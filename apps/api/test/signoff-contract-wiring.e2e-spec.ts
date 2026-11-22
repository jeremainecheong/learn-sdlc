import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ASSIGNMENT_REASON_MIN, INHERITED_TASK_KEY, SIGNOFF_ROUTES } from '@learnsdlc/shared';
import type { BulkSignoffResult, PublishVersionResult, SignoffQueueView } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { ContentService } from '../src/content/content.service';
import { ProjectVersionEntity } from '../src/content/project.entities';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import { UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { LEAD_IN_PHASE, LEAD_IN_WORK, MIDDLE_PHASE, MIDDLE_WORK, importHostPackThreePhase, stampDeepReceipt } from './written-phase-pack';
import { ExchangeLog, Redactor, holdExchangeContract } from './fixtures/contract-exchanges/recorder';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The sign-off queue and the bulk sign-off, recorded through the real
 * `AppModule` for `apps/web/test/signoff-queue-wiring.test.tsx`.
 *
 * The scenario is `bulk-signoff.e2e-spec.ts`'s: a teacher's copy whose
 * design phase's design task is countersigned, two learners of the class who
 * hand it in and wait. Recorded are the reads the class page
 * makes on the way to the queue (the classes, the overview, the class's
 * learners), the queue, a batch with too short a reason (refused, 400), the
 * batch the API accepts (one task, both learners, one reason), the same batch
 * again (each learner refused by a sentence), and the queue after (empty).
 *
 * The stub AI (`mockAiForRoutes`, `name: 'mock-ai'`) stands in for the
 * provider and the in-process runner for the sandbox; nothing leaves the
 * process. `CONTRACT_EXCHANGES_RECORD=1` (inline) rewrites
 * `fixtures/contract-exchanges/signoff.json`; without it the spec checks the shapes.
 */
describe('the sign-off queue and the bulk sign-off, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const redactor = new Redactor();
  const log = new ExchangeLog();
  const REASON = 'Heard both interviews in the Monday lab.';
  /** The task the version marks for a countersignature: the middle phase's design task. */
  const SIGNED = INHERITED_TASK_KEY;

  const route = (key: keyof typeof SIGNOFF_ROUTES, cohortId: string) =>
    `/api/v1${SIGNOFF_ROUTES[key].path.replace(':cohortId', cohortId)}`;

  /** Display names no product text holds, so replacing them cannot touch a word of copy. */
  const account = async (handle: string, displayName: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${handle}@rx-contract.test`, password: PASSWORD, displayName })
      .expect(201);
    const id = registered.body.user.id as string;
    redactor.name(displayName, `name:${handle}`);
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  /** One GET through the real route, kept as an exchange. */
  const get = async (name: string, url: string, token: string, status = 200) => {
    const res = await request(http).get(url).set(bearer(token)).expect(status);
    log.take(name, 'GET', url, undefined, res);
    return res.body;
  };
  const post = async (name: string, url: string, token: string, body: unknown, status: number) => {
    const res = await request(http).post(url).set(bearer(token)).send(body as object).expect(status);
    log.take(name, 'POST', url, body, res);
    return res.body;
  };

  const submitTask = async (token: string, phaseStateId: string, taskKey: string) => {
    const submitted = await request(http)
      .post(`/api/v1/phases/${phaseStateId}/tasks/${encodeURIComponent(taskKey)}/submit`)
      .set(bearer(token))
      .expect(201);
    return waitForSubmission(http, bearer(token), submitted.body.id, { attempts: 80, intervalMs: 200, message: `the ${taskKey} submission did not finish` });
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  it('confirms the stub AI before anything is driven (m8)', () => {
    expect(app.get(OpenAiProvider)).toBe(mockAiForRoutes);
    expect((app.get(OpenAiProvider) as unknown as { name: string }).name).toBe('mock-ai');
  });

  it('records the class page’s reads, the queue, a refused batch, the accepted batch, the batch again and the queue after', async () => {
    const teacher = await account('teacher', 'Zeb Quorrant', 'INSTRUCTOR');
    const made = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).send({ name: 'Monday lab' }).expect(201);
    const cohortId = made.body.id as string;
    redactor.name(made.body.joinCode, 'join-code');

    // The teacher's copy of the host's three-phase variant (Shelf's Requirements, Design and
    // Implementation), untouched: the middle phase's design task is the one marked.
    const hostVersionId = await importHostPackThreePhase(
      { content: app.get(ContentService), dataSource: db, registry: app.get(ProjectRegistryService) },
      { slug: 'release-signoff' },
    );
    const slug = 'interviews-copy';
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacher.token))
      .send({ title: 'Interviews', slug, fromVersionId: hostVersionId })
      .expect(201);
    const at = `/api/v1/instructor/projects/${created.body.project.id}/versions/${created.body.draftVersionId}`;
    // Shelf's Implementation is executable: the copy publishes on a deep receipt
    await stampDeepReceipt(db, created.body.draftVersionId);
    const published = (
      await request(http).post(`${at}/publish`).set(bearer(teacher.token)).send({ version: '1.0.0', notes: 'An interview to countersign.' }).expect(200)
    ).body as PublishVersionResult;
    // The version marks the design task `signOff`, as the importer writes a pack
    // that declares it; the registry is the runtime's reader.
    const versions = db.getRepository(ProjectVersionEntity);
    const row = await versions.findOneByOrFail({ id: published.versionId });
    const compiled = JSON.parse(JSON.stringify(row.compiled));
    const marked = compiled.phases.find((one: any) => one.key === MIDDLE_PHASE).tasks.find((one: any) => one.taskKey === SIGNED);
    marked.signOff = true;
    await versions.update({ id: row.id }, { compiled });
    await app.get(ProjectRegistryService).load();
    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(teacher.token))
      .send({ projectVersionId: published.versionId, reason: 'This class interviews a customer this term.' })
      .expect(200);

    const learners: string[] = [];
    for (const [handle, name] of [
      ['ann', 'Ixa Pellowmere'],
      ['ben', 'Quon Adrevelle'],
    ]) {
      const one = await account(handle, name);
      await request(http).post('/api/v1/enrollments/join').set(bearer(one.token)).send({ code: made.body.joinCode }).expect(200);
      const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(one.token)).send({ projectSlug: slug }).expect(201);
      // Requirements first (its story is its sole task), so Design opens
      const leadInId = enrolled.body.phases.find((p: any) => p.key === LEAD_IN_PHASE).id as string;
      await request(http).put(`/api/v1/phases/${leadInId}/workspace`).set(bearer(one.token)).send({ files: LEAD_IN_WORK }).expect(200);
      expect((await submitTask(one.token, leadInId, INHERITED_TASK_KEY)).passed).toBe(true);
      await request(http).post(`/api/v1/phases/${leadInId}/advance`).set(bearer(one.token)).expect(201);
      const middleId = enrolled.body.phases.find((p: any) => p.key === MIDDLE_PHASE).id as string;
      await request(http).put(`/api/v1/phases/${middleId}/workspace`).set(bearer(one.token)).send({ files: MIDDLE_WORK }).expect(200);
      expect((await submitTask(one.token, middleId, SIGNED)).passed).toBe(true);
      learners.push(one.id);
    }

    // The class page's own reads, in the order it makes them.
    await get('cohorts', '/api/v1/instructor/cohorts', teacher.token);
    await get('overview', '/api/v1/instructor/overview', teacher.token);
    const classLearners = await get('classLearners', `/api/v1/instructor/learners?cohort=${cohortId}&limit=50`, teacher.token);
    // The class page's panels beside the queue read these; recorded so the
    // replay answers every request the page makes, not only the queue's.
    await get('stuck', `/api/v1/instructor/stuck?cohortId=${cohortId}`, teacher.token);
    await get('classProject', `/api/v1/instructor/cohorts/${cohortId}/project`, teacher.token);
    await get('assignable', `/api/v1/instructor/cohorts/${cohortId}/project/assignable`, teacher.token);
    await get('notes', `/api/v1/instructor/notes?cohortId=${cohortId}`, teacher.token);
    await get('schedule', `/api/v1/instructor/cohorts/${cohortId}/schedule?project=${slug}`, teacher.token);
    const submissionIds = new Set<string>();
    const walk = (value: unknown, key = '') => {
      if (Array.isArray(value)) value.forEach((one) => walk(one));
      else if (value && typeof value === 'object') {
        if (key === 'lastSubmission' && typeof (value as { id?: unknown }).id === 'string') submissionIds.add((value as { id: string }).id);
        for (const [k, one] of Object.entries(value)) walk(one, k);
      }
    };
    walk(classLearners);
    expect(submissionIds.size).toBeGreaterThan(0);
    for (const [n, id] of [...submissionIds].entries()) {
      await get(`teacherFeedback${n + 1}`, `/api/v1/submissions/${id}/teacher-feedback`, teacher.token);
    }

    const before = (await get('queue', route('signoff.queue', cohortId), teacher.token)) as SignoffQueueView;
    expect(before.cohortId).toBe(cohortId);
    expect(before.rows.map((one) => one.userId).sort()).toEqual([...learners].sort());
    for (const one of before.rows) expect([one.phaseKey, one.taskKey, one.taskTitle]).toEqual([MIDDLE_PHASE, SIGNED, marked.title]);

    const batch = { phaseKey: MIDDLE_PHASE, taskKey: SIGNED, userIds: [...learners].sort() };
    const short = 'x'.repeat(ASSIGNMENT_REASON_MIN - 1);
    await post('bulkShortReason', route('signoff.bulk', cohortId), teacher.token, { ...batch, reason: short }, 400);
    const signed = (await post('bulk', route('signoff.bulk', cohortId), teacher.token, { ...batch, reason: REASON }, 200)) as BulkSignoffResult;
    expect([...signed.signedOff].sort()).toEqual([...learners].sort());
    expect(signed.refused).toEqual([]);
    const again = (await post('bulkAgain', route('signoff.bulk', cohortId), teacher.token, { ...batch, reason: REASON }, 200)) as BulkSignoffResult;
    expect(again.signedOff).toEqual([]);
    expect(again.refused.map((one) => one.userId).sort()).toEqual([...learners].sort());
    for (const one of again.refused) expect(one.sentence.length).toBeGreaterThan(10);
    const after = (await get('queueAfter', route('signoff.queue', cohortId), teacher.token)) as SignoffQueueView;
    expect(after.rows).toEqual([]);

    holdExchangeContract(
      'signoff',
      'apps/api/test/signoff-contract-wiring.e2e-spec.ts',
      log,
      { cohortId, reasonMin: ASSIGNMENT_REASON_MIN, reason: REASON },
      redactor,
    );
  }, 240000);
});
