'use client';

/**
 * Who is signed in, as an external store.
 *
 * The shell is drawn once, above the router, and it names the learner and
 * filters the sidebar by their role. Reading that from localStorage inside an
 * effect keyed on the pathname would make every navigation commit one frame
 * with no name and a one-entry sidebar before the effect put them back. So the profile lives in
 * one module-level store instead: written by the few places that change it,
 * read synchronously by anything that renders it, and subscribed to by React
 * through `useSyncExternalStore`.
 *
 * The server snapshot is `null` because the server has no storage. That costs
 * one flip on the first hydration of a full page load, which is the only place
 * it is unavoidable; every client navigation after that reads the store as it
 * already is.
 */
import { useSyncExternalStore } from 'react';
import type { UserProfile } from '@learnsdlc/shared';
import { sameSession } from './session-token';
import { DRILL_ALERT_PREFIX } from './drill-alert-key';
import { CLASS_CODE_FOR_KEY, CLASS_CODE_KEY, DOTTED_KEY, PROFILE_DRAFT_KEY, REGISTRATION_EMAIL_KEY } from './storage-keys';

export const TOKEN_KEY = 'lsdlc_token';
export const USER_KEY = 'lsdlc_user';

type Listener = () => void;

const listeners = new Set<Listener>();
/** Run when a session ends, so per-learner caches can drop what they hold. */
const enders = new Set<() => void>();

/**
 * The snapshot React compares. It has to be referentially stable between
 * changes or `useSyncExternalStore` re-renders forever, so the parsed profile
 * is kept here and only replaced when the stored string actually changes.
 */
let current: UserProfile | null = null;
let raw: string | null = null;
let read = false;
let watching = false;
type SessionStorage = 'localStorage' | 'sessionStorage';
let selectedStorage: SessionStorage = 'localStorage';
let memoryToken: string | null = null;
let storageRefuses = false;

function storage(): Storage { return window[selectedStorage]; }
function removeFrom(store: SessionStorage, key: string): void {
  try { window[store].removeItem(key); } catch { /* Refused storage stays in memory. */ }
}
function selectStorage(): void {
  try {
    if (window.sessionStorage.getItem(TOKEN_KEY) || window.sessionStorage.getItem(USER_KEY)) selectedStorage = 'sessionStorage';
  } catch { /* A browser may refuse either store independently. */ }
}

function parse(value: string | null): UserProfile | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed as UserProfile;
  } catch {
    // fall through: a value we cannot parse is a value we cannot use
  }
  return null;
}

function readStorage(): string | null {
  try {
    return storage().getItem(USER_KEY);
  } catch {
    return null;
  }
}

/**
 * Take a stored string as the truth and tell everyone. Used for a change made
 * somewhere else: another tab, or this one's own storage event. The first
 * read in {@link getSession} does the same work without notifying, because
 * nothing is subscribed yet.
 */
function adopt(value: string | null): void {
  if (value === raw) return;
  raw = value;
  current = parse(value);
  if (value && !current) {
    // Structurally wrong: drop it rather than throwing on every render of
    // every page, including the error boundary's way out.
    try {
      storage().removeItem(USER_KEY);
    } catch {
      // storage refused; the parsed value is null either way
    }
    raw = null;
  }
  listeners.forEach((fn) => fn());
}

/** The signed-in profile, or null. Safe on the server, where it is always null. */
export function getSession(): UserProfile | null {
  if (typeof window === 'undefined') return null;
  if (!read) {
    read = true;
    selectStorage();
    const value = readStorage();
    raw = value;
    current = parse(value);
    if (value && !current) {
      try {
        storage().removeItem(USER_KEY);
      } catch {
        // storage refused; the parsed value is null either way
      }
      raw = null;
    }
  }
  return current;
}

/** Nothing on the server: the profile is a client fact. */
export function getServerSession(): null {
  return null;
}

/**
 * The bearer token as stored. It lives here rather than beside the requests it
 * signs because it is also what every per-learner cache checks itself against;
 * `lib/api` re-exports it, so callers still read it from there.
 */
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  getSession();
  if (storageRefuses) return memoryToken;
  try {
    return storage().getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Ties a cache to the learner whose token filled it.
 *
 * Returns a check to call before every read and write: it empties the cache
 * the moment the token is not the one it was filled under. Signing out fires
 * {@link onSessionEnd}, and so does signing in as someone else over the top of
 * a live session in this tab ({@link setAuthSession} ends the old one when the
 * token changes). What fires nothing is a token that changes underneath this
 * tab (another tab signing a different account into shared storage, which
 * this tab only hears as a new profile) and a cache that only listened for
 * the end of a session would hand the second learner the first one's work.
 * This check is what catches that case, and it costs nothing in the others.
 */
export function ownedByToken(drop: () => void): () => void {
  let owner: string | null = null;
  return () => {
    const token = getToken();
    if (token === owner) return;
    // A background renewal (lib/api.ts) replaces the token, not the learner.
    if (sameSession(token, owner)) { owner = token; return; }
    drop();
    owner = token;
  };
}

export function subscribe(listener: Listener): () => void {
  if (!watching && typeof window !== 'undefined') {
    watching = true;
    window.addEventListener('storage', (e: StorageEvent) => {
      // A temporary sign-in belongs to this tab. A different tab's remembered
      // account must not replace its profile or authorize its cached work.
      if (selectedStorage === 'sessionStorage' && e.storageArea !== window.sessionStorage) return;
      if (selectedStorage === 'localStorage' && e.storageArea === window.sessionStorage) return;
      if (e.key === USER_KEY) adopt(e.newValue);
      if ((e.key === TOKEN_KEY && !e.newValue) || e.key === null) {
        clearSessionDrafts();
        memoryToken = null;
        adopt(null);
        enders.forEach(fn => fn());
      }
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Writes the profile through to storage and tells everything that shows it. */
export function setSession(user: UserProfile | null): void {
  if (typeof window === 'undefined') return;
  getSession();
  read = true;
  const value = user ? JSON.stringify(user) : null;
  try {
    if (value) storage().setItem(USER_KEY, value);
    else storage().removeItem(USER_KEY);
  } catch {
    // storage refused; the store still holds the truth for this page
  }
  raw = value;
  current = user;
  listeners.forEach((fn) => fn());
  if (!user) enders.forEach((fn) => fn());
}

/**
 * Whether two profiles say the same thing.
 *
 * The shell refetches the profile on every mount, so that a lost or
 * unparseable one comes back and an admin's role change takes effect without a
 * re-login. The answer is usually identical to what is already stored, and
 * writing it back would notify every subscriber for nothing, so the shell
 * compares first.
 */
export function sameProfile(a: UserProfile | null, b: UserProfile | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.email === b.email &&
    a.displayName === b.displayName &&
    a.role === b.role &&
    a.cohort === b.cohort &&
    a.avatar === b.avatar && a.bio === b.bio && a.goals === b.goals &&
    a.onboardingCompleted === b.onboardingCompleted && a.profileVersion === b.profileVersion
  );
}

/** Start an authenticated session in the learner's selected browser store.
 * Returns false if that store refused either credential; the current page
 * still has a consistent in-memory token and profile in that case. */
export function setAuthSession(token: string, user: UserProfile, options: { persist?: boolean } = {}): boolean {
  if (typeof window === 'undefined') return false;
  const previousToken = getToken();
  if (previousToken !== token) {
    removeFrom('sessionStorage', PROFILE_DRAFT_KEY);
    removeFrom('sessionStorage', DOTTED_KEY[PROFILE_DRAFT_KEY]);
  }
  selectedStorage = options.persist === false ? 'sessionStorage' : 'localStorage';
  const other: SessionStorage = selectedStorage === 'localStorage' ? 'sessionStorage' : 'localStorage';
  removeFrom(other, TOKEN_KEY);
  removeFrom(other, USER_KEY);
  read = true;
  memoryToken = token;
  raw = JSON.stringify(user);
  current = user;
  try {
    storage().setItem(USER_KEY, raw);
    storage().setItem(TOKEN_KEY, token);
    storageRefuses = storage().getItem(TOKEN_KEY) !== token || storage().getItem(USER_KEY) !== raw;
  } catch { storageRefuses = true; }
  if (storageRefuses) {
    // Do not leave a partial credential that could revive after a reload.
    removeFrom(selectedStorage, TOKEN_KEY);
    removeFrom(selectedStorage, USER_KEY);
  }
  if (previousToken && previousToken !== token) enders.forEach(fn => fn());
  listeners.forEach(fn => fn());
  return !storageRefuses;
}

/**
 * Put a renewed token in place of the one it renews, in the store the sign-in
 * chose (remembered or this tab only), and nothing else: the profile, the
 * caches and the drafts all belong to the same session and stay. Refused,
 * leaving the old token where it was, when the stored token is no longer
 * `previous` (a sign-out or another sign-in got there first), when `next` is
 * not a renewal of the same sign-in, or when the store will not keep it.
 */
export function replaceSessionToken(previous: string, next: string): boolean {
  if (typeof window === 'undefined') return false;
  if (getToken() !== previous || !sameSession(previous, next)) return false;
  if (storageRefuses) {
    memoryToken = next;
    return true;
  }
  try {
    storage().setItem(TOKEN_KEY, next);
    if (storage().getItem(TOKEN_KEY) !== next) {
      storage().setItem(TOKEN_KEY, previous);
      return false;
    }
  } catch {
    return false;
  }
  memoryToken = next;
  return true;
}

/** Ends both remembered and temporary credentials and all per-learner caches. */
export function clearSession(): void {
  if (typeof window === 'undefined') return;
  clearSessionDrafts();
  for (const store of ['localStorage', 'sessionStorage'] as const) {
    removeFrom(store, TOKEN_KEY);
    removeFrom(store, USER_KEY);
  }
  memoryToken = null;
  storageRefuses = false;
  selectedStorage = 'localStorage';
  read = true;
  raw = null;
  current = null;
  listeners.forEach(fn => fn());
  enders.forEach(fn => fn());
}

function clearSessionDrafts(): void {
  for (const key of [PROFILE_DRAFT_KEY, CLASS_CODE_KEY, CLASS_CODE_FOR_KEY, REGISTRATION_EMAIL_KEY]) {
    removeFrom('sessionStorage', key);
    removeFrom('sessionStorage', DOTTED_KEY[key]);
  }
  // An incident drill's alert text, kept per phase for this tab: removed here, so a sign-out on a page that never
  // loaded the drill's code (Home after a reload) leaves none of it for the next account in the tab.
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(DRILL_ALERT_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch { /* Refused storage holds nothing to remove. */ }
}

/**
 * Register a cache to empty when the session ends. Returns the unregister
 * function, though module-level caches never need it.
 */
export function onSessionEnd(fn: () => void): () => void {
  enders.add(fn);
  return () => {
    enders.delete(fn);
  };
}

/** The profile as React state. `null` on the server and during hydration. */
export function useSession(): UserProfile | null {
  return useSyncExternalStore(subscribe, getSession, getServerSession);
}

/** The role alone, which is all the sidebar needs. */
export function useRole(): UserProfile['role'] | undefined {
  return useSession()?.role;
}
