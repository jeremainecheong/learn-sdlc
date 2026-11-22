'use client';

/**
 * Every sentence the preview panel says, in one file.
 *
 * The API never writes prose about the preview. It answers a `status` and a
 * one-word `stopReason`, and the two sentences it does carry in `message` are
 * the runner's own report on the learner's process ("Your API did not start.")
 * and the three shared constants about a deployment that cannot preview. Every
 * other word a learner reads is here, exported, so a missing one is a failing
 * test rather than an empty box.
 */
import {
  PREVIEW_DISABLED_MESSAGE,
  PREVIEW_ISOLATION_MESSAGE,
  PREVIEW_NOT_MARKED_MESSAGE,
  PREVIEW_UNAVAILABLE_MESSAGE,
  type PreviewStopReason,
  type PreviewUnsupported,
} from '@learnsdlc/shared';
import { DISPLAY_LOCALE } from '@/lib/locale';

/** Nothing running yet: what the button will do, and for how long. */
export const IDLE =
  'The app is not running. Run app builds your front end, starts your API and shows it here. It runs in your own preview session for up to ten minutes.';

export const STARTING = 'Starting your app.';

/**
 * The second line under "Starting your app.".
 *
 * There is no place in a queue to report, a preview is never enqueued, so
 * the honest second line is what is actually happening
 * and how long it is allowed to take.
 */
export const STARTING_DETAIL =
  'The front end is compiled and your API is started. This usually takes a few seconds.';

/** The footer while the app is up. */
export function runningSince(readyAt: string | null): string {
  return `Running since ${clockTime(readyAt)}. Stops after ten minutes, or five minutes with nothing happening.`;
}

/** Shown only once the hard cap is under two minutes away. */
export function minutesLeft(minutes: number): string {
  const n = Math.max(1, Math.ceil(minutes));
  return `About ${n} minute${n === 1 ? '' : 's'} left.`;
}

/**
 * Why the app is not running any more, one sentence per reason.
 *
 * Four are fixed word for word by the preview contract. `build`, `crashed`
 * and `shutdown` are this file's own and follow the same shape: what
 * happened, whether anything was lost, what to do next.
 */
export const STOPPED: Record<PreviewStopReason, string> = {
  learner: 'You stopped the app.',
  idle: 'The app stopped after five quiet minutes. Nothing was lost. Start it again when you need it.',
  expired: 'The app ran for its ten minutes and stopped. Start it again to keep going.',
  budget: 'The app stopped after serving 32 MB. The console shows what it was serving.',
  build: "The front end did not build, so the app stopped. The console has the compiler's message.",
  crashed: 'Your app stopped on its own. The console shows what it printed last.',
  shutdown: 'The app was stopped because the platform restarted. Start it again when you need it.',
};

/** A session that stopped without saying why. */
export const STOPPED_UNKNOWN = 'The app is not running any more. Start it again when you need it.';

export function stoppedSentence(reason: PreviewStopReason | null): string {
  return reason ? STOPPED[reason] : STOPPED_UNKNOWN;
}

/**
 * The app did not start. The runner's own sentence is the one to show, it is
 * the only party that watched the learner's process, and this is what stands
 * in for it when there is none.
 */
export const FAILED_FALLBACK = 'Your app did not start. The console has what it printed.';

export function failedSentence(message: string | null): string {
  return message?.trim() ? message.trim() : FAILED_FALLBACK;
}

/** The front end did not compile. The API may still be answering. */
export const BUNDLE_FAILED =
  "The front end did not build. The console has the compiler's message.";

/** Why this deployment cannot preview at all. */
export function unsupportedSentence(
  why: PreviewUnsupported,
  message?: string | null,
): string {
  if (message?.trim()) return message.trim();
  if (why === 'lambda-runner') return PREVIEW_UNAVAILABLE_MESSAGE;
  // A host whose runner cannot isolate learner code.
  // Preview is not "turned off" there; it cannot run, and Submit says the same.
  if (why === 'isolation') return PREVIEW_ISOLATION_MESSAGE;
  return PREVIEW_DISABLED_MESSAGE;
}

/** Under every state, on every deployment. */
export const NOT_MARKED = PREVIEW_NOT_MARKED_MESSAGE;

/**
 * A pane with no room for an application, said rather than left blank.
 *
 * On a phone the right rail can be shorter than the app it is framing, and an
 * iframe clipped to nothing looks exactly like an app that did not start. The
 * door is the same one the toolbar opens, so the sentence points at it.
 */
export const TOO_SHORT = 'This pane is too short to show your app.';

export const CONTROLS = {
  run: 'Run app',
  runAgain: 'Start it again',
  refresh: 'Refresh',
  open: 'Open in a new tab',
  stop: 'Stop',
  console: 'Console',
  rebuild: 'Rebuild preview',
  appView: 'Open App preview',
};

// Which save the running app shows. A preview keeps serving the build
// it started with; these say when a later save exists and what a rebuild does.

/** A save or an Apply has moved past the build the app is serving. */
export const PREVIEW_EARLIER = 'Preview is using an earlier version of your code.';

/** While a rebuild stops the app and starts it again from the current save. */
export const PREVIEW_REBUILDING = 'Rebuilding the preview from your current save.';

/** Once the rebuilt app is serving. */
export const PREVIEW_REBUILT = 'Preview rebuilt from your current save.';

// A refused start (status `busy`) has three causes, said apart.

/**
 * Why the API refused a start, when the cause is the learner's own preview
 * and not the class (`reason` on the answer, apps/api/src/preview/preview.dto.ts
 * PreviewRefusalFields). Absent on the class-full refusal and on any answer
 * from an API before the field.
 */
export type PreviewRefusalReason = 'own-preview-stopping' | 'own-preview-starting';

export interface PreviewRefusalFields {
  reason?: PreviewRefusalReason;
}

/** The class has every seat: the API's SANDBOX_BUSY_MESSAGE is the body. */
export const BUSY_TITLE = 'Every seat is taken';

/**
 * The API's sentence when the only thing in the way is this learner's own
 * earlier preview, stopped but not yet confirmed gone (the API's
 * PREVIEW_OWN_STOPPING_MESSAGE). Read only when the answer has no `reason`:
 * an API from before the field said the case only by this sentence.
 */
export const OWN_STOPPING_MESSAGE =
  'Your earlier preview is still stopping. Your work is saved. Try again in a moment.';

export const OWN_STOPPING_TITLE = 'Your earlier preview is still stopping';

/** The body under OWN_STOPPING_TITLE, which already says the first sentence. */
export const OWN_STOPPING_BODY = 'Your work is saved. Try again in a moment.';

/** Another start of the learner's own (a second tab) is still launching. */
export const OWN_STARTING_TITLE = 'Your preview is already starting';

export const OWN_STARTING_BODY = 'Give it a moment.';

/** A cause this panel does not know yet: true whatever it is, over the API's sentence. */
export const REFUSED_TITLE = 'Your app is not running';

/**
 * The title and body for a refused start: by the API's `reason` when it sends
 * one, else by its sentence (an API from before the field), else the class.
 */
export function busyCopy(
  session: { message?: string | null; reason?: string } | null | undefined,
): { title: string; body: string } {
  const message = session?.message ?? null;
  const reason = session?.reason;
  if (reason === 'own-preview-stopping') return { title: OWN_STOPPING_TITLE, body: OWN_STOPPING_BODY };
  if (reason === 'own-preview-starting') return { title: OWN_STARTING_TITLE, body: OWN_STARTING_BODY };
  // Only the class-full refusal comes without a reason, so a reason this panel
  // does not know is never "every seat is taken".
  if (reason) return { title: REFUSED_TITLE, body: message ?? '' };
  if (message?.trim() === OWN_STOPPING_MESSAGE) return { title: OWN_STOPPING_TITLE, body: OWN_STOPPING_BODY };
  return { title: BUSY_TITLE, body: message ?? '' };
}

/** What the running app was built from: the current save, an earlier one, or the starting code. */
export function builtFromSentence(current: boolean, builtFrom: string | null): string {
  if (current) return 'Built from the current save.';
  if (!builtFrom) return 'Built from the starting code.';
  return `Built from your save at ${clockTime(builtFrom)}.`;
}

export const FRAME_TITLE = 'Your running app';

/** The console when the app has printed nothing yet. */
export const CONSOLE_EMPTY = 'Your app has printed nothing yet.';

/**
 * "14:32" in the viewer's own time zone, from an ISO instant. A missing
 * instant is drawn as an em dash rather than as "Invalid Date".
 *
 * Twenty-four hour, like the status bar under the code, the journal and the
 * pull request: "Running since 12:32 PM" beside a status bar reading
 * "12:26" is two clocks on one screen.
 */
export function clockTime(at: string | null): string {
  if (!at) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

// The page preview, the learner's own page code run
// in the browser. Every sentence it says is here.

/** Above the frame, always: what this is and what it is not. */
export const PAGE_PREVIEW_LABEL =
  'Page preview: your code running in the browser with sample data. Your API is not running here.';

/**
 * The label for a page that asks the API for its data where the project ships
 * no sample data: "with sample data" over an empty page would not be true, so
 * it says why the page is empty. Chosen by `pagePreviewLabel`.
 */
export const PAGE_PREVIEW_LABEL_NO_DATA =
  'Page preview: your code running in the browser. Your API is not running here, so the page gets no data from it.';

export const PAGE_PREVIEW_FRAME_TITLE = 'Your page, running in the browser';

export const PAGE_PREVIEW_TIMEOUT = 'This page did not draw in 5 seconds.';

export const PAGE_PREVIEW_RELOAD = 'Reload';

export const PAGE_PREVIEW_BUILDING = 'Building your page.';

export const PAGE_PREVIEW_NO_PAGE =
  'This room has no page to draw: its web files have no .html file, no main or index module and no page component.';

export const PAGE_PREVIEW_ERRORS = 'Your page reported:';

export const PAGE_PREVIEW_TOO_MANY = 'The page preview draws up to 200 files. This project has more.';

export const PAGE_PREVIEW_TOO_BIG = 'The page preview draws up to 2 MB of code. This project has more.';

/** The page preview in a tab of its own: the document title (the brand is appended by the root layout). */
export const PAGE_PREVIEW_TAB_TITLE = 'Page preview';

/** HH:MM:SS, local, 24-hour. */
export function pagePreviewClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(DISPLAY_LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** The tab's snapshot line: when its code was taken, and that it does not follow the editor. */
export function pagePreviewTabSnapshot(iso: string): string {
  return `Snapshot of the code in your editor at ${pagePreviewClock(iso)}. This tab does not update: to see later changes, go back to your workspace and press ${CONTROLS.open} again.`;
}

/** The tab when this browser holds no snapshot for its address. */
export const PAGE_PREVIEW_TAB_EMPTY = `Nothing to show here. Open the page preview in your workspace and press ${CONTROLS.open}.`;

/** A package the preview frame does not carry. */
export function pagePreviewMissingPackage(name: string): string {
  return `This page imports '${name}', which the page preview does not provide. It provides react, react-dom, react-dom/client and a small hash router for react-router-dom.`;
}
