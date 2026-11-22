import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_QUIZ_PASS_MARK, EMPTY_STORY, serialiseStory, type PhaseKey, type PhaseRubric, type QuizChecks, type QuizQuestion } from '@learnsdlc/shared';
import type {
  ConfigChecks,
  ContentFileSpec,
  FileRule,
  PhaseChecks,
  PhaseContent,
  ProjectContent,
  StoryChecks,
} from '../src/content/content.types';
import { compilePack, type AuthoredTask, type CompiledSnapshot } from '../src/content/pack-compiler';
import { uploadPack } from './fixtures/paths';

/**
 * The FIXTURE quiz: test scaffolding, and nothing a learner should ever see.
 *
 * Specs need a compiled quiz to build against, on a **written** phase and on
 * an **executable** one, and real questions are content that is written and
 * reviewed with a pack. So this file ships one deliberately synthetic quiz
 * instead: the stems say what
 * they are, the options say which one the fixture keys, and the explanations
 * explain nothing but the fixture. Nothing here is a concept check, nothing
 * here has been reviewed, and nothing here belongs in a pack.
 *
 * It is a helper beside `mock-ai.ts` for exactly the same reason that one is:
 * the shape has to be identical everywhere it is asserted, or two specs prove
 * two different things.
 *
 * **TaskTrackr is not touched by any of it.** These fixtures are hand-built
 * packs, so `content-golden.spec.ts` and `verdict-golden.spec.ts` cannot move.
 */

/** Said once, so a reader who greps for a real question finds this instead. */
export const FIXTURE_QUIZ_NOTICE =
  'Synthetic fixture quiz. It teaches nothing and has been reviewed by nobody; the starter questions are written by the owner’s team.';

/**
 * `count` obviously-fake questions, keyed `q1..qN`.
 *
 * Every one keys option `a` and every one offers a second option keyed `b`, so
 * a spec can hand in a whole right paper (`a` everywhere), a whole wrong one
 * (`b` everywhere) or any mixture, and know the score without reading the key.
 */
export function fixtureQuizQuestions(count = 5, prefix = 'q'): QuizQuestion[] {
  return Array.from({ length: count }, (_, at) => {
    const id = `${prefix}${at + 1}`;
    return {
      id,
      stem: `Fixture question ${at + 1}. This is test scaffolding and teaches nothing — option A is the one this fixture keys.`,
      options: [
        { id: 'a', text: 'Option A — the option this fixture keys as right.' },
        { id: 'b', text: 'Option B — the option this fixture keys as wrong.' },
      ],
      correct: ['a'],
      explanation: `Fixture explanation ${at + 1}. Option A is right because the fixture says so, which is the whole of it.`,
      concept: `fixture-concept-${at + 1}`,
    };
  });
}

/**
 * A quiz slice: five fixture questions, drawing three, `DEFAULT_QUIZ_PASS_MARK`
 * and three attempts: the defaults a **required** quiz is created with, so a
 * fixture that is marked required already clears
 * `quiz-retake-is-a-new-paper`.
 */
export function fixtureQuizChecks(over: Partial<QuizChecks> = {}): QuizChecks {
  return {
    kind: 'quiz',
    questions: fixtureQuizQuestions(),
    drawn: 3,
    shuffleOptions: true,
    passMark: DEFAULT_QUIZ_PASS_MARK,
    attempts: { max: 3, cooldownSeconds: null },
    criterion: 'concepts',
    ...over,
  };
}

/** A quiz task's rubric: one criterion, weight 1, keyed by the quiz's own. */
export function fixtureQuizRubric(criterion = 'concepts', passThreshold = 70): PhaseRubric {
  return {
    passThreshold,
    criteria: [
      {
        key: criterion,
        title: 'Concepts',
        weight: 1,
        description: 'Scored by the quiz your teacher set.',
      },
    ],
  };
}

/**
 * An authored quiz task: owns no path, mints no artefact, declares its own
 * slice, and carries the one-criterion rubric `quiz-rubric-key-is-the-quiz's`
 * holds it to.
 */
export function fixtureQuizTask(
  taskKey: string,
  order: number,
  over: Partial<AuthoredTask> = {},
  checks: QuizChecks = fixtureQuizChecks(),
): AuthoredTask {
  return {
    taskKey,
    order,
    required: false,
    artefactType: 'quiz',
    artefactPath: null,
    title: `Fixture quiz "${taskKey}"`,
    brief: FIXTURE_QUIZ_NOTICE,
    owns: [],
    gradedUnits: checks.questions.map((question) => ({ kind: 'question' as const, id: question.id })),
    rubric: fixtureQuizRubric(checks.criterion),
    checks,
    ...over,
  };
}

/* ------------------------------ the two packs ----------------------------- */

const file = (path: string, language: string): ContentFileSpec => ({
  path,
  content: `# ${path}\n`,
  editable: true,
  language,
});

/** A config phase's rule over the file it names, which `FileRule` requires. */
const fileRule = (id: string, criterion: string, target: string): FileRule => ({
  id,
  label: id,
  criterion,
  pattern: 'x',
  required: true,
  failDetail: 'no',
  target,
});

const rubricOf = (...keys: string[]): PhaseRubric => ({
  passThreshold: 70,
  criteria: keys.map((key) => ({ key, title: key, weight: 1 / keys.length, description: 'd' })),
});

const phaseOf = (
  key: PhaseKey,
  order: number,
  checks: PhaseChecks,
  files: ContentFileSpec[],
  rubric: PhaseRubric,
): PhaseContent => ({
  key,
  order,
  title: `the ${key} phase`,
  intro: 'i',
  artifactKind: checks.kind,
  language: 'python',
  canRun: true,
  runLabel: 'Run',
  taskPanel: 'the phase brief',
  objectives: ['one'],
  files,
  rubric,
  checks,
  assistant: { systemPrompt: 's', topics: [], progressive: [] },
  canPreview: false,
});

/** The story phase's record, which it mounts editable. */
export const STORY_RECORD = 'requirements/story.json';
/** The config file the executable phase's first rule reads, beside its Dockerfile. */
export const COMPOSE = 'docker-compose.yml';
export const DOCKERFILE = 'api/Dockerfile';

/** Shelf's Requirements checks (the upload fixture's), the story the written phase grades. */
const SHELF_STORY_CHECKS = (
  JSON.parse(readFileSync(join(uploadPack('shelf'), 'phases/01-requirements/phase.json'), 'utf8')) as { checks: StoryChecks }
).checks;

/** The written phase a quiz reaches with no rule change at all: a story phase graded by its floor. */
export function writtenPhase(): PhaseContent {
  const checks: StoryChecks = JSON.parse(JSON.stringify(SHELF_STORY_CHECKS));
  const record: ContentFileSpec = { path: checks.record, content: serialiseStory(EMPTY_STORY), editable: true, language: 'json' };
  return phaseOf('design', 1, checks, [record], rubricOf('clarity'));
}

/** The executable phase the all-six-phases rule reaches, drill included. */
export function executablePhase(withDrill = false): PhaseContent {
  const checks: ConfigChecks = {
    kind: 'config',
    rules: [fileRule('compose-env', 'clarity', COMPOSE), fileRule('docker-workdir', 'clarity', DOCKERFILE)],
    smokeImplFiles: {},
    smokeDockerfile: DOCKERFILE,
    smokeCommands: [['python3', 'ops/selfcheck.py']],
    expectInOutput: 'ok',
    ...(withDrill
      ? {
          drill: {
            fault: 'fixture-fault',
            description: 'a fixture fault',
            faultedFiles: { [DOCKERFILE]: 'FROM scratch\n' },
            expectFailure: true,
          },
        }
      : {}),
  };
  return phaseOf(
    'deployment',
    2,
    checks,
    [file(COMPOSE, 'yaml'), file(DOCKERFILE, 'dockerfile')],
    rubricOf('clarity'),
  );
}

/**
 * The phase's **sole non-quiz task**: it owns every editable path the phase
 * mounts and every graded unit it declares, and it declares no slice of its
 * own: the sole-task exemption, which keeps the stored snapshot from growing.
 */
export function soleGradedTask(phase: PhaseContent, taskKey = 'main'): AuthoredTask {
  return {
    taskKey,
    order: 1,
    required: true,
    owns: phase.files.filter((one) => one.editable).map((one) => one.path),
    gradedUnits:
      phase.checks.kind === 'config'
        ? phase.checks.rules.map((one) => ({ kind: 'rule' as const, id: one.id }))
        : phase.checks.kind === 'story'
          ? [{ kind: 'record' as const, id: phase.checks.record }]
          : [],
    rubric: phase.rubric,
  };
}

export function fixturePack(phases: PhaseContent[]): ProjectContent {
  return {
    slug: 'quiz-fixture',
    version: '1.0.0',
    title: 'the quiz fixture project',
    tagline: 't',
    description: 'd',
    language: 'python',
    languages: ['python'],
    phases,
  };
}

/**
 * **A compiled quiz version, on a written phase and on an executable one.**
 *
 * Both phases hold their one graded task and one optional fixture quiz beside
 * it, which is the shape the quiz specs build on: the design phase needs no
 * rule at all, and the deployment phase is the all-six-phases rule end to end.
 */
export function compiledQuizSnapshot(
  over: { required?: boolean; withDrill?: boolean } = {},
): CompiledSnapshot {
  const written = writtenPhase();
  const executable = executablePhase(over.withDrill ?? false);
  const quiz = (key: string): AuthoredTask =>
    fixtureQuizTask(key, 2, over.required ? { required: true } : {});
  return compilePack(fixturePack([written, executable]), {
    authored: {
      design: [soleGradedTask(written), quiz('design-check')],
      deployment: [soleGradedTask(executable), quiz('deployment-check')],
    },
  });
}
