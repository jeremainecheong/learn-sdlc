'use client';

import { sameSession, sessionKey } from '@/lib/session-token';
import { useEffect, useMemo, useReducer } from 'react';
import type { PhaseDetail } from '@learnsdlc/shared';
import { api, describeError, getToken, onSessionLeaving } from '@/lib/api';
import { getSession, useSession } from '@/lib/session';
import {
  acknowledgeVersionedWorkspaceSave, readVersionedWorkspaceDraft,
  rememberVersionedWorkspaceDraft, saveVersionedWorkspaceOnExit, discardVersionedWorkspaceDraft,
} from '@/lib/api-workspace';

/** How long typing must pause before the workspace is saved. */
export const WORKSPACE_SAVE_DELAY_MS = 700;
const CONFLICT = 'This workspace changed elsewhere. Your draft is retained; compare it with the saved work before retrying.';
/** An edit made on the copy a reset replaced, before the reset copy loaded. */
const RESET_UNLOADED = 'This task was started over, but its fresh copy has not loaded yet. Your edit is kept here and is not saved over it; reload the page to compare.';

/** One queue per mounted phase and session. Its callbacks cannot adopt another account. */
class VersionedWorkspaceSaver {
  detail: PhaseDetail | null = null;
  version: string | null = null;
  typed: Record<string, string> = {};
  dirty: Record<string, string> = {};
  saveError = '';
  conflict: PhaseDetail | null = null;
  saving = false;
  active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private exiting = false;
  private conflictDetected = false;
  /** A reset's version and paths, until a copy at least that new has been adopted. */
  private resetAwaiting: { version: string; before: string | null; paths: Set<string> } | null = null;
  notify: () => void = () => undefined;

  constructor(readonly phaseId: string, readonly ownerId: string | null, readonly token: string | null) {}
  /** The same account and the same sign-in: a background renewal of the token (lib/api.ts) keeps the saver. */
  private ownsSession = () => !!this.ownerId && !!this.token && getSession()?.id === this.ownerId && sameSession(getToken(), this.token);
  private emit = () => { if (this.active && this.ownsSession()) this.notify(); };
  private remember = () => {
    // A draft of the copy a reset replaced is kept against the version before
    // the reset, so a later load compares it instead of saving it.
    const held = this.resetAwaiting;
    const base = held?.before && Object.keys(this.dirty).some(path => held.paths.has(path)) ? held.before : this.version;
    if (this.ownsSession() && base !== null) rememberVersionedWorkspaceDraft(this.phaseId, this.dirty, base, this.ownerId!);
  };
  private cancelTimer = () => { if (this.timer) clearTimeout(this.timer); this.timer = null; };
  private scheduleSave = () => {
    this.cancelTimer();
    if (!this.active || !this.ownsSession() || this.exiting || this.inFlight || this.conflictDetected || this.detail?.status === 'locked' || !Object.keys(this.dirty).length) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flushSave().catch(() => { /* saveError keeps the failure visible until a retry succeeds. */ }); }, WORKSPACE_SAVE_DELAY_MS);
  };

  adopt(detail: PhaseDetail | null) {
    if (!detail || detail.id !== this.phaseId || !this.ownsSession()) return;
    const first = this.version === null;
    const serverVersion = detail.workspaceUpdatedAt ?? '';
    const knownVersion = [this.version ?? '', this.detail?.workspaceUpdatedAt ?? '', this.conflict?.workspaceUpdatedAt ?? ''].sort().at(-1)!;
    if (!first && serverVersion < knownVersion) {
      // A request begun before a reviewed resolution may arrive afterwards.
      // Keep its status/permission metadata, but never pair its old file bytes
      // with our newer write version: that would authorize a lost update.
      const retained = this.conflict && (this.conflict.workspaceUpdatedAt ?? '') >= (this.detail?.workspaceUpdatedAt ?? '') ? this.conflict : this.detail;
      if (retained) this.detail = { ...detail, files: retained.files, workspaceUpdatedAt: retained.workspaceUpdatedAt };
      this.emit();
      return;
    }
    this.detail = detail;
    if (this.resetAwaiting && serverVersion >= this.resetAwaiting.version) {
      // The reset copy is here. An edit made on the copy it replaced is
      // compared with it, never saved over it.
      this.resetAwaiting = null;
      if (this.conflictDetected && !this.conflict && Object.keys(this.dirty).length) {
        this.conflict = detail;
        this.saveError = CONFLICT;
        this.cancelTimer();
        this.emit();
        return;
      }
    }
    if (first) {
      this.version = serverVersion;
      const draft = readVersionedWorkspaceDraft(this.phaseId);
      if (draft) {
        const editable = detail.files.filter(file => file.editable);
        const restored = Object.fromEntries(editable.filter(file => draft.files[file.path] !== undefined).map(file => [file.path, draft.files[file.path]]));
        const caughtUp = Object.entries(restored).every(([path, content]) => detail.files.find(file => file.path === path)?.content === content);
        if (caughtUp) acknowledgeVersionedWorkspaceSave(this.phaseId, draft.files, serverVersion, this.ownerId!);
        else {
          this.version = draft.baseVersion;
          this.typed = restored;
          this.dirty = { ...restored };
          if (draft.baseVersion !== serverVersion) { this.saveError = CONFLICT; this.conflict = detail; this.conflictDetected = true; }
        }
      }
    } else if (this.conflict && serverVersion !== this.version) {
      this.conflict = detail;
    } else if (!this.inFlight && Object.keys(this.dirty).length && serverVersion !== this.version) {
      this.conflict = detail;
      this.conflictDetected = true;
      this.saveError = CONFLICT;
      this.cancelTimer();
    } else if (!this.inFlight && !Object.keys(this.dirty).length && serverVersion >= this.version!) {
      this.version = serverVersion;
      this.typed = {};
    }
    if (first) this.scheduleSave();
    this.emit();
  }

  setFile = (path: string, content: string): void => {
    if (!this.ownsSession() || this.detail?.status === 'locked' || !this.detail?.files.some(file => file.path === path && file.editable)) return;
    this.typed = { ...this.typed, [path]: content };
    this.dirty[path] = content;
    if (this.resetAwaiting?.paths.has(path)) {
      // The screen still shows the words the reset replaced: hold the edit
      // for a comparison instead of saving it over the starter.
      this.conflictDetected = true;
      this.saveError = RESET_UNLOADED;
    }
    this.remember();
    this.scheduleSave();
    this.emit();
  };

  flushSave = (): Promise<void> => {
    this.cancelTimer();
    if (!this.ownsSession() || this.version === null) return Promise.reject(new Error('The editing session changed. Sign in again to recover your draft.'));
    if (this.inFlight) return this.inFlight;
    if (!Object.keys(this.dirty).length) return Promise.resolve();
    if (this.conflictDetected) {
      // A retry can recover a missing comparison, but it cannot authorize an
      // overwrite. Only resolveConflict may use the reviewed server version.
      if (this.conflict) return Promise.reject(new Error(CONFLICT));
      this.saving = true;
      this.emit();
      this.inFlight = api.phase(this.phaseId).then(fresh => {
        if (!this.ownsSession() || fresh.id !== this.phaseId) throw new Error('The editing session changed. Sign in again to recover your draft.');
        this.conflict = fresh;
        this.saveError = CONFLICT;
        throw new Error(CONFLICT);
      }).catch((error: unknown) => {
        if (this.ownsSession() && !this.conflict) this.saveError = 'Your draft is retained, but the saved copy could not be loaded for comparison. Check your connection and retry saving.';
        throw error;
      }).finally(() => { this.inFlight = null; this.saving = false; this.emit(); });
      return this.inFlight;
    }
    this.saving = true;
    this.emit();
    // Start in a microtask so synchronous JSON + Markdown updates form one
    // snapshot. Later edits wait for the preceding revision to be acknowledged.
    this.inFlight = Promise.resolve().then(async () => {
      while (Object.keys(this.dirty).length) {
        if (!this.ownsSession()) throw new Error('The editing session changed. Sign in again to recover your draft.');
        if (this.detail?.status === 'locked') throw new Error('This phase is locked. Your draft has not been submitted.');
        const files = { ...this.dirty };
        const result = this.exiting
          ? await saveVersionedWorkspaceOnExit(this.phaseId, files, { baseVersion: this.version!, ownerId: this.ownerId!, token: getToken() ?? this.token! })
          : await api.saveWorkspace(this.phaseId, files, this.version!);
        if (!this.ownsSession()) throw new Error('The editing session changed. Sign in again to recover your draft.');
        if (typeof result.version !== 'string') throw new Error('The save did not return its revision. Your draft is retained.');
        const newer = [this.detail, this.conflict].filter((detail): detail is PhaseDetail => Boolean(detail && (detail.workspaceUpdatedAt ?? '') > result.version))
          .sort((a, b) => (b.workspaceUpdatedAt ?? '').localeCompare(a.workspaceUpdatedAt ?? ''))[0];
        if (newer && Object.entries(files).some(([path, content]) => newer.files.find(file => file.path === path)?.content !== content)) {
          // The write landed before another tab's newer save. Its delayed
          // acknowledgment must not erase this draft or call it current.
          this.version = result.version;
          this.conflict = newer;
          this.conflictDetected = true;
          this.saveError = CONFLICT;
          this.remember();
          throw new Error(CONFLICT);
        }
        this.version = newer?.workspaceUpdatedAt ?? result.version;
        for (const [path, content] of Object.entries(files)) if (this.dirty[path] === content) delete this.dirty[path];
        acknowledgeVersionedWorkspaceSave(this.phaseId, files, this.version, this.ownerId!);
        this.remember();
      }
      this.saveError = '';
      this.conflict = null;
      this.conflictDetected = false;
    }).catch(async (error: unknown) => {
      if (this.ownsSession()) {
        this.remember();
        this.saveError = describeError(error, error instanceof Error ? error.message : 'Your last edits could not be saved. Your draft is retained.');
        if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
          this.conflictDetected = true;
          this.cancelTimer();
          try {
            const fresh = await api.phase(this.phaseId);
            if (this.ownsSession() && fresh.id === this.phaseId) { this.conflict = fresh; this.saveError = CONFLICT; }
          } catch {
            if (this.ownsSession()) this.saveError = 'Your draft is retained, but the saved copy could not be loaded for comparison. Check your connection and retry saving.';
          }
        }
      }
      throw error;
    }).finally(() => { this.inFlight = null; this.saving = false; this.emit(); });
    return this.inFlight;
  };

  resolveConflict = async (choice: 'saved' | 'draft', reviewedVersion: string): Promise<void> => {
    if (!this.ownsSession()) throw new Error('The editing session changed. Sign in again to recover your draft.');
    if (this.inFlight) throw new Error('Wait for the current save before resolving this conflict.');
    const reviewed = this.conflict;
    if (!reviewed || (reviewed.workspaceUpdatedAt ?? '') !== reviewedVersion) throw new Error('The comparison changed. Review the saved copy again before choosing.');
    this.cancelTimer();
    if (this.resetAwaiting && reviewedVersion >= this.resetAwaiting.version) this.resetAwaiting = null;
    this.detail = reviewed;
    this.version = reviewedVersion;
    this.conflict = null;
    this.conflictDetected = false;
    this.saveError = '';
    if (choice === 'saved') {
      this.dirty = {};
      this.typed = {};
      discardVersionedWorkspaceDraft(this.phaseId, this.ownerId!);
      this.emit();
      return;
    }
    this.remember();
    this.emit();
    await this.flushSave();
  };

  /**
   * The learner started a task over. The room flushed
   * before the reset, so nothing typed is lost here: the reset's paths leave
   * the buffer and the draft, the version the reset answered is the one every
   * later save quotes, and the room's reload is then no conflict.
   */
  adoptReset = (version: string, paths: readonly string[]): void => {
    if (!this.ownsSession()) return;
    this.cancelTimer();
    const before = this.version;
    const typed = { ...this.typed };
    for (const path of paths) {
      delete this.dirty[path];
      delete typed[path];
    }
    this.typed = typed;
    if (Object.keys(this.dirty).length) this.remember();
    else discardVersionedWorkspaceDraft(this.phaseId, this.ownerId!);
    this.version = version;
    this.conflict = null;
    this.conflictDetected = false;
    this.saveError = '';
    // Until the room's reload lands, the paths still show pre-reset bytes.
    this.resetAwaiting = (this.detail?.workspaceUpdatedAt ?? '') >= version ? null : { version, before, paths: new Set(paths) };
    this.emit();
  };

  /** The version the next write quotes, read when called (not at render). */
  currentVersion = (): string | null => this.version;

  leave = (): void => {
    this.cancelTimer();
    this.exiting = true;
    this.remember();
    if (this.conflictDetected) return;
    // If a request is already running, its queue drains the remaining draft
    // using that response's revision; never send a competing exit overwrite.
    void this.flushSave().catch(() => { /* Already retained locally and in saveError. */ });
  };
  resume = (): void => { this.exiting = false; this.scheduleSave(); };
}

export function useVersionedWorkspaceSave(phaseId: string, detail: PhaseDetail | null) {
  const session = useSession();
  const token = getToken();
  // Keyed on the sign-in, not the token string: a renewal must not rebuild the
  // queue (and lose its version and pending keystrokes) under the learner.
  const key = sessionKey(token);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const saver = useMemo(() => new VersionedWorkspaceSaver(phaseId, session?.id ?? null, token), [phaseId, session?.id, key]);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  saver.notify = redraw;

  useEffect(() => {
    saver.active = true;
    saver.resume();
    const unregister = onSessionLeaving(saver.leave);
    window.addEventListener('pagehide', saver.leave);
    window.addEventListener('pageshow', saver.resume);
    window.addEventListener('online', saver.resume);
    return () => {
      saver.leave();
      saver.active = false;
      unregister();
      window.removeEventListener('pagehide', saver.leave);
      window.removeEventListener('pageshow', saver.resume);
      window.removeEventListener('online', saver.resume);
    };
  }, [saver]);
  useEffect(() => { saver.adopt(detail); }, [saver, detail]);

  const files: Record<string, string> = {};
  for (const file of (saver.detail ?? detail)?.files ?? []) files[file.path] = saver.typed[file.path] ?? file.content;
  return { files, setFile: saver.setFile, flushSave: saver.flushSave, saveError: saver.saveError, saving: saver.saving, dirty: Object.keys(saver.dirty).length > 0, savedVersion: saver.version, currentVersion: saver.currentVersion, conflict: saver.conflict, resolveConflict: saver.resolveConflict, adoptReset: saver.adoptReset };
}
