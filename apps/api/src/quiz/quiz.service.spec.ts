import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { DESIGN_OLDER_FORMAT_ROOM, RUNBOOK_OLDER_FORMAT_ROOM, type SubmissionView } from '@learnsdlc/shared';
import {
  compiledQuizSnapshot,
  fixtureQuizChecks,
  fixtureQuizQuestions,
} from '../../test/quiz-fixture';
import { olderTaskTrackrPack } from '../../test/legacy-phase';
import { layoutFromManifest } from '../content/legacy-layout';
import { ContentService } from '../content/content.service';
import type { PhaseContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';
import { QuizAttemptEntity, SubmissionEntity, TaskStateEntity } from '../db/entities';
import type { PhaseStateEntity } from '../db/entities';
import { QUIZ_PAPER_REFUSAL } from '../feedback/quiz-scoring';
import { optionToken, QuizAttemptsService } from './quiz-attempts.service';
import { QUIZ_SHEET_REFUSAL, QuizService } from './quiz.service';

/**
 * The learner's three quiz routes, at the service layer.
 *
 * Four properties are what this file exists to hold, and each of them is an
 * obligation rather than a preference.
 *
 * **The key never leaves.** Every payload this service produces is asserted
 * over its whole serialised form, not field by field, at every point in an
 * attempt's life: before the paper, on the open paper and after the hand-in.
 * A pool's undrawn questions are asserted absent in the
 * same breath: a pool whose undrawn half leaks is not a pool.
 *
 * **One sentence, four facts.** An unknown question id, an unknown option id, a
 * duplicate selection and a value that is not a list of option ids all read the
 * same, so a refusal is not an oracle a caller can probe the paper with.
 * The same rule, in the other register: an attempt id that is
 * unknown, somebody else's, still open or already graded is one sentence, which
 * is `FeedbackService`'s own `QUIZ_PAPER_REFUSAL` rather than a second copy of
 * it.
 *
 * **Two counters, two questions.** The limit is `COUNT(*)` over **closed**
 * rows, so an open paper spends nothing and a double start is not a second
 * paper. `task_states.attempts` is not this counter and is never read
 * here.
 *
 * **The hand-in is the only writer that reaches the grader**, and it reaches it
 * through `FeedbackService.submit` with the attempt id: the fifth argument
 * that keeps the IDE's Submit from handing in a paper that was never drawn.
 */

const snapshot = compiledQuizSnapshot();
const DESIGN = 'design';
const QUIZ_KEY = 'design-check';
const VERSION = 'pv-1';

const phase = (): PhaseContent => {
  const found = snapshot.content.phases.find((one) => one.key === DESIGN);
  if (!found) throw new Error('the fixture lost its written phase');
  return found;
};

const tasks = (): CompiledTask[] => {
  const found = snapshot.phases.find((one) => one.key === DESIGN);
  if (!found) throw new Error('the fixture lost its written phase’s tasks');
  return found.tasks;
};

const quizTask = (): CompiledTask => {
  const found = tasks().find((one) => one.taskKey === QUIZ_KEY);
  if (!found) throw new Error('the fixture lost its quiz task');
  return found;
};

const state = {
  id: 'ps-1',
  userId: 'u-1',
  enrollmentId: 'e-1',
  phaseKey: DESIGN,
} as unknown as PhaseStateEntity;

const view: SubmissionView = {
  id: 'sub-1',
  status: 'queued',
  score: null,
  passed: null,
  report: null,
  createdAt: '2026-09-21T00:00:00.000Z',
};

/** Every stem the pool declares, so "the undrawn half stayed sealed" is assertable. */
const POOL_STEMS = fixtureQuizQuestions().map((one) => one.stem);

describe('the learner’s quiz routes', () => {
  let dataSource: DataSource;
  let attempts: QuizAttemptsService;
  let rows: Repository<QuizAttemptEntity>;
  let taskStates: Repository<TaskStateEntity>;
  let service: QuizService;
  let submit: jest.Mock;
  let versionId: string | null;
  let compiledTasks: CompiledTask[];
  /** The phase the learner's pin answers now. */
  let loaded: PhaseContent;

  beforeEach(async () => {
    dataSource = await memoryDataSource();
    rows = dataSource.getRepository(QuizAttemptEntity);
    taskStates = dataSource.getRepository(TaskStateEntity);
    attempts = new QuizAttemptsService(rows);
    versionId = VERSION;
    compiledTasks = tasks();
    loaded = phase();
    submit = jest.fn(async () => view);

    const workflow = {
      loadOwnedState: jest.fn(async () => ({
        state,
        phase: loaded,
        enrollment: { id: 'e-1' },
      })),
    };
    const content = {
      getTasksForEnrollment: jest.fn(() => compiledTasks),
      resolveForEnrollment: jest.fn(() => ({ content: snapshot.content, versionId })),
    };

    service = new QuizService(
      workflow as never,
      content as never,
      { submit } as never,
      attempts,
      taskStates,
      // The real repository, so the still-marking guard reads what the grader
      // writes rather than a stand-in that always answers "nothing in flight".
      dataSource.getRepository(SubmissionEntity),
    );
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  /* ------------------------- what a learner may read ----------------------- */

  it('answers the room without a key, before a paper has been drawn', async () => {
    const room = await service.room('u-1', 'ps-1', QUIZ_KEY);
    expect(room).toMatchObject({
      taskKey: QUIZ_KEY,
      title: quizTask().title,
      // The number of questions ONE PAPER draws, never the pool's size: a
      // learner who knew the pool held five would know a retake is a subset.
      drawn: 3,
      passMark: fixtureQuizChecks().passMark,
      status: 'in_progress',
      attemptsUsed: 0,
      attemptsLeft: 3,
      cooldownSecondsLeft: null,
      bestScore: null,
      lastSubmissionId: null,
      paper: null,
    });
    expect(JSON.stringify(room)).not.toMatch(/"correct"/);
    expect(JSON.stringify(room)).not.toContain('Fixture explanation');
  });

  it('carries no key, no explanation and no undrawn question on the open paper', async () => {
    const paper = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const wire = JSON.stringify(paper);

    // The key never leaves, asserted over the whole payload rather than field
    // by field, which is only possible because a result says `outcome` and
    // never `correct`.
    expect(wire).not.toMatch(/"correct"/);
    expect(wire).not.toContain('Fixture explanation');
    expect(wire).not.toContain('fixture-concept');

    // The pool's undrawn questions are not in the
    // payload at all, because the payload is built from the paper.
    expect(POOL_STEMS.filter((stem) => wire.includes(stem))).toHaveLength(3);
    expect(paper.questions).toHaveLength(3);

    // The projection, exactly: an id, a stem, options that are an id and a
    // text, and how many answers may be picked. Nothing marks an option, on
    // any route, at any time.
    for (const question of paper.questions) {
      expect(Object.keys(question).sort()).toEqual(['id', 'multiple', 'options', 'stem']);
      for (const option of question.options) {
        expect(Object.keys(option).sort()).toEqual(['id', 'text']);
      }
    }
  });

  /* --------------- the options, under this paper's own tokens -------------- */

  it('names an option by a token of this paper’s, never by the id the teacher wrote', async () => {
    // **The side channel this closes.** The authored ids are the order the
    // teacher wrote the options in, and a teacher who writes the right answer
    // first would have leaked the key by position on every paper they ever
    // set. So what the learner reads is a token taken over THIS paper, and
    // `a`/`b` (the ids the fixture and every authoring form use) appear
    // nowhere in the payload.
    const paper = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const wire = JSON.stringify(paper);
    expect(wire).not.toMatch(/"[ab]"/);

    // The fixture shuffles its options, so the order a learner reads is the
    // row's permutation, and each option is named by its token, in that order.
    const row = await rows.findOneByOrFail({ id: paper.attemptId });
    for (const question of paper.questions) {
      const ids = question.options.map((option) => option.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      // The token is this paper's, this question's and this option's.
      const drawn = row.paper.find((one) => one.questionId === question.id)?.optionIds ?? [];
      expect([...drawn].sort()).toEqual(['a', 'b']);
      expect(ids).toEqual(drawn.map((id) => optionToken(paper.attemptId, question.id, id)));
    }
  });

  it('gives no two papers and no two learners a token in common', async () => {
    // Nothing about a token survives the paper it was drawn for, so a learner
    // cannot carry what they worked out on one paper onto the next, and two
    // learners comparing notes learn nothing about the key.
    const mine = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const tokens = new Set(mine.questions.flatMap((one) => one.options.map((two) => two.id)));

    await rows.update({ id: mine.attemptId }, { submittedAt: new Date().toISOString() });
    const retake = await service.start('u-1', 'ps-1', QUIZ_KEY);
    for (const question of retake.questions) {
      for (const option of question.options) expect(tokens.has(option.id)).toBe(false);
    }
  });

  it('says how many answers a question takes, and never which', async () => {
    // The radio-or-checkbox fact, and the least that a control which does not
    // lie can be built on. The fixture keys one option per question, so every
    // question reads single-answer; a two-key question reads multiple, and
    // neither payload says which options those are.
    const single = await service.start('u-1', 'ps-1', QUIZ_KEY);
    expect(single.questions.map((one) => one.multiple)).toEqual([false, false, false]);

    compiledTasks = withChecks(
      fixtureQuizChecks({
        questions: fixtureQuizQuestions().map((one) => ({ ...one, correct: ['a', 'b'] })),
      }),
    );
    await rows.clear();
    const several = await service.start('u-1', 'ps-1', QUIZ_KEY);
    expect(several.questions.map((one) => one.multiple)).toEqual([true, true, true]);
    expect(JSON.stringify(several)).not.toMatch(/"correct"/);
  });

  it('measures how many answers a question takes exactly as the scorer does', async () => {
    // A key that names one option twice is ONE answer, not two. `scorePaper`
    // folds the key into `new Set(question.correct)` and then requires
    // `picked.size === wanted.size` (feedback.service.ts), so a paper that
    // measured the raw array would draw a checkbox group, tell the learner to
    // pick every answer that applies, and mark them wrong for doing it.
    //
    // Nothing above refuses the repeat: `quiz-questions-well-formed` folds
    // `correct` into a set before it asks whether every option is keyed
    // (validation.ts), and `QuizQuestionDto.correct` carries no
    // `@ArrayUnique()`. So the duplicate can reach a compiled slice, and the
    // paper stays honest by measuring the set the scorer measures.
    compiledTasks = withChecks(
      fixtureQuizChecks({
        questions: fixtureQuizQuestions().map((one) => ({ ...one, correct: ['a', 'a'] })),
      }),
    );
    const paper = await service.start('u-1', 'ps-1', QUIZ_KEY);
    expect(paper.questions.map((one) => one.multiple)).toEqual([false, false, false]);
    expect(JSON.stringify(paper)).not.toMatch(/"correct"/);
  });

  it('carries no key once the paper has been handed in either', async () => {
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const attemptId = started.attemptId;
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, {});
    // The verdict lands, because `submit` is a double here and the real one
    // links the paper to its revision before the job is enqueued. A paper left
    // naming no revision is the shape a queue outage leaves behind, and the
    // room offers that one back on purpose.
    const submissions = dataSource.getRepository(SubmissionEntity);
    const marked = await submissions.save(
      submissions.create({
        phaseStateId: 'ps-1',
        userId: 'u-1',
        taskKey: QUIZ_KEY,
        status: 'completed',
      }),
    );
    await attempts.link(attemptId, marked.id);

    const room = await service.room('u-1', 'ps-1', QUIZ_KEY);
    expect(JSON.stringify(room)).not.toMatch(/"correct"/);
    expect(JSON.stringify(room)).not.toContain('Fixture explanation');
    expect(room.paper).toBeNull();
    expect(room.attemptsUsed).toBe(1);
    expect(room.attemptsLeft).toBe(2);
  });

  it('reads the task’s own best score back', async () => {
    await taskStates.save(
      taskStates.create({ phaseStateId: 'ps-1', userId: 'u-1', taskKey: QUIZ_KEY, bestScore: 80 }),
    );
    expect((await service.room('u-1', 'ps-1', QUIZ_KEY)).bestScore).toBe(80);
  });

  /* ---------------------------- not a quiz at all -------------------------- */

  it('answers all three routes with one sentence for a task that is not a quiz', async () => {
    const artefact = compiledTasks.find((one) => one.taskKey !== QUIZ_KEY)?.taskKey ?? 'main';
    await expect(service.room('u-1', 'ps-1', artefact)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.start('u-1', 'ps-1', artefact)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.handIn('u-1', 'ps-1', artefact, 'any', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Refused here rather than in `submit`, so one task gets one answer from
    // all three routes instead of two sentences from two layers.
    expect(submit).not.toHaveBeenCalled();
  });

  it('404s a key the pinned version does not declare', async () => {
    await expect(service.room('u-1', 'ps-1', 'no-such-task')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /* ------------------------------- starting -------------------------------- */

  it('hands back the open paper rather than drawing a second one, and spends nothing', async () => {
    const first = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const second = await service.start('u-1', 'ps-1', QUIZ_KEY);
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.questions).toEqual(first.questions);
    expect(await rows.count()).toBe(1);
    // The limit is counted on CLOSED rows, so an abandoned paper costs nothing.
    const room = await service.room('u-1', 'ps-1', QUIZ_KEY);
    expect(room.attemptsUsed).toBe(0);
    expect(room.attemptsLeft).toBe(3);
    expect(room.paper?.attemptId).toBe(first.attemptId);
  });

  it('refuses a spent limit by name, and says how many were used', async () => {
    for (let at = 0; at < 3; at += 1) {
      const open = await service.start('u-1', 'ps-1', QUIZ_KEY);
      await service.handIn('u-1', 'ps-1', QUIZ_KEY, open.attemptId, {});
    }
    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).rejects.toThrow(/all 3 attempts/);
    expect(await rows.count()).toBe(3);
  });

  it('refuses a running cooldown by name, and opens again when it has run out', async () => {
    compiledTasks = withChecks(fixtureQuizChecks({ attempts: { max: null, cooldownSeconds: 120 } }));
    const open = await service.start('u-1', 'ps-1', QUIZ_KEY);
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, open.attemptId, {});

    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).rejects.toThrow(/opens in/);
    expect((await service.room('u-1', 'ps-1', QUIZ_KEY)).cooldownSecondsLeft).toBeGreaterThan(0);

    await rows.update(
      { taskKey: QUIZ_KEY },
      { submittedAt: new Date(Date.now() - 300_000).toISOString() },
    );
    expect((await service.room('u-1', 'ps-1', QUIZ_KEY)).cooldownSecondsLeft).toBeNull();
    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).resolves.toMatchObject({
      attemptId: expect.any(String),
    });
  });

  it('refuses to draw a paper an enrolment has no published version to pin it to', async () => {
    versionId = null;
    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(await rows.count()).toBe(0);
  });

  /* ------------------------------- handing in ------------------------------ */

  it('writes the sheet and hands the attempt id to the grader', async () => {
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const attemptId = started.attemptId;
    const answers = Object.fromEntries(
      (started.questions).map((one) => [one.id, [one.options[0].id]]),
    );

    await expect(service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, answers)).resolves.toBe(view);

    const closed = await rows.findOneByOrFail({ id: attemptId });
    // **The sheet is stored in the teacher's own ids**, mapped back from the
    // tokens the learner sent. The scorer, the regrade and the teacher's
    // authoring view all read the ids the quiz was written in; the tokens are
    // the wire's and go no further than it.
    expect(closed.answers).toEqual(
      Object.fromEntries(
        started.questions.map((one) => [
          one.id,
          [one.options[0].id === optionToken(attemptId, one.id, 'a') ? 'a' : 'b'],
        ]),
      ),
    );
    expect(JSON.stringify(closed.answers)).not.toContain(started.questions[0].options[0].id);
    expect(closed.submittedAt).toEqual(expect.any(String));
    // The property is `attemptId`, and the sheet is written BEFORE the grader
    // is called: `submit` reads the newest CLOSED paper.
    expect(submit).toHaveBeenCalledWith(phase(), state, undefined, QUIZ_KEY, { attemptId });
  });

  it('refuses one sentence for every paper that is not the one open on this quiz', async () => {
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const attemptId = started.attemptId;

    // Unknown, and another learner's, which reads as unknown, because the
    // read is keyed on this learner's own phase state.
    for (const id of ['dd0c4a2e-0f6b-4a6f-8a5a-0c3ec1f0f0aa', 'not-a-uuid', '']) {
      await expect(service.handIn('u-1', 'ps-1', QUIZ_KEY, id, {})).rejects.toThrow(
        QUIZ_PAPER_REFUSAL,
      );
    }
    expect(submit).not.toHaveBeenCalled();

    // A second hand-in of a paper already in the record, with its
    // revision named, is refused, and nothing is scored a second time.
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, {});
    await attempts.link(attemptId, 'sub-1');
    submit.mockClear();
    await expect(service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, {})).rejects.toThrow(
      QUIZ_PAPER_REFUSAL,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('hands in again a paper whose revision never reached the queue', async () => {
    // `submit` takes the link back when the queue refuses, precisely so the learner
    // is not left with a spent attempt and a sheet nobody can hand in. This is
    // the read that lets them: closed, but naming no revision.
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const attemptId = started.attemptId;
    const questionId = started.questions[0].id ?? '';
    // Sent as the learner holds it: this paper's token for option `a`.
    const answers = { [questionId]: [optionToken(attemptId, questionId, 'a')] };
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, answers);
    submit.mockClear();

    await expect(service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, {})).resolves.toBe(view);
    expect(submit).toHaveBeenCalledWith(phase(), state, undefined, QUIZ_KEY, { attemptId });
    // The sheet in the record is the sheet that was handed in (in the
    // teacher's ids); a retry does not rewrite it, and it does not spend a
    // second attempt.
    expect((await rows.findOneByOrFail({ id: attemptId })).answers).toEqual({ [questionId]: ['a'] });
    expect(await attempts.handedIn('ps-1', QUIZ_KEY, 0)).toBe(1);
  });

  it('hands in again a paper whose marking was lost, and never one that was marked', async () => {
    // The other half of the same promise. A queue that answered 503 takes the
    // link back (`submit`'s own unlink), but two paths leave the revision
    // `failed` with the paper still naming it: the stall age-out, which writes
    // off a job nobody is running, and a pipeline failure on a queue that does
    // not retry. Both leave a learner with a spent attempt, no verdict and a
    // sheet they could never hand in again, for a worker death they did not
    // cause, and on the last attempt of a required quiz that is the phase and
    // the rest of the project.
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const attemptId = started.attemptId;
    const questionId = started.questions[0]?.id ?? '';
    // Sent as the learner holds it: this paper's token for option `a`.
    const answers = { [questionId]: [optionToken(attemptId, questionId, 'a')] };
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, answers);

    const submissions = dataSource.getRepository(SubmissionEntity);
    const lost = await submissions.save(
      submissions.create({ phaseStateId: 'ps-1', userId: 'u-1', taskKey: QUIZ_KEY, status: 'failed' }),
    );
    await attempts.link(attemptId, lost.id);
    submit.mockClear();

    await expect(service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, {})).resolves.toBe(view);
    expect(submit).toHaveBeenCalledWith(phase(), state, undefined, QUIZ_KEY, { attemptId });
    // The sheet in the record is the one that was handed in (in the teacher's
    // ids), and the quiz's own counter did not move: this is one paper being
    // marked, twice asked.
    expect((await rows.findOneByOrFail({ id: attemptId })).answers).toEqual({ [questionId]: ['a'] });
    expect(await attempts.handedIn('ps-1', QUIZ_KEY, 0)).toBe(1);

    // And a verdict that LANDED is still the end of that paper: the widening
    // is a lost marking, never a second bite at a scored one.
    submit.mockClear();
    for (const status of ['completed', 'queued', 'running'] as const) {
      await submissions.update({ id: lost.id }, { status });
      await expect(service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, {})).rejects.toThrow(
        QUIZ_PAPER_REFUSAL,
      );
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it('will not draw a second paper while the first one is still being marked', async () => {
    // ONE SHEET, TWO PAPERS, ONE VERDICT: the shape that has no other guard.
    // `UQ_quiz_attempts_open` constrains nothing once a row is closed, which
    // is exactly the state a paper waiting for its verdict is in; the grader
    // scores *the newest handed-in row*, so a second paper drawn and handed in
    // meanwhile would be scored by the first paper's job. Refused where the
    // second paper would be drawn, not where its counter has been spent.
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, started.attemptId, {});
    const marking = await dataSource.getRepository(SubmissionEntity).save(
      dataSource.getRepository(SubmissionEntity).create({
        phaseStateId: 'ps-1',
        userId: 'u-1',
        taskKey: QUIZ_KEY,
        status: 'queued',
      }),
    );
    await attempts.link(started.attemptId, marking.id);

    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).rejects.toThrow(/still being marked/);
    // Nothing was drawn, so nothing was spent: one closed row and no open one.
    expect(await attempts.handedIn('ps-1', QUIZ_KEY, 0)).toBe(1);
    expect(await attempts.open('ps-1', QUIZ_KEY)).toBeNull();

    // And the door opens the moment the verdict lands.
    await dataSource
      .getRepository(SubmissionEntity)
      .update({ id: marking.id }, { status: 'completed' });
    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).resolves.toMatchObject({
      attemptId: expect.any(String),
    });
  });

  it('draws again when the last paper never reached the queue', async () => {
    // The same read, on the shape `submit` leaves behind when the queue refuses: a
    // closed paper with no revision named. That is not a marking in flight,
    // and a learner must not be locked out by an outage they did not cause.
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, started.attemptId, {});
    expect((await rows.findOneByOrFail({ id: started.attemptId })).submissionId).toBeNull();
    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).resolves.toMatchObject({
      attemptId: expect.any(String),
    });
  });

  it('refuses a paper drawn against a version this enrolment is no longer pinned to', async () => {
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const attemptId = started.attemptId;
    versionId = 'pv-2';

    await expect(service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, {})).rejects.toThrow(
      /has changed since this paper was drawn/,
    );
    // Refused before the sheet is written: a paper is not scored against a
    // guess, and the row is left exactly as it was drawn.
    expect((await rows.findOneByOrFail({ id: attemptId })).submittedAt).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses a spent limit at hand-in too, without counting the paper in hand', async () => {
    compiledTasks = withChecks(fixtureQuizChecks({ attempts: { max: 1, cooldownSeconds: null } }));
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const attemptId = started.attemptId;
    // The paper in hand is the first attempt, so it hands in: the count it is
    // measured against must not include itself.
    await expect(service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, {})).resolves.toBe(view);

    // A second paper, drawn before the teacher's limit was reached, then
    // handed in after it: the row is open, so the limit is what refuses it.
    await rows.save(
      rows.create({
        phaseStateId: 'ps-1',
        userId: 'u-1',
        taskKey: QUIZ_KEY,
        projectVersionId: VERSION,
        paper: [],
        startedAt: new Date().toISOString(),
        submittedAt: null,
      }),
    );
    const open = await attempts.open('ps-1', QUIZ_KEY);
    await expect(
      service.handIn('u-1', 'ps-1', QUIZ_KEY, open?.id ?? '', {}),
    ).rejects.toThrow(/all 1 attempt/);
  });

  /* ------------- a phase its pin holds in the older format ---------------- */

  it.each([
    ['TaskTrackr 4.0.0\'s Deployment', () => new ContentService().loadProject(layoutFromManifest(olderTaskTrackrPack()).source).phases.find((one) => one.key === 'deployment')!, RUNBOOK_OLDER_FORMAT_ROOM],
    ['a markdown Design', () => ({ ...phase(), checks: { kind: 'markdown' } }) as unknown as PhaseContent, DESIGN_OLDER_FORMAT_ROOM],
  ])('refuses a quiz in %s before any paper is drawn or closed, so the refusal spends no attempt', async (_name, older, sentence) => {
    compiledTasks = withChecks(fixtureQuizChecks({ attempts: { max: 1, cooldownSeconds: null } }));
    // A paper drawn while the pin still answered a structured phase, then the
    // pin answers the older one: nothing grades it, so nothing may close it.
    const held = await service.start('u-1', 'ps-1', QUIZ_KEY);
    loaded = older();

    await expect(service.handIn('u-1', 'ps-1', QUIZ_KEY, held.attemptId, {})).rejects.toThrow(new ConflictException(sentence));
    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).rejects.toThrow(new ConflictException(sentence));
    expect(submit).not.toHaveBeenCalled();
    const row = await rows.findOneByOrFail({ id: held.attemptId });
    expect([row.submittedAt, row.answers]).toEqual([null, null]);
    expect(await rows.count()).toBe(1);
    expect(await attempts.handedIn('ps-1', QUIZ_KEY, 0)).toBe(0);
    // The one attempt the limit allows is still owed.
    expect((await service.room('u-1', 'ps-1', QUIZ_KEY)).attemptsLeft).toBe(1);
  });

  /* --------------------- one sentence for a bad sheet ---------------------- */

  it('refuses an unknown question, an unknown option, a duplicate and a bad value alike', async () => {
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const attemptId = started.attemptId;
    const first = started.questions[0];
    const questionId = first?.id ?? '';
    const optionId = first?.options[0].id ?? '';

    const sheets: Record<string, unknown>[] = [
      { 'no-such-question': [optionId] },
      { [questionId]: ['no-such-option'] },
      { [questionId]: [optionId, optionId] },
      { [questionId]: optionId },
      { [questionId]: [7] },
    ];
    for (const sheet of sheets) {
      await expect(
        service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, sheet as Record<string, string[]>),
      ).rejects.toThrow(QUIZ_SHEET_REFUSAL);
    }

    // One identical sentence, naming neither the question nor the
    // key, so an error message is not an oracle. And nothing was written.
    expect((await rows.findOneByOrFail({ id: attemptId })).submittedAt).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses the teacher’s own id and another paper’s token with that same sentence', async () => {
    // A learner who guessed the authored ids (`a`, `b`, the ids every
    // authoring form writes) or who kept a token from their last paper, is
    // answering some other paper. Accepting either would make the authored
    // order a thing a caller could probe for; refusing it with a sentence of
    // its own would make the refusal the probe.
    const earlier = await service.start('u-1', 'ps-1', QUIZ_KEY);
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, earlier.attemptId, {});
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const shared = started.questions.find((one) =>
      earlier.questions.some((two) => two.id === one.id),
    );
    const question = shared ?? started.questions[0];
    const stale = optionToken(earlier.attemptId, question.id, 'a');
    submit.mockClear();

    for (const sheet of [{ [question.id]: ['a'] }, { [question.id]: ['b'] }, { [question.id]: [stale] }]) {
      await expect(
        service.handIn('u-1', 'ps-1', QUIZ_KEY, started.attemptId, sheet),
      ).rejects.toThrow(QUIZ_SHEET_REFUSAL);
    }
    expect((await rows.findOneByOrFail({ id: started.attemptId })).submittedAt).toBeNull();
    expect(submit).not.toHaveBeenCalled();

    // and the paper's own token for the same option is taken, and stored as `a`
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, started.attemptId, {
      [question.id]: [optionToken(started.attemptId, question.id, 'a')],
    });
    expect((await rows.findOneByOrFail({ id: started.attemptId })).answers).toEqual({
      [question.id]: ['a'],
    });
  });

  /* ------------- a retake prefers what the last paper left out ------------- */

  const askedOn = (paper: { questions: { id: string }[] }) => paper.questions.map((one) => one.id);

  /**
   * Put a handed-in paper at its own instant, `at` seconds into a fixed day.
   * A learner's papers are round trips apart; an in-memory fixture can close
   * two inside one millisecond, and "the last paper" is then a tie the record
   * cannot see through. The existing specs pin order the same way.
   */
  const closedAt = async (attemptId: string, at: number) =>
    rows.update(
      { id: attemptId },
      { submittedAt: new Date(Date.UTC(2026, 8, 21, 0, 0, at)).toISOString() },
    );

  it('asks on a retake both questions the last paper left out', async () => {
    // The fixture is the tightest shape the publish wall's promise has to
    // hold on in practice: five in the pool, three drawn, two left out. A
    // retake asks both of those and repeats one, never the same paper twice.
    const first = await service.start('u-1', 'ps-1', QUIZ_KEY);
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, first.attemptId, {});
    const retake = await service.start('u-1', 'ps-1', QUIZ_KEY);

    const leftOut = fixtureQuizQuestions()
      .map((one) => one.id)
      .filter((id) => !askedOn(first).includes(id));
    expect(leftOut).toHaveLength(2);
    expect(askedOn(retake)).toEqual(expect.arrayContaining(leftOut));
    expect(askedOn(retake).filter((id) => askedOn(first).includes(id))).toHaveLength(1);
  });

  it('asks on the first paper after a reset what the paper the run ended on left out', async () => {
    const before = await sit(3);
    for (const [at, id] of before.entries()) await closedAt(id, at + 1);
    const last = await rows.findOneByOrFail({ id: before[2] });
    await reset();

    const fresh = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const lastAsked = last.paper.map((one) => one.questionId);
    // The run ended with its attempts spent, so the last paper's explanations
    // were released: the new run asks everything that paper did not.
    expect(askedOn(fresh).filter((id) => !lastAsked.includes(id))).toHaveLength(2);
  });

  it('prefers on an optional quiz with no limit exactly as on a required one', async () => {
    compiledTasks = tasks().map((task) =>
      task.taskKey === QUIZ_KEY
        ? { ...task, required: false, checks: fixtureQuizChecks({ attempts: { max: null, cooldownSeconds: null } }) }
        : task,
    );
    let previous = await service.start('u-1', 'ps-1', QUIZ_KEY);
    for (let at = 0; at < 4; at += 1) {
      await service.handIn('u-1', 'ps-1', QUIZ_KEY, previous.attemptId, {});
      await closedAt(previous.attemptId, at + 1);
      const next = await service.start('u-1', 'ps-1', QUIZ_KEY);
      expect(askedOn(next).filter((id) => askedOn(previous).includes(id))).toHaveLength(1);
      previous = next;
    }
  });

  /* ------------------ the lock, and the teacher's recovery ----------------- */

  /**
   * Hand in `count` papers, as a learner grinding through the teacher's limit
   * would, and **land each verdict**, because `submit` is a double here and
   * the real one links the paper to its revision before the job is enqueued.
   *
   * The link is not decoration. A closed paper naming no revision is the shape
   * a queue outage leaves behind, and the room offers exactly that shape back
   * so the sheet can be handed in again; a fixture that skipped the link would
   * be asking these tests about a learner mid-outage while calling them a
   * learner who has used up their papers.
   */
  const sit = async (count: number): Promise<string[]> => {
    const submissions = dataSource.getRepository(SubmissionEntity);
    const sat: string[] = [];
    for (let at = 0; at < count; at += 1) {
      const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
      await service.handIn('u-1', 'ps-1', QUIZ_KEY, started.attemptId, {});
      const marked = await submissions.save(
        submissions.create({
          phaseStateId: 'ps-1',
          userId: 'u-1',
          taskKey: QUIZ_KEY,
          status: 'completed',
        }),
      );
      await attempts.link(started.attemptId, marked.id);
      sat.push(started.attemptId);
    }
    return sat;
  };

  /** What the teacher's `task-reset` lever writes: a new epoch on the task row. */
  const reset = async (): Promise<void> => {
    const row = await taskStates.findOne({ where: { phaseStateId: 'ps-1', taskKey: QUIZ_KEY } });
    if (row) {
      await taskStates.update(
        { id: row.id },
        { status: 'in_progress', passedAt: null, bestScore: null, resetCount: row.resetCount + 1 },
      );
      return;
    }
    await taskStates.save(
      taskStates.create({ phaseStateId: 'ps-1', userId: 'u-1', taskKey: QUIZ_KEY, resetCount: 1 }),
    );
  };

  it('spends the last attempt and then says so, in the refusal and in the room', async () => {
    // THE LOCK, reproduced. Three papers at a limit of three and none of them
    // passed: nothing in the product draws a fourth, and on a REQUIRED quiz
    // that is the phase's gate and the rest of the project behind it. The room has to say
    // so rather than offer a button that refuses.
    await sit(3);
    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).rejects.toThrow(/all 3 attempts/);

    const room = await service.room('u-1', 'ps-1', QUIZ_KEY);
    expect(room.attemptsUsed).toBe(3);
    expect(room.attemptsLeft).toBe(0);
    expect(room.status).not.toBe('passed');
    // Computed on the server from the rows, never a flag a browser could flip.
    expect(room.needsInstructorReset).toBe(true);
  });

  it('offers back the sheet nobody marked, rather than sending the learner to an instructor', async () => {
    // THE RECOVERY THAT HAD NO SURFACE. `paperToHandIn` was widened to take a
    // closed paper whose marking never happened, and `submit` was widened to
    // match, but `open()` answers null on a closed row, so the room drew no
    // paper at all, and on the last allowed one it drew *ask your instructor*
    // over a sheet the route would still have taken. A reset is not what that
    // learner needs: their attempts are not what went wrong, a worker is, and
    // the reset would start an epoch that leaves their sheet behind unmarked.
    await sit(2);
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const question = started.questions[0];
    const answers = { [question?.id ?? '']: [question?.options[0]?.id ?? ''] };
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, started.attemptId, answers);

    // Both shapes of a marking that is never coming, in the order a learner
    // meets them: a revision that never reached the queue, then one that was
    // written off. The room's answer is the same for both.
    const submissions = dataSource.getRepository(SubmissionEntity);
    const dead = await submissions.save(
      submissions.create({
        phaseStateId: 'ps-1',
        userId: 'u-1',
        taskKey: QUIZ_KEY,
        status: 'failed',
      }),
    );
    for (const linked of [false, true]) {
      if (linked) await attempts.link(started.attemptId, dead.id);
      const room = await service.room('u-1', 'ps-1', QUIZ_KEY);
      expect(room.attemptsUsed).toBe(3);
      expect(room.attemptsLeft).toBe(0);
      // Not a state a person has to open. The learner has a control again.
      expect(room.needsInstructorReset).toBe(false);
      expect(room.paper?.attemptId).toBe(started.attemptId);
      // And it says what it is, so a room cannot draw it as a blank paper:
      // handing in a closed sheet re-enqueues the answers already in the
      // record and overwrites nothing, so inputs typed over it are discarded.
      expect(room.paper?.handedInAt).toEqual(expect.any(String));
      expect(room.paper?.selected).toEqual(answers);
      // The seal holds on this payload exactly as on an open paper's.
      expect(JSON.stringify(room)).not.toMatch(/"correct"/);
      expect(JSON.stringify(room)).not.toContain('Fixture explanation');
    }

    // The way out is the hand-in control, and it needs no reset at all: the
    // paper in hand is discounted from the limit it is measured against.
    submit.mockClear();
    await expect(
      service.handIn('u-1', 'ps-1', QUIZ_KEY, started.attemptId, {}),
    ).resolves.toBe(view);
    expect(submit).toHaveBeenCalledWith(phase(), state, undefined, QUIZ_KEY, {
      attemptId: started.attemptId,
    });
    // One paper being marked, twice asked: the counter did not move and the
    // sheet in the record is still the one that was written, in the
    // teacher's ids, which the token the learner sent maps back to.
    expect(await attempts.handedIn('ps-1', QUIZ_KEY, 0)).toBe(3);
    const picked = question?.options[0]?.id ?? '';
    const authored = ['a', 'b'].find(
      (id) => optionToken(started.attemptId, question?.id ?? '', id) === picked,
    );
    expect(authored).toBeDefined();
    expect((await rows.findOneByOrFail({ id: started.attemptId })).answers).toEqual({
      [question?.id ?? '']: [authored],
    });
  });

  /**
   * The web room's own request for that state: the seam that per-paper
   * option tokens open.
   *
   * The room seeds its inputs from `paper.selected` and hands exactly that
   * sheet back (`QuizRoom`'s load, then `handIn`): it holds no other names for
   * the options. `selected` is minted by `sheetInTokens` in one file and read
   * back by `sheetFromTokens` in another, so if the two ever named an option
   * differently the one recovery a learner can reach alone would be refused
   * with the bad-sheet sentence, while the test above, which hands `{}` back,
   * would stay green.
   */
  it('takes back the sheet it offered, in the tokens it offered it in', async () => {
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const answers = Object.fromEntries(
      started.questions.map((question) => [question.id, [question.options[1]?.id ?? '']]),
    );
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, started.attemptId, answers);
    const written = (await rows.findOneByOrFail({ id: started.attemptId })).answers;
    const submissions = dataSource.getRepository(SubmissionEntity);
    const dead = await submissions.save(
      submissions.create({ phaseStateId: 'ps-1', userId: 'u-1', taskKey: QUIZ_KEY, status: 'failed' }),
    );
    await attempts.link(started.attemptId, dead.id);

    const offered = (await service.room('u-1', 'ps-1', QUIZ_KEY)).paper;
    expect(offered?.attemptId).toBe(started.attemptId);
    expect(offered?.handedInAt).toEqual(expect.any(String));
    expect(offered?.selected).toEqual(answers);
    // Every name in `selected` is the name of an option drawn on the same
    // paper, which is how the room ticks the boxes back on.
    for (const question of offered?.questions ?? []) {
      const names = question.options.map((option) => option.id);
      for (const picked of offered?.selected?.[question.id] ?? []) expect(names).toContain(picked);
    }

    submit.mockClear();
    await expect(
      service.handIn('u-1', 'ps-1', QUIZ_KEY, offered!.attemptId, offered!.selected!),
    ).resolves.toBe(view);
    expect(submit).toHaveBeenCalledTimes(1);
    // The record is still the sheet that was written, in the teacher's ids.
    expect((await rows.findOneByOrFail({ id: started.attemptId })).answers).toEqual(written);
  });

  it('says nothing about an instructor while the last paper is still being marked', async () => {
    // `attemptsUsed` counts CLOSED rows, so the sheet just handed in is
    // counted the instant it is written, while this task's row only reads
    // `passed` once the grading job lands. Between the two the room drew *you
    // have handed in every paper on this quiz* over a paper that may well
    // pass: on a reload, or in a second tab, where the room's own in-flight
    // flag is false because the component has just mounted.
    await sit(2);
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    await service.handIn('u-1', 'ps-1', QUIZ_KEY, started.attemptId, {});
    const submissions = dataSource.getRepository(SubmissionEntity);
    const marking = await submissions.save(
      submissions.create({
        phaseStateId: 'ps-1',
        userId: 'u-1',
        taskKey: QUIZ_KEY,
        status: 'queued',
      }),
    );
    await attempts.link(started.attemptId, marking.id);

    for (const status of ['queued', 'running'] as const) {
      await submissions.update({ id: marking.id }, { status });
      const room = await service.room('u-1', 'ps-1', QUIZ_KEY);
      expect(room.attemptsLeft).toBe(0);
      expect(room.needsInstructorReset).toBe(false);
      // And nothing to press either: the sheet is in and its verdict is on
      // its way, so it is neither an open paper nor one owed a mark.
      expect(room.paper).toBeNull();
      expect(room.lastSubmissionId).toBe(marking.id);
    }

    // The moment the verdict lands without a pass, the recovery really is the
    // teacher's, and the room says so again.
    await submissions.update({ id: marking.id }, { status: 'completed' });
    expect((await service.room('u-1', 'ps-1', QUIZ_KEY)).needsInstructorReset).toBe(true);
  });

  it('is not a learner’s problem to solve once they have passed, or while attempts remain', async () => {
    // Two absences, because the copy this flag drives (*ask your instructor*)
    // is wrong in both. A learner still holding an attempt has a button to
    // press, and a learner who has passed has nothing left to ask for.
    await sit(1);
    expect((await service.room('u-1', 'ps-1', QUIZ_KEY)).needsInstructorReset).toBe(false);

    await sit(2);
    await taskStates.save(
      taskStates.create({
        phaseStateId: 'ps-1',
        userId: 'u-1',
        taskKey: QUIZ_KEY,
        status: 'passed',
        bestScore: 100,
      }),
    );
    expect((await service.room('u-1', 'ps-1', QUIZ_KEY)).needsInstructorReset).toBe(false);
  });

  it('asks for a reset when a REQUIRED quiz was signed off with no paper left and no pass behind it', async () => {
    // A teacher's Sign off writes the row `passed` with no paper behind it,
    // and the strict-evidence gate still waits on a passing one. With every
    // paper spent, "your best score is already recorded" would be the wrong
    // answer to a learner whose phase will not open, and `start` refuses
    // them all the same. Reset is the way out, and the room says so.
    compiledTasks = compiledQuizSnapshot({ required: true }).phases.find((one) => one.key === DESIGN)!.tasks;
    await sit(3);
    await taskStates.save(
      taskStates.create({
        phaseStateId: 'ps-1',
        userId: 'u-1',
        taskKey: QUIZ_KEY,
        status: 'passed',
        bestScore: 70,
        signedOffBy: 'ms-tan',
        signedOffAt: '2026-09-29T00:00:00.000Z',
      }),
    );
    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).rejects.toThrow(/all 3 attempts/);
    expect((await service.room('u-1', 'ps-1', QUIZ_KEY)).needsInstructorReset).toBe(true);

    // A passing paper the gate accepts is a learner who is through: no reset.
    const submissions = dataSource.getRepository(SubmissionEntity);
    await submissions.update(
      { phaseStateId: 'ps-1', taskKey: QUIZ_KEY },
      {
        passed: true,
        workspaceSnapshot: {},
        contextSnapshot: { links: [], ranBeforeSubmit: false, drill: null },
        report: {
          assessmentMode: 'strict_binary',
          passed: true,
          checks: [{ id: 'quiz', label: 'Quiz', status: 'passed', detail: '3 of 3' }],
          aiReview: {
            provider: 'not-applicable',
            verdict: 'pass',
            criteriaEvidence: [{ key: 'concepts', met: true, evidence: 'Scored 100.', issue: '', nextStep: '' }],
          },
        } as never,
      },
    );
    expect((await service.room('u-1', 'ps-1', QUIZ_KEY)).needsInstructorReset).toBe(false);
  });

  /**
   * After a Sign off the room could read "Best score 50%" beside two papers
   * marked 0 of 2. The 50 is the sign-off's credit at the pass mark; the room
   * is told so (`passCredited`), by the gate's own predicate, and is
   * told nothing of the kind once a paper has earned a pass.
   */
  it('says a passed row with no passing paper behind it is a teacher’s credit', async () => {
    await sit(2);
    await taskStates.save(
      taskStates.create({
        phaseStateId: 'ps-1',
        userId: 'u-1',
        taskKey: QUIZ_KEY,
        status: 'passed',
        bestScore: 60,
        signedOffBy: 'ms-tan',
        signedOffAt: '2026-09-29T00:00:00.000Z',
      }),
    );
    const credited = await service.room('u-1', 'ps-1', QUIZ_KEY);
    expect(credited.passCredited).toBe(true);
    expect(credited.bestScore).toBe(60);

    // A passing paper the gate accepts: the best score is the learner's own.
    const submissions = dataSource.getRepository(SubmissionEntity);
    await submissions.update(
      { phaseStateId: 'ps-1', taskKey: QUIZ_KEY },
      {
        passed: true,
        workspaceSnapshot: {},
        contextSnapshot: { links: [], ranBeforeSubmit: false, drill: null },
        report: {
          assessmentMode: 'strict_binary',
          passed: true,
          checks: [{ id: 'quiz', label: 'Quiz', status: 'passed', detail: '3 of 3' }],
          aiReview: {
            provider: 'not-applicable',
            verdict: 'pass',
            criteriaEvidence: [{ key: 'concepts', met: true, evidence: 'Scored 100.', issue: '', nextStep: '' }],
          },
        } as never,
      },
    );
    expect('passCredited' in (await service.room('u-1', 'ps-1', QUIZ_KEY))).toBe(false);
  });

  it('carries no credit flag on a quiz nobody has passed', async () => {
    await sit(1);
    expect('passCredited' in (await service.room('u-1', 'ps-1', QUIZ_KEY))).toBe(false);
  });

  it('opens a fresh paper on the epoch the teacher’s reset starts, and numbers it one', async () => {
    const before = await sit(3);
    await reset();

    // The attempts are back, and the count is the new epoch's: history is not
    // deleted, it is simply not what *attempts used* is asking about.
    const room = await service.room('u-1', 'ps-1', QUIZ_KEY);
    expect(room.attemptsUsed).toBe(0);
    expect(room.attemptsLeft).toBe(3);
    expect(room.needsInstructorReset).toBe(false);

    const fresh = await service.start('u-1', 'ps-1', QUIZ_KEY);
    expect(before).not.toContain(fresh.attemptId);
    const row = await rows.findOneByOrFail({ id: fresh.attemptId });
    expect(row.epoch).toBe(1);
    // Every paper they ever sat is still in the record.
    expect(await rows.count()).toBe(4);
    // And the new paper is a new draw, not the one they sat as attempt one.
    const first = await rows.findOneByOrFail({ id: before[0] });
    expect(row.paper).not.toEqual(first.paper);
  });

  it('refuses a paper left open by a reset with the one sentence every wrong id gets', async () => {
    // The teacher resets while a paper is open. That paper belongs to a run
    // the teacher has closed: it is voided rather than deleted, and a stale
    // hand-in of it meets `QUIZ_PAPER_REFUSAL`, the same sentence an unknown
    // id, somebody else's id and an already-graded id meet, so the refusal
    // cannot be used to ask what became of it.
    const stranded = await service.start('u-1', 'ps-1', QUIZ_KEY);
    await attempts.voidOpen('ps-1', QUIZ_KEY);
    await reset();
    submit.mockClear();

    await expect(
      service.handIn('u-1', 'ps-1', QUIZ_KEY, stranded.attemptId, {}),
    ).rejects.toThrow(QUIZ_PAPER_REFUSAL);
    expect(submit).not.toHaveBeenCalled();

    // Voided, never sat: no sheet, no score, no revision, and it counts
    // towards no limit, in its own epoch as much as in the new one.
    const row = await rows.findOneByOrFail({ id: stranded.attemptId });
    expect(row.answers).toBeNull();
    expect(row.score).toBeNull();
    expect(row.submissionId).toBeNull();
    expect((await service.room('u-1', 'ps-1', QUIZ_KEY)).attemptsUsed).toBe(0);
    // And the learner really can start again.
    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).resolves.toMatchObject({
      attemptId: expect.any(String),
    });
  });

  it('leaves an optional quiz with no limit exactly where it was', async () => {
    // The recovery is about a limit being spent. A quiz with none has nothing
    // to give back, and must not start reading as though a teacher owed it
    // something.
    compiledTasks = withChecks(
      fixtureQuizChecks({ attempts: { max: null, cooldownSeconds: null } }),
    );
    await sit(4);
    const room = await service.room('u-1', 'ps-1', QUIZ_KEY);
    expect(room.attemptsLeft).toBeNull();
    expect(room.needsInstructorReset).toBe(false);
    await expect(service.start('u-1', 'ps-1', QUIZ_KEY)).resolves.toMatchObject({
      attemptId: expect.any(String),
    });
  });

  it('takes a blank sheet and a partly filled one', async () => {
    const started = await service.start('u-1', 'ps-1', QUIZ_KEY);
    const attemptId = started.attemptId;
    const one = started.questions[0];
    // No timer, no forced completion: a paper handed in half answered is a
    // paper, and the questions left blank are scored wrong like any other.
    await expect(
      service.handIn('u-1', 'ps-1', QUIZ_KEY, attemptId, { [one?.id ?? '']: [] }),
    ).resolves.toBe(view);
  });
});

/** The fixture's tasks with the quiz's slice replaced, so a spec can set a limit. */
function withChecks(checks: ReturnType<typeof fixtureQuizChecks>): CompiledTask[] {
  const found = snapshot.phases.find((one) => one.key === DESIGN);
  if (!found) throw new Error('the fixture lost its written phase’s tasks');
  return found.tasks.map((task) => (task.taskKey === QUIZ_KEY ? { ...task, checks } : task));
}
