/**
 * The shared contract for the teacher's path through authoring a project.
 *
 * It covers what lets a teacher walk that path on their own: a staff-only
 * starter archive, what the upload says it changed on the way in, a read-only
 * learner preview of a draft, and a guide that explains every step and every
 * upload refusal. The API and the web app both read every value
 * below, so a value that drifts fails `teacher-path.spec.ts` first.
 *
 * The rules this file keeps:
 *
 * - **Four regions.** The file is four regions, in the order DERIVE,
 *   GUIDE-CONTENT, PREVIEW-DESIGN, STARTER.
 * - **`ProjectUploadResult` is not edited.** It keeps its six keys
 *   (`upload-contract.spec.ts`, the recorded upload exchange). The upload
 *   answers `ProjectUploadResultWithWarnings`, which adds `warnings` only when
 *   the upload changed something. It is defined once, in the DERIVE region.
 * - **Append only.** Add names; never rename one.
 * - **Imports are siblings only,** and every type it reads from the contract
 *   modules is `import type`.
 */

import type { PhaseDetail, PhaseTaskView } from './contract/phase-detail';
import type { PhaseKey } from './phases';
import type { ArtefactType } from './projects';
import {
  BUDGET_CEILING,
  PROJECT_UPLOAD_LIMITS,
  UPLOAD_REFUSAL_CODES,
  type ProjectUploadResult,
  type UploadRefusalCode,
} from './upload-contract';
import { withThousands } from './words';

/* ====== Region DERIVE: what the upload answers ====== */

/*
 * `ProjectUploadResultWithWarnings` is the extension the upload returns, and
 * this file holds exactly one definition of it.
 */

/**
 * `ProjectUploadResult` keeps its six keys; the upload answers this extension
 * and sets `warnings` only when it changed something on the way in (the key is
 * absent otherwise, so an upload that changed nothing answers exactly the
 * recorded six-key exchange).
 */
export interface ProjectUploadResultWithWarnings extends ProjectUploadResult {
  /**
   * What the upload changed on the way in, one sentence each: a Requirements
   * phase of the old markdown kind converted to the story kind, naming the
   * stories whose persona, capability or benefit was filled with a placeholder,
   * and a Design phase of the old markdown kind converted to the design kind,
   * naming what moved and what was dropped. Absent when nothing was changed.
   */
  warnings?: string[];
}

/* ====== Region GUIDE-CONTENT: the teacher guide ====== */

/* =========================== the teacher guide =========================== */
/*
 * The teacher guide's copy. Copy only: no function here reads the network, a
 * clock or the archive.
 *
 * Four things live here, each a closed table the web reads verbatim:
 *
 * - `UPLOAD_REFUSAL_HELP`: for every wire code an upload can refuse with
 *   (`UPLOAD_REFUSAL_CODES`, 29), what happened and how to fix it. It never
 *   quotes the archive: like `UPLOAD_REFUSALS`, every word is fixed.
 * - `UPLOAD_REFUSAL_FALLBACK`: what the page adds under an answer that carries
 *   no code (a 429, a 401 or 403, a 5xx, no answer at all). It never says the
 *   archive is wrong, because nothing in such an answer says so.
 * - `GUIDE_STEPS`: the ten steps of the teacher's path, each with two to four
 *   sentences of help, where "Take me there" goes, and its section of the
 *   in-app guide.
 * - `INLINE_HELP` and the single lines the upload page and the editor say.
 */

/** Where the in-app teacher guide lives on the web. */
export const TEACHER_GUIDE_PATH = '/teacher/guide';

/**
 * The guide page's own section ids, beside the ones the generated document
 * gives its `##` headings (GitHub's slug rule). The refusal table is drawn
 * from `UPLOAD_REFUSAL_HELP`, not from the document.
 */
export const TEACHER_GUIDE_OWN_SECTIONS = Object.freeze({
  refusalHelp: 'refusal-help',
} as const);

/* ------------------------------ the refusal help ------------------------------ */

/** One refusal, explained: what happened, how to fix it, and where the guide says more. */
export interface UploadRefusalHelp {
  /** What happened, as a short sentence-case line. Never a byte of the archive. */
  title: string;
  /** How to fix it: one to three sentences. */
  fix: string;
  /** A section id of the in-app guide (`TEACHER_GUIDE_PATH#guideAnchor`). */
  guideAnchor: string;
}

const PREPARE = '1-prepare-the-archive';
const UPLOAD = '2-upload';
const RUN_SHAPES_SECTION = '6-the-seven-run-shapes';

/**
 * Every wire code, explained. Exactly the keys of `UPLOAD_REFUSAL_CODES`: the
 * `Record` makes a missing code a compile error, and the contract spec makes an
 * extra one a red test.
 */
export const UPLOAD_REFUSAL_HELP: Readonly<Record<UploadRefusalCode, Readonly<UploadRefusalHelp>>> = Object.freeze({
  PATH_CLIMB: {
    title: 'An entry climbs out of the project folder',
    fix: 'Zip the project folder itself, so every entry sits inside it. Leave out any entry whose path climbs up a folder or starts at the root of the disk, then upload again.',
    guideAnchor: PREPARE,
  },
  SYMLINK: {
    title: 'An entry is a symbolic link',
    fix: 'Replace each link with the file it points to, or leave it out, and zip the folder again. An upload holds ordinary files only.',
    guideAnchor: PREPARE,
  },
  DUPLICATE_NAME: {
    title: 'Two entries share one name',
    fix: 'Zip a clean copy of the folder, so each file and folder appears once and no file sits at the same path as a folder.',
    guideAnchor: PREPARE,
  },
  CASE_COLLISION: {
    title: 'Two names differ only in upper and lower case',
    fix: 'Rename one of the two files or folders so the names differ by more than case, then zip the folder again.',
    guideAnchor: PREPARE,
  },
  NUL_IN_NAME: {
    title: 'An entry name holds a control character',
    fix: 'Rename the entry so its name holds only printable characters, then zip the folder again.',
    guideAnchor: PREPARE,
  },
  RATIO_BOMB: {
    title: `An entry unpacks to more than ${PROJECT_UPLOAD_LIMITS.maxRatio} times its packed size`,
    fix: 'Leave out the file that packs down so far, usually generated data or build output, and zip the folder again.',
    guideAnchor: PREPARE,
  },
  TOTAL_SIZE_BOMB: {
    title: 'The archive unpacks to more than the upload limit',
    fix: 'Leave out dependencies and build output, such as node_modules and built bundles, so the unpacked project fits the limit the upload page shows.',
    guideAnchor: PREPARE,
  },
  TOO_MANY_ENTRIES: {
    title: `The archive holds more than ${withThousands(PROJECT_UPLOAD_LIMITS.maxEntries)} entries`,
    fix: 'Leave out dependencies, caches and build output, which hold most of the entries, and zip the folder again.',
    guideAnchor: PREPARE,
  },
  ENCRYPTED_ENTRY: {
    title: 'An entry is encrypted',
    fix: 'Zip the folder again with no password. An upload is read as it is.',
    guideAnchor: PREPARE,
  },
  ZIP64_OR_SIZE_MISMATCH: {
    title: 'An entry does not match the size or checksum it declares',
    fix: 'Make the archive again with your computer\'s own zip tool, and keep it under the upload limit. A damaged archive, or a very large one, cannot be read.',
    guideAnchor: PREPARE,
  },
  CRC_MISMATCH: {
    title: 'An entry is damaged',
    fix: 'Make the archive again from the project folder. The copy that was sent does not match its own checksum, which usually means it was cut short.',
    guideAnchor: PREPARE,
  },
  RUNTIME_OUTSIDE_PROFILE: {
    title: 'The project asks for a library this deployment does not bake',
    fix: 'Remove the runtime block from project.json, or pin only the versions the runtime profile on the upload page holds. Adding a library is a platform change, not a content change.',
    guideAnchor: PREPARE,
  },
  RUN_LIMIT_ABOVE_LEARNER: {
    title: 'A run asks for more time or memory than a learner\'s run gets',
    fix: 'Remove the time and memory keys from that run. Every run gets a learner\'s limits, and a project never needs to declare them.',
    guideAnchor: RUN_SHAPES_SECTION,
  },
  RUN_SHAPE_NOT_ALLOWED: {
    title: 'A run is outside the seven run shapes',
    fix: 'Declare each run in one of the seven run shapes, with no command of its own. Each finding under the sentence says where in the manifest to look.',
    guideAnchor: RUN_SHAPES_SECTION,
  },
  TWO_WORK_TASKS: {
    title: 'A coding, testing or deployment phase holds two work tasks',
    fix: 'Keep one work task in each of Implementation, Testing, Deployment and Maintenance. A quiz beside it is fine.',
    guideAnchor: PREPARE,
  },
  HIDDEN_IN_WORKSPACE: {
    title: 'A file a learner reads holds a hidden test',
    fix: 'Take the hidden test\'s bytes out of every file a learner reads, so the hidden suite stays hidden, then upload again.',
    guideAnchor: PREPARE,
  },
  SOLUTION_IN_EDITABLE: {
    title: 'A file a learner edits holds the reference solution',
    fix: 'Give the learner a starter file in place of the finished one. The reference solution belongs in its sealed folder only.',
    guideAnchor: PREPARE,
  },
  CEILING_PER_PHASE: {
    title: `A phase would boot more than ${BUDGET_CEILING.perPhase} microVMs`,
    fix: `Remove runs or mutants from that phase until one full pass of it boots ${BUDGET_CEILING.perPhase} or fewer.`,
    guideAnchor: PREPARE,
  },
  CEILING_PER_VERSION: {
    title: `The project would boot more than ${BUDGET_CEILING.perVersion} microVMs`,
    fix: `Remove runs or mutants across the phases until one full pass of the project boots ${BUDGET_CEILING.perVersion} or fewer.`,
    guideAnchor: PREPARE,
  },
  RESERVED_NAME: {
    title: 'A taken or reserved address gets a number added',
    fix: 'Nothing to fix: the upload goes ahead, and the project keeps your title. Only its web address ends in a number, such as -2.',
    guideAnchor: UPLOAD,
  },
  SECRET_FILE: {
    title: 'The archive holds a file shaped like a secret',
    fix: 'Leave out environment files, private keys, credential files and folders such as .git, and zip a clean copy. The one example allowed is canonical/.env.example.',
    guideAnchor: PREPARE,
  },
  ARCHIVE_TOO_LARGE: {
    title: 'The archive is larger than the upload limit',
    fix: 'Leave out dependencies and build output and zip the folder again, so the archive fits the limit the upload page shows.',
    guideAnchor: PREPARE,
  },
  NOT_A_ZIP: {
    title: 'The file is not a zip archive',
    fix: 'Choose the .zip of your project folder. Other kinds of archive are not read.',
    guideAnchor: PREPARE,
  },
  NOT_A_PACK: {
    title: 'The archive is not a project in the authoring layout',
    fix: 'Check that project.json sits at the top of the archive or inside one folder, and that each phase folder holds a phase.json that reads as JSON. When a line under the sentence names a file or a field, fix that one first.',
    guideAnchor: PREPARE,
  },
  WARMUP_NOT_UPLOADABLE: {
    title: 'The project declares a warm-up',
    fix: 'Remove the warmup key from project.json and leave its folder out, then upload again.',
    guideAnchor: PREPARE,
  },
  TITLE_INVALID: {
    title: 'The title is empty or too long',
    fix: 'Give the project a title of 1 to 120 characters. Learners see it, and the address is made from it.',
    guideAnchor: UPLOAD,
  },
  UNSUPPORTED_ARCHIVE: {
    title: 'An entry is packed in a way the upload does not read',
    fix: 'Make the archive with your computer\'s own zip tool, which stores or deflates each entry.',
    guideAnchor: PREPARE,
  },
  EMPTY_ARCHIVE: {
    title: 'The archive holds no files',
    fix: 'Zip the project folder itself, with its files in it, and upload again.',
    guideAnchor: PREPARE,
  },
  ARCHIVE_NAME_TOO_LONG: {
    title: 'An entry name is too long',
    fix: 'Shorten the deepest folder or file names, so every path is at most 1,024 bytes and 64 parts.',
    guideAnchor: PREPARE,
  },
});
for (const code of UPLOAD_REFUSAL_CODES) Object.freeze(UPLOAD_REFUSAL_HELP[code]);

/**
 * Under an answer that carries no code: the upload's pace (429), a session or a
 * role (401, 403), the server (5xx), or no answer in time. It says what to try
 * and never that the archive is wrong. Each step it names holds under every
 * one of those sentences: the page says "nothing was imported" for a 429 and
 * a no-code 400 or 5xx, so the draft check is offered only for a run that ran
 * out of time.
 */
export const UPLOAD_REFUSAL_FALLBACK: Readonly<UploadRefusalHelp> = Object.freeze({
  title: 'What to try next',
  fix: 'Wait a minute, then upload the archive again. If the upload ran out of time, look in Your projects for the draft first. If you were signed out, sign in and try once more.',
  guideAnchor: UPLOAD,
});

/* -------------------------------- the ten steps -------------------------------- */

/** The teacher's path, in order. Add keys, never rename them. */
export const GUIDE_STEP_KEYS = [
  'prepare',
  'upload',
  'refine',
  'seal',
  'deep-validate',
  'preview',
  'publish',
  'assign',
  'sign-off',
  'export',
] as const;
Object.freeze(GUIDE_STEP_KEYS);

export type GuideStepKey = (typeof GUIDE_STEP_KEYS)[number];

/**
 * Where "Take me there" goes: an element id on the Projects page, on the draft
 * editor, or the classes page (where a version is assigned).
 */
export interface GuideStepAnchor {
  page: 'projects' | 'editor' | 'classes';
  id: string;
}

export interface GuideStep {
  key: GuideStepKey;
  title: string;
  /** Two to four sentences. */
  help: readonly string[];
  anchor: Readonly<GuideStepAnchor>;
  /** A section id of the in-app guide. */
  docsAnchor: string;
  /** A step a teacher may leave out: the path is complete without it. */
  optional: boolean;
}

/** The Preview step's help. */
export const PREVIEW_STEP_HELP: readonly string[] = Object.freeze([
  'See each phase as a learner will: the brief, the files a learner opens, the tasks and the quiz questions, without the answers or anything sealed.',
  'Nothing in a preview is saved, graded or seen by learners, and it starts no run and asks no AI model.',
]);

/** The starter archive's own warning. */
export const STARTER_WARNING = 'Replace the starter\'s hidden tests before you assign it.';

export const GUIDE_STEPS: readonly Readonly<GuideStep>[] = Object.freeze([
  {
    key: 'prepare',
    title: 'Prepare',
    help: [
      'Start from the starter archive on this page, or zip a project of your own in the authoring layout: project.json, canonical/ and one folder per phase.',
      'A Requirements phase needs no files beyond its phase.json, which holds the stories and the floor, and an optional interview.json for the stakeholder. You can also build it after the upload, in the editor\'s five steps.',
      'Leave out dependencies, build output and anything shaped like a secret.',
    ],
    anchor: { page: 'projects', id: 'guide-start-here' },
    docsAnchor: PREPARE,
    optional: false,
  },
  {
    key: 'upload',
    title: 'Upload',
    help: [
      'Choose Upload a project, give it a title and choose the archive. It becomes a draft, version 0.1.0, that only you can see.',
      'The upload runs fast validation at once. A refusal says what happened and how to fix it, and nothing is imported until the whole archive is accepted.',
      'Uploading again always makes a new project. To change this one, edit its draft.',
    ],
    anchor: { page: 'projects', id: 'guide-upload' },
    docsAnchor: UPLOAD,
    optional: false,
  },
  {
    key: 'refine',
    title: 'Refine',
    help: [
      'Edit each task\'s brief and objectives, and write the quiz questions and their answers, phase by phase.',
      'Every save comes back with a fresh validation report, so the report on the page is never one save behind.',
      'This step is done when fast validation finds nothing that would stop a publish.',
    ],
    anchor: { page: 'editor', id: 'guide-refine' },
    docsAnchor: '3-edit-the-draft',
    optional: false,
  },
  {
    key: 'seal',
    title: 'Seal',
    help: [
      'Hidden tests, the reference solution and mutants are sealed: no learner sees them, and the editor shows only each file\'s path, digest and size.',
      'Write them one whole file at a time with Edit the executable task, in Implementation, Testing, Deployment and Maintenance. Put a hidden test under a folder, such as tests/<name>.',
      STARTER_WARNING,
    ],
    anchor: { page: 'editor', id: 'guide-refine' },
    docsAnchor: '3-edit-the-draft',
    optional: false,
  },
  {
    key: 'deep-validate',
    title: 'Deep-validate',
    help: [
      'Deep validation boots your project in the sandbox, one microVM at a time, with a learner\'s limits and no AI model. It checks that the solution passes, the starter fails, every mutant is killed and the smoke check passes.',
      'The dialog shows the microVM count before you start, and that count is what the run costs.',
      'A result belongs to the bytes it ran on. Change an executable file and it goes stale, so run it again before you publish.',
    ],
    anchor: { page: 'editor', id: 'guide-deep' },
    docsAnchor: '4-deep-validation',
    optional: false,
  },
  {
    key: 'preview',
    title: 'Preview',
    help: PREVIEW_STEP_HELP,
    anchor: { page: 'editor', id: 'guide-preview' },
    docsAnchor: 'preview-a-draft-as-a-learner',
    optional: true,
  },
  {
    key: 'publish',
    title: 'Publish',
    help: [
      'Publishing freezes the draft as a version that never changes, so learners stay on the version they started.',
      'It checks everything again: the microVM ceiling, the runtime profile, the run shapes and limits, and a current, passing deep validation for every executable phase of your own.',
      'A refusal names what to fix, and nothing is published until the checks pass.',
    ],
    anchor: { page: 'editor', id: 'guide-publish' },
    docsAnchor: '5-publish-and-assign',
    optional: false,
  },
  {
    key: 'assign',
    title: 'Assign',
    help: [
      'Open a class from your classes and put it on the published version, with a reason the record of changes keeps.',
      'New enrolments take that version, and learners already enrolled stay on theirs.',
      'Nothing reaches a learner until you publish a version and assign it.',
    ],
    anchor: { page: 'classes', id: 'main' },
    docsAnchor: '5-publish-and-assign',
    optional: false,
  },
  {
    key: 'sign-off',
    title: 'Sign-off',
    help: [
      'Tick Needs your sign-off on a task when a learner\'s pass of it should wait for you. The mark reaches only the versions you publish after it.',
      'Learners who pass a marked task wait in the class\'s sign-off queue, and you can sign off up to 200 of them at once with one reason.',
    ],
    anchor: { page: 'editor', id: 'guide-refine' },
    docsAnchor: '9-sign-off-one-task-for-many-learners',
    optional: true,
  },
  {
    key: 'export',
    title: 'Export',
    help: [
      'Export as an archive, in the editor\'s header, saves a version in the authoring layout that you can upload again.',
      'It holds your sealed files, so keep it where only you can read it.',
      'The Requirements phase is exported as its phase.json, with an interview.json beside it when it has a stakeholder, and its starting story record only when that record is not the empty one the upload creates.',
    ],
    anchor: { page: 'editor', id: 'guide-export' },
    docsAnchor: '8-export-a-version',
    optional: true,
  },
] satisfies GuideStep[]);
for (const step of GUIDE_STEPS) {
  Object.freeze(step);
  Object.freeze(step.help);
  Object.freeze(step.anchor);
}

/* --------------------------------- inline help --------------------------------- */

/** The editor sections that carry one "What is this?" line. Add keys, never rename them. */
export const INLINE_HELP_KEYS = ['tasks', 'quiz', 'sealedFiles', 'runtime', 'budget', 'interview'] as const;
Object.freeze(INLINE_HELP_KEYS);

export type InlineHelpKey = (typeof INLINE_HELP_KEYS)[number];

/** What each section is, in a line a teacher can read in one breath. */
export const INLINE_HELP: Readonly<Record<InlineHelpKey, { topic: string; line: string }>> = Object.freeze({
  tasks: {
    topic: 'tasks',
    line: 'A task is one piece of work in a phase. A phase passes when every required task in it passes, and an optional task never blocks it.',
  },
  quiz: {
    topic: 'the quiz',
    line: 'A quiz is a task scored by its answer key. Learners see the questions and options, never the key or the explanations.',
  },
  sealedFiles: {
    topic: 'sealed files',
    line: 'Sealed files are the hidden tests, the reference solution and the mutants. They grade learners, and no learner ever sees their bytes. Put a hidden test under a folder, such as tests/<name>.',
  },
  runtime: {
    topic: 'the runtime profile',
    line: 'The runtime profile is the one set of libraries this deployment bakes into the sandbox. A project can ask only for what it holds.',
  },
  budget: {
    topic: 'the microVM ceiling',
    line: `A microVM is one sandbox boot. One full pass may boot at most ${BUDGET_CEILING.perPhase} a phase and ${BUDGET_CEILING.perVersion} a version, and publishing refuses above that.`,
  },
  interview: {
    topic: 'the stakeholder interview',
    line: 'Learners question a persona in Requirements to uncover the missing story. The answers stay sealed, and the reviewer is given them when a task\'s brief names the persona.',
  },
});
for (const key of INLINE_HELP_KEYS) Object.freeze(INLINE_HELP[key]);

/* ------------------------------ the single lines ------------------------------ */

/** Above the warnings an accepted upload answers, before the draft opens. */
export const UPLOAD_WARNINGS_SENTENCE = 'The upload changed the archive on the way in. Check these in the editor.';

/** Under a Requirements phase with no interview, in the editor. */
export const NO_INTERVIEW_HINT = 'Add a stakeholder in step 2 below to give learners someone to interview.';

/* ====== Region PREVIEW-DESIGN: the learner preview of a draft ====== */

/*
 * The learner preview's shared types. Append only.
 *
 * The preview is what a learner of this draft would read, and nothing else:
 * every key below is one a learner already reads on `GET /phases/:id`, the
 * interview room or the quiz room, or is derived from one (the gate sentence,
 * `needsSignOff`). No key is named for sealed content: there is no `checks`,
 * `hidden`, `solution`, `reference`, `impl`, `mutants`, `drill`, `facts`,
 * `answer`, `keywords`, `correct`, `explanation`, `rubric`, `unknownReply`,
 * `refusal` or `systemPrompt` anywhere in these shapes, and the key lists are
 * consts so a type-level test holds each shape to them exactly.
 */
/** One workspace file, as a learner's room mounts it before they type: editable or locked. */
export interface LearnerPreviewFile {
  path: string;
  content: string;
  editable: boolean;
  language: string;
}

/** One task of a phase: what it is called, the room it is worked in, and whether a teacher signs it off. */
export interface LearnerPreviewTask {
  key: string;
  order: number;
  required: boolean;
  title: string;
  /** The task's kind as the learner's room picks it (`PhaseTaskView.artefactType`). */
  artefactType: ArtefactType;
  /** `PhaseTaskView.evidence`, the same derivation. */
  evidence: PhaseTaskView['evidence'];
  /** True exactly when `evidence` is `signed-off`: a teacher's countersignature is half the pass. */
  needsSignOff: boolean;
}

/** One question of a quiz's pool, without its key: the stem, the options' words and whether more than one is right. */
export interface LearnerPreviewQuizQuestion {
  id: string;
  stem: string;
  /** The options' text in the order the teacher wrote them. Authored option ids are not carried. */
  options: string[];
  /** `QuizPaperQuestion.multiple`: the learner's paper says so too. */
  multiple: boolean;
}

/** One quiz task: its title, how many questions a paper draws, the pass mark, and the pool without keys. */
export interface LearnerPreviewQuiz {
  taskKey: string;
  title: string;
  drawn: number;
  passMark: number;
  questions: LearnerPreviewQuizQuestion[];
}

/** The stakeholder interview, as the room opens it: who they are and their opening line. Nothing else. */
export interface LearnerPreviewInterview {
  persona: { name: string; role: string };
  opening: string;
}

/** One phase, in order, as a learner of this draft would first read it. */
export interface LearnerPreviewPhase {
  key: PhaseKey;
  order: number;
  title: string;
  intro: string;
  objectives: string[];
  /** The phase brief, plain text, as the room shows it. */
  brief: string;
  files: LearnerPreviewFile[];
  /** The learner's story spec and the provided stories, as `PhaseDetail.story` carries them; absent unless the phase's check kind is `story`. */
  story?: PhaseDetail['story'];
  /** The design spec, as `PhaseDetail.design` carries it; absent unless the phase's check kind is `design`. */
  design?: PhaseDetail['design'];
  /** The runbook's floor and drill switch, as `PhaseDetail.runbook` carries them; absent unless the phase grades a runbook. */
  runbook?: PhaseDetail['runbook'];
  /** The ticket, contract switch and floor, as `PhaseDetail.change` carries them; absent unless the phase grades a change request. */
  change?: PhaseDetail['change'];
  tasks: LearnerPreviewTask[];
  quizzes: LearnerPreviewQuiz[];
  interview: LearnerPreviewInterview | null;
  canRun: boolean;
  runLabel: string;
  /** The rubric criteria's titles, the names a learner's check results are read under. */
  checkLabels: string[];
  /** When a learner opens this phase, in one sentence (shown, never enforced: there is no learner). */
  gate: string;
}

/** `GET /instructor/projects/:projectId/versions/:versionId/learner-preview`. */
export interface LearnerPreviewView {
  title: string;
  version: string;
  phases: LearnerPreviewPhase[];
}

/* The allowed keys, exactly (a type-level test holds each interface to its list). */
export const LEARNER_PREVIEW_VIEW_KEYS = ['title', 'version', 'phases'] as const;
export const LEARNER_PREVIEW_PHASE_KEYS = [
  'key',
  'order',
  'title',
  'intro',
  'objectives',
  'brief',
  'files',
  'story',
  'design',
  'runbook',
  'change',
  'tasks',
  'quizzes',
  'interview',
  'canRun',
  'runLabel',
  'checkLabels',
  'gate',
] as const;
export const LEARNER_PREVIEW_FILE_KEYS = ['path', 'content', 'editable', 'language'] as const;
export const LEARNER_PREVIEW_TASK_KEYS = [
  'key',
  'order',
  'required',
  'title',
  'artefactType',
  'evidence',
  'needsSignOff',
] as const;
export const LEARNER_PREVIEW_QUIZ_KEYS = ['taskKey', 'title', 'drawn', 'passMark', 'questions'] as const;
export const LEARNER_PREVIEW_QUESTION_KEYS = ['id', 'stem', 'options', 'multiple'] as const;
export const LEARNER_PREVIEW_INTERVIEW_KEYS = ['persona', 'opening'] as const;

/**
 * Names no preview shape may carry at any depth: each is where sealed or
 * scoring material lives in the compiled snapshot. The contract spec asserts
 * the allowed lists above are disjoint from this one, and the builder's spec
 * walks a built preview for them.
 */
export const LEARNER_PREVIEW_FORBIDDEN_KEYS = [
  'checks',
  'hidden',
  'hiddenTestFiles',
  'solution',
  'solutionFiles',
  'reference',
  'referenceTestFiles',
  'impl',
  'implFiles',
  'supportFiles',
  'mutants',
  'drill',
  'faultedFiles',
  'facts',
  'answer',
  'keywords',
  'correct',
  'explanation',
  'concept',
  'rubric',
  'rules',
  'unknownReply',
  'refusal',
  'systemPrompt',
  'assistant',
  'gradedUnits',
] as const;

/* ====== Region STARTER: the staff starter archives ====== */

/**
 * The two staff downloads, in the order the guide lists them. The API serves
 * each at `GET /instructor/starter/:name` (INSTRUCTOR and ADMIN only).
 */
export const STARTER_ARCHIVES = ['starter', 'shelf'] as const;

export type StarterArchiveName = (typeof STARTER_ARCHIVES)[number];

/** The same two names as a frozen list, the shape the API's starter-archive helper reads. */
export const STARTER_ARCHIVE_NAMES: readonly StarterArchiveName[] = Object.freeze([...STARTER_ARCHIVES]);
