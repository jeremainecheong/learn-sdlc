import 'reflect-metadata';
import type { Socket } from 'socket.io';
import type { AuthService } from '../auth/auth.service';
import { EventsGateway, observedAdapterClient, scheduleExpiry, tokenExpiresAt } from './events.gateway';

/** A signed-looking token whose payload says `exp`; the signature is never checked here. */
const tokenWithExp = (exp: number | undefined): string => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'u1', ver: 0, ...(exp === undefined ? {} : { exp }) })}.sig`;
};

/** The parts of a socket the gateway touches on connect. */
function fakeSocket(token: string) {
  const handlers: Record<string, Array<() => void>> = {};
  const client = {
    handshake: { auth: { token } },
    join: jest.fn(async () => undefined),
    disconnect: jest.fn(),
    on: jest.fn((event: string, handler: () => void): void => {
      (handlers[event] ||= []).push(handler);
    }),
  };
  return {
    client: client as unknown as Socket,
    disconnect: client.disconnect,
    join: client.join,
    fire: (event: string) => (handlers[event] || []).forEach((h) => h()),
  };
}

/**
 * A socket authenticates once, at the handshake. Revocation (password change,
 * suspension, a cohort move) closes it through `onSessionRevoked`; a token
 * that merely reaches its `exp` would not be closed that way, and the room
 * would keep delivering after the REST side had started answering 401. So the
 * socket is closed at that instant too.
 */
describe('EventsGateway and a token that expires', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const gateway = () => {
    const auth = {
      authenticate: jest.fn(async () => ({ id: 'u1', email: 'a@b', role: 'LEARNER', cohort: null })),
      onSessionRevoked: jest.fn(),
    } as unknown as AuthService;
    return new EventsGateway(auth);
  };

  it('reads the instant the token stops being one', () => {
    expect(tokenExpiresAt(tokenWithExp(1_800_000_000))).toBe(1_800_000_000_000);
    expect(tokenExpiresAt(tokenWithExp(undefined))).toBeNull();
    expect(tokenExpiresAt('not-a-token')).toBeNull();
    expect(tokenExpiresAt('a.%%%.c')).toBeNull();
  });

  it('closes the socket when the token reaches exp, and not before', async () => {
    const exp = Math.floor(Date.now() / 1000) + 1;
    const socket = fakeSocket(tokenWithExp(exp));

    await gateway().handleConnection(socket.client);

    expect(socket.join).toHaveBeenCalledWith('user:u1');
    jest.advanceTimersByTime(500);
    expect(socket.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_500);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('closes a socket whose token is already past exp at once', async () => {
    const socket = fakeSocket(tokenWithExp(Math.floor(Date.now() / 1000) - 10));

    await gateway().handleConnection(socket.client);
    jest.advanceTimersByTime(0);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('leaves a token with no exp connected', async () => {
    const socket = fakeSocket(tokenWithExp(undefined));

    await gateway().handleConnection(socket.client);
    jest.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);

    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('forgets the timer when the socket goes first', () => {
    const socket = fakeSocket('x');
    scheduleExpiry(socket.client, Date.now() + 1000);

    socket.fire('disconnect');
    jest.advanceTimersByTime(2000);

    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('never asks setTimeout for more than it can hold', () => {
    const socket = fakeSocket('x');
    scheduleExpiry(socket.client, Date.now() + 2 ** 40);

    // A wait beyond the ceiling would have fired at once; clamped, it has not.
    jest.advanceTimersByTime(1000);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });

  it('still refuses a token the auth service will not answer to', async () => {
    const auth = {
      authenticate: jest.fn(async () => {
        throw new Error('no');
      }),
      onSessionRevoked: jest.fn(),
    } as unknown as AuthService;
    const socket = fakeSocket(tokenWithExp(Math.floor(Date.now() / 1000) + 60));

    await new EventsGateway(auth).handleConnection(socket.client);

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it.each(['authentication', 'room join'] as const)(
    'does not leave a revoked socket connected when revocation arrives during %s',
    async (stage) => {
      let revoke!: (userId: string) => void;
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const auth = {
        authenticate: jest.fn(async () => {
          if (stage === 'authentication') { entered(); await held; }
          return { id: 'u1', email: 'a@b', role: 'LEARNER', cohort: null };
        }),
        onSessionRevoked: jest.fn((listener) => { revoke = listener; }),
      } as unknown as AuthService;
      const socket = fakeSocket(tokenWithExp(Math.floor(Date.now() / 1000) + 60));
      if (stage === 'room join') socket.join.mockImplementation(async () => { entered(); await held; });
      const connecting = new EventsGateway(auth).handleConnection(socket.client);
      await started;
      revoke('u1');
      release();
      await connecting;
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      if (stage === 'authentication') expect(socket.join).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('keeps an unrelated account connecting during another account’s revocation', async () => {
    let revoke!: (userId: string) => void;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const auth = {
      authenticate: jest.fn(async () => { entered(); await held; return { id: 'u2' }; }),
      onSessionRevoked: jest.fn((listener) => { revoke = listener; }),
    } as unknown as AuthService;
    const socket = fakeSocket(tokenWithExp(undefined));
    const connecting = new EventsGateway(auth).handleConnection(socket.client);
    await started;
    revoke('u1');
    release();
    await connecting;
    expect(socket.join).toHaveBeenCalledWith('user:u2');
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});


describe('adapter command rejection observation', () => {
  it('observes a discarded pub/sub rejection without converting it into success for an awaited caller', async () => {
    const failure = new Error('controlled closed adapter connection');
    const original = Promise.reject(failure);
    const failed = jest.fn();
    const client = { publish: jest.fn(() => original), status: 'end' };
    const observed = observedAdapterClient(client as unknown as import('ioredis').Redis, failed);
    const returned = observed.publish('owned-channel', 'owned-message');
    expect(returned).toBe(original);
    await expect(returned).rejects.toBe(failure);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(observed.status).toBe('end');
  });
});
