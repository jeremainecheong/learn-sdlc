'use client';

/**
 * Everything the pull request page reads, loaded once.
 *
 * The phase detail, every submission for the phase, and the workspace
 * snapshots of the selected submission and its predecessor, the head of the pull request and the base
 * it is read against. The derivations are the ones the implementation panel
 * already uses; only the diff and the merge belong to this page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PASS_THRESHOLD, type PhaseDetail, type SubmissionView } from '@learnsdlc/shared';
import { api, describeError } from '@/lib/api';
import { clearCommitDraft, commitDraft } from '@/lib/commit';
import { jobWake } from '@/lib/job-signal';
import { PollTimeoutError, pollUntil, useRecoverWhenBack } from '@/lib/poll';
import { setActiveProject } from '@/lib/project';
import { invalidateProject } from '@/lib/useProject';
import {
  buildLedger,
  buildRevisions,
  timeOf,
  type Revision,
} from '@/components/workspace/panels/implementation/pr';
import { soleWorkTaskKey, submitArgs } from '@/components/workspace/TaskPanel';
import { isRoomRecordPath } from '@/components/workspace/records';
import { fileDiff, type FileDiff } from './diff';
import { carriedThreads, prThreads, threadsOn, type PrThread } from './threads';

const settled = (job: { status: SubmissionView['status'] }) =>
  job.status === 'completed' || job.status === 'failed';

export interface PullRequest {
  detail: PhaseDetail | null;
  /** Every submission, oldest first. */
  revisions: Revision[];
  /** Latest reviewed submission; historical file selection never changes the gate. */
  head: Revision | null;
  threads: PrThread[];
  diffs: FileDiff[];
  /**
   * True when the head's files have been read back and are not kept any more:
   * retention keeps the newest five revisions per phase and everything that passed,
   * and nulls the workspace copy on the rest.
   */
  filesPruned: boolean;
  baseFilesPruned: boolean;
  fileRevision: Revision | null;
  fileBase: Revision | null;
  filesLoading: boolean;
  filesError: string;
  selectRevision: (id: string | null) => void;
  retryFiles: () => void;
  /**
   * Whether a revision's files are still kept: true when they have been read
   * back, false when retention has pruned them, undefined when this page never
   * asked: only the two newest graded revisions are ever fetched.
   */
  filesKept: (id: string) => boolean | undefined;
  /** Threads on a file, in line order. */
  threadsFor: (path: string) => PrThread[];
  ledger: ReturnType<typeof buildLedger>;
  /** The gate this phase's score has to cross. */
  gate: number;
  /** The base of the diff, when there was a previous revision to read against. */
  baseAttempt: number | null;
  openedAt: string;
  loading: boolean;
  error: string;
  notice: string;
  busy: boolean;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
  /**
   * Submit again, with what the learner said this revision changes. Called
   * with nothing (the header button, ⌘↵) it sends the draft the Commit
   * field is holding for this phase.
   */
  submit: (commitMessage?: string) => Promise<void>;
  reload: () => Promise<void>;
  /** Load the pull request again after a failure: the Try again control. */
  retry: () => void;
}

/**
 * `selectedTask` is which task of a split phase the room is on.
 * Left out (which is every phase this room draws while coding, testing and
 * deployment phases stay single-task) the submit reaches the phase route,
 * which resolves the phase's only task itself.
 */
export function usePullRequest(phaseId: string, selectedTask?: string | null): PullRequest {
  const [detail, setDetail] = useState<PhaseDetail | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionView[]>([]);
  // `undefined` is a revision whose files have not been read yet; `null` is one
  // whose files are not kept any more (retention prunes all but the newest five per
  // phase and everything that passed). The two must not be the same value: an
  // empty file map is a diff that deletes the world.
  const [snapshots, setSnapshots] = useState<Record<string, Record<string, string> | null>>({});
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [snapshotErrors, setSnapshotErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const currentPhase = useRef(phaseId);
  currentPhase.current = phaseId;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    // The phase route resolves a phase's only task and refuses a
    // phase a teacher has split, so the phase is read first and its revisions
    // are asked for under the task the refused route would have resolved (the
    // phase's one piece of work). A phase with one task makes the same call,
    // a moment later.
    const d = await api.phase(phaseId);
    const list = await api.submissions(phaseId, soleWorkTaskKey(d.tasks));
    if (!alive.current || currentPhase.current !== phaseId) return;
    setActiveProject(d.projectSlug);
    setDetail(d);
    setSubmissions(list);
    setLoading(false);

  }, [phaseId]);

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setLoading(true);
    setAttempt((n) => n + 1);
  }, []);
  // The recovery loop: while the room is showing a failure it picks the
  // connection back up on its own.
  useRecoverWhenBack(Boolean(error) && !detail, retry);

  useEffect(() => {
    setSelectedRevisionId(null);
    setSnapshots({});
    setSnapshotErrors({});
    setDetail(null);
    setSubmissions([]);
    setLoading(true);
  }, [phaseId]);

  useEffect(() => {
    setError('');
    // `e.message` on a dead API is the browser's own "Failed to fetch", which
    // says nothing a learner can act on. describeError writes the sentence the
    // rest of the product uses.
    load().catch((e: unknown) => {
      if (!alive.current || currentPhase.current !== phaseId) return;
      setError(describeError(e, 'The pull request could not be loaded. Try again.'));
      setLoading(false);
    });
  }, [load, attempt]);

  const gate = detail?.rubric.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const revisions = useMemo(() => buildRevisions(submissions, gate), [submissions, gate]);

  const graded = useMemo(() => revisions.filter((r) => r.report), [revisions]);
  const head = graded[graded.length - 1] ?? null;
  const previous = graded[graded.length - 2] ?? null;
  const fileRevision = (selectedRevisionId ? graded.find(r => r.id === selectedRevisionId) : head) ?? null;
  const fileIndex = fileRevision ? graded.findIndex(r => r.id === fileRevision.id) : -1;
  const fileBase = fileIndex > 0 ? graded[fileIndex - 1] : null;
  const selectRevision = useCallback((id: string | null) => {
    if (id !== null && !graded.some(r => r.id === id)) return;
    setSelectedRevisionId(id);
  }, [graded]);
  const retryFiles = useCallback(() => setSnapshotErrors({}), []);

  // Selecting history reads only the exact selected pair. A stale response can
  // populate neither another phase nor a newer selection, and an absent base
  // must never be silently treated as an empty file and shown as all additions.
  useEffect(() => {
    const ids = [fileRevision?.id, fileBase?.id].filter((id): id is string => Boolean(id));
    const wanted = ids.filter(id => snapshots[id] === undefined && !snapshotErrors[id]);
    if (!wanted.length) return;
    let cancelled = false;
    void Promise.all(wanted.map(async id => {
      try {
        const full = await api.getSubmissionWithFiles(id);
        if (full.id !== id) throw new Error('The saved revision does not match the requested submission.');
        return { id, snapshot: full.workspaceSnapshot ?? null, error: '' };
      } catch (error) {
        return { id, snapshot: undefined, error: describeError(error, 'The saved files could not be loaded. Retry to read this revision.') };
      }
    })).then(results => {
      if (cancelled || !alive.current || currentPhase.current !== phaseId) return;
      setSnapshots(previous => ({ ...previous, ...Object.fromEntries(results.filter(r => r.snapshot !== undefined).map(r => [r.id, r.snapshot])) }));
      setSnapshotErrors(previous => ({ ...previous, ...Object.fromEntries(results.filter(r => r.error).map(r => [r.id, r.error])) }));
    });
    return () => { cancelled = true; };
  }, [fileRevision?.id, fileBase?.id, phaseId, snapshots, snapshotErrors]);
  const fileIds = [fileRevision?.id, fileBase?.id].filter((id): id is string => Boolean(id));
  const filesLoading = fileIds.some(id => snapshots[id] === undefined && !snapshotErrors[id]);
  const filesError = [...new Set(fileIds.map(id => snapshotErrors[id]).filter(Boolean))].join(' ');

  const later = useMemo(
    () => (head ? revisions.filter((r) => r.attempt > head.attempt) : []),
    [revisions, head],
  );

  const phaseKey = detail?.key;
  // The head's threads are the open argument; the ones the head settled are
  // kept alongside them, on the base's lines, so the diff reads as one review
  // rather than as whatever the last submission happened to leave.
  const threads = useMemo(() => {
    if (!phaseKey) return [];
    const open = prThreads(phaseKey, head, later);
    const keys = new Set(open.map((t) => t.key));
    return [...open, ...carriedThreads(phaseKey, previous, head).filter((t) => !keys.has(t.key))];
  }, [phaseKey, head, previous, later]);

  const fileThreads = useMemo(() => {
    if (!phaseKey || !fileRevision) return [];
    const following = revisions.filter(r => r.attempt > fileRevision.attempt);
    const open = prThreads(phaseKey, fileRevision, following);
    const keys = new Set(open.map(t => t.key));
    return [...open, ...carriedThreads(phaseKey, fileBase, fileRevision).filter(t => !keys.has(t.key))];
  }, [phaseKey, fileRevision, fileBase, revisions]);

  const diffs = useMemo(() => {
    if (!fileRevision) return [];
    const after = snapshots[fileRevision.id];
    if (!after) return [];
    if (fileBase && !snapshots[fileBase.id]) return [];
    const before = fileBase ? snapshots[fileBase.id] ?? undefined : undefined;
    // A room record (the runbook, the change request) is written through forms, never read as a file diff.
    const paths = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].sort().filter((path) => !isRoomRecordPath(path));
    const out: FileDiff[] = [];
    for (const path of paths) {
      const here = fileThreads.filter((t) => t.path === path);
      const anchors = here.filter((t) => t.side !== 'old').map((t) => t.line);
      const anchorsOld = here.filter((t) => t.side === 'old').map((t) => t.line);
      const d = fileDiff(path, before?.[path], after[path] ?? '', anchors, anchorsOld);
      if (d.adds === 0 && d.dels === 0 && here.length === 0) continue;
      out.push(d);
    }
    // A file a reviewer is arguing on is read first.
    return out.sort((a, b) => {
      const ta = fileThreads.filter((t) => t.path === a.path).length;
      const tb = fileThreads.filter((t) => t.path === b.path).length;
      if (ta !== tb) return tb - ta;
      return a.path.localeCompare(b.path);
    });
  }, [fileRevision, fileBase, snapshots, fileThreads]);

  /**
   * True when the head's files have been read and are not kept any more. The
   * verdict and the scores are; the copy of the workspace is what retention
   * prunes, and saying so is better than an empty diff.
   */
  const filesPruned = fileRevision ? snapshots[fileRevision.id] === null : false;
  const baseFilesPruned = fileBase ? snapshots[fileBase.id] === null : false;

  const filesKept = useCallback(
    (id: string) => {
      const held = snapshots[id];
      return held === undefined ? undefined : held !== null;
    },
    [snapshots],
  );

  const ledger = useMemo(() => buildLedger(head?.report?.contract ?? []), [head]);
  const threadsFor = useCallback((path: string) => threadsOn(fileThreads, path), [fileThreads]);

  const submit = useCallback(
    async (commitMessage?: string) => {
      if (busy) return;
      setBusy(true);
      setError('');
      setNotice('');
      // The draft is the fallback rather than the argument, so a caller that
      // hands this straight to a button's onClick cannot send a click event as
      // the learner's commit message.
      const message = (typeof commitMessage === 'string' ? commitMessage : commitDraft(phaseId)).trim();
      let started: SubmissionView;
      try {
        started = await api.submit(...submitArgs(phaseId, message || undefined, detail?.tasks, selectedTask));
      } catch (err) {
        if (alive.current) {
          setError((err as Error).message);
          setBusy(false);
        }
        return;
      }
      // The words are on the revision, so the field starts empty for the
      // next one. Only once the API has taken it: a submission that never left
      // the browser keeps what the learner typed.
      clearCommitDraft(phaseId);
      // The submission is in the pull request from now, not from its verdict: the queued row joins the list, so
      // the chip reads "Reviewing", the count includes it and the line follows it (NF-2). `api.submit` returns it
      // without an attempt number, so it takes the next one. The next read of the list replaces the whole list,
      // this row with it; a submit that failed above added nothing.
      if (alive.current && currentPhase.current === phaseId) {
        setSubmissions((list) =>
          list.some((s) => s.id === started.id)
            ? list
            : [...list, { ...started, attempt: started.attempt ?? (list.at(-1)?.attempt ?? list.length) + 1 }],
        );
      }
      try {
        // The socket only shortens the wait; `load()` below is still the answer.
        await pollUntil(() => api.getSubmission(started.id), settled, {
          wake: jobWake('submission', started.id),
        });
        if (!alive.current) return;
        await load();
        invalidateProject();
      } catch (err) {
        if (!alive.current) return;
        if (err instanceof PollTimeoutError) setNotice('The review is still running. It will land here.');
        else setError((err as Error).message);
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [busy, load, phaseId, detail?.tasks, selectedTask],
  );

  return {
    detail,
    revisions,
    head,
    threads,
    diffs,
    filesPruned,
    baseFilesPruned,
    fileRevision,
    fileBase,
    filesLoading,
    filesError,
    selectRevision,
    retryFiles,
    filesKept,
    threadsFor,
    ledger,
    gate,
    baseAttempt: fileBase?.attempt ?? null,
    openedAt: revisions[0] ? timeOf(revisions[0].createdAt) : '',
    loading,
    error,
    notice,
    busy,
    setError,
    setNotice,
    submit,
    retry,
    reload: load,
  };
}
