'use client';

/**
 * One reviewer thread, drawn where it was left: inside the diff, under the
 * line it is about.
 *
 * A reply goes to the same reviewer the phase's persona panel talks to, with
 * the file and line already said, so answering a thread costs the learner one
 * sentence rather than a re-explanation. An open thread takes replies; a
 * resolved one is history and says which submission settled it.
 */
import { useId, useRef, useState } from 'react';
import { Avatar, Button, Chip } from '@/components/ui';
import type { PhaseKey } from '@learnsdlc/shared';
import type { PrThread } from './threads';

export function Thread({
  thread,
  phaseKey,
  index,
  closedByMerge = false,
  showPath = false,
  onReply,
}: {
  thread: PrThread;
  phaseKey: PhaseKey;
  /** 1-based, for the test id. */
  index: number;
  /** The phase is merged: nothing on it can be answered by another submission. */
  closedByMerge?: boolean;
  /** Name the file too: a list of threads spans more than one. */
  showPath?: boolean;
  /** Sends the reply and resolves with what the reviewer said back. */
  onReply?: (thread: PrThread, text: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [question, setQuestion] = useState<{ text: string; status: 'pending' | 'failed' | 'sent' } | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const errorId = useId();
  const open = thread.state === 'open' && !closedByMerge;

  const send = async (retryText?: string) => {
    const sentDraft = retryText ?? draft;
    const text = sentDraft.trim();
    if (!text || busy || !onReply || !open) return;
    setBusy(true);
    setError('');
    setAnswer('');
    setQuestion({ text: sentDraft, status: 'pending' });
    // A retry belongs to the retained question, not a newer composer draft.
    setDraft(current => retryText === undefined || current === sentDraft ? '' : current);
    input.current?.focus({ preventScroll: true });
    try {
      setAnswer(await onReply(thread, text));
      setQuestion({ text: sentDraft, status: 'sent' });
    } catch (err) {
      setQuestion({ text: sentDraft, status: 'failed' });
      setDraft(current => current === '' ? sentDraft : current);
      setError(`The reply could not be received (${(err as Error).message}). Your question is kept. Try again in a moment.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid={`phase-implementation-thread-${index}`}
      className={`ml-[26px] mr-2.5 mb-2 mt-1.5 flex flex-col rounded-lg border-1.5 bg-surface sm:ml-[106px] ${
        open ? 'border-warn' : 'border-edge2'
      }`}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <Avatar initials={thread.initials} phaseKey={phaseKey} size={28} title={thread.who} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-semibold text-ink">{thread.who}</span>
            <span className="label-sm wrap">
              {thread.line > 0
                ? showPath && thread.path
                  ? `on ${thread.path} line ${thread.line}`
                  : `on line ${thread.line}`
                : `on ${thread.path || 'this pull request'}`}
            </span>
            <span className="flex-1" aria-hidden />
            <Chip tone={open ? 'warn' : 'pass'}>
              {open
                ? 'Open'
                : thread.resolvedIn
                  ? `Resolved in submission ${thread.resolvedIn}`
                  : 'Closed by the merge'}
            </Chip>
          </div>
          <p className="wrap text-[13px] leading-[1.5] text-ink2">{thread.message}</p>
          <p className="wrap text-[13px] leading-[1.5] text-ink">{thread.ask}</p>
          {/* Inside the diff the line is already drawn right above the thread,
              so the snippet is only worth its height in the list, where the
              thread is read away from the code. */}
          {thread.snippet && showPath && (
            <p className="mono wrap rounded-sm bg-raised px-2 py-1 text-[11.5px] text-ink2">
              {thread.snippet}
            </p>
          )}
          {/* The failing case names itself, the way the editor's note does. An
              analyzer thread does not: it already says the function in its
              first sentence, and repeating it reads as noise. */}
          {thread.kind === 'test' && (
            <p className="mono wrap text-[11.5px] text-muted">{thread.source}</p>
          )}
          {question && (
            <div data-testid={`pr-reply-question-${index}`} className="ml-3 rounded-ctl border-1.5 border-edge bg-tint px-2.5 py-2 text-[13px] leading-[1.5] text-ink">
              <span className="text-[11px] font-semibold">You</span>
              <p className="wrap whitespace-pre-wrap">{question.text}</p>
              {question.status === 'pending' && <span role="status" className="label-sm">Sending…</span>}
              {question.status === 'failed' && <span className="label-sm">Reply not received</span>}
            </div>
          )}
          {error && (
            <p id={errorId} role="alert" className="wrap rounded-ctl border-1.5 border-fail bg-failtint px-2.5 py-2 text-[13px] leading-[1.5] text-ink2">{error}</p>
          )}
          {open && onReply && question?.status === 'failed' && (
            <Button variant="secondary" size="sm" onClick={() => void send(question.text)} testId={`pr-reply-retry-${index}`}>Retry this reply</Button>
          )}
          {answer && (
            <p className="wrap rounded-ctl border-1.5 border-edge bg-raised px-2.5 py-2 text-[13px] leading-[1.5] text-ink2">
              {answer}
            </p>
          )}
        </div>
      </div>
      {open && onReply && (
        <div className="flex gap-2 border-t-1.5 border-edge px-3 pb-2.5 pt-2 sm:pl-[50px]">
          <input
            ref={input}
            aria-describedby={error ? errorId : undefined}
            className="field h-8 flex-1 !px-2.5 text-[12.5px]"
            placeholder="Reply, or change the line and submit again"
            aria-label={`Reply to the ${thread.who} on line ${thread.line}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
            }}
            data-testid={`pr-reply-${index}`}
          />
          <Button
            variant="secondary"
            size="sm"
            busy={busy}
            busyLabel="Sending"
            disabled={draft.trim().length === 0}
            onClick={() => void send()}
            testId={`pr-reply-send-${index}`}
          >
            Reply
          </Button>
        </div>
      )}
    </div>
  );
}
