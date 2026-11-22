import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  INHERITED_TASK_KEY,
  MULTI_TASK_CHECK_ID,
  QUIZ_ONLY_ADD_REFUSAL,
  SOLE_TASK_KEY,
  SOLUTION_LOCKED_MESSAGE,
} from '@learnsdlc/shared';
import type {
  PhaseDetail,
  PublishVersionResult,
  QuizOpenPaper,
  ValidationReport,
} from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { ContentService } from '../src/content/content.service';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import {
  EnrollmentEntity,
  PhaseStateEntity,
  TaskStateEntity,
  SubmissionEntity,
  UserEntity,
} from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import {
  CLOSING_PHASE,
  HOST_QUIZ_KEYS,
  LEAD_IN_PHASE,
  LEAD_IN_WORK,
  MIDDLE_PHASE,
  MIDDLE_WORK,
  hostQuizBody,
  importHostPackThreePhase,
  stampDeepReceipt,
} from './written-phase-pack';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * Several tasks in one phase, end to end, on the wired application
 * (teacher-authored projects). The split phase is the middle (Design) phase
 * of the host's three-phase variant (`test/written-phase-pack.ts`: Shelf's
 * Requirements, Design and Implementation), at order 2: its design task, a
 * required concept quiz and an optional one, which is what a phase takes
 * beside its one work task. Every learner here passes the lead-in first.
 *
 * The unit specs prove each half against a hand-built task list or a directly
 * compiled pack. This file is the one that starts at
 * a teacher pressing buttons and ends at a learner's gate opening, and each
 * step is a link somebody can cut:
 *
 * - unmount the task view builder and step 2 sees no tasks;
 * - drop `phaseRollup` from the grader and step 3 opens the phase on one
 *   required task of two;
 * - let an optional task into the quantifier and step 4 opens it on the wrong
 *   one;
 * - seed a missing task row as anything but unstarted and step 5 passes a
 *   phase over a row that is not there;
 * - default the kept routes' key to `SOLE_TASK_KEY` and step 7's door answers
 *   404 on a phase that serves one.
 *
 * **The equivalence is asserted beside every one of them**, on a learner of
 * the imported default project, because none of the multi-task machinery may
 * be visible to them.
 */
describe('several tasks in one phase, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  let teacherToken = '';
  let teacherId = '';
  let learnerToken = '';
  let learnerId = '';
  /** A learner in no class at all, who therefore works the imported default. */
  let plainToken = '';
  let cohortId = '';
  let joinCode = '';

  let projectId = '';
  let versionId = '';
  /** The version the class is assigned, and the pin an exported enrolment names. */
  let publishedVersionId = '';
  let ownSlug = '';
  let defaultSlug = '';
  let platformVersionId = '';
  let middleId = '';
  let implementationId = '';
  /** The host's three-phase variant, which the teacher copies. */
  let hostVersionId = '';
  let plainRequirementsId = '';

  /** The second REQUIRED task, a concept quiz, and the OPTIONAL one beside it. */
  const CRITERIA = HOST_QUIZ_KEYS[0];
  const SCOPE = HOST_QUIZ_KEYS[1];

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({
        email: `${name}-${stamp}@task-grain.test`,
        password: PASSWORD,
        displayName: name,
      })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  /** Submit one task of a phase and wait for its verdict. */
  const submitTask = async (
    token: string,
    phaseStateId: string,
    taskKey: string,
  ): Promise<any> => {
    const submitted = await request(http)
      .post(`/api/v1/phases/${phaseStateId}/tasks/${encodeURIComponent(taskKey)}/submit`)
      .set(bearer(token))
      .expect(201);
    return waitForSubmission(http, bearer(token), submitted.body.id, { attempts: 80, intervalMs: 200, message: `the ${taskKey} submission did not finish` });
  };

  const phase = async (token: string, phaseStateId: string): Promise<PhaseDetail> =>
    (await request(http).get(`/api/v1/phases/${phaseStateId}`).set(bearer(token)).expect(200))
      .body as PhaseDetail;

  const taskOf = (detail: PhaseDetail, key: string) =>
    (detail.tasks ?? []).find((one) => one.key === key);

  /**
   * Sit one quiz: draw a paper, answer every question with the option the
   * fixture keys (by what it says, as a learner picks), hand it in and wait.
   */
  const sitQuiz = async (token: string, phaseStateId: string, taskKey: string): Promise<any> => {
    const room = `/api/v1/phases/${phaseStateId}/tasks/${taskKey}/quiz`;
    const paper = (await request(http).post(`${room}/attempts`).set(bearer(token)).expect(200)).body as QuizOpenPaper;
    const answers = Object.fromEntries(
      paper.questions.map((question) => [question.id, [question.options.find((option) => option.text.startsWith('Option A —'))!.id]]),
    );
    const handed = await request(http).post(`${room}/attempts/${paper.attemptId}`).set(bearer(token)).send({ answers }).expect(201);
    return waitForSubmission(http, bearer(token), handed.body.id, { attempts: 80, intervalMs: 200, message: `the ${taskKey} paper did not finish` });
  };

  const rowsFor = (phaseStateId: string) =>
    db.getRepository(TaskStateEntity).find({ where: { phaseStateId }, order: { taskKey: 'ASC' } });

  /** Pass the lead-in and advance, so the middle phase (the split phase) opens. */
  const passLeadIn = async (token: string, enrolled: any) => {
    const leadInId = enrolled.phases.find((one: any) => one.key === LEAD_IN_PHASE).id as string;
    await request(http).put(`/api/v1/phases/${leadInId}/workspace`).set(bearer(token)).send({ files: LEAD_IN_WORK }).expect(200);
    expect((await submitTask(token, leadInId, INHERITED_TASK_KEY)).passed).toBe(true);
    await request(http).post(`/api/v1/phases/${leadInId}/advance`).set(bearer(token)).expect(201);
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);

    const teacher = await account('rahim', 'INSTRUCTOR');
    teacherToken = teacher.token;
    teacherId = teacher.id;
    const made = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(teacherToken))
      .send({ name: 'Thursday 2pm' })
      .expect(201);
    cohortId = made.body.id;
    joinCode = made.body.joinCode;

    const learner = await account('sofia');
    learnerToken = learner.token;
    learnerId = learner.id;
    plainToken = (await account('dana')).token;
    hostVersionId = await importHostPackThreePhase(
      { content: app.get(ContentService), dataSource: db, registry: app.get(ProjectRegistryService) },
      { slug: `release-grain-${stamp}` },
    );
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  /* ------------------------ 1. the teacher's version ----------------------- */

  it('publishes a phase holding two required tasks and one optional', async () => {
    const library = await request(http)
      .get('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    defaultSlug = platform.slug;
    platformVersionId = platform.publishedVersionId;

    ownSlug = `overdue-report-${stamp}`;
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .send({
        title: 'Overdue Report',
        slug: ownSlug,
        fromVersionId: hostVersionId,
      })
      .expect(201);
    projectId = created.body.project.id;
    versionId = created.body.draftVersionId;

    const addTask = (phaseKey: string, body: Record<string, unknown>) =>
      request(http)
        .post(
          `/api/v1/instructor/projects/${projectId}/versions/${versionId}/phases/${phaseKey}/tasks`,
        )
        .set(bearer(teacherToken))
        .send(body);

    // The second REQUIRED task: a concept quiz, which owns no file and so
    // touches none of the design task's.
    const second = await addTask(MIDDLE_PHASE, { ...hostQuizBody(CRITERIA) }).expect(201);
    expect(second.body.phase.tasks.map((one: any) => one.taskKey)).toEqual([
      INHERITED_TASK_KEY,
      CRITERIA,
    ]);
    // A phase holding its work task and a quiz does not block the publish, at
    // the surface a teacher reads it on.
    expect(second.body.phase.blocksPublish).toBe(false);
    expect(second.body.phase.checkKind).toBe('design');

    const third = await addTask(MIDDLE_PHASE, { ...hostQuizBody(SCOPE), required: false }).expect(201);
    expect(third.body.phase.tasks.map((one: any) => one.required)).toEqual([true, true, false]);
    expect(third.body.phase.tasks.slice(1).map((one: any) => one.artefactPath)).toEqual([null, null]);

    const report = (
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/validate`)
        .set(bearer(teacherToken))
        .expect(200)
    ).body as ValidationReport;
    expect(report.publishable).toBe(true);
    expect(report.blocking).toEqual([]);

    // Shelf's Implementation is executable: the copy publishes on a deep receipt
    await stampDeepReceipt(db, versionId);
    const published = (
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/publish`)
        .set(bearer(teacherToken))
        .send({ version: '1.0.0', notes: 'Design split three ways.' })
        .expect(200)
    ).body as PublishVersionResult;
    expect(published.version).toBe('1.0.0');
    publishedVersionId = published.versionId;

    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(teacherToken))
      .send({
        projectVersionId: published.versionId,
        reason: 'Thursday writes the overdue report this term.',
      })
      .expect(200);
  }, 60000);

  it('refuses a second graded task in a phase the code grader marks at the door, by the quiz-only sentence', async () => {
    // The door a teacher meets. A second project, copied from the platform
    // version (TaskTrackr, whose Implementation the code grader marks), so the
    // version published above is untouched. Beside a phase's own work only a
    // concept quiz is added, so the second task never reaches the wall.
    const draft = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .send({ title: 'Walled', slug: `walled-${stamp}`, fromVersionId: platformVersionId })
      .expect(201);
    const walledProject = draft.body.project.id as string;
    const walledVersion = draft.body.draftVersionId as string;

    const refused = await request(http)
      .post(
        `/api/v1/instructor/projects/${walledProject}/versions/${walledVersion}/phases/implementation/tasks`,
      )
      .set(bearer(teacherToken))
      .send({
        taskKey: 'refactor',
        title: 'Write down what you refactored',
        brief: 'Name the function you changed and what it now guarantees.',
        artefactType: 'document',
        required: true,
      })
      .expect(400);
    expect(String(refused.body.message)).toBe(QUIZ_ONLY_ADD_REFUSAL);

    const report = (
      await request(http)
        .post(`/api/v1/instructor/projects/${walledProject}/versions/${walledVersion}/validate`)
        .set(bearer(teacherToken))
        .expect(200)
    ).body as ValidationReport;
    expect(report.checks.find((one) => one.id === MULTI_TASK_CHECK_ID && one.phaseKey === 'implementation')?.status).toBe('passed');
  }, 60000);

  /* --------------------------- 2. the learner's board ---------------------- */

  it('gives the learner three tasks, a row each, and a phase that has not opened', async () => {
    await request(http)
      .post('/api/v1/enrollments/join')
      .set(bearer(learnerToken))
      .send({ code: joinCode })
      .expect(200);
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(learnerToken))
      .send({ projectSlug: ownSlug })
      .expect(201);
    await passLeadIn(learnerToken, enrolled.body);
    middleId = enrolled.body.phases.find((one: any) => one.key === MIDDLE_PHASE).id;
    implementationId = enrolled.body.phases.find((one: any) => one.key === CLOSING_PHASE).id;

    const detail = await phase(learnerToken, middleId);
    expect((detail.tasks ?? []).map((one) => one.key)).toEqual([
      INHERITED_TASK_KEY,
      CRITERIA,
      SCOPE,
    ]);
    expect((detail.tasks ?? []).map((one) => one.required)).toEqual([true, true, false]);
    expect(detail.taskCounts).toEqual({ total: 3, required: 2, passed: 0, passedRequired: 0 });
    // Derived from the units and never chosen: the design task is sealed
    // written work, so `reviewed`; a quiz is marked by its key, so `automated`.
    expect((detail.tasks ?? []).map((one) => one.evidence)).toEqual([
      'reviewed',
      'automated',
      'automated',
    ]);

    // One row per authored task, on this phase and on every other phase of
    // the copy: each of the host's phases holds its inherited task (the
    // closing phase too), so the per-task machinery is live everywhere.
    expect((await rowsFor(middleId)).map((one) => one.taskKey)).toEqual([
      CRITERIA,
      SCOPE,
      INHERITED_TASK_KEY,
    ]);
    expect((await rowsFor(implementationId)).map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY]);

    // The summary view carries the counts and the list without the four heavy
    // fields, which is the whole difference between the two views.
    const summaries = await request(http)
      .get(`/api/v1/phases/summaries?project=${ownSlug}`)
      .set(bearer(learnerToken))
      .expect(200);
    const summary = (summaries.body as PhaseDetail[]).find((one) => one.id === middleId);
    expect(summary?.taskCounts).toEqual({ total: 3, required: 2, passed: 0, passedRequired: 0 });
    expect((summary?.tasks ?? []).map((one) => one.key)).toEqual([
      INHERITED_TASK_KEY,
      CRITERIA,
      SCOPE,
    ]);
    expect(summary?.tasks?.[0].rubric).toBeUndefined();
    expect(summary?.tasks?.[0].brief).toBeUndefined();
    expect(detail.tasks?.[0].rubric).toBeDefined();
  }, 60000);

  /* ------------------ 3. one required task is not the gate ----------------- */

  it('passes the first required task with its own score and leaves the phase shut', async () => {
    await request(http)
      .put(`/api/v1/phases/${middleId}/workspace`)
      .set(bearer(learnerToken))
      .send({ files: MIDDLE_WORK })
      .expect(200);

    const verdict = await submitTask(learnerToken, middleId, INHERITED_TASK_KEY);
    expect(verdict.passed).toBe(true);
    expect(verdict.taskKey).toBe(INHERITED_TASK_KEY);

    const detail = await phase(learnerToken, middleId);
    // The task passed. The phase did not: `phaseRollup` quantifies over the
    // pinned version's REQUIRED keys, and one of two is not all of them.
    expect(taskOf(detail, INHERITED_TASK_KEY)?.status).toBe('passed');
    expect(taskOf(detail, INHERITED_TASK_KEY)?.bestScore).toBe(verdict.score);
    expect(taskOf(detail, CRITERIA)?.status).toBe('in_progress');
    expect(detail.status).toBe('submitted');
    expect(detail.passedAt).toBeNull();
    expect(detail.taskCounts).toEqual({ total: 3, required: 2, passed: 1, passedRequired: 1 });

    await request(http)
      .post(`/api/v1/phases/${middleId}/advance`)
      .set(bearer(learnerToken))
      .expect(400);
  }, 120000);

  it('changes nothing when the optional task passes on its own', async () => {
    const before = await phase(learnerToken, middleId);

    const verdict = await sitQuiz(learnerToken, middleId, SCOPE);
    expect(verdict.passed).toBe(true);

    const after = await phase(learnerToken, middleId);
    expect(taskOf(after, SCOPE)?.status).toBe('passed');
    // Three of the four numbers move; `passedRequired` does not, and neither
    // does the gate or the phase's own score. An optional task is shown,
    // scored and recorded, and moves nothing.
    expect(after.taskCounts).toEqual({ total: 3, required: 2, passed: 2, passedRequired: 1 });
    expect(after.status).toBe('submitted');
    expect(after.passedAt).toBeNull();
    expect(after.bestScore).toBe(before.bestScore);

    await request(http)
      .post(`/api/v1/phases/${middleId}/advance`)
      .set(bearer(learnerToken))
      .expect(400);
  }, 120000);

  /* --------------------- 4. a missing row is a failing row ----------------- */

  it('never counts a required task with no row of its own as a pass', async () => {
    const verdict = await sitQuiz(learnerToken, middleId, CRITERIA);
    expect(verdict.passed).toBe(true);

    const opened = await phase(learnerToken, middleId);
    expect(opened.status).toBe('passed');
    expect(opened.taskCounts).toEqual({ total: 3, required: 2, passed: 3, passedRequired: 2 });

    // Now take the row away, exactly as a bad migration or a half-finished
    // restore would. The submissions are untouched and one of them is a
    // passing revision of this very task.
    await db.getRepository(TaskStateEntity).delete({ phaseStateId: middleId, taskKey: CRITERIA });
    const held = await db
      .getRepository(SubmissionEntity)
      .count({ where: { phaseStateId: middleId, taskKey: CRITERIA, passed: true } });
    expect(held).toBeGreaterThan(0);

    // The read repairs the board, and the row it puts back is an UNSTARTED
    // one, which is what a required key with no row means.
    const healed = await phase(learnerToken, middleId);
    expect(taskOf(healed, CRITERIA)?.status).toBe('in_progress');
    expect(healed.taskCounts).toEqual({ total: 3, required: 2, passed: 2, passedRequired: 1 });

    // `phase_states.status` stays `passed`, and that is the rule rather than a
    // gap: a phase's status is written by a verdict, an override, an import or
    // `advance`'s heal, and none of those has run since the row went. A read
    // does not take a learner's pass away.
    //
    // What the missing row DOES do is refuse the gate, and that is the
    // inversion this case exists for: `advance` quantifies over the pinned
    // version's required keys and every one of them must have a row that
    // reads `passed`. A green tile and a refused gate is the pair to assert,
    // because a build that got this wrong would show neither.
    expect(healed.status).toBe('passed');
    await request(http)
      .post(`/api/v1/phases/${middleId}/advance`)
      .set(bearer(learnerToken))
      .expect(400);

    // and the work is not lost: the learner hands the same task in again.
    const again = await sitQuiz(learnerToken, middleId, CRITERIA);
    expect(again.passed).toBe(true);
    const back = await phase(learnerToken, middleId);
    expect(back.status).toBe('passed');
    expect(back.passedAt).not.toBeNull();
  }, 120000);

  /* ----------------------------- 5. the door ------------------------------- */

  it('answers the answer door per task, and refuses the phase route by name', async () => {
    // Each task's door is shut on its own merits (the pack ships no answer
    // for the design's prose, and a quiz owns no file to show) and that is
    // what the room is told rather than a 403.
    for (const [key, reason] of [[INHERITED_TASK_KEY, 'prose'], [CRITERIA, 'quiz'], [SCOPE, 'quiz']]) {
      const answered = await request(http)
        .get(`/api/v1/phases/${middleId}/tasks/${encodeURIComponent(key)}/solution`)
        .set(bearer(learnerToken))
        .expect(200);
      expect(answered.body.available).toBe(false);
      expect(answered.body.unavailableReason).toBe(reason);
      expect(answered.body.files).toEqual([]);
      expect(answered.body.taskKey).toBe(key);
    }

    // A key the pinned version does not declare is the loader's own 404.
    const unknown = await request(http)
      .get(`/api/v1/phases/${middleId}/tasks/epics/solution`)
      .set(bearer(learnerToken))
      .expect(404);
    expect(String(unknown.body.message)).toBe('unknown task: epics');

    // And the kept phase-level routes name the tasks rather than picking one,
    // because picking one is how a learner's work goes to the wrong grader.
    for (const path of [
      `/api/v1/phases/${middleId}/solution`,
      `/api/v1/phases/${middleId}/submissions`,
    ]) {
      const refused = await request(http).get(path).set(bearer(learnerToken)).expect(400);
      expect(String(refused.body.message)).toBe(
        `This phase has 3 tasks. Submit one of them: ${INHERITED_TASK_KEY}, ${CRITERIA}, ${SCOPE}.`,
      );
    }
    const submitRefused = await request(http)
      .post(`/api/v1/phases/${middleId}/submit`)
      .set(bearer(learnerToken))
      .expect(400);
    expect(String(submitRefused.body.message)).toContain(`${CRITERIA}, ${SCOPE}.`);
  }, 60000);

  /* ------------------- 6. the teacher's lever, and advance ----------------- */

  it("writes the phase down when a teacher reopens one required task, then advances", async () => {
    const reopened = await request(http)
      .post(`/api/v1/instructor/learners/${learnerId}/phases/${middleId}/override`)
      .set(bearer(teacherToken))
      .send({
        action: 'task-reopen',
        taskKey: INHERITED_TASK_KEY,
        reason: 'The design never says what lending a book already on loan answers; look at it again before we move on.',
      })
      .expect(200);
    expect(reopened.body.status).not.toBe('passed');

    const down = await phase(learnerToken, middleId);
    expect(taskOf(down, INHERITED_TASK_KEY)?.status).not.toBe('passed');
    expect(down.status).toBe('in_progress');
    await request(http)
      .post(`/api/v1/phases/${middleId}/advance`)
      .set(bearer(learnerToken))
      .expect(400);

    // The learner answers it again, the gate closes over the required set
    // once more, and the phase opens.
    const verdict = await submitTask(learnerToken, middleId, INHERITED_TASK_KEY);
    expect(verdict.passed).toBe(true);
    const open = await phase(learnerToken, middleId);
    expect(open.status).toBe('passed');

    const advanced = await request(http)
      .post(`/api/v1/phases/${middleId}/advance`)
      .set(bearer(learnerToken))
      .expect(201);
    expect(advanced.body.currentPhaseOrder).toBe(3);
    const next = advanced.body.phases.find((one: any) => one.key === CLOSING_PHASE);
    expect(next.status).toBe('in_progress');
  }, 180000);

  /* ------------------------- 7. the learner who cannot tell ---------------- */

  it('leaves a learner of the imported default project unable to tell', async () => {
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(plainToken))
      .send({ projectSlug: defaultSlug })
      .expect(201);
    plainRequirementsId = enrolled.body.phases.find((one: any) => one.key === 'requirements').id;

    const detail = await phase(plainToken, plainRequirementsId);
    // One task, and it is the synthesised sole one: no switcher to draw, no
    // key in any URL, and no row anywhere in the database.
    expect((detail.tasks ?? []).map((one) => one.key)).toEqual([SOLE_TASK_KEY]);
    expect(detail.taskCounts).toEqual({ total: 1, required: 1, passed: 0, passedRequired: 0 });
    expect(detail.tasksUpdatedAt).toBeNull();
    expect(await rowsFor(plainRequirementsId)).toEqual([]);

    // Every board of this enrolment, not only the phase that was read.
    const states = await db
      .getRepository(PhaseStateEntity)
      .find({ where: { userId: (await db.getRepository(UserEntity).findOneByOrFail({ email: `dana-${stamp}@task-grain.test` })).id } });
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) expect(await rowsFor(state.id)).toEqual([]);

    // And the phase-level routes resolve rather than naming tasks: there is
    // one task, so "the phase's only task" has an answer. The door on work
    // they have not passed is the usual sentence: 403 and
    // `SOLUTION_LOCKED_MESSAGE`, never 404 "unknown task", which is what a
    // key defaulted to `SOLE_TASK_KEY` would answer here.
    const locked = await request(http)
      .get(`/api/v1/phases/${plainRequirementsId}/solution`)
      .set(bearer(plainToken))
      .expect(403);
    expect(String(locked.body.message)).toBe(SOLUTION_LOCKED_MESSAGE);
    await request(http)
      .get(`/api/v1/phases/${plainRequirementsId}/submissions`)
      .set(bearer(plainToken))
      .expect(200);
  }, 120000);

  /* ------------------------------ 8. the export ---------------------------- */

  it('carries the task rows out of the class in the version-3 export', async () => {
    const exported = await request(http)
      .get(`/api/v1/instructor/cohorts/${cohortId}/export.json`)
      .set(bearer(teacherToken))
      .expect(200);
    const document = exported.body;
    expect(document.formatVersion).toBe(3);

    const learner = document.learners.find(
      (one: any) => one.email === `sofia-${stamp}@task-grain.test`,
    );
    expect(learner).toBeDefined();
    const enrolment = learner.enrollments[0];
    const middle = enrolment.phases.find((one: any) => one.phaseKey === MIDDLE_PHASE);
    expect(middle.tasks.map((one: any) => one.taskKey).sort()).toEqual([
      INHERITED_TASK_KEY,
      CRITERIA,
      SCOPE,
    ].sort());
    // Every field of the export's task row, and no `signedOffBy`: an export
    // carries no ids.
    for (const task of middle.tasks) {
      expect(Object.keys(task).sort()).toEqual(
        [
          'attempts',
          'awaitingSignOff',
          'bestScore',
          'countersigned',
          'passedAt',
          'ranBeforeSubmit',
          'resetAt',
          'resetCount',
          'signedOffAt',
          'solutionReadAt',
          'status',
          'taskKey',
        ].sort(),
      );
      expect('signedOffBy' in task).toBe(false);
    }
    // And each revision says which task it answered.
    const keys = new Set(middle.submissions.map((one: any) => one.taskKey));
    expect(keys.has(CRITERIA)).toBe(true);
    expect(keys.has(INHERITED_TASK_KEY)).toBe(true);

    // The audit trail records the lever the teacher pulled, under its own name.
    const events = document.auditEvents.map((one: any) => one.event as string);
    expect(events).toContain('task.reopen');
    expect(teacherId).toBeTruthy();
  }, 60000);

  /* ----------------------- 9. the class on another machine ----------------- */

  /**
   * The round trip, and the one step of it a file cannot carry.
   *
   * The learner this case exports has passed both required tasks and has
   * **not** advanced, because a board whose enrolment has already moved past
   * the phase answers `advance` as a retried one and would prove nothing. So
   * the same board is asked the same question twice: at the source, where it
   * opens, and on the destination, where it does not: until the learner hands
   * the work in again.
   *
   * That refusal is the honest half of the round trip rather than a defect in
   * task rows. A class file carries a revision's verdict, its report and the
   * workspace it was taken from; it has never carried the **context snapshot**
   * the strict evidence gate reads (`CohortExportSubmission` has no field for
   * one, in this format version or in the one before it). So the rows, the
   * scores and the roll-up arrive, the gate reads them, and the evidence half
   * is re-made by the learner on the machine they now work on.
   */
  it('round-trips the class in the v3 file, and the learner is advanceable there once they hand the tasks in again', async () => {
    const meiEmail = `mei-${stamp}@task-grain.test`;
    const mei = await account('mei');
    await request(http)
      .post('/api/v1/enrollments/join')
      .set(bearer(mei.token))
      .send({ code: joinCode })
      .expect(200);
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(mei.token))
      .send({ projectSlug: ownSlug })
      .expect(201);
    await passLeadIn(mei.token, enrolled.body);
    const sourceId = enrolled.body.phases.find((one: any) => one.key === MIDDLE_PHASE).id as string;

    await request(http)
      .put(`/api/v1/phases/${sourceId}/workspace`)
      .set(bearer(mei.token))
      .send({ files: MIDDLE_WORK })
      .expect(200);
    expect((await submitTask(mei.token, sourceId, INHERITED_TASK_KEY)).passed).toBe(true);
    expect((await sitQuiz(mei.token, sourceId, CRITERIA)).passed).toBe(true);

    /** A task row as the file has to carry it: the work, not the machine it is on. */
    const rowShape = (rows: TaskStateEntity[]) =>
      rows.map((row) => ({
        taskKey: row.taskKey,
        status: row.status,
        bestScore: row.bestScore,
        attempts: row.attempts,
        passedAt: row.passedAt,
      }));
    const sourceRows = rowShape(await rowsFor(sourceId));
    expect(sourceRows.map((row) => row.status).sort()).toEqual([
      'in_progress',
      'passed',
      'passed',
    ]);
    const sourcePhase = await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: sourceId });
    expect(sourcePhase.status).toBe('passed');

    // The file, taken the way the panel takes it.
    const exported = await request(http)
      .get(`/api/v1/instructor/cohorts/${cohortId}/export.json`)
      .set(bearer(teacherToken))
      .expect(200);
    const document = exported.body;
    expect(document.formatVersion).toBe(3);
    // What the file carries about a revision, and the one thing it has never
    // carried. `CohortExportSubmission` has a field for the verdict, and for
    // the workspace when the export was asked for snapshots; it has no field
    // in this format version or the one before it for the **context
    // snapshot** the strict evidence gate reads. That absence is the half of
    // the round trip the refusal further down is about, so it is asserted
    // here, on the document, rather than inferred from a 400.
    const fileRevisions = document.learners
      .find((one: any) => one.email === meiEmail)
      .enrollments.find((one: any) => one.projectSlug === ownSlug)
      .phases.find((one: any) => one.phaseKey === MIDDLE_PHASE).submissions;
    expect(fileRevisions.map((one: any) => one.taskKey).sort()).toEqual([
      CRITERIA,
      INHERITED_TASK_KEY,
    ]);
    for (const revision of fileRevisions) {
      expect(revision.passed).toBe(true);
      expect(revision).not.toHaveProperty('contextSnapshot');
    }

    // The same board, at the source: it opens.
    const advancedHere = await request(http)
      .post(`/api/v1/phases/${sourceId}/advance`)
      .set(bearer(mei.token))
      .expect(201);
    expect(advancedHere.body.currentPhaseOrder).toBe(3);

    // As the file arrives on another machine: nobody in it is anybody this
    // deployment already knows, so the import mints every account and moves
    // none of the learners above into the new class.
    const destinationEmail = (email: string) => email.replace('@task-grain.test', '.copy@task-grain.test');
    for (const learner of document.learners) learner.email = destinationEmail(learner.email);
    const meiCopyEmail = destinationEmail(meiEmail);

    const imported = await request(http)
      .post('/api/v1/instructor/cohorts/import')
      .set(bearer(teacherToken))
      .send(document)
      .expect(200);
    expect(imported.body.applied).toBe(true);
    expect(imported.body.cohort.id).not.toBe(cohortId);
    expect(imported.body.createdAccounts).toContain(meiCopyEmail);
    const outcome = imported.body.learners.find((one: any) => one.email === meiCopyEmail);
    expect(outcome.outcome).toBe('created');
    // The roll-up ran on every imported phase and agreed with the file: a
    // phase that had come in shut would have said so here, in the teacher's
    // own sentence.
    expect(String(outcome.note ?? '')).not.toContain('came in shut');

    // The destination board, read from the database before anything repairs it.
    const copy = await db.getRepository(UserEntity).findOneByOrFail({ email: meiCopyEmail });
    const destEnrolment = await db
      .getRepository(EnrollmentEntity)
      .findOneByOrFail({ userId: copy.id, projectSlug: ownSlug });
    // Pinned to the version that graded the work, never to whatever this
    // machine's head is, which is why the task keys below are the same keys.
    expect(destEnrolment.projectVersionId).toBe(publishedVersionId);
    expect(destEnrolment.currentPhaseOrder).toBe(2);
    const destStates = await db
      .getRepository(PhaseStateEntity)
      .find({ where: { enrollmentId: destEnrolment.id }, order: { phaseOrder: 'ASC' } });
    const destPhase = destStates.find((one) => one.phaseKey === MIDDLE_PHASE)!;

    // The task states and their scores arrived, row for row.
    expect(rowShape(await rowsFor(destPhase.id))).toEqual(sourceRows);
    // And the phase the roll-up decided on this machine is the phase the
    // learner left behind on the other one.
    expect([destPhase.status, destPhase.bestScore, destPhase.passedAt]).toEqual([
      sourcePhase.status,
      sourcePhase.bestScore,
      sourcePhase.passedAt,
    ]);

    // The learner, on the machine they now work on. An imported account has no
    // password of its own (the way in is the recovery link) so the session
    // is minted the way every other spec mints one for a row it holds.
    const copyToken = (await app.get(AuthService).issueSession(copy)).token;
    const detail = await phase(copyToken, destPhase.id);
    expect((detail.tasks ?? []).map((one) => one.key)).toEqual([
      INHERITED_TASK_KEY,
      CRITERIA,
      SCOPE,
    ]);
    expect(detail.taskCounts).toEqual({ total: 3, required: 2, passed: 2, passedRequired: 2 });
    expect(taskOf(detail, CRITERIA)?.bestScore).toBe(
      sourceRows.find((row) => row.taskKey === CRITERIA)?.bestScore,
    );

    // The revisions arrived with their verdicts and without their evidence: a
    // strict, passing report on each required key, and `contextSnapshot` null
    // on every one of them, because the file had none to give. That null is
    // the conjunct the gate refuses on: `strictPass` reads
    // `s.workspaceSnapshot && s.contextSnapshot` before it reads the report,
    // never the score and never the task row, both of which the assertions
    // above have just found intact. So the 400 below is this format's missing
    // half, not a defect in task rows, and the case is named for the step
    // that follows it.
    const importedRevisions = await db
      .getRepository(SubmissionEntity)
      .find({ where: { phaseStateId: destPhase.id } });
    expect(importedRevisions.map((one) => one.taskKey).sort()).toEqual([
      CRITERIA,
      INHERITED_TASK_KEY,
    ]);
    for (const revision of importedRevisions) {
      expect([revision.passed, revision.report?.assessmentMode, revision.report?.passed]).toEqual([
        true,
        'strict_binary',
        true,
      ]);
      expect(revision.contextSnapshot).toBeNull();
    }

    // The gate reads the imported rows and refuses on the half the file does
    // not carry: the evidence, never the pass.
    const refused = await request(http)
      .post(`/api/v1/phases/${destPhase.id}/advance`)
      .set(bearer(copyToken))
      .expect(400);
    expect(String(refused.body.message)).toContain('strict evidence review');

    // So the learner hands the same two tasks in again (their workspace came
    // with them) and each verdict moves its own row exactly as it did at the
    // source.
    expect((await submitTask(copyToken, destPhase.id, INHERITED_TASK_KEY)).passed).toBe(true);
    expect((await sitQuiz(copyToken, destPhase.id, CRITERIA)).passed).toBe(true);
    const reopened = await phase(copyToken, destPhase.id);
    expect(reopened.status).toBe('passed');
    expect(reopened.taskCounts).toEqual({ total: 3, required: 2, passed: 2, passedRequired: 2 });

    const advancedThere = await request(http)
      .post(`/api/v1/phases/${destPhase.id}/advance`)
      .set(bearer(copyToken))
      .expect(201);
    expect(advancedThere.body.currentPhaseOrder).toBe(3);
    expect(
      advancedThere.body.phases.find((one: any) => one.key === CLOSING_PHASE).status,
    ).toBe('in_progress');
  }, 180000);
});
