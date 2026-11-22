import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { DESIGN_JSON, EMPTY_DESIGN, INHERITED_TASK_KEY, SOLUTION_LOCKED_MESSAGE, serialiseDesign, serialiseStory } from '@learnsdlc/shared';
import type { PhaseDetail, PublishVersionResult, TaskResetPlanView } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { ContentService } from '../src/content/content.service';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import {
  AuditEventEntity,
  SubmissionEntity,
  TaskResetEntity,
  TaskStateEntity,
  UserEntity,
} from '../src/db/entities';
import { RESET_REFUSALS } from '../src/workflow/learner-reset';
import { EARLIER_RUN_NOTE } from '../src/instructor/regrade.service';
import { mockAiForRoutes } from './mock-ai';
import {
  HOST_PHASE,
  HOST_QUIZ_KEYS,
  HOST_RECORD,
  HOST_STORY,
  HOST_WORK,
  LEAD_IN_PHASE,
  LEAD_IN_WORK,
  MIDDLE_PHASE,
  MIDDLE_WORK,
  hostQuizBody,
  importHostPack,
  importHostPackThreePhase,
  stampDeepReceipt,
} from './written-phase-pack';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The learner's reset of one task, through the real `AppModule`:
 *
 * 1. a teacher publishes a copy whose phase holds its work task (A = the
 *    inherited `main`) and a concept quiz beside it (B, optional, so it gates
 *    nothing), and assigns it to the class. A quiz is what a phase takes beside
 *    its one work task, and a learner may not reset a quiz, so A is the task
 *    reset. Steps 2 to 6 are on the host's Requirements
 *    (`test/written-phase-pack.ts`, A the story), open on enrolment; steps 7
 *    and 8 are on its three-phase variant, whose middle (Design) phase (A the
 *    design) is reached by passing the lead-in, because they advance past the
 *    phase to order 3;
 * 2. the learner joins, writes A, gets a failing A and opens a paper of B;
 * 3. reset A: A's record restored, B's open paper untouched, one
 *    `task_resets` row, attempts and history kept, the gate unchanged;
 * 4. a regrade of the pre-reset revision moves no gate, and says so;
 * 5. a post-reset pass of A passes it;
 * 6. a TaskTrackr phase refuses the reset by its sentence;
 * 7. after the phase passes, a teacher reopens A, the learner resets it,
 *    hands in failing work, and the teacher Passes the phase: `advance` is
 *    refused and the answer door is 403, because the only strict pass of A is
 *    of the run the reset ended; a post-reset strict pass then advances;
 * 8. the same with a legacy NULL-epoch passing revision (a row written before
 *    revisions carried a run epoch) seeded first, which the reset stamps with
 *    the run it ends.
 *
 * It also asserts `projectIsDefault` on both enrolments (the lessons seam).
 */
describe('the learner reset, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  const REASON = 'The criteria need another look before this phase can count.';

  const A = INHERITED_TASK_KEY;
  const B = HOST_QUIZ_KEYS[0];
  /** A's failing and passing work: the host's story (one criterion misses the floor), and the middle phase's design (an empty one). */
  const STORY_FAIL = { [HOST_RECORD]: serialiseStory({ ...HOST_STORY, criteria: HOST_STORY.criteria.slice(0, 1) }) };
  const STORY_PASS = HOST_WORK;
  const DESIGN_FAIL = { ...MIDDLE_WORK, [DESIGN_JSON]: serialiseDesign(EMPTY_DESIGN) };
  const DESIGN_PASS = MIDDLE_WORK;

  let teacherToken = '';
  let joinCode = '';
  let ownSlug = '';
  let defaultSlug = '';
  let hostJoinCode = '';
  let hostSlug = '';

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@learner-reset.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const phase = async (token: string, id: string): Promise<PhaseDetail> =>
    (await request(http).get(`/api/v1/phases/${id}`).set(bearer(token)).expect(200)).body as PhaseDetail;
  const taskOf = (detail: PhaseDetail, key: string) => (detail.tasks ?? []).find((one) => one.key === key);

  const write = (token: string, id: string, files: Record<string, string>) =>
    request(http).put(`/api/v1/phases/${id}/workspace`).set(bearer(token)).send({ files }).expect(200);

  const submitTask = async (token: string, id: string, taskKey: string): Promise<any> => {
    const submitted = await request(http)
      .post(`/api/v1/phases/${id}/tasks/${encodeURIComponent(taskKey)}/submit`)
      .set(bearer(token))
      .expect(201);
    return waitForSubmission(http, bearer(token), submitted.body.id, { attempts: 100, intervalMs: 200, message: `the ${taskKey} submission did not finish` });
  };

  const plan = async (token: string, id: string, key: string): Promise<TaskResetPlanView> =>
    (await request(http).get(`/api/v1/phases/${id}/tasks/${key}/reset`).set(bearer(token)).expect(200)).body;

  const reset = async (token: string, id: string, key: string) => {
    const detail = await phase(token, id);
    return request(http)
      .post(`/api/v1/phases/${id}/tasks/${key}/reset`)
      .set(bearer(token))
      .send({ baseVersion: detail.workspaceUpdatedAt ?? null });
  };

  const override = (learnerId: string, id: string, body: Record<string, unknown>) =>
    request(http)
      .post(`/api/v1/instructor/learners/${learnerId}/phases/${id}/override`)
      .set(bearer(teacherToken))
      .send({ reason: REASON, ...body })
      .expect(200);

  /** A learner in the class, enrolled on the teacher's copy of the three-phase variant. */
  const classLearner = async (name: string) => {
    const who = await account(name);
    await request(http).post('/api/v1/enrollments/join').set(bearer(who.token)).send({ code: joinCode }).expect(200);
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(who.token))
      .send({ projectSlug: ownSlug })
      .expect(201);
    const leadInId = enrolled.body.phases.find((one: any) => one.key === LEAD_IN_PHASE).id as string;
    // The lead-in first, so the middle phase opens: its work, its sole task, then advance
    await write(who.token, leadInId, LEAD_IN_WORK);
    expect((await submitTask(who.token, leadInId, INHERITED_TASK_KEY)).passed).toBe(true);
    await request(http).post(`/api/v1/phases/${leadInId}/advance`).set(bearer(who.token)).expect(201);
    const middleId = enrolled.body.phases.find((one: any) => one.key === MIDDLE_PHASE).id as string;
    return { ...who, middleId, enrolment: enrolled.body };
  };

  /** A learner in the host's class, enrolled on the teacher's copy of it. */
  const hostLearner = async (name: string) => {
    const who = await account(name);
    await request(http).post('/api/v1/enrollments/join').set(bearer(who.token)).send({ code: hostJoinCode }).expect(200);
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(who.token))
      .send({ projectSlug: hostSlug })
      .expect(201);
    // the host's phase is its first, so it is open on enrolment
    const phaseId = enrolled.body.phases.find((one: any) => one.key === HOST_PHASE).id as string;
    return { ...who, phaseId, enrolment: enrolled.body };
  };

  /** A learner whose middle phase has passed on strictly reviewed work (A; the quiz B gates nothing). */
  const passedA = async (name: string) => {
    const who = await classLearner(name);
    await write(who.token, who.middleId, DESIGN_PASS);
    expect((await submitTask(who.token, who.middleId, A)).passed).toBe(true);
    expect((await phase(who.token, who.middleId)).status).toBe('passed');
    return who;
  };

  /**
   * The reopen chain: teacher reopens A → learner resets A → failing work → teacher
   * Pass. The gate and the door must stay shut on the discarded run's pass.
   */
  const reopenResetFailPass = async (who: { id: string; token: string; middleId: string }) => {
    await override(who.id, who.middleId, { action: 'task-reopen', taskKey: A });
    const done = await reset(who.token, who.middleId, A);
    expect(done.status).toBe(201);
    await write(who.token, who.middleId, DESIGN_FAIL);
    expect((await submitTask(who.token, who.middleId, A)).passed).toBe(false);
    await override(who.id, who.middleId, { action: 'pass' });
    expect((await phase(who.token, who.middleId)).status).toBe('passed');

    const refused = await request(http)
      .post(`/api/v1/phases/${who.middleId}/advance`)
      .set(bearer(who.token))
      .expect(400);
    expect(String(refused.body.message)).toContain('strict evidence review');
    const door = await request(http)
      .get(`/api/v1/phases/${who.middleId}/tasks/${A}/solution`)
      .set(bearer(who.token))
      .expect(403);
    expect(String(door.body.message)).toBe(SOLUTION_LOCKED_MESSAGE);

    // A post-reset strict pass of A, and the gate opens.
    await write(who.token, who.middleId, DESIGN_PASS);
    expect((await submitTask(who.token, who.middleId, A)).passed).toBe(true);
    const advanced = await request(http)
      .post(`/api/v1/phases/${who.middleId}/advance`)
      .set(bearer(who.token))
      .expect(201);
    expect(advanced.body.currentPhaseOrder).toBe(3);
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);

    teacherToken = (await account('ms-lim', 'INSTRUCTOR')).token;
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacherToken)).expect(200);
    defaultSlug = library.body.library.find((one: any) => one.isDefault).slug;
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  /**
   * A copy whose phase holds the quiz B beside its work task A, published and
   * given to a new class; `deep` stamps the deep receipt a copy with an
   * executable phase (the three-phase variant's Implementation) publishes on.
   */
  const publishSplitCopy = async (fromVersionId: string, slug: string, phaseKey: string, { deep = false } = {}) => {
    const made = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(teacherToken))
      .send({ name: 'Friday 10am' })
      .expect(201);
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .send({ title: 'Reset Copy', slug, fromVersionId })
      .expect(201);
    const projectId = created.body.project.id;
    const versionId = created.body.draftVersionId;
    await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/phases/${phaseKey}/tasks`)
      .set(bearer(teacherToken))
      .send({ ...hostQuizBody(B), required: false })
      .expect(201);
    if (deep) await stampDeepReceipt(db, versionId);
    const published = (
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/publish`)
        .set(bearer(teacherToken))
        .send({ version: '1.0.0', notes: 'Split in two.' })
        .expect(200)
    ).body as PublishVersionResult;
    await request(http)
      .put(`/api/v1/instructor/cohorts/${made.body.id}/project`)
      .set(bearer(teacherToken))
      .send({ projectVersionId: published.versionId, reason: 'Friday writes the overdue report this term.' })
      .expect(200);
    return { cohortId: made.body.id as string, joinCode: made.body.joinCode as string };
  };

  describe('on the host', () => {
    beforeAll(async () => {
      const hostVersionId = await importHostPack(
        { content: app.get(ContentService), dataSource: db, registry: app.get(ProjectRegistryService) },
        { slug: `release-reset-${stamp}` },
      );
      hostSlug = `reset-release-copy-${stamp}`;
      hostJoinCode = (await publishSplitCopy(hostVersionId, hostSlug, HOST_PHASE)).joinCode;
    }, 120000);

    it('fail A, reset A, regrade the old run, pass A; TaskTrackr refuses; projectIsDefault on both', async () => {
      const who = await hostLearner('ines');
      expect(who.enrolment.projectIsDefault).toBe(false);

      // 2. write A; a failing A; a paper of B opened
      await write(who.token, who.phaseId, STORY_FAIL);
      const failed = await submitTask(who.token, who.phaseId, A);
      expect(failed.passed).toBe(false);
      const quizRoom = `/api/v1/phases/${who.phaseId}/tasks/${B}/quiz`;
      const paper = (await request(http).post(`${quizRoom}/attempts`).set(bearer(who.token)).expect(200)).body;
      // The failing revision is made a legacy NULL-epoch row, as a row written
      // before run epochs existed or during a rollback window reads, so the
      // reset below must stamp it and the regrade in step 4 re-runs a NULL
      // revision the reset stamped.
      await db.getRepository(SubmissionEntity).update(
        { phaseStateId: who.phaseId, taskKey: A },
        { resetEpoch: null },
      );
      const before = await phase(who.token, who.phaseId);
      const attemptsBefore = taskOf(before, A)?.attempts;

      // 3. reset A
      const planned = await plan(who.token, who.phaseId, A);
      expect(planned).toMatchObject({ restores: [HOST_RECORD], reseeds: [], protectedBy: [], refusal: null });
      const done = await reset(who.token, who.phaseId, A);
      expect(done.status).toBe(201);
      expect(done.body.workspace[HOST_RECORD]).toBeUndefined();
      expect((await request(http).get(quizRoom).set(bearer(who.token)).expect(200)).body.paper).toEqual(paper);
      expect(done.body.task.key).toBe(A);
      const after = await phase(who.token, who.phaseId);
      expect(after.status).toBe(before.status);
      expect(taskOf(after, A)?.attempts).toBe(attemptsBefore);
      expect(await db.getRepository(TaskResetEntity).count({ where: { userId: who.id } })).toBe(1);
      const history = await db.getRepository(SubmissionEntity).find({ where: { phaseStateId: who.phaseId, taskKey: A } });
      expect(history).toHaveLength(1);
      // the reset closed the run it ended on the old revision
      expect(history[0].resetEpoch).toBe(0);
      expect((await db.getRepository(TaskStateEntity).findOneByOrFail({ phaseStateId: who.phaseId, taskKey: A })).resetCount).toBe(1);

      // 4. a regrade of the pre-reset revision moves no gate, and says so
      await db.getRepository(SubmissionEntity).update({ id: history[0].id }, { packVersion: '0.0.1' });
      const batch = await request(http)
        .post('/api/v1/instructor/regrades')
        .set(bearer(teacherToken))
        .send({ projectSlug: hostSlug, phaseKey: HOST_PHASE, scope: 'everyone', userId: who.id, reason: REASON })
        .expect(201);
      for (let i = 0; i < 100; i++) {
        const status = await request(http).get(`/api/v1/instructor/regrades/${batch.body.id}`).set(bearer(teacherToken)).expect(200);
        if (status.body.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const trail = await db.getRepository(AuditEventEntity).find({ where: { event: 'phase.regrade', subjectUserId: who.id } });
      const ofA = trail.filter((row) => (row.detail as any)?.submissionId && (row.detail as any).run === EARLIER_RUN_NOTE);
      expect(ofA.length).toBeGreaterThan(0);
      expect(taskOf(await phase(who.token, who.phaseId), A)?.status).not.toBe('passed');
      // the regrade row carries the run the reset stamped on its parent
      const regraded = await db.getRepository(SubmissionEntity).find({ where: { regradeOf: history[0].id } });
      expect(regraded.map((row) => row.resetEpoch)).toEqual([0]);

      // 5. a post-reset pass of A
      await write(who.token, who.phaseId, STORY_PASS);
      expect((await submitTask(who.token, who.phaseId, A)).passed).toBe(true);
      expect(taskOf(await phase(who.token, who.phaseId), A)?.status).toBe('passed');

      // 6. TaskTrackr refuses, by its sentence
      const plain = await account('tomas');
      const enrolled = await request(http)
        .post('/api/v1/enrollments')
        .set(bearer(plain.token))
        .send({ projectSlug: defaultSlug })
        .expect(201);
      expect(enrolled.body.projectIsDefault).toBe(true);
      const plainRequirements = enrolled.body.phases.find((one: any) => one.key === 'requirements').id;
      // Any key: a sole-task list is refused before the key is asked about.
      expect((await plan(plain.token, plainRequirements, 'main')).refusal).toBe(RESET_REFUSALS.soleTask);
      const refused = await reset(plain.token, plainRequirements, 'main');
      expect(refused.status).toBe(400);
      expect(String(refused.body.message)).toBe(RESET_REFUSALS.soleTask);
    }, 240000);
  });

  /*
   * A teacher's Pass advances past the phase and opens the next one, so it rides the
   * three-phase variant: the middle (Design) phase at order 2, the closing
   * phase at 3.
   */
  describe("on the host's three-phase variant", () => {
    beforeAll(async () => {
      const hostVersionId = await importHostPackThreePhase(
        { content: app.get(ContentService), dataSource: db, registry: app.get(ProjectRegistryService) },
        { slug: `release-three-reset-${stamp}` },
      );
      ownSlug = `reset-copy-${stamp}`;
      ({ joinCode } = await publishSplitCopy(hostVersionId, ownSlug, MIDDLE_PHASE, { deep: true }));
    }, 120000);

    it('reopen, reset, failing work and a teacher Pass leave the gate and the door shut', async () => {
      const who = await passedA('oskar');
      await reopenResetFailPass(who);
    }, 240000);

    it('a NULL-epoch pass from before H5 does not survive the reset either', async () => {
      const who = await passedA('priya');
      // What a row written before run epochs existed (or an older API during a
      // rollback window) leaves behind.
      await db.getRepository(SubmissionEntity).update(
        { phaseStateId: who.middleId, taskKey: A },
        { resetEpoch: null },
      );
      await reopenResetFailPass(who);
      const stamped = await db.getRepository(SubmissionEntity).find({
        where: { phaseStateId: who.middleId, taskKey: A },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      expect(stamped[0].resetEpoch).toBe(0);
    }, 240000);
  });
});

