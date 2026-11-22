'use client';

import { sameSession } from '@/lib/session-token';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { InterviewState } from '@learnsdlc/shared';
import { ApiError, describeError, getToken } from '@/lib/api';
import { mentorApi } from '@/lib/api-mentor';
import { useRecoverWhenBack } from '@/lib/poll';
import { onSessionEnd, ownedByToken, subscribe } from '@/lib/session';

export type OutgoingInterviewQuestion = {
  id: number; question: string; status: 'pending' | 'failed';
  failure?: { kind: 'withheld' | 'rejected' | 'unconfirmed'; message: string };
};
const serverToken = () => null;

function replyFailure(error: unknown, persona: string, historyChecked: boolean): NonNullable<OutgoingInterviewQuestion['failure']> {
  const reference = error instanceof ApiError && error.requestId ? ` (reference ${error.requestId})` : '';
  if (error instanceof ApiError && error.status === 503 && error.body && typeof error.body === 'object'
      && 'code' in error.body && error.body.code === 'STAKEHOLDER_REPLY_WITHHELD') {
    return { kind: 'withheld', message: `${persona} could not provide a reliable reply this time. Your question is kept; you can retry it.${reference}` };
  }
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return { kind: 'rejected', message: `${error.message} Your question is kept.` };
  }
  return { kind: 'unconfirmed', message: historyChecked
    ? `${persona}'s reply did not arrive, and no new reply appeared when we checked the conversation. Your question is kept; you can retry it.${reference}`
    : `We could not confirm whether ${persona} replied because recent replies are unavailable. Your question is kept. Check your connection and recent replies before retrying.${reference}` };
}

const rooms = new Map<string, InterviewState>();
const clearRooms = () => rooms.clear();
const ownRooms = ownedByToken(clearRooms);
onSessionEnd(clearRooms);
function heldRoom(id: string) { ownRooms(); return rooms.get(id); }
function holdRoom(id: string, state: InterviewState) { ownRooms(); rooms.set(id, state); }

/** The phase layout owns the interview, including an answer arriving in another tab. */
export function useInterview(phaseId: string) {
  const liveToken = useSyncExternalStore(subscribe, getToken, serverToken);
  const scopeRef = useRef({ phaseId, owner: liveToken });
  // A renewal of the same sign-in (lib/api.ts) keeps the scope, so the
  // conversation, its draft and the question in flight are not reset.
  if (scopeRef.current.phaseId !== phaseId || !sameSession(scopeRef.current.owner, liveToken)) scopeRef.current = { phaseId, owner: liveToken };
  const owner = scopeRef.current.owner;
  const scope = scopeRef.current;
  const [viewScope, setViewScope] = useState(scope);
  const [state, setState] = useState<InterviewState | null>(() => heldRoom(phaseId) ?? null);
  const [draft, updateDraft] = useState('');
  const draftRef = useRef({ value: '', version: 0 });
  const setDraft = useCallback((value: string) => {
    draftRef.current = { value, version: draftRef.current.version + 1 };
    updateDraft(value);
  }, []);
  const [outgoing, setOutgoing] = useState<OutgoingInterviewQuestion[]>([]);
  const restoredDrafts = useRef(new Map<number, number>());
  const nextQuestionId = useRef(0);
  const requestRef = useRef<{ scope: typeof scope; id: number } | null>(null);
  const stateVersion = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [absent, setAbsent] = useState(false);
  const [loading, setLoading] = useState(!heldRoom(phaseId));
  const [attempt, setAttempt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reopen = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    requestRef.current = null;
    stateVersion.current += 1;
    restoredDrafts.current.clear();
    setViewScope(scope); setState(heldRoom(phaseId) ?? null); setDraft('');
    setOutgoing([]); setBusy(false); setError(''); setAbsent(false);
    following.current = true;
  }, [scope, phaseId, setDraft]);

  useEffect(() => {
    if (!owner) { setLoading(false); return; }
    const held = heldRoom(phaseId);
    if (held) setState(held);
    let live = true;
    setLoading(!held);
    const version = stateVersion.current;
    // Cached history renders immediately, but a returning phase must see
    // replies committed after navigation. Never overwrite a newer ask.
    const current = () => live && alive.current && scopeRef.current === scope && sameSession(getToken(), owner) && stateVersion.current === version;
    mentorApi.interview(phaseId).then(fresh => {
      if (!current()) return;
      holdRoom(phaseId, fresh); setState(fresh); setError(''); setAbsent(false);
    }).catch((err: unknown) => {
      if (!current()) return;
      if (err instanceof ApiError && err.status === 404) setAbsent(true);
      else setError(describeError(err, 'The interview did not open. Try again in a moment.'));
    }).finally(() => { if (current()) setLoading(false); });
    return () => { live = false; };
  }, [phaseId, owner, scope, attempt]);
  useRecoverWhenBack(!state && Boolean(error) && !absent, reopen);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const rememberPosition = () => {
      if (element.clientHeight > 0) following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 120;
    };
    const follow = () => {
      if (element.clientHeight > 0 && following.current) element.scrollTop = element.scrollHeight;
    };
    follow();
    element.addEventListener('scroll', rememberPosition, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    observer?.observe(element);
    for (const child of Array.from(element.children)) observer?.observe(child);
    return () => { observer?.disconnect(); element.removeEventListener('scroll', rememberPosition); };
  }, [state?.turns.length, outgoing.length, busy, loading]);

  const ask = useCallback(async (retryId?: number) => {
    const retry = retryId === undefined ? undefined : outgoing.find(row => row.id === retryId && row.status === 'failed');
    if (retryId !== undefined && !retry) return;
    const originalDraft = draftRef.current.value;
    const question = (retry?.question ?? originalDraft).trim();
    if (!alive.current || scopeRef.current !== scope || !owner || !sameSession(getToken(), owner) || viewScope !== scope || question.length < 3 || requestRef.current?.scope === scope || !state || state.turnsLeft <= 0) return;
    const id = retry?.id ?? outgoing.find(row => row.status === 'failed' && row.question === question)?.id ?? ++nextQuestionId.current;
    const startingTurnIds = new Set(state.turns.map(turn => turn.id));
    const request = { scope, id };
    requestRef.current = request;
    stateVersion.current += 1;
    const current = () => alive.current && scopeRef.current === scope && sameSession(getToken(), owner) && requestRef.current === request;
    // A retry uses its captured question; a newer composer draft stays intact.
    const clearsDraft = !retry || restoredDrafts.current.get(id) === draftRef.current.version;
    restoredDrafts.current.delete(id);
    if (clearsDraft) setDraft('');
    const clearedVersion = draftRef.current.version;
    setOutgoing(rows => [...rows.filter(row => row.id !== id), { id, question, status: 'pending' }]);
    following.current = true;
    setBusy(true); setError('');
    try {
      const answered = await mentorApi.ask(phaseId, question);
      if (!current()) return;
      holdRoom(phaseId, answered.state); setState(answered.state);
      setOutgoing(rows => rows.filter(row => row.id !== id));
    } catch (err) {
      if (!current()) return;
      // An HTTP failure can follow a committed turn. Read the authoritative
      // record before offering retry; old equal text alone is not delivery.
      const fresh = await mentorApi.interview(phaseId).catch(() => null);
      if (fresh && current()) {
        holdRoom(phaseId, fresh); setState(fresh);
        if (fresh.turns.some(turn => !startingTurnIds.has(turn.id) && turn.question === question)) {
          setOutgoing(rows => rows.filter(row => row.id !== id));
          return;
        }
      }
      if (!current()) return;
      const failure = replyFailure(err, state.persona.name, Boolean(fresh));
      setOutgoing(rows => rows.map(row => row.id === id ? { ...row, status: 'failed', failure } : row));
      if (clearsDraft && draftRef.current.version === clearedVersion) {
        setDraft(originalDraft);
        restoredDrafts.current.set(id, draftRef.current.version);
      }
      // This request's failure belongs beside its retained question. The
      // header notice is reserved for opening/refreshing the conversation.
    } finally { if (current()) { requestRef.current = null; setBusy(false); } }
  }, [owner, outgoing, phaseId, scope, setDraft, state, viewScope]);
  const send = useCallback(() => ask(), [ask]);
  const retry = useCallback((id: number) => ask(id), [ask]);
  const visible = viewScope === scope;
  return { state: visible ? state : null, draft: visible ? draft : '', setDraft, outgoing: visible ? outgoing : [], retry, busy: visible && busy, error: visible ? error : '', absent: visible && absent, loading: !visible || loading, scrollRef, send, reopen };
}
