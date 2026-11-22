import { REQUIREMENTS_ARTEFACT } from '../../../e2e/golden-records';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { mockAiForRoutes } from './mock-ai';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ContentService } from '../src/content/content.service';
import { soleTaskFor } from '../src/content/pack-compiler';
import { AuditEventEntity, PhaseStateEntity, SubmissionEntity } from '../src/db/entities';
import { strictlyReviewed } from './strict-evidence-fixture';
import { HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The post-gate reveal end to end.
 *
 * Two things are worth proving through the whole container rather than against
 * the service: the route is behind the global guard and the gate refuses before
 * anything else can, and the phase detail every room already holds carries the
 * door, so a page can decide whether to draw it without a second request.
 *
 * Requirements runs through the real pipeline with an explicit semantic AI
 * test double, so the "this phase has no reference" answer is an honest one
 * rather than a fixture.
 * Implementation's gate is set by hand: passing it needs a sandbox run of the
 * whole two-language project, which `e2e/solution.spec.ts` and the journey
 * already do end to end, and repeating it here would buy a slower copy of the
 * same fact rather than a new one.
 */
describe('The reference solution (integration)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let dataSource: DataSource;
  let content: ContentService;

  let leeToken = '';
  let kimToken = '';
  let leePhases: Record<string, string> = {};

  const asLee = () => ({ authorization: `Bearer ${leeToken}` });
  const asKim = () => ({ authorization: `Bearer ${kimToken}` });

  const learner = async (
    email: string,
    displayName: string,
  ): Promise<{ token: string; phases: Record<string, string> }> => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password1!', displayName })
      .expect(201);
    const token = registered.body.token;
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set({ authorization: `Bearer ${token}` })
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    return {
      token,
      phases: Object.fromEntries(enrolled.body.phases.map((p: any) => [p.key, p.id])),
    };
  };

  const passRequirements = async (token: string, phaseId: string): Promise<void> => {
    const auth = { authorization: `Bearer ${token}` };
    await request(http)
      .put(`/api/v1/phases/${phaseId}/workspace`)
      .set(auth)
      .send({ files: REQUIREMENTS_ARTEFACT })
      .expect(200);
    const submitted = await request(http)
      .post(`/api/v1/phases/${phaseId}/submit`)
      .set(auth)
      .expect(201);
    const verdict = await waitForSubmission(http, auth, submitted.body.id, { attempts: 80, intervalMs: 250 });
    expect(verdict.passed).toBe(true);
  };

  /**
   * The board half of a pass and nothing else: what a teacher's phase-wide
   * Pass writes, with no revision of the learner's behind it.
   */
  const boardPass = async (phaseStateId: string) => {
    const states = dataSource.getRepository(PhaseStateEntity);
    const state = await states.findOneByOrFail({ id: phaseStateId });
    await states.update(phaseStateId, {
      status: 'passed',
      passedAt: new Date().toISOString(),
      bestScore: 88,
      attempts: 1,
      unlockedAt: state.unlockedAt ?? new Date().toISOString(),
    });
    return state;
  };

  /**
   * The gate, set the way `advance()` requires it, with the merged revision
   * behind it: a strictly reviewed one, because the door opens on the strict
   * gate's own evidence.
   */
  const passByHand = async (phaseStateId: string, snapshot: Record<string, string>) => {
    const state = await boardPass(phaseStateId);
    await dataSource.getRepository(SubmissionEntity).save(
      dataSource.getRepository(SubmissionEntity).create({
        phaseStateId,
        userId: state.userId,
        status: 'completed',
        passed: true,
        score: 88,
        workspaceSnapshot: snapshot,
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: strictlyReviewed(soleTaskFor(content.getPhase('tasktrackr', state.phaseKey)).rubric),
      }),
    );
  };

  const reads = () =>
    dataSource.getRepository(AuditEventEntity).find({ where: { event: 'solution.read' } });

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], pipeline: 'prefix' }));
    dataSource = app.get(DataSource);
    content = app.get(ContentService);

    const lee = await learner('solution-lee@learnsdlc.test', 'Lee');
    leeToken = lee.token;
    leePhases = lee.phases;
    const kim = await learner('solution-kim@learnsdlc.test', 'Kim');
    kimToken = kim.token;
  }, 180000);

  afterAll(async () => {
    await app.close();
  });

  it('refuses the reference on a phase whose gate is not in', async () => {
    const res = await request(http)
      .get(`/api/v1/phases/${leePhases.requirements}/solution`)
      .set(asLee())
      .expect(403);
    expect(res.body.message).toBe('the reference opens when this phase passes its gate');
  });

  it('refuses without a token at all', async () => {
    await request(http).get(`/api/v1/phases/${leePhases.requirements}/solution`).expect(401);
  });

  it('says a passed prose phase has no reference, and stamps nothing', async () => {
    await passRequirements(leeToken, leePhases.requirements);
    const res = await request(http)
      .get(`/api/v1/phases/${leePhases.requirements}/solution`)
      .set(asLee())
      .expect(200);
    expect(res.body.available).toBe(false);
    expect(res.body.unavailableReason).toBe('prose');
    expect(res.body.files).toEqual([]);
    expect(res.body.readAt).toBeNull();
    expect(await reads()).toHaveLength(0);
  }, 60000);

  it('carries the door on the phase detail of a phase the pack answers nothing for', async () => {
    const full = await request(http)
      .get(`/api/v1/phases/${leePhases.requirements}`)
      .set(asLee())
      .expect(200);
    expect(full.body.solution).toEqual({ available: false, files: 0, readAt: null });
  });

  it('keeps the answer shut on a board-only pass, and says so on the phase detail', async () => {
    await boardPass(leePhases.implementation);
    const res = await request(http)
      .get(`/api/v1/phases/${leePhases.implementation}/solution`)
      .set(asLee())
      .expect(403);
    expect(res.body.message).toBe('the reference opens when this phase passes its gate');
    const detail = await request(http)
      .get(`/api/v1/phases/${leePhases.implementation}`)
      .set(asLee())
      .expect(200);
    expect(detail.body.solution).toMatchObject({ available: true, awaitingReview: true, readAt: null });
    expect(await reads()).toHaveLength(0);
  });

  it("hands back the pack's answer beside the learner's merged files, once the gate is in", async () => {
    const phase = content.getPhase('tasktrackr', 'implementation');
    if (phase.checks.kind !== 'code') throw new Error('implementation is a code phase');
    const targets = phase.checks.editableTargets;
    await passByHand(leePhases.implementation, { [targets[0]]: 'mine\n' });

    const res = await request(http)
      .get(`/api/v1/phases/${leePhases.implementation}/solution`)
      .set(asLee())
      .expect(200);
    expect(res.body.available).toBe(true);
    expect(res.body.files.map((f: any) => f.path)).toEqual(targets);
    expect(res.body.files[0].yours).toBe('mine\n');
    expect(res.body.files[0].theirs).toBe(phase.checks.solutionFiles[targets[0]]);
    expect(res.body.files.some((f: any) => f.yours === null)).toBe(true);
    expect(res.body.bestScore).toBe(88);
    expect(res.body.readAt).not.toBeNull();
  });

  it('stamps the first reading once, and says so on the phase detail', async () => {
    const first = await request(http)
      .get(`/api/v1/phases/${leePhases.implementation}/solution`)
      .set(asLee())
      .expect(200);
    const again = await request(http)
      .get(`/api/v1/phases/${leePhases.implementation}/solution`)
      .set(asLee())
      .expect(200);
    expect(again.body.readAt).toBe(first.body.readAt);
    expect(await reads()).toHaveLength(1);

    const detail = await request(http)
      .get(`/api/v1/phases/${leePhases.implementation}`)
      .set(asLee())
      .expect(200);
    expect(detail.body.solution.readAt).toBe(first.body.readAt);
    // A reviewed pass: the door carries no waiting flag.
    expect(detail.body.solution.awaitingReview).toBeUndefined();

    // The shell holds summaries, and the door has to be on those too: the
    // phases card draws it without ever asking for the workspace's files.
    const summary = await request(http)
      .get(`/api/v1/phases/${leePhases.implementation}?view=summary`)
      .set(asLee())
      .expect(200);
    expect(summary.body.solution.available).toBe(true);
    expect(summary.body.solution.files).toBeGreaterThan(1);
    expect(summary.body.solution.readAt).toBe(first.body.readAt);
  });

  it("refuses another learner's phase in the ownership check's own words", async () => {
    const res = await request(http)
      .get(`/api/v1/phases/${leePhases.implementation}/solution`)
      .set(asKim())
      .expect(403);
    expect(res.body.message).toBe('not your phase');
  });
});
