import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import { EMPTY_STORY, INHERITED_TASK_KEY, SIGNOFF_ROUTES, serialiseStory } from '@learnsdlc/shared';
import type { BulkSignoffResult, RunResult, SignoffQueueView } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { DeepValidationService, hasCurrentDeepReceipt } from '../src/authoring/deep-validation';
import { UPLOAD_PATH } from '../src/authoring/upload.service';
import type { CompiledSnapshot } from '../src/content/pack-compiler';
import type { CodeChecks, ConfigChecks, TestsChecks } from '../src/content/content.types';
import { ProjectVersionEntity } from '../src/content/project.entities';
import { readZip, zipLimits } from '../src/content/zip-reader';
import { config } from '../src/config';
import { AuditEventEntity, PhaseStateEntity, TaskStateEntity, UserEntity } from '../src/db/entities';
import { SandboxService } from '../src/execution/sandbox.service';
import type { SandboxJob } from '../src/execution/sandbox.service';
import { mockAiForRoutes } from './mock-ai';
import { zipDirectory } from './fixtures/upload-packs/archive';
import { SHELF_DIR } from './fixtures/upload-packs/markers';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The sign-off mark's whole road, in jest, over the real `AppModule` and its
 * real routes: editor → export → re-upload → publish → pass → the queue lists
 * the learner → one bulk sign-off.
 *
 * 1. A teacher uploads the Shelf pack (`upload-packs/shelf`).
 * 2. The teacher marks Requirements' sole task for sign-off through the task
 *    door (`PATCH …/phases/requirements/tasks/main {signOff:true}`).
 * 3. The version is exported and the archive uploaded again: the new draft's
 *    Requirements task holds the mark (phase.json's `task` block).
 * 4. Fast validation, then deep validation of the new draft, exactly as
 *    `teacher-upload-journey.e2e-spec.ts` runs it: only the sandbox transport
 *    is stubbed (this host's runner refuses learner code without kernel
 *    isolation, and no runner env is set to change that), so every job still
 *    goes through the RunGate; a job is judged by its bytes (the journey's
 *    judge, copied: it is not exported).
 * 5. The draft publishes and a class is put on it.
 * 6. A learner passes Requirements through the routes' AI mock (the stub
 *    review only; OPENAI_API_KEY unset, the provider overridden: no real
 *    call), and the pass waits for the countersignature.
 * 7. The class sign-off queue lists the learner on that task.
 * 8. One bulk sign-off with one reason: one audit row, and the phase opens
 *    exactly once (a second batch signs nobody and moves nothing).
 */
/** SH-5 as a story record that meets the shelf's floor: the sentence, three tagged criteria and one exclusion. */
const SH5_RECORD = serialiseStory({
  ...EMPTY_STORY,
  id: 'SH-5',
  title: 'See an author’s free books',
  persona: 'library member',
  capability: 'to see which of an author’s books are free to borrow right now',
  benefit: 'I only walk to the shelf for a book that is there',
  criteria: [
    { id: 'AC-1', given: 'an author with three books on the shelf', when: 'a member filters by that author', then: 'the member sees all three books marked free', tag: 'happy' },
    { id: 'AC-2', given: 'one of those books is on loan to another member', when: 'the member filters by that author', then: 'that book is shown as lent and the other two as free', tag: 'boundary' },
    { id: 'AC-3', given: 'an author with no books at all', when: 'a member filters by that author', then: 'the member sees an empty list and no error', tag: 'error' },
  ],
  scopeExclusions: ['Holding a book for a member while it is on loan'],
});

describe('the sign-off mark, editor → export → re-upload → publish → pass → queue → bulk sign-off', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  let address = 0;
  /** Each request from its own address, so per-address gates measure the route, not this file. */
  const from = () => ({ 'x-forwarded-for': `10.93.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });

  const binary = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };

  /* ------------------ the stub sandbox (the journey's judge, copied) ------------------ */

  let judged: CompiledSnapshot | null = null;
  const ok = (n = 4): RunResult => ({ ok: true, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1, tests: { total: n, passed: n, failed: 0, errored: 0, cases: [] } });
  const bad = (n = 4): RunResult => ({
    ok: false, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1,
    tests: { total: n, passed: n - 1, failed: 1, errored: 0, cases: [{ name: 'test_shelf_order', status: 'failed', message: 'AssertionError', frames: [] }] },
  });
  const same = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys(a).sort().join('\n') === Object.keys(b).sort().join('\n') && Object.keys(a).every((k) => a[k] === b[k]);
  const judge = (job: SandboxJob): RunResult => {
    const phases = judged?.content.phases ?? [];
    if (job.mode === 'smoke') {
      const drill = phases.map((p) => (p.checks.kind === 'config' ? (p.checks as ConfigChecks).drill : undefined)).find(Boolean);
      const faulted = drill && Object.entries(drill.faultedFiles).some(([at, bytes]) => job.files[at] === bytes);
      return { ok: !faulted, exitKind: faulted ? 'error' : 'ok', stdout: '', stderr: '', durationMs: 1 };
    }
    if (job.gradedFiles) {
      const tests = phases.find((p) => p.checks.kind === 'tests')?.checks as TestsChecks | undefined;
      return tests?.runs.some((run) => same(job.gradedFiles!, run.implFiles)) ? ok() : bad();
    }
    const code = phases.filter((p) => p.checks.kind === 'code').map((p) => p.checks as CodeChecks);
    const targets = [...new Set(code.flatMap((checks) => checks.editableTargets ?? []))];
    const good = new Set<string>(code.flatMap((checks) => Object.values(checks.solutionFiles)));
    const held = targets.filter((at) => job.files[at] !== undefined);
    return held.length > 0 && held.every((at) => good.has(job.files[at])) ? ok() : bad();
  };
  /** Every AI surface the routes' mock answered: the stub only (OPENAI_API_KEY unset; the provider overridden). */
  const aiCalls: string[] = [];
  const counting = {
    ...mockAiForRoutes,
    review: jest.fn(async (...args: any[]) => {
      aiCalls.push('review');
      return (mockAiForRoutes.review as any)(...args);
    }),
  };

  /* ------------------------------ the people ------------------------------ */

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `${name}-${stamp}@signoff-round-trip.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  let teacher = { id: '', token: '' };
  let learner = { id: '', token: '' };
  let first = { projectId: '', versionId: '' };
  let again = { projectId: '', versionId: '', slug: '' };
  let publishedVersionId = '';
  let cohortId = '';
  let learnerPhases: Record<string, string> = {};

  const versionBase = (projectId: string, versionId: string) => `/api/v1/instructor/projects/${projectId}/versions/${versionId}`;
  const snapshotOf = async (id: string): Promise<CompiledSnapshot> =>
    (await db.manager.findOneByOrFail(ProjectVersionEntity, { id })).compiled as CompiledSnapshot;
  const requirementsTask = (snapshot: CompiledSnapshot) => snapshot.phases.find((one) => one.key === 'requirements')!.tasks[0];

  beforeAll(async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    jest.spyOn(SandboxService.prototype as any, 'runPython').mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).endsWith('analyzer.py')) {
        return JSON.stringify({ issues: [], metrics: { files: 1, functions: 1, todosRemaining: 0, maxComplexity: 1, docstringCoverage: 1 } });
      }
      return JSON.stringify(judge(args[1] as unknown as SandboxJob));
    });
    // Test-only: read the client address from X-Forwarded-For (see `from`).
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, counting]], trustProxy: true }));
    db = app.get(DataSource);
    teacher = await account('signoff-teacher', 'INSTRUCTOR');
    learner = await account('signoff-learner');
  }, 120000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  it('1–2. the teacher uploads the Shelf pack and marks Requirements’ sole task for sign-off through the task door', async () => {
    const uploaded = await request(http).post(UPLOAD_PATH).set(bearer(teacher.token)).set(from())
      .send({ title: `Signed shelf ${stamp}`, archiveBase64: zipDirectory(SHELF_DIR).toString('base64') });
    expect({ status: uploaded.status, message: uploaded.status === 201 ? null : uploaded.body?.message }).toEqual({ status: 201, message: null });
    first = { projectId: uploaded.body.projectId, versionId: uploaded.body.versionId };
    expect(requirementsTask(await snapshotOf(first.versionId)).signOff).toBe(false);

    const marked = await request(http)
      .patch(`${versionBase(first.projectId, first.versionId)}/phases/requirements/tasks/${INHERITED_TASK_KEY}`)
      .set(bearer(teacher.token)).set(from())
      .send({ signOff: true });
    expect({ status: marked.status, message: marked.status === 200 ? null : marked.body?.message }).toEqual({ status: 200, message: null });
    expect(marked.body.phase.tasks.map((one: { taskKey: string; signOff?: boolean }) => [one.taskKey, one.signOff])).toEqual([[INHERITED_TASK_KEY, true]]);
    expect(requirementsTask(await snapshotOf(first.versionId)).signOff).toBe(true);
  }, 120000);

  it('3. the version exports with the mark in phase.json’s task block, and the archive uploads again holding it', async () => {
    const out = await request(http).get(`${versionBase(first.projectId, first.versionId)}/export`).set(bearer(teacher.token)).set(from()).buffer(true).parse(binary as never);
    expect({ status: out.status, message: out.status === 200 ? null : JSON.parse((out.body as Buffer).toString('utf-8')).message }).toEqual({ status: 200, message: null });
    const archive = out.body as Buffer;
    const phaseJson = readZip(archive, zipLimits(config.importMaxBytes)).find((one) => one.name.endsWith('/phases/01-requirements/phase.json'))!;
    expect(JSON.parse(phaseJson.bytes.toString('utf-8')).task).toEqual({ signOff: true });

    const uploaded = await request(http).post(UPLOAD_PATH).set(bearer(teacher.token)).set(from())
      .send({ title: `Signed shelf again ${stamp}`, archiveBase64: archive.toString('base64') });
    expect({ status: uploaded.status, message: uploaded.status === 201 ? null : uploaded.body?.message }).toEqual({ status: 201, message: null });
    again = { projectId: uploaded.body.projectId, versionId: uploaded.body.versionId, slug: uploaded.body.slug };
    expect(requirementsTask(await snapshotOf(again.versionId))).toMatchObject({ taskKey: INHERITED_TASK_KEY, signOff: true });
    const draft = await request(http).get(versionBase(again.projectId, again.versionId)).set(bearer(teacher.token)).set(from()).expect(200);
    // an unmarked task carries no mark (absent reads false)
    expect((draft.body.phases as { key: string; tasks: { signOff?: boolean }[] }[]).map((one) => [one.key, one.tasks[0].signOff === true])).toEqual([
      ['requirements', true], ['design', false], ['implementation', false], ['testing', false], ['deployment', false], ['maintenance', false],
    ]);
  }, 120000);

  it('4. fast validation is clean, then deep validation passes on the stub transport and its receipt is stored', async () => {
    const base = versionBase(again.projectId, again.versionId);
    const fast = await request(http).post(`${base}/validate`).set(bearer(teacher.token)).set(from()).expect(200);
    expect(fast.body.blocking).toEqual([]);
    judged = await snapshotOf(again.versionId);
    const cost = await request(http).get(`${base}/deep-validation`).set(bearer(teacher.token)).set(from()).expect(200);
    expect(cost.body.costWarning.microVMs).toBeGreaterThan(0);
    await request(http).post(`${base}/deep-validation`).set(bearer(teacher.token)).set(from()).send({ acknowledgedMicroVMs: cost.body.costWarning.microVMs }).expect(202);
    await app.get(DeepValidationService).idle();
    const view = await request(http).get(`${base}/deep-validation`).set(bearer(teacher.token)).set(from()).expect(200);
    expect({ status: view.body.status, current: view.body.current, failed: (view.body.checks as { status: string }[]).filter((one) => one.status === 'failed') })
      .toEqual({ status: 'passed', current: true, failed: [] });
    expect(hasCurrentDeepReceipt(await db.manager.findOneByOrFail(ProjectVersionEntity, { id: again.versionId }))).toBe(true);
  }, 180000);

  it('5. the draft publishes, still marked, and a class is put on it', async () => {
    const published = await request(http).post(`${versionBase(again.projectId, again.versionId)}/publish`).set(bearer(teacher.token)).set(from()).send({ version: '1.0.0' });
    expect({ status: published.status, message: published.status === 200 ? null : published.body?.message }).toEqual({ status: 200, message: null });
    publishedVersionId = published.body.versionId;
    expect(requirementsTask(await snapshotOf(publishedVersionId))).toMatchObject({ taskKey: INHERITED_TASK_KEY, signOff: true });

    const made = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).set(from()).send({ name: 'Signed shelf class' }).expect(201);
    cohortId = made.body.id;
    await request(http).put(`/api/v1/instructor/cohorts/${cohortId}/project`).set(bearer(teacher.token)).set(from())
      .send({ projectVersionId: publishedVersionId, reason: 'This class runs the signed shelf this term.' }).expect(200);
    await request(http).post('/api/v1/enrollments/join').set(bearer(learner.token)).set(from()).send({ code: made.body.joinCode }).expect(200);
    const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(learner.token)).set(from()).send({ projectSlug: again.slug }).expect(201);
    learnerPhases = Object.fromEntries((enrolled.body.phases as { key: string; id: string }[]).map((one) => [one.key, one.id]));
    expect(Object.keys(learnerPhases).sort()).toEqual(['deployment', 'design', 'implementation', 'maintenance', 'requirements', 'testing']);
  }, 120000);

  it('6. the learner passes Requirements through the stub review, and the pass waits for the countersignature', async () => {
    await request(http).put(`/api/v1/phases/${learnerPhases.requirements}/workspace`).set(bearer(learner.token)).set(from())
      .send({ files: { 'requirements/story.json': SH5_RECORD } }).expect(200);
    const submitted = await request(http).post(`/api/v1/phases/${learnerPhases.requirements}/submit`).set(bearer(learner.token)).set(from());
    expect({ status: submitted.status, message: submitted.status < 300 ? null : submitted.body?.message }).toEqual({ status: 201, message: null });
    const verdict = await waitForSubmission(http, () => ({ ...bearer(learner.token), ...from() }), submitted.body.id, { attempts: 300, intervalMs: 100 });
    expect({ passed: verdict?.passed, status: verdict?.status }).toEqual({ passed: true, status: 'completed' });
    expect(aiCalls).toEqual(['review']);
    // the countersignature is what the door waits for
    const state = await db.manager.findOneByOrFail(PhaseStateEntity, { id: learnerPhases.requirements });
    expect(state.status).not.toBe('passed');
    const row = await db.manager.findOneByOrFail(TaskStateEntity, { phaseStateId: learnerPhases.requirements, taskKey: INHERITED_TASK_KEY });
    expect({ awaitingSignOff: row.awaitingSignOff, status: row.status }).toEqual({ awaitingSignOff: true, status: 'submitted' });
  }, 180000);

  it('7–8. the class queue lists the learner on that task; one bulk sign-off writes one audit row and opens the phase exactly once', async () => {
    const route = (key: keyof typeof SIGNOFF_ROUTES) => `/api/v1${SIGNOFF_ROUTES[key].path.replace(':cohortId', cohortId)}`;
    const queue = (await request(http).get(route('signoff.queue')).set(bearer(teacher.token)).set(from()).expect(200)).body as SignoffQueueView;
    expect(queue.rows.map((one) => [one.userId, one.phaseKey, one.taskKey])).toEqual([[learner.id, 'requirements', INHERITED_TASK_KEY]]);
    const batch = { phaseKey: 'requirements', taskKey: INHERITED_TASK_KEY, userIds: [learner.id] };
    const audited = async () =>
      (await db.manager.find(AuditEventEntity, { where: { subjectUserId: In([learner.id]) } })).filter((one) => one.event === 'class.bulk-signoff');
    const reason = 'Heard the story read aloud in the Tuesday lab.';
    const signed = await request(http).post(route('signoff.bulk')).set(bearer(teacher.token)).set(from()).send({ ...batch, reason });
    expect({ status: signed.status, message: signed.status < 300 ? null : signed.body?.message }).toEqual({ status: 200, message: null });
    expect(signed.body as BulkSignoffResult).toEqual({ signedOff: [learner.id], refused: [] });
    const rows = await audited();
    expect(rows.map((one) => [one.subjectUserId, one.reason, (one.detail as { taskKey?: string }).taskKey])).toEqual([[learner.id, reason, INHERITED_TASK_KEY]]);
    const state = await db.manager.findOneByOrFail(PhaseStateEntity, { id: learnerPhases.requirements });
    expect(state.status).toBe('passed');
    // the queue is empty now, and the same batch again signs nobody and moves nothing
    expect(((await request(http).get(route('signoff.queue')).set(bearer(teacher.token)).set(from()).expect(200)).body as SignoffQueueView).rows).toEqual([]);
    const twice = await request(http).post(route('signoff.bulk')).set(bearer(teacher.token)).set(from()).send({ ...batch, reason }).expect(200);
    expect((twice.body as BulkSignoffResult).signedOff).toEqual([]);
    expect(await audited()).toHaveLength(1);
    expect((await db.manager.findOneByOrFail(PhaseStateEntity, { id: learnerPhases.requirements })).passedAt).toBe(state.passedAt);
    // the door opens once: Design unlocks on the first Continue, and a second changes nothing
    await request(http).post(`/api/v1/phases/${learnerPhases.requirements}/advance`).set(bearer(learner.token)).set(from()).expect(201);
    const design = await db.manager.findOneByOrFail(PhaseStateEntity, { id: learnerPhases.design });
    expect(design.status).toBe('in_progress');
    await request(http).post(`/api/v1/phases/${learnerPhases.requirements}/advance`).set(bearer(learner.token)).set(from()).expect(201);
    expect((await db.manager.findOneByOrFail(PhaseStateEntity, { id: learnerPhases.design })).unlockedAt).toBe(design.unlockedAt);
    // no real AI call was made: every review was the stub's
    expect(aiCalls.every((one) => one === 'review')).toBe(true);
  }, 120000);
});
