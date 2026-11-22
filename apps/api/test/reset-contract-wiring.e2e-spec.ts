import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { API_CONTRACT_JSON, DESIGN_JSON, EMPTY_DESIGN, INHERITED_TASK_KEY, serialiseDesign } from '@learnsdlc/shared';
import type { EnrollmentView, PhaseDetail, PublishVersionResult, TaskResetPlanView } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { ContentService } from '../src/content/content.service';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import { SubmissionEntity, UserEntity } from '../src/db/entities';
import { RESET_REFUSALS } from '../src/workflow/learner-reset';
import { EARLIER_RUN_NOTE } from '../src/instructor/regrade.service';
import { mockAiForRoutes } from './mock-ai';
import {
  HOST_QUIZ_KEYS,
  LEAD_IN_PHASE,
  LEAD_IN_WORK,
  MIDDLE_PHASE,
  MIDDLE_WORK,
  hostQuizBody,
  importHostPackThreePhase,
  stampDeepReceipt,
} from './written-phase-pack';
import { Redactor, elideFiles, elideWorkspace, holdContract } from './fixtures/contract-bodies/recorder';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The recorded reset contract, through the real `AppModule`.
 *
 * The seam spec `learner-reset.e2e-spec.ts` proves the rule; this file
 * drives the same routes and holds what they answer in
 * `fixtures/contract-bodies/reset.json`, which
 * `apps/web/test/reset-wiring.test.tsx` renders the real room and the real
 * reset control from:
 *
 * - the learner's phase before, the plan (`GET …/reset`), the reset's answer
 *   (`POST …/reset`, 201) and the phase after;
 * - a reset quoting a stale `baseVersion`: the 409 and its body, which is the
 *   stale save's (`workspace_changed`, the newer version and files); the room
 *   answers it with "Nothing was reset…" and a reload, not with the editor's
 *   "Keep mine" banner;
 * - a sole-task (TaskTrackr) phase: its detail (the web draws no control on
 *   it), the plan's refusal and the POST's 400;
 * - a regrade of the pre-reset revision, as the teacher's audit trail for
 *   that learner answers it (`GET /instructor/audit?learnerId=`), whose row
 *   carries `detail.run` = "of an earlier run, moved no gate", and the batch
 *   view, which carries no such field (the note lives on the trail only).
 */
describe('the learner reset, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const REASON = 'The criteria need another look before this phase can count.';
  const redactor = new Redactor();

  /** A: the middle (Design) phase's design task, the one reset; a concept quiz sits beside it, so the list is not a sole task. */
  const A = INHERITED_TASK_KEY;
  /** What A owns: the design record and the API contract, both restored by its reset. */
  const A_PATHS = [DESIGN_JSON, API_CONTRACT_JSON];
  /** An empty design: a failing A. */
  const A_FAIL = serialiseDesign(EMPTY_DESIGN);

  let teacherToken = '';
  let joinCode = '';
  let ownSlug = '';
  let defaultSlug = '';

  /** Display names no product text holds, so replacing them cannot touch a word of copy. */
  const account = async (handle: string, displayName: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${handle}@contract-bodies.test`, password: PASSWORD, displayName })
      .expect(201);
    const id = registered.body.user.id as string;
    redactor.name(displayName, `name:${handle}`);
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const phase = async (token: string, id: string): Promise<PhaseDetail> =>
    (await request(http).get(`/api/v1/phases/${id}`).set(bearer(token)).expect(200)).body as PhaseDetail;

  const submitTask = async (token: string, id: string, taskKey: string): Promise<any> => {
    const submitted = await request(http)
      .post(`/api/v1/phases/${id}/tasks/${encodeURIComponent(taskKey)}/submit`)
      .set(bearer(token))
      .expect(201);
    return waitForSubmission(http, bearer(token), submitted.body.id, { attempts: 100, intervalMs: 200, message: `the ${taskKey} submission did not finish` });
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);

    teacherToken = (await account('teacher', 'Zeb Quorrant', 'INSTRUCTOR')).token;
    const made = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacherToken)).send({ name: 'Friday' }).expect(201);
    joinCode = made.body.joinCode;
    redactor.name(joinCode, 'join-code');

    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacherToken)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    defaultSlug = platform.slug;
    // The teacher's copy of the host's three-phase variant (Shelf's Requirements, Design and
    // Implementation): the design task at order 2, split by an optional concept quiz beside it.
    const hostVersionId = await importHostPackThreePhase(
      { content: app.get(ContentService), dataSource: db, registry: app.get(ProjectRegistryService) },
      { slug: 'release-reset' },
    );
    ownSlug = 'reset-copy';
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .send({ title: 'Reset Copy', slug: ownSlug, fromVersionId: hostVersionId })
      .expect(201);
    const at = `/api/v1/instructor/projects/${created.body.project.id}/versions/${created.body.draftVersionId}`;
    await request(http)
      .post(`${at}/phases/${MIDDLE_PHASE}/tasks`)
      .set(bearer(teacherToken))
      .send({ ...hostQuizBody(HOST_QUIZ_KEYS[0]), required: false })
      .expect(201);
    // Shelf's Implementation is executable: the copy publishes on a deep receipt
    await stampDeepReceipt(db, created.body.draftVersionId);
    const published = (
      await request(http).post(`${at}/publish`).set(bearer(teacherToken)).send({ version: '1.0.0', notes: 'Design in two.' }).expect(200)
    ).body as PublishVersionResult;
    await request(http)
      .put(`/api/v1/instructor/cohorts/${made.body.id}/project`)
      .set(bearer(teacherToken))
      .send({ projectVersionId: published.versionId, reason: 'Friday writes the overdue report this term.' })
      .expect(200);
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  it('records plan, reset, stale 409, sole-task refusal and the trail row of the reset', async () => {
    const who = await account('learner', 'Ixa Pellowmere');
    await request(http).post('/api/v1/enrollments/join').set(bearer(who.token)).send({ code: joinCode }).expect(200);
    const board = (await request(http).post('/api/v1/enrollments').set(bearer(who.token)).send({ projectSlug: ownSlug }).expect(201))
      .body as EnrollmentView;
    // The lead-in first (its task is its sole task), so the middle phase, which holds the split, opens
    const leadInId = board.phases.find((one) => one.key === LEAD_IN_PHASE)!.id;
    await request(http).put(`/api/v1/phases/${leadInId}/workspace`).set(bearer(who.token)).send({ files: LEAD_IN_WORK }).expect(200);
    expect((await submitTask(who.token, leadInId, 'main')).passed).toBe(true);
    await request(http).post(`/api/v1/phases/${leadInId}/advance`).set(bearer(who.token)).expect(201);
    const id = board.phases.find((one) => one.key === MIDDLE_PHASE)!.id;

    await request(http).put(`/api/v1/phases/${id}/workspace`).set(bearer(who.token)).send({ files: { ...MIDDLE_WORK, [DESIGN_JSON]: A_FAIL } }).expect(200);
    const failed = await submitTask(who.token, id, A);
    expect(failed.passed).toBe(false);
    const before = await phase(who.token, id);

    const planned = (await request(http).get(`/api/v1/phases/${id}/tasks/${A}/reset`).set(bearer(who.token)).expect(200))
      .body as TaskResetPlanView;
    expect(planned).toMatchObject({ restores: A_PATHS, reseeds: [], protectedBy: [], refusal: null });
    expect(typeof planned.dropsPendingProposal).toBe('boolean');

    // A stale version first: nothing is written, and the body is the stale save's.
    const staleBase = '2000-01-01T00:00:00.000Z';
    const stale = await request(http).post(`/api/v1/phases/${id}/tasks/${A}/reset`).set(bearer(who.token)).send({ baseVersion: staleBase });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('workspace_changed');
    expect(stale.body.version).toBe(before.workspaceUpdatedAt);
    expect((await phase(who.token, id)).workspaceUpdatedAt).toBe(before.workspaceUpdatedAt);

    const done = await request(http)
      .post(`/api/v1/phases/${id}/tasks/${A}/reset`)
      .set(bearer(who.token))
      .send({ baseVersion: before.workspaceUpdatedAt ?? null })
      .expect(201);
    for (const path of A_PATHS) expect(done.body.workspace[path]).toBeUndefined();
    expect(done.body.version).not.toBe(before.workspaceUpdatedAt);
    expect(done.body.task.key).toBe(A);
    const after = await phase(who.token, id);
    expect(after.workspaceUpdatedAt).toBe(done.body.version);

    // The pre-reset revision, regraded, moves no gate and says so on the trail.
    const history = await db.getRepository(SubmissionEntity).find({ where: { phaseStateId: id, taskKey: A } });
    await db.getRepository(SubmissionEntity).update({ id: history[0].id }, { packVersion: '0.0.1' });
    const batch = await request(http)
      .post('/api/v1/instructor/regrades')
      .set(bearer(teacherToken))
      .send({ projectSlug: ownSlug, phaseKey: MIDDLE_PHASE, scope: 'everyone', userId: who.id, reason: REASON })
      .expect(201);
    let batchView: any = batch.body;
    for (let i = 0; i < 100; i++) {
      batchView = (await request(http).get(`/api/v1/instructor/regrades/${batch.body.id}`).set(bearer(teacherToken)).expect(200)).body;
      if (batchView.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const trail = (await request(http).get('/api/v1/instructor/audit').query({ learnerId: who.id, limit: 50 }).set(bearer(teacherToken)).expect(200))
      .body as Array<{ event: string; detail?: Record<string, unknown> }>;
    const earlier = trail.filter((row) => row.event === 'phase.regrade' && row.detail?.run === EARLIER_RUN_NOTE);
    expect(earlier.length).toBeGreaterThan(0);
    // The batch view names no run: the regrade note is on the trail only.
    // Deliberately not pinned as a negative, so a batch-view field that adds
    // the note later is not a red here.

    // The sole-task list refuses, by its sentence.
    const plain = await account('plain', 'Oru Vantelli');
    const plainBoard = (await request(http).post('/api/v1/enrollments').set(bearer(plain.token)).send({ projectSlug: defaultSlug }).expect(201))
      .body as EnrollmentView;
    const plainId = plainBoard.phases.find((one) => one.key === 'requirements')!.id;
    const solePlan = (await request(http).get(`/api/v1/phases/${plainId}/tasks/${INHERITED_TASK_KEY}/reset`).set(bearer(plain.token)).expect(200)).body;
    expect(solePlan.refusal).toBe(RESET_REFUSALS.soleTask);
    const plainDetail = await phase(plain.token, plainId);
    const soleRefused = await request(http)
      .post(`/api/v1/phases/${plainId}/tasks/${INHERITED_TASK_KEY}/reset`)
      .set(bearer(plain.token))
      .send({ baseVersion: plainDetail.workspaceUpdatedAt ?? null });
    expect(soleRefused.status).toBe(400);
    expect(String(soleRefused.body.message)).toBe(RESET_REFUSALS.soleTask);

    holdContract(
      'reset',
      'apps/api/test/reset-contract-wiring.e2e-spec.ts',
      {
        enrollment: board,
        phaseBefore: elideFiles(before),
        plan: planned,
        staleReset: { status: stale.status, body: { ...stale.body, files: elideWorkspace(stale.body.files) } },
        reset: { status: 201, body: done.body },
        phaseAfter: elideFiles(after),
        regradeBatch: batchView,
        auditTrail: trail,
        plainPhase: elideFiles(plainDetail),
        solePlan,
        soleRefused: { status: soleRefused.status, body: soleRefused.body },
      },
      redactor,
    );
  }, 240000);
});
