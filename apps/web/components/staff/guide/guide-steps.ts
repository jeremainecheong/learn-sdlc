/**
 * The ten steps' states, derived on the client.
 *
 * Every state comes from what the page already holds: the draft
 * (`version.draft`), the deep-validation view (`deepValidation.read`), the
 * project summary where the page has one, and two facts of this session (a
 * preview opened, an export saved). No status API is added and nothing here
 * calls the network.
 *
 * A step is `done`, `todo` or `stale` (a passing or failing deep validation on
 * bytes that have changed since). A step that does not apply to this project,
 * such as sealing on a project with no executable phase, says so with
 * `applies: false` rather than claiming to be done.
 */
import type {
  AuthoredProjectSummary,
  DeepValidationView,
  DraftVersionView,
  GuideStep,
  GuideStepKey,
} from '@learnsdlc/shared';
import { GUIDE_STEPS } from '@learnsdlc/shared';

type GuideStepState = 'todo' | 'done' | 'stale';

export interface DerivedGuideStep extends GuideStep {
  state: GuideStepState;
  /** False when the step has nothing to do on this project. */
  applies: boolean;
}

export interface GuideInput {
  /** The draft the editor holds, or null where there is none (the Projects page, the guide page). */
  view: DraftVersionView | null;
  /** The deep-validation view, or null when it has not been read. */
  deep?: DeepValidationView | null;
  /** The project's row, where the page has it: whether it published and how many classes are on it. */
  summary?: Pick<AuthoredProjectSummary, 'cohortsUsing' | 'publishedVersion'> | null;
  /** This session opened the learner preview. */
  previewed?: boolean;
  /** This session saved an export. */
  exported?: boolean;
}

function executablesOf(view: DraftVersionView) {
  return view.phases.flatMap((phase) => phase.tasks.flatMap((task) => (task.executable ? [task.executable] : [])));
}

function stateOf(key: GuideStepKey, input: GuideInput): { state: GuideStepState; applies: boolean } {
  const { view } = input;
  const done = (yes: boolean) => ({ state: yes ? ('done' as const) : ('todo' as const), applies: true });
  if (view === null) {
    // Nothing to read: every step is ahead.
    return { state: 'todo', applies: true };
  }
  const frozen = view.status !== 'draft';
  const executables = executablesOf(view);
  switch (key) {
    case 'prepare':
    case 'upload':
      return done(true);
    case 'refine':
      return done(frozen || view.validation?.publishable === true);
    case 'seal':
      if (executables.length === 0) return { state: 'done', applies: false };
      return done(
        frozen ||
          executables.every(
            (exec) =>
              exec.solution.length > 0 &&
              exec.runs.some((run) => run.hidden.length > 0) &&
              (exec.checkKind !== 'tests' || exec.mutants.length > 0),
          ),
      );
    case 'deep-validate': {
      if (executables.length === 0) return { state: 'done', applies: false };
      if (frozen) return done(true);
      const deep = input.deep;
      if (!deep) return done(false);
      if (deep.current) return done(deep.status === 'passed');
      return { state: deep.status === 'passed' || deep.status === 'failed' ? 'stale' : 'todo', applies: true };
    }
    case 'preview':
      return done(input.previewed === true);
    case 'publish':
      // The project published once: the next draft keeps the step done, as Assign does.
      return done(view.status === 'published' || Boolean(input.summary?.publishedVersion));
    case 'assign':
      return done((input.summary?.cohortsUsing ?? 0) > 0);
    case 'sign-off':
      return done(view.phases.some((phase) => phase.tasks.some((task) => task.signOff === true)));
    case 'export':
      return done(input.exported === true);
  }
}

/** The ten steps, in order, each with its state. */
export function deriveGuideSteps(input: GuideInput): DerivedGuideStep[] {
  return GUIDE_STEPS.map((step) => ({
    ...step,
    ...stateOf(step.key, input),
  }));
}

/** The first step a teacher still has to take: required, applicable, not done. Null when the path is walked. */
export function nextGuideStep(steps: readonly DerivedGuideStep[]): DerivedGuideStep | null {
  return steps.find((step) => !step.optional && step.applies && step.state !== 'done') ?? null;
}

/**
 * Where "Take me there" goes from the page the rail is drawn on, or null when
 * that page cannot reach the step (an editor section, seen from a page with no
 * draft open).
 */
export function guideStepHref(step: Pick<GuideStep, 'anchor'>, from: 'projects' | 'editor' | 'guide'): string | null {
  const { page, id } = step.anchor;
  if (page === 'classes') return '/teacher';
  if (page === 'projects') return from === 'projects' ? `#${id}` : `/teacher/projects#${id}`;
  return from === 'editor' ? `#${id}` : null;
}
