'use client';

/**
 * The Preview pane: the fourth tab of the right column.
 *
 * One panel, seven states, and every sentence in `copy.ts` rather than in the
 * markup, so a state with nothing to say is a failing test instead of an empty
 * box.
 *
 * The controls come before the frame in the DOM on purpose. Everything inside
 * the iframe is a tab stop of the learner's own making, and a Refresh button
 * placed after it would be reachable only by tabbing through somebody's
 * half-written application first.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PreviewSessionView, PreviewStatus, PreviewUnsupported } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Button, Chip, EmptyState } from '@/components/ui';
import { PreviewFrame } from './PreviewFrame';
import {
  BUNDLE_FAILED,
  CONTROLS,
  IDLE,
  NOT_MARKED,
  PREVIEW_EARLIER,
  PREVIEW_REBUILDING,
  PREVIEW_REBUILT,
  STARTING,
  STARTING_DETAIL,
  TOO_SHORT,
  builtFromSentence,
  busyCopy,
  failedSentence,
  minutesLeft,
  runningSince,
  stoppedSentence,
  unsupportedSentence,
  type PreviewRefusalFields,
} from './copy';
import { minutesLeftOf } from '../usePreview';
import { builtFrom, previewCurrency, type PreviewBuildFields } from './currency';

const CTRL = 'btn-ghost btn-sm shrink-0';

/**
 * Below this many pixels the frame area cannot show an application at all, and
 * the panel says so instead of framing nothing. Above the second the sentence
 * goes again: two numbers rather than one because the sentence is itself part
 * of the height it is measuring, and a single threshold would show it, shrink
 * the area past the threshold and never settle.
 */
const FRAME_UNUSABLE_PX = 180;
/** How long a Rebuild press may wait for the page to start the app before the panel stops saying so. */
const REBUILD_GRACE_MS = 4_000;
const FRAME_USABLE_PX = 260;

/**
 * The one link that opens the running app in a tab of its own.
 *
 * Both places that carry the preview's private address go through this so they
 * cannot drift: `noreferrer` implies `noopener` and keeps the capability in the
 * path out of any `Referer` header, and `referrerPolicy` says the same thing a
 * second time so that editing the `rel` cannot silently drop it.
 *
 * What this cannot fix: the browser's own status bubble prints the address on
 * hover and the new tab's address bar displays it, so anyone who can see the
 * screen can read it. Once the preview is stopped, the address answers
 * nothing.
 */
export function PreviewOpenLink({
  apiUrl,
  url,
  testId,
  className,
  children,
}: {
  apiUrl: string;
  url: string | null;
  testId: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <a
      href={`${apiUrl}${url}`}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      data-testid={testId}
      className={className}
    >
      {children}
    </a>
  );
}

/**
 * Whether the frame area is too short to be worth drawing an app into.
 *
 * Measured rather than assumed from the viewport: the pane's height is what
 * the rail, the phase strip and whatever else the room is showing have left,
 * and that is not something a breakpoint knows.
 */
function useTooShort(live: boolean) {
  const area = useRef<HTMLDivElement | null>(null);
  const [tooShort, setTooShort] = useState(false);
  useEffect(() => {
    const el = area.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      const h = el.getBoundingClientRect().height;
      setTooShort((was) => (was ? h < FRAME_USABLE_PX : h < FRAME_UNUSABLE_PX));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [live]);
  return { area, tooShort: tooShort && live };
}

/**
 * The minutes-left line, recomputed on its own clock.
 *
 * The panel only polls every fifteen seconds once the app is up, and the whole
 * point of this sentence is that it is accurate in the last two minutes: so
 * it counts down against `expiresAt` rather than against the last answer.
 */
function TimeLeft({ expiresAt }: { expiresAt: string }) {
  const [left, setLeft] = useState(() => minutesLeftOf(expiresAt));
  useEffect(() => {
    setLeft(minutesLeftOf(expiresAt));
    const t = setInterval(() => setLeft(minutesLeftOf(expiresAt)), 15_000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (left === null) return null;
  return (
    <span className="text-warn" data-testid="preview-time-left">
      {minutesLeft(left)}
    </span>
  );
}

export function PreviewPanel({
  status,
  session,
  apiUrl,
  url,
  nonce,
  errors,
  starting,
  error,
  unsupported,
  onStart,
  onStop,
  onRefresh,
  onOpenConsole,
  savedVersion,
  onOpenAppView,
}: {
  status: PreviewStatus;
  /** The API's answer, with the save it was built from and the current save (`currency.ts`). */
  session: (PreviewSessionView & PreviewBuildFields & PreviewRefusalFields) | null;
  apiUrl: string;
  url: string | null;
  nonce: number;
  /** How many lines a learner should look at, carried on the Console control. */
  errors: number;
  starting: boolean;
  /** A request that did not land, said once, above everything else. */
  error: string;
  unsupported: PreviewUnsupported;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
  onOpenConsole: () => void;
  /**
   * The workspace's newest save stamp as this tab knows it (the save hook's
   * version), so a save or an Apply is noticed before the next status poll.
   * Optional: without it the poll's own `workspaceVersion` is read.
   */
  savedVersion?: string | null;
  /** Opens the room's full App preview view, offered when this pane is too short. */
  onOpenAppView?: () => void;
}) {
  const live = status === 'ready' && Boolean(url);
  const detached = status === 'ready' && !url;
  const bundleFailed = live && session?.bundleOk === false;
  /**
   * The press is answered in the pane, not only on the button.
   *
   * `status` is the API's word and the start takes about a second and a half
   * to come back with it, so on `status` alone the pane would sit on "The app is not running" while
   * the learner waited. `starting` is the client's own: it is true from the
   * press to the first answer, and the two together are what the pane draws.
   */
  const booting =
    status === 'starting' || (starting && !live && status !== 'unavailable');
  const { area, tooShort } = useTooShort(live);

  /*
   * The build against the save. A rebuild is one Run app press: the
   * API's start stops this learner's running app first and then builds the
   * current save, in that order and under the same seat, so the panel never
   * sends a stop and a start that could cross. `press` holds the session the
   * press replaced; the press is answered while it runs and once the new app
   * serves the current save.
   */
  const currency = previewCurrency(session, savedVersion);
  const [press, setPress] = useState<{ from: string; phase: 'pressed' | 'running' | 'settled' } | null>(null);
  useEffect(() => {
    if (!press) return;
    if (press.phase === 'pressed' && starting) setPress({ ...press, phase: 'running' });
    else if (press.phase === 'running' && !starting) setPress({ ...press, phase: 'settled' });
  }, [press, starting]);
  useEffect(() => {
    // A press the page never acted on (the save before the start refused, say)
    // is not left saying it is rebuilding.
    if (press?.phase !== 'pressed') return;
    const t = setTimeout(() => setPress((held) => (held?.phase === 'pressed' ? null : held)), REBUILD_GRACE_MS);
    return () => clearTimeout(t);
  }, [press?.phase]);
  const rebuilt = press?.phase === 'settled' && !!session && session.id !== press.from;
  const rebuilding = press !== null && (press.phase !== 'settled' || (rebuilt && booting));
  useEffect(() => {
    // A later save after the rebuild: the note about the last press no longer
    // describes what the pane shows, and the stale line takes its place.
    if (press?.phase === 'settled' && currency === 'earlier') setPress(null);
  }, [press?.phase, currency]);
  const rebuild = () => {
    setPress({ from: session?.id ?? '', phase: 'pressed' });
    onStart();
  };


  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="preview-pane">
      {/* Before the controls, and not inside the frame area: the whole point
          of this sentence is that there is no room to draw anything below it;
          this line included. A rail 73px tall (a phone) fits the
          wrapped toolbar and nothing else, so the sentence goes first or it is
          never read. */}
      {tooShort && (
        <p
          className="shrink-0 border-b-1.5 border-edge px-3.5 py-2 text-[12.5px] leading-relaxed text-ink2"
          data-testid="preview-too-short"
        >
          {TOO_SHORT}{' '}
          {onOpenAppView && (
            <>
              <button
                type="button"
                onClick={onOpenAppView}
                data-testid="preview-too-short-app-view"
                className="font-semibold text-accent"
              >
                {CONTROLS.appView}
              </button>{' '}
              or{' '}
            </>
          )}
          <PreviewOpenLink
            apiUrl={apiUrl}
            url={url}
            testId="preview-too-short-open"
            className="font-semibold text-accent"
          >
            {CONTROLS.open}
          </PreviewOpenLink>
          .
        </p>
      )}

      {/* Controls first, so Tab reaches them before the learner's own app. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b-1.5 border-edge px-3 py-2">
        {live && (
          <>
            <button type="button" onClick={onRefresh} data-testid="preview-refresh" className={CTRL}>
              <Icon name="refresh" size={13} />
              {CONTROLS.refresh}
            </button>
            <PreviewOpenLink apiUrl={apiUrl} url={url} testId="preview-open" className={CTRL}>
              <Icon name="external" size={13} />
              {CONTROLS.open}
            </PreviewOpenLink>
            <button type="button" onClick={onStop} data-testid="preview-stop" className={CTRL}>
              <Icon name="cross" size={13} />
              {CONTROLS.stop}
            </button>
          </>
        )}
        {status !== 'unavailable' && (
          <button
            type="button"
            onClick={onOpenConsole}
            data-testid="preview-console-toggle"
            className={`${CTRL} ml-auto`}
          >
            <Icon name="terminal" size={13} />
            {CONTROLS.console}
            {errors > 0 && <Chip tone="fail">{errors}</Chip>}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="shrink-0 border-b-1.5 border-edge px-3.5 py-2 text-[12.5px] text-fail" data-testid="preview-error">
          {error}
        </p>
      )}

      <div ref={area} className="min-h-0 flex-1 overflow-y-auto">
        {status === 'unavailable' ? (
          <div className="px-3.5 py-3" data-testid="preview-unsupported">
            <EmptyState
              icon="info"
              title="Live preview is not available here"
              body={unsupportedSentence(unsupported, session?.message ?? null)}
            />
          </div>
        ) : booting ? (
          <div className="flex flex-col gap-1 px-3.5 py-3" data-testid="preview-starting">
            <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
              <Icon name="refresh" size={14} className="animate-spin-slow text-accent" />
              {STARTING}
            </p>
            <p className="purpose">{rebuilding ? PREVIEW_REBUILDING : STARTING_DETAIL}</p>
          </div>
        ) : detached ? (
          <div className="px-3.5 py-3" data-testid="preview-detached">
            <EmptyState
              icon="refresh"
              title="This tab needs a new preview link"
              body="Your preview is running, but this tab no longer has its private link. Starting a new preview replaces it and resets its temporary app data."
              action={
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" icon="run" testId="preview-run" onClick={onStart}>
                    Start a new preview
                  </Button>
                  <Button size="sm" variant="ghost" testId="preview-stop" onClick={onStop}>
                    Stop the running preview
                  </Button>
                </div>
              }
            />
          </div>
        ) : status === 'idle' ? (
          <div className="px-3.5 py-3" data-testid="preview-idle">
            <EmptyState
              icon="run"
              title="Your app is not running"
              body={IDLE}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  icon="run"
                  testId="preview-run"
                  busy={starting}
                  busyLabel="Building"
                  onClick={onStart}
                >
                  {CONTROLS.run}
                </Button>
              }
            />
          </div>
        ) : status === 'busy' ? (
          <div className="px-3.5 py-3" data-testid="preview-busy">
            <EmptyState
              icon="clock"
              title={busyCopy(session).title}
              body={busyCopy(session).body}
              action={
                <Button size="sm" variant="secondary" icon="run" testId="preview-run" onClick={onStart}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : status === 'failed' ? (
          <div className="px-3.5 py-3" data-testid="preview-failed">
            <EmptyState
              icon="warning"
              title="Your app did not start"
              body={failedSentence(session?.message ?? null)}
              action={
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" icon="run" testId="preview-run" busy={starting} busyLabel="Building" onClick={onStart}>
                    {CONTROLS.runAgain}
                  </Button>
                  <Button size="sm" variant="ghost" icon="terminal" testId="preview-failed-console" onClick={onOpenConsole}>
                    {CONTROLS.console}
                  </Button>
                </div>
              }
            />
          </div>
        ) : status === 'stopped' ? (
          <div
            className="px-3.5 py-3"
            data-testid="preview-stopped"
            data-reason={session?.stopReason ?? ''}
          >
            <EmptyState
              icon="clock"
              title="The app is not running"
              body={stoppedSentence(session?.stopReason ?? null)}
              action={
                <Button size="sm" variant="secondary" icon="run" testId="preview-run" busy={starting} busyLabel="Building" onClick={onStart}>
                  {CONTROLS.runAgain}
                </Button>
              }
            />
          </div>
        ) : live ? (
          <div className="flex h-full min-h-0 flex-col">
            {rebuilding ? (
              <p
                role="status"
                className="flex shrink-0 items-center gap-2 border-b-1.5 border-edge px-3.5 py-2 text-[12.5px] text-ink"
                data-testid="preview-rebuilding"
              >
                <Icon name="refresh" size={13} className="animate-spin-slow text-accent" />
                {PREVIEW_REBUILDING}
              </p>
            ) : currency === 'earlier' ? (
              <div
                role="status"
                className="flex shrink-0 flex-wrap items-center gap-2 border-b-1.5 border-edge bg-warntint px-3.5 py-2 text-[12.5px] text-ink"
                data-testid="preview-stale"
              >
                <span className="min-w-0 flex-1">{PREVIEW_EARLIER}</span>
                <Button size="sm" variant="secondary" icon="refresh" testId="preview-rebuild" onClick={rebuild}>
                  {CONTROLS.rebuild}
                </Button>
              </div>
            ) : rebuilt && currency === 'current' ? (
              <p
                role="status"
                className="shrink-0 border-b-1.5 border-edge bg-passtint px-3.5 py-2 text-[12.5px] text-ink"
                data-testid="preview-rebuilt"
              >
                {PREVIEW_REBUILT}
              </p>
            ) : null}
            {bundleFailed && (
              <p
                className="shrink-0 border-b-1.5 border-edge bg-failtint px-3.5 py-2 text-[12.5px] text-ink"
                data-testid="preview-bundle-failed"
              >
                {BUNDLE_FAILED}
              </p>
            )}
            <PreviewFrame apiUrl={apiUrl} url={url as string} nonce={nonce} />
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t-1.5 border-edge px-3.5 py-2 text-[11.5px] leading-relaxed text-muted">
        {live && (
          <p data-testid="preview-status">
            {runningSince(session?.readyAt ?? null)}{' '}
            {session?.expiresAt && <TimeLeft expiresAt={session.expiresAt} />}
          </p>
        )}
        {live && currency !== 'unknown' && (
          <p data-testid="preview-built-from">{builtFromSentence(currency === 'current', builtFrom(session))}</p>
        )}
        <p data-testid="preview-not-marked">{NOT_MARKED}</p>
      </div>
    </div>
  );
}
