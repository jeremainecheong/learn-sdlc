import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_DESIGN_FLOOR,
  LEARNER_PREVIEW_FILE_KEYS,
  LEARNER_PREVIEW_FORBIDDEN_KEYS,
  LEARNER_PREVIEW_INTERVIEW_KEYS,
  LEARNER_PREVIEW_PHASE_KEYS,
  LEARNER_PREVIEW_QUESTION_KEYS,
  LEARNER_PREVIEW_QUIZ_KEYS,
  LEARNER_PREVIEW_TASK_KEYS,
  LEARNER_PREVIEW_VIEW_KEYS,
} from '@learnsdlc/shared';
import type {
  LearnerPreviewFile,
  LearnerPreviewInterview,
  LearnerPreviewPhase,
  LearnerPreviewQuiz,
  LearnerPreviewQuizQuestion,
  LearnerPreviewTask,
  LearnerPreviewView,
  QuizChecks,
} from '@learnsdlc/shared';
import { canonicalJson } from '../content/blob.store';
import { ContentService } from '../content/content.service';
import type { DesignChecks, PhaseContent, ProjectContent, StoryChecks } from '../content/content.types';
import { MemoryPackSource } from '../content/memory-pack-source';
import { DirectoryPackSource, type PackSource } from '../content/pack-source';
import { checksOf, compilePack, type AuthoredTask, type CompiledSnapshot } from '../content/pack-compiler';
import { entriesOf } from '../../test/fixtures/upload-packs/archive';
import { SHELF_DIR, SHELF_MARKERS } from '../../test/fixtures/upload-packs/markers';
import { fixtureQuizTask, soleGradedTask } from '../../test/quiz-fixture';
import { RECORD_CHANGE_FLOOR, RECORD_RUNBOOK_FLOOR, RECORD_TICKET, recordPack } from '../../test/record-pack';
import { FIRST_PHASE_GATE, learnerPreviewOf, previewGateSentence } from './learner-preview';

/**
 * The learner preview's builder, at unit level.
 *
 * - **The sealed-byte sweep.** The preview of
 *   the shelf draft (compiled in-process from `upload-packs/shelf`, read-only,
 *   with sentinels planted in an in-memory mirror of it (an interview, a quiz
 *   with a sign-off beside it, and a marker in every scoring field the pack
 *   carries; the six shelf-fixture markers already sit in its sealed files)) is
 *   serialised and must hold none of them, while the compiled snapshot holds
 *   every one (the sweep reads real planted bytes, or it reads nothing). Then
 *   a structural sweep over TaskTrackr, the planted shelf and the starter
 *   fixture: every line of 28+ characters of
 *   every sealed store the snapshot carries (hidden tests, solutions,
 *   references, impl, support, mutants, drill faults, rule patterns and fail
 *   details, interview answers, topics, keywords and replies, quiz keys and
 *   explanations, rubric descriptions and mentor prompts) that no
 *   learner-visible field of the same snapshot holds must be absent from the
 *   preview.
 * - **The gate sentence**: phases 2 to 6 name the previous phase and the sign-off.
 * - **The interview card**: the persona and the opening, only.
 * - **Purity**: the builder's import graph holds no provider, sandbox,
 *   grader, `RunGate`, repository or DI module, and the builder changes
 *   nothing it is handed.
 *
 * Parity with the learner's payload, and that a preview writes nothing and
 * calls nothing, need the real application: `test/learner-preview.e2e-spec.ts`.
 */

/* --------------------------- type-level: exact keys --------------------------- */

type HasExactlyKeys<T, K extends PropertyKey> = [keyof T] extends [K]
  ? [K] extends [keyof T]
    ? true
    : false
  : false;

true satisfies HasExactlyKeys<LearnerPreviewView, (typeof LEARNER_PREVIEW_VIEW_KEYS)[number]>;
true satisfies HasExactlyKeys<LearnerPreviewPhase, (typeof LEARNER_PREVIEW_PHASE_KEYS)[number]>;
true satisfies HasExactlyKeys<LearnerPreviewFile, (typeof LEARNER_PREVIEW_FILE_KEYS)[number]>;
true satisfies HasExactlyKeys<LearnerPreviewTask, (typeof LEARNER_PREVIEW_TASK_KEYS)[number]>;
true satisfies HasExactlyKeys<LearnerPreviewQuiz, (typeof LEARNER_PREVIEW_QUIZ_KEYS)[number]>;
true satisfies HasExactlyKeys<LearnerPreviewQuizQuestion, (typeof LEARNER_PREVIEW_QUESTION_KEYS)[number]>;
true satisfies HasExactlyKeys<LearnerPreviewInterview, (typeof LEARNER_PREVIEW_INTERVIEW_KEYS)[number]>;
true satisfies HasExactlyKeys<LearnerPreviewInterview['persona'], 'name' | 'role'>;

/* --------------------------------- the packs --------------------------------- */

const TASKTRACKR_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'content', 'tasktrackr');
/** The starter fixture; if it is absent, the sweep's starter arm says so by name. */
const STARTER_DIR = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'upload-packs', 'starter');

/** Every scoring or sealed field this spec plants a marker in, beside the shelf fixture's six. */
const PLANTED = {
  factTopic: 'PVS-FACT-TOPIC-4Q7L',
  factAnswer: 'PVS-FACT-ANSWER-8D2X',
  factKeyword: 'pvskeywordzq',
  unknownReply: 'PVS-UNKNOWN-REPLY-6N3B',
  refusal: 'PVS-REFUSAL-REPLY-1W9K',
  designRubric: 'PVS-DESIGN-RUBRIC-5C8M',
  designPrompt: 'PVS-DESIGN-PROMPT-2H6R',
  rubricDescription: 'PVS-RUBRIC-DESC-7T4J',
  mentorPrompt: 'PVS-MENTOR-PROMPT-3V5P',
  mentorHint: 'PVS-MENTOR-HINT-9G1F',
  mutantMeta: 'PVS-MUTANT-META-4K2S',
  drillDescription: 'PVS-DRILL-DESC-8B7Y',
  quizKeyOption: 'PVS-QUIZ-KEY-OPTION-6Z3E',
  quizExplanation: 'PVS-QUIZ-EXPLANATION-5L1U',
  quizConcept: 'PVS-QUIZ-CONCEPT-2A9N',
} as const;
const SENTINELS: string[] = [...Object.values(SHELF_MARKERS), ...Object.values(PLANTED)];

/** The learner-visible positive controls the planted mirror carries. */
const PERSONA = { name: 'Ines Moreau', role: 'circulation desk lead at the Shelf library' };
const OPENING = 'Ines here, from the circulation desk. Ask me what you need about the shelf.';
const QUIZ_KEY = 'pv-loans-check';
const QUIZ_STEM = 'Which shelf order does the loan desk read first?';

/**
 * The shelf fixture, mirrored in memory with the markers planted
 * (`upload-packs/shelf` is read, never written). The mirror exists only in
 * memory.
 */
function plantedShelfEntries(): { name: string; bytes: Buffer }[] {
  const entries = entriesOf(SHELF_DIR).map((one) => ({ name: one.name, bytes: one.data }));
  const at = (name: string) => {
    const found = entries.find((one) => one.name === name);
    if (!found) throw new Error(`the shelf fixture has no ${name}`);
    return found;
  };
  const json = (name: string, edit: (doc: any) => void) => {
    const entry = at(name);
    const doc = JSON.parse(entry.bytes.toString('utf-8'));
    edit(doc);
    entry.bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  };
  // the interview is planted as the phase's own interview.json (pushed below), which the folder layout reads by name
  json('phases/01-requirements/phase.json', (doc) => {
    doc.rubric.criteria[0].description = `${doc.rubric.criteria[0].description} ${PLANTED.rubricDescription}`;
    doc.assistant.systemPrompt = `${doc.assistant.systemPrompt} ${PLANTED.mentorPrompt}`;
    doc.assistant.topics[0].hints[0] = `${doc.assistant.topics[0].hints[0]} ${PLANTED.mentorHint}`;
  });
  // Requirements is a story phase and Design a design phase, so the shelf carries no written rule;
  // the Design phase's rubric and mentor prompt carry markers of their own (TaskTrackr's
  // markdown Design keeps the rule patterns and fail details in the structural sweep).
  json('phases/02-design/phase.json', (doc) => {
    doc.rubric.criteria[0].description = `${doc.rubric.criteria[0].description} ${PLANTED.designRubric}`;
    doc.assistant.systemPrompt = `${doc.assistant.systemPrompt} ${PLANTED.designPrompt}`;
  });
  json('phases/05-deployment/phase.json', (doc) => {
    doc.checks.drill.description = `${doc.checks.drill.description} ${PLANTED.drillDescription}`;
  });
  json('phases/04-testing/mutants/lend_twice_allowed/meta.json', (doc) => {
    doc.description = `${doc.description} ${PLANTED.mutantMeta}`;
  });
  entries.push({
    name: 'phases/01-requirements/interview.json',
    bytes: Buffer.from(
      `${JSON.stringify(
        {
          persona: PERSONA,
          opening: OPENING,
          unknownReply: `I have not thought about that. ${PLANTED.unknownReply}`,
          refusal: `That wording is yours to write. ${PLANTED.refusal}`,
          maxTurns: 8,
          factsExpected: 2,
          facts: [
            { id: 'f1', topic: `Who asks ${PLANTED.factTopic}`, keywords: ['who', PLANTED.factKeyword], answer: `Members at the desk ask. ${PLANTED.factAnswer}` },
            { id: 'f2', topic: 'What they need', keywords: ['need'], answer: 'They need to know which books are free to borrow today.' },
            { id: 'f3', topic: 'Why it matters', keywords: ['why'], answer: 'A wasted walk to the shelf costs a member their lunch break.' },
          ],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    ),
  });
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function load(source: PackSource): ProjectContent {
  return new ContentService().loadProject(source);
}

/** The quiz planted beside Requirements' own task: its key, explanations and concepts carry markers. */
function plantedQuiz(): QuizChecks {
  const option = (id: string, text: string) => ({ id, text });
  return {
    kind: 'quiz',
    questions: [
      {
        id: 'q1',
        stem: QUIZ_STEM,
        options: [option(PLANTED.quizKeyOption, 'Free to borrow first'), option('b', 'Alphabetical by title')],
        correct: [PLANTED.quizKeyOption],
        explanation: `The desk reads availability first. ${PLANTED.quizExplanation}`,
        concept: PLANTED.quizConcept,
      },
      {
        id: 'q2',
        stem: 'Which two facts must a loan record hold?',
        options: [option('a', 'The borrower'), option('b', 'The due date'), option('c', 'The shelf colour')],
        correct: ['a', 'b'],
        explanation: 'A loan names who has the book and when it comes back.',
      },
      {
        id: 'q3',
        stem: 'Who decides what SH-5 must do?',
        options: [option('a', 'The member who asked'), option('b', 'The tester')],
        correct: ['a'],
        explanation: 'The need is the member’s.',
      },
    ],
    drawn: 2,
    shuffleOptions: true,
    passMark: 50,
    attempts: { max: 3, cooldownSeconds: null },
    criterion: 'concepts',
  };
}

/** The planted shelf, compiled the importer's way, with Requirements' work task marked for sign-off and a quiz beside it. */
function plantedShelf(): CompiledSnapshot {
  const content = load(new MemoryPackSource(plantedShelfEntries() as never, 'shelf-sentinel'));
  const requirements = content.phases.find((one) => one.key === 'requirements') as PhaseContent;
  const authored: Record<string, AuthoredTask[]> = {
    requirements: [
      { ...soleGradedTask(requirements), signOff: true, title: 'Write SH-5' },
      fixtureQuizTask(QUIZ_KEY, 2, { title: 'Loans, checked', required: true }, plantedQuiz()),
    ],
  };
  return compilePack(content, { authored });
}

/** A minimal story check: one provided story carrying one criterion. */
const STORY_CHECKS: StoryChecks = {
  kind: 'story',
  record: 'requirements/story.json',
  providedStories: [
    { id: 'US-1', title: 'Borrow a book', persona: 'member', capability: 'borrow a book', benefit: 'read it at home',
      criteria: [{ id: 'AC-1', given: 'a free copy', when: 'I borrow it', then: 'it is on my loans', tag: 'happy' }] },
  ],
  learnerStory: { id: 'US-4', hints: { persona: 'circulation desk lead' } },
  floor: { minCriteria: 2, requiredTags: ['happy', 'boundary'], minExclusions: 1, requireSentence: true },
};

/** A copy of the snapshot whose Requirements phase is graded as a story, so the preview carries `story`. */
function withStoryPhase(compiled: CompiledSnapshot): CompiledSnapshot {
  const copy = structuredClone(compiled);
  const requirements = copy.content.phases.find((one) => one.key === 'requirements') as PhaseContent;
  requirements.checks = structuredClone(STORY_CHECKS);
  return copy;
}

/** The keys `PhaseDetail.story` carries at any depth: none names sealed or scoring content. */
const STORY_KEYS = [
  'story', 'id', 'hints', 'persona', 'capability', 'benefit', 'floor', 'minCriteria', 'requiredTags',
  'minExclusions', 'requireSentence', 'providedStories', 'title', 'criteria', 'given', 'when', 'then', 'tag',
] as const;

/** A minimal design check: both contracts on, the sequence diagram on, one story to trace to. */
const DESIGN_CHECKS: DesignChecks = {
  kind: 'design',
  record: 'design/design.json',
  contracts: { api: true, screens: true },
  sequence: true,
  stories: [{ id: 'US-1', title: 'Borrow a book', line: 'As a member I want to borrow a book so that I can read it at home.' }],
  floor: { ...DEFAULT_DESIGN_FLOOR },
};

/** A copy of the snapshot whose Design phase is graded as a design, so the preview carries `design`. */
function withDesignPhase(compiled: CompiledSnapshot): CompiledSnapshot {
  const copy = structuredClone(compiled);
  const design = copy.content.phases.find((one) => one.key === 'design') as PhaseContent;
  design.checks = structuredClone(DESIGN_CHECKS);
  return copy;
}

/** The keys `PhaseDetail.design` carries at any depth: none names sealed or scoring content. */
const DESIGN_KEYS = ['design', 'contracts', 'api', 'screens', 'sequence', 'stories', 'line', ...Object.keys(DEFAULT_DESIGN_FLOOR)];

/**
 * The keys `PhaseDetail.runbook` and `PhaseDetail.change` carry at any depth.
 * `runbook.drill` is the one allowed key that shares a forbidden name: it is
 * the boolean "this phase drills", never the sealed `checks.drill` spec, and
 * the walk exempts it at that place only, asserting a boolean.
 */
const RUNBOOK_KEYS = ['runbook', 'floor', ...Object.keys(RECORD_RUNBOOK_FLOOR)];
const CHANGE_KEYS = ['change', 'ticket', 'id', 'title', 'summary', 'acceptance', 'line', 'contract', 'floor', ...Object.keys(RECORD_CHANGE_FLOOR)];

/** Every key at every depth, without each phase's `runbook.drill`, which must be a boolean. */
function keysBesideRunbookDrill(view: LearnerPreviewView): Set<string> {
  return keysOf(view.phases.map((phase) => {
    if (!phase.runbook) return phase;
    expect(typeof phase.runbook.drill).toBe('boolean');
    const { drill: _drill, ...runbook } = phase.runbook;
    return { ...phase, runbook };
  }));
}

function tasktrackr(): CompiledSnapshot {
  return compilePack(load(new DirectoryPackSource(TASKTRACKR_DIR)));
}

/** The starter, as an upload stores it: its interview is its own interview.json. */
function starter(): CompiledSnapshot {
  return compilePack(load(new DirectoryPackSource(STARTER_DIR)));
}

/* ------------------------------ the sweep's needles ------------------------------ */

const NEEDLE_MIN = 28;

/** Every string a sealed or scoring store of the snapshot holds, by where it came from. */
function sealedStringsOf(compiled: CompiledSnapshot): string[] {
  const out: string[] = [];
  const files = (record: Record<string, string> | undefined) => out.push(...Object.values(record ?? {}));
  const checksSeen = new Set<unknown>();
  for (const phase of compiled.content.phases) {
    const tasks = compiled.phases.find((one) => one.key === phase.key)?.tasks ?? [];
    for (const checks of [phase.checks, ...tasks.map((task) => checksOf(phase, task))]) {
      if (checksSeen.has(checks)) continue;
      checksSeen.add(checks);
      const any = checks as any;
      files(any.hiddenTestFiles);
      files(any.solutionFiles);
      files(any.referenceTestFiles);
      files(any.implFiles);
      files(any.supportFiles);
      for (const run of any.runs ?? []) {
        files(run.hiddenTestFiles);
        files(run.referenceTestFiles);
        files(run.implFiles);
        files(run.supportFiles);
      }
      for (const mutant of any.mutants ?? []) {
        files(mutant.files);
        out.push(mutant.description ?? '');
      }
      if (any.drill) {
        files(any.drill.faultedFiles);
        out.push(any.drill.description ?? '');
      }
      for (const rule of any.rules ?? []) out.push(rule.pattern ?? '', rule.forbidden ?? '', rule.failDetail ?? '');
      if (checks.kind === 'quiz') {
        for (const question of checks.questions) {
          out.push(question.explanation, question.concept ?? '', ...question.correct);
        }
      }
    }
    for (const task of tasks) out.push(...task.rubric.criteria.map((criterion) => criterion.description));
    out.push(...phase.rubric.criteria.map((criterion) => criterion.description));
    out.push(phase.assistant.systemPrompt, ...phase.assistant.progressive, ...phase.assistant.topics.flatMap((topic) => topic.hints));
    if (phase.interview) {
      out.push(phase.interview.unknownReply, phase.interview.refusal);
      for (const fact of phase.interview.facts) out.push(fact.topic, fact.answer, fact.keywords.join(' '));
    }
  }
  return out.filter(Boolean);
}

/**
 * What a learner of this snapshot can read, from the snapshot itself and
 * never from the preview: the workspace bytes, the brief, the words of each
 * phase and task, the stakeholder's name and opening, and each quiz's stems
 * and options. A sealed line that is also one of these is visible by design
 * (TaskTrackr's dual-role files are the shipped example) and is not a needle.
 */
function learnerVisibleOf(compiled: CompiledSnapshot): string {
  const parts: string[] = [];
  for (const phase of compiled.content.phases) {
    parts.push(phase.title, phase.intro, phase.taskPanel, phase.runLabel, ...phase.objectives);
    parts.push(...phase.files.map((file) => file.content));
    parts.push(...phase.rubric.criteria.map((criterion) => criterion.title));
    if (phase.interview) parts.push(phase.interview.persona.name, phase.interview.persona.role, phase.interview.opening);
    for (const task of compiled.phases.find((one) => one.key === phase.key)?.tasks ?? []) {
      parts.push(task.title);
      const checks = checksOf(phase, task);
      if (checks.kind === 'quiz') {
        for (const question of checks.questions) parts.push(question.stem, ...question.options.map((option) => option.text));
      }
    }
  }
  return parts.join('\n');
}

function needlesOf(strings: string[], visible: string): { needles: string[]; visibleByDesign: number } {
  const lines = [...new Set(strings.flatMap((text) => text.split('\n')).map((line) => line.trim()))].filter(
    (line) => line.length >= NEEDLE_MIN,
  );
  const needles = lines.filter((line) => !visible.includes(line));
  return { needles, visibleByDesign: lines.length - needles.length };
}

/** A needle in its raw and its JSON-escaped form, so a serialised answer cannot hide one behind an escape. */
function leaked(serialised: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => serialised.includes(needle) || serialised.includes(JSON.stringify(needle).slice(1, -1)));
}

/** Every key at every depth of a JSON value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((one) => keysOf(one, into));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysOf(inner, into);
    }
  }
  return into;
}

/* ---------------------------- the sealed-byte sweep ---------------------------- */

describe('learnerPreviewOf: the sealed-byte sweep', () => {
  const compiled = plantedShelf();
  const preview = learnerPreviewOf(compiled);
  const serialised = JSON.stringify(preview);

  it('reads real planted bytes: every sentinel is in the compiled shelf', () => {
    const snapshot = JSON.stringify(compiled);
    expect(SENTINELS.filter((sentinel) => !snapshot.includes(sentinel))).toEqual([]);
  });

  it('the shelf draft preview holds none of them', () => {
    expect(leaked(serialised, SENTINELS)).toEqual([]);
  });

  it('…and the learner-visible controls are there (the sweep reads a real preview)', () => {
    const requirements = preview.phases[0];
    const record = compiled.content.phases[0].files.find((file) => file.path === 'requirements/story.json');
    expect(record).toBeDefined();
    expect(requirements.files.find((file) => file.path === record!.path)?.content).toBe(record!.content);
    expect(requirements.story?.providedStories.map((one) => one.id)).toEqual(['SH-1', 'SH-2', 'SH-3', 'SH-4']);
    expect(requirements.interview).toEqual({ persona: PERSONA, opening: OPENING });
    expect(requirements.quizzes[0].questions[0].stem).toBe(QUIZ_STEM);
    expect(serialised).toContain('Free to borrow first');
  });

  it('carries no key named for sealed or scoring content, at any depth', () => {
    // The same draft with Requirements graded as a story, so the walk covers `story` too.
    const storyPreview = learnerPreviewOf(withStoryPhase(compiled));
    expect(storyPreview.phases[0].story?.providedStories[0].criteria).toHaveLength(1);
    // And with Design graded as a design, so the walk covers `design` too.
    const designPreview = learnerPreviewOf(withDesignPhase(compiled));
    expect(designPreview.phases.find((one) => one.key === 'design')?.design).toEqual({
      contracts: DESIGN_CHECKS.contracts, sequence: true, stories: DESIGN_CHECKS.stories, floor: DESIGN_CHECKS.floor,
    });
    // And TaskTrackr with a runbook and a change request, so the walk covers `runbook` and `change`.
    const recordPreview = learnerPreviewOf(compilePack(load(recordPack())));
    expect(recordPreview.phases.find((one) => one.key === 'deployment')?.runbook).toEqual({ floor: RECORD_RUNBOOK_FLOOR, drill: true });
    expect(recordPreview.phases.find((one) => one.key === 'maintenance')?.change).toEqual({ ticket: RECORD_TICKET, contract: true, floor: RECORD_CHANGE_FLOOR });
    // Shelf's Deployment carries a runbook too since its records, so every view is walked without runbook.drill.
    const keys = new Set<string>();
    for (const view of [preview, storyPreview, designPreview, recordPreview]) for (const key of keysBesideRunbookDrill(view)) keys.add(key);
    expect(LEARNER_PREVIEW_FORBIDDEN_KEYS.filter((key) => keys.has(key))).toEqual([]);
    // The allowed lists themselves are disjoint from the forbidden one.
    const allowed = new Set<string>([
      ...LEARNER_PREVIEW_VIEW_KEYS,
      ...LEARNER_PREVIEW_PHASE_KEYS,
      ...LEARNER_PREVIEW_FILE_KEYS,
      ...LEARNER_PREVIEW_TASK_KEYS,
      ...LEARNER_PREVIEW_QUIZ_KEYS,
      ...LEARNER_PREVIEW_QUESTION_KEYS,
      ...LEARNER_PREVIEW_INTERVIEW_KEYS,
      ...STORY_KEYS,
      ...DESIGN_KEYS,
      ...RUNBOOK_KEYS,
      ...CHANGE_KEYS,
      'name',
      'role',
    ]);
    expect(LEARNER_PREVIEW_FORBIDDEN_KEYS.filter((key) => allowed.has(key))).toEqual([]);
    expect([...keys].filter((key) => !allowed.has(key))).toEqual([]);
  });

  it('each shape holds exactly its allowed keys', () => {
    expect(Object.keys(preview).sort()).toEqual([...LEARNER_PREVIEW_VIEW_KEYS].sort());
    for (const phase of preview.phases) {
      expect(Object.keys(phase).sort()).toEqual([...LEARNER_PREVIEW_PHASE_KEYS].sort());
      for (const file of phase.files) expect(Object.keys(file).sort()).toEqual([...LEARNER_PREVIEW_FILE_KEYS].sort());
      for (const task of phase.tasks) expect(Object.keys(task).sort()).toEqual([...LEARNER_PREVIEW_TASK_KEYS].sort());
      for (const quiz of phase.quizzes) {
        expect(Object.keys(quiz).sort()).toEqual([...LEARNER_PREVIEW_QUIZ_KEYS].sort());
        for (const question of quiz.questions) {
          expect(Object.keys(question).sort()).toEqual([...LEARNER_PREVIEW_QUESTION_KEYS].sort());
        }
      }
    }
  });

  it('a quiz is its pool without the key: option words in authored order, no option id, `multiple` as the paper says', () => {
    const quiz = preview.phases[0].quizzes[0];
    expect(quiz).toEqual({
      taskKey: QUIZ_KEY,
      title: 'Loans, checked',
      drawn: 2,
      passMark: 50,
      questions: [
        { id: 'q1', stem: QUIZ_STEM, options: ['Free to borrow first', 'Alphabetical by title'], multiple: false },
        { id: 'q2', stem: 'Which two facts must a loan record hold?', options: ['The borrower', 'The due date', 'The shelf colour'], multiple: true },
        { id: 'q3', stem: 'Who decides what SH-5 must do?', options: ['The member who asked', 'The tester'], multiple: false },
      ],
    });
  });

  it('a task carries its title, its kind and whether it needs a sign-off, and nothing it is scored by', () => {
    expect(preview.phases[0].tasks).toEqual([
      { key: 'main', order: 1, required: true, title: 'Write SH-5', artefactType: 'user-story', evidence: 'signed-off', needsSignOff: true },
      { key: QUIZ_KEY, order: 2, required: true, title: 'Loans, checked', artefactType: 'quiz', evidence: 'automated', needsSignOff: false },
    ]);
    for (const phase of preview.phases.slice(1)) {
      for (const task of phase.tasks) expect(task.needsSignOff).toBe(task.evidence === 'signed-off');
    }
  });

  it('the workspace is the learner-mountable rows only, editable and locked, with their flags', () => {
    for (const [at, phase] of preview.phases.entries()) {
      const mounted = compiled.content.phases[at].files;
      expect(phase.files).toEqual(
        mounted.map((file) => ({ path: file.path, content: file.content, editable: file.editable, language: file.language })),
      );
    }
    const implementation = preview.phases.find((phase) => phase.key === 'implementation')!;
    expect(implementation.files.some((file) => file.editable)).toBe(true);
    expect(implementation.files.some((file) => /hidden/i.test(file.path))).toBe(false);
  });

  it('the run and check labels a learner sees: canRun, runLabel and the criteria titles', () => {
    for (const [at, phase] of preview.phases.entries()) {
      const source = compiled.content.phases[at];
      expect({ canRun: phase.canRun, runLabel: phase.runLabel, checkLabels: phase.checkLabels }).toEqual({
        canRun: source.canRun,
        runLabel: source.runLabel,
        checkLabels: source.rubric.criteria.map((criterion) => criterion.title),
      });
    }
  });

  describe.each([
    ['TaskTrackr', () => tasktrackr()],
    ['the planted shelf', () => plantedShelf()],
  ])('structural sweep: %s', (_name, build) => {
    it('no line of a sealed store that a learner cannot read reaches the preview', () => {
      const snapshot = build();
      const { needles, visibleByDesign } = needlesOf(sealedStringsOf(snapshot), learnerVisibleOf(snapshot));
      expect(needles.length).toBeGreaterThan(20);
      expect(visibleByDesign).toBeGreaterThanOrEqual(0);
      expect(leaked(JSON.stringify(learnerPreviewOf(snapshot)), needles)).toEqual([]);
    });
  });

  it('structural sweep: the starter', () => {
    const snapshot = starter();
    // The starter ships its interview, so the card exists.
    expect(learnerPreviewOf(snapshot).phases.some((phase) => phase.interview !== null)).toBe(true);
    const strings = sealedStringsOf(snapshot);
    const { needles } = needlesOf(strings, learnerVisibleOf(snapshot));
    expect(needles.length).toBeGreaterThan(20);
    expect(leaked(JSON.stringify(learnerPreviewOf(snapshot)), needles)).toEqual([]);
  });
});

/* ------------------------------ the gate sentence ------------------------------ */

describe('learnerPreviewOf: the gate sentence', () => {
  it('phases 2 to 6 name the phase before them and the sign-off; phase 1 opens first', () => {
    for (const compiled of [plantedShelf(), tasktrackr()]) {
      const preview = learnerPreviewOf(compiled);
      expect(preview.phases).toHaveLength(6);
      expect(preview.phases[0].gate).toBe(FIRST_PHASE_GATE);
      for (const [at, phase] of preview.phases.entries()) {
        if (at === 0) continue;
        const previous = preview.phases[at - 1];
        expect(phase.gate).toBe(
          `Learners open this after every task in ${previous.title} has passed and, where a task needs it, has been signed off.`,
        );
        expect(phase.gate).toContain(previous.title);
        expect(phase.gate).toMatch(/signed off/);
      }
    }
  });

  it('says "required" when the phase before holds an optional task, because an optional task moves no gate', () => {
    const tasks = plantedShelf().phases[0].tasks;
    expect(previewGateSentence('Requirements', tasks)).toBe(
      'Learners open this after every task in Requirements has passed and, where a task needs it, has been signed off.',
    );
    expect(previewGateSentence('Requirements', [tasks[0], { ...tasks[1], required: false }])).toBe(
      'Learners open this after every required task in Requirements has passed and, where a task needs it, has been signed off.',
    );
  });

  it('phases arrive in order, whatever order the snapshot lists them in', () => {
    const compiled = plantedShelf();
    const shuffled: CompiledSnapshot = {
      ...compiled,
      content: { ...compiled.content, phases: [...compiled.content.phases].reverse() },
    };
    expect(learnerPreviewOf(shuffled).phases.map((phase) => phase.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

/* ------------------------------ the interview card ------------------------------ */

describe('learnerPreviewOf: the interview card', () => {
  it('is the persona and the opening only, on the phase that declares an interview, and null elsewhere', () => {
    const compiled = plantedShelf();
    const preview = learnerPreviewOf(compiled);
    const card = preview.phases[0].interview!;
    expect(Object.keys(card).sort()).toEqual(['opening', 'persona']);
    expect(Object.keys(card.persona).sort()).toEqual(['name', 'role']);
    expect(card).toEqual({ persona: PERSONA, opening: OPENING });
    expect(preview.phases.slice(1).map((phase) => phase.interview)).toEqual([null, null, null, null, null]);
    const brief = compiled.content.phases[0].interview!;
    const serialised = JSON.stringify(card);
    for (const fact of brief.facts) {
      expect(serialised).not.toContain(fact.answer);
      expect(serialised).not.toContain(fact.topic);
      // The set, not each word: an ordinary keyword ("need") may be a word the opening says too.
      expect(serialised).not.toContain(JSON.stringify(fact.keywords));
    }
    expect(serialised).not.toContain(PLANTED.factKeyword);
    expect(serialised).not.toContain(brief.unknownReply);
    expect(serialised).not.toContain(brief.refusal);
  });

  it("TaskTrackr's room: its stakeholder's name, role and opening, and none of its ten answers", () => {
    const compiled = tasktrackr();
    const brief = compiled.content.phases.find((phase) => phase.key === 'requirements')!.interview!;
    const card = learnerPreviewOf(compiled).phases[0].interview;
    expect(card).toEqual({ persona: { name: brief.persona.name, role: brief.persona.role }, opening: brief.opening });
    expect(leaked(JSON.stringify(learnerPreviewOf(compiled)), brief.facts.map((fact) => fact.answer))).toEqual([]);
  });

  it('a draft with no interview previews none (the empty state)', () => {
    const shelf = compilePack(load(new DirectoryPackSource(SHELF_DIR)));
    expect(learnerPreviewOf(shelf).phases.every((phase) => phase.interview === null)).toBe(true);
  });
});

/* ------------------------------------ purity ------------------------------------ */

const BUILDER = path.join(__dirname, 'learner-preview.ts');

/** Every file `learner-preview.ts` reaches by a relative import, and every package it names. */
function importClosure(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  const IMPORT = /(?:import|export)\s[^'";]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while (pending.length) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const match of fs.readFileSync(file, 'utf-8').matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec.startsWith('.')) {
        packages.add(spec);
        continue;
      }
      const base = path.resolve(path.dirname(file), spec);
      const resolved = [`${base}.ts`, path.join(base, 'index.ts')].find((one) => fs.existsSync(one));
      if (!resolved) throw new Error(`${path.basename(file)} imports ${spec}, which does not resolve`);
      pending.push(resolved);
    }
  }
  return { files: [...files].map((file) => path.relative(path.resolve(__dirname, '..'), file)).sort(), packages: [...packages].sort() };
}

describe('learnerPreviewOf: purity', () => {
  it('imports no provider, sandbox, grader, RunGate, repository or DI module, at any depth', () => {
    const { files, packages } = importClosure(BUILDER);
    const forbiddenFile = /(\.service|\.provider|\.controller|\.module|\.guard|\.gateway|\.processor|\.entities?)\.ts$|sandbox|run-?gate|grader|feedback|openai|assistant|repository|execution|queue|workflow\.service/i;
    expect(files.filter((file) => forbiddenFile.test(file))).toEqual([]);
    expect(packages.filter((name) => name !== '@learnsdlc/shared' && name !== 'crypto')).toEqual([]);
    // What it does reach, named, so a new edge is a red line someone has to read.
    expect(files).toEqual([
      'authoring/learner-preview.ts',
      'content/blob.store.ts',
      'content/content.types.ts',
      'content/pack-compiler.ts',
      'content/screen-copy.ts',
      'content/task-units.ts',
      // what a learner reads of a text, plain: `@learnsdlc/shared` and a type only
      'workflow/learner-text.ts',
      'workflow/phase-detail-design.ts',
      'workflow/phase-detail-records.ts',
      'workflow/phase-detail-story.ts',
      'workflow/solution.reference.ts',
      'workflow/task-view.ts',
    ]);
  });

  it('names no DI, ORM or I/O symbol in its own source', () => {
    const source = fs.readFileSync(BUILDER, 'utf-8');
    for (const word of ['@Injectable', 'Repository', 'DataSource', 'EntityManager', 'ModuleRef', 'process.env', 'fetch(', 'readFileSync']) {
      expect(source).not.toContain(word);
    }
  });

  it('changes nothing it is handed, and answers the same twice', () => {
    const compiled = plantedShelf();
    const before = canonicalJson(compiled);
    const first = learnerPreviewOf(compiled);
    expect(canonicalJson(compiled)).toBe(before);
    expect(canonicalJson(learnerPreviewOf(compiled))).toBe(canonicalJson(first));
    // And the answer shares no object with the snapshot: editing it cannot edit the draft.
    first.phases[0].objectives.push('mutated');
    first.phases[0].files[0].content = 'mutated';
    expect(canonicalJson(compiled)).toBe(before);
    // Nor does the story a story phase carries: its hints, floor, stories and criteria are copies.
    const storied = withStoryPhase(compiled);
    const storiedBefore = canonicalJson(storied);
    const story = learnerPreviewOf(storied).phases[0].story!;
    story.hints.persona = 'mutated';
    story.floor.requiredTags.push('error');
    story.providedStories[0].title = 'mutated';
    story.providedStories[0].criteria![0].then = 'mutated';
    story.providedStories.push({ ...story.providedStories[0] });
    expect(canonicalJson(storied)).toBe(storiedBefore);
    // Nor does the design spec a design phase carries: its switches, stories and floor are copies.
    const designed = withDesignPhase(compiled);
    const designedBefore = canonicalJson(designed);
    const design = learnerPreviewOf(designed).phases.find((one) => one.key === 'design')!.design!;
    design.contracts.api = false;
    design.stories[0].title = 'mutated';
    design.stories.push({ ...design.stories[0] });
    design.floor.minEntities = 99;
    expect(canonicalJson(designed)).toBe(designedBefore);
  });
});
