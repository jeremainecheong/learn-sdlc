'use client';

/**
 * "I'm stuck": the one way past a mentor that will not write the answer.
 *
 * The mentor is under a rule, it hints, it never solves, and a learner who
 * is genuinely stuck has nowhere to go but a person. This is that door, and it
 * is deliberately quiet: a text button under the composer, a two-field form,
 * and then the instructor's own words back in the same column.
 *
 * It polls rather than pushes. The socket, the gateway and the bell live
 * elsewhere, and adding a push there would need nothing changed here; a 20-second poll
 * on a handful of open flags is also simply the right shape for one laptop
 * hosting one class.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { STUCK_QUESTION_MAX, STUCK_QUESTION_MIN, STUCK_RAISED_MESSAGE, STUCK_TRIED_MAX, type StuckFlag as Flag } from '@learnsdlc/shared';
import { ApiError, describeError } from '@/lib/api';
import { mentorApi } from '@/lib/api-mentor';
import { Avatar, Button, Notice, initialsOf } from '@/components/ui';
import { whenShort } from '@/components/staff/primitives';
import { wrapDialogFocus } from '@/components/chat/ChatSurface';
import { useViewAs, viewAsMentorSentence } from '@/lib/view-as';
import './StuckFlag.css';

/** How often the column asks whether the instructor has answered yet. */
export const STUCK_POLL_WAITING_MS = 20_000;
/** Once answered there is nothing left to wait for, so it slows right down. */
export const STUCK_POLL_ANSWERED_MS = 60_000;

const isOpen = (flag: Flag | null): boolean => Boolean(flag && !flag.clearedAt);

export function StuckFlag({ phaseStateId: asked }: { phaseStateId?: string }) {
  // While a teacher views a learner's work the flag is the
  // learner's, not theirs to read or raise. `GET /phases/:id/stuck` is a
  // learner route the teacher's token is refused on, and raising one is a
  // write: so nothing is asked, and the door is drawn closed with the reason
  // on it. Everything below reads the phase through `phaseStateId`, and with
  // none it asks nothing and polls nothing.
  const viewing = useViewAs();
  const phaseStateId = viewing ? undefined : asked;
  const [flag, setFlag] = useState<Flag | null>(null);
  const [form, setForm] = useState(false);
  const [question, setQuestion] = useState('');
  const [tried, setTried] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const openButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const questionId = useId();
  const triedId = useId();
  const phase = useRef(phaseStateId);
  phase.current = phaseStateId;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    if (!phaseStateId) return;
    try {
      const mine = await mentorApi.stuck(phaseStateId);
      if (alive.current && phase.current === phaseStateId) setFlag(mine);
    } catch {
      // A poll that fails changes nothing on screen: the flag on the last
      // answer is still the truth until a later poll says otherwise.
    }
  }, [phaseStateId]);

  useEffect(() => {
    setFlag(null);
    setForm(false);
    setError('');
    setQuestion('');
    setTried('');
    setBusy(false);
    dialog.current?.close();
    void read();
  }, [phaseStateId, read]);

  // Waiting on a person is worth asking about often; a flag already answered is
  // only waiting on the learner pressing "That helped".
  const waiting = isOpen(flag);
  const answeredAt = flag?.answeredAt ?? null;
  useEffect(() => {
    if (!phaseStateId || !waiting) return;
    // Two primitives rather than the flag object: every poll returns a new
    // object, and depending on it would tear the timer down and build it again
    // on each answer.
    const ms = answeredAt ? STUCK_POLL_ANSWERED_MS : STUCK_POLL_WAITING_MS;
    const id = setInterval(() => void read(), ms);
    return () => clearInterval(id);
  }, [phaseStateId, waiting, answeredAt, read]);

  const closeForm = useCallback(() => {
    dialog.current?.close();
    setForm(false);
    setError('');
    openButton.current?.focus({ preventScroll: true });
  }, []);

  const openForm = () => {
    if (!dialog.current?.open) dialog.current?.showModal();
    setForm(true);
    if (!waiting) questionInput.current?.focus({ preventScroll: true });
  };

  const raise = async () => {
    const text = question.trim();
    if (busy || !phaseStateId || text.length < STUCK_QUESTION_MIN) return;
    setBusy(true);
    setError('');
    try {
      const raised = await mentorApi.raiseStuck(phaseStateId, text, tried.trim());
      if (!alive.current || phase.current !== phaseStateId) return;
      setFlag(raised);
      setQuestion('');
      setTried('');
    } catch (err) {
      if (!alive.current || phase.current !== phaseStateId) return;
      // Two tabs, one flag: the open one is the answer, so show it.
      if (err instanceof ApiError && err.status === 409) {
        await read();
      }
      if (!alive.current || phase.current !== phaseStateId) return;
      setError(describeError(err, 'The flag did not go up. Try again in a moment.'));
    } finally {
      if (alive.current && phase.current === phaseStateId) setBusy(false);
    }
  };

  const clear = async () => {
    if (busy || !phaseStateId) return;
    setBusy(true);
    setError('');
    try {
      const cleared = await mentorApi.clearStuck(phaseStateId);
      if (alive.current && phase.current === phaseStateId) { setFlag(cleared); closeForm(); }
    } catch (err) {
      if (alive.current && phase.current === phaseStateId) {
        setError(describeError(err, 'The flag did not come down. Try again in a moment.'));
      }
    } finally {
      if (alive.current && phase.current === phaseStateId) setBusy(false);
    }
  };

  if (viewing && asked) {
    return (
      <div className="stuck-help-action" data-testid="stuck-flag">
        <button
          type="button"
          disabled
          title={viewAsMentorSentence(viewing)}
          className="label-sm w-fit font-medium text-muted"
          data-testid="stuck-open"
        >
          I'm stuck
        </button>
      </div>
    );
  }

  if (!phaseStateId) return null;

  const open = waiting;
  const answered = open && answeredAt;
  const short = question.trim().length > 0 && question.trim().length < STUCK_QUESTION_MIN;

  return (
    <div className="stuck-help-action" data-testid="stuck-flag">
        <button
          ref={openButton}
          type="button"
          onClick={openForm}
          aria-haspopup="dialog"
          aria-expanded={form}
          aria-controls={`${titleId}-dialog`}
          className="label-sm w-fit font-medium text-ink2 underline decoration-edge2 underline-offset-2 hover:text-ink"
          data-testid="stuck-open"
        >
          {answered ? 'Read instructor reply' : open ? 'View help request' : "I'm stuck"}
        </button>
      <dialog ref={dialog} id={`${titleId}-dialog`} aria-labelledby={titleId} className="stuck-help-dialog" data-testid="stuck-dialog"
        onKeyDown={event => { wrapDialogFocus(event); if (event.key === 'Escape') event.stopPropagation(); }}
        onCancel={event => { event.preventDefault(); closeForm(); }}
        onClose={() => { setForm(false); }}>
        <header><h2 id={titleId}>Instructor help</h2><button type="button" onClick={closeForm} aria-label="Close instructor help"><X size={18} aria-hidden="true" /></button></header>
        <div className="stuck-help-body">
        {error && <Notice tone="fail" testId="stuck-error">{error}</Notice>}
        {!open && <div className="stuck-help-form">
          <p>Share the part you cannot get past and what you have tried. Your instructor can reply here.</p>
          <label className="label-sm font-medium text-ink2" htmlFor={questionId}>
            What are you stuck on?
          </label>
          <textarea
            id={questionId}
            ref={questionInput}
            className="field min-h-[56px] resize-y py-[7px] text-[13px]"
            maxLength={STUCK_QUESTION_MAX}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What you cannot get past, in your own words"
            data-testid="stuck-question"
          />
          <label className="label-sm font-medium text-ink2" htmlFor={triedId}>
            What have you tried? (optional)
          </label>
          <textarea
            id={triedId}
            className="field min-h-[44px] resize-y py-[7px] text-[13px]"
            maxLength={STUCK_TRIED_MAX}
            value={tried}
            onChange={(e) => setTried(e.target.value)}
            data-testid="stuck-tried"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={raise} busy={busy} busyLabel="Raising" disabled={short || question.trim().length === 0} testId="stuck-send">
              Ask your instructor
            </Button>
            <Button size="sm" variant="ghost" onClick={closeForm} testId="stuck-cancel">
              Cancel
            </Button>
            {(short || question.trim().length === 0) && (
              <span className="label-sm">Say what you are stuck on, at least 10 characters</span>
            )}
          </div>
        </div>}

      {open && !answered && (
        <><Notice tone="info" testId="stuck-raised" icon="clock">
          {STUCK_RAISED_MESSAGE}
        </Notice><p className="stuck-help-question">{flag?.question}</p>{flag?.tried && <p className="stuck-help-question">What you tried: {flag.tried}</p>}</>
      )}

      {open && answered && flag && (
        <div className="flex flex-col gap-2 rounded-ctl border-1.5 border-edge2 p-2.5" data-testid="stuck-answer">
          <div className="flex items-start gap-2.5">
            <Avatar initials={initialsOf(flag.answeredByName || 'Your instructor')} size={26} />
            <div className="min-w-0 flex-1">
              <p className="label-sm font-medium text-ink2">
                Your instructor
                {flag.answeredByName ? `, ${flag.answeredByName}` : ''}, {whenShort(flag.answeredAt)}
              </p>
              <p className="mt-1 wrap whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
                {flag.answer}
              </p>
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={clear} busy={busy} busyLabel="Clearing" testId="stuck-clear">
            That helped
          </Button>
        </div>
      )}
        </div>
      </dialog>
    </div>
  );
}
