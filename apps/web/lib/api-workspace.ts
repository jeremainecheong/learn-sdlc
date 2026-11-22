'use client';

import type { PhaseDetail } from '@learnsdlc/shared';
import { API_BASE, REQUEST_TIMEOUT_MS, getToken, onSignOut, request, tokenAtSessionEnd } from './api';
import { authHeader } from './api-fetch';
import { sameSession } from './session-token';
import { PENDING_PREFIX } from './pending-action';
import { getSession, subscribe } from './session';

/** Kept as a name because the workspace page reads `updatedAt` off it to spot a copy saved from another tab. */
export type WorkspacePhaseDetail = PhaseDetail;

/**
 * The Fetch standard gives a page 64 KiB of `keepalive` body across every
 * request in flight, and rejects the whole request the moment it is exceeded.
 * The API accepts 200,000 characters per file, so a learner with a long file
 * had their exit save refused by their own browser: silently, because the
 * rejection landed in a catch with nothing to show it to. Above this the
 * request goes out as an ordinary one, which the browser may cancel on unload;
 * a request that might not finish beats one that is never sent.
 */
const KEEPALIVE_LIMIT = 60_000;

/** Where a save that did not land waits for the next visit. One key per phase. */
const DRAFT_PREFIX = 'lsdlc_draft_';
/** The file tree's remembered folds, kept by the workspace page under the same rule. */
const TREE_PREFIX = 'lsdlc_tree_';
/** Older than this and the copy on the server is the better guess. */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

interface Draft {
  at: number;
  /** Whose keystrokes these are. A draft is only ever replayed under the account that wrote it. */
  by: string;
  files: Record<string, string>;
  /** Versioned callers must never replay this draft over a different revision. */
  baseVersion?: string;
}

const draftKey = (id: string) => `${DRAFT_PREFIX}${id}`;

/** The account a draft would belong to right now, or null when nobody is signed in. */
const owner = (): string | null => getSession()?.id ?? null;

/**
 * The draft, with the moment it was written, or null when there is nothing
 * this account can use: no draft, one too old, one somebody else wrote.
 */
function readDraftRecord(id: string): { at: number; files: Record<string, string>; baseVersion?: string } | null {
  try {
    const raw = window.localStorage.getItem(draftKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Draft;
    if (!parsed || typeof parsed.at !== 'number' || !parsed.files) return null;
    if (Date.now() - parsed.at > DRAFT_TTL_MS) {
      dropDraft(id);
      return null;
    }
    // Written under another account, or under none: not this learner's to
    // read, and never to be sent to the server as theirs.
    const me = owner();
    if (!me || parsed.by !== me) {
      dropDraft(id);
      return null;
    }
    return { at: parsed.at, files: parsed.files, ...(typeof parsed.baseVersion === 'string' ? { baseVersion: parsed.baseVersion } : {}) };
  } catch {
    return null;
  }
}

function holdDraft(id: string, files: Record<string, string>, baseVersion?: string): void {
  // No account, no draft: there is nobody to replay it for, and a copy of a
  // learner's file left in a shared browser after they have gone is exactly
  // what the sweep below exists to prevent.
  const me = owner();
  if (!me) return;
  try {
    const prior = readDraftRecord(id);
    const version = baseVersion ?? prior?.baseVersion;
    const draft: Draft = { at: Date.now(), by: me, files: { ...prior?.files, ...files }, ...(version === undefined ? {} : { baseVersion: version }) };
    window.localStorage.setItem(draftKey(id), JSON.stringify(draft));
  } catch {
    // A browser that keeps nothing cannot be given a safety net; the request
    // below is the only chance these edits have.
  }
}

function dropDraft(id: string): void {
  try {
    window.localStorage.removeItem(draftKey(id));
  } catch {
    // nothing was kept, so there is nothing to remove
  }
}

/**
 * Forget only the files this write actually landed. Anything typed while it was
 * in flight is still owed to the server and stays in the draft.
 */
function dropSavedPaths(id: string, saved: Record<string, string>, nextVersion?: string): void {
  const record = readDraftRecord(id);
  const draft = record?.files;
  if (!draft) return;
  const left: Record<string, string> = {};
  for (const [path, content] of Object.entries(draft)) {
    if (saved[path] !== content) left[path] = content;
  }
  if (Object.keys(left).length === 0) {
    dropDraft(id);
    return;
  }
  const me = owner();
  if (!me) {
    dropDraft(id);
    return;
  }
  try {
    const version = nextVersion ?? record?.baseVersion;
    const kept: Draft = { at: Date.now(), by: me, files: left, ...(version === undefined ? {} : { baseVersion: version }) };
    window.localStorage.setItem(draftKey(id), JSON.stringify(kept));
  } catch {
    // as above
  }
}

/**
 * Everything the workspace keeps in this browser for the learner who has just
 * signed out: their unsaved files, their folded tree, and the action a session
 * ended under along with what they had typed for it (lib/pending-action.ts). A
 * lab computer is shared, and the next person at it can open the browser's
 * storage.
 */
export function forgetWorkspaceStorage(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && (key.startsWith(DRAFT_PREFIX) || key.startsWith(TREE_PREFIX) || key.startsWith(PENDING_PREFIX))) stale.push(key);
    }
    stale.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // nothing was kept, so there is nothing to remove
  }
}

/**
 * Everything the workspace keeps for anybody other than `keep`: drafts and
 * pending actions stamped with another account (or none), and, when the account
 * at this keyboard is known to have changed, the folded trees too.
 *
 * A pending action carries the same `by` stamp as a draft, so one check answers
 * for both.
 */
export function forgetOtherLearnersWorkspaceStorage(keep: string, treesToo: boolean): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(TREE_PREFIX)) {
        if (treesToo) stale.push(key);
        continue;
      }
      if (!key.startsWith(DRAFT_PREFIX) && !key.startsWith(PENDING_PREFIX)) continue;
      let by: unknown = null;
      try {
        by = (JSON.parse(window.localStorage.getItem(key) ?? 'null') as { by?: unknown } | null)?.by;
      } catch {
        by = null;
      }
      if (by !== keep) stale.push(key);
    }
    stale.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // nothing was kept, so there is nothing to remove
  }
}

if (typeof window !== 'undefined') {
  // Sign out is when a learner leaves the machine, so it is when their things
  // go. A session that ends under them (a token the API stops answering to
  // mid-edit) is not: they are about to sign back in, the draft is the only
  // copy of their last keystrokes, and it is stamped with their account, so
  // nobody else can be handed it (edges: an expiring token does not take the
  // last edit with it).
  onSignOut(forgetWorkspaceStorage);
  // Somebody else signing in on top (on a lab computer whose last learner
  // walked away from an expired session without pressing Sign out) takes
  // that learner's things with them. The account seen last is kept across the
  // signed-out gap so the same learner returning sweeps nothing of their own.
  let seen: string | null = getSession()?.id ?? null;
  subscribe(() => {
    const now = getSession()?.id ?? null;
    if (!now) return;
    if (now !== seen) forgetOtherLearnersWorkspaceStorage(now, seen !== null);
    seen = now;
  });
}

/** The size the browser will weigh, not the length of the string. */
function byteLength(body: string): number {
  return new TextEncoder().encode(body).length;
}

/**
 * The phase, with any edits that never reached the server put back.
 *
 * A save made on the way out can fail (a body the browser would not send, a
 * laptop that slept, a request the browser cancelled on unload) and the
 * learner is not there to be told. {@link saveWorkspaceOnExit} writes those
 * files down locally first, and this is where they are collected: on the next
 * load of the phase, whatever the server is still behind on is sent again
 * before the page draws. The learner opens the file and their text is in it.
 *
 * Two things a draft is never allowed to do: speak for another account (it is
 * read only under the one that wrote it), and write over a save the learner
 * made since from somewhere else. The second is the case of a draft left on
 * one machine and a newer save made on another; the server's stamp is later
 * than the draft, so the draft is the stale copy and is dropped.
 */
async function loadPhase(id: string): Promise<WorkspacePhaseDetail> {
  const detail = await request<WorkspacePhaseDetail>('GET', `/phases/${id}`);
  if (typeof window === 'undefined') return detail;
  const record = readDraftRecord(id);
  if (!record) return detail;
  // The Requirements saver restores these files with their original version
  // and displays conflicts. This draft replay must not silently rebase them.
  if (record.baseVersion !== undefined) return detail;
  const savedAt = detail.workspaceUpdatedAt ? Date.parse(detail.workspaceUpdatedAt) : NaN;
  if (Number.isFinite(savedAt) && savedAt > record.at) {
    dropDraft(id);
    return detail;
  }
  const draft = record.files;

  const behind: Record<string, string> = {};
  for (const file of detail.files) {
    // Only files this phase still lets the learner write: the API refuses any
    // other path outright, which would strand the whole draft.
    if (!file.editable) continue;
    const kept = draft[file.path];
    if (kept !== undefined && kept !== file.content) behind[file.path] = kept;
  }
  if (Object.keys(behind).length === 0) {
    dropDraft(id);
    return detail;
  }

  try {
    await request<{ saved: boolean }>('PUT', `/phases/${id}/workspace`, { files: behind });
  } catch {
    // Still no way through. Keep the draft and show the server's copy rather
    // than a version of the file that exists nowhere.
    return detail;
  }
  dropDraft(id);
  return {
    ...detail,
    files: detail.files.map((f) =>
      behind[f.path] !== undefined ? { ...f, content: behind[f.path] } : f,
    ),
  };
}

export const workspaceApi = {
  phase: (id: string) => loadPhase(id),
};

export interface VersionedWorkspaceDraft { files: Record<string, string>; baseVersion: string }

export function readVersionedWorkspaceDraft(id: string): VersionedWorkspaceDraft | null {
  const record = readDraftRecord(id);
  return record?.baseVersion === undefined ? null : { files: record.files, baseVersion: record.baseVersion };
}

/** These guards keep late replies from changing another signed-in learner's storage. */
export function rememberVersionedWorkspaceDraft(id: string, files: Record<string, string>, baseVersion: string, ownerId: string): void {
  if (owner() === ownerId && Object.keys(files).length) holdDraft(id, files, baseVersion);
}

export function acknowledgeVersionedWorkspaceSave(id: string, files: Record<string, string>, version: string, ownerId: string): void {
  if (owner() === ownerId) dropSavedPaths(id, files, version);
}

export function discardVersionedWorkspaceDraft(id: string, ownerId: string): void {
  if (owner() === ownerId) dropDraft(id);
}

/** A versioned exit save never changes credentials, rebases a conflict, or hides failure. */
export async function saveVersionedWorkspaceOnExit(
  id: string,
  files: Record<string, string>,
  context: { baseVersion: string; ownerId: string; token: string },
): Promise<{ version: string }> {
  if (owner() !== context.ownerId || !sameSession(getToken(), context.token)) throw new Error('The editing session changed. Sign in again to recover your draft.');
  rememberVersionedWorkspaceDraft(id, files, context.baseVersion, context.ownerId);
  const body = JSON.stringify({ files, baseVersion: context.baseVersion });
  const response = await fetch(`${API_BASE}/phases/${id}/workspace`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${context.token}` },
    body,
    keepalive: byteLength(body) <= KEEPALIVE_LIMIT,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error(response.status === 409
    ? 'This workspace changed elsewhere. Your draft is retained; compare it with the saved work before retrying.'
    : 'Your last edits could not be saved. Your draft is retained for this account.'), { status: response.status });
  const result = await response.json() as { version?: unknown };
  if (typeof result.version !== 'string') throw new Error('The save did not return its revision. Your draft is retained.');
  return { version: result.version };
}

/**
 * The last save, made on the way out: leaving the editor, switching phase, or
 * closing the tab.
 *
 * Typing is saved on a debounce, so a learner who types and immediately clicks
 * the sidebar has edits that no timer will ever fire for. This writes them
 * without the caller waiting for a result (the component that would have
 * shown one is already gone) and marks the request `keepalive` so the browser
 * finishes it even when the document is being torn down.
 *
 * It returns its promise all the same, because there is one caller that can
 * wait: the 401 handler, which flushes before it takes the browser to /login.
 * The files are written to local storage before the request and cleared when it
 * succeeds, so a save that never lands is offered back on the next visit
 * instead of disappearing.
 */
export function saveWorkspaceOnExit(id: string, files: Record<string, string>): Promise<void> {
  if (typeof window === 'undefined' || Object.keys(files).length === 0) return Promise.resolve();
  holdDraft(id, files);
  // A session that has just ended still has the token it ended with, and a
  // signed write the server may refuse beats an unsigned one it certainly will.
  const token = getToken() ?? tokenAtSessionEnd();
  const body = JSON.stringify({ files });
  return fetch(`${API_BASE}/phases/${id}/workspace`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...authHeader(token),
    },
    body,
    keepalive: byteLength(body) <= KEEPALIVE_LIMIT,
  })
    .then((res) => {
      if (res.ok) dropSavedPaths(id, files);
    })
    .catch(() => undefined);
}
