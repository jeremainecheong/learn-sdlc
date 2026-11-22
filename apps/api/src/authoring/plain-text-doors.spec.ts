// Plain text at the API's doors and reads:
// every text a teacher writes is stored as `plainTextOf` of what was sent, a
// text already plain is stored byte for byte, and a learner of a published
// version that still holds markdown reads each text plain, its HTML comments
// not shown, while the stored bytes and the compiled snapshot stay as they
// are. The harness is `authoring.service.spec.ts`'s (the shipped TaskTrackr
// imported as the platform's published default, and a teacher's copy of it),
// with `workflow.service.spec.ts`'s learner read over the same database.
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  TASK_BRIEF_MAX,
  plainTextOf,
  type DesignChecksBody,
  type FeedbackReport,
  type PhaseKey,
  type QuizChecks,
  type StoryChecksBody,
  type SubmissionView,
} from '@learnsdlc/shared';
import { S1_TEACHER as teacher, copyTaskTrackr, openForkWorld, type Fork, type ForkWorld } from '../../test/tasktrackr-phase';
import { compiledQuizSnapshot } from '../../test/quiz-fixture';
import { LocalMentorProvider } from '../assistant/local.provider';
import { phaseScopeOf, taskScopeOf } from '../assistant/project-scope';
import type { MentorContext } from '../assistant/provider.types';
import type { DesignChecks, PhaseContent } from '../content/content.types';
import type { CompiledSnapshot, CompiledTask } from '../content/pack-compiler';
import { ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import {
  EnrollmentEntity,
  PhaseStateEntity,
  QuizAttemptEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { FeedbackService } from '../feedback/feedback.service';
import { scorePaper } from '../feedback/quiz-scoring';
import { conceptSubmissionView, conceptTask } from '../quiz/concept/concept';
import { QuizAttemptsService } from '../quiz/quiz-attempts.service';
import { QuizService, quizOpenPaper } from '../quiz/quiz.service';
import { RepoService } from '../repo/repo.service';
import { WorkflowService } from '../workflow/workflow.service';
import { isReferenceExecutablePhase } from './deep-validation';
import { requirePlainText, requireText, taskWordsPatch } from './draft';
import { DEEP_RECEIPT_CHECK_ID, quizRevealOptionalOnlyRefusal } from './validation';
import { memoryDataSource } from '../../test/support/memory-db';

let world: ForkWorld;
let workflow: WorkflowService;
let copies = 0;
const copy = (): Promise<Fork> => copyTaskTrackr(world, `plain-text-doors-${(copies += 1)}`);

const tasks = () => world.dataSource.getRepository(ProjectTaskEntity);
const phases = () => world.dataSource.getRepository(ProjectPhaseEntity);
const versions = () => world.dataSource.getRepository(ProjectVersionEntity);

const phaseRow = (versionId: string, key: PhaseKey) => phases().findOneByOrFail({ projectVersionId: versionId, key });
const taskRow = async (versionId: string, key: PhaseKey, taskKey = 'main') =>
  tasks().findOneByOrFail({ projectPhaseId: (await phaseRow(versionId, key)).id, taskKey });
/** The version row's compiled snapshot exactly as stored. */
const storedCompiled = async (versionId: string) => JSON.stringify((await versions().findOneByOrFail({ id: versionId })).compiled);

let learners = 0;
/** A learner enrolled on a project, and their phase states by key, each opened so a room can be read. */
const enrolled = async (slug: string): Promise<{ userId: string; stateOf: (key: PhaseKey) => Promise<string> }> => {
  const users = world.dataSource.getRepository(UserEntity);
  const learner = await users.save(
    users.create({ email: `plain-text-learner-${(learners += 1)}@learnsdlc.test`, passwordHash: 'x', displayName: 'Learner', role: 'LEARNER' }),
  );
  await workflow.enroll(learner.id, slug);
  const states = world.dataSource.getRepository(PhaseStateEntity);
  return {
    userId: learner.id,
    stateOf: async (key) => {
      const state = await states.findOneByOrFail({ userId: learner.id, phaseKey: key });
      if (state.status === 'locked') await states.update({ id: state.id }, { status: 'in_progress' });
      return state.id;
    },
  };
};

/** No markdown a learner could see: no heading mark, no strong or emphasis pair, no HTML comment. */
const readsPlain = (text: string): void => {
  expect(text).not.toMatch(/^#{1,6} /m);
  expect(text).not.toContain('**');
  expect(text).not.toContain('<!--');
};

beforeAll(async () => {
  Logger.overrideLogger(false);
  world = await openForkWorld();
  workflow = new WorkflowService(
    world.dataSource.getRepository(EnrollmentEntity),
    world.dataSource.getRepository(PhaseStateEntity),
    world.dataSource.getRepository(ReleaseRecordEntity),
    world.content,
    { latestFor: async () => null } as unknown as FeedbackService,
    world.dataSource,
  );
});
afterAll(async () => {
  await world?.close();
});

describe("the editor's doors store plain text", () => {
  it('stores a markdown brief, title and objectives sent to the executable arm as plain text, every word kept', async () => {
    const at = await copy();
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', {
      title: 'Fill the **gaps**',
      brief: '## Steps\n\n- **one**',
      objectives: ['Use `x`', 'Read the _overdue_ rule'],
    });
    const row = await taskRow(at.versionId, 'implementation');
    expect(row.title).toBe('Fill the gaps');
    // the list marker is kept and the code span keeps its backticks
    expect(row.brief).toBe('Steps\n\n- one');
    expect(row.objectives).toEqual(['Use `x`', 'Read the overdue rule']);
  });

  it("stores an intro, rubric sentences, a ticket's lines and a provided story's text as plain text", async () => {
    const at = await copy();
    await world.service.updatePhase(teacher, at.projectId, at.versionId, 'requirements', { intro: 'Read the **backlog** first.' });
    expect((await phaseRow(at.versionId, 'requirements')).intro).toBe('Read the backlog first.');

    // the story task: a provided story's words and its rubric's sentences, replaced whole
    const story = await taskRow(at.versionId, 'requirements');
    const checks = story.checks as unknown as StoryChecksBody & { record: string };
    const provided = checks.providedStories.map((one, i) =>
      i === 0
        ? { ...one, title: '**Overdue** report', capability: 'see the _overdue_ tasks', criteria: one.criteria?.map((c, j) => (j === 0 ? { ...c, given: 'a **due** task' } : c)) }
        : one,
    );
    const rubric = {
      passThreshold: story.rubric.passThreshold,
      criteria: story.rubric.criteria.map((c, i) => (i === 0 ? { ...c, title: '**Story** quality', description: '_Clear_ and testable.' } : c)),
    };
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'requirements', 'main', {
      story: { providedStories: provided, learnerStory: { ...checks.learnerStory, hints: { ...checks.learnerStory.hints, persona: 'Who is _late_?' } }, floor: checks.floor },
      rubric,
    });
    const savedStory = await taskRow(at.versionId, 'requirements');
    const stored = savedStory.checks as unknown as StoryChecksBody;
    expect(stored.providedStories[0]).toMatchObject({ title: 'Overdue report', capability: 'see the overdue tasks' });
    if (provided[0].criteria?.length) expect(stored.providedStories[0].criteria![0].given).toBe('a due task');
    expect(stored.learnerStory.hints.persona).toBe('Who is late?');
    expect(savedStory.rubric.criteria[0]).toMatchObject({ title: 'Story quality', description: 'Clear and testable.' });

    // a criterion reworded on its own (the written arm's `criteria`)
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'requirements', 'main', {
      criteria: [{ key: rubric.criteria[1].key, title: 'The **second**', description: 'Says _why_.' }],
    });
    expect((await taskRow(at.versionId, 'requirements')).rubric.criteria[1]).toMatchObject({ title: 'The second', description: 'Says why.' });

    // Maintenance's ticket: its title, its summary and each acceptance line
    const maintenance = await taskRow(at.versionId, 'maintenance');
    const ticket = (maintenance.checks as unknown as { ticket: { id: string; title: string; summary: string; acceptance: { id: string; line: string }[] } }).ticket;
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', {
      ticket: {
        ...ticket,
        title: '**Comments** on a task',
        summary: 'Let people _comment_.',
        acceptance: ticket.acceptance.map((one, i) => (i === 0 ? { ...one, line: '`add_comment` stores **one** comment.' } : one)),
      },
    });
    const savedTicket = ((await taskRow(at.versionId, 'maintenance')).checks as unknown as { ticket: typeof ticket }).ticket;
    expect(savedTicket.title).toBe('Comments on a task');
    expect(savedTicket.summary).toBe('Let people comment.');
    expect(savedTicket.acceptance[0].line).toBe('`add_comment` stores one comment.');
    expect(savedTicket.acceptance.slice(1)).toEqual(ticket.acceptance.slice(1));
  });

  it("stores a quiz's stem, options and explanations as plain text, and refuses a bad quiz in the words it was sent", async () => {
    const at = await copy();
    const question = (id: string) => ({
      id,
      stem: `What does **${id}** check?`,
      options: [{ id: 'a', text: 'The _overdue_ rule' }, { id: 'b', text: 'Nothing' }],
      correct: ['a'],
      explanation: 'Because **the rule** says so.',
    });
    await world.service.addTask(teacher, at.projectId, at.versionId, 'testing', {
      taskKey: 'recap',
      title: '**Recap** quiz',
      brief: 'Read **this** first.',
      objectives: ['Know the _rule_'],
      artefactType: 'quiz',
      required: false,
      quiz: { questions: [question('q1'), question('q2')] },
    });
    const row = await taskRow(at.versionId, 'testing', 'recap');
    expect([row.title, row.brief, row.objectives]).toEqual(['Recap quiz', 'Read this first.', ['Know the rule']]);
    const quiz = row.checks as unknown as QuizChecks;
    expect(quiz.questions[0]).toMatchObject({
      stem: 'What does q1 check?',
      options: [{ id: 'a', text: 'The overdue rule' }, { id: 'b', text: 'Nothing' }],
      explanation: 'Because the rule says so.',
    });

    // the whole paper replaced through `updateTask`'s quiz arm
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'testing', 'recap', {
      quiz: { questions: [question('q3'), question('q4')] },
    });
    const replaced = (await taskRow(at.versionId, 'testing', 'recap')).checks as unknown as QuizChecks;
    expect(replaced.questions.map((one) => one.stem)).toEqual(['What does q3 check?', 'What does q4 check?']);

    // a refusal names the title as the teacher sent it, and nothing is minted
    await expect(
      world.service.addTask(teacher, at.projectId, at.versionId, 'testing', {
        taskKey: 'gated',
        title: '**Gated** quiz',
        brief: 'A brief.',
        artefactType: 'quiz',
        required: true,
        quiz: { questions: [question('q1'), question('q2')], revealExplanation: 'always' },
      }),
    ).rejects.toThrow(quizRevealOptionalOnlyRefusal('**Gated** quiz'));
    await expect(taskRow(at.versionId, 'testing', 'gated')).rejects.toThrow();
  });

  it('leaves plain text byte for byte', async () => {
    const at = await copy();
    const brief = 'Open the file.\n\n1. Read the rule\n2. Write the test\n\n    def test_it():\n        assert add(1, 2) == 3\n\nKeep `__init__` and list_tasks as they are.';
    expect(plainTextOf(brief)).toBe(brief);
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', {
      title: 'Fill the gaps',
      brief,
      objectives: ['Use `x`'],
    });
    const row = await taskRow(at.versionId, 'implementation');
    expect([row.title, row.brief, row.objectives]).toEqual(['Fill the gaps', brief, ['Use `x`']]);
    const intro = 'Read the backlog first.\n\n- one\n- two';
    await world.service.updatePhase(teacher, at.projectId, at.versionId, 'design', { intro });
    expect((await phaseRow(at.versionId, 'design')).intro).toBe(intro);
  });
});

describe('a learner reads a published version plain', () => {
  it('shows a learner of a published version that holds markdown its brief as plain text, with HTML comments removed, and leaves the stored bytes alone', async () => {
    // TaskTrackr ships every brief plain (6.0.0), so the version holding a markdown brief is a copy published with
    // the brief written to its row directly, as a version published before texts were kept plain holds it
    const at = await copy();
    const story = await taskRow(at.versionId, 'requirements');
    await tasks().update({ id: story.id }, { brief: `## Your task\n\n<!-- only the teacher reads this -->\n${story.brief}` });
    await world.service.publish(teacher, at.projectId, at.versionId, { version: '1.0.0' });
    const before = await storedCompiled(at.versionId);
    expect(before).toContain('## Your task');
    expect(before).toContain('<!-- only the teacher reads this -->');
    const learner = await enrolled(`plain-text-doors-${copies}`);
    const detail = await workflow.phaseDetail(learner.userId, await learner.stateOf('requirements'));
    readsPlain(detail.taskPanel);
    expect(detail.taskPanel).toContain('Your task');
    expect(detail.tasks![0].brief).toBe(detail.taskPanel);
    // the summary still leaves the brief out
    expect((await workflow.phaseDetail(learner.userId, await learner.stateOf('requirements'), 'summary')).taskPanel).toBe('');
    expect(await storedCompiled(at.versionId)).toBe(before);
  });

  it('shows a learner of a published version whose objectives, intro, rubric sentences and story and ticket lines hold markdown each of them plain, and leaves the stored bytes unchanged', async () => {
    const at = await copy();
    // rows written directly, as a version published before texts were kept plain holds them: markdown in every member
    const requirements = await phaseRow(at.versionId, 'requirements');
    await phases().update({ id: requirements.id }, { intro: 'Read the **backlog** first.<!-- for teachers -->' });
    const story = await taskRow(at.versionId, 'requirements');
    const storyChecks = story.checks as unknown as StoryChecksBody;
    await tasks().update({ id: story.id }, {
      brief: '## Your task\n\n<!-- only the teacher reads this -->\nWrite **one** story.',
      objectives: ['**Name** the persona', 'Keep `__init__`'],
      rubric: { ...story.rubric, criteria: story.rubric.criteria.map((c, i) => (i === 0 ? { ...c, title: '**Story** quality', description: '_Clear_ and testable.' } : c)) },
      checks: {
        ...story.checks,
        providedStories: storyChecks.providedStories.map((one, i) =>
          i === 0 ? { ...one, title: '**Overdue** report', criteria: one.criteria?.map((c, j) => (j === 0 ? { ...c, then: 'it is **listed**' } : c)) } : one,
        ),
        learnerStory: { ...storyChecks.learnerStory, hints: { ...storyChecks.learnerStory.hints, persona: 'Who is _late_?' } },
      } as never,
    });
    const maintenance = await taskRow(at.versionId, 'maintenance');
    const code = maintenance.checks as unknown as { ticket: { title: string; summary: string; acceptance: { id: string; line: string }[] } };
    await tasks().update({ id: maintenance.id }, {
      checks: {
        ...maintenance.checks,
        ticket: { ...code.ticket, title: '**Comments** on a task', acceptance: code.ticket.acceptance.map((one, i) => (i === 0 ? { ...one, line: '`add_comment` stores **one**.' } : one)) },
      } as never,
    });
    await world.service.publish(teacher, at.projectId, at.versionId, { version: '1.0.0' });
    const before = await storedCompiled(at.versionId);
    expect(before).toContain('**Story** quality');

    const slug = `plain-text-doors-${copies}`;
    const learner = await enrolled(slug);
    const detail = await workflow.phaseDetail(learner.userId, await learner.stateOf('requirements'));
    expect(detail.intro).toBe('Read the backlog first.');
    readsPlain(detail.taskPanel);
    expect(detail.taskPanel).toContain('Write one story.');
    expect(detail.objectives).toEqual(['Name the persona', 'Keep `__init__`']);
    expect(detail.rubric.criteria[0]).toMatchObject({ title: 'Story quality', description: 'Clear and testable.' });
    expect(detail.story!.providedStories[0].title).toBe('Overdue report');
    if (storyChecks.providedStories[0].criteria?.length) expect(detail.story!.providedStories[0].criteria![0].then).toBe('it is listed');
    expect(detail.story!.hints.persona).toBe('Who is late?');
    // each task view reads the same, plain
    const main = detail.tasks!.find((one) => one.key === 'main')!;
    readsPlain(main.brief!);
    expect(main.objectives).toEqual(['Name the persona', 'Keep `__init__`']);
    expect(main.rubric!.criteria[0]).toMatchObject({ title: 'Story quality', description: 'Clear and testable.' });
    // the board's summary of the phase reads the intro plain too
    const board = await workflow.enrollmentView(await world.dataSource.getRepository(EnrollmentEntity).findOneByOrFail({ userId: learner.userId }));
    const summaryIntro = board.phases.find((one) => one.key === 'requirements')?.intro;
    expect(summaryIntro).toBeDefined();
    expect(summaryIntro).toBe('Read the backlog first.');

    const change = await workflow.phaseDetail(learner.userId, await learner.stateOf('maintenance'));
    expect(change.change!.ticket.title).toBe('Comments on a task');
    expect(change.change!.ticket.acceptance[0].line).toBe('`add_comment` stores one.');

    // the staff Learner preview shows a teacher what a learner reads
    const preview = await world.service.learnerPreview(teacher, at.projectId, at.versionId);
    const previewed = preview.phases.find((one) => one.key === 'requirements')!;
    expect([previewed.intro, previewed.brief, previewed.objectives]).toEqual([detail.intro, detail.taskPanel, detail.objectives]);
    expect(previewed.story).toEqual(detail.story);

    expect(await storedCompiled(at.versionId)).toBe(before);
    expect((await taskRow(at.versionId, 'requirements')).objectives).toEqual(['**Name** the persona', 'Keep `__init__`']);
  });

  it("shows the local mentor's hint of such a version plain", async () => {
    const shipped = world.content.getProject('tasktrackr').phases.find((one) => one.key === 'implementation')!;
    const phase: PhaseContent = {
      ...shipped,
      assistant: {
        ...shipped.assistant,
        topics: [{ keywords: ['overdue'], hints: ['Read the **overdue** rule <!-- note -->again.'] }],
        progressive: ['Start with the _first_ gap.'],
      },
    };
    const context = (message: string): MentorContext =>
      ({ phase, message, interactionCount: 0, topicUseCounts: {}, signals: { todosRemaining: [], lastFailedChecks: [] } }) as MentorContext;
    const mentor = new LocalMentorProvider();
    const topic = await mentor.chat(context('what is overdue?'));
    expect(topic.content).toContain('Read the overdue rule again.');
    readsPlain(topic.content);
    expect((await mentor.chat(context('help'))).content).toContain('Start with the first gap.');
    expect((await mentor.questionHint(context('give me the solution'))).content).toContain('Start with the first gap.');
    // the stored hint is untouched
    expect(phase.assistant.topics[0].hints[0]).toBe('Read the **overdue** rule <!-- note -->again.');
  });

  it("shows a learner a quiz's stems and options plain on the paper, and its explanations plain in the result", () => {
    const checks: QuizChecks = {
      kind: 'quiz',
      questions: [
        {
          id: 'q1',
          stem: 'What does **this** check?',
          options: [{ id: 'a', text: 'The _rule_' }, { id: 'b', text: 'Keep `x_y`' }],
          correct: ['a'],
          explanation: 'Because **the rule**.',
          concept: '_Overdue_ rule',
        },
      ],
      shuffleOptions: false,
      passMark: 50,
      attempts: { max: null, cooldownSeconds: null },
      criterion: 'concepts',
    };
    const row = { id: 'paper-1', startedAt: new Date(0), submittedAt: null, answers: null, paper: [{ questionId: 'q1', optionIds: ['a', 'b'] }] } as unknown as QuizAttemptEntity;
    const paper = quizOpenPaper(row, checks);
    expect(paper.questions[0].stem).toBe('What does this check?');
    expect(paper.questions[0].options.map((one) => one.text)).toEqual(['The rule', 'Keep `x_y`']);
    // marking stores the pinned version's texts as they are; the result is converted where it is read
    const scored = scorePaper(checks, row.paper, { q1: ['a'] });
    expect(scored.questions[0]).toMatchObject({ stem: 'What does **this** check?', explanation: 'Because **the rule**.', concept: '_Overdue_ rule' });
    expect(scored.questions[0].options.map((one) => one.text)).toEqual(['The _rule_', 'Keep `x_y`']);
    // the concept check's result is built from the paper at hand-in, and reads plain
    const after = { id: 'paper-1', taskKey: 'concept-after', submittedAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString() } as unknown as QuizAttemptEntity;
    const concept = conceptSubmissionView(after, scored, 100).report!.quiz!.questions[0];
    expect(concept).toMatchObject({ stem: 'What does this check?', explanation: 'Because the rule.', concept: 'Overdue rule' });
    expect(concept.options.map((one) => one.text)).toEqual(['The rule', 'Keep `x_y`']);
    expect(checks.questions[0].stem).toBe('What does **this** check?');
  });

  it("keeps a code span and a fenced block, their delimiters included, in a learner's read", async () => {
    const at = await copy();
    const brief = '## Build\n\nKeep `__init__` as it is.\n\n```yaml\n- name: build\n  run: make **all**\n```\n\n    indented_code = 1';
    const story = await taskRow(at.versionId, 'requirements');
    await tasks().update({ id: story.id }, { brief });
    await world.service.publish(teacher, at.projectId, at.versionId, { version: '1.0.0' });
    const learner = await enrolled(`plain-text-doors-${copies}`);
    const detail = await workflow.phaseDetail(learner.userId, await learner.stateOf('requirements'));
    expect(detail.taskPanel).toBe('Build\n\nKeep `__init__` as it is.\n\n```yaml\n- name: build\n  run: make **all**\n```\n\n    indented_code = 1');
  });

  it('shows a staff reader the stored text', async () => {
    const at = await copy();
    const story = await taskRow(at.versionId, 'requirements');
    const brief = '## Your task\n\n<!-- only the teacher reads this -->\nWrite **one** story.';
    await tasks().update({ id: story.id }, { brief, objectives: ['**Name** the persona'] });
    await phases().update({ id: (await phaseRow(at.versionId, 'requirements')).id }, { intro: 'Read the **backlog**.' });
    const view = await world.service.readDraft(teacher, at.projectId, at.versionId);
    const requirements = view.phases.find((one) => one.key === 'requirements')!;
    expect(requirements.intro).toBe('Read the **backlog**.');
    const main = requirements.tasks.find((one) => one.taskKey === 'main')!;
    expect(main.brief).toBe(brief);
    expect(main.objectives).toEqual(['**Name** the persona']);
  });

  it("keeps a TaskTrackr copy whose brief and objectives became plain text on the reference's application", async () => {
    const at = await copy();
    const reference = world.content.getProject('tasktrackr').phases.find((one) => one.key === 'implementation')!;
    // TaskTrackr 6.0.0 ships its briefs plain, so plainTextOf leaves the reference's words byte for byte
    expect(plainTextOf(reference.taskPanel)).toBe(reference.taskPanel);
    const before = (await world.service.readDraft(teacher, at.projectId, at.versionId)).phases.find((one) => one.key === 'implementation')!;
    expect(before.provenance?.application ?? null).not.toBeNull();
    // the copy's brief and objectives as `plainTextOf` makes them (a draft's conversion, TaskTrackr 6.0.0's words)
    const row = await taskRow(at.versionId, 'implementation');
    expect(row.brief).toBe(reference.taskPanel);
    await tasks().update({ id: row.id }, { brief: plainTextOf(reference.taskPanel), objectives: reference.objectives.map(plainTextOf) });
    const reread = (await world.service.readDraft(teacher, at.projectId, at.versionId)).phases.find((one) => one.key === 'implementation')!;
    expect(reread.provenance?.application ?? null).toEqual(before.provenance?.application);
    // a brief that is the teacher's own still moves the copy off the reference's application
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', { brief: 'A **new** brief.' });
    const own = (await world.service.readDraft(teacher, at.projectId, at.versionId)).phases.find((one) => one.key === 'implementation')!;
    expect(own.provenance?.application ?? null).toBeNull();
  });
});

describe('a quiz result is converted where it is read', () => {
  /** A stored report as it was written before texts were kept plain: the pinned version's quiz texts as they were, markdown and comments included. */
  const storedReport = (): FeedbackReport =>
    ({
      overall: 50,
      passed: false,
      criteria: [],
      checks: [{ id: 'quiz', label: 'Quiz', status: 'failed', detail: '1 of 2 right.' }],
      quiz: {
        correctCount: 1,
        drawn: 2,
        passMark: 60,
        attempt: 1,
        attemptsLeft: null,
        questions: [
          {
            id: 'q1',
            stem: 'What does **this** check?<!-- teacher note -->',
            options: [{ id: 't1', text: 'The _overdue_ rule' }, { id: 't2', text: 'Keep `x_y`' }],
            selected: ['t1'],
            outcome: 'right',
            explanation: 'Because **the rule** says so.',
            concept: '_Overdue_ rule',
          },
          { id: 'q2', stem: '## Which one?', options: [{ id: 't3', text: '**A**' }], selected: [], outcome: 'wrong', explanation: null, concept: null },
        ],
      },
    }) as unknown as FeedbackReport;

  const expectPlain = (view: Pick<SubmissionView, 'report'>): void => {
    const [one, two] = view.report!.quiz!.questions;
    expect(one).toMatchObject({ stem: 'What does this check?', explanation: 'Because the rule says so.', concept: 'Overdue rule', selected: ['t1'] });
    expect(one.options).toEqual([{ id: 't1', text: 'The overdue rule' }, { id: 't2', text: 'Keep `x_y`' }]);
    // a sealed explanation stays sealed
    expect(two).toMatchObject({ stem: 'Which one?', explanation: null, concept: null });
    expect(two.options).toEqual([{ id: 't3', text: 'A' }]);
  };

  it('shows a learner a quiz result stored before texts were kept plain through latestFor and the history, and leaves the stored row alone', async () => {
    const learner = await enrolled('tasktrackr');
    const stateId = await learner.stateOf('testing');
    const submissions = world.dataSource.getRepository(SubmissionEntity);
    const row = await submissions.save(
      submissions.create({ phaseStateId: stateId, userId: learner.userId, taskKey: '', status: 'completed', score: 50, passed: false, report: storedReport() }),
    );
    const Feedback = FeedbackService as unknown as new (...deps: unknown[]) => FeedbackService;
    const feedback = new Feedback(submissions);
    const latest = await feedback.latestFor(stateId);
    expectPlain(latest!);
    // the dossier and history read the same rows through `historyRevision`
    const repo = new RepoService(world.dataSource, world.content) as unknown as {
      historyRevision(row: SubmissionEntity, snapshot: Record<string, string> | null): Pick<SubmissionView, 'report'>;
    };
    expectPlain(repo.historyRevision(await submissions.findOneByOrFail({ id: row.id }), null));
    // nothing is rewritten
    expect((await submissions.findOneByOrFail({ id: row.id })).report).toEqual(storedReport());
  });
});

describe('Design story lines and a quiz concept label are teacher texts too', () => {
  it('stores a quiz concept label plain at the door', async () => {
    const at = await copy();
    await world.service.addTask(teacher, at.projectId, at.versionId, 'testing', {
      taskKey: 'labelled',
      title: 'Labelled quiz',
      brief: 'A brief.',
      artefactType: 'quiz',
      required: false,
      quiz: {
        questions: ['q1', 'q2'].map((id) => ({
          id,
          stem: `Stem ${id}?`,
          options: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }],
          correct: ['a'],
          explanation: 'Because.',
          concept: '**Overdue** rule',
        })),
      },
    });
    const quiz = (await taskRow(at.versionId, 'testing', 'labelled')).checks as unknown as QuizChecks;
    expect(quiz.questions.map((one) => one.concept)).toEqual(['Overdue rule', 'Overdue rule']);
  });

  it("stores a Design story's title and line plain at the door, and shows a learner a stored markdown one plain", async () => {
    const at = await copy();
    const design = await taskRow(at.versionId, 'design');
    const checks = design.checks as unknown as DesignChecks;
    expect(checks.kind).toBe('design');
    expect(checks.stories.length).toBeGreaterThan(0);
    const body: DesignChecksBody = {
      contracts: checks.contracts,
      sequence: checks.sequence,
      stories: checks.stories.map((one, i) => (i === 0 ? { ...one, title: '**Overdue** report', line: 'As a _lead_ I see late tasks' } : one)),
      floor: checks.floor,
    } as DesignChecksBody;
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'design', 'main', { design: body });
    const stored = (await taskRow(at.versionId, 'design')).checks as unknown as DesignChecks;
    expect(stored.stories[0]).toMatchObject({ title: 'Overdue report', line: 'As a lead I see late tasks' });
    expect(stored.stories.slice(1)).toEqual(checks.stories.slice(1));

    // a version published before texts were kept plain holds the markdown as written
    await tasks().update({ id: design.id }, {
      checks: { ...checks, stories: checks.stories.map((one, i) => (i === 0 ? { ...one, title: '**Overdue** report', line: 'As a _lead_ <!-- n -->I see late tasks' } : one)) } as never,
    });
    await world.service.publish(teacher, at.projectId, at.versionId, { version: '1.0.0' });
    const learner = await enrolled(`plain-text-doors-${copies}`);
    const detail = await workflow.phaseDetail(learner.userId, await learner.stateOf('design'));
    expect(detail.design!.stories[0]).toMatchObject({ title: 'Overdue report', line: 'As a lead I see late tasks' });
    const preview = await world.service.learnerPreview(teacher, at.projectId, at.versionId);
    expect(preview.phases.find((one) => one.key === 'design')!.design).toEqual(detail.design);
  });
});

describe('a member plainTextOf turns blank is refused as empty, and the cap is asked of what was sent', () => {
  it('refuses a title, brief or criterion sentence that is only markdown with the existing empty sentence', async () => {
    const at = await copy();
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', { title: '#' })).rejects.toThrow('A title cannot be empty.');
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', { brief: '---' })).rejects.toThrow('A brief cannot be empty.');
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', { objectives: ['***'] })).rejects.toThrow(
      'An objective cannot be empty.',
    );
    const story = await taskRow(at.versionId, 'requirements');
    await expect(
      world.service.updateTask(teacher, at.projectId, at.versionId, 'requirements', 'main', {
        criteria: [{ key: story.rubric.criteria[0].key, title: '***', description: 'Says why.' }],
      }),
    ).rejects.toThrow('A criterion title cannot be empty.');
    await expect(
      world.service.addTask(teacher, at.projectId, at.versionId, 'testing', {
        taskKey: 'blank',
        title: '#',
        brief: 'A brief.',
        artefactType: 'quiz',
        required: false,
        quiz: { questions: ['q1', 'q2'].map((id) => ({ id, stem: `${id}?`, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: ['a'], explanation: 'E.' })) },
      }),
    ).rejects.toThrow('A title cannot be empty.');
    await expect(world.service.updatePhase(teacher, at.projectId, at.versionId, 'requirements', { intro: '---' })).rejects.toThrow(/^The intro of .+ cannot be empty\.$/);
    // nothing moved
    const row = await taskRow(at.versionId, 'implementation');
    expect([row.title.length > 0, row.brief.length > 0]).toEqual([true, true]);
    await expect(taskRow(at.versionId, 'testing', 'blank')).rejects.toThrow();
  });

  /** A door's save refused with `sentence`, and the task's row as it was. */
  const refusedUnchanged = async (at: Fork, key: PhaseKey, save: () => Promise<unknown>, sentence: string, taskKey = 'main') => {
    const before = JSON.stringify(await taskRow(at.versionId, key, taskKey).catch(() => null));
    await expect(save()).rejects.toThrow(sentence);
    expect(JSON.stringify(await taskRow(at.versionId, key, taskKey).catch(() => null))).toBe(before);
  };

  it("refuses a Design story's title or line that converts blank with the design check's own sentence", async () => {
    const at = await copy();
    const checks = (await taskRow(at.versionId, 'design')).checks as unknown as DesignChecks;
    const body = (story: Partial<DesignChecks['stories'][number]>): DesignChecksBody =>
      ({ contracts: checks.contracts, sequence: checks.sequence, stories: checks.stories.map((one, i) => (i === 0 ? { ...one, ...story } : one)), floor: checks.floor }) as DesignChecksBody;
    await refusedUnchanged(at, 'design', () => world.service.updateTask(teacher, at.projectId, at.versionId, 'design', 'main', { design: body({ line: '---' }) }), 'stories.line is required');
    await refusedUnchanged(at, 'design', () => world.service.updateTask(teacher, at.projectId, at.versionId, 'design', 'main', { design: body({ title: '#' }) }), 'stories.title is required');
  });

  it("refuses a provided story's field or clause that converts blank with the story check's own sentence", async () => {
    const at = await copy();
    const checks = (await taskRow(at.versionId, 'requirements')).checks as unknown as StoryChecksBody;
    const first = checks.providedStories[0];
    expect(first.criteria?.length).toBeGreaterThan(0);
    const send = (story: Partial<typeof first>) => () =>
      world.service.updateTask(teacher, at.projectId, at.versionId, 'requirements', 'main', {
        story: { providedStories: checks.providedStories.map((one, i) => (i === 0 ? { ...one, ...story } : one)), learnerStory: checks.learnerStory, floor: checks.floor },
      });
    await refusedUnchanged(at, 'requirements', send({ capability: '***' }), 'providedStories.capability is required');
    await refusedUnchanged(
      at,
      'requirements',
      send({ criteria: first.criteria!.map((c, j) => (j === 0 ? { ...c, given: '#' } : c)) }),
      `Provided story ${first.id} has a criterion with an empty Given, When or Then.`,
    );
  });

  it("refuses a ticket's title or acceptance line that converts blank with the ticket check's own sentence", async () => {
    const at = await copy();
    const ticket = ((await taskRow(at.versionId, 'maintenance')).checks as unknown as { ticket: { id: string; title: string; summary: string; acceptance: { id: string; line: string }[] } }).ticket;
    const send = (patch: Partial<typeof ticket>) => () => world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { ticket: { ...ticket, ...patch } });
    await refusedUnchanged(at, 'maintenance', send({ title: '#' }), 'The ticket needs a title.');
    await refusedUnchanged(
      at,
      'maintenance',
      send({ acceptance: ticket.acceptance.map((one, i) => (i === 0 ? { ...one, line: '---' } : one)) }),
      `Acceptance ${ticket.acceptance[0].id} needs a line.`,
    );
  });

  it("refuses a whole rubric's criterion sentence that converts blank with the criterion's own empty sentence", async () => {
    const at = await copy();
    const story = await taskRow(at.versionId, 'requirements');
    const rubric = (patch: { title?: string; description?: string }) => ({
      passThreshold: story.rubric.passThreshold,
      criteria: story.rubric.criteria.map((c, i) => (i === 0 ? { ...c, ...patch } : c)),
    });
    const send = (patch: { title?: string; description?: string }) => () => world.service.updateTask(teacher, at.projectId, at.versionId, 'requirements', 'main', { rubric: rubric(patch) });
    await refusedUnchanged(at, 'requirements', send({ title: '***' }), 'A criterion title cannot be empty.');
    await refusedUnchanged(at, 'requirements', send({ description: '---' }), 'A criterion description cannot be empty.');
  });

  it('says "An objective" and "A brief": every empty and cap sentence of the editor takes the article its noun asks for', () => {
    expect(() => taskWordsPatch({ objectives: ['#'] })).toThrow(/^An objective cannot be empty\.$/);
    expect(() => taskWordsPatch({ brief: '---' })).toThrow(/^A brief cannot be empty\.$/);
    expect(() => taskWordsPatch({ title: '' })).toThrow(/^A title cannot be empty\.$/);
    expect(() => requireText('', 'objective', 300)).toThrow(/^An objective cannot be empty\.$/);
    expect(() => requireText('x'.repeat(301), 'objective', 300)).toThrow(/^An objective is at most 300 characters, and this one is 301\.$/);
    expect(() => requireText('x'.repeat(161), 'title', 160)).toThrow(/^A title is at most 160 characters, and this one is 161\.$/);
    expect(() => requirePlainText('***', 'objective', 300)).toThrow(/^An objective cannot be empty\.$/);
    expect(() => requirePlainText('***', 'criterion title', 120)).toThrow(/^A criterion title cannot be empty\.$/);
  });

  it("refuses an added task's objective that converts blank with the objective's own empty sentence", async () => {
    const at = await copy();
    await refusedUnchanged(
      at,
      'testing',
      () =>
        world.service.addTask(teacher, at.projectId, at.versionId, 'testing', {
          taskKey: 'aims',
          title: 'Aims quiz',
          brief: 'A brief.',
          objectives: ['Know the rule', '#'],
          artefactType: 'quiz',
          required: false,
          quiz: { questions: ['q1', 'q2'].map((id) => ({ id, stem: `${id}?`, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: ['a'], explanation: 'E.' })) },
        }),
      'An objective cannot be empty.',
      'aims',
    );
  });

  it("refuses a quiz option's text or a concept label that converts blank with its own empty sentence", async () => {
    const at = await copy();
    const add = (question: { optionText?: string; concept?: string }) => () =>
      world.service.addTask(teacher, at.projectId, at.versionId, 'testing', {
        taskKey: 'blanks',
        title: 'Blanks quiz',
        brief: 'A brief.',
        artefactType: 'quiz',
        required: false,
        quiz: {
          questions: ['q1', 'q2'].map((id) => ({
            id,
            stem: `${id}?`,
            options: [{ id: 'a', text: question.optionText ?? 'A' }, { id: 'b', text: 'B' }],
            correct: ['a'],
            explanation: 'E.',
            ...(question.concept !== undefined ? { concept: question.concept } : {}),
          })),
        },
      });
    await refusedUnchanged(at, 'testing', add({ optionText: '---' }), 'A quiz option cannot be empty.', 'blanks');
    await refusedUnchanged(at, 'testing', add({ concept: '#' }), 'A concept label cannot be empty.', 'blanks');
  });

  it('holds a markdown brief to the cap by its sent length, even when its plain text would fit', async () => {
    const at = await copy();
    const brief = `## ${'a'.repeat(TASK_BRIEF_MAX - 1)}`;
    expect(plainTextOf(brief).length).toBeLessThanOrEqual(TASK_BRIEF_MAX);
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', { brief })).rejects.toThrow(
      `A brief is at most ${TASK_BRIEF_MAX} characters, and this one is ${brief.length}.`,
    );
  });
});

describe("the conversions a learner's mentor and rooms read", () => {
  it("shows the local mentor's failing-test explanation's hint plain", async () => {
    const shipped = world.content.getProject('tasktrackr').phases.find((one) => one.key === 'implementation')!;
    const phase: PhaseContent = {
      ...shipped,
      assistant: { ...shipped.assistant, topics: [{ keywords: ['overdue'], hints: ['Read the **overdue** rule <!-- note -->again.'] }], progressive: ['Start with the _first_ gap.'] },
    };
    const reply = await new LocalMentorProvider().chat({
      phase,
      message: 'why does it fail',
      interactionCount: 0,
      topicUseCounts: {},
      signals: { todosRemaining: [], lastFailedChecks: [] },
      failingTest: { name: 'test_overdue_excludes_today', assertion: 'assert x', path: 'app/tasks.py', line: 3 },
    } as unknown as MentorContext);
    expect(reply.content).toContain('Read the overdue rule again.');
    expect(reply.content).not.toContain('**overdue**');
    expect(reply.content).not.toContain('<!--');
  });

  describe("the quiz room's and the concept room's brief", () => {
    const snapshot: CompiledSnapshot = compiledQuizSnapshot();
    let dataSource: DataSource;
    let rooms: QuizService;
    beforeAll(async () => {
      dataSource = await memoryDataSource();
      const phase = snapshot.content.phases.find((one) => one.key === 'design')!;
      const held = snapshot.phases.find((one) => one.key === 'design')!.tasks;
      const compiledTasks: CompiledTask[] = held.map((task) => (task.taskKey === 'design-check' ? { ...task, brief: '## Before you start\n\nRead **this** first.<!-- teacher -->' } : task));
      const state = { id: 'ps-1', userId: 'u-1', enrollmentId: 'e-1', phaseKey: 'design', status: 'in_progress' } as unknown as PhaseStateEntity;
      rooms = new QuizService(
        { loadOwnedState: async () => ({ state, phase, enrollment: { id: 'e-1' } }) } as never,
        { getTasksForEnrollment: () => compiledTasks, resolveForEnrollment: () => ({ content: snapshot.content, versionId: 'pv-1' }) } as never,
        { submit: async () => ({ id: 'sub-x' }) } as never,
        new QuizAttemptsService(dataSource.getRepository(QuizAttemptEntity)),
        dataSource.getRepository(TaskStateEntity),
        dataSource.getRepository(SubmissionEntity),
      );
    });
    afterAll(async () => {
      await dataSource?.destroy();
    });

    it("shows a teacher's quiz brief plain in the quiz room", async () => {
      expect((await rooms.room('u-1', 'ps-1', 'design-check')).brief).toBe('Before you start\n\nRead this first.');
    });

    it("keeps the concept room's platform brief byte for byte", async () => {
      const room = await rooms.room('u-1', 'ps-1', 'concept-before');
      const written = conceptTask('design', 'concept-before', { questions: Array.from({ length: room.drawn }) } as unknown as QuizChecks).brief;
      expect(room.brief).toBe(written);
      expect(plainTextOf(written)).toBe(written);
    });
  });
});

describe('a TaskTrackr copy whose briefs became plain text stays on the reference everywhere', () => {
  it("reads reference in taskScopeOf, phaseScopeOf and deep validation, and publish asks it for no deep run", async () => {
    const at = await copy();
    const shipped = world.content.getProject('tasktrackr');
    // the copy's briefs and objectives as `plainTextOf` makes them (a converted draft), every other byte the reference's
    for (const key of ['requirements', 'implementation', 'testing'] as const) {
      const reference = shipped.phases.find((one) => one.key === key)!;
      // TaskTrackr 6.0.0 ships its briefs plain, so plainTextOf leaves the reference's words byte for byte
      expect(plainTextOf(reference.taskPanel)).toBe(reference.taskPanel);
      const row = await taskRow(at.versionId, key);
      expect(row.brief).toBe(reference.taskPanel);
      await tasks().update({ id: row.id }, { brief: plainTextOf(reference.taskPanel), objectives: reference.objectives.map(plainTextOf) });
    }
    // publish's own reader: no deep-validation row for either executable phase
    const report = await world.service.validate(teacher, at.projectId, at.versionId);
    const deepRows = report.checks.filter((one) => one.id === DEEP_RECEIPT_CHECK_ID).map((one) => one.phaseKey);
    expect(deepRows).not.toContain('implementation');
    expect(deepRows).not.toContain('testing');
    await world.service.publish(teacher, at.projectId, at.versionId, { version: '1.0.0' });

    const compiled = (await versions().findOneByOrFail({ id: at.versionId })).compiled as unknown as CompiledSnapshot;
    for (const key of ['requirements', 'implementation', 'testing'] as const) {
      const phase = compiled.content.phases.find((one) => one.key === key)!;
      const held = compiled.phases.find((one) => one.key === key)!.tasks;
      const work = held.filter((one) => one.checkKind !== 'quiz');
      expect(work).toHaveLength(1);
      expect(work[0].brief).toBe(plainTextOf(shipped.phases.find((one) => one.key === key)!.taskPanel));
      expect([key, taskScopeOf(phase, work[0], held).kind]).toEqual([key, 'reference']);
      expect([key, phaseScopeOf(phase, held).kind]).toEqual([key, 'reference']);
      if (key !== 'requirements') expect([key, isReferenceExecutablePhase(phase, held)]).toEqual([key, true]);
    }
  });

  it("keeps a phase whose plain brief differs from the reference's by one word on the authored scope", () => {
    for (const shipped of world.content.getProject('tasktrackr').phases.filter((one) => ['requirements', 'implementation', 'testing'].includes(one.key))) {
      const twin: PhaseContent = { ...shipped, taskPanel: plainTextOf(shipped.taskPanel), objectives: shipped.objectives.map(plainTextOf) };
      expect([shipped.key, phaseScopeOf(twin).kind]).toEqual([shipped.key, 'reference']);
      const own: PhaseContent = { ...twin, taskPanel: `${twin.taskPanel} Also.` };
      expect([shipped.key, taskScopeOf(own).kind, phaseScopeOf(own).kind]).toEqual([shipped.key, 'authored', 'authored']);
    }
  });
});
