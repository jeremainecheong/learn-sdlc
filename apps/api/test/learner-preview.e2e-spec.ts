import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { INHERITED_TASK_KEY } from '@learnsdlc/shared';
import type { LearnerPreviewView, PhaseDetail, RunResult } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { InterviewService } from '../src/assistant/interview.service';
import { AuthService } from '../src/auth/auth.service';
import { DeepValidationService } from '../src/authoring/deep-validation';
import { learnerPreviewOf } from '../src/authoring/learner-preview';
import { UPLOAD_PATH } from '../src/authoring/upload.service';
import type { CompiledSnapshot } from '../src/content/pack-compiler';
import type { CodeChecks, ConfigChecks, TestsChecks } from '../src/content/content.types';
import { ProjectVersionEntity } from '../src/content/project.entities';
import { PhaseStateEntity, UserEntity } from '../src/db/entities';
import { RunGate } from '../src/execution/run-gate';
import { SandboxService, type SandboxJob } from '../src/execution/sandbox.service';
import { FeedbackService } from '../src/feedback/feedback.service';
import { QuizService } from '../src/quiz/quiz.service';
import { WorkflowService } from '../src/workflow/workflow.service';
import { mockAiForRoutes } from './mock-ai';
import { zipDirectory } from './fixtures/upload-packs/archive';
import { SHELF_DIR } from './fixtures/upload-packs/markers';
import { fixtureQuizQuestions } from './quiz-fixture';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The learner preview on the real application: the
 * `@Get('projects/:projectId/versions/:versionId/learner-preview')` route and
 * `AuthoringService.learnerPreview`. The parity cases read the builder
 * directly and need no route.
 *
 * - **Parity.** For TaskTrackr's published version AND
 *   the shelf uploaded, deep-validated (stub transport) and published in-test
 *   with a quiz beside Design's task, every preview phase's fields and files
 *   are a subset of what a fresh learner reads, with equal values: the
 *   learner's `phaseDetail(…, 'full', repair=false, write=false)` (the ViewAs
 *   path), `InterviewService.state` and the quiz room plus a drawn paper. The
 *   two derived fields are held to their sources (`gate` is shown, never
 *   enforced; `needsSignOff === (evidence === 'signed-off')`), and a quiz's
 *   pool is a superset of any paper (a paper draws `drawn` of it).
 * - **No write and no call**, through the route: every table's row
 *   count is equal before and after, and the provider, the sandbox transport,
 *   the grader and `RunGate` are each called zero times.
 * - **Guards**: the owner 200; another teacher 404; a learner 403. The rate
 *   limit lives in memory or Redis, so the row counts cover it.
 */
describe('learner preview', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  let address = 0;
  const from = () => ({ 'x-forwarded-for': `10.91.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });

  let owner = { id: '', token: '' };
  let other = { id: '', token: '' };
  let learner = { id: '', token: '' };
  let projectId = '';
  let versionId = '';
  let snapshot: CompiledSnapshot;
  const QUIZ_KEY = 'pv-design-check';

  /* The sandbox transport judges a job by its bytes (sealed-roles-shelf's stub, copied, never imported). */
  const ok = (n = 4): RunResult => ({ ok: true, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1, tests: { total: n, passed: n, failed: 0, errored: 0, cases: [] } });
  const bad = (n = 4): RunResult => ({ ok: false, exitKind: 'error', stdout: '', stderr: '', durationMs: 1, tests: { total: n, passed: n - 1, failed: 1, errored: 0, cases: [] } });
  const same = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys(a).sort().join('\n') === Object.keys(b).sort().join('\n') && Object.keys(a).every((k) => a[k] === b[k]);
  const judge = (job: SandboxJob): RunResult => {
    const phases = snapshot.content.phases;
    if (job.mode === 'smoke') {
      const drill = phases.map((p) => (p.checks.kind === 'config' ? (p.checks as ConfigChecks).drill : undefined)).find(Boolean);
      const faulted = drill && Object.entries(drill.faultedFiles).some(([at, bytes]) => job.files[at] === bytes);
      return { ok: !faulted, exitKind: faulted ? 'error' : 'ok', stdout: '', stderr: '', durationMs: 1 };
    }
    if (job.gradedFiles) {
      const tests = phases.find((p) => p.checks.kind === 'tests')?.checks as TestsChecks | undefined;
      return tests?.runs.some((run) => same(job.gradedFiles!, run.implFiles)) ? ok() : bad();
    }
    for (const phase of phases) {
      if (phase.checks.kind !== 'code') continue;
      const checks = phase.checks as CodeChecks;
      const hidden = checks.runs.some(
        (run) => Object.keys(run.hiddenTestFiles).length > 0 && Object.entries(run.hiddenTestFiles).every(([at, bytes]) => job.files[at] === bytes),
      );
      if (!hidden) continue;
      return Object.entries(checks.solutionFiles).every(([at, bytes]) => job.files[at] === bytes) ? ok() : bad();
    }
    return bad();
  };

  /* The calls the no-call case counts. */
  const aiCalls: string[] = [];
  const countingAi = new Proxy(mockAiForRoutes as object, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function'
        ? (...args: unknown[]) => {
            aiCalls.push(String(key));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          }
        : value;
    },
  });
  let sandboxCalls = 0;

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `${name}-${stamp}@learner-preview.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };
  const previewPath = (project: string, version: string) =>
    `/api/v1/instructor/projects/${project}/versions/${version}/learner-preview`;

  /** A learner on `versionId`, every phase opened (test scaffolding: the gate is not what is under test). */
  const enrolOn = async (publishedVersionId: string, slug: string): Promise<Record<string, string>> => {
    const made = await request(http).post('/api/v1/instructor/cohorts').set(bearer(owner.token)).send({ name: `Preview ${slug}` }).expect(201);
    await request(http)
      .put(`/api/v1/instructor/cohorts/${made.body.id}/project`)
      .set(bearer(owner.token))
      .send({ projectVersionId: publishedVersionId, reason: 'The learner preview parity check.' })
      .expect(200);
    const fresh = await account(`pv-learner-${slug}-${address}`);
    await request(http).post('/api/v1/enrollments/join').set(bearer(fresh.token)).send({ code: made.body.joinCode }).expect(200);
    const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(fresh.token)).send({ projectSlug: slug }).expect(201);
    const states: Record<string, string> = { __user: fresh.id };
    for (const phase of enrolled.body.phases) states[phase.key] = phase.id;
    await db.manager
      .createQueryBuilder()
      .update(PhaseStateEntity)
      .set({ status: 'in_progress' })
      .where('userId = :user AND status = :locked', { user: fresh.id, locked: 'locked' })
      .execute();
    return states;
  };

  /** Parity: every preview field and file ⊆ the learner's own payload, with equal values. */
  const assertParity = async (compiled: CompiledSnapshot, states: Record<string, string>) => {
    const preview = learnerPreviewOf(compiled);
    const learnerId = states.__user;
    const workflow = app.get(WorkflowService);
    for (const phase of preview.phases) {
      const detail: PhaseDetail = await workflow.phaseDetail(learnerId, states[phase.key], 'full', false, false);
      expect({ key: phase.key, order: phase.order, title: phase.title, intro: phase.intro, objectives: phase.objectives, brief: phase.brief, canRun: phase.canRun, runLabel: phase.runLabel }).toEqual({
        key: detail.key, order: detail.order, title: detail.title, intro: detail.intro, objectives: detail.objectives, brief: detail.taskPanel, canRun: detail.canRun, runLabel: detail.runLabel,
      });
      expect(phase.checkLabels).toEqual(detail.rubric.criteria.map((criterion) => criterion.title));
      for (const file of phase.files) {
        expect(detail.files.find((one) => one.path === file.path)).toMatchObject(file);
      }
      for (const task of phase.tasks) {
        const view = (detail.tasks ?? []).find((one) => one.key === task.key);
        expect(view).toBeDefined();
        const { needsSignOff, ...carried } = task;
        expect(view).toMatchObject(carried);
        expect(needsSignOff).toBe(view!.evidence === 'signed-off');
      }
      if (phase.interview) {
        const state = await app.get(InterviewService).state(learnerId, states[phase.key]);
        expect({ persona: state.persona, opening: state.opening }).toEqual(phase.interview);
        expect(detail.stakeholder).toEqual(phase.interview.persona);
      } else {
        expect(detail.stakeholder).toBeNull();
      }
      for (const quiz of phase.quizzes) {
        const quizzes = app.get(QuizService);
        const room = await quizzes.room(learnerId, states[phase.key], quiz.taskKey);
        expect({ taskKey: room.taskKey, title: room.title, drawn: room.drawn, passMark: room.passMark }).toEqual({
          taskKey: quiz.taskKey, title: quiz.title, drawn: quiz.drawn, passMark: quiz.passMark,
        });
        const paper = await quizzes.start(learnerId, states[phase.key], quiz.taskKey);
        expect(paper.questions).toHaveLength(quiz.drawn);
        for (const drawn of paper.questions) {
          const pooled = quiz.questions.find((one) => one.id === drawn.id);
          expect(pooled).toBeDefined();
          expect({ stem: pooled!.stem, multiple: pooled!.multiple }).toEqual({ stem: drawn.stem, multiple: drawn.multiple });
          expect([...pooled!.options].sort()).toEqual(drawn.options.map((option) => option.text).sort());
        }
      }
    }
    return preview;
  };

  beforeAll(async () => {
    jest.spyOn(SandboxService.prototype as any, 'runPython').mockImplementation(async (...args: unknown[]) => {
      sandboxCalls += 1;
      return JSON.stringify(judge(args[1] as SandboxJob));
    });
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, countingAi]], trustProxy: true, listen: true }));
    db = app.get(DataSource);

    owner = await account('pv-owner', 'INSTRUCTOR');
    other = await account('pv-other', 'INSTRUCTOR');
    learner = await account('pv-learner');

    const uploaded = await request(http)
      .post(UPLOAD_PATH)
      .set(bearer(owner.token))
      .set(from())
      .send({ title: `Shelf preview ${stamp}`, archiveBase64: zipDirectory(SHELF_DIR).toString('base64') });
    expect({ status: uploaded.status, code: uploaded.body?.code }).toEqual({ status: 201, code: undefined });
    projectId = uploaded.body.projectId;
    versionId = uploaded.body.versionId;
    // A quiz beside Design's task, so the parity covers a pool and a paper.
    await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/phases/design/tasks`)
      .set(bearer(owner.token))
      .send({
        taskKey: QUIZ_KEY,
        title: 'Check the contract',
        brief: 'Five questions about the shelf contract.',
        artefactType: 'quiz',
        required: false,
        quiz: { questions: fixtureQuizQuestions(8), drawn: 5, shuffleOptions: true, passMark: 80, attempts: { max: 3, cooldownSeconds: null }, criterion: 'concepts' },
      })
      .expect(201);
    snapshot = (await db.manager.findOneByOrFail(ProjectVersionEntity, { id: versionId })).compiled as CompiledSnapshot;
  }, 180000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  /* ------------------------------ guards ------------------------------ */

  it('guards: the owner 200, another teacher 404, a learner 403', async () => {
    const own = await request(http).get(previewPath(projectId, versionId)).set(bearer(owner.token));
    expect(own.status).toBe(200);
    expect((own.body as LearnerPreviewView).phases).toHaveLength(6);
    await request(http).get(previewPath(projectId, versionId)).set(bearer(other.token)).expect(404);
    await request(http).get(previewPath(projectId, versionId)).set(bearer(learner.token)).expect(403);
  });

  it('guards: an ADMIN who does not own the project 403; a version of another project, through this one, 404', async () => {
    const admin = await account('pv-admin', 'ADMIN');
    await request(http).get(previewPath(projectId, versionId)).set(bearer(admin.token)).expect(403);
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(owner.token)).expect(200);
    const elsewhere = library.body.library.find((one: any) => one.isDefault).publishedVersionId as string;
    expect(elsewhere).not.toBe(versionId);
    const crossed = await request(http).get(previewPath(projectId, elsewhere)).set(bearer(owner.token));
    expect(crossed.status).toBe(404);
    expect(JSON.stringify(crossed.body)).not.toContain('"phases"');
  });

  it('a draft whose last compile failed is refused by name (409), never shown as new words beside the old task list', async () => {
    const required = `/api/v1/instructor/projects/${projectId}/versions/${versionId}/phases/design/tasks/${INHERITED_TASK_KEY}/required`;
    await request(http).put(required).set(bearer(owner.token)).set(from()).send({ required: false }).expect(200);
    try {
      const refused = await request(http).get(previewPath(projectId, versionId)).set(bearer(owner.token));
      expect({ status: refused.status, says: String(refused.body?.message).includes('does not compile as it stands') }).toEqual({ status: 409, says: true });
    } finally {
      // undone whatever the assertion said, so the publish below still has a required task
      await request(http).put(required).set(bearer(owner.token)).set(from()).send({ required: true }).expect(200);
    }
    snapshot = (await db.manager.findOneByOrFail(ProjectVersionEntity, { id: versionId })).compiled as CompiledSnapshot;
    const back = await request(http).get(previewPath(projectId, versionId)).set(bearer(owner.token)).expect(200);
    expect(back.body).toEqual(JSON.parse(JSON.stringify(learnerPreviewOf(snapshot))));
  });

  /* ----------------------- no write and no call ----------------------- */

  it('the route writes no row and calls no provider, sandbox, grader or RunGate', async () => {
    const tables = (await db.query(
      db.options.type === 'postgres'
        ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'"
        : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )) as { name: string }[];
    expect(tables.length).toBeGreaterThan(10);
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const { name } of tables) out[name] = Number((await db.query(`SELECT COUNT(*) AS n FROM "${name}"`))[0].n);
      return out;
    };
    const grader = jest.spyOn(FeedbackService.prototype, 'submit');
    const gate = jest.spyOn(RunGate.prototype, 'run');
    aiCalls.length = 0;
    const sandboxBefore = sandboxCalls;
    const before = await counts();
    for (let i = 0; i < 3; i += 1) {
      const answer = await request(http).get(previewPath(projectId, versionId)).set(bearer(owner.token)).expect(200);
      expect(answer.body).toEqual(JSON.parse(JSON.stringify(learnerPreviewOf(snapshot))));
    }
    expect(await counts()).toEqual(before);
    expect({ ai: aiCalls, sandbox: sandboxCalls - sandboxBefore, grader: grader.mock.calls.length, gate: gate.mock.calls.length }).toEqual({
      ai: [],
      sandbox: 0,
      grader: 0,
      gate: 0,
    });
  });

  /* ------------------------------ parity ----------------------------- */

  it("TaskTrackr: every preview field and file is the learner's own, with equal values", async () => {
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(owner.token)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    const version = await db.manager.findOneByOrFail(ProjectVersionEntity, { id: platform.publishedVersionId });
    const states = await enrolOn(version.id, (version.compiled as CompiledSnapshot).slug);
    const preview = await assertParity(version.compiled as CompiledSnapshot, states);
    expect(preview.phases[0].interview).not.toBeNull();
  }, 180000);

  it('the Shelf pack, published in the test: the same, with a quiz pool beside Design', async () => {
    const deep = `/api/v1/instructor/projects/${projectId}/versions/${versionId}/deep-validation`;
    const cost = await request(http).get(deep).set(bearer(owner.token)).expect(200);
    await request(http).post(deep).set(bearer(owner.token)).send({ acknowledgedMicroVMs: cost.body.costWarning.microVMs }).expect(202);
    await app.get(DeepValidationService).idle();
    const published = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/publish`)
      .set(bearer(owner.token))
      .send({ version: '1.0.0', notes: 'Published for the learner preview parity check.' });
    expect({ status: published.status, message: published.status === 200 ? null : published.body.message }).toEqual({ status: 200, message: null });
    const version = await db.manager.findOneByOrFail(ProjectVersionEntity, { id: published.body.versionId });
    const states = await enrolOn(version.id, (version.compiled as CompiledSnapshot).slug);
    const preview = await assertParity(version.compiled as CompiledSnapshot, states);
    expect(preview.phases.find((phase) => phase.key === 'design')!.quizzes).toHaveLength(1);
  }, 240000);
});
