'use client';

/**
 * What the bell knows, for the whole session.
 *
 * The shell is drawn once above the router, so the bell has to read the same
 * on Home, Phases, the map, the journal, the shelf and the workspace, and it
 * cannot go and ask again on every navigation to do it. So the rows live in a
 * module store rather than in the panel's state: read synchronously by whoever
 * renders them, refreshed in the background when the copy has gone stale, and
 * dropped the moment the token changes.
 *
 * Two rules are worth saying out loud, because both are about trust.
 *
 * A failed load never empties the badge. The last known count stays until a
 * load succeeds, because a bell that silently drops to zero teaches a learner
 * to distrust it, which is the one thing a bell cannot survive.
 *
 * And a row that has been marked read is gone from here for good. There is no
 * read archive and no notifications page: what falls off the bottom of the
 * panel is read on the page it concerns, and a second inbox is a place work
 * goes to be forgotten.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { NotificationEvent, NotificationListView, NotificationView } from '@learnsdlc/shared';
import { SOCKET_EVENTS } from '@learnsdlc/shared';
import { getToken, request } from './api';
import { onSessionEnd, ownedByToken } from './session';
import { getSocket } from './socket';

/** How long a copy is used without a background refresh. `lib/records.ts`'s number. */
export const FRESH_MS = 60_000;

/** The most rows the panel draws. Past this it says how many more there are. */
export const BELL_ROWS = 8;

interface Store {
  items: NotificationView[];
  unread: number;
  /** When the copy in hand was fetched. 0 means there has never been one. */
  at: number;
  loading: boolean;
  /** The sentence the panel shows above the plan steps, or empty. */
  error: string;
}

const EMPTY: Store = { items: [], unread: 0, at: 0, loading: false, error: '' };

let store: Store = EMPTY;
const watchers = new Set<() => void>();
let inflight: Promise<void> | null = null;
/** Bumped when the answer in the air asked its question before the last change. */
let generation = 0;

function set(next: Partial<Store>): void {
  store = { ...store, ...next };
  watchers.forEach((fn) => fn());
}

function reset(): void {
  generation += 1;
  inflight = null;
  store = EMPTY;
  watchers.forEach((fn) => fn());
}

/**
 * These belong to one signed-in session. Someone signing in second in the same
 * tab must never be handed the first learner's bell, and signing out is not
 * the only way that happens: `lib/records.ts` pays for the same guard.
 */
const own = ownedByToken(reset);

onSessionEnd(reset);

function snapshot(): Store {
  return store;
}

/** Nothing on the server: the bell is a fact about one signed-in browser. */
function serverSnapshot(): Store {
  return EMPTY;
}

function subscribe(fn: () => void): () => void {
  watchers.add(fn);
  wireSocket();
  return () => {
    watchers.delete(fn);
  };
}

/* -------------------------------- the socket ------------------------------ */

let wired = false;

/**
 * One subscription to the socket the app already has, for the life of the tab.
 *
 * Never `io()` again: `lib/socket.ts` owns the instance, its unbounded
 * reconnection and its authenticated handshake, and a second connection would
 * be a second room join for the same learner.
 */
function wireSocket(): void {
  if (wired || typeof window === 'undefined') return;
  const socket = getSocket();
  if (!socket) return; // no token yet; the next subscriber tries again
  wired = true;
  socket.on(SOCKET_EVENTS.notification, (event: NotificationEvent) => {
    own();
    if (!event?.notification) return;
    // The badge comes from the payload rather than from the length of what is
    // held: the panel draws eight rows and the count is all of them.
    set({
      items: [event.notification, ...store.items.filter((row) => row.id !== event.notification.id)],
      unread: event.unread,
      at: Date.now(),
      error: '',
    });
  });
}

/* --------------------------------- loading -------------------------------- */

const isStale = (): boolean => store.at === 0 || Date.now() - store.at > FRESH_MS;

/**
 * Fetch the rows unless the copy in hand is younger than a minute. Never
 * rejects: a bell that will not load is not a reason to fail a page.
 */
export function loadNotifications(force = false): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  own();
  if (!getToken()) return Promise.resolve();
  if (!force && !isStale()) return Promise.resolve();
  if (inflight) return inflight;
  const mine = generation;
  set({ loading: true });
  const p = request<NotificationListView>('GET', `/notifications?limit=${BELL_ROWS * 2}`)
    .then((list) => {
      if (mine !== generation) return;
      // A route that can answer nothing hands `request()` an empty object
      // rather than a payload, so the shape is checked rather
      // than trusted: a bell drawn from `undefined.map` is a blank page.
      const items = Array.isArray(list?.items) ? list.items : [];
      const unread = typeof list?.unread === 'number' ? list.unread : items.length;
      set({ items, unread, at: Date.now(), loading: false, error: '' });
    })
    .catch(() => {
      if (mine !== generation) return;
      // The rows and the count stay exactly as they were.
      set({
        loading: false,
        error: 'Your notifications could not be loaded. Try again in a moment.',
      });
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/* --------------------------------- writing -------------------------------- */

/**
 * Mark one read: optimistically, because the row is gone from the panel the
 * moment it is pressed and a round trip is not what the learner is waiting
 * for. A refusal puts it back and says so.
 */
export async function markNotificationRead(id: string): Promise<void> {
  own();
  const before = store;
  const row = before.items.find((item) => item.id === id);
  if (!row) return;
  set({
    items: before.items.filter((item) => item.id !== id),
    unread: Math.max(0, before.unread - 1),
    error: '',
  });
  const mine = generation;
  try {
    const { unread } = await request<{ unread: number }>('POST', `/notifications/${id}/read`);
    if (mine === generation) set({ unread, at: Date.now() });
  } catch {
    if (mine !== generation) return;
    set({ items: before.items, unread: before.unread, error: markFailed });
  }
}

/** The same for the whole block. */
export async function markAllNotificationsRead(): Promise<void> {
  own();
  const before = store;
  if (!before.items.length && !before.unread) return;
  set({ items: [], unread: 0, error: '' });
  const mine = generation;
  try {
    await request<{ unread: number }>('POST', '/notifications/read-all');
    if (mine === generation) set({ at: Date.now() });
  } catch {
    if (mine !== generation) return;
    set({ items: before.items, unread: before.unread, error: markFailed });
  }
}

const markFailed = 'That could not be marked as read. Try again in a moment.';

/* ---------------------------------- React --------------------------------- */

export interface Notifications {
  items: NotificationView[];
  unread: number;
  loading: boolean;
  error: string;
  /** Ask again now: the panel opening, the tab coming back, Try again. */
  reload: () => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

export function useNotifications(): Notifications {
  const state = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const reload = useCallback(() => {
    void loadNotifications(true);
  }, []);
  const markRead = useCallback((id: string) => {
    void markNotificationRead(id);
  }, []);
  const markAllRead = useCallback(() => {
    void markAllNotificationsRead();
  }, []);
  return {
    items: state.items,
    unread: state.unread,
    loading: state.loading,
    error: state.error,
    reload,
    markRead,
    markAllRead,
  };
}
