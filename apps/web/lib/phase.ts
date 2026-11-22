import type { PhaseKey, PhaseStatus } from '@learnsdlc/shared';

/**
 * The six phases as the interface names them. The API is the source of truth
 * for ids and titles; this is the presentational layer on top: a short form
 * for tight spaces and a verb for "what you do here".
 */
export const PHASE_META: Record<PhaseKey, { order: number; title: string; short: string; verb: string }> = {
  requirements: { order: 1, title: 'Requirements', short: 'Req', verb: 'Specify' },
  design: { order: 2, title: 'Design', short: 'Design', verb: 'Decide' },
  implementation: { order: 3, title: 'Implementation', short: 'Build', verb: 'Build' },
  testing: { order: 4, title: 'Testing', short: 'Test', verb: 'Prove' },
  deployment: { order: 5, title: 'Deployment', short: 'Deploy', verb: 'Ship' },
  maintenance: { order: 6, title: 'Maintenance', short: 'Maintain', verb: 'Sustain' },
};

export const PHASE_KEYS = Object.keys(PHASE_META) as PhaseKey[];

/** A phase's picture, the one the dashboard, the record pages and the room headers draw. */
export const phaseArt = (key: PhaseKey) => `/artwork/dashboard-${key}-3d.webp`;

/** The reviewer's role in each phase: the workspace's reviewer tab, the journal's hint titles and the signature on a pull request's review threads. */
export const PERSONA_NAME: Record<PhaseKey, string> = {
  requirements: 'Product owner',
  design: 'Architect',
  implementation: 'Senior engineer',
  testing: 'QA lead',
  deployment: 'SRE',
  maintenance: 'Maintainer',
};

/**
 * One reviewer per phase: the person whose reading the phase is written for.
 * `initials` is what the avatar carries, `role` completes the sentence
 * "Reviewed by the …", and `does` is the two-sentence description of what they
 * read and what they will not do for the learner.
 */
export const PHASE_REVIEWER: Record<PhaseKey, { initials: string; role: string; does: string }> = {
  requirements: {
    initials: 'PO',
    role: 'product owner',
    does: 'Reads your story and its criteria. Asks whether each one can be run. Never writes the story.',
  },
  design: {
    initials: 'AR',
    role: 'architect',
    does: 'Reads your model and your contracts. Asks what each decision gave up. Never makes the decision.',
  },
  implementation: {
    initials: 'SE',
    role: 'senior engineer',
    does: 'Reads your pull request. Comments on lines. Never writes the fix.',
  },
  testing: {
    initials: 'QA',
    role: 'QA lead',
    does: 'Reads your tests against the planted bugs. Says which bug is still alive. Never writes the test.',
  },
  deployment: {
    initials: 'SR',
    role: 'site reliability engineer',
    does: 'Reads your pipeline and your runbook. Pages you when the container stops. Never fixes it for you.',
  },
  maintenance: {
    initials: 'MT',
    role: 'maintainer',
    does: 'Reads the change against the contract it answers to. Says what else it touches. Never makes the change.',
  },
};

/** The phase hue as a CSS colour, e.g. for inline SVG strokes. */
export function phaseHue(key: PhaseKey): string {
  return `rgb(var(--hue-${key}))`;
}

/** The phase's pale tint as a CSS colour. */
export function phaseTint(key: PhaseKey): string {
  return `rgb(var(--tint-${key}))`;
}

/**
 * The one status vocabulary every list shares. It lives in `@learnsdlc/shared`
 * with the project map that reads it, and is re-exported here for
 * `@/lib/phase` importers.
 *   pass: gate cleared (green fill)
 *   done: finished, no gate (phase-hue fill)
 *   now:  the thing being worked on (accent outline)
 *   todo: not started or locked (dashed)
 *   fail: failing (red fill)
 *   warn: needs a decision or a resubmission (orange fill)
 */
export { statusState, type StatusState } from '@learnsdlc/shared';

/** "Passed with 86", "Scored 64 of 70", "Not submitted". */
export function scoreLabel(score: number | null | undefined, threshold = 70): string {
  if (score == null || Number.isNaN(score)) return 'Not submitted';
  const s = Math.round(score);
  return s >= threshold ? `Passed with ${s}` : `Scored ${s} of ${threshold}`;
}

/** Maps a free-form status to the plain word the interface uses. */
export function statusWord(status: PhaseStatus): string {
  switch (status) {
    case 'passed':
      return 'Passed';
    case 'locked':
      return 'Locked';
    case 'submitted':
      return 'Submitted';
    default:
      return 'In progress';
  }
}
