import {
  ARTEFACT_PATH_CHECK_ID,
  BUDGET_CEILING,
  budgetCeilingRefusal,
  MULTI_TASK_CHECK_ID,
  applicationPhasesSentence,
  REQUIRED_TASK_CHECK_ID,
  SUPPORTED_STACK_CHECK_ID,
  duplicateArtefactPathRefusal,
  multiTaskPublishRefusal,
  noRequiredTaskRefusal,
  refusesMultiTaskPublish,
  summariseValidation,
  unsupportedLibraryRefusal,
} from '@learnsdlc/shared';
import type {
  ArtifactKind,
  PhaseKey,
  QuizChecks,
  SupportedStacks,
  ValidationCheck,
  ValidationReport,
} from '@learnsdlc/shared';
import type { ProjectContent, RuntimeSpec } from '../content/content.types';
import type { RawPackManifest, RawPhase } from './upload-limits';
import { hasCurrentDeepReceipt } from './deep-validation';
import type { ProjectVersionEntity } from '../content/project.entities';
import { SCREEN_CONTRACT_PATH } from '../content/screen-copy';
import { unsupportedPackages } from './runtime-stacks';

/**
 * The fast tier: everything a teacher can be told about a draft without
 * starting a microVM.
 *
 * One property decides whether this file is worth having: on a
 * `failed` row the sentence is **word for word** the sentence publish refuses
 * with. A teacher who reads one wording while drafting and another at the door
 * learns that the editor is a guess, and then stops reading it. So every
 * failing row here is built from the same exported refusal the service throws,
 * and the report is only ever assembled through `summariseValidation`, so
 * `publishable` and `blocking` cannot disagree.
 *
 * `not-applicable` is a neutral state and not a near-miss. A project with no
 * application has nothing for the sandbox proofs to prove, and eighteen grey
 * rows is a worse first impression than one collapsed line, which is what
 * `notApplicableLine` is for, and why a project that *does* have an application
 * gets no row for them at all rather than a grey one.
 */

/** The compile's own row. Add ids, never rename them. */
export const COMPILE_CHECK_ID = 'version-compiles';

/**
 * The eight `sandbox: true` proofs (the ids of the checks table in `cli/content-check-engine.ts`). The fast
 * tier never runs one; it reports the ones this project has nothing to prove
 * for, so a markdown-only project reads one collapsed line instead of eight
 * red rows about an application it does not have.
 */
export const DEEP_TIER_CHECK_IDS = [
  'solution-passes-hidden',
  'stub-fails-hidden',
  'front-end-suite-runs',
  'reference-passes-impl',
  'mutants-die',
  'drill-breaks-smoke',
  'forged-entrypoint-refused',
  'preview-starts',
] as const;

export type DeepTierCheckId = (typeof DEEP_TIER_CHECK_IDS)[number];

/** What each deep proof needs a project to have before it means anything. */
const DEEP_TIER_NEEDS: Record<DeepTierCheckId, { label: string; needs: string }> = {
  'solution-passes-hidden': { label: 'The shipped solution passes the hidden suite', needs: 'code phase' },
  'stub-fails-hidden': { label: 'The stubs fail the hidden suite', needs: 'code phase' },
  'front-end-suite-runs': { label: "The front end's own suite runs", needs: 'front end to build' },
  'reference-passes-impl': { label: 'The reference suite passes the reference implementation', needs: 'tests phase' },
  'mutants-die': { label: 'Every mutant is killed', needs: 'tests phase' },
  'drill-breaks-smoke': { label: 'The incident drill breaks the smoke run', needs: 'deployment drill' },
  'forged-entrypoint-refused': { label: 'A forged entry point is refused', needs: 'config phase' },
  'preview-starts': { label: 'The live preview starts', needs: 'preview to start' },
};

/**
 * The four fast-tier ids a quiz adds. **Appended, never renamed**: an id is
 * the handle a stored report is read back by.
 *
 * None of them has a compiler twin, and that is deliberate: every one is a
 * question about a quiz's own fields, which the compiler cannot ask without
 * the teacher's authored shape in front of it. They still refuse a publish,
 * because publish reads `report.publishable`.
 */
export const QUIZ_QUESTIONS_CHECK_ID = 'quiz-questions-well-formed';
export const QUIZ_DRAW_CHECK_ID = 'quiz-draw-fits-pool';
export const QUIZ_PASS_MARK_CHECK_ID = 'quiz-pass-mark-reachable';
export const QUIZ_RETAKE_CHECK_ID = 'quiz-retake-is-a-new-paper';

/**
 * The reveal is an optional quiz's choice only.
 * A row only for a quiz that carries `revealExplanation`, so a quiz without
 * the choice draws no row; a failed row blocks the
 * publish of a quiz that was made required after the choice was written.
 */
export const QUIZ_REVEAL_CHECK_ID = 'quiz-reveal-optional-only';

/**
 * The one sentence `quiz-reveal-optional-only` refuses with, at the route and
 * in the report alike, so a teacher reads one wording for one rule.
 */
export function quizRevealOptionalOnlyRefusal(title: string): string {
  return (
    `${title} is required, and only an optional quiz chooses when its explanations are shown; a required quiz ` +
    'shows them after a pass or once its attempts run out, so mark it optional or remove the choice.'
  );
}

/**
 * A version whose later phases read the accepted screen
 * copy must keep a Design task that owns the screen contract.
 */
export const SCREEN_CONTRACT_OWNER_CHECK_ID = 'screen-contract-has-an-owner';

/**
 * The one sentence publish refuses with when no Design task owns
 * `shared/contract/screens.json` while a later phase reads the copy a passing
 * Design submission leaves there. Removing the inherited Design task takes the
 * file with it, and the advance out of Design then refuses every learner.
 */
export function screenContractOwnerRefusal(designTitle: string, laterTitle: string): string {
  return `Keep the ${designTitle} task you copied beside your own: ${laterTitle} reads the screen copy a passing ${designTitle} submission leaves in ${SCREEN_CONTRACT_PATH}, so with no task owning that file no learner could ever leave ${designTitle}.`;
}

/**
 * The owner is there but optional. The Design gate opens
 * on the required tasks alone, so the phase reads passed while the advance
 * still waits on a pass of the optional owner. One sentence, the fix first.
 */
export function optionalScreenContractOwnerRefusal(designTitle: string, laterTitle: string): string {
  return `Make the ${designTitle} task that owns ${SCREEN_CONTRACT_PATH} required: ${laterTitle} reads the screen copy its passing submission leaves there, so while it is optional a learner could pass ${designTitle} and still never leave it.`;
}

/**
 * No Design task owns the screen contract. The advance does not refuse
 * (with no owner there is no copy to carry, so the later
 * phases mount the pack's own baseline) and the row says so as a note (a
 * `passed` row). `referenceName` is the registry's name for the project
 * the application phases come from.
 */
export function screenContractBaselineNote(designTitle: string, laterTitle: string, referenceName: string): string {
  return `No ${designTitle} task owns ${SCREEN_CONTRACT_PATH}, so ${laterTitle} shows ${referenceName}'s own screen copy.`;
}

/**
 * The owner is optional and is not the reference's own
 * task by its anchor. Its learners advance whether or not they passed it: a
 * passing submission's copy is carried, and without one the baseline mounts.
 */
export function optionalScreenContractBaselineNote(designTitle: string, laterTitle: string, referenceName: string): string {
  return `The ${designTitle} task that owns ${SCREEN_CONTRACT_PATH} is optional, so ${laterTitle} shows ${referenceName}'s own screen copy unless a passing submission of it supplies one.`;
}

/* ------------- the rows a teacher's own scenario adds ------------- */

// Never renamed: stored reports hold these ids. A warning or a note in this tier is a
// `passed` row whose sentence says the thing; only a `failed` row blocks.
export const INTERVIEW_WELL_FORMED_CHECK_ID = 'interview-well-formed';
export const INTERVIEW_SEALED_ROW_CHECK_ID = 'interview-sealed-row-matches';
export const BACKLOG_ONE_DOCUMENT_CHECK_ID = 'provided-backlog-one-document';
export const BACKLOG_SHAPE_CHECK_ID = 'provided-backlog-shape';
export const BRIEF_NAMES_STAKEHOLDER_CHECK_ID = 'brief-names-the-stakeholder';
export const BRIEF_NAMES_REMOVED_STAKEHOLDER_CHECK_ID = 'brief-names-a-removed-stakeholder';
export const SCENARIO_ONE_PROJECT_CHECK_ID = 'scenario-is-one-project';
export const INHERITED_TASK_SCENARIO_CHECK_ID = 'inherited-task-matches-scenario';
/**
 * The note that the last four phases are the reference project's application
 * (the `application-is-…` row). Its id names no project: the name is in the
 * sentence, from the registry.
 */
export const APPLICATION_CHECK_ID = 'application-is-the-reference';

/** One written phase, as the scenario rows read it. */
export interface ScenarioPhaseInput {
  key: PhaseKey;
  title: string;
  /** The intro, interview or a read-only document is no longer the reference's. */
  scenarioOwn: boolean;
  /** Anything in the phase is the teacher's: the scenario, or a task that is not the reference's. */
  teachers: boolean;
  /** The inherited task, where it is still the reference's by its own anchor. */
  inheritedReference: { taskKey: string; title: string } | null;
}

/**
 * What the service knows about a draft's scenario, for the rows above. A
 * caller that omits it draws none of them.
 */
export interface ScenarioValidationInput {
  /** The reference project's name, from its registry title (never a slug). */
  referenceName: string;
  /** One per phase holding an interview or an interview row. */
  interviews: {
    key: PhaseKey;
    title: string;
    present: boolean;
    facts: number;
    /** The content loader's own sentence, when it refuses the brief. */
    refusal: string | null;
    sealedRows: number;
    sealedMatches: boolean;
  }[];
  /** Each read-only document more than one written phase mounts. */
  documents: { path: string; phases: { key: PhaseKey; title: string }[]; sameBytes: boolean }[];
  /** The provided backlog, while a task still owns the room's story record. */
  backlog: { key: PhaseKey; title: string; path: string; stories: number; missing: string | null } | null;
  /** Written tasks that are not the reference's and whose brief does not name the stakeholder in full. */
  unnamedStakeholder: { key: PhaseKey; taskKey: string; title: string; persona: string }[];
  /** Kept tasks whose brief names a reference stakeholder this version no longer has. */
  removedStakeholder: { key: PhaseKey; taskKey: string; title: string; name: string }[];
  writtenPhases: ScenarioPhaseInput[];
  /** Whether any application phase still runs the reference's application. */
  application: boolean;
}

/** The record id the room's consistency check reads, which a kept inherited room task still grades. */
const ROOM_RECORD_STORY_ID = 'US-4';

export interface ValidationTaskInput {
  taskKey: string;
  title: string;
  required: boolean;
  artefactPath: string | null;
  /**
   * What scores this task, where the caller knows it.
   *
   * Absent reads as the phase's own kind, which is the same as counting every
   * task. It is
   * here because the gate below counts the tasks the wall counts (the
   * **non-quiz** ones) and a task list with no kinds on it cannot tell them
   * apart: a quiz's `artefactPath` is null, and so is an inherited `code`
   * task's.
   */
  checkKind?: ArtifactKind;
  /** The quiz this task is, where it is one. Never carried for another kind. */
  quiz?: QuizChecks;
  /**
   * The workspace paths the task owns, where the caller knows them.
   * A caller that omits it draws no row.
   */
  owns?: string[];
  /**
   * Whether the task is the reference's own by its task
   * anchor alone (`isReferenceTaskAnchor`), where the caller knows it. Absent
   * reads as yes, which keeps the stricter refusals for a caller that omits it.
   */
  anchorReference?: boolean;
}

export interface ValidationPhaseInput {
  key: PhaseKey;
  title: string;
  /** The kind that scores the phase's own tasks, which decides what applies. */
  checkKind: ArtifactKind;
  hasDrill: boolean;
  tasks: ValidationTaskInput[];
  /** Whether the phase mounts the accepted Design screen copy. Absent reads as no. */
  readsScreenCopy?: boolean;
}

/* ---------------- the publish arm's rows ---------------- */

/** Appended, never renamed: a stored report is read back by these ids. */
export const BUDGET_CEILING_CHECK_ID = 'budget-within-ceiling';
export const RUNTIME_PROFILE_CHECK_ID = 'runtime-in-profile';
export const RUN_SHAPES_CHECK_ID = 'runs-are-closed-shapes';
export const DEEP_RECEIPT_CHECK_ID = 'deep-validation-current';

/** One package of a version's runtime block the baked profile cannot run (`runtimeProfileRefusals`). */
export interface RuntimeProfileFinding {
  package: string;
  ecosystem: string;
  reason: 'not-in-profile' | 'pin-form';
}

/** What the publish arm needs to know about a draft's executable side. Absent draws none of its rows. */
export interface ExecutableValidationInput {
  /** microVMs one full pass boots, per phase, priced by the compiler's own `sandboxBudgetFor`. */
  budget: { key: PhaseKey; title: string; microVMs: number }[];
  runtime: RuntimeProfileFinding[];
  /**
   * The runtime profile's reader threw (a missing runtime lock, or content packs
   * that disagree on a baked version), so the runtime could not be measured
   * against the profile. A refusal by sentence, never a 500. Absent reads as no.
   */
  runtimeUnreadable?: boolean;
  /** The upload's `checkPackRuns` + `checkRunLimits`, re-run over the version. */
  runShapes: { code: string; where: string; sentence: string }[];
  /** Every code, tests or config phase: is it the reference project's, and is its deep receipt current. */
  phases: { key: PhaseKey; title: string; reference: boolean; deepCurrent: boolean }[];
  /**
   * Whether this report is the publish's own. The deep receipt is a condition
   * *of publishing*: on a draft it is a
   * warning in exactly the words the publish refuses with, so a fresh
   * upload validates clean and the teacher reads the door's sentence early.
   * The ceiling, the profile and the run shapes are defects of the draft and
   * fail in both.
   */
  publishing: boolean;
  /**
   * Whether the draft never had the reference project's application: an upload
   * (`origin: 'upload'`), or any draft none of whose application phases is the
   * reference application (a copy of an upload). Words only: its deep-receipt
   * sentence does not say it is not that application. Absent reads as no.
   */
  uploaded?: boolean;
}

/** Printable, short, no trailing stop: a name a teacher typed, said back. */
function said(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '').slice(0, 80).replace(/[.\s]+$/, '');
}

export function runtimeProfileRefusal(finding: RuntimeProfileFinding): string {
  const name = said(finding.package) || 'a package';
  const where = finding.ecosystem === 'runtime' ? '' : `${said(finding.ecosystem)} `;
  return finding.reason === 'pin-form'
    ? `This version's runtime pins the ${where}package "${name}" in a form the runtime profile this deployment runs does not accept, so it cannot be published. Pin it exactly, at a version the profile holds.`
    : `This version's runtime asks for the ${where}package "${name}", which is outside the runtime profile this deployment runs, so it cannot be published. Remove it, or use one the profile holds.`;
}

/**
 * What a teacher reads when this deployment cannot read its own
 * runtime profile. Fixed words: it quotes no archive byte, no path and no
 * reader message (those name host files); the reason goes to the server log.
 */
export const RUNTIME_PROFILE_UNREADABLE =
  "This deployment could not read the runtime profile it runs, so it cannot check this version's runtime against it, and the version cannot be published until it can. Nothing in the project needs to change: try again later, or tell the platform's administrator.";

export function deepReceiptRefusal(phaseTitle: string, { uploaded = false }: { uploaded?: boolean } = {}): string {
  // A copy of the reference project whose application changed is told why it
  // needs a receipt; an uploaded project never had the reference's application,
  // so saying it is not that application tells its teacher nothing.
  return uploaded
    ? `${phaseTitle} has no current deep validation. Run deep validation on this draft and publish once it passes.`
    : `${phaseTitle} is not the reference project's application as it shipped, and it has no current deep validation. Run deep validation on this draft and publish once it passes.`;
}


/**
 * A compiled version in the raw shape the upload's run-shape rule reads, so
 * publish asks the version the same question the upload asked the archive.
 *
 * The loader has already dropped every key it does not know, so what is left
 * is exactly what the runner will be handed: each test run's language,
 * harness, transform and (for a code run) its hidden harness and sealed
 * suite; each smoke argv beside the files it may run; the preview's argv.
 * "A script this pack ships" is a workspace path some phase (or the warm-up)
 * mounts, which is what the runner can find on disk.
 */
export function rawPackManifestOf(content: ProjectContent): RawPackManifest {
  // A script the pack ships is a file no learner can edit: locked wherever it
  // is mounted (upload holds argv to `canonical/`; a learner-editable file
  // never runs as a preview or a smoke here either).
  const shipped = new Set<string>();
  const editable = new Set<string>();
  for (const phase of content.phases) {
    for (const file of phase.files) (file.editable ? editable : shipped).add(file.path);
  }
  for (const file of content.warmup?.files ?? []) (file.editable ? editable : shipped).add(file.path);
  for (const at of editable) shipped.delete(at);
  const phases: RawPhase[] = content.phases.map((phase) => {
    const checks = phase.checks;
    const hiddenTestFiles: Record<string, string[]> = {};
    let raw: Record<string, unknown> = { kind: checks.kind };
    if (checks.kind === 'code' || checks.kind === 'tests') {
      raw = {
        kind: checks.kind,
        runs: checks.runs.map((run) => {
          const out: Record<string, unknown> = { id: run.id, language: run.language, harness: run.harness, transform: run.transform };
          if (checks.kind === 'code') {
            out.hiddenHarness = run.hiddenHarness;
            out.hiddenTestDir = 'hidden';
            hiddenTestFiles[run.id] = Object.keys(run.hiddenTestFiles).map((at) => `hidden/${at}`);
          }
          return out;
        }),
      };
    } else if (checks.kind === 'config') {
      raw = { kind: 'config', smoke: { commands: checks.smokeCommands, implFiles: checks.smokeImplFiles } };
    }
    return { key: phase.key, title: phase.title, artifactKind: phase.artifactKind, checks: raw, hiddenTestFiles, rest: {} };
  });
  const project: Record<string, unknown> = {};
  if (content.preview) project.preview = content.preview;
  if (content.runtime) project.runtime = content.runtime;
  if (content.build) project.build = content.build;
  const warmup = content.warmup ? { check: content.warmup.check } : null;
  return { project, warmup, phases, shippedFiles: [...shipped] };
}

/**
 * Whether the version holds a deep receipt made against its executable bytes
 * as they are now: deep validation's `hasCurrentDeepReceipt` (receipt digest =
 * `executableContentDigest`). Anything it throws reads as "not current", which
 * only ever refuses a publish, never admits one.
 */
export function deepReceiptIsCurrent(version: Pick<ProjectVersionEntity, 'compiled' | 'validation'>): boolean {
  try {
    return hasCurrentDeepReceipt(version) === true;
  } catch {
    return false;
  }
}

/** The publish arm's rows, in the order a teacher fixes them: price, runtime, commands, proof. */
function executableRows(input: ExecutableValidationInput): ValidationCheck[] {
  const out: ValidationCheck[] = [];
  let total = 0;
  for (const phase of input.budget) {
    total += phase.microVMs;
    if (phase.microVMs > BUDGET_CEILING.perPhase) {
      out.push(row(BUDGET_CEILING_CHECK_ID, 'A phase boots no more microVMs than the ceiling', 'failed',
        budgetCeilingRefusal(phase.microVMs, phase.title), { phaseKey: phase.key }));
    }
  }
  if (total > BUDGET_CEILING.perVersion) {
    out.push(row(BUDGET_CEILING_CHECK_ID, 'A version boots no more microVMs than the ceiling', 'failed',
      budgetCeilingRefusal(total, null)));
  }
  if (input.runtimeUnreadable) {
    out.push(row(RUNTIME_PROFILE_CHECK_ID, 'The runtime is inside the profile this deployment runs', 'failed',
      RUNTIME_PROFILE_UNREADABLE));
  }
  for (const finding of input.runtime) {
    out.push(row(RUNTIME_PROFILE_CHECK_ID, 'The runtime is inside the profile this deployment runs', 'failed',
      runtimeProfileRefusal(finding)));
  }
  for (const finding of input.runShapes) {
    out.push(row(RUN_SHAPES_CHECK_ID, 'Every run is one the runner already knows', 'failed', finding.sentence));
  }
  const gate = (blocked: boolean): ValidationCheck['status'] => (blocked && input.publishing ? 'failed' : 'passed');
  const warn = (blocked: boolean) => (blocked && !input.publishing ? { advisory: 'warning' as const } : {});
  for (const phase of input.phases) {
    if (phase.reference) continue;
    out.push(row(DEEP_RECEIPT_CHECK_ID, 'Deep validation is current for this phase',
      gate(!phase.deepCurrent),
      phase.deepCurrent ? `${phase.title}'s deep validation passed against these exact bytes.` : deepReceiptRefusal(phase.title, { uploaded: input.uploaded }),
      { phaseKey: phase.key, ...warn(!phase.deepCurrent) }));
  }
  return out;
}

export interface ValidationInput {
  phases: ValidationPhaseInput[];
  /** The publish arm's input. Absent draws none of its rows. */
  executable?: ExecutableValidationInput;
  runtime?: RuntimeSpec | null;
  hasBuild: boolean;
  hasPreview: boolean;
  /**
   * What `compilePack` said, when it refused. It is the compiler's own sentence
   * and it is carried rather than thrown: a teacher saving a half-finished task
   * must be able to save it and read why it would not publish.
   */
  compileError: string | null;
  /** The scenario rows' input. Absent draws none of them. */
  scenario?: ScenarioValidationInput;
}

const row = (
  id: string,
  label: string,
  status: ValidationCheck['status'],
  sentence: string,
  over: Partial<Pick<ValidationCheck, 'phaseKey' | 'taskKey' | 'files' | 'advisory'>> = {},
): ValidationCheck => ({
  id,
  label,
  status,
  sentence,
  phaseKey: over.phaseKey ?? null,
  taskKey: over.taskKey ?? null,
  files: over.files ?? [],
  // A warning or a note is still a `passed` row, marked so
  // the report never lets it read as a plain pass.
  ...(over.advisory ? { advisory: over.advisory } : {}),
});

/** Whether any phase of the draft is scored by this kind of check. */
const anyKind = (input: ValidationInput, kind: ArtifactKind): boolean =>
  input.phases.some((phase) => phase.checkKind === kind);

/** What scores one task: its own kind where the caller named it, else the phase's. */
const kindOf = (task: ValidationTaskInput, phase: ValidationPhaseInput): ArtifactKind =>
  task.checkKind ?? phase.checkKind;

/** Every score a paper of `drawn` questions can produce, as `overall` rounds it. */
const exactScores = (drawn: number): number[] =>
  Array.from({ length: drawn + 1 }, (_, right) => Math.round((100 * right) / drawn));

/** The first score at or above the mark, and how many right answers it takes. */
function firstPassingScore(drawn: number, passMark: number): { right: number; score: number } | null {
  const scores = exactScores(drawn);
  for (let right = 0; right <= drawn; right += 1) {
    if (scores[right] >= passMark) return { right, score: scores[right] };
  }
  return null;
}

/**
 * What is wrong with a quiz's questions, in one sentence, or null.
 *
 * One sentence and not a list, because a teacher fixes one thing and re-reads
 * the row; and the first refusal is the one nearest the top of the paper, so
 * the order below is the order a teacher reads their own questions in.
 *
 * `seen` is the phase's question ids so far, carried across the phase's tasks:
 * a question id is a graded unit's id, and the compiler refuses two tasks
 * owning one unit with a sentence about units. This is the same fact said in
 * the teacher's words, before they reach the door.
 */
function quizShapeRefusal(
  quiz: QuizChecks,
  title: string,
  seen: Map<string, string>,
): string | null {
  if (quiz.questions.length === 0) {
    return `${title} is a quiz with no questions, so there is nothing for a learner to answer. Write at least one.`;
  }
  for (const question of quiz.questions) {
    const at = `${title}: the question "${question.id}"`;
    const held = seen.get(question.id);
    if (held !== undefined) {
      return `${at} is also asked by ${held}. A question id is what scores it, so two questions in one phase cannot share one; rename one of them.`;
    }
    seen.set(question.id, title);
    if (question.stem.trim() === '') {
      return `${at} has no text, so a learner would be asked nothing. Write the question.`;
    }
    if (question.explanation.trim() === '') {
      return `${at} has no explanation, and the explanation is the only thing a learner is given once they are finished with the question — the key never is. Write it.`;
    }
    if (question.options.length < 2 || question.options.length > 8) {
      return `${at} offers ${question.options.length} ${question.options.length === 1 ? 'option' : 'options'}, and a multiple-choice question offers between 2 and 8.`;
    }
    const ids = new Set<string>();
    for (const option of question.options) {
      if (ids.has(option.id)) {
        return `${at} offers two options keyed "${option.id}". An answer is submitted as an option id, so two options cannot share one.`;
      }
      ids.add(option.id);
    }
    if (question.correct.length === 0) {
      return `${at} marks no option correct, so no learner could answer it. Mark at least one.`;
    }
    const keyed = new Set<string>();
    for (const id of question.correct) {
      if (!ids.has(id)) {
        return `${at} marks "${id}" correct, which is not one of its options, so no answer could match it.`;
      }
      // A repeat is ONE answer to the scorer, which folds the key into a set
      // before it compares, but *how many answers this question takes* is
      // read off the same key, so an array of two would draw the question as
      // a checkbox group, tell the learner to pick every answer that applies,
      // and mark them wrong for doing it. Refused here, where a teacher can
      // read about it, rather than quietly folded away.
      if (keyed.has(id)) {
        return `${at} marks "${id}" correct twice. A question that takes one answer is asked one way and a question that takes several is asked another, so a repeat would tell a learner to pick more options than the key accepts. Mark it once.`;
      }
      keyed.add(id);
    }
    if (keyed.size === question.options.length) {
      return `${at} marks every option correct, so it asks nothing. Leave at least one option wrong.`;
    }
  }
  return null;
}

function appliesTo(id: DeepTierCheckId, input: ValidationInput): boolean {
  switch (id) {
    case 'solution-passes-hidden':
    case 'stub-fails-hidden':
      return anyKind(input, 'code');
    case 'reference-passes-impl':
    case 'mutants-die':
      return anyKind(input, 'tests');
    case 'forged-entrypoint-refused':
      return anyKind(input, 'config');
    case 'drill-breaks-smoke':
      return input.phases.some((phase) => phase.hasDrill);
    case 'front-end-suite-runs':
      return input.hasBuild;
    case 'preview-starts':
      return input.hasPreview;
  }
}

/**
 * Run the fast tier and fold it into the report the editor draws and the
 * publish reads.
 *
 * The order is the order a teacher wants to read a failure in: the gate that
 * would refuse the whole publish, then whether a phase could ever be passed,
 * then the paths a room and a reset key on, then what the runner can import,
 * then what the compiler said, and last the neutral rows.
 */
export function fastValidation(
  input: ValidationInput,
  stacks: SupportedStacks,
  ranAt: string = new Date().toISOString(),
): ValidationReport {
  const checks: ValidationCheck[] = [];

  /*
   * The safety gate: a draft may hold any number of tasks, a publish may not.
   *
   * The gate is asked **of the phase's own check kind**. Written
   * work may hold as many tasks as a teacher likes once the runtime is ready;
   * a phase graded by the code, test or deployment grader may not, and its
   * refusal carries `EXECUTABLE_SPLIT_NOT_READY`: the one sentence the
   * compiler's own wall is built out of, so a teacher reads the same words in
   * the editor and at the door. While the runtime gate is shut every kind
   * answers 1.
   */
  for (const phase of input.phases) {
    const count = phase.tasks.length;
    // The gate counts the **non-quiz** tasks, which is what the compiler's
    // wall counts. A `code` phase with one quiz beside its inherited task
    // would otherwise read `failed` here and `blocksPublish: true` in the
    // editor while the compiler published it: the editor telling a teacher
    // their version cannot ship and the door letting it through. A task whose
    // kind the caller does not name is counted, so a caller that names no
    // kinds counts every task.
    const graded = phase.tasks.filter((task) => kindOf(task, phase) !== 'quiz').length;
    const quizzes = count - graded;
    const blocked = refusesMultiTaskPublish(graded, phase.checkKind);
    checks.push(
      row(
        MULTI_TASK_CHECK_ID,
        'A phase holds tasks a learner can work on',
        blocked ? 'failed' : 'passed',
        blocked
          ? multiTaskPublishRefusal(phase.title, graded, phase.checkKind)
          : count > 1
            ? // every phase holds one graded task beside quizzes

              `${phase.title} holds ${graded} graded ${graded === 1 ? 'task' : 'tasks'} and ` +
              `${quizzes} ${quizzes === 1 ? 'quiz' : 'quizzes'}, which a learner can work on.`
            : count === 0
              ? `${phase.title} holds no task yet.`
              : `${phase.title} holds ${count === 1 ? '1 task' : `${count} tasks`}, which a learner can work on.`,
        { phaseKey: phase.key },
      ),
    );
  }

  /* a phase whose tasks are all optional could never be gated */
  for (const phase of input.phases) {
    const required = phase.tasks.filter((task) => task.required);
    checks.push(
      row(
        REQUIRED_TASK_CHECK_ID,
        'A phase has a task that gates it',
        required.length > 0 ? 'passed' : 'failed',
        required.length > 0
          ? `${phase.title} is gated on ${required.length === 1 ? '1 required task' : `${required.length} required tasks`}.`
          : noRequiredTaskRefusal(phase.title),
        { phaseKey: phase.key },
      ),
    );
  }

  /*
   * Four rows per quiz task, and they are the only place a
   * quiz's own fields are held to anything: the compiler can see that a quiz
   * task owns no file and claims one rubric key, and it cannot see whether a
   * teacher keyed an option that is not in the question.
   *
   * A draft with no quiz gets no rows at all rather than four grey ones, which
   * is the same judgement `notApplicableLine` is built on.
   */
  for (const phase of input.phases) {
    const seenQuestion = new Map<string, string>();
    for (const task of phase.tasks) {
      const quiz = task.quiz;
      if (!quiz) continue;
      const over = { phaseKey: phase.key, taskKey: task.taskKey };
      const drawn = quiz.drawn ?? quiz.questions.length;

      const wrong = quizShapeRefusal(quiz, task.title, seenQuestion);
      checks.push(
        row(
          QUIZ_QUESTIONS_CHECK_ID,
          'A quiz asks questions that can be answered',
          wrong ? 'failed' : 'passed',
          wrong ??
            `${task.title} asks ${quiz.questions.length === 1 ? '1 question' : `${quiz.questions.length} questions`}, each with options a learner can choose between and a key among them.`,
          over,
        ),
      );

      const fits = quiz.drawn === undefined || (quiz.drawn >= 1 && quiz.drawn <= quiz.questions.length);
      checks.push(
        row(
          QUIZ_DRAW_CHECK_ID,
          'A quiz draws a paper its pool can fill',
          fits ? 'passed' : 'failed',
          fits
            ? quiz.drawn === undefined
              ? `${task.title} draws its whole pool of ${quiz.questions.length}, in order.`
              : `${task.title} draws ${quiz.drawn} of its ${quiz.questions.length} questions.`
            : `${task.title} draws ${quiz.drawn} questions from a pool of ${quiz.questions.length}, and a paper cannot ask a question the pool does not hold. Draw between 1 and ${quiz.questions.length}.`,
          over,
        ),
      );

      /*
       * `quiz-pass-mark-reachable` **warns**, and a warning in this tier is a
       * `passed` row whose sentence says the thing: the three statuses are
       * `passed`, `failed` and `not-applicable`, and a `failed` row blocks the
       * publish. A mark of 70 on a five-question paper is not wrong, it is a
       * mark of 80 wearing a different number, and that is a teacher's
       * decision to make knowingly rather than a version to refuse.
       */
      const reachable = drawn > 0 && exactScores(drawn).includes(quiz.passMark);
      const firstPass = drawn > 0 ? firstPassingScore(drawn, quiz.passMark) : null;
      checks.push(
        row(
          QUIZ_PASS_MARK_CHECK_ID,
          'A quiz pass mark is a score a paper can land on',
          'passed',
          reachable || firstPass === null
            ? `${task.title} passes at ${quiz.passMark}%, which a paper of ${drawn} can land on exactly.`
            : `${task.title} passes at ${quiz.passMark}%, which a paper of ${drawn} cannot land on. The first passing score is ${firstPass.right} of ${drawn}, which is ${firstPass.score}% — so ${quiz.passMark}% is ${firstPass.score}% under another name.`,
          over,
        ),
      );

      const fixedPaper = quiz.drawn === undefined || quiz.drawn === quiz.questions.length;
      const resat = task.required && (quiz.attempts.max === null || fixedPaper);
      checks.push(
        row(
          QUIZ_RETAKE_CHECK_ID,
          'A required quiz is a new paper each time',
          resat ? 'failed' : 'passed',
          resat
            ? `${task.title} gates ${phase.title} and ${quiz.attempts.max === null ? 'can be re-sat without limit' : `draws all ${quiz.questions.length} of its questions every time`}, so a learner passes it by persistence rather than by knowing the answer. Give it a finite number of attempts and a pool larger than the paper it draws, or mark it optional.`
            : task.required
              ? `${task.title} gates ${phase.title}, draws ${drawn} of ${quiz.questions.length} and allows ${quiz.attempts.max} ${quiz.attempts.max === 1 ? 'attempt' : 'attempts'}, so a retake is a different paper.`
              : `${task.title} gates nothing, so it is free to be re-sat as often as a learner likes.`,
          over,
        ),
      );

      // A row only where the quiz carries the choice.
      if (quiz.revealExplanation !== undefined) {
        checks.push(
          row(
            QUIZ_REVEAL_CHECK_ID,
            'Only an optional quiz chooses when its explanations are shown',
            task.required ? 'failed' : 'passed',
            task.required
              ? quizRevealOptionalOnlyRefusal(task.title)
              : quiz.revealExplanation === 'always'
                ? `${task.title} gates nothing and shows its explanations after every attempt.`
                : `${task.title} gates nothing and shows its explanations after a pass or when its attempts run out.`,
            over,
          ),
        );
      }
    }
  }

  /*
   * The screen contract has an owner wherever a later phase reads it.
   * A row only for a version that has a Design phase, a later phase reading
   * the copy, and owners the caller could name: a caller that names none
   * draws no row.
   */
  const design = input.phases.find((phase) => phase.key === 'design');
  const reader = design ? input.phases.slice(input.phases.indexOf(design) + 1).find((phase) => phase.readsScreenCopy) : undefined;
  if (design && reader && design.tasks.every((task) => Array.isArray(task.owns))) {
    const owners = design.tasks.filter((task) => task.owns!.includes(SCREEN_CONTRACT_PATH));
    // An owner only counts if the gate waits for it. An
    // optional one lets Design read passed while the advance still refuses.
    const owned = owners.some((task) => task.required);
    // The advance refuses only for an owner that is the
    // reference's own task by its anchor (`requireAcceptedDesignScreenCopy`).
    // With a name to say it in (the scenario input), no owner, or an optional
    // owner that is not the reference's, is a note: the baseline mounts.
    const name = input.scenario?.referenceName;
    const baseline = !owned && name !== undefined && owners.every((task) => task.anchorReference === false);
    checks.push(
      row(
        SCREEN_CONTRACT_OWNER_CHECK_ID,
        'The screen contract later phases read has an owner',
        owned || baseline ? 'passed' : 'failed',
        owned
          ? `A ${design.title} task owns ${SCREEN_CONTRACT_PATH}, so ${reader.title} can read the screen copy a passing ${design.title} submission leaves there.`
          : baseline
            ? owners.length
              ? optionalScreenContractBaselineNote(design.title, reader.title, name as string)
              : screenContractBaselineNote(design.title, reader.title, name as string)
            : owners.length
              ? optionalScreenContractOwnerRefusal(design.title, reader.title)
              : screenContractOwnerRefusal(design.title, reader.title),
        { phaseKey: design.key, files: [SCREEN_CONTRACT_PATH], ...(!owned && baseline ? { advisory: 'note' as const } : {}) },
      ),
    );
  }

  if (input.scenario) checks.push(...scenarioRows(input.scenario));

  /* artefact paths, across the whole version: a reset keys on one */
  const heldBy = new Map<string, { title: string; phaseKey: PhaseKey }>();
  const clashes: ValidationCheck[] = [];
  let paths = 0;
  for (const phase of input.phases) {
    for (const task of phase.tasks) {
      if (task.artefactPath === null) continue;
      paths += 1;
      const already = heldBy.get(task.artefactPath);
      if (already) {
        clashes.push(
          row(
            ARTEFACT_PATH_CHECK_ID,
            'No two tasks write to one file',
            'failed',
            duplicateArtefactPathRefusal(task.artefactPath, already.title),
            { phaseKey: phase.key, taskKey: task.taskKey, files: [task.artefactPath] },
          ),
        );
        continue;
      }
      heldBy.set(task.artefactPath, { title: task.title, phaseKey: phase.key });
    }
  }
  checks.push(
    ...(clashes.length > 0
      ? clashes
      : [
          row(
            ARTEFACT_PATH_CHECK_ID,
            'No two tasks write to one file',
            'passed',
            paths === 0
              ? 'No task in this version writes a file of its own, so no two can collide.'
              : `${paths === 1 ? '1 task writes' : `${paths} tasks write`} to a file of their own, and no two share one.`,
          ),
        ]),
  );

  /* what the runner bakes, measured against the runner's own manifest */
  const unsupported = unsupportedPackages(input.runtime, stacks);
  if (!input.runtime) {
    checks.push(
      row(
        SUPPORTED_STACK_CHECK_ID,
        'The runner can import what this project needs',
        'not-applicable',
        'This project declares no runtime packages, so there is nothing to check.',
      ),
    );
  } else if (unsupported.length === 0) {
    checks.push(
      row(
        SUPPORTED_STACK_CHECK_ID,
        'The runner can import what this project needs',
        'passed',
        stacks.sentence,
      ),
    );
  } else {
    for (const one of unsupported) {
      checks.push(
        row(
          SUPPORTED_STACK_CHECK_ID,
          'The runner can import what this project needs',
          'failed',
          unsupportedLibraryRefusal(one.ecosystem, one.name),
        ),
      );
    }
  }

  /* the ceiling, the profile, the run shapes, the deep receipt */
  if (input.executable) checks.push(...executableRows(input.executable));

  /* what the compiler said, carried rather than thrown */
  checks.push(
    row(
      COMPILE_CHECK_ID,
      'The version compiles',
      input.compileError ? 'failed' : 'passed',
      input.compileError ?? 'Every phase compiles: each task owns the files it is graded on, and no two tasks share what scores them.',
    ),
  );

  /* the neutral rows, for the proofs this project has nothing to prove */
  for (const id of DEEP_TIER_CHECK_IDS) {
    if (appliesTo(id, input)) continue;
    const { label, needs } = DEEP_TIER_NEEDS[id];
    checks.push(
      row(id, label, 'not-applicable', `This project has no ${needs}, so there is nothing here to prove.`),
    );
  }

  return summariseValidation('fast', ranAt, checks);
}

/**
 * The rows a teacher's own scenario adds. Two refuse (an interview the loader would refuse
 * or whose sealed row no longer holds it, and one document holding two sets of
 * bytes) and the rest are `passed` rows whose sentence is the warning or the
 * note, drawn only where the thing is true.
 */
function scenarioRows(scenario: ScenarioValidationInput): ValidationCheck[] {
  const out: ValidationCheck[] = [];
  const name = scenario.referenceName;

  for (const one of scenario.interviews) {
    const over = { phaseKey: one.key };
    const interview = /\binterview$/i.test(one.title) ? one.title : `${one.title} interview`; // never "interview interview"
    if (one.present) {
      out.push(
        row(
          INTERVIEW_WELL_FORMED_CHECK_ID,
          'The stakeholder interview is one the room can hold',
          one.refusal ? 'failed' : 'passed',
          one.refusal ??
            `The ${interview} is well formed: ${one.facts === 1 ? '1 fact' : `${one.facts} facts`} for a learner to settle.`,
          over,
        ),
      );
    }
    const matches = one.present ? one.sealedRows === 1 && one.sealedMatches : one.sealedRows === 0;
    out.push(
      row(
        INTERVIEW_SEALED_ROW_CHECK_ID,
        "The interview's sealed row holds the interview",
        matches ? 'passed' : 'failed',
        matches
          ? `The ${interview}'s sealed row holds exactly its interview, so its answers can never be mounted where a learner reads them.`
          : one.present
            ? `The ${interview}'s sealed row does not hold the interview's bytes, so the rule that keeps the answers out of every learner's file cannot see them. Save the interview again.`
            : `${one.title} holds a sealed interview row and no interview. Remove the interview again so the two agree.`,
        over,
      ),
    );
  }

  for (const document of scenario.documents) {
    const titles = document.phases.map((phase) => phase.title).join(' and ');
    out.push(
      row(
        BACKLOG_ONE_DOCUMENT_CHECK_ID,
        'A document several phases mount is one document',
        document.sameBytes ? 'passed' : 'failed',
        document.sameBytes
          ? `"${document.path}" is one document in ${titles}, byte for byte.`
          : `"${document.path}" holds different bytes in ${titles}, and it is one document. Replace it again from either phase: every phase that mounts it takes the same bytes.`,
        { phaseKey: document.phases[0]?.key, files: [document.path] },
      ),
    );
  }

  const backlog = scenario.backlog;
  if (backlog && (backlog.stories === 0 || backlog.missing !== ROOM_RECORD_STORY_ID)) {
    out.push(
      row(
        BACKLOG_SHAPE_CHECK_ID,
        'The backlog leaves the story the room grades for the learner',
        'passed',
        backlog.stories === 0
          ? `"${backlog.path}" lists no story as "## US-n — Title", so a learner's backlog in ${backlog.title} is empty. Write the stories your class starts from.`
          : `"${backlog.path}" does not mark ${ROOM_RECORD_STORY_ID} as the missing story, and the story task you kept still grades a record with the id ${ROOM_RECORD_STORY_ID}. Keep "## ${ROOM_RECORD_STORY_ID} — … (missing)" in the backlog, or replace the task with one of your own.`,
        { phaseKey: backlog.key, files: [backlog.path], advisory: 'warning' },
      ),
    );
  }

  for (const one of scenario.unnamedStakeholder) {
    out.push(
      row(
        BRIEF_NAMES_STAKEHOLDER_CHECK_ID,
        'A task that needs the interview names the stakeholder',
        'passed',
        `"${one.title}" does not name ${one.persona} in full in its brief, so its reviewer is given none of ${one.persona}'s answers. Name ${one.persona} in the brief of a task that depends on the interview.`,
        { phaseKey: one.key, taskKey: one.taskKey, advisory: 'warning' },
      ),
    );
  }

  for (const one of scenario.removedStakeholder) {
    out.push(
      row(
        BRIEF_NAMES_REMOVED_STAKEHOLDER_CHECK_ID,
        'A brief names only a stakeholder this version has',
        'passed',
        `"${one.title}" names ${one.name}, who is not this version's stakeholder, so a learner would look for someone the interview does not hold. Rewrite the brief, or replace the task with one of your own.`,
        { phaseKey: one.key, taskKey: one.taskKey, advisory: 'warning' },
      ),
    );
  }

  const requirements = scenario.writtenPhases.find((phase) => phase.key === 'requirements');
  const design = scenario.writtenPhases.find((phase) => phase.key === 'design');
  if (requirements && design) {
    const designBehind = requirements.teachers && design.inheritedReference;
    const requirementsBehind = design.teachers && requirements.inheritedReference;
    if (designBehind || requirementsBehind) {
      out.push(
        row(
          SCENARIO_ONE_PROJECT_CHECK_ID,
          'Requirements and Design describe one project',
          'passed',
          designBehind
            ? `${design.title} still asks for ${name}'s data model, contract and screens, while ${requirements.title} is your own. Rewrite or replace the ${design.title} task so the two phases describe one project.`
            : `${requirements.title} still asks for ${name}'s user story, while ${design.title} is your own. Rewrite or replace the ${requirements.title} task so the two phases describe one project.`,
          { phaseKey: designBehind ? design.key : requirements.key, advisory: 'warning' },
        ),
      );
    }
  }

  for (const phase of scenario.writtenPhases) {
    if (!phase.scenarioOwn || !phase.inheritedReference) continue;
    out.push(
      row(
        INHERITED_TASK_SCENARIO_CHECK_ID,
        "A copied task fits the phase's scenario",
        'passed',
        `${phase.title}'s scenario is your own, but "${phase.inheritedReference.title}" is still ${name}'s task and grades ${name}'s work. Rewrite it, or replace it with a task of your own.`,
        { phaseKey: phase.key, taskKey: phase.inheritedReference.taskKey, advisory: 'warning' },
      ),
    );
  }

  if (scenario.application) {
    out.push(
      row(APPLICATION_CHECK_ID, "The last four phases run the reference's application", 'passed', applicationPhasesSentence(name), { advisory: 'note' }),
    );
  }
  return out;
}
