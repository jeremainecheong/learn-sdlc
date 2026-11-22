'use client';

/**
 * The bell, and what is behind it.
 *
 * Half of what it counts is the steps under "Do next" that have not passed
 * (worked out in the shell from the enrolment, so it
 * reads the same on every page rather than appearing on Home and vanishing
 * everywhere else) but the other half is what has happened since the learner
 * last looked: a gate passed, a review posted, a deadline near, a drill still
 * open, a note from their instructor. On the staff side it is the class: who
 * is stuck, who is flagged, who asked for help.
 *
 * Pressing it opens a panel rather than navigating somewhere. Navigating would
 * answer a question nobody asked: the point of a bell is to say what is
 * waiting before you commit to going anywhere.
 *
 * Nothing arrives with a sound, a toast or an animation. A row appears and the
 * number changes, and that is the whole of it: a bell that interrupts is a
 * bell people turn off.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { placeOf, pluralWord, type NotificationKind, type NotificationView, type PhaseSummary } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Notice, PhaseMark, StatusSquare } from '@/components/ui';
import type { NextStep } from '@/components/home/derive';
import { DISPLAY_LOCALE } from '@/lib/locale';
import { BELL_ROWS, FRESH_MS, loadNotifications, useNotifications } from '@/lib/notifications';
import { useSession } from '@/lib/session';
import { ShellDialog } from './ShellDialog';

/**
 * The square a row wears. `warn` is "this is owed and time is passing",
 * `pass` is "that went well", `now` is "somebody is waiting on you to read
 * this". No kind is `fail`: nothing in the bell is a verdict.
 */
const KIND_STATE: Record<NotificationKind, 'pass' | 'warn' | 'now'> = {
  'gate.passed': 'pass',
  'deadline.near': 'warn',
  'drill.unresolved': 'warn',
  'class.stuck': 'warn',
  'class.integrity': 'warn',
  'review.posted': 'now',
  'stuck.answered': 'now',
  'instructor.note': 'now',
  'class.help': 'now',
};

/** "4m", "2h", "Tue", "5 Mar", the mono stamp at the right of a row. */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const date = new Date(at);
  const days = Math.round(hours / 24);
  // Inside the week a weekday is the fastest thing to read; past it, a date.
  if (days < 7) return date.toLocaleDateString(DISPLAY_LOCALE, { weekday: 'short' });
  return date.toLocaleDateString(DISPLAY_LOCALE, { day: 'numeric', month: 'short' });
}

export function BellPanel({
  steps,
  phase,
  place,
  phases,
  workspaceHref,
}: {
  /** The plan's steps; the ones not passed are what is waiting. */
  steps: NextStep[];
  /** The phase the steps belong to, for the mark and the row's second line. */
  phase?: PhaseSummary;
  /**
   * That phase's place in the learner's own project (`placeOf`), the number its
   * mark wears; the panel holds the phase but not the project's list, so the
   * caller passes it in. Without it the mark reads LearnSDLC's own number.
   */
  place?: number;
  /**
   * The phases of the learner's current enrolment, which the shell already
   * holds. A notification names a phase but no project; a row whose link names
   * one of these phase states is numbered by its place in this list.
   */
  phases?: readonly PhaseSummary[];
  /** Where the foot link goes. The current phase unless a page says otherwise. */
  workspaceHref?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const session = useSession();
  const staff = session?.role === 'INSTRUCTOR' || session?.role === 'ADMIN';
  const { items, unread, error, reload, markRead, markAllRead } = useNotifications();

  const waiting = steps.filter((s) => s.state !== 'pass');
  const count = waiting.length + unread;
  const label = bellLabel(unread, waiting.length);

  const shown = items.slice(0, BELL_ROWS);
  const more = Math.max(0, unread - shown.length);

  const close = useCallback(() => setOpen(false), []);

  // Any route change closes it: the panel is about where you are not.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // The rows are the session's, not this mount's, so this is a refresh of a
  // copy that is already on screen rather than a load the panel waits for.
  // Asked for on mount, when the panel opens, and when the tab is looked at
  // again: the three moments the answer could have changed while nothing was
  // listening.
  useEffect(() => {
    void loadNotifications();
  }, []);

  useEffect(() => {
    if (open) void loadNotifications();
  }, [open]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadNotifications();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    // And once a minute while the tab is being looked at, because the socket
    // is latency and not truth: a learner who never leaves the page and whose
    // socket dropped in the middle of a lab would otherwise see the badge stop
    // moving with nothing on screen to say why. The store only fetches when
    // its copy has actually gone stale, so this is one request a minute at
    // most, and none at all in a tab nobody is looking at.
    const timer = window.setInterval(onVisible, FRESH_MS);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  const footHref = staff ? '/teacher' : workspaceHref;
  const footLabel = staff ? 'Open my classes' : 'Open the workspace';
  const empty = staff ? 'Nothing new in your class' : 'Nothing is waiting on you';

  return (
    <div className="relative flex shrink-0 items-center">
      <button
        type="button"
        ref={buttonRef}
        data-testid="bell"
        onClick={() => setOpen((was) => !was)}
        title={label}
        aria-label={`Notifications: ${label}`}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        className="shell-icon-button shell-bell-trigger relative"
      >
        <Icon name="bell" size={18} />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold tabular-nums text-onaccent">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      <ShellDialog open={open} onClose={close} anchor={buttonRef} id={panelId} testId="bell-panel" label="Notifications" className="shell-notifications-dialog">
          {/* The panel's own name, not the name of one of its blocks. "Waiting
              on you" is the heading of the second block, so using it here too
              would have a finished learner meet the words twice in one 320px
              panel with six things they had already done filed under the first
              of them. */}
          <div className="shell-menu-heading"><strong>Notifications</strong><button type="button" className="shell-icon-button" aria-label="Close notifications" onClick={close}><Icon name="cross" size={18} /></button></div>

          {error && (
            <div className="flex items-start gap-2 border-b-1.5 border-edge px-3.5 py-2.5">
              <Notice tone="warn" testId="bell-error" className="flex-1">
                {error}
              </Notice>
              <button
                type="button"
                data-testid="bell-retry"
                onClick={reload}
                className="btn-ghost btn-sm shrink-0"
              >
                Try again
              </button>
            </div>
          )}

          {/* What happened. Absent entirely when there is none, and headed,
              because a result is not a task: six passed gates under "Waiting
              on you" told a learner they owed the work they had just done. */}
          {shown.length > 0 && (
            <div data-testid="bell-new" className="border-b-1.5 border-edge">
              <p className="label-sm border-b-1.5 border-edge px-3.5 py-2">What happened</p>
              <ul className="m-0 flex list-none flex-col p-0">
                {shown.map((row) => (
                  <li key={row.id} className="border-b-1.5 border-edge">
                    <NotificationRow
                      row={row}
                      place={notificationPlace(row, phases)}
                      onOpen={() => {
                        markRead(row.id);
                        close();
                      }}
                    />
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2 px-3.5 py-2">
                <button
                  type="button"
                  data-testid="bell-mark-all"
                  onClick={() => markAllRead()}
                  className="btn-ghost btn-sm"
                >
                  Mark all as read
                </button>
                <span className="flex-1" aria-hidden />
                {more > 0 && (
                  <span className="label-sm" data-testid="bell-more">
                    and {more} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Waiting on you: the plan. An instructor has no enrolment, so this
              block never draws for them and the panel is the New block alone. */}
          {waiting.length > 0 && (
            <>
              <p className="label-sm border-b-1.5 border-edge px-3.5 py-2">Waiting on you</p>
              <ul className="m-0 flex list-none flex-col p-0">
                {waiting.map((step) => (
                  <li key={step.key} className="border-b-1.5 border-edge last:border-b-0">
                    <Link
                      href={step.href}
                      data-testid="bell-item"
                      onClick={() => close()}
                      className="flex min-h-11 items-center gap-2.5 px-3.5 py-2 transition-colors hover:bg-raised"
                    >
                      {phase ? (
                        <PhaseMark phaseKey={phase.key} size={18} numeral={place} state={step.state === 'pass' ? 'pass' : 'now'} />
                      ) : (
                        <StatusSquare state={step.state} size={10} />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                        {step.title}
                      </span>
                      <span className="mono shrink-0 text-[11.5px] text-muted">{step.meta}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}

          {shown.length === 0 && waiting.length === 0 && (
            <p className="px-3.5 py-4 text-[13px] text-ink2" data-testid="bell-empty">
              {empty}
            </p>
          )}

          {footHref && (
            <div className="border-t-1.5 border-edge px-3.5 py-2.5">
              <Link
                href={footHref}
                data-testid="bell-open-workspace"
                onClick={() => close()}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline"
              >
                {footLabel}
                <Icon name="chevron-right" size={13} />
              </Link>
            </div>
          )}
      </ShellDialog>
    </div>
  );
}

/** The phase state a row's link is about: `/workspace/<id>...` or `/feedback?phase=<id>...`. */
const ROW_PHASE_STATE = /^\/workspace\/([^/?#]+)|^\/feedback\?(?:[^#]*&)?phase=([^&#]+)/;

/**
 * A notification's place in the learner's current project, read from the
 * phases the shell already holds: the phase state its link names, when that
 * state is one of them and is the row's phase. Undefined otherwise (a row
 * about another enrolment, or one with no phase state in its link), and the
 * mark then wears LearnSDLC's own number.
 */
export function notificationPlace(row: NotificationView, phases: readonly PhaseSummary[] | undefined): number | undefined {
  if (!row.phaseKey || !phases?.length) return undefined;
  const found = ROW_PHASE_STATE.exec(row.href);
  let stateId = '';
  try {
    stateId = found ? decodeURIComponent(found[1] ?? found[2] ?? '') : '';
  } catch {
    return undefined;
  }
  const held = stateId ? phases.find((one) => one.id === stateId && one.key === row.phaseKey) : undefined;
  return held ? placeOf({ phases }, held.key) || undefined : undefined;
}

/** One notification: the mark, the sentence, and when it happened. */
function NotificationRow({ row, place, onOpen }: { row: NotificationView; place?: number; onOpen: () => void }) {
  return (
    <Link
      href={row.href}
      data-testid="bell-note"
      data-kind={row.kind}
      onClick={onOpen}
      title={row.detail ? `${row.title} — ${row.detail}` : row.title}
      className="flex min-h-11 items-center gap-2.5 px-3.5 py-2 transition-colors hover:bg-raised"
    >
      {row.phaseKey ? (
        <PhaseMark
          phaseKey={row.phaseKey}
          size={18}
          numeral={place}
          state={KIND_STATE[row.kind] === 'pass' ? 'pass' : 'now'}
        />
      ) : (
        <StatusSquare state={KIND_STATE[row.kind]} size={10} />
      )}
      <span className="min-w-0 flex-1 break-words text-[13px] leading-relaxed text-ink">{row.title}</span>
      <span className="mono shrink-0 text-[11.5px] text-muted">{relativeTime(row.createdAt)}</span>
    </Link>
  );
}

/**
 * What the button says it is for. The two halves are counted separately
 * because they are different kinds of thing: one is news, the other is work.
 */
export function bellLabel(unread: number, waiting: number): string {
  const news = unread === 1 ? '1 new' : `${unread} new`;
  const work = `${waiting} ${pluralWord(waiting, 'thing')} waiting on you`;
  if (!unread && !waiting) return 'Nothing is waiting on you';
  if (!waiting) return news;
  if (!unread) return work;
  return `${news}, and ${work}`;
}
