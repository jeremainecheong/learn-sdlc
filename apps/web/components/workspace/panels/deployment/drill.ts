/**
 * INCIDENT-1 in numbers and words: the clock, the exit code, how long the
 * deployment was broken, and the events the timeline is drawn from.
 *
 * Pure, and shared by the two rooms the drill is run in, the IDE's Drill tab
 * and the incident drill page, so both say the same thing about the same
 * state rather than each computing its own version of "1 minute 50 seconds".
 */
import type { DrillState, PhaseDetail } from '@learnsdlc/shared';
import { RUNBOOK_JSON, serialiseRunbook, validateRunbookRecord } from '@learnsdlc/shared';
import type { StatusState } from '@/lib/phase';
import { runsReferenceApplication } from '@/components/workspace/application';
import type { TimelineEvent } from './Timeline';
import { REFERENCE_COPY } from '../../reference/copy';

export const CI_PATH = '.github/workflows/ci.yml';
export const DOCKERFILE_PATH = 'Dockerfile';

/**
 * "02:30". An incident is read on a 24-hour clock in every runbook there has
 * ever been, and a locale that says "2:30 PM" here would also change how wide
 * the column is between one learner and the next.
 */
export const clock = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';

export const exitWord = (code: number | null | undefined): string =>
  code == null ? 'no exit code recorded' : `exit ${code}`;

export const errorText = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : 'The request failed. Try again.';

export const secondsBetween = (from: string, to: string): number =>
  Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 1000);

/** "2:05", the clock label under a timeline dot. */
export const mmss = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "1 minute 50 seconds", the way an incident report says it. */
export function spoken(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  const mins = `${m} minute${m === 1 ? '' : 's'}`;
  return rest ? `${mins} ${rest} second${rest === 1 ? '' : 's'}` : mins;
}

/**
 * When the outage ended, by the drill's own record: `fixAppliedAt`,
 * the first passing health run after the failure, which the runbook's incident
 * timeline stores as "A health check passed after the failure." Not the
 * write-up (`resolvedAt`, which adds the learner's typing time) and not the
 * latest health run (`healthRanAt`, which a re-run moves). A resolved drill
 * with no fix stamp falls back to the resolve: the API refuses a resolve
 * without one, so only a drill stored before that rule could carry it. Null
 * while the deployment is still broken.
 */
export function outageEndedAt(drill: DrillState): string | null {
  return drill.fixAppliedAt ?? drill.resolvedAt ?? null;
}

/**
 * How long INCIDENT-1 was broken, said the same way by the incident card and
 * the drill page's chip (the timeline draws the same span): paged to
 * {@link outageEndedAt}, or to `now` while it is still broken.
 */
export function brokenFor(drill: DrillState, now: number): string {
  const ended = outageEndedAt(drill);
  const said = spoken(secondsBetween(drill.pagedAt, ended ?? new Date(now).toISOString()));
  return ended ? `Broken for ${said}, then fixed` : `Broken for ${said}`;
}

/**
 * The timeline's words over the red span while the incident is still open (no
 * passing health run after the failure and no resolve). The chip counts paged
 * to now, so a length taken at the last event drawn would be a second, shorter
 * length; the timeline says the outage has not ended instead.
 */
export const STILL_BROKEN = 'Still broken';

/** The path this phase actually uses, so a project that moves a file still resolves. */
export function pathIn(detail: PhaseDetail, wanted: string): string {
  const exact = detail.files.find((f) => f.path === wanted);
  if (exact) return exact.path;
  const base = wanted.split('/').pop() ?? wanted;
  return detail.files.find((f) => f.path.endsWith(base))?.path ?? wanted;
}

/**
 * The path this phase mounts for an artefact, or null
 * when a teacher's own application ships none. TaskTrackr's names are the
 * literals above; an uploaded pack names its own files (one may ship
 * `api/Dockerfile` and no workflow), so for it there is no
 * literal fallback, and a control for a file it does not ship is not drawn.
 * On the reference application this is {@link pathIn}.
 */
export function shippedPath(detail: PhaseDetail, wanted: string): string | null {
  const found = pathIn(detail, wanted);
  if (runsReferenceApplication(detail.provenance)) return found;
  return detail.files.some((f) => f.path === found) ? found : null;
}

/** {@link shippedPath}, or the words that name the artefact when the pack ships no such file. */
export function shippedName(detail: PhaseDetail, wanted: string, words: string): string {
  return shippedPath(detail, wanted) ?? words;
}

/** The drill as a run of events, oldest first, for {@link IncidentTimeline}. */
export function timelineEvents(drill: DrillState, healthOk: boolean): TimelineEvent[] {
  const paged = drill.pagedAt;
  const events: TimelineEvent[] = [
    { at: 0, t: '0:00', kind: 'alert', label: 'INCIDENT-1 paged: the faulted copy did not start', state: 'fail' },
  ];
  if (drill.healthRanAt) {
    const at = secondsBetween(paged, drill.healthRanAt);
    events.push({
      at,
      t: mmss(at),
      kind: 'check',
      label: healthOk ? 'Health check passes on your files' : `Health check ${exitWord(drill.healthExit)} on your files`,
      state: healthOk ? 'pass' : 'fail',
    });
  }
  if (drill.fixAppliedAt) {
    const at = secondsBetween(paged, drill.fixAppliedAt);
    events.push({ at, t: mmss(at), kind: 'fix', label: 'The fix passes the same check' });
  }
  if (drill.resolvedAt) {
    const at = secondsBetween(paged, drill.resolvedAt);
    events.push({ at, t: mmss(at), kind: 'verify', label: 'INCIDENT-1 resolved and written up', state: 'pass' });
  }
  return events;
}

/** What the room says once the incident is closed: the drill page and the IDE say the same sentence. */
export const resolvedSentence = (hasRecord: boolean): string => (hasRecord ? 'Closed. The incident is in your runbook.' : 'INCIDENT-1 resolved.');

/** The IDE's resolve: the drill's answer, then a reload, so the IDE adopts the resolve's own new save stamp, which the next save quotes, and the record's incident, as `health` already does. */
export async function resolveAndReload<T>(resolve: () => Promise<T>, reload: () => Promise<unknown>): Promise<T> {
  const state = await resolve();
  await reload().catch(() => undefined);
  return state;
}

/** What the IDE's own resolve answered: its new save stamp, and the write-up it sent. */
export interface OwnResolve {
  version: string | null;
  incident: { rootCause: string; fix: string; actionItem: string };
}

/**
 * Whether a change to a file, read back by the reload that follows this page's
 * own resolve, is that resolve's write and nothing else. The resolve
 * writes the incident into the runbook record and moves the save stamp, and
 * every other write to the workspace moves the stamp too, so the record is the
 * resolve's own when: it is the runbook record; the copy read carries the very
 * stamp the resolve answered; its incident is the write-up this page sent; and
 * with the incident set back to the one the page held, it is the record the
 * page held. Anything else (another tab's save before the resolve, a reset, an
 * Apply elsewhere) is not explained, and the page says the copy changed, as it
 * always has.
 */
export function writtenByOwnResolve(path: string, held: string | undefined, read: string, readVersion: string | null | undefined, own: OwnResolve): boolean {
  if (path !== RUNBOOK_JSON || held === undefined || !own.version || !readVersion) return false;
  if (Date.parse(readVersion) !== Date.parse(own.version)) return false;
  const before = validateRunbookRecord(held).runbook;
  const after = validateRunbookRecord(read).runbook;
  if (!before || !after) return false;
  const sent = own.incident;
  if (after.incident.rootCause !== sent.rootCause.trim() || after.incident.fix !== sent.fix.trim() || after.incident.actionItem !== sent.actionItem.trim()) return false;
  return serialiseRunbook({ ...after, incident: before.incident }) === serialiseRunbook(before);
}

/* ------------------------- the drill, said once ------------------------- */
/*
 * The drill is drawn in two places, the workspace's Pipeline tab and the
 * incident drill page, and both say the same thing about the same state: the
 * same card before it starts, the same purpose, the same two rows with the
 * same titles, chips and colours. The words live here.
 */

/** The card before the drill starts: its title, purpose, chip and empty state. */
export const DRILL_CARD_TITLE = 'INCIDENT-1';
export const DRILL_CARD_PURPOSE = 'An isolated selfcheck against a faulted copy of the configuration. Your own files are not touched.';
export const DRILL_NOT_STARTED_CHIP = 'Not started';
export const DRILL_NOT_STARTED = 'The drill has not started';
/** What starting the drill does; Compose is named only on the reference application, whose configuration it is. */
export const drillNotStartedBody = (reference: boolean): string =>
  `Starting the drill runs the project selfcheck against a faulted ${reference ? REFERENCE_COPY.drillTarget : 'copy of the configuration'} and records its real output. Fix the setting it names, rerun the selfcheck, and write the incident record. This drill does not build or deploy images.`;

/** The faulted configuration's card, once paged: what the platform ran and where to look. */
export const faultedPurpose = (reference: boolean, runbook: boolean): string =>
  `The platform ran an isolated selfcheck against a faulted ${reference ? REFERENCE_COPY.drillTarget : 'copy of the configuration'}. Read what it printed${runbook ? ' and your runbook' : ''} to find the fault. No image is built or deployed.`;

/** The paged drill's chip: "Paged" while it is open, the same tone as the drill's clock and the brief's row. */
export const pagedChip = (drill: DrillState): { label: string; tone: 'warn' | 'pass' } =>
  drill.resolvedAt ? { label: 'Resolved', tone: 'pass' } : { label: 'Paged', tone: 'warn' };

export interface DrillRow {
  title: string;
  state: StatusState;
  chip: string;
  tone: 'neutral' | 'pass' | 'fail';
  /** The exit code, where the chip names what it means: a title, not a word in the sentence. */
  chipTitle?: string;
}

/** The faulted copy's row: "Fault detected" when the selfcheck failed on it, as the pack declares it must. */
export function faultedRow(drill: DrillState): DrillRow {
  const known = typeof drill.pagedExit === 'number';
  const failed = known && drill.pagedExit !== 0;
  return {
    title: 'The faulted configuration',
    state: !known ? 'todo' : failed ? 'fail' : 'pass',
    chip: !known ? 'No recorded exit' : failed ? 'Fault detected' : 'Fault not detected',
    tone: !known ? 'neutral' : failed ? 'fail' : 'pass',
    chipTitle: known ? `Exit ${drill.pagedExit}` : undefined,
  };
}

/**
 * The selfcheck on the learner's own files, as the drill recorded it. Before it
 * runs the sentence says since when: a selfcheck run from the header
 * before the page was paged is not the drill's, and "not run yet" a minute
 * after one read as false.
 */
export function healthRow(drill: DrillState): DrillRow & { detail: string } {
  const ran = Boolean(drill.healthRanAt);
  const ok = drill.healthExit === 0;
  return {
    title: 'The project selfcheck on your files',
    state: ran ? (ok ? 'pass' : 'fail') : 'todo',
    chip: ran ? (ok ? 'Passed' : 'Failed') : 'Not run',
    tone: ran ? (ok ? 'pass' : 'fail') : 'neutral',
    detail: ran
      ? `Last run at ${clock(drill.healthRanAt)} against your files: ${exitWord(drill.healthExit)}.`
      : `Not run since you were paged at ${clock(drill.pagedAt)}.`,
  };
}

/** The heading over what the selfcheck on the learner's files printed; the row above carries its verdict. */
export const healthOutputTitle = (exit: number): string => `What the selfcheck on your files printed: exit ${exit}`;

/**
 * "Declare it resolved": the three things that must be true, in order, ticked as the drill records them. One list
 * for the workspace's Pipeline tab and the drill page's checklist.
 */
export function resolveSteps(drill: DrillState): { title: string; detail: string; state: StatusState; meta?: string }[] {
  const pagedKnown = typeof drill.pagedExit === 'number';
  const pagedFailed = pagedKnown && drill.pagedExit !== 0;
  const healthOk = drill.healthExit === 0;
  const resolved = Boolean(drill.resolvedAt);
  return [
    {
      title: 'The selfcheck fails on the faulted copy',
      detail: !pagedKnown ? 'No selfcheck exit was recorded. Start the drill again.' : pagedFailed
        ? 'Ran when you were paged. The selfcheck found the fault.'
        : 'Ran when you were paged, and the selfcheck did not detect the fault. Page the drill again.',
      state: pagedFailed ? 'pass' : 'todo',
      meta: clock(drill.pagedAt),
    },
    {
      title: 'The selfcheck passes on your files',
      detail: drill.healthRanAt
        ? `Ran at ${clock(drill.healthRanAt)}: ${exitWord(drill.healthExit)}.`
        : 'Fix the file the incident names, then run the selfcheck against your own files.',
      state: drill.healthRanAt ? (healthOk ? 'pass' : 'fail') : 'todo',
      meta: clock(drill.healthRanAt),
    },
    {
      title: 'INCIDENT-1 has a root cause in your words',
      detail: resolved
        ? `Written at ${clock(drill.resolvedAt)}.`
        : 'Three lines: what went wrong, what you changed, what would have caught it.',
      state: resolved ? 'pass' : 'todo',
      meta: resolved ? clock(drill.resolvedAt) : 'You',
    },
  ];
}
