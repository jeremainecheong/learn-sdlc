'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { io, Socket } from 'socket.io-client';
import { API_URL, getToken } from './api';
import { TOKEN_KEY } from './session';
import { SESSION_RENEWED_EVENT } from './session-token';

let socket: Socket | null = null;
let socketToken: string | null = null;

/**
 * Whether live updates are arriving.
 *
 * `paused` is not an error: polling is the source of truth and a paused socket
 * only costs latency. It is worth saying out loud all the same, because the
 * workspace's panels update themselves the moment a job lands, and a learner
 * watching a panel that has quietly stopped listening has no way to tell that
 * from a job that has not finished.
 */
export type SocketState = 'live' | 'paused';

let state: SocketState = 'paused';
const watchers = new Set<() => void>();

function setState(next: SocketState): void {
  if (next === state) return;
  state = next;
  watchers.forEach((fn) => fn());
}

export function getSocketState(): SocketState {
  return state;
}

export function subscribeSocketState(fn: () => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

/** The state as React state, for the pip in the status bar. */
export function useSocketState(): SocketState {
  return useSyncExternalStore(subscribeSocketState, getSocketState, () => 'paused' as const);
}

/**
 * How long the socket has to stay away before the status bar says so.
 *
 * The store starts at `paused` and turns `live` on the first handshake, which
 * on a laptop takes a fraction of a second. Drawing the pip in that gap would
 * put "live updates paused" on the screen every time a workspace opens, which
 * teaches a learner to ignore it, and the pip only earns its place if it is
 * rare.
 */
export const SOCKET_PAUSE_GRACE_MS = 3_000;

/**
 * True once live updates have been away long enough to be worth mentioning.
 * `useSocketState` is the raw fact; this is the one the status bar draws.
 */
export function useSocketPaused(graceMs: number = SOCKET_PAUSE_GRACE_MS): boolean {
  const state = useSocketState();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (state === 'live') {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), graceMs);
    return () => clearTimeout(timer);
  }, [state, graceMs]);
  return state === 'paused' && settled;
}

/**
 * Nudge a sleeping socket the moment there is any reason to believe the
 * network is back.
 *
 * Socket.IO's own backoff climbs to the cap and then waits there, so a laptop
 * reopened after a lesson can sit for the best part of the cap with a live API
 * on the other end. The browser knows better than the backoff does: coming
 * online, and the tab being looked at again, are both worth an immediate
 * attempt. Registered once, for the life of the tab.
 */
let nudgeWired = false;

function wireNudges(): void {
  if (nudgeWired || typeof window === 'undefined') return;
  nudgeWired = true;
  const nudge = () => {
    const instance = socket;
    if (!instance || instance.connected) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // A no-op while the manager is already mid-reconnect; otherwise it skips
    // the rest of the backoff and tries now.
    instance.connect();
  };
  window.addEventListener('online', nudge);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', nudge);
  // Another tab signing in, or out, changes the stored
  // token under this one. `storage` fires only in the other tabs, which are
  // exactly the ones whose socket is still joined to the old token.
  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_KEY || event.key === null) swapToken();
  });
  // This tab renewed its session (lib/api.ts). The server closes a socket at
  // its handshake token's `exp`, so the instance reconnects now, in place,
  // and the handshake reads the renewed token.
  window.addEventListener(SESSION_RENEWED_EVENT, swapToken);
}

/**
 * Set while a token swap takes the instance down on purpose, so the
 * `disconnect` it emits is not read as the server refusing the handshake.
 */
let swapping = false;

/**
 * Follow the stored token. A new token reconnects the **same** instance
 * (the workspace attached its listeners to it once, keyed on the phase, and a
 * replacement would silently have none) and the handshake reads the new token
 * through the `auth` callback. No token closes it.
 */
function swapToken(): void {
  const instance = socket;
  if (!instance) return;
  const token = getToken();
  if (token === socketToken) return;
  if (!token) {
    closeSocket();
    return;
  }
  socketToken = token;
  swapping = true;
  try {
    instance.disconnect();
  } finally {
    swapping = false;
  }
  instance.connect();
}

/**
 * Live job updates over Socket.IO. Polling remains the source of truth:
 * a dropped socket only costs latency, never correctness.
 *
 * The instance is built once per token and kept. A budget of a few
 * reconnection attempts (five, say) is spent by Socket.IO's default backoff in
 * about seventeen seconds (less than an API restart takes) after which the
 * instance would be dropped. Nothing calls `getSocket()` again (the one caller
 * is an effect keyed on the phase), so a restart in the middle of a class would
 * leave every open workspace with no live updates for the rest of the day and
 * nothing on screen to say so. So the budget is unbounded with the backoff
 * capped near thirty seconds, and the instance is dropped only when the server
 * refuses the handshake: a token that has stopped working, which retrying
 * cannot fix.
 */
export function getSocket(): Socket | null {
  if (typeof window === 'undefined') return null;
  const token = getToken();
  if (!token) return null;
  // The token is read at handshake time, so a socket built for the previous
  // sign-in stays joined to that user's room until it next reconnects. Someone
  // signing in second in the same tab must not be handed the first user's
  // connection.
  if (socket && socketToken !== token) closeSocket();
  if (!socket) {
    const instance = io(API_URL, {
      // Asked for at every handshake, reconnections included: an object
      // here is the token captured when the instance was built, sent again
      // after that token has been replaced.
      auth: (cb) => cb({ token: getToken() ?? '' }),
      transports: ['websocket', 'polling'],
      // Forever, because the thing on the other end is a laptop API that gets
      // restarted, closed and moved between networks during a class.
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
    });
    // A rejected token is rejected identically every time, so retrying it is
    // permanent load on the API for nothing. Socket.IO says so by tearing the
    // socket's own subscriptions down: `active` is false once the server
    // refused the handshake, and stays true for every transport failure, which
    // is the one worth waiting out.
    const dropIfRefused = () => {
      setState('paused');
      if (!swapping && !instance.active && socket === instance) closeSocket();
    };
    instance.on('connect', () => setState('live'));
    instance.on('connect_error', dropIfRefused);
    instance.on('disconnect', dropIfRefused);
    socket = instance;
    socketToken = token;
    setState(instance.connected ? 'live' : 'paused');
    wireNudges();
  }
  return socket;
}

export function closeSocket(): void {
  // Cleared before disconnecting, not after: disconnect() emits to the
  // listeners above synchronously, and they would otherwise re-enter here.
  const instance = socket;
  socket = null;
  socketToken = null;
  setState('paused');
  instance?.disconnect();
}
