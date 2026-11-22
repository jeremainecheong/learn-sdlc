import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { DEFAULT_QUIZ_PASS_MARK, INHERITED_TASK_KEY } from '@learnsdlc/shared';
import { relianceIndex } from '../src/feedback/checkers';
import type {
  AuthoredQuiz,
  LearnerAnalytics,
  PhaseDetail,
  PublishVersionResult,
  QuizOpenPaper,
  QuizRoomView,
  SolutionView,
} from '@learnsdlc/shared';
import { DESIGN_ARTEFACT, REQUIREMENTS_ARTEFACT } from '../../../e2e/golden-records';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { SandboxService } from '../src/execution/sandbox.service';
import { AuthService } from '../src/auth/auth.service';
import { ContentService } from '../src/content/content.service';
import { compilePack, sandboxBudgetFor } from '../src/content/pack-compiler';
import { QuizAttemptEntity, PhaseStateEntity, TaskStateEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from './quiz-fixture';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * A quiz, end to end, on the wired application.
 *
 * The unit specs prove each half against a hand-built task list, a directly
 * compiled pack or a service double. This is the file
 * that starts at a teacher pressing buttons and ends at a learner leaving a
 * phase, and each of its steps is a join somebody can cut:
 *
 * - leave `tasks.quizKey` out of `AUTHORING_ROUTES` and step 2's key read is a
 *   404 rather than the one audited door that carries an answer;
 * - leave `quiz` off `AddTaskDto` and step 2's body is **silently stripped** by
 *   the global `whitelist: true` pipe, so the teacher's quiz arrives with no
 *   questions;
 * - drop `quiz` from `ARTIFACT_KINDS` and step 3's version is refused at boot;
 * - drop the ownership conjuncts from `servablePhase` and step 9's learner
 *   takes a 500 on their next board with nothing having been refused at
 *   publish;
 * - forget `reportExtras`' quiz guard and step 9's MCQ runs a microVM;
 * - forget the pre-switch fork in `buildReport` and step 6 passes its pass mark
 *   and can never advance;
 * - re-scope `solutionMeta` back to `tasks.length` and step 10's learner
 *   quietly loses a door they had earned, with nothing refusing and nothing
 *   500ing: a button simply stops being drawn.
 *
 * **The seal is asserted over whole serialised payloads**, not field by field.
 * `QuizQuestion.correct` never leaves the API on any route at any time, and
 * `explanation` only once a learner is finished with a question, so the
 * assertion that carries those two rules is a substring test over the whole
 * body: a field added to a payload later is caught by it, and a walk of the
 * fields the payload declares would not be.
 *
 * **The questions here are the FIXTURE quiz** (`quiz-fixture.ts`), which says
 * so in every stem. Real questions are content written and reviewed with a
 * pack, and nothing in this file is one.
 *
 * **TaskTrackr is not touched.** Every version here is a teacher's copy, so
 * `content-golden.spec.ts` and `verdict-golden.spec.ts` cannot move, which
 * step 11 asserts rather than assumes.
 */
describe('a quiz, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  /**
   * The sandbox, counted rather than run.
   *
   * This is a **count**: a quiz hand-in drives this double zero times,
   * whatever phase the quiz sits in. Counting is the whole of what it does, so
   * the one number every executable assertion below reads is this one.
   */
  const execute = jest.fn(async () => ({
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr: 'the sandbox double ran nothing',
    durationMs: 1,
    truncated: false,
  }));

  let teacherToken = '';
  let learnerToken = '';
  let learnerId = '';
  let cohortId = '';
  let joinCode = '';

  /** The teacher's project, its draft, and the version the class is pinned to. */
  let projectId = '';
  let versionId = '';
  let publishedVersionId = '';
  /** The draft opened after 2.0.0, which becomes 3.0.0. */
  let nextVersion = '';
  let slug = '';
  let platformVersionId = '';

  /** The learner's phase state ids, on the pinned version. */
  let requirementsId = '';
  let designId = '';
  let implementationId = '';
  let deploymentId = '';

  const QUIZ_KEY = 'concepts';
  const DEPLOY_QUIZ_KEY = 'deploy-concepts';
  /** 4 of 5 clears it; 5 of 5 is not what the gate asks for. */
  const PASS_MARK = 80;

  /**
   * Eight questions, five drawn.
   *
   * `quiz-retake-is-a-new-paper` refuses a **required** quiz that draws its
   * whole pool, because an unlimited re-sit of a fixed paper is a gate that
   * opens on persistence. So the pool is larger than the draw, which is also
   * what makes "4 of 5" a number rather than a coincidence.
   */
  const POOL = fixtureQuizQuestions(8);
  const authoredQuiz = (over: Partial<AuthoredQuiz> = {}): AuthoredQuiz => ({
    questions: POOL,
    drawn: 5,
    shuffleOptions: true,
    passMark: PASS_MARK,
    attempts: { max: 3, cooldownSeconds: null },
    criterion: 'concepts',
    ...over,
  });

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@quiz-journey.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(
        (await import('../src/db/entities')).UserEntity,
        { id },
        { role },
      );
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const phase = async (token: string, phaseStateId: string): Promise<PhaseDetail> =>
    (await request(http).get(`/api/v1/phases/${phaseStateId}`).set(bearer(token)).expect(200))
      .body as PhaseDetail;

  const taskOf = (detail: PhaseDetail, key: string) =>
    (detail.tasks ?? []).find((one) => one.key === key);

  /** Submit one task and wait for its verdict, as the room's own poll does. */
  const submitTask = async (phaseStateId: string, taskKey: string): Promise<any> => {
    const submitted = await request(http)
      .post(`/api/v1/phases/${phaseStateId}/tasks/${encodeURIComponent(taskKey)}/submit`)
      .set(bearer(learnerToken))
      .expect(201);
    return waitFor(submitted.body.id);
  };

  const waitFor = async (submissionId: string, token = learnerToken): Promise<any> => {
    return waitForSubmission(http, bearer(token), submissionId, { attempts: 100, intervalMs: 200, message: `submission ${submissionId} did not finish` });
  };

  /** Draw a paper, answer every drawn question, hand it in, read the verdict. */
  const sit = async (
    phaseStateId: string,
    taskKey: string,
    pick: (question: QuizOpenPaper['questions'][number], at: number) => string[],
    token = learnerToken,
  ) => {
    const paper = (
      await request(http)
        .post(`/api/v1/phases/${phaseStateId}/tasks/${taskKey}/quiz/attempts`)
        .set(bearer(token))
        .expect(200)
    ).body as QuizOpenPaper;
    // The paper names its options by this paper's own tokens and never by the
    // ids the fixture wrote, so `a`/`b` are not on it anywhere.
    for (const question of paper.questions) {
      for (const option of question.options) expect(['a', 'b']).not.toContain(option.id);
    }
    // THE WEB ROOM'S SIDE OF THE SAME WIRE. The room's fixtures
    // (`apps/web/test/quiz-room.test.tsx`) are written in this shape, so the
    // shape is held here too, where the real tokens are minted.
    for (const question of paper.questions) {
      for (const option of question.options) expect(option.id).toMatch(/^o[0-9a-f]{24}$/);
    }
    // And the room's reload: `QuizRoom` reads `GET …/quiz` on mount and
    // answers whatever `paper` that carries, so a learner who reloads mid-paper
    // must be handed this paper under these names: a token minted afresh per
    // read would turn every answer they give after a reload into a refusal.
    const reloaded = (
      await request(http)
        .get(`/api/v1/phases/${phaseStateId}/tasks/${taskKey}/quiz`)
        .set(bearer(token))
        .expect(200)
    ).body as QuizRoomView;
    expect(reloaded.paper).toEqual(paper);
    // `pick` still says which option it means in the fixture's own letters;
    // the learner finds that option the way a learner does: by what it says.
    const answers: Record<string, string[]> = {};
    paper.questions.forEach((question, at) => {
      answers[question.id] = pick(question, at).map((letter) => optionSaying(question, letter));
    });
    const handed = await request(http)
      .post(`/api/v1/phases/${phaseStateId}/tasks/${taskKey}/quiz/attempts/${paper.attemptId}`)
      .set(bearer(token))
      .send({ answers })
      .expect(201);
    const verdict = await waitFor(handed.body.id, token);
    // The marked paper names the options exactly as the paper served them, and
    // "your answer" is the option the learner picked, by the same name.
    for (const marked of verdict.report?.quiz?.questions ?? []) {
      const served = paper.questions.find((one) => one.id === marked.id);
      expect(marked.options.map((option: any) => option.id)).toEqual(
        served?.options.map((option) => option.id),
      );
      expect(marked.selected).toEqual(answers[marked.id]);
    }
    // The room the learner comes back to draws this verdict: no paper is open,
    // and the revision it names is the one the hand-in returned, which is the
    // row `QuizRoom` fetches to draw the marked paper.
    const after = (
      await request(http)
        .get(`/api/v1/phases/${phaseStateId}/tasks/${taskKey}/quiz`)
        .set(bearer(token))
        .expect(200)
    ).body as QuizRoomView;
    expect(after.paper).toBeNull();
    expect(after.lastSubmissionId).toBe(handed.body.id);
    return { paper, verdict };
  };

  /**
   * The option on this paper whose text is the fixture's option `letter`: how
   * a learner picks, since the id they are sent is this paper's token for it.
   */
  const optionSaying = (question: QuizOpenPaper['questions'][number], letter: string): string => {
    const found = question.options.find((option) =>
      option.text.startsWith(`Option ${letter.toUpperCase()} —`),
    );
    if (!found) throw new Error(`${question.id} offers no option ${letter}`);
    return found.id;
  };

  /**
   * The key, as a string to search a whole body for.
   *
   * `"correct"` is the field name, so it catches a key that travelled under
   * its own name anywhere in a payload, at any depth, in a field nobody has
   * written yet. That is the point of asserting over the serialised body
   * rather than walking the fields the payload declares.
   */
  const KEY_WORDS = ['"correct"', 'Fixture explanation'];

  /**
   * The seal, over a whole serialised LEARNER payload.
   *
   * Three rules in one assertion: no key ever, no explanation until the
   * learner is finished with the question, and no undrawn question at all:
   * `undrawn` is the ids the pool holds and this paper did not. A pool exists
   * so a retake is a different subset, and a pool whose undrawn half leaks is
   * not a pool.
   *
   * `concept` is released **with** the explanation, so it is sealed here
   * for exactly as long as the explanation is.
   */
  const sealedFromLearner = (body: unknown, undrawn: string[] = []) => {
    const text = JSON.stringify(body);
    for (const word of [...KEY_WORDS, 'fixture-concept-']) expect(text).not.toContain(word);
    for (const id of undrawn) expect(text).not.toContain(`"${id}"`);
  };

  /**
   * The seal, over the TEACHER's draft payload.
   *
   * The key and the explanations are withheld here for a sharper reason than
   * the learner's: `readDraft` and `listTasks` are guarded by
   * `requireVisibleProject`, which admits every instructor on the deployment
   * to every platform-owned project and any project to an `ADMIN`, so a
   * payload carrying `correct` would carry it to people who are not the
   * project's owner.
   *
   * `concept` is deliberately **not** sealed from a teacher: it is what the
   * question tests, in their own words, and it is the field the editor draws
   * beside the stem. It is not a key.
   */
  const sealedFromDraft = (body: unknown) => {
    const text = JSON.stringify(body);
    for (const word of KEY_WORDS) expect(text).not.toContain(word);
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes], [SandboxService, { execute, startApp: jest.fn(), stopApp: jest.fn(), statusApp: jest.fn(), assetApp: jest.fn() }]] }));
    db = app.get(DataSource);

    teacherToken = (await account('priya', 'INSTRUCTOR')).token;
    const made = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(teacherToken))
      .send({ name: 'Monday 10am' })
      .expect(201);
    cohortId = made.body.id;
    joinCode = made.body.joinCode;
    const learner = await account('amir');
    learnerToken = learner.token;
    learnerId = learner.id;
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  /* ====================== 1. the copy carries both rows ==================== */

  it('copies a source phase that holds an artefact task and a quiz, and keeps both', async () => {
    const library = await request(http)
      .get('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    platformVersionId = platform.publishedVersionId;

    // A SOURCE with a split design phase, published so it can be copied from.
    // A copy that took only `(compiledPhases.get(key) ?? [])[0]` would drop a
    // quiz ordered second without a word and make a quiz ordered first the
    // copy's `main`.
    const source = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .send({ title: 'Source', slug: `quiz-source-${stamp}`, fromVersionId: platformVersionId })
      .expect(201);
    const sourceProject = source.body.project.id as string;
    const sourceVersion = source.body.draftVersionId as string;

    await request(http)
      .post(
        `/api/v1/instructor/projects/${sourceProject}/versions/${sourceVersion}/phases/design/tasks`,
      )
      .set(bearer(teacherToken))
      .send({
        taskKey: QUIZ_KEY,
        title: 'Check the design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz({ attempts: { max: null, cooldownSeconds: null }, drawn: undefined }),
      })
      .expect(201);

    const sourcePublished = (
      await request(http)
        .post(`/api/v1/instructor/projects/${sourceProject}/versions/${sourceVersion}/publish`)
        .set(bearer(teacherToken))
        .send({ version: '1.0.0', notes: 'A design phase with a formative quiz beside it.' })
        .expect(200)
    ).body as PublishVersionResult;

    // THE COPY. Both rows, in order, the first keyed `main` and each carrying
    // its own checks.
    slug = `overdue-report-${stamp}`;
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .send({ title: 'Overdue Report', slug, fromVersionId: sourcePublished.versionId })
      .expect(201);
    projectId = created.body.project.id;
    versionId = created.body.draftVersionId;

    const copied = (
      await request(http)
        .get(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/phases/design/tasks`)
        .set(bearer(teacherToken))
        .expect(200)
    ).body;
    expect(copied.tasks.map((one: any) => one.taskKey)).toEqual([INHERITED_TASK_KEY, QUIZ_KEY]);
    expect(copied.tasks[1].artefactType).toBe('quiz');
    expect(copied.tasks[1].checkKind).toBe('quiz');
    // `quiz-owns-no-file`: the quiz writes nothing a learner edits, so the
    // inherited task keeps every editable path the phase mounts.
    expect(copied.tasks[1].artefactPath).toBeNull();
    // A written phase holding a quiz is not a phase the wall refuses, and
    // the teacher's editor says so with the same count the compiler uses.
    expect(copied.blocksPublish).toBe(false);

    // THE DRAFT PAYLOAD CARRIES NO KEY. `readDraft` and `listTasks`
    // are guarded by `requireVisibleProject`, which admits every instructor to
    // every platform-owned project and any project to an ADMIN, so the view
    // is `AuthoredQuizView`, with counts and never ids.
    sealedFromDraft(copied);
    expect(copied.tasks[1].quiz.questions[0].answerCount).toBe(1);
    expect(copied.tasks[1].quiz.questions[0]).not.toHaveProperty('explanation');
  }, 120000);

  /* ============== 2. the teacher authors, and is refused first ============= */

  it('refuses a required quiz beside an optional artefact task, by name, then publishes', async () => {
    const taskPath = `/api/v1/instructor/projects/${projectId}/versions/${versionId}/phases/design/tasks`;

    // The copy's quiz is the source's formative one. Make it the gate.
    await request(http)
      .patch(`${taskPath}/${QUIZ_KEY}`)
      .set(bearer(teacherToken))
      .send({ quiz: authoredQuiz() })
      .expect(200);
    await request(http)
      .put(`${taskPath}/${QUIZ_KEY}/required`)
      .set(bearer(teacherToken))
      .send({ required: true })
      .expect(200);

    // …and take the artefact task out of the required set, which is the shape
    // `phase-needs-a-required-artefact-task` exists for: `phaseRollup`
    // quantifies over the required keys and nothing in it asks whether an
    // artefact task is among them, so this would be a phase opened by an MCQ
    // alone: a gate weaker than any other on this platform.
    await request(http)
      .put(`${taskPath}/${INHERITED_TASK_KEY}/required`)
      .set(bearer(teacherToken))
      .send({ required: false })
      .expect(200);

    const refused = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/publish`)
      .set(bearer(teacherToken))
      .send({ version: '2.0.0' })
      .expect(400);
    expect(refused.body.message).toContain('design');
    expect(refused.body.message).toContain('multiple-choice questions alone');

    await request(http)
      .put(`${taskPath}/${INHERITED_TASK_KEY}/required`)
      .set(bearer(teacherToken))
      .send({ required: true })
      .expect(200);

    // THE ONE DOOR THAT CARRIES THE KEY, and it is audited on every read.
    const key = (
      await request(http)
        .get(
          `/api/v1/instructor/projects/${projectId}/versions/${versionId}/phases/design/tasks/${QUIZ_KEY}/quiz/key`,
        )
        .set(bearer(teacherToken))
        .expect(200)
    ).body as AuthoredQuiz;
    expect(key.questions).toHaveLength(8);
    expect(key.questions[0].correct).toEqual(['a']);
    expect(key.passMark).toBe(PASS_MARK);
    const audit = await request(http)
      .get('/api/v1/instructor/audit')
      .set(bearer(teacherToken))
      .expect(200);
    const row = (audit.body.events ?? audit.body).find?.(
      (one: any) => one.event === 'project.quiz-key',
    );
    expect(row).toBeTruthy();
    expect(row.detail.taskTitle).toBe('Check the design concepts');

    const published = (
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/publish`)
        .set(bearer(teacherToken))
        .send({ version: '2.0.0', notes: 'The design phase gains a required concept check.' })
        .expect(200)
    ).body as PublishVersionResult;
    publishedVersionId = published.versionId;
  }, 120000);

  /* ==================== 3. the class, and the enrolment =================== */

  it('assigns the version, and a learner enrols and is pinned to it', async () => {
    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(teacherToken))
      .send({ projectVersionId: publishedVersionId, reason: 'Monday takes the concept check.' })
      .expect(200);
    await request(http)
      .post('/api/v1/enrollments/join')
      .set(bearer(learnerToken))
      .send({ code: joinCode })
      .expect(200);

    // The pin resolves. Drop an ownership conjunct from `servablePhase` and
    // this line is where the 500 lands: publish would still have
    // succeeded, which is why the runtime wall is its own step and not a
    // paragraph.
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(learnerToken))
      .send({ projectSlug: slug })
      .expect(201);
    const by = (key: string) => enrolled.body.phases.find((one: any) => one.key === key).id;
    requirementsId = by('requirements');
    designId = by('design');
    implementationId = by('implementation');
    deploymentId = by('deployment');
  }, 120000);

  /* ================= 4. the room, sealed, over whole payloads ============== */

  it('serves the quiz room with no key, no explanation and no undrawn question', async () => {
    // Requirements first, so the learner is standing on the design phase when
    // step 6 asks `advance` to let them out of it.
    await request(http)
      .put(`/api/v1/phases/${requirementsId}/workspace`)
      .set(bearer(learnerToken))
      .send({ files: REQUIREMENTS_ARTEFACT })
      .expect(200);
    const story = await submitTask(requirementsId, INHERITED_TASK_KEY);
    expect(story.passed).toBe(true);
    await request(http)
      .post(`/api/v1/phases/${requirementsId}/advance`)
      .set(bearer(learnerToken))
      .expect(201);

    // BEFORE THE ATTEMPT.
    const room = (
      await request(http)
        .get(`/api/v1/phases/${designId}/tasks/${QUIZ_KEY}/quiz`)
        .set(bearer(learnerToken))
        .expect(200)
    ).body as QuizRoomView;
    sealedFromLearner(room);
    expect(room.drawn).toBe(5);
    // How many one paper asks, never the size of the pool behind it.
    expect(room.drawn).toBeLessThan(POOL.length);
    expect(room.passMark).toBe(PASS_MARK);
    expect(room.attemptsUsed).toBe(0);
    expect(room.attemptsLeft).toBe(3);
    expect(room.paper).toBeNull();

    // AND THE PHASE PAYLOAD THE BOARD READS: `taskViews` builds `PhaseTaskView`
    // field by field, so a quiz's questions are not in it either.
    const detail = await phase(learnerToken, designId);
    sealedFromLearner(detail);
    const quizView = taskOf(detail, QUIZ_KEY);
    expect(quizView?.artefactType).toBe('quiz');
    expect(quizView?.evidence).toBe('automated');
    expect(quizView?.sealed).toBe(true);
    expect(quizView?.files).toEqual([]);
    expect(quizView).not.toHaveProperty('checks');
  }, 180000);

  /* ======================= 5. a failing attempt ========================== */

  it('fails the paper, names what was wrong and not what was right, and refuses a replay', async () => {
    // Two of five right, which is 40% against a mark of 80.
    const { paper, verdict } = await sit(designId, QUIZ_KEY, (_question, at) =>
      at < 2 ? ['a'] : ['b'],
    );
    const drawnIds = paper.questions.map((one) => one.id);
    const undrawn = POOL.map((one) => one.id).filter((id) => !drawnIds.includes(id));
    expect(undrawn.length).toBe(3);
    // ON THE OPEN PAPER, and on the failing scored report.
    sealedFromLearner(paper, undrawn);
    sealedFromLearner(verdict, undrawn);

    expect(verdict.passed).toBe(false);
    expect(verdict.report.overall).toBe(40);
    // ONE check for the paper, not one per question: `strictTaskEvidencePassed`
    // refuses a stored report holding a check that is not `passed` or `info`,
    // and four callers ask it of this report long after `buildReport` is done
    // with it. A `failed` check per wrong answer would make 100% the real pass
    // mark for ever.
    expect(verdict.report.checks.map((one: any) => one.id)).toEqual(['quiz']);
    // What was wrong, and not what was right.
    const outcomes = verdict.report.quiz.questions.map((one: any) => one.outcome);
    expect(outcomes).toEqual(['right', 'right', 'wrong', 'wrong', 'wrong']);
    // Attempts are not spent, so no question is finished with: no explanation.
    expect(verdict.report.quiz.questions.every((one: any) => one.explanation === null)).toBe(true);
    expect(verdict.report.quiz.attemptsLeft).toBe(2);
    // No model was asked, and the report says which of the two absences it is.
    expect(verdict.report.aiReview.provider).toBe('not-applicable');
    expect(verdict.report.aiReview.verdict).toBe('pass');

    const closed = await db
      .getRepository(QuizAttemptEntity)
      .count({ where: { taskKey: QUIZ_KEY } });
    expect(closed).toBe(1);

    // A REPLAY OF THE SAME ATTEMPT ID is refused by name.
    const replay = await request(http)
      .post(`/api/v1/phases/${designId}/tasks/${QUIZ_KEY}/quiz/attempts/${paper.attemptId}`)
      .set(bearer(learnerToken))
      .send({ answers: Object.fromEntries(drawnIds.map((id) => [id, ['a']])) })
      .expect(400);
    expect(String(replay.body.message)).toMatch(/handed in/i);

    // THE IDE's Cmd-Enter, and a saved script: the generic submit route naming
    // the quiz's key with NO attempt id. It is refused by name, writes no
    // submission and leaves the count where it was.
    const rowsBefore = await db
      .getRepository(TaskStateEntity)
      .findOneOrFail({ where: { phaseStateId: designId, taskKey: QUIZ_KEY } });
    const bypass = await request(http)
      .post(`/api/v1/phases/${designId}/tasks/${QUIZ_KEY}/submit`)
      .set(bearer(learnerToken))
      .expect(400);
    expect(String(bypass.body.message)).toMatch(/quiz/i);
    const rowsAfter = await db
      .getRepository(TaskStateEntity)
      .findOneOrFail({ where: { phaseStateId: designId, taskKey: QUIZ_KEY } });
    expect(rowsAfter.attempts).toBe(rowsBefore.attempts);
    expect(
      await db.getRepository(QuizAttemptEntity).count({ where: { taskKey: QUIZ_KEY } }),
    ).toBe(1);

    // THE AUTHORED ORDER IS NOT A LEVER. The retake is drawn,
    // and a sheet naming the ids the teacher wrote (or a token from the paper
    // just marked) is not an answer to it: the one sentence every bad sheet
    // gets, and nothing written. The retake stays open for step 6 to answer.
    const retake = (
      await request(http)
        .post(`/api/v1/phases/${designId}/tasks/${QUIZ_KEY}/quiz/attempts`)
        .set(bearer(learnerToken))
        .expect(200)
    ).body as QuizOpenPaper;
    const retakeIds = retake.questions.map((one) => one.id);
    // A retake prefers what the last paper left out: eight in
    // the pool and five drawn leaves three unasked, and all three are on it.
    expect(undrawn.every((id) => retakeIds.includes(id))).toBe(true);
    const repeated = retake.questions.find((one) => drawnIds.includes(one.id))!;
    const earlier = paper.questions.find((one) => one.id === repeated.id)!;
    for (const answers of [
      { [repeated.id]: ['a'] },
      { [repeated.id]: [earlier.options[0].id] },
    ]) {
      const refused = await request(http)
        .post(`/api/v1/phases/${designId}/tasks/${QUIZ_KEY}/quiz/attempts/${retake.attemptId}`)
        .set(bearer(learnerToken))
        .send({ answers })
        .expect(400);
      expect(String(refused.body.message)).toMatch(/does not match the paper that was drawn/);
    }
    const still = await db.getRepository(QuizAttemptEntity).findOneByOrFail({ id: retake.attemptId });
    expect(still.submittedAt).toBeNull();
  }, 180000);

  /* ============ 6. four of five, the gate, and the door out =============== */

  it('passes at 4 of 5 against a pass mark of 80, and then advances', async () => {
    const { paper, verdict } = await sit(designId, QUIZ_KEY, (_question, at) =>
      at < 4 ? ['a'] : ['b'],
    );
    expect(verdict.passed).toBe(true);
    // Four of five is 80, which clears the mark and is not 100. The whole
    // point of the number: a per-question `failed` check would have made 100
    // the real mark, silently.
    expect(verdict.report.overall).toBe(80);
    expect(verdict.report.overall).toBeLessThan(100);
    // FINISHED WITH THE QUESTION, so the explanations for the drawn five are
    // released, and only for them. The pool's undrawn three never leave.
    const drawnIds = paper.questions.map((one) => one.id);
    const undrawn = POOL.map((one) => one.id).filter((id) => !drawnIds.includes(id));
    expect(JSON.stringify(verdict)).not.toContain('"correct"');
    for (const id of undrawn) expect(JSON.stringify(verdict)).not.toContain(`"${id}"`);
    expect(verdict.report.quiz.questions.every((one: any) => one.explanation !== null)).toBe(true);

    const detail = await phase(learnerToken, designId);
    expect(taskOf(detail, QUIZ_KEY)?.status).toBe('passed');
    expect(taskOf(detail, QUIZ_KEY)?.bestScore).toBe(80);
    const row = await db
      .getRepository(TaskStateEntity)
      .findOneOrFail({ where: { phaseStateId: designId, taskKey: QUIZ_KEY } });
    expect(row.bestScore).toBe(80);
    expect(detail.bestScore).not.toBeNull();

    // THE PHASE IS STILL SHUT. The quiz is one required key of two.
    expect(detail.status).not.toBe('passed');
    await request(http)
      .post(`/api/v1/phases/${designId}/advance`)
      .set(bearer(learnerToken))
      .expect(400);

    // Now the artefact task.
    await request(http)
      .put(`/api/v1/phases/${designId}/workspace`)
      .set(bearer(learnerToken))
      .send({ files: DESIGN_ARTEFACT })
      .expect(200);
    const artefact = await submitTask(designId, INHERITED_TASK_KEY);
    expect(artefact.passed).toBe(true);

    const opened = await phase(learnerToken, designId);
    expect(opened.status).toBe('passed');

    // AND `advance` SUCCEEDS: the pass mark asked of the product rather than
    // of a predicate. `advance` evaluates the gate a second time and
    // independently, over the **stored** report, at a site `buildReport` never
    // runs at. A journey that asserted only the roll-up would be green here
    // even if the learner could not leave the phase.
    await request(http)
      .post(`/api/v1/phases/${designId}/advance`)
      .set(bearer(learnerToken))
      .expect(201);
  }, 180000);

  /* ====== 6b. every attempt spent, and the teacher's reset that opens it === */

  it('locks a second learner out of the course, and a teacher’s reset gives it back', async () => {
    // THE BLOCKER, end to end. A required quiz failed on every allowed attempt
    // shuts the phase and every phase after it, and nothing the learner can
    // reach opens them: the cap is compulsory on a required quiz, the count is
    // over the papers already handed in, and a live enrolment is never
    // re-pinned, so republishing with a larger cap does not reach them.
    //
    // A second learner, because the first one has passed this quiz and a
    // learner who has passed cannot be locked out of it.
    const stuck = await account('noor');
    await request(http)
      .post('/api/v1/enrollments/join')
      .set(bearer(stuck.token))
      .send({ code: joinCode })
      .expect(200);
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(stuck.token))
      .send({ projectSlug: slug })
      .expect(201);
    const phaseOf = (key: string): string =>
      enrolled.body.phases.find((one: any) => one.key === key).id;
    const theirRequirements = phaseOf('requirements');
    const theirDesign = phaseOf('design');

    // Through requirements, so they are standing on the design phase.
    await request(http)
      .put(`/api/v1/phases/${theirRequirements}/workspace`)
      .set(bearer(stuck.token))
      .send({ files: REQUIREMENTS_ARTEFACT })
      .expect(200);
    const story = await waitFor(
      (
        await request(http)
          .post(`/api/v1/phases/${theirRequirements}/tasks/${encodeURIComponent(INHERITED_TASK_KEY)}/submit`)
          .set(bearer(stuck.token))
          .expect(201)
      ).body.id,
      stuck.token,
    );
    expect(story.passed).toBe(true);
    await request(http)
      .post(`/api/v1/phases/${theirRequirements}/advance`)
      .set(bearer(stuck.token))
      .expect(201);

    // Three papers, none of them passed. One of five right is 20 against 80.
    for (const _ of [1, 2, 3]) {
      const { verdict } = await sit(theirDesign, QUIZ_KEY, (_q, at) => (at < 1 ? ['a'] : ['b']), stuck.token);
      expect(verdict.passed).toBe(false);
    }

    // The room says so, and it says it as a state rather than as a button that
    // would refuse.
    const shut = (
      await request(http)
        .get(`/api/v1/phases/${theirDesign}/tasks/${QUIZ_KEY}/quiz`)
        .set(bearer(stuck.token))
        .expect(200)
    ).body as QuizRoomView;
    expect(shut.attemptsUsed).toBe(3);
    expect(shut.attemptsLeft).toBe(0);
    expect(shut.needsInstructorReset).toBe(true);
    // And the seal holds on this payload too.
    sealedFromLearner(shut);

    // No fourth paper, and no way out of the phase.
    const refused = await request(http)
      .post(`/api/v1/phases/${theirDesign}/tasks/${QUIZ_KEY}/quiz/attempts`)
      .set(bearer(stuck.token))
      .expect(400);
    expect(String(refused.body.message)).toMatch(/all 3 attempts/);
    await request(http)
      .post(`/api/v1/phases/${theirDesign}/advance`)
      .set(bearer(stuck.token))
      .expect(400);

    // THE TEACHER SEES IT, which is what makes the lever reachable: a teacher
    // cannot reset what they cannot tell apart from a learner who has not
    // started.
    const detail = await request(http)
      .get(`/api/v1/instructor/learners/${stuck.id}`)
      .set(bearer(teacherToken))
      .expect(200);
    const theirTasks = detail.body.enrollments
      .flatMap((one: any) => one.phases)
      .find((one: any) => one.id === theirDesign).tasks;
    expect(theirTasks.find((one: any) => one.key === QUIZ_KEY).quizAttemptsSpent).toBe(true);
    // The artefact task beside it is not a quiz and carries no such field.
    expect(theirTasks.find((one: any) => one.key === INHERITED_TASK_KEY)).not.toHaveProperty(
      'quizAttemptsSpent',
    );

    // THE RESET. The ordinary lever a teacher has, doing what they read it as
    // doing.
    await request(http)
      .post(`/api/v1/instructor/learners/${stuck.id}/phases/${theirDesign}/override`)
      .set(bearer(teacherToken))
      .send({
        action: 'task-reset',
        taskKey: QUIZ_KEY,
        reason: 'Noor sat this three times while ill; giving them the concept check again.',
      })
      .expect(200);

    // The attempts are back, and not one paper was deleted.
    const opened = (
      await request(http)
        .get(`/api/v1/phases/${theirDesign}/tasks/${QUIZ_KEY}/quiz`)
        .set(bearer(stuck.token))
        .expect(200)
    ).body as QuizRoomView;
    expect(opened.attemptsUsed).toBe(0);
    expect(opened.attemptsLeft).toBe(3);
    expect(opened.needsInstructorReset).toBe(false);
    expect(opened.bestScore).toBeNull();
    expect(
      await db
        .getRepository(QuizAttemptEntity)
        .count({ where: { userId: stuck.id, taskKey: QUIZ_KEY } }),
    ).toBe(3);

    // A FRESH PAPER, a pass on the new run, and the way on opens.
    const { verdict } = await sit(theirDesign, QUIZ_KEY, (_q, at) => (at < 4 ? ['a'] : ['b']), stuck.token);
    expect(verdict.passed).toBe(true);
    expect(verdict.report.overall).toBe(80);
    // Attempt numbering restarts, because that is what a returned attempt is.
    expect(verdict.report.quiz.attempt).toBe(1);
    expect(verdict.report.quiz.attemptsLeft).toBe(2);

    await request(http)
      .put(`/api/v1/phases/${theirDesign}/workspace`)
      .set(bearer(stuck.token))
      .send({ files: DESIGN_ARTEFACT })
      .expect(200);
    const artefact = await waitFor(
      (
        await request(http)
          .post(`/api/v1/phases/${theirDesign}/tasks/${encodeURIComponent(INHERITED_TASK_KEY)}/submit`)
          .set(bearer(stuck.token))
          .expect(201)
      ).body.id,
      stuck.token,
    );
    expect(artefact.passed).toBe(true);
    await request(http)
      .post(`/api/v1/phases/${theirDesign}/advance`)
      .set(bearer(stuck.token))
      .expect(201);
  }, 300000);

  /* ================= 7. an optional quiz moves nothing ==================== */

  it('opens nothing and moves no average when the same quiz is optional', async () => {
    const before = (
      await request(http)
        .get(`/api/v1/analytics/me?project=${slug}`)
        .set(bearer(learnerToken))
        .expect(200)
    ).body as LearnerAnalytics;

    // The implementation phase, which the learner is now standing on. A copy
    // of the fixture quiz, marked optional, on a phase whose own work is not
    // done: it is scored, it is recorded, and it opens nothing.
    const draft = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions`)
      .set(bearer(teacherToken))
      .send({ fromVersionId: publishedVersionId })
      .expect(201);
    nextVersion = draft.body.versionId as string;
    await request(http)
      .post(
        `/api/v1/instructor/projects/${projectId}/versions/${nextVersion}/phases/implementation/tasks`,
      )
      .set(bearer(teacherToken))
      .send({
        taskKey: 'impl-concepts',
        title: 'Check the implementation concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz({ attempts: { max: null, cooldownSeconds: null }, drawn: undefined }),
      })
      .expect(201);

    // The learner is still pinned to 2.0.0, so this is about the pinned
    // version and not about the draft: the optional quiz they can take is the
    // one already on the board.
    const after = (
      await request(http)
        .get(`/api/v1/analytics/me?project=${slug}`)
        .set(bearer(learnerToken))
        .expect(200)
    ).body as LearnerAnalytics;
    expect(after.averageScore).toBe(before.averageScore);
    expect(after.progressPercent).toBe(before.progressPercent);
    expect(implementationId).toBeTruthy();
  }, 180000);

  /* ============ 8. the two percentages, on three surfaces ================= */

  it('agrees about checklistPercent and masteryPercent on the dashboard, the table and the CSV', async () => {
    const mine = (
      await request(http)
        .get(`/api/v1/analytics/me?project=${slug}`)
        .set(bearer(learnerToken))
        .expect(200)
    ).body as LearnerAnalytics;
    expect(typeof mine.checklistPercent).toBe('number');
    // One quiz taken, best 80, and it is a mean over the quiz tasks that have
    // a score: a second reading of the same rows, for a different question.
    expect(mine.masteryPercent).toBe(80);

    const overview = await request(http)
      .get(`/api/v1/instructor/overview?project=${slug}`)
      .set(bearer(teacherToken))
      .expect(200);
    const row = overview.body.learners.find((one: any) => one.displayName === 'amir');
    expect(row.checklistPercent).toBe(mine.checklistPercent);
    expect(row.masteryPercent).toBe(mine.masteryPercent);

    const csv = await request(http)
      .get(`/api/v1/instructor/gradebook.csv?project=${slug}`)
      .set(bearer(teacherToken))
      .expect(200);
    const [header, ...lines] = csv.text.trim().split('\n').map((line) => line.trim());
    // Appended, because the header is the contract a spreadsheet import reads.
    expect(header.endsWith('checklist %,quiz mastery %')).toBe(true);
    const learnerLine = lines.find((line) => line.includes('amir'))!;
    const cells = learnerLine.split(',');
    expect(cells.at(-2)).toBe(String(mine.checklistPercent));
    expect(cells.at(-1)).toBe(String(mine.masteryPercent));
  }, 120000);

  /* ============ 9. the executable leg: the all-six-phases rule =========== */

  it('puts an optional quiz beside a config task, resolves it, and runs no microVM', async () => {
    // The same draft step 7 opened, which already carries the implementation
    // phase's optional quiz. Both quizzes ship in one version, because that is
    // the version step 10's learner is pinned to when the teacher adds a quiz
    // beside a phase they have already passed.
    const draftVersion = nextVersion;

    await request(http)
      .post(
        `/api/v1/instructor/projects/${projectId}/versions/${draftVersion}/phases/deployment/tasks`,
      )
      .set(bearer(teacherToken))
      .send({
        taskKey: DEPLOY_QUIZ_KEY,
        title: 'Check the deployment concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz({ attempts: { max: null, cooldownSeconds: null }, drawn: undefined }),
      })
      .expect(201);

    // THE BUDGET IS THE NUMBER IT WAS. `sandboxBudgetFor` sums runs and mutants
    // per task and a quiz's units are all `question`, so it adds zero, which
    // is the whole argument for letting one sit beside an executable task.
    const compiled = compilePack(app.get(ContentService).getProject('tasktrackr'));
    expect(compiled.sandboxBudgetByPhase).toEqual({
      requirements: 0,
      design: 0,
      implementation: 4,
      testing: 10,
      deployment: 2,
      maintenance: 4,
    });
    expect(compiled.sandboxBudget).toBe(20);

    const publishedDeploy = (
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${draftVersion}/publish`)
        .set(bearer(teacherToken))
        .send({ version: '3.0.0', notes: 'Quizzes on implementation and deployment.' })
        .expect(200)
    ).body as PublishVersionResult;

    // THE VERSION RESOLVES AT THE ENROLMENT SEAM. A `servablePhase` of
    // `tasks.length < 2 || (markdown && every task markdown)` would let a
    // config phase of one task and one quiz publish and then throw
    // `describeUnservableVersion` at every learner pinned to it.
    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(teacherToken))
      .send({ projectVersionId: publishedDeploy.versionId, reason: 'Monday moves to 3.0.0.' })
      .expect(200);

    // THE PIN IS MOVED HERE RATHER THAN BY A ROUTE, and that is a fact about
    // the product rather than a shortcut. An enrolment is pinned to the
    // version it started on for the life of it (`writeEnrollment`), and
    // re-assigning a class writes the class's assignment without touching a
    // learner's `projectVersionId`, so 3.0.0 reaches the learners who enrol
    // next and no others. A quiz added to a phase learners have already
    // worked reaches them only this way.
    await db.manager.update(
      (await import('../src/db/entities')).EnrollmentEntity,
      { userId: learnerId, projectSlug: slug },
      { projectVersionId: publishedDeploy.versionId },
    );

    const reboard = await request(http)
      .get(`/api/v1/enrollments/mine?project=${slug}`)
      .set(bearer(learnerToken))
      .expect(200);
    const deployment = reboard.body.phases.find((one: any) => one.key === 'deployment');
    deploymentId = deployment.id;

    await db.manager.update(PhaseStateEntity, { id: deploymentId }, { status: 'in_progress' });
    const detail = await phase(learnerToken, deploymentId);
    const keys = (detail.tasks ?? []).map((one) => one.key);
    expect(keys).toEqual([INHERITED_TASK_KEY, DEPLOY_QUIZ_KEY]);

    // The server half of the IDE room's rule: the executable task keeps its own
    // files, the quiz owns none, so the IDE room has one file list to open on
    // and one task to key its memory to.
    expect(taskOf(detail, DEPLOY_QUIZ_KEY)?.files).toEqual([]);
    expect((taskOf(detail, INHERITED_TASK_KEY)?.files ?? []).length).toBeGreaterThan(0);

    // THE PHASE'S BRIEF is the CONFIG task's, not the quiz's. An overlay that
    // took `tasks[0]` would let a quiz ordered first put its brief on
    // `PhaseContent.taskPanel`: read by the room, the mentor's
    // system prompt, the mentor cache identity, `integrityFor`'s `given` set
    // and the maintenance map.
    expect(detail.taskPanel).not.toContain(FIXTURE_QUIZ_NOTICE);

    // The executable task's door is shut for its own reason: it has not passed.
    // `solution.service.ts` refuses unless the task's own gate is in, so this
    // is the route's gate rather than the pack's answer.
    await request(http)
      .get(`/api/v1/phases/${deploymentId}/tasks/${INHERITED_TASK_KEY}/solution`)
      .set(bearer(learnerToken))
      .expect(403);

    // THE QUIZ HAND-IN RUNS NO MICROVM. `reportExtras` is keyed on
    // `phase.key`, so without its quiz guard a quiz handed in here would reach
    // `drillFor`, which runs a smoke check against the pack's faulted copy: a
    // real sandbox run, billed to a hand-in that scored an MCQ by set equality.
    const runsBefore = execute.mock.calls.length;
    const { verdict } = await sit(deploymentId, DEPLOY_QUIZ_KEY, () => ['a']);
    expect(execute).toHaveBeenCalledTimes(runsBefore);
    expect(verdict.report.drill).toBeUndefined();
    expect(verdict.report.ci).toBeUndefined();
    expect(verdict.report.contract).toBeUndefined();
    expect(verdict.report.impact).toBeUndefined();
    expect(verdict.passed).toBe(true);

    // AND PASSING THE OPTIONAL QUIZ OPENS NOTHING.
    const after = await phase(learnerToken, deploymentId);
    expect(taskOf(after, DEPLOY_QUIZ_KEY)?.status).toBe('passed');
    expect(after.status).not.toBe('passed');

    // With a pass behind it: a learner who has passed
    // an optional quiz on a phase that ships an answer reads `available: false`
    // with no `solutionFiles` path on the payload. `referenceFiles` reads
    // `checksOf(phase, task)`, so a quiz (which carries its own `QuizChecks`
    // slice) answers `quiz` rather than falling through to the `default:`
    // arm's word, `config`. This is the one place in the product where a
    // passing task sits beside a phase that ships a model answer, and it is
    // the reason the sole-task slice exemption is written for the executable task and
    // never for the quiz.
    const quizDoor = (
      await request(http)
        .get(`/api/v1/phases/${deploymentId}/tasks/${DEPLOY_QUIZ_KEY}/solution`)
        .set(bearer(learnerToken))
        .expect(200)
    ).body as SolutionView;
    expect(quizDoor.available).toBe(false);
    expect(quizDoor.unavailableReason).toBe('quiz');
    expect(quizDoor.files ?? []).toEqual([]);
    sealedFromLearner(quizDoor);

    // THE GUARD IS NOT A BLANKET: the same phase's EXECUTABLE task still buys
    // the phase-specific sections. (Whether its smoke reaches a microVM is a
    // question about the learner's own Dockerfile, which this fixture does not
    // write; `feedback.service.spec.ts` and `quiz-report-extras.spec.ts` hold
    // the run count, and what is asserted here is that the sections are back.)
    const config = await submitTask(deploymentId, INHERITED_TASK_KEY);
    expect(config.report.ci).toBeDefined();
    expect(config.report.drill).toBeDefined();
  }, 240000);

  /* =============== 10. the door a learner had already earned ============== */

  it('keeps the answer door a learner earned when a teacher adds a quiz beside it', async () => {
    // The learner is on the implementation phase and their pin now carries the
    // optional `impl-concepts` quiz beside the inherited code task: the exact
    // shape a `WorkflowService.solutionMeta` gated on `tasks.length !== 1`
    // would withdraw the phase's answer door for.
    //
    // This is the step that would otherwise fail silently. Nothing
    // refuses and nothing 500s: a button simply stops being drawn.
    // `PhaseTaskView.solution` exists and nothing in `apps/web` reads it, so
    // every learner surface for the door is phase-level: the button, the read
    // line, the journal event and the dossier field all go at once.
    await db.manager.update(
      PhaseStateEntity,
      { id: implementationId },
      { status: 'in_progress' },
    );
    const detail = await phase(learnerToken, implementationId);
    expect((detail.tasks ?? []).map((one) => one.key)).toEqual([
      INHERITED_TASK_KEY,
      'impl-concepts',
    ]);
    // `solutionMeta` reads the phase's sole NON-QUIZ task, so it answers for
    // the code task exactly as it would if that task were the phase's only one:
    // the pack ships an answer for a `code` phase, so the door is there to be
    // earned. Re-scope it back to `tasks.length` and this line reads false.
    const door = detail.solution!;
    expect(door.available).toBe(true);
    expect(door.files).toBeGreaterThan(0);
    expect(door.readAt).toBeNull();
    expect(taskOf(detail, 'impl-concepts')?.solution).toMatchObject({ available: false, files: 0 });
    expect(taskOf(detail, INHERITED_TASK_KEY)?.solution.available).toBe(true);

    // ONE FIXTURE, BOTH DOORS. The quiz's own is shut on the same payload,
    // read off `PhaseTaskView.solution` rather than off the route: the route
    // is gated on a pass this learner has not taken, and what this asserts is
    // the pair of answers the phase gives, not the gate.
  }, 180000);

  /* ================== 11. TaskTrackr, unmoved and unasked ================= */

  it('leaves TaskTrackr byte-identical: the content digest and the budgets are where they were', async () => {
    const content = app.get(ContentService);
    const compiled = compilePack(content.getProject('tasktrackr'));
    // Every phase of the shipped project is its synthesised sole task and no
    // phase of it declares a quiz, so every quiz branch is dead code there:
    // safe by construction, asserted rather than assumed.
    // `content-golden.spec.ts` and `verdict-golden.spec.ts`
    // hold the digests themselves and are run whole, never regenerated.
    for (const phaseContent of content.getProject('tasktrackr').phases) {
      expect(phaseContent.checks.kind).not.toBe('quiz');
      const tasks = compiled.phases.find((one) => one.key === phaseContent.key)!.tasks;
      expect(tasks).toHaveLength(1);
      expect(sandboxBudgetFor(phaseContent, tasks)).toBe(
        compiled.sandboxBudgetByPhase[phaseContent.key],
      );
    }
    expect(compiled.sandboxBudget).toBe(20);
  }, 120000);

  /* ======= quiz hand-ins are exempt from the reliance ratio ======= */

  it('reads the same relianceIndex after a quiz retake as before it', async () => {
    // A quiz hand-in must not dilute the hints-to-attempts ratio. The exemption lives
    // where the denominator is spent, so this is the same fact asked of the
    // product: two more papers, and the number a learner reads does not move.
    await request(http)
      .post(`/api/v1/phases/${deploymentId}/hints`)
      .set(bearer(learnerToken))
      .send({ question: 'What does a smoke test actually prove?' })
      .catch(() => undefined);

    const before = (
      await request(http)
        .get(`/api/v1/analytics/me?project=${slug}`)
        .set(bearer(learnerToken))
        .expect(200)
    ).body as LearnerAnalytics;

    await sit(deploymentId, DEPLOY_QUIZ_KEY, () => ['a']);
    await sit(deploymentId, DEPLOY_QUIZ_KEY, () => ['b']);

    const after = (
      await request(http)
        .get(`/api/v1/analytics/me?project=${slug}`)
        .set(bearer(learnerToken))
        .expect(200)
    ).body as LearnerAnalytics;
    expect(after.relianceIndex).toBe(before.relianceIndex);
    // And the formula itself is untouched: `checkers.ts` is not forked, which
    // is what the verdict-golden net covers.
    expect(relianceIndex(0, 5)).toBe(0);
    expect(DEFAULT_QUIZ_PASS_MARK).toBe(60);
  }, 240000);

  /* =================== the reveal a teacher chooses ===================== */

  it('an optional capped quiz set to "after every attempt" shows its explanations on a failed paper; without the choice it does not', async () => {
    // The joins, through the real routes: the DTO line (the global pipe strips
    // an undeclared property, so without it the choice never reaches the
    // service), the fork that writes it into the row, the compile and publish
    // that carry the row into the pinned snapshot, and `revealRuleFor` at the
    // verdict. A required quiz refuses the choice by name.
    const { EnrollmentEntity } = await import('../src/db/entities');
    const pinned = await db.manager.findOneByOrFail(EnrollmentEntity, { userId: learnerId, projectSlug: slug });
    const draft = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions`)
      .set(bearer(teacherToken))
      .send({ fromVersionId: pinned.projectVersionId })
      .expect(201);
    const draftVersion = draft.body.versionId as string;
    const tasksAt = `/api/v1/instructor/projects/${projectId}/versions/${draftVersion}/phases/deployment/tasks`;
    const capped = { max: 3, cooldownSeconds: null };

    // a required quiz is refused the choice, in the rule's own sentence
    const refused = await request(http)
      .post(tasksAt)
      .set(bearer(teacherToken))
      .send({
        taskKey: 'reveal-gated',
        title: 'A gated check',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: true,
        quiz: authoredQuiz({ attempts: capped, revealExplanation: 'always' }),
      })
      .expect(400);
    expect(JSON.stringify(refused.body)).toContain(
      'A gated check is required, and only an optional quiz chooses when its explanations are shown',
    );

    const add = (taskKey: string, title: string, quiz: AuthoredQuiz) =>
      request(http)
        .post(tasksAt)
        .set(bearer(teacherToken))
        .send({ taskKey, title, brief: FIXTURE_QUIZ_NOTICE, artefactType: 'quiz', required: false, quiz })
        .expect(201);
    // each its own question ids: a question id is what scores it, so two quizzes
    // in one phase cannot share one
    await add(
      'reveal-always',
      'Practice, shown every time',
      authoredQuiz({ questions: fixtureQuizQuestions(8, 'ra'), attempts: capped, revealExplanation: 'always' }),
    );
    await add('reveal-plain', 'Practice, as built', authoredQuiz({ questions: fixtureQuizQuestions(8, 'rp'), attempts: capped }));
    await add(
      'reveal-on-pass',
      'Practice, shown on a pass',
      authoredQuiz({
        questions: fixtureQuizQuestions(8, 'ro'),
        attempts: { max: null, cooldownSeconds: null },
        revealExplanation: 'on-pass',
      }),
    );

    // the editor reads the choice back, and the draft stays sealed
    const listed = await request(http).get(tasksAt).set(bearer(teacherToken)).expect(200);
    sealedFromDraft(listed.body);
    const reveals = Object.fromEntries(
      (listed.body.tasks as any[]).filter((one) => one.quiz).map((one) => [one.taskKey, one.quiz.revealExplanation ?? null]),
    );
    expect(reveals).toMatchObject({ 'reveal-always': 'always', 'reveal-plain': null, 'reveal-on-pass': 'on-pass' });

    const published = (
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${draftVersion}/publish`)
        .set(bearer(teacherToken))
        .send({ version: '4.0.0', notes: 'Practice quizzes that show their explanations.' })
        .expect(200)
    ).body as PublishVersionResult;
    // the pin moves the way step 9 moves it, for the reason step 9 gives
    await db.manager.update(
      EnrollmentEntity,
      { userId: learnerId, projectSlug: slug },
      { projectVersionId: published.versionId },
    );
    await request(http).get(`/api/v1/enrollments/mine?project=${slug}`).set(bearer(learnerToken)).expect(200);

    const explanationsOf = (verdict: any): Array<string | null> =>
      (verdict.report.quiz.questions as any[]).map((one) => one.explanation);

    // 'always' on a capped optional quiz: a failed paper with attempts left
    // shows every explanation
    const always = (await sit(deploymentId, 'reveal-always', () => ['b'])).verdict;
    expect(always.passed).toBe(false);
    expect(explanationsOf(always)).toHaveLength(5);
    expect(explanationsOf(always).every((one) => typeof one === 'string' && one.includes('Fixture explanation'))).toBe(true);

    // absent on a capped optional quiz: the default rule, so a failed paper with
    // attempts left shows none
    const plain = (await sit(deploymentId, 'reveal-plain', () => ['b'])).verdict;
    expect(plain.passed).toBe(false);
    expect(explanationsOf(plain).every((one) => one === null)).toBe(true);
    expect(JSON.stringify(plain.report)).not.toContain('Fixture explanation');

    // 'on-pass' on an UNLIMITED optional quiz closes the door the default rule
    // would open for a formative quiz: a failed paper shows none
    const onPass = (await sit(deploymentId, 'reveal-on-pass', () => ['b'])).verdict;
    expect(onPass.passed).toBe(false);
    expect(explanationsOf(onPass).every((one) => one === null)).toBe(true);
  }, 240000);
});
