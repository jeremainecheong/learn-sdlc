import type {
  AnalyzerReport,
  CriterionScore,
  FeedbackCheck,
  MutationReport,
  PhaseRubric,
  PhaseStatus,
  RunResult,
} from '@learnsdlc/shared';
import { codeQualityScore, hintMarksLost } from '@learnsdlc/shared';
import type { FileRule } from '../content/content.types';
// Teacher-authored projects: the roll-up asks the one sole-task predicate and
// derives its own required set. Both are pure and database-free, and
// `feedback` already reads `content`, so this adds no new module dependency.
import type { CompiledTask } from '../content/pack-compiler';
import { requiredKeysOf, soleTaskList } from '../content/task-units';

export interface RuleOutcome {
  check: FeedbackCheck;
  criterion: string;
  required: boolean;
  passed: boolean;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Marks a criterion loses for each optional rule that failed. */
export const OPTIONAL_RULE_PENALTY = 15;

/** Marks the process criterion loses when the learner did not run the work before submitting. */
export const NO_RUN_PENALTY = 40;

/**
 * The reliance index at which a learner reads as leaning on the mentor. One
 * number for the learner's integrity note, the adaptive tier and the class
 * table, so the three always agree.
 */
export const RELIANCE_FLAG_THRESHOLD = 60;

/** The lowest average best score the adaptive tier's challenge accepts. */
export const TIER_CHALLENGE_MIN_SCORE = 85;

/** The highest reliance index the adaptive tier's challenge accepts. */
export const TIER_CHALLENGE_MAX_RELIANCE = 30;

/** An average best score below this puts a learner on the guided tier. */
export const TIER_GUIDED_BELOW_SCORE = 65;

/** How many consecutive words a mentor reply and an artefact must share to read as a paste. */
export const MENTOR_PASTE_WINDOW = 8;

/** Guided hints in a phase at which a first, unrun submission reads as no effort of the learner's own. */
export const NO_EFFORT_MIN_HINTS = 6;

/** The cap on the test criteria when the learner wrote too few tests. */
export const TOO_FEW_TESTS_CAP = 50;

/**
 * Evaluate a config phase's file rules, each over its own target.
 */
export function evaluateRules(
  rules: readonly FileRule[],
  contentFor: (target: string) => string,
): RuleOutcome[] {
  return rules.map((rule) => {
    const text = contentFor(rule.target);
    let passed: boolean;
    if (rule.forbidden) {
      passed = !new RegExp(rule.forbidden, rule.flags || '').test(text);
    } else {
      passed = new RegExp(rule.pattern || '', rule.flags || '').test(text);
    }
    return {
      criterion: rule.criterion,
      required: rule.required,
      passed,
      check: {
        id: rule.id,
        label: rule.label,
        status: passed ? 'passed' : rule.required ? 'failed' : 'warning',
        detail: passed ? 'Check passed.' : rule.failDetail,
      } as FeedbackCheck,
    };
  });
}

/**
 * Remove Python docstrings and whole-line comments so scaffold text never
 * counts as coverage. The authored test template names the behaviours the
 * learner must cover ("complete", "filter", "overdue") in its module
 * docstring; leaving that in would satisfy the keyword mapping with zero
 * tests written.
 */
export function stripPythonComments(source: string): string {
  return source
    .replace(/("""|''')[\s\S]*?\1/g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * Whether a language's source is read with the JavaScript rules.
 *
 * `typescript` is written in JavaScript's syntax and only ever reaches a
 * runner as JavaScript: esbuild strips the types in the parent before the
 * child starts. Everything here that reads a source file
 * therefore treats the two the same, and the alternative is the Python
 * branch, which reads a `.tsx` suite as zero tests and leaves its whole
 * scaffold standing.
 */
function readsAsJavaScript(language: string): boolean {
  return language === 'javascript' || language === 'typescript';
}

/** Strip comments for the given language so scaffolding never counts as work. */
export function stripCodeComments(source: string, language: string): string {
  if (readsAsJavaScript(language)) {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }
  return stripPythonComments(source);
}

/**
 * Criterion scores from rule outcomes: required rules average to the score,
 * failed optional rules subtract a penalty.
 */
export function scoreFromRules(
  rubric: PhaseRubric,
  outcomes: RuleOutcome[],
  extraPenalties: Record<string, number> = {},
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const criterion of rubric.criteria) {
    const mine = outcomes.filter((o) => o.criterion === criterion.key);
    const required = mine.filter((o) => o.required);
    const optionalFailed = mine.filter((o) => !o.required && !o.passed).length;
    if (mine.length === 0 && !(criterion.key in extraPenalties)) continue;
    const base = required.length
      ? (required.filter((o) => o.passed).length / required.length) * 100
      : 100;
    const penalty = optionalFailed * OPTIONAL_RULE_PENALTY + (extraPenalties[criterion.key] || 0);
    scores.set(criterion.key, clamp(base - penalty));
  }
  return scores;
}

/**
 * The rubric's code-quality criterion. The arithmetic lives in shared because
 * the Health tab in the editor shows the same number and says the same sums out
 * loud; two copies would be one edit from disagreeing.
 */
export function scoreCodeQuality(analysis: AnalyzerReport): number {
  return codeQualityScore(analysis);
}

export function scoreTests(run: RunResult | null): number {
  if (!run || !run.tests || run.tests.total === 0) return 0;
  return clamp((run.tests.passed / run.tests.total) * 100);
}

export function scoreProcess(ranBeforeSubmit: boolean, hintsThisPhase: number): number {
  let score = 100;
  if (!ranBeforeSubmit) score -= NO_RUN_PENALTY;
  // The same three numbers the mentor column shows a learner, imported rather
  // than written twice. The column says "the first ten cost nothing, then
  // three each, down to a floor of thirty"; this is where that sentence is
  // enforced, and there is one place to change it.
  score -= hintMarksLost(hintsThisPhase);
  return clamp(score);
}

export function scoreMutation(mutation: MutationReport | null): number {
  if (!mutation || mutation.total === 0) return 0;
  return clamp((mutation.killed / mutation.total) * 100);
}

/**
 * AI-reliance index for a phase: hints dominate when they outnumber the
 * learner's own submit/iterate actions. 0 = fully self-directed.
 */
export function relianceIndex(hints: number, attempts: number): number {
  if (hints === 0) return 0;
  return Math.round((100 * hints) / (hints + 2 * attempts + 1));
}

export function assembleCriteria(
  rubric: PhaseRubric,
  scores: Map<string, number>,
  evidence: Map<string, string[]>,
): CriterionScore[] {
  return rubric.criteria.map((criterion) => ({
    key: criterion.key,
    title: criterion.title,
    weight: criterion.weight,
    score: scores.get(criterion.key) ?? 0,
    evidence: evidence.get(criterion.key) ?? [],
  }));
}

export function overallScore(criteria: CriterionScore[]): number {
  const total = criteria.reduce((sum, c) => sum + c.score * c.weight, 0);
  return clamp(total);
}

/**
 * Count the tests in one file: `def test_*` for Python, `test(`/`it(` for the
 * JavaScript family. A testing phase's `minTests` is the pack's one number
 * over the whole suite, so a front-end file counted with the Python rule
 * returns zero and the learner is told to write tests they have written.
 */
export function countTestMethods(source: string, language = 'python'): number {
  if (readsAsJavaScript(language)) {
    return (source.match(/\b(test|it)\s*\(/g) || []).length;
  }
  return (source.match(/^\s*def test_\w+/gm) || []).length;
}

/* ----------------------------- phase status ------------------------------ */

/**
 * Where a graded submission moves the phase. Grading runs asynchronously, so
 * by the time a result lands the phase may already be passed (keep it) or
 * locked again (an instructor reset, a re-delivered job for a phase the
 * learner never unlocked): a failed rubric must never unlock a locked phase
 * by stamping it 'submitted', and nothing here may un-pass a phase.
 */
export function nextPhaseStatus(current: PhaseStatus, passed: boolean): PhaseStatus {
  if (current === 'locked' || current === 'passed') return current;
  return passed ? 'passed' : 'submitted';
}

/* ------------------------------ the roll-up ------------------------------- */

/**
 * The columns a verdict may move on a phase state: exactly the three every
 * writer of a phase's status writes, and nothing else. `attempts` is
 * deliberately absent: it is spent and refunded in SQL and is never derived.
 */
export interface PhaseRollup {
  status: PhaseStatus;
  passedAt: string | null;
  bestScore: number | null;
}

/** The three columns the roll-up reads off the phase state it is moving. */
export type HeldPhaseState = PhaseRollup;

/** One task's row, as the roll-up and the door read it. Structural on purpose. */
export interface HeldTaskState {
  taskKey: string;
  status: PhaseStatus;
  passedAt: string | null;
  bestScore: number | null;
}

/** The columns a verdict may move on one task's row. */
export interface TaskRollup {
  status: PhaseStatus;
  passedAt: string | null;
  bestScore: number | null;
  awaitingSignOff: boolean;
}

/**
 * Where a graded verdict moves ONE task: `nextPhaseStatus` plus the one thing a
 * task has that a phase does not.
 *
 * A task the pack marks `signOff` is **not passed by a verdict**. The verdict
 * is what makes it *ready*: the evidence is in and a teacher's countersignature
 * is the remaining half, so until that lands the task reads `submitted`, which
 * is the status the whole platform already uses for "graded, not through".
 * Writing it `passed` **and** `awaitingSignOff` at one instant would give three
 * readers (the door, the roll-up and `advance`) three different meanings for
 * one word on one row. With the sign-off inside the transition instead, all
 * three read `status === 'passed'` and all three mean the same thing by
 * construction.
 */
export function taskRollup(
  held: Pick<TaskRollup, 'status' | 'passedAt' | 'bestScore'>,
  task: { signOff: boolean },
  verdict: { passed: boolean; overall: number },
  now: string,
): TaskRollup {
  const earned = verdict.passed && !task.signOff;
  const status = nextPhaseStatus(held.status, earned);
  return {
    status,
    passedAt: status === 'passed' && held.status !== 'passed' ? now : held.passedAt,
    bestScore: Math.max(held.bestScore ?? 0, verdict.overall),
    awaitingSignOff: task.signOff && verdict.passed && held.status !== 'passed',
  };
}

/**
 * Where a graded task's verdict moves its phase.
 *
 * `tasks` is the **enrolment's pinned version's** compiled list, and the
 * required set is derived from it inside this function so that no caller can
 * hand it a set derived from the rows, which is the one thing the naive form
 * of this function got wrong. `states` is whatever `task_states` rows exist,
 * and a required key with no row is a key that has not passed.
 *
 * `locked` and `passed` stay sticky, so `nextPhaseStatus`' own comment:
 * nothing here may un-pass a phase: is obeyed rather than worked around.
 *
 * Structural parameter types, so this file stays free of entities and the
 * graders, the regrade, the instructor override, the cohort import and
 * `advance` can all call the one function.
 */
export function phaseRollup(
  held: HeldPhaseState,
  tasks: readonly CompiledTask[],
  states: readonly HeldTaskState[],
  verdict: { passed: boolean; overall: number },
  now: string,
): PhaseRollup {
  const requiredKeys = requiredKeysOf(tasks);

  // A sole-task phase's roll-up IS `nextPhaseStatus`, with the same two
  // arguments and the same `bestScore` expression the phase-level writers
  // use. The branch is not an optimisation, it is the proof that the shipped
  // project decides exactly as `nextPhaseStatus` does, and it reads no task
  // row at all, because a sole task has none.
  if (soleTaskList(tasks)) {
    const status = nextPhaseStatus(held.status, verdict.passed);
    return {
      status,
      passedAt: status === 'passed' && held.status !== 'passed' ? now : held.passedAt,
      bestScore: Math.max(held.bestScore ?? 0, verdict.overall),
    };
  }

  if (held.status === 'locked') {
    return { status: 'locked', passedAt: held.passedAt, bestScore: held.bestScore };
  }

  const byKey = new Map(states.map((state) => [state.taskKey, state]));
  // THE FIX: quantified over the required KEYS, not over the rows handed in.
  // A missing row is a failing row, and `requiredKeys.size > 0` makes a set
  // that somehow came back empty read shut, which is the direction a doubt
  // must fall. The compiler already refuses a phase with no required task, so
  // that conjunct is belt and braces rather than a case anyone can author.
  const allPassed =
    requiredKeys.size > 0 &&
    [...requiredKeys].every((key) => byKey.get(key)?.status === 'passed');
  const opened = held.status === 'passed' || allPassed;

  const passedAts = [...requiredKeys]
    .map((key) => byKey.get(key)?.passedAt)
    .filter((at): at is string => !!at);
  const scores = [...requiredKeys].map((key) => byKey.get(key)?.bestScore ?? 0);

  return {
    status: opened ? 'passed' : 'submitted',
    passedAt: opened
      ? (held.passedAt ?? (passedAts.length ? passedAts.slice().sort().at(-1)! : now))
      : held.passedAt,
    // The mean over the REQUIRED keys, and monotonic on purpose: an optional
    // task moves no phase score, and a concurrent pair cannot write a mean that
    // goes backwards.
    bestScore: Math.max(
      held.bestScore ?? 0,
      scores.reduce((sum, score) => sum + score, 0) / Math.max(1, requiredKeys.size),
    ),
  };
}

/* ------------------------------ dockerfile ------------------------------- */

const INTERPRETERS = new Set(['python', 'python3', 'node']);

/** A workspace script the smoke run may start: a Python or JavaScript file. */
const SCRIPT_FILE = /\.(py|js)$/;

/**
 * An argv word that is a path outside the sandbox workspace: absolute, home
 * relative, or climbing out with `..`. The runner executes the argv verbatim,
 * so nothing here may address the host filesystem.
 */
function escapesWorkspace(word: string): boolean {
  if (word.startsWith('/') || word.startsWith('~') || /^[A-Za-z]:[\\/]/.test(word)) return true;
  return word.split(/[\\/]/).includes('..');
}

/** Split a Dockerfile instruction's arguments: exec form (JSON array) or shell form. */
function dockerArgs(raw: string): string[] | null {
  const text = raw.trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) && parsed.every((a) => typeof a === 'string') ? parsed : null;
    } catch {
      return null;
    }
  }
  return text.split(/\s+/).filter(Boolean);
}

export interface DockerEntrypoint {
  /** The argv the container starts with (ENTRYPOINT + CMD, Docker semantics). */
  argv: string[];
  /** Why no runnable argv could be derived; set only when `argv` is empty. */
  problem?: string;
}

/**
 * Derive what `docker run <image>` would execute from the learner's
 * Dockerfile: ENTRYPOINT with CMD as default arguments, or CMD alone. Paths
 * under WORKDIR are made relative so the same argv runs in the sandbox
 * workspace.
 *
 * The runner executes this argv verbatim, so the whole of it is validated,
 * not just the launcher: an interpreter word from the allowlist, then a
 * workspace-relative script that the job actually ships, then plain arguments
 * for that script. `python -c`, `node -e`, `python -m http.server`, a bare
 * `-` reading the program from stdin, and any path that leaves the workspace
 * are all refused: accepting them turned the deployment phase into a shell
 * on the machine hosting the class, with the output handed back to the
 * learner. `files`, when given, is the job's workspace: the script must be one
 * of its files, so an entrypoint can only start code the pack shipped or the
 * learner was invited to edit.
 */
export function dockerEntrypoint(
  dockerfile: string,
  files?: Record<string, string>,
): DockerEntrypoint {
  // Backslash continuations join the next line, as Docker itself reads them.
  const logical = dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  let workdir = '';
  let entrypoint: string[] | null = null;
  let cmd: string[] | null = null;
  for (const line of logical) {
    const m = line.match(/^\s*(WORKDIR|ENTRYPOINT|CMD)\s+(.+?)\s*$/i);
    if (!m) continue;
    const [, keyword, rest] = m;
    if (keyword.toUpperCase() === 'WORKDIR') workdir = rest.trim().replace(/\/+$/, '');
    else if (keyword.toUpperCase() === 'ENTRYPOINT') entrypoint = dockerArgs(rest);
    else cmd = dockerArgs(rest);
  }
  if (!entrypoint && !cmd) {
    return { argv: [], problem: 'the Dockerfile has no ENTRYPOINT or CMD, so the container has nothing to start' };
  }
  const argv = entrypoint ? [...entrypoint, ...(cmd || [])] : cmd || [];
  const relative = argv.map((a) =>
    workdir && a.startsWith(`${workdir}/`) ? a.slice(workdir.length + 1) : a,
  );
  const launcher = relative[0] || '';
  if (!INTERPRETERS.has(launcher)) {
    return {
      argv: [],
      problem: `the container starts with "${launcher}" — the smoke run expects the CLI launched through python or node`,
    };
  }
  const script = relative[1] || '';
  if (!script || !SCRIPT_FILE.test(script) || escapesWorkspace(script)) {
    return {
      argv: [],
      problem: script
        ? `the container starts ${launcher} with "${script}" — the smoke run expects a .py or .js file inside the working directory`
        : `the container starts ${launcher} with no script — name the CLI file the container should run`,
    };
  }
  if (files && files[script] === undefined) {
    return {
      argv: [],
      problem: `the container starts "${script}", which is not one of this phase's files — check the path against the working directory you set`,
    };
  }
  const stray = relative.slice(2).find((a) => escapesWorkspace(a));
  if (stray) {
    return {
      argv: [],
      problem: `the container passes "${stray}" to the CLI — the smoke run only passes arguments from inside the working directory`,
    };
  }
  return { argv: relative };
}

/**
 * Rewrite the authored smoke commands to start the way the learner's
 * container does: keep each command's CLI arguments (everything after the
 * script file) and start them through the Dockerfile's own launcher. This is
 * what makes the build check depend on the learner's Dockerfile rather than a
 * fixed command.
 *
 * Only the launcher (interpreter and script) is taken from the Dockerfile.
 * Anything after the script there is the container's *default* arguments,
 * which `docker run <image> add "Ship the release"` replaces, so a learner who
 * writes `CMD ["--help"]` beside a correct ENTRYPOINT still gets a smoke run
 * of the arguments the pack authored rather than a mangled argv.
 */
export function smokeArgvFor(entrypoint: string[], authored: string[][]): string[][] {
  const at = entrypoint.findIndex((a) => SCRIPT_FILE.test(a));
  const launcher = at >= 0 ? entrypoint.slice(0, at + 1) : entrypoint;
  return authored.map((command) => {
    const script = command.findIndex((a) => SCRIPT_FILE.test(a));
    const args = script >= 0 ? command.slice(script + 1) : command;
    return [...launcher, ...args];
  });
}

/* ------------------------------ adaptivity ------------------------------- */

export type DifficultyTier = 'guided' | 'standard' | 'challenge';

/**
 * Adaptive difficulty: choose the scaffolding tier from the learner's
 * track record so support fades as mastery grows. A learner who scores high
 * with little AI reliance gets terser, deeper hints ('challenge'); one who is
 * struggling or over-relying gets fuller guidance ('guided').
 */
export function difficultyTier(
  averageBestScore: number | null,
  relianceIndex: number,
  phasesPassed: number,
): DifficultyTier {
  if (phasesPassed === 0 || averageBestScore === null) return 'standard';
  if (averageBestScore >= TIER_CHALLENGE_MIN_SCORE && relianceIndex <= TIER_CHALLENGE_MAX_RELIANCE) return 'challenge';
  if (averageBestScore < TIER_GUIDED_BELOW_SCORE || relianceIndex >= RELIANCE_FLAG_THRESHOLD) return 'guided';
  return 'standard';
}

/** How many progressive-hint steps to skip for a tier (fading scaffolding). */
export function tierHintOffset(tier: DifficultyTier): number {
  return tier === 'challenge' ? 1 : 0;
}

/* ------------------------------- integrity ------------------------------- */

function shingles(text: string, n: number): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/**
 * Detect whether an artefact reproduces a substantial verbatim run from any
 * mentor reply: a paste of the assistant's words into the learner's own work.
 * Uses n-gram (shingle) overlap so paraphrase and short shared phrases don't
 * trip it; a run of `n` consecutive words in common is the signal.
 *
 * `given` is everything the pack itself handed the learner: the task panel, the
 * brief, the backlog, the locked files and the scaffolds. A run of words that
 * is already in front of them is not evidence that they took it from the
 * mentor, and the mentor's hints quote the pack's own vocabulary on purpose,
 * so without this the detector fires on the learner who correctly restates the
 * customer's own acceptance criterion. Measured on the seeded class: 16 of 25
 * learners flagged, on phrases like "most overdue first, then higher priority,
 * then id", which is the ordering rule the customer gave them.
 */
export function detectMentorPaste(
  artifact: string,
  mentorTexts: string[],
  n = MENTOR_PASTE_WINDOW,
  given: string[] = [],
): boolean {
  const artShingles = shingles(artifact, n);
  if (artShingles.size === 0) return false;
  const handed = new Set<string>();
  for (const source of given) for (const shingle of shingles(source, n)) handed.add(shingle);
  for (const reply of mentorTexts) {
    for (const shingle of shingles(reply, n)) {
      if (artShingles.has(shingle) && !handed.has(shingle)) return true;
    }
  }
  return false;
}
