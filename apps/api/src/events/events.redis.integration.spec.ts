import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { createServer, type Server as HttpServer } from 'http';
import { once } from 'events';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { Server } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import type { Redis } from 'ioredis';
import { SOCKET_EVENTS, type JobEvent } from '@learnsdlc/shared';
import { AuthService } from '../auth/auth.service';
import { UserEntity } from '../db/entities';
import { config } from '../config';
import { EventsGateway } from './events.gateway';

// REDIS_TEST=1 runs these against a Redis server on 127.0.0.1:6379.
// GAP_SECURITY_REDIS=1 is read as the same switch.
const enabled = process.env.REDIS_TEST === '1' || process.env.GAP_SECURITY_REDIS === '1';
const describeRedis = enabled ? describe : describe.skip;
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('owned socket observation timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

function clientOnce(client: ClientSocket, event: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const received = (...args: unknown[]) => { clearTimeout(timer); resolve(args); };
    const timer = setTimeout(() => { client.off(event, received); reject(new Error('owned client event timed out')); }, 4000);
    client.once(event, received);
  });
}

describeRedis('actual Redis adapter, isolated channel and two HTTP/socket servers', () => {
  let db: DataSource;
  let authA: AuthService;
  let authB: AuthService;
  let gateways: EventsGateway[];
  let servers: Server[];
  let httpServers: HttpServer[];
  let clients: ClientSocket[];
  let ports: number[];
  const prior = config.redisUrl;
  const internals = (gateway: EventsGateway) => gateway as unknown as {
    redisClients: Redis[]; connected: Map<unknown, unknown>;
  };

  beforeEach(async () => {
    Object.assign(config, { redisUrl: 'redis://127.0.0.1:6379' });
    db = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [UserEntity], synchronize: true }).initialize();
    const jwt = new JwtService({ secret: 'redis-owned-test-only', signOptions: { expiresIn: '1h' } });
    authA = new AuthService(passwordWorkFixture(), db.getRepository(UserEntity), jwt);
    authB = new AuthService(passwordWorkFixture(), db.getRepository(UserEntity), jwt);
    const channel = `learnsdlc:gap_socket_${randomUUID().replace(/-/g, '')}`;
    gateways = [new EventsGateway(authA, channel), new EventsGateway(authB, channel)];
    servers = []; httpServers = []; clients = []; ports = [];
    for (const gateway of gateways) {
      const http = createServer();
      const server = new Server(http, { serveClient: false });
      gateway.afterInit(server);
      server.on('connection', socket => void gateway.handleConnection(socket));
      await Promise.all(internals(gateway).redisClients.map(redis => redis.status === 'ready' ? Promise.resolve() : once(redis, 'ready')));
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('test listener refused');
      ports.push(address.port); servers.push(server); httpServers.push(http);
    }
  });
  afterEach(async () => {
    for (const client of clients ?? []) client.disconnect();
    for (const gateway of gateways ?? []) await gateway.onApplicationShutdown();
    for (const server of servers ?? []) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const http of httpServers ?? []) if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
    if (db?.isInitialized) await db.destroy();
    Object.assign(config, { redisUrl: prior });
  });

  async function connect(name: string, at = 1) {
    const row = await db.manager.save(UserEntity, db.manager.create(UserEntity, {
      email: `gap-redis-${name}@example.invalid`, passwordHash: 'unused', displayName: 'Redis fixture',
    }));
    const session = await authA.issueSession(row);
    const before = internals(gateways[at]).connected.size;
    const client = io(`http://127.0.0.1:${ports[at]}`, {
      auth: { token: session.token }, transports: ['websocket'], reconnection: false, forceNew: true,
    });
    clients.push(client);
    await waitFor(() => client.connected && internals(gateways[at]).connected.size === before + 1);
    return { row, client, session };
  }

  it('delivers through the actual broker and revokes the remote socket without affecting another owner', async () => {
    const one = await connect('owner');
    const two = await connect('other');
    const event = { id: 'gap-redis-job', status: 'completed' } as unknown as JobEvent;
    const firstDelivery = clientOnce(one.client, SOCKET_EVENTS.job);
    await gateways[0].emitJob(one.row.id, event);
    expect((await firstDelivery)[0]).toEqual(event);
    await authA.signOut(one.row.id);
    await waitFor(() => !one.client.connected);
    const otherDelivery = clientOnce(two.client, SOCKET_EVENTS.job);
    await gateways[0].emitJob(two.row.id, event);
    expect((await otherDelivery)[0]).toEqual(event);
    expect(two.client.connected).toBe(true);
    await expect(authB.authenticate(one.session.token)).rejects.toThrow('signed out');
  });

  it('checks SQL again on remote delivery when a version changed without a pub/sub revocation event', async () => {
    const one = await connect('silent-rotation');
    const received = jest.fn(); one.client.on(SOCKET_EVENTS.job, received);
    await db.manager.update(UserEntity, { id: one.row.id }, { tokenVersion: 4 });
    await gateways[0].emitJob(one.row.id, { id: 'must-not-arrive' } as unknown as JobEvent);
    await waitFor(() => !one.client.connected);
    expect(received).not.toHaveBeenCalled();
  });

  it('fails closed when only this test replica loses its owned Redis connections', async () => {
    const one = await connect('isolated-outage');
    const received = jest.fn(); one.client.on(SOCKET_EVENTS.job, received);
    // This severs only the test's two clients. No Redis server/config/key mutation.
    for (const redis of internals(gateways[1]).redisClients) redis.disconnect();
    await waitFor(() => !one.client.connected);
    await gateways[0].emitJob(one.row.id, { id: 'outage-event' } as unknown as JobEvent);
    expect(received).not.toHaveBeenCalled();
    const replacement = io(`http://127.0.0.1:${ports[1]}`, {
      auth: { token: one.session.token }, transports: ['websocket'], reconnection: false, forceNew: true,
    });
    clients.push(replacement);
    await clientOnce(replacement, 'disconnect');
    expect(internals(gateways[1]).connected.size).toBe(0);
    expect(internals(gateways[0]).redisClients.every(redis => redis.status === 'ready')).toBe(true);
  });

  it('does not turn a browser-emitted adapter event into another owner’s server notification', async () => {
    const one = await connect('untrusted-event');
    const two = await connect('protected-owner');
    const received = jest.fn(); two.client.on(SOCKET_EVENTS.job, received);
    one.client.emit('learnsdlc:authorized-delivery:v1', two.row.id, SOCKET_EVENTS.job, { id: 'forged-event' });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(received).not.toHaveBeenCalled();
    const genuine = clientOnce(two.client, SOCKET_EVENTS.job);
    await gateways[0].emitJob(two.row.id, { id: 'genuine-event' } as unknown as JobEvent);
    expect((await genuine)[0]).toEqual({ id: 'genuine-event' });
  });

});
