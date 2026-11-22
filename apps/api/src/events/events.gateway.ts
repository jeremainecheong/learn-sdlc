import { Inject, Injectable, Logger, OnApplicationShutdown, Optional } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import IORedis, { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
// NotificationEvent rides the same room and the same handshake.
import { JobEvent, NotificationEvent, SOCKET_EVENTS } from '@learnsdlc/shared';
import { AuthService } from '../auth/auth.service';
import { config, webOriginList } from '../config';

/**
 * WEB_ORIGIN is documented as comma-separated and main.ts splits it for REST.
 * Socket.IO compares the Origin header against this value literally, so
 * handing it the raw string made every origin fail the handshake as soon as a
 * second one was configured: silently, because REST polling keeps the UI
 * working. The same split, applied once, at module load.
 */
const allowedOrigins = webOriginList(config.webOrigin);

/**
 * The instant a bearer token stops being one, in ms since the epoch, or null
 * for a token that carries no `exp`. Read from the payload segment only
 * after `authenticate` has verified the signature; this never decides whether
 * the token is good, only when it stops being.
 */
export function tokenExpiresAt(token: string): number | null {
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/** setTimeout's ceiling; a longer wait would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const CHECKED_EVENT = 'learnsdlc:authorized-delivery:v1';
export const EVENTS_REDIS_KEY = Symbol('EVENTS_REDIS_KEY');
export const SOCKET_AUTH_RECHECK_MS = 5_000;

/**
 * A socket authenticates once, at the handshake, and `onSessionRevoked`
 * closes it when the account is signed out, suspended or moved. A token that
 * simply reaches its `exp` had no such moment: the REST side answered 401
 * from then on while the room kept delivering. This closes the socket at
 * that instant; the client reconnects with whatever token it holds and is
 * checked again. Unreferenced so a waiting timer never holds the process,
 * and cleared when the socket goes first.
 */
export function scheduleExpiry(
  client: Pick<Socket, 'disconnect' | 'on'>,
  expiresAt: number | null,
  now: number = Date.now(),
): void {
  if (expiresAt === null) return;
  const wait = Math.min(Math.max(expiresAt - now, 0), MAX_TIMER_MS);
  const timer = setTimeout(() => client.disconnect(true), wait);
  timer.unref?.();
  client.on('disconnect', () => clearTimeout(timer));
}

/** redis-adapter 8.x intentionally discards these command promises. ioredis
 * rejects them when a connection closes, including during adapter.close().
 * Observe that rejection without replacing the promise or masking it from an
 * awaited caller. Only adapter-owned clients use this view. */
export function observedAdapterClient(client: Redis, failed: () => void): Redis {
  const detached = new Set(['publish', 'subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe']);
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!detached.has(String(property))) return value.bind(target);
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args) as Promise<unknown> | undefined;
        if (result && typeof result.catch === 'function') void result.catch(() => failed());
        return result;
      };
    },
  });
}

/**
 * Pushes job lifecycle updates (runs, submissions) to the owning learner in
 * real time. Clients also poll the REST endpoints, so a dropped socket only
 * costs latency, never correctness.
 */
@Injectable()
@WebSocketGateway({ cors: { origin: allowedOrigins } })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnApplicationShutdown {
  private readonly logger = new Logger(EventsGateway.name);
  private redisClients: Redis[] = [];
  private readonly connecting = new Map<Socket, { userId: string | null; revoked: Set<string>; unavailable: boolean }>();
  private readonly connected = new Map<Socket, { userId: string; token: string; revoked: boolean }>();
  private authorityTimer: NodeJS.Timeout | null = null;
  private checking = false;

  @WebSocketServer()
  server: Server;

  constructor(private readonly auth: AuthService,
    @Optional() @Inject(EVENTS_REDIS_KEY) private readonly redisKey = 'learnsdlc:events:v1',
  ) {
    // A socket authenticates once, at the handshake. Without this a revoked
    // token would keep receiving the learner's job events until the tab
    // happened to reconnect.
    this.auth.onSessionRevoked((userId) => {
      // A socket may not have joined its account room yet. Remember events
      // during authentication, and close a known account even while the
      // asynchronous adapter is still completing its room join.
      for (const [client, pending] of this.connecting) {
        if (pending.userId === null || pending.userId === userId) pending.revoked.add(userId);
        if (pending.userId === userId) client.disconnect(true);
      }
      for (const [client, active] of this.connected) {
        if (active.userId === userId) { active.revoked = true; client.disconnect(true); this.connected.delete(client); }
      }
      this.server?.in(`user:${userId}`).disconnectSockets(true);
    });
  }

  /**
   * Behind a load balancer the job worker that finishes a run is not, in
   * general, the replica holding the learner's socket. The Redis adapter makes
   * `to(room)` fan out through pub/sub so the event reaches whichever replica
   * has them. It rides the same REDIS_URL as the job queue: an in-process
   * queue means one replica, and one replica needs no adapter.
   */
  afterInit(server: Server): void {
    this.server = server;
    // Redis broadcasts a delivery request, not the learner payload to rooms.
    // Each receiving process verifies its own sockets against shared authority.
    server.on(CHECKED_EVENT, (userId: string, kind: string, event: JobEvent | NotificationEvent) => {
      if (kind === SOCKET_EVENTS.job || kind === SOCKET_EVENTS.notification) return this.deliverLocal(userId, kind, event);
    });
    this.authorityTimer = setInterval(() => void this.recheckConnections(), SOCKET_AUTH_RECHECK_MS);
    this.authorityTimer.unref?.();
    if (!config.redisUrl) return;
    const pub = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
    const sub = pub.duplicate();
    // ioredis throws on an unhandled 'error' event; a Redis blip should cost
    // a logged line and a reconnect, not the process.
    for (const client of [pub, sub]) {
      client.on('error', () => { this.logger.warn('socket adapter unavailable; connections must authenticate again'); this.disconnectLocal(); });
      client.on('close', () => this.disconnectLocal());
    }
    this.redisClients = [pub, sub];
    const failed = () => { this.disconnectLocal(); };
    server.adapter(createAdapter(observedAdapterClient(pub, failed), observedAdapterClient(sub, failed), { key: this.redisKey }));
    this.logger.log('socket rooms shared across replicas via Redis');
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = (client.handshake.auth?.token as string) || '';
    const pending = { userId: null as string | null, revoked: new Set<string>(), unavailable: false };
    this.connecting.set(client, pending);
    try {
      if (this.redisClients.some(client => client.status !== 'ready')) throw new Error('socket adapter unavailable');
      const user = await this.auth.authenticate(token);
      pending.userId = user.id;
      if (pending.unavailable || pending.revoked.has(user.id)) throw new Error('session revoked during connection');
      await client.join(`user:${user.id}`);
      const current = await this.auth.authenticate(token);
      if (current.id !== user.id || pending.unavailable || pending.revoked.has(user.id)) throw new Error('session revoked during room join');
      if (this.redisClients.some(client => client.status !== 'ready')) throw new Error('socket adapter unavailable');
      const active = { userId: user.id, token, revoked: false };
      this.connected.set(client, active);
      client.on('disconnect', () => { active.revoked = true; this.connected.delete(client); });
      scheduleExpiry(client, tokenExpiresAt(token));
    } catch {
      this.logger.warn('socket connection rejected: bad or revoked token');
      client.disconnect(true);
    } finally {
      this.connecting.delete(client);
    }
  }

  emitJob(userId: string, event: JobEvent): Promise<void> {
    return this.deliver(userId, SOCKET_EVENTS.job, event);
  }

  /**
   * One notification, to the account it is for.
   *
   * The same room and the same authenticated handshake as `emitJob`, so a
   * suspended account stops receiving these for free: `onSessionRevoked` above
   * already disconnects its sockets. Emitted after the row has committed,
   * never inside the transaction that wrote it, and never a reason anything
   * fails: a socket that is not there costs the badge a minute, and the panel
   * refetches on focus.
   */
  emitNotification(userId: string, event: NotificationEvent): Promise<void> {
    return this.deliver(userId, SOCKET_EVENTS.notification, event);
  }

  private async deliver(userId: string, kind: string, event: JobEvent | NotificationEvent): Promise<void> {
    const local = this.deliverLocal(userId, kind, event);
    if (this.redisClients.length && this.redisClients.every(client => client.status === 'ready')) {
      try { this.server?.serverSideEmit(CHECKED_EVENT, userId, kind, event); }
      catch { this.logger.warn('socket event fanout unavailable'); this.disconnectLocal(); }
    }
    await local;
  }

  private async deliverLocal(userId: string, kind: string, event: JobEvent | NotificationEvent): Promise<void> {
    await Promise.all([...this.connected].filter(([, active]) => active.userId === userId).map(async ([client, active]) => {
      try {
        const current = await this.auth.authenticate(active.token);
        if (active.revoked || current.id !== userId || this.connected.get(client) !== active ||
            this.redisClients.some(redis => redis.status !== 'ready')) throw new Error('session unavailable');
        client.emit(kind, event);
      } catch {
        active.revoked = true;
        this.connected.delete(client);
        client.disconnect(true);
      }
    }));
  }

  /** Idle sockets also close after remote logout, suspension, or authority outage.
   * No event is delivered during that polling interval without a fresh check. */
  async recheckConnections(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await Promise.all([...this.connected].map(async ([client, active]) => {
        try {
          const current = await this.auth.authenticate(active.token);
          if (active.revoked || current.id !== active.userId) throw new Error('session revoked');
        } catch {
          active.revoked = true; this.connected.delete(client); client.disconnect(true);
        }
      }));
    } finally { this.checking = false; }
  }

  private disconnectLocal(): void {
    for (const [client, active] of this.connected) { active.revoked = true; client.disconnect(true); }
    this.connected.clear();
    for (const [client, pending] of this.connecting) {
      pending.unavailable = true;
      if (pending.userId) pending.revoked.add(pending.userId);
      client.disconnect(true);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.authorityTimer) clearInterval(this.authorityTimer);
    this.authorityTimer = null;
    this.disconnectLocal();
    await Promise.all(
      this.redisClients.map((client) =>
        // QUIT is a command, and with maxRetriesPerRequest: null a command
        // waits for a reconnect that, if Redis is down, never comes, which
        // held `docker compose stop api` for the full grace period. Only a
        // connected client is asked politely; any other state is torn down.
        client.status === 'ready' ? client.quit().catch(() => undefined) : client.disconnect(),
      ),
    );
    this.redisClients = [];
  }
}
