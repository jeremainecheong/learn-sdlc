import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { INHERITED_TASK_KEY } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { ContentService } from '../src/content/content.service';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import { AuditEventEntity, SubmissionEntity, TaskStateEntity, UserEntity } from '../src/db/entities';
import { inFlightResetRefusal } from '../src/instructor/instructor.service';
import { mockAiForRoutes } from './mock-ai';
import { HOST_PHASE, HOST_QUIZ_KEYS, HOST_WORK, hostQuizBody, importHostPack } from './written-phase-pack';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * On the wired application: a teacher's two reset
 * levers wait for a revision that is still being marked.
 *
 * The unit spec proves the check sits inside `overridePhase`'s enrolment lock.
 * This file proves the rest of the chain a teacher actually pulls: the mounted
 * `POST /instructor/learners/:id/phases/:id/override` route, a revision the
 * learner handed in through their own route and that the real queue is really
 * grading, the one sentence arriving as the 409's message, nothing written
 * while it is refused, and the same press going through once the verdict is
 * in.
 *
 * The revision is held mid-grading rather than faked: the route-level AI double
 * is made to wait on a promise this file releases, so the submission is
 * `running` because a job is running it.
 */
describe('a teacher’s reset waits for a revision still being marked, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  /** The task held mid-grading: the host's story task. Its sibling: a quiz beside it. */
  const HELD = INHERITED_TASK_KEY;
  const SIBLING = HOST_QUIZ_KEYS[0];
  let heldTitle = '';
  const REASON = 'The learner asked to start this task over after the class discussion.';

  let teacherToken = '';
  let learnerToken = '';
  let learnerId = '';
  let phaseId = '';

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@reset-in-flight.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const override = (body: Record<string, unknown>) =>
    request(http)
      .post(`/api/v1/instructor/learners/${learnerId}/phases/${phaseId}/override`)
      .set(bearer(teacherToken))
      .send({ reason: REASON, ...body });

  const settled = async (submissionId: string): Promise<any> => {
    return waitForSubmission(http, bearer(learnerToken), submissionId, { attempts: 100, intervalMs: 100, message: 'the held submission never finished' });
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);

    // The teacher's class, on a copy of the host (`test/written-phase-pack.ts`,
    // Shelf's Requirements) whose phase holds its story task and a quiz of the
    // teacher's beside it: a split phase, so the per-task lever is live on it.
    const teacher = await account('mei', 'INSTRUCTOR');
    teacherToken = teacher.token;
    const cohort = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(teacherToken))
      .send({ name: 'Friday 10am' })
      .expect(201);
    const hostVersionId = await importHostPack(
      { content: app.get(ContentService), dataSource: db, registry: app.get(ProjectRegistryService) },
      { slug: `release-in-flight-${stamp}` },
    );
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .send({ title: 'Reset Race', slug: `reset-race-${stamp}`, fromVersionId: hostVersionId })
      .expect(201);
    const projectId = created.body.project.id as string;
    const versionId = created.body.draftVersionId as string;
    await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/phases/${HOST_PHASE}/tasks`)
      .set(bearer(teacherToken))
      .send(hostQuizBody(SIBLING))
      .expect(201);
    const published = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/publish`)
      .set(bearer(teacherToken))
      .send({ version: '1.0.0', notes: 'Requirements split in two.' })
      .expect(200);
    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohort.body.id}/project`)
      .set(bearer(teacherToken))
      .send({ projectVersionId: published.body.versionId, reason: 'Friday works the split copy this term.' })
      .expect(200);

    const learner = await account('tomas');
    learnerToken = learner.token;
    learnerId = learner.id;
    await request(http)
      .post('/api/v1/enrollments/join')
      .set(bearer(learnerToken))
      .send({ code: cohort.body.joinCode })
      .expect(200);
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(learnerToken))
      .send({})
      .expect(201);
    // The host's phase is its first, so it is open on enrolment
    phaseId = enrolled.body.phases.find((one: any) => one.key === HOST_PHASE).id;
    await request(http).put(`/api/v1/phases/${phaseId}/workspace`).set(bearer(learnerToken)).send({ files: HOST_WORK }).expect(200);
    const detail = await request(http).get(`/api/v1/phases/${phaseId}`).set(bearer(learnerToken)).expect(200);
    heldTitle = detail.body.tasks.find((one: any) => one.key === HELD).title;
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  it('refuses both reset levers by the one sentence while the revision is graded, then lets them through', async () => {
    // Hold the next review mid-flight. The job is really running it: the row
    // reads `running` because the queue claimed it, not because a test wrote it.
    const base = mockAiForRoutes.review.getMockImplementation()!;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockAiForRoutes.review.mockImplementationOnce(async (...args: Parameters<typeof base>) => {
      entered();
      await gate;
      return base(...args);
    });

    const submitted = await request(http)
      .post(`/api/v1/phases/${phaseId}/tasks/${HELD}/submit`)
      .set(bearer(learnerToken))
      .expect(201);
    try {
      await reached;
      const row = await db.getRepository(SubmissionEntity).findOneByOrFail({ id: submitted.body.id });
      expect([row.status, row.taskKey]).toEqual(['running', HELD]);
      const before = await db
        .getRepository(TaskStateEntity)
        .findOneByOrFail({ phaseStateId: phaseId, taskKey: HELD });

      // The per-task lever, on the task being graded.
      const taskRefused = await override({ action: 'task-reset', taskKey: HELD }).expect(409);
      expect(taskRefused.body.message).toBe(inFlightResetRefusal(heldTitle));
      // The phase lever, over every task of the phase.
      const phaseRefused = await override({ action: 'reset-phase' }).expect(409);
      expect(phaseRefused.body.message).toBe(inFlightResetRefusal('Requirements'));
      // A sibling's revision does not hold the per-task lever: the quiz has
      // none in flight, so its reset goes through.
      await override({ action: 'task-reset', taskKey: SIBLING }).expect(200);

      // Refused means nothing written: the task row, and no trail row for either.
      const held = await db
        .getRepository(TaskStateEntity)
        .findOneByOrFail({ phaseStateId: phaseId, taskKey: HELD });
      expect([held.status, held.resetCount, held.resetAt]).toEqual([
        before.status,
        before.resetCount,
        before.resetAt,
      ]);
      const trail = await db.getRepository(AuditEventEntity).find({ where: { targetId: phaseId } });
      expect(trail.map((one) => [one.action, (one.detail as { taskKey?: string } | null)?.taskKey])).toEqual([
        ['task-reset', SIBLING],
      ]);
    } finally {
      release();
    }

    // The verdict lands; the same presses now go through.
    const verdict = await settled(submitted.body.id);
    expect(verdict.status).toBe('completed');
    await override({ action: 'task-reset', taskKey: HELD }).expect(200);
    const reset = await db
      .getRepository(TaskStateEntity)
      .findOneByOrFail({ phaseStateId: phaseId, taskKey: HELD });
    expect([reset.status, reset.bestScore, reset.resetCount]).toEqual(['in_progress', null, 1]);
    await override({ action: 'reset-phase' }).expect(200);
  }, 120000);
});
