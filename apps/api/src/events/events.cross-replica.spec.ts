import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import type { Server, Socket } from 'socket.io';
import { SOCKET_EVENTS, type JobEvent } from '@learnsdlc/shared';
import { UserEntity } from '../db/entities';
import { AuthService } from '../auth/auth.service';
import { config } from '../config';
import { EventsGateway } from './events.gateway';
import { memoryDataSource } from '../../test/support/memory-db';

function socket(token: string) {
  const handlers = new Map<string, () => void>();
  const client = {
    handshake: { auth: { token } }, join: jest.fn(async () => undefined), emit: jest.fn(),
    on: jest.fn((name: string, handler: () => void) => { handlers.set(name, handler); }),
    disconnect: jest.fn(() => handlers.get('disconnect')?.()),
  };
  return client;
}

describe('cross-process socket authorization (real shared SQL, controlled adapter delivery)', () => {
  let db: DataSource;
  let authA: AuthService;
  let authB: AuthService;
  let gateway: EventsGateway;
  let receive: (user: string, kind: string, event: JobEvent) => Promise<void>;
  const priorRedis = config.redisUrl;
  const event = { id: 'controlled-job' } as unknown as JobEvent;

  beforeEach(async () => {
    (config as { redisUrl: string }).redisUrl = '';
    db = await memoryDataSource();
    const jwt = new JwtService({ secret: 'cross-replica-test-only', signOptions: { expiresIn: '1h' } });
    authA = new AuthService(passwordWorkFixture(), db.getRepository(UserEntity), jwt);
    authB = new AuthService(passwordWorkFixture(), db.getRepository(UserEntity), jwt);
    gateway = new EventsGateway(authB);
    gateway.afterInit({
      on: (_name: string, listener: typeof receive) => { receive = listener; },
      in: () => ({ disconnectSockets: jest.fn() }),
    } as unknown as Server);
  });
  afterEach(async () => {
    await gateway.onApplicationShutdown();
    await db.destroy();
    (config as { redisUrl: string }).redisUrl = priorRedis;
  });
  async function account(email: string) {
    const row = await db.manager.save(UserEntity, db.manager.create(UserEntity, {
      email, passwordHash: 'unused', displayName: 'Socket fixture',
    }));
    const session = await authA.issueSession(row);
    const client = socket(session.token);
    await gateway.handleConnection(client as unknown as Socket);
    return { row, client, session };
  }

  it('does not deliver a remote adapter event after logout on another API, leaving another account connected', async () => {
    const one = await account('gap-socket-a@example.invalid');
    const two = await account('gap-socket-b@example.invalid');
    await authA.signOut(one.row.id);
    await receive(one.row.id, SOCKET_EVENTS.job, event);
    expect(one.client.emit).not.toHaveBeenCalled();
    expect(one.client.disconnect).toHaveBeenCalledWith(true);
    await receive(two.row.id, SOCKET_EVENTS.job, event);
    expect(two.client.emit).toHaveBeenCalledWith(SOCKET_EVENTS.job, event);
    expect(two.client.disconnect).not.toHaveBeenCalled();
  });

  it('closes an idle connection after a remote rotation, without waiting for an event', async () => {
    const one = await account('gap-socket-rotation@example.invalid');
    await db.manager.update(UserEntity, { id: one.row.id }, { tokenVersion: 3 });
    await gateway.recheckConnections();
    expect(one.client.disconnect).toHaveBeenCalledWith(true);
    expect(one.client.emit).not.toHaveBeenCalled();
  });

  it('fails closed on authority outage instead of delivering with a prior handshake', async () => {
    const one = await account('gap-socket-outage@example.invalid');
    jest.spyOn(db.getRepository(UserEntity), 'findOne').mockRejectedValueOnce(new Error('controlled outage'));
    await receive(one.row.id, SOCKET_EVENTS.job, event);
    expect(one.client.emit).not.toHaveBeenCalled();
    expect(one.client.disconnect).toHaveBeenCalledWith(true);
  });

  it('rechecks a handshake whose room join completes after remote revocation', async () => {
    const row = await db.manager.save(UserEntity, db.manager.create(UserEntity, {
      email: 'gap-socket-join@example.invalid', passwordHash: 'unused', displayName: 'Delayed join',
    }));
    const session = await authA.issueSession(row);
    const client = socket(session.token);
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    client.join.mockImplementation(async () => { entered(); await held; });
    const pending = gateway.handleConnection(client as unknown as Socket);
    await started; await authA.signOut(row.id); release(); await pending;
    expect(client.disconnect).toHaveBeenCalledWith(true);
    await receive(row.id, SOCKET_EVENTS.job, event);
    expect(client.emit).not.toHaveBeenCalled();
  });
});
