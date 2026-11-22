/**
 * The live preview of a learner's own application: its status, log lines,
 * session and refusal sentences.
 */

/* --------------------------------- live preview --------------------------- */

/**
 * Where a learner's own application is, as the panel reads it.
 *
 * `idle` is the client's own word for "there is no session"; the API never
 * returns it. `busy` is the runner full of other people's previews and
 * `unavailable` is a deployment that cannot preview at all: the Lambda
 * transport, or `PREVIEW_ENABLED=false`. Both are outages rather than
 * verdicts, exactly as `RunExitKind`'s `unavailable` is.
 */
export type PreviewStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'stopped'
  | 'busy'
  | 'unavailable';

/**
 * Why a session is no longer running.
 *
 * The runner names the reason and never the sentence: one word here, and the
 * words a learner reads live in the web's `copy.ts`, so a sentence has one
 * home. `crashed` is the app's own exit, `build` is a front end that never
 * compiled, and `shutdown` is the API or the runner going down under it.
 */
export type PreviewStopReason =
  | 'learner'
  | 'idle'
  | 'expired'
  | 'budget'
  | 'build'
  | 'crashed'
  | 'shutdown';

/** One line the learner's app printed, as the console pane draws it. */
export interface PreviewLogLine {
  stream: 'out' | 'err';
  /** Redacted and truncated by the runner before it is stored, never here. */
  text: string;
  at: string;
}

/**
 * One live preview, as the workspace sees it.
 *
 * `url` is the only field that ever carries the capability, and it is present
 * only on the answer to a start: a status poll that repeated it would put the
 * capability into every response body, every browser cache and every HAR file
 * a learner sends us when something goes wrong.
 */
export interface PreviewSessionView {
  /** Opaque to the web; the capability id is carried separately and only once. */
  id: string;
  phaseStateId: string;
  status: PreviewStatus;
  /**
   * '/api/v1/preview/<capability>/' while the app can be opened, else null.
   * Present only on the answer to start; never on a status poll.
   */
  url: string | null;
  /** False means the front end did not build; the page will say so. */
  bundleOk: boolean;
  /** One sentence for the learner, never a stack trace. */
  message: string | null;
  stopReason: PreviewStopReason | null;
  startedAt: string;
  readyAt: string | null;
  /** The hard cap. The panel shows the minutes left once under two. */
  expiresAt: string;
  /** The idle cap, pushed out by every proxied request and every status poll. */
  idleExpiresAt: string;
  bytesServed: number;
  console: PreviewLogLine[];
  /** Pass back on the next poll to get only what is new. */
  cursor: number;
}

/**
 * Why this deployment cannot preview, or null when it can.
 *
 * `isolation`: the code runner has
 * reported that it cannot put a kernel boundary around learner code on this
 * host, so it refuses to run any, the same fact Submit reports. Only a runner
 * that has said so; one that has not been asked yet is not refused.
 */
export type PreviewUnsupported = 'lambda-runner' | 'disabled' | 'isolation' | null;

export const PREVIEW_UNAVAILABLE_MESSAGE =
  'Live preview needs the runner on this machine or in the runner container. This deployment runs code in Lambda, where an app has nowhere to keep running. Everything else in the phase works as normal.';

export const PREVIEW_DISABLED_MESSAGE =
  'Live preview is turned off on this deployment. Everything else in the phase works as normal.';

export const PREVIEW_ISOLATION_MESSAGE =
  'Live preview cannot run here: the code runner cannot provide kernel isolation on this host, so it runs no learner code. Your saved work is unchanged.';

export const PREVIEW_NOT_MARKED_MESSAGE = 'The preview is for you. It is not marked.';

/* Three more true sentences for a preview that cannot run, each for a case
 * where "turned off", "did not start" or "every seat is taken" would not be
 * so. */

/** The preview's runner could not be reached or started on this deployment. */
export const PREVIEW_RUNNER_UNAVAILABLE_MESSAGE =
  'Live preview could not reach its runner, so your app did not start. Your saved work is unchanged. Everything else in the phase works as normal.';

/**
 * The learner's own last session never had its shutdown confirmed, and the
 * seat it held stays held until an operator checks the runner and clears it.
 */
export const PREVIEW_CLEANUP_HELD_MESSAGE =
  'Your last app session was never confirmed as shut down, so its seat stays held until the people who run this platform clear it. Your saved work is unchanged.';

/** Every seat is held by a session whose shutdown was never confirmed. */
export const PREVIEW_PAUSED_MESSAGE =
  'Live preview is paused here until the people who run this platform clear an app session that was never confirmed as shut down. Your saved work is unchanged.';

/*
 * The preview's other fields live in other modules: PhaseDetail carries
 * `canPreview?: boolean` and `previewUnsupported?` (./phase-detail), and
 * AuditEventView['event'] carries 'preview.start' | 'preview.stop' (./feedback).
 */
