// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The live-updates socket's token.
 *
 * Built with `auth: { token }`, the token would be read once when the
 * instance was made. Socket.IO re-sends that same object on every
 * reconnection, so a socket that outlived its token (a new sign-in in another
 * tab, a token swapped under it) would keep handshaking with the old one:
 * joined to the old account's room, or refused forever. The handshake asks for the
 * token each time (`auth` as a callback), and a change of the stored token
 * seen from another tab reconnects the one instance in place, keeping every
 * listener the workspace attached to it; a token removed closes it.
 */

const rig = vi.hoisted(() => ({
  token: 'token-a' as string | null,
  made: [] as Array<{ options: Record<string, unknown>; instance: FakeSocket }>,
}));

interface FakeSocket {
  connected: boolean;
  active: boolean;
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  on: (event: string, fn: (...args: unknown[]) => void) => FakeSocket;
  emit: (event: string, ...args: unknown[]) => void;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

vi.mock('socket.io-client', () => ({
  io: (_url: string, options: Record<string, unknown>) => {
    const instance: FakeSocket = {
      connected: false,
      active: true,
      handlers: {},
      on(event, fn) {
        (this.handlers[event] ??= []).push(fn);
        return this;
      },
      emit(event, ...args) {
        (this.handlers[event] ?? []).forEach((fn) => fn(...args));
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    instance.connect = vi.fn(() => {
      instance.active = true;
      return instance;
    });
    instance.disconnect = vi.fn(() => {
      instance.active = false;
      instance.connected = false;
      instance.emit('disconnect', 'io client disconnect');
      return instance;
    });
    rig.made.push({ options, instance });
    return instance;
  },
}));

vi.mock('@/lib/api', () => ({ API_URL: 'http://api.test', getToken: () => rig.token }));

import { closeSocket, getSocket, getSocketState } from '@/lib/socket';
import { TOKEN_KEY } from '@/lib/session';

const handshake = (options: Record<string, unknown>): unknown => {
  const auth = options.auth;
  expect(typeof auth, 'auth is asked for at each handshake, not captured').toBe('function');
  let sent: unknown;
  (auth as (cb: (data: unknown) => void) => void)((data) => {
    sent = data;
  });
  return sent;
};

beforeEach(() => {
  rig.token = 'token-a';
  rig.made.length = 0;
});
afterEach(() => {
  closeSocket();
});

describe('the live-updates socket and its token', () => {
  it('sends the token stored at each handshake, not the one it was built with', () => {
    getSocket();
    expect(rig.made).toHaveLength(1);
    expect(handshake(rig.made[0].options)).toEqual({ token: 'token-a' });
    rig.token = 'token-a2';
    expect(handshake(rig.made[0].options)).toEqual({ token: 'token-a2' });
  });

  it('reconnects the same instance in place when another tab changes the stored token', () => {
    const socket = getSocket();
    const { instance } = rig.made[0];
    const kept = vi.fn();
    instance.on('job:update', kept);
    rig.token = 'token-b';
    window.dispatchEvent(new StorageEvent('storage', { key: TOKEN_KEY, newValue: 'token-b' }));

    expect(instance.disconnect).toHaveBeenCalledTimes(1);
    expect(instance.connect).toHaveBeenCalledTimes(1);
    // The one instance, with its listeners, and no second socket.
    expect(rig.made).toHaveLength(1);
    expect(getSocket()).toBe(socket);
    expect(rig.made).toHaveLength(1);
    expect(handshake(rig.made[0].options)).toEqual({ token: 'token-b' });
    instance.emit('job:update', 1);
    expect(kept).toHaveBeenCalledWith(1);
  });

  it('closes when another tab removes the token', () => {
    getSocket();
    const { instance } = rig.made[0];
    rig.token = null;
    window.dispatchEvent(new StorageEvent('storage', { key: TOKEN_KEY, newValue: null }));
    expect(instance.disconnect).toHaveBeenCalled();
    expect(instance.connect).not.toHaveBeenCalled();
    expect(getSocketState()).toBe('paused');
    expect(getSocket()).toBeNull();
  });

  it('does nothing when an unrelated key changes or the token is the same', () => {
    getSocket();
    const { instance } = rig.made[0];
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else', newValue: 'x' }));
    window.dispatchEvent(new StorageEvent('storage', { key: TOKEN_KEY, newValue: 'token-a' }));
    expect(instance.disconnect).not.toHaveBeenCalled();
    expect(instance.connect).not.toHaveBeenCalled();
  });

  it('still drops an instance whose handshake the server refused', () => {
    getSocket();
    const { instance } = rig.made[0];
    instance.active = false;
    instance.emit('connect_error', new Error('unauthorized'));
    expect(getSocket()).not.toBe(instance);
    expect(rig.made).toHaveLength(2);
  });
});
