import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { INHERITED_TASK_KEY } from '@learnsdlc/shared';
import type { PhaseDetail, PublishVersionResult, QuizOpenPaper } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { ContentService } from '../src/content/content.service';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import { AuthoringService } from '../src/authoring/authoring.service';
import { ProjectEntity, ProjectVersionEntity, UserEntity } from '../src/db/entities';
import { RESET_REFUSALS } from '../src/workflow/learner-reset';
import { mockAiForRoutes } from './mock-ai';
import type { Fork } from './tasktrackr-phase';
import {
  CLOSING_PHASE,
  HOST_ARCHITECTURE,
  HOST_PHASE,
  HOST_QUIZ_KEYS,
  HOST_RECORD,
  HOST_RUNBOOK,
  HOST_WORK,
  LEAD_IN_PHASE,
  LEAD_IN_WORK,
  MIDDLE_PHASE,
  MIDDLE_WORK,
  addHostQuizzes,
  copyHost,
  hostQuizBody,
  importHostPack,
  importHostPackThreePhase,
  stampDeepReceipt,
} from './written-phase-pack';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * What the host (`test/written-phase-pack.ts`) promises the specs that ride it,
 * on the wired application and the real grader:
 *
 * - `HOST_WORK` passes the story task of the one-phase host (Shelf's
 *   Requirements), so a spec that writes it is writing passing work, not just
 *   bytes;
 * - a copy's phase holds the story task and the two quizzes `addHostQuizzes`
 *   adds and publishes; with a quiz removed and the sign-off mark on the story
 *   task it still publishes;
 * - a learner's reset is task-scoped: the story task's reset starts its record
 *   over and leaves a quiz's open paper; a quiz refuses a learner's reset;
 * - each quiz is titled by its key, and a learner sits a host quiz's paper
 *   through the real paper and submission routes and passes it;
 * - the two reference files are mounted read-only, and the host is imported as
 *   a platform version;
 * - the three-phase variant (Shelf's Requirements, Design and Implementation)
 *   publishes as a teacher's copy on a stamped deep receipt, a learner passes its lead-in with
 *   `LEAD_IN_WORK` and enters the middle (Design) phase at order 2, and
 *   advancing that phase on `MIDDLE_WORK` opens order 3 rather than the
 *   course-completion refusal.
 */
describe('the story host, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  let teacherToken = '';
  let teacherId = '';

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@written-phase-pack.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const submitTask = async (token: string, phaseStateId: string, taskKey: string): Promise<any> => {
    const submitted = await request(http)
      .post(`/api/v1/phases/${phaseStateId}/tasks/${encodeURIComponent(taskKey)}/submit`)
      .set(bearer(token))
      .expect(201);
    return waitForSubmission(http, bearer(token), submitted.body.id, { attempts: 100, intervalMs: 200, message: `the ${taskKey} submission did not finish` });
  };

  /**
   * A teacher's copy of the version (`prepare` run on its draft first, untouched
   * without one), published and given to a new class; a learner enrolled on it.
   */
  const learnerOnCopy = async (fromVersionId: string, slug: string, name: string, prepare?: (fork: Fork) => Promise<void>) => {
    const cohort = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(teacherToken))
      .send({ name: `Class ${slug}` })
      .expect(201);
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .send({ title: `Copy ${slug}`, slug, fromVersionId })
      .expect(201);
    await prepare?.({ projectId: created.body.project.id, versionId: created.body.draftVersionId });
    const published = (
      await request(http)
        .post(`/api/v1/instructor/projects/${created.body.project.id}/versions/${created.body.draftVersionId}/publish`)
        .set(bearer(teacherToken))
        .send({ version: '1.0.0' })
        .expect(200)
    ).body as PublishVersionResult;
    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohort.body.id}/project`)
      .set(bearer(teacherToken))
      .send({ projectVersionId: published.versionId, reason: 'This class works the story host.' })
      .expect(200);
    const who = await account(name);
    await request(http).post('/api/v1/enrollments/join').set(bearer(who.token)).send({ code: cohort.body.joinCode }).expect(200);
    const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(who.token)).send({ projectSlug: slug }).expect(201);
    const idOf = (key: string) => enrolled.body.phases.find((one: any) => one.key === key).id as string;
    return { ...who, enrolment: enrolled.body, idOf };
  };

  const world = () => ({ content: app.get(ContentService), dataSource: db, registry: app.get(ProjectRegistryService) });

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
    const teacher = await account('host-teacher', 'INSTRUCTOR');
    teacherToken = teacher.token;
    teacherId = teacher.id;
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  const teacher = () => ({ id: teacherId, role: 'INSTRUCTOR' as const, cohort: 'default' });
  const publish = (fork: Fork) =>
    request(http)
      .post(`/api/v1/instructor/projects/${fork.projectId}/versions/${fork.versionId}/publish`)
      .set(bearer(teacherToken))
      .send({ version: '1.0.0' });

  it('HOST_WORK passes the story task of the one-phase host', async () => {
    const hostVersionId = await importHostPack(world(), { slug: `shelf-host-${stamp}` });
    const who = await learnerOnCopy(hostVersionId, `shelf-host-copy-${stamp}`, 'rafa');
    const phaseId = who.idOf(HOST_PHASE);

    await request(http).put(`/api/v1/phases/${phaseId}/workspace`).set(bearer(who.token)).send({ files: HOST_WORK }).expect(200);
    const verdict = await submitTask(who.token, phaseId, INHERITED_TASK_KEY);
    expect(verdict.passed).toBe(true);
    expect(verdict.taskKey).toBe(INHERITED_TASK_KEY);
    // the story floor's own checks ran and every one passed, not only the score
    const checks = verdict.report.checks as { id: string; status: string }[];
    expect(checks.map((check) => check.id)).toEqual(expect.arrayContaining(['story.record']));
    expect(checks.filter((check) => check.status !== 'passed')).toEqual([]);
  }, 120000);

  it('a copy holding the story task and two quizzes publishes; with one quiz removed and the sign-off mark on the story task it still publishes', async () => {
    const hostVersionId = await importHostPack(world(), { slug: `shelf-host-tasks-${stamp}` });
    const service = app.get(AuthoringService);
    const tasksOf = async (fork: Fork) =>
      (await service.readDraft(teacher(), fork.projectId, fork.versionId)).phases
        .find((phase) => phase.key === HOST_PHASE)!
        .tasks.map((task) => task.taskKey);

    const three = await copyHost({ service }, hostVersionId, `shelf-host-three-tasks-${stamp}`, teacher());
    await addHostQuizzes({ service }, three, HOST_PHASE, teacher());
    expect(await tasksOf(three)).toEqual([INHERITED_TASK_KEY, ...HOST_QUIZ_KEYS]);
    await publish(three).expect(200);

    const two = await copyHost({ service }, hostVersionId, `shelf-host-two-tasks-${stamp}`, teacher());
    await addHostQuizzes({ service }, two, HOST_PHASE, teacher());
    await service.removeTask(teacher(), two.projectId, two.versionId, HOST_PHASE, HOST_QUIZ_KEYS[1]);
    await service.updateTask(teacher(), two.projectId, two.versionId, HOST_PHASE, INHERITED_TASK_KEY, { signOff: true });
    expect(await tasksOf(two)).toEqual([INHERITED_TASK_KEY, HOST_QUIZ_KEYS[0]]);
    await publish(two).expect(200);
  }, 120000);

  it("a learner's reset is task-scoped: the story task starts its record over and leaves a quiz's open paper, and a quiz's own reset is refused", async () => {
    const hostVersionId = await importHostPack(world(), { slug: `shelf-host-reset-${stamp}` });
    const who = await learnerOnCopy(hostVersionId, `shelf-host-reset-copy-${stamp}`, 'ines', (fork) =>
      addHostQuizzes({ service: app.get(AuthoringService) }, fork, HOST_PHASE, teacher()),
    );
    const phaseId = who.idOf(HOST_PHASE);
    const quizRoom = `/api/v1/phases/${phaseId}/tasks/${HOST_QUIZ_KEYS[0]}/quiz`;
    await request(http).put(`/api/v1/phases/${phaseId}/workspace`).set(bearer(who.token)).send({ files: HOST_WORK }).expect(200);
    const paper = (await request(http).post(`${quizRoom}/attempts`).set(bearer(who.token)).expect(200)).body;

    const before = await request(http).get(`/api/v1/phases/${phaseId}`).set(bearer(who.token)).expect(200);
    const quizReset = await request(http)
      .post(`/api/v1/phases/${phaseId}/tasks/${HOST_QUIZ_KEYS[0]}/reset`)
      .set(bearer(who.token))
      .send({ baseVersion: before.body.workspaceUpdatedAt })
      .expect(400);
    expect(quizReset.body.message).toBe(RESET_REFUSALS.quiz);
    const done = await request(http)
      .post(`/api/v1/phases/${phaseId}/tasks/${INHERITED_TASK_KEY}/reset`)
      .set(bearer(who.token))
      .send({ baseVersion: before.body.workspaceUpdatedAt })
      .expect(201);
    expect(done.body.workspace[HOST_RECORD]).toBeUndefined();
    expect((await request(http).get(quizRoom).set(bearer(who.token)).expect(200)).body.paper).toEqual(paper);
  }, 120000);

  it('titles each quiz by its key, and a learner sits a host quiz through the paper and submission routes and passes it', async () => {
    expect(hostQuizBody('late-marker').title).toBe('Concept check: late-marker');
    const hostVersionId = await importHostPack(world(), { slug: `shelf-host-quiz-${stamp}` });
    const who = await learnerOnCopy(hostVersionId, `shelf-host-quiz-copy-${stamp}`, 'tomas', (fork) =>
      addHostQuizzes({ service: app.get(AuthoringService) }, fork, HOST_PHASE, teacher()),
    );
    const phaseId = who.idOf(HOST_PHASE);
    const before = (await request(http).get(`/api/v1/phases/${phaseId}`).set(bearer(who.token)).expect(200)).body as PhaseDetail;
    expect((before.tasks ?? []).filter((task) => task.key !== INHERITED_TASK_KEY).map((task) => [task.key, task.title])).toEqual(
      HOST_QUIZ_KEYS.map((key) => [key, `Concept check: ${key}`]),
    );

    // the paper, answered with the option the fixture keys (by what it says, as a learner picks)
    const room = `/api/v1/phases/${phaseId}/tasks/${HOST_QUIZ_KEYS[0]}/quiz`;
    const paper = (await request(http).post(`${room}/attempts`).set(bearer(who.token)).expect(200)).body as QuizOpenPaper;
    expect(paper.questions).toHaveLength(5);
    const answers = Object.fromEntries(
      paper.questions.map((question) => [question.id, [question.options.find((option) => option.text.startsWith('Option A —'))!.id]]),
    );
    const handed = await request(http).post(`${room}/attempts/${paper.attemptId}`).set(bearer(who.token)).send({ answers }).expect(201);
    const verdict = await waitForSubmission(http, bearer(who.token), handed.body.id, { attempts: 80, intervalMs: 200 });
    expect(verdict?.status).toBe('completed');
    expect(verdict.taskKey).toBe(HOST_QUIZ_KEYS[0]);
    expect(verdict.passed).toBe(true);
    const after = (await request(http).get(`/api/v1/phases/${phaseId}`).set(bearer(who.token)).expect(200)).body as PhaseDetail;
    expect((after.tasks ?? []).find((task) => task.key === HOST_QUIZ_KEYS[0])?.status).toBe('passed');
  }, 120000);

  it('mounts the two reference files read-only, and imports the host as a platform version', async () => {
    const hostVersionId = await importHostPack(world(), { slug: `shelf-host-files-${stamp}` });
    const version = await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: hostVersionId });
    expect((await db.getRepository(ProjectEntity).findOneByOrFail({ id: version.projectId })).platformOwned).toBe(true);
    const files = version.compiled!.content.phases.find((phase) => phase.key === HOST_PHASE)!.files;
    expect(
      files.filter((file) => file.path === HOST_RUNBOOK || file.path === HOST_ARCHITECTURE).map((file) => [file.path, file.editable]),
    ).toEqual([
      // the folder layout's mount order is the path order
      [HOST_ARCHITECTURE, false],
      [HOST_RUNBOOK, false],
    ]);
  });

  it('the three-phase variant publishes, opens its middle (Design) phase at order 2 after the lead-in, and advances it to order 3', async () => {
    const hostVersionId = await importHostPackThreePhase(world(), { slug: `shelf-host-three-${stamp}` });
    // Shelf's Implementation is executable, so the copy publishes on a deep receipt (`stampDeepReceipt`)
    const who = await learnerOnCopy(hostVersionId, `shelf-host-three-copy-${stamp}`, 'noor', (fork) => stampDeepReceipt(db, fork.versionId));
    expect(who.enrolment.phases.map((one: any) => [one.key, one.order])).toEqual([
      [LEAD_IN_PHASE, 1],
      [MIDDLE_PHASE, 2],
      [CLOSING_PHASE, 3],
    ]);
    expect(who.enrolment.phases.map((one: any) => one.status)).toEqual(['in_progress', 'locked', 'locked']);

    // the lead-in passes on LEAD_IN_WORK and opens the middle (Design) phase
    const leadInId = who.idOf(LEAD_IN_PHASE);
    await request(http).put(`/api/v1/phases/${leadInId}/workspace`).set(bearer(who.token)).send({ files: LEAD_IN_WORK }).expect(200);
    expect((await submitTask(who.token, leadInId, INHERITED_TASK_KEY)).passed).toBe(true);
    const intoMiddle = await request(http).post(`/api/v1/phases/${leadInId}/advance`).set(bearer(who.token)).expect(201);
    expect(intoMiddle.body.currentPhaseOrder).toBe(2);
    expect(intoMiddle.body.phases.find((one: any) => one.key === MIDDLE_PHASE).status).toBe('in_progress');

    // the middle (Design) phase passes on MIDDLE_WORK, and advancing it opens order 3
    const middleId = who.idOf(MIDDLE_PHASE);
    await request(http).put(`/api/v1/phases/${middleId}/workspace`).set(bearer(who.token)).send({ files: MIDDLE_WORK }).expect(200);
    expect((await submitTask(who.token, middleId, INHERITED_TASK_KEY)).passed).toBe(true);
    const intoClosing = await request(http).post(`/api/v1/phases/${middleId}/advance`).set(bearer(who.token)).expect(201);
    expect(intoClosing.body.currentPhaseOrder).toBe(3);
    expect(intoClosing.body.phases.find((one: any) => one.key === CLOSING_PHASE).status).toBe('in_progress');
  }, 180000);
});
