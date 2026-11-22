import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { INHERITED_TASK_KEY, SIGNOFF_ROUTES } from '@learnsdlc/shared';
import type { BulkSignoffResult, PhaseDetail, PublishVersionResult, SignoffQueueView } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { ContentService } from '../src/content/content.service';
import { ProjectVersionEntity } from '../src/content/project.entities';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import { AuditEventEntity, PhaseStateEntity, TaskStateEntity, UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { LEAD_IN_PHASE, LEAD_IN_WORK, MIDDLE_PHASE, MIDDLE_WORK, importHostPackThreePhase, stampDeepReceipt } from './written-phase-pack';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The sign-off queue and the bulk sign-off on the
 * wired application, through `SIGNOFF_ROUTES` as the contract declares them.
 *
 * A teacher's copy of the host's three-phase variant
 * (`test/written-phase-pack.ts`: Shelf's Requirements, Design and
 * Implementation) whose middle (Design) phase at order 2 holds its design
 * task, which the version marks `signOff` (as an uploaded pack may; this spec
 * writes the mark into the published snapshot the way the importer writes it,
 * then reloads the registry). Two learners of the class pass the lead-in,
 * hand the design in and are graded by the real grader: it passes, waits for
 * a countersignature, and the door stays shut. The teacher reads the queue, is
 * refused an empty reason, then signs the class off in one batch: one
 * `class.bulk-signoff` row per learner, each phase opened once, and each
 * learner's Continue now answers (to order 3, the closing phase).
 */
describe('the sign-off queue and the bulk sign-off, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  const REASON = 'Read both designs in the Monday lab.';

  /** The task the version marks for a countersignature: the middle phase's design task. */
  const SIGNED = INHERITED_TASK_KEY;
  let signedTitle = '';

  const path = (key: keyof typeof SIGNOFF_ROUTES, cohortId: string) =>
    `/api/v1${SIGNOFF_ROUTES[key].path.replace(':cohortId', cohortId)}`;

  let teacher = { id: '', token: '' };
  let other = { id: '', token: '' };
  let cohortId = '';
  let joinCode = '';
  let otherCohortId = '';
  let otherJoinCode = '';
  let ownSlug = '';
  let learners: { id: string; token: string; middleId: string }[] = [];
  let outsider = { id: '', token: '', middleId: '' };

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@bulk-signoff.test`, password: PASSWORD, displayName: name })
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
    return waitForSubmission(http, bearer(token), submitted.body.id, { attempts: 80, intervalMs: 200, message: `the ${taskKey} submission did not finish` });
  };

  const phase = async (token: string, phaseStateId: string): Promise<PhaseDetail> =>
    (await request(http).get(`/api/v1/phases/${phaseStateId}`).set(bearer(token)).expect(200)).body as PhaseDetail;

  /** Join a class, enrol on its project, pass the lead-in, write the design and hand it in. */
  const learnerWorks = async (name: string, code: string) => {
    const one = await account(name);
    await request(http).post('/api/v1/enrollments/join').set(bearer(one.token)).send({ code }).expect(200);
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(one.token))
      .send({ projectSlug: ownSlug })
      .expect(201);
    // The lead-in first (its one task), so the middle phase opens
    const leadInId = enrolled.body.phases.find((p: any) => p.key === LEAD_IN_PHASE).id as string;
    await request(http).put(`/api/v1/phases/${leadInId}/workspace`).set(bearer(one.token)).send({ files: LEAD_IN_WORK }).expect(200);
    expect((await submitTask(one.token, leadInId, INHERITED_TASK_KEY)).passed).toBe(true);
    await request(http).post(`/api/v1/phases/${leadInId}/advance`).set(bearer(one.token)).expect(201);
    const middleId = enrolled.body.phases.find((p: any) => p.key === MIDDLE_PHASE).id as string;
    await request(http).put(`/api/v1/phases/${middleId}/workspace`).set(bearer(one.token)).send({ files: MIDDLE_WORK }).expect(200);
    expect((await submitTask(one.token, middleId, SIGNED)).passed).toBe(true);
    return { ...one, middleId };
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);

    teacher = await account('rahim', 'INSTRUCTOR');
    other = await account('sam', 'INSTRUCTOR');
    const made = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).send({ name: 'Monday lab' }).expect(201);
    cohortId = made.body.id;
    joinCode = made.body.joinCode;
    const theirs = await request(http).post('/api/v1/instructor/cohorts').set(bearer(other.token)).send({ name: 'Friday lab' }).expect(201);
    otherCohortId = theirs.body.id;
    otherJoinCode = theirs.body.joinCode;

    // The teacher's copy of the host, untouched: the design task is the one marked.
    const hostVersionId = await importHostPackThreePhase(
      { content: app.get(ContentService), dataSource: db, registry: app.get(ProjectRegistryService) },
      { slug: `release-signoff-${stamp}` },
    );
    ownSlug = `interviews-${stamp}`;
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacher.token))
      .send({ title: 'Interviews', slug: ownSlug, fromVersionId: hostVersionId })
      .expect(201);
    const projectId = created.body.project.id as string;
    const draftId = created.body.draftVersionId as string;
    // Shelf's Implementation is executable: the copy publishes on a deep receipt
    await stampDeepReceipt(db, draftId);
    const published = (
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${draftId}/publish`)
        .set(bearer(teacher.token))
        .send({ version: '1.0.0', notes: 'A design to countersign.' })
        .expect(200)
    ).body as PublishVersionResult;

    // The version marks the design task `signOff`, as the importer writes a
    // pack that declares it; the registry is the runtime's one reader.
    const versions = db.getRepository(ProjectVersionEntity);
    const row = await versions.findOneByOrFail({ id: published.versionId });
    const compiled = JSON.parse(JSON.stringify(row.compiled));
    const middle = compiled.phases.find((one: any) => one.key === MIDDLE_PHASE);
    const signed = middle.tasks.find((one: any) => one.taskKey === SIGNED);
    signed.signOff = true;
    signedTitle = signed.title;
    await versions.update({ id: row.id }, { compiled });
    await app.get(ProjectRegistryService).load();

    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(teacher.token))
      .send({ projectVersionId: published.versionId, reason: 'This class has its designs countersigned this term.' })
      .expect(200);

    learners = [await learnerWorks('ann', joinCode), await learnerWorks('ben', joinCode)];
    // Ola did the same work in this class and has since moved to Sam's: her
    // board is as awaited as theirs, and no longer this teacher's to sign.
    outsider = await learnerWorks('ola', joinCode);
    await request(http).post('/api/v1/enrollments/join').set(bearer(outsider.token)).send({ code: otherJoinCode }).expect(200);
    expect((await db.getRepository(UserEntity).findOneByOrFail({ id: outsider.id })).cohort).toBe(otherCohortId);
  }, 240000);

  afterAll(async () => {
    await app?.close();
  });

  it('the countersigned task waits after its pass, and the door stays shut', async () => {
    for (const one of [...learners, outsider]) {
      const detail = await phase(one.token, one.middleId);
      const signed = (detail.tasks ?? []).find((task) => task.key === SIGNED);
      expect(signed?.status).not.toBe('passed');
      expect(detail.status).not.toBe('passed');
      const row = await db.getRepository(TaskStateEntity).findOneByOrFail({ phaseStateId: one.middleId, taskKey: SIGNED });
      // The grader's own words for it: handed in, not passed, awaited.
      expect([row.status, row.awaitingSignOff]).toEqual(['submitted', true]);
      await request(http).post(`/api/v1/phases/${one.middleId}/advance`).set(bearer(one.token)).expect(400);
    }
  });

  it('the queue lists the class’s learners awaiting the countersignature, and only the class’s', async () => {
    const view = (await request(http).get(path('signoff.queue', cohortId)).set(bearer(teacher.token)).expect(200)).body as SignoffQueueView;
    expect(view.cohortId).toBe(cohortId);
    expect(view.rows.map((row) => row.userId).sort()).toEqual(learners.map((one) => one.id).sort());
    for (const row of view.rows) {
      expect(row).toEqual({
        userId: expect.any(String),
        learnerName: expect.stringMatching(/^(ann|ben)$/),
        phaseKey: MIDDLE_PHASE,
        taskKey: SIGNED,
        taskTitle: signedTitle,
        awaitingSince: expect.any(String),
      });
    }
    // Another teacher's class is a 404, and so is a learner's call.
    await request(http).get(path('signoff.queue', otherCohortId)).set(bearer(teacher.token)).expect(404);
    await request(http).get(path('signoff.queue', cohortId)).set(bearer(learners[0].token)).expect(403);
  });

  it('refuses an empty reason and a foreign class, and writes nothing', async () => {
    const before = await db.getRepository(AuditEventEntity).count();
    const body = { phaseKey: MIDDLE_PHASE, taskKey: SIGNED, userIds: learners.map((one) => one.id) };
    for (const reason of ['', '   ']) {
      await request(http).post(path('signoff.bulk', cohortId)).set(bearer(teacher.token)).send({ ...body, reason }).expect(400);
    }
    await request(http).post(path('signoff.bulk', cohortId)).set(bearer(teacher.token)).send(body).expect(400);
    await request(http)
      .post(path('signoff.bulk', otherCohortId))
      .set(bearer(teacher.token))
      .send({ ...body, userIds: [outsider.id], reason: REASON })
      .expect(404);
    await request(http)
      .post(path('signoff.bulk', cohortId))
      .set(bearer(learners[0].token))
      .send({ ...body, reason: REASON })
      .expect(403);
    expect(await db.getRepository(AuditEventEntity).count()).toBe(before);
    const row = await db.getRepository(TaskStateEntity).findOneByOrFail({ phaseStateId: outsider.middleId, taskKey: SIGNED });
    expect([row.status, row.awaitingSignOff, row.signedOffBy]).toEqual(['submitted', true, null]);
  });

  it('signs the class off in one batch: one audited row per learner, each phase opened once, the door open', async () => {
    const result = (
      await request(http)
        .post(path('signoff.bulk', cohortId))
        .set(bearer(teacher.token))
        .send({
          phaseKey: MIDDLE_PHASE,
          taskKey: SIGNED,
          userIds: [...learners.map((one) => one.id), outsider.id],
          reason: REASON,
        })
        .expect(200)
    ).body as BulkSignoffResult;
    expect(result.signedOff.sort()).toEqual(learners.map((one) => one.id).sort());
    // The learner of another class is reported, by one sentence, and untouched.
    expect(result.refused).toEqual([{ userId: outsider.id, sentence: expect.any(String) }]);
    const untouched = await db.getRepository(TaskStateEntity).findOneByOrFail({ phaseStateId: outsider.middleId, taskKey: SIGNED });
    expect([untouched.status, untouched.awaitingSignOff]).toEqual(['submitted', true]);

    const audit = await db.getRepository(AuditEventEntity).find({ where: { event: 'class.bulk-signoff' as never } });
    expect(audit.map((row) => row.subjectUserId).sort()).toEqual(learners.map((one) => one.id).sort());
    for (const row of audit) {
      expect(row.reason).toBe(REASON);
      expect(row.actorUserId).toBe(teacher.id);
    }

    const opened: string[] = [];
    for (const one of learners) {
      const state = await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: one.middleId });
      expect(state.status).toBe('passed');
      opened.push(state.passedAt!);
      const advanced = await request(http).post(`/api/v1/phases/${one.middleId}/advance`).set(bearer(one.token)).expect(201);
      expect(advanced.body.currentPhaseOrder).toBe(3);
    }

    // A second batch opens nothing twice and leaves no row.
    const again = (
      await request(http)
        .post(path('signoff.bulk', cohortId))
        .set(bearer(teacher.token))
        .send({ phaseKey: MIDDLE_PHASE, taskKey: SIGNED, userIds: learners.map((one) => one.id), reason: REASON })
        .expect(200)
    ).body as BulkSignoffResult;
    expect(again.signedOff).toEqual([]);
    expect(again.refused).toHaveLength(2);
    for (const [i, one] of learners.entries()) {
      expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: one.middleId })).passedAt).toBe(opened[i]);
    }
    expect(await db.getRepository(AuditEventEntity).count({ where: { event: 'class.bulk-signoff' as never } })).toBe(2);

    // And the queue is empty; the teacher's trail carries the rows.
    const view = (await request(http).get(path('signoff.queue', cohortId)).set(bearer(teacher.token)).expect(200)).body as SignoffQueueView;
    expect(view.rows).toEqual([]);
    const trail = (await request(http).get('/api/v1/instructor/audit').set(bearer(teacher.token)).expect(200)).body as any[];
    expect(trail.filter((one) => one.event === 'class.bulk-signoff')).toHaveLength(2);
  }, 120000);
});
