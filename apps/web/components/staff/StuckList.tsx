'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, MessageSquareText, RefreshCw } from 'lucide-react';
import type { StuckItem } from '@learnsdlc/shared';
import { STUCK_ANSWER_MAX, STUCK_ANSWER_MIN } from '@learnsdlc/shared';
import { ApiError, describeError } from '@/lib/api';
import { mentorApi } from '@/lib/api-mentor';
import { useSession } from '@/lib/session';
import { sinceLabel, when } from '@/components/staff/primitives';
import './StuckList.css';

const STUCK_LIST_POLL_MS = 20_000;
type Props = {
  project?: string;
  cohortId?: string;
  /** Additional view filter; the API independently enforces teacher membership. */
  learnerIds?: readonly string[];
  onInspect: (item: StuckItem) => void;
  /** Bumped when the class page reads its records again: the requests are read with them. */
  refreshRound?: number;
};

export function StuckList(props: Props) {
  const user = useSession();
  if (!user || user.role === 'LEARNER') return null;
  // A new session or class scope must never display the previous class's rows
  // or retain an answer composed for another learner.
  const scope = props.learnerIds ? [...props.learnerIds].sort().join('|') : '*';
  return <ScopedRequests key={`${user.id}:${props.project ?? '*'}:${props.cohortId ?? '*'}:${scope}`} {...props} />;
}

function ScopedRequests({ project, cohortId, learnerIds, onInspect, refreshRound = 0 }: Props) {
  const [items, setItems] = useState<StuckItem[] | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [replyError, setReplyError] = useState('');
  const alive = useRef(false);
  const loadVersion = useRef(0);
  const pollPending = useRef(false);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setRefreshing(true);
    try {
      const rows = await mentorApi.stuckList({ project: project && project !== 'all' ? project : undefined, state: 'open', cohortId });
      if (alive.current && version === loadVersion.current) {
        setItems(rows);
        setError('');
      }
    } catch (err) {
      if (alive.current && version === loadVersion.current)
        setError(describeError(err, 'Help requests could not be loaded. Try again.'));
    } finally {
      if (alive.current && version === loadVersion.current) setRefreshing(false);
    }
  }, [project, cohortId]);

  useEffect(() => {
    alive.current = true;
    void load();
    const id = setInterval(() => {
      if (pollPending.current || document.hidden) return;
      pollPending.current = true;
      void load().finally(() => { pollPending.current = false; });
    }, STUCK_LIST_POLL_MS);
    return () => { alive.current = false; loadVersion.current++; clearInterval(id); };
  }, [load]);

  const seenRound = useRef(refreshRound);
  useEffect(() => {
    if (seenRound.current === refreshRound) return;
    seenRound.current = refreshRound;
    void load();
  }, [refreshRound, load]);

  const send = async (item: StuckItem) => {
    const text = answer.trim();
    if (busy || text.length < STUCK_ANSWER_MIN || text.length > STUCK_ANSWER_MAX) return;
    setBusy(true);
    setReplyError('');
    try {
      await mentorApi.answerStuck(item.phaseStateId, text);
      if (!alive.current) return;
      setAnswer('');
      setOpenRow(null);
      await load();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.status === 409) await load();
      setReplyError(describeError(err, 'The answer did not send. Your draft is kept for retry.'));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const rows = (items ?? []).filter(item => !learnerIds || learnerIds.includes(item.userId));
  const waiting = rows.filter(item => item.answeredAt === null);
  const answered = rows.filter(item => item.answeredAt !== null);
  const row = (item: StuckItem) => {
    const open = openRow === item.phaseStateId;
    const done = item.answeredAt !== null;
    return <li key={item.phaseStateId} className="teacher-help-row" data-testid={`stuck-row-${item.userId}`}>
      <div className="teacher-help-row-heading">
        <div><strong>{item.displayName}</strong><span>{item.phaseTitle}</span></div>
        <span className="exp-caption" title={when(item.raisedAt)}>{done ? 'Answered' : sinceLabel(item.raisedAt)}</span>
      </div>
      <p className="teacher-help-question">{item.question}</p>
      {item.tried && <p className="teacher-help-tried">What they tried: {item.tried}</p>}
      <div className="exp-actions">
        {!done && <button type="button" className="exp-button exp-primary" disabled={busy} aria-expanded={open} aria-controls={`help-answer-${item.phaseStateId}`} data-testid={`stuck-reply-${item.phaseStateId}`} onClick={() => { setAnswer(''); setReplyError(''); setOpenRow(open ? null : item.phaseStateId); }}>{open ? 'Close reply' : 'Reply to learner'}</button>}
        <button type="button" className="exp-button" onClick={() => onInspect(item)} aria-label={`Inspect submitted ${item.phaseTitle} evidence for ${item.displayName}`}>View submitted phase evidence <ArrowRight size={14} aria-hidden="true" /></button>
      </div>
      {done && <div className="teacher-help-answer" data-testid="stuck-answered"><span className="exp-caption">Answered by {item.answeredByName ?? 'a member of staff'}</span><p>{item.answer}</p></div>}
      {open && !done && <form className="teacher-help-form" id={`help-answer-${item.phaseStateId}`} onSubmit={event => { event.preventDefault(); void send(item); }}>
        <label className="exp-field">Your reply to {item.displayName}<textarea maxLength={STUCK_ANSWER_MAX} minLength={STUCK_ANSWER_MIN} required value={answer} disabled={busy} onChange={event => setAnswer(event.target.value)} data-testid="stuck-answer-input" aria-describedby={replyError ? `help-answer-error-${item.phaseStateId}` : undefined} autoFocus rows={5} /></label>
        {replyError && <p id={`help-answer-error-${item.phaseStateId}`} role="alert" className="exp-error" data-testid="stuck-answer-error">{replyError}</p>}
        <p className="exp-caption">Offer a useful next step. Use at least 10 characters.</p>
        <button type="submit" className="exp-button exp-primary" disabled={busy || answer.trim().length < STUCK_ANSWER_MIN} data-testid="stuck-answer-send">{busy ? 'Sending…' : 'Send the answer'}</button>
      </form>}
    </li>;
  };

  const refreshButton = <button type="button" className="exp-button" onClick={() => void load()} disabled={refreshing} data-testid="stuck-refresh"><RefreshCw size={14} aria-hidden="true" />{refreshing ? 'Refreshing…' : 'Refresh requests'}</button>;
  // The first read still out: the same one row as "No open help requests", the state that most often follows, so
  // when the read answers with nothing to answer, nothing under the strip moves (a whole card drawn first would
  // then shrink). When requests are waiting, the strip grows into the card as it must.
  if (items === null && !error && !replyError) {
    return <section className="exp-panel teacher-help teacher-help-loading" data-testid="stuck-list" aria-labelledby="teacher-help-heading" aria-busy="true">
      <h2 id="teacher-help-heading"><MessageSquareText size={17} aria-hidden="true" />Requests for help</h2>
      <p role="status">Loading help requests…</p>
      {refreshButton}
    </section>;
  }
  // Nothing to answer: one row, so the class's own work leads the page rather than an empty card.
  if (items !== null && rows.length === 0 && !error && !replyError) {
    return <section className="exp-panel teacher-help teacher-help-empty" data-testid="stuck-list" aria-labelledby="teacher-help-heading">
      <h2 id="teacher-help-heading"><MessageSquareText size={17} aria-hidden="true" />Requests for help</h2>
      <p data-testid="stuck-empty" role="status">No open help requests</p>
      {refreshButton}
    </section>;
  }
  return <section className="exp-panel teacher-help" data-testid="stuck-list" aria-labelledby="teacher-help-heading">
    <header className="exp-section-heading"><div><span className="exp-eyebrow">A learner is asking you</span><h2 id="teacher-help-heading"><MessageSquareText size={21} aria-hidden="true" />Requests for help</h2><p>Questions learners chose to share with their instructor, oldest first.</p></div>{refreshButton}</header>
    {error && <p role="alert" className="exp-error" data-testid="stuck-list-error">{error}</p>}
    {replyError && !waiting.some(item => item.phaseStateId === openRow) && <p role="alert" className="exp-error" data-testid="stuck-answer-error">{replyError}</p>}
    {items === null ? <p role="status">{error ? 'Help request status is unavailable.' : 'Loading help requests…'}</p> : <>
      <p className="exp-caption" role="status">{waiting.length} waiting for your reply</p>
      {rows.length === 0 && <p data-testid="stuck-empty">No open help requests. Learners can ask their instructor from a phase workspace.</p>}
      <ul className="teacher-help-list">{waiting.map(row)}</ul>
      {answered.length > 0 && <details className="teacher-help-answered" data-testid="stuck-answered-group"><summary data-testid="stuck-answered-toggle">Answered, waiting for learner acknowledgment ({answered.length})</summary><ul className="teacher-help-list">{answered.map(row)}</ul></details>}
    </>}
  </section>;
}

export default StuckList;
