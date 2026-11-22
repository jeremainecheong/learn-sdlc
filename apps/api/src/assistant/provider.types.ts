import type {
  AiRubricReview,
  CriterionScore,
  FeedbackCheck,
  MentorMemoryView,
} from '@learnsdlc/shared';
import { PhaseContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';
import type { PhaseScope, TaskScope } from './project-scope';

export interface MentorSignals {
  /** Names of learner functions still stubbed with TODO/NotImplementedError. */
  todosRemaining: string[];
  /** Labels of checks that failed on the latest submission. */
  lastFailedChecks: string[];
}

/**
 * The failing test one "explain this failure" turn is about.
 *
 * Everything in here came out of the learner's own workspace or out of the
 * runner, so every line of it rides inside the LEARNER_DATA fence in the user
 * turn, never in a system message. What is deliberately absent is as much of
 * the design as what is present: no traceback, no frame list, and never the
 * hidden test's own source. The mentor is told the name, the first line of the
 * assertion, where it landed and the learner's code around it, and nothing
 * else could help it teach.
 */
export interface FailingTestContext {
  /** The case's own name, as the runner reported it. */
  name: string;
  /** True when it is from the hidden suite: the mentor is told that, never its body. */
  hidden: boolean;
  /** The first line of the assertion, capped at 160 characters. */
  assertion: string;
  /** The learner's own file the deepest frame landed in, or null. */
  path: string | null;
  line: number | null;
  /** That file around the frame, at most 25 lines and 2000 characters, or ''. */
  excerpt: string;
}

export interface MentorContext {
  phase: PhaseContent;
  message: string;
  /** Current editable learner files, never hidden tests or reference solutions. */
  workspace?: Record<string, string>;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Prior user messages in this phase (0-based progression). */
  interactionCount: number;
  /** Per-topic prior use counts, keyed by topic index. */
  topicUseCounts: Record<number, number>;
  signals: MentorSignals;
  /** Adaptive difficulty: steps of scaffolding to fade (0 = full). */
  difficultyOffset?: number;
  /**
   * What the mentor carries out of the phases this learner has finished
   * Derived from their own artefacts, so it is learner data:
   * it goes inside the LEARNER_DATA fence in the user turn, never in a
   * system message.
   */
  memory?: MentorMemoryView | null;
  /**
   * Notes this class's instructor wrote for the mentor to quote, at most two
   * Instructor-authored, so these do belong in the system
   * message, inside their own markers, and under the hard rules.
   */
  instructorNotes?: string[];
  /**
   * The failing test this turn is about. Present only for the
   * explain route: it changes the cache key, it is the whole subject of the
   * offline answer, and it rides inside the LEARNER_DATA fence because every
   * line of it came out of the learner's workspace or the runner.
   */
  failingTest?: FailingTestContext;
  /**
   * Whose content this turn is about: TaskTrackr's, or
   * a teacher's. `AssistantService.chat` resolves it from the phase **before**
   * the lesson wrap and from the pinned version's task list. Only a scope
   * `project-scope.ts` minted is honoured; absent (or a look-alike), the
   * composers resolve `phaseScopeOf(phase)`, which fails safe to the neutral
   * prompts.
   */
  scope?: PhaseScope;
}

export interface ProviderReply {
  content: string;
  tokensIn: number;
  tokensOut: number;
  provider: string;
}

export interface ReviewInput {
  /** Exact editable source captured when the learner submitted. */
  workspace?: Record<string, string>;
  criteria: CriterionScore[];
  checks: FeedbackCheck[];
  overall: number;
  hints: number;
  ranBeforeSubmit: boolean;
  /**
   * The task this review is about (teacher-authored projects).
   *
   * The gate compares the review's `criteriaEvidence` against the **task's**
   * criteria, exactly and by key, so the review must be assembled from the
   * task, not the phase; otherwise the arithmetic does not close and no
   * authored task could ever pass, and a teacher-authored task's rubric is
   * derived from its own rules, so it can differ from its phase's on a phase
   * holding a single task.
   *
   * Everything the provider reads about the task is reachable from here:
   * `task.rubric` is the rubric the evidence is counted against,
   * `task.brief` is the trusted brief, `task.owns` is the set a criterion may
   * cite, and `checksOf(phase, task)` is the slice the structural facts are
   * built from.
   *
   * **Optional, and absent means the phase.** Every expression it replaces
   * falls back to the phase's own, so a caller that names no task, the
   * offline reviewer, a replay, a phase-level spec, gets the phase's
   * message, word for word. For a phase whose compiled
   * list is the synthesised sole task the two are the same object: `rubric`
   * *is* `phase.rubric`, `brief` *is* `phase.taskPanel`, `owns` *is* every
   * editable path, and `checksOf` answers `phase.checks`.
   */
  task?: CompiledTask;
  /**
   * The phase's whole task list, the one the grader already holds.
   * It decides which task the web routes to the phase's own room, so an
   * authored task is told the interface it is really worked in. Absent means
   * `[task]`.
   */
  phaseTasks?: readonly CompiledTask[];
  /**
   * An explicit scope, used before any resolution. Only one `project-scope.ts`
   * minted is honoured (the reference scope, for a spec that pins TaskTrackr's
   * wording on a synthetic phase); otherwise the composer resolves
   * `taskScopeOf(phase, task, phaseTasks)`.
   */
  scope?: TaskScope;
}

export interface AiProvider {
  readonly name: string;
  chat(ctx: MentorContext): Promise<ProviderReply>;
  review(phase: PhaseContent, input: ReviewInput): Promise<AiRubricReview>;
}

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));
