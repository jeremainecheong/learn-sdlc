/**
 * Classroom mode: a queued job's position and the lab's view of a class.
 */

/* ----------------------------- classroom mode ----------------------------- */

/**
 * Where a queued job sits. `ahead` is jobs, not seconds, because jobs is what
 * the queue actually knows; the estimate beside it is derived from how long
 * recent jobs of the same kind took and is null until there is enough history
 * to be worth printing.
 */
export interface QueuePositionView {
  state: 'queued' | 'running' | 'done';
  /** Jobs the scheduler would start before this one. 0 means next. Null when unknown. */
  ahead: number | null;
  /** Rounded to ten seconds, floored at ten. Null when there is no estimate. */
  estimateSeconds: number | null;
}

/** Why a class cannot be reached from the room, when it cannot. */
export type LabUnreachable =
  /** The API is bound to loopback: this is the single-machine demo, not a lab. */
  | 'loopback'
  /** Bound to the network, but this machine has no address on it. */
  | 'no-address';

/** One class, with the two things a learner needs to arrive: a link and a picture of it. */
export interface LabCohortView {
  cohortId: string;
  name: string;
  /** ABCD-EFGH, dashed the way the console prints it. */
  joinCode: string;
  /** The full link, including the code. Empty when there is no origin to build it from. */
  joinUrl: string;
  /** A complete <svg> element for joinUrl, or null when there is no link to encode. */
  qrSvg: string | null;
}

/**
 * What the console can tell an instructor about hosting this session. It is a
 * report, never a control: the API cannot rebind itself, and nothing here can
 * turn hosting on. That is `npm run host`, deliberately.
 */
export interface LabView {
  /** True when the API is bound past loopback: a class on the network can reach it. */
  hosted: boolean;
  /** The origin learners open, e.g. http://192.168.1.24:3000. Null when there is none. */
  origin: string | null;
  /** Set when `hosted` is false, or when hosting found no address. */
  unreachable: LabUnreachable | null;
  cohorts: LabCohortView[];
}
