import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { EnrollmentView, PhaseDetail, PhaseKey, PublishVersionResult } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { PhaseStateEntity, UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { Redactor, elideFiles, holdContract } from './fixtures/contract-bodies/recorder';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The recorded provenance contract of a copied project, through the real
 * `AppModule`.
 *
 * The seam spec `copy-becomes-own.e2e-spec.ts` proves the whole
 * journey; this file drives the same routes on a smaller copy and holds what
 * they answer in `fixtures/contract-bodies/copy-provenance.json`, which
 * `apps/web/test/copy-becomes-own-wiring.test.tsx` renders the real editor,
 * class card and learner surfaces from.
 *
 * A teacher copies the reference project as "Room Desk" and rewrites only the
 * Requirements intro, so the recording holds all three roll-ups a learner can
 * meet: Requirements `mixed` (own intro, the reference's interview, files and
 * room task), Design `reference`, and the four application phases
 * `reference` with the application named. A learner on the copy and a learner
 * on the platform default each read their board and three phases.
 *
 * Pinned by value: on every reference-project
 * payload `roomTask === 'reference'` on Requirements and Design and
 * `scenario === 'reference'` on every summary; `projectIsDefault` is true on
 * the default enrolment and false on the copy's; `application` is named on the
 * application phases of both, and the web's bridge notice keys it on
 * `projectIsDefault === false` alone.
 */
describe('the copy\'s provenance, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const SLUG = 'room-desk';
  const INTRO = 'Room Desk books the meeting rooms on two floors. You start where every project starts: with what the facilities team needs.';
  const redactor = new Redactor();

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

  const detailOf = async (token: string, id: string): Promise<PhaseDetail> =>
    (await request(http).get(`/api/v1/phases/${id}`).set(bearer(token)).expect(200)).body as PhaseDetail;

  const idOf = (view: EnrollmentView, key: PhaseKey) => view.phases.find((one) => one.key === key)!.id;

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  it('records the teacher draft, the class card, both boards and their phases, and pins the provenance values', async () => {
    const teacher = await account('teacher', 'Zeb Quorrant', 'INSTRUCTOR');
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacher.token)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacher.token))
      .send({ title: 'Room Desk', slug: SLUG, fromVersionId: platform.publishedVersionId })
      .expect(201);
    const draft = (path = '') =>
      `/api/v1/instructor/projects/${created.body.project.id}/versions/${created.body.draftVersionId}${path}`;

    const copied = (await request(http).get(draft()).set(bearer(teacher.token)).expect(200)).body;
    const intro = await request(http)
      .patch(draft('/phases/requirements'))
      .set(bearer(teacher.token))
      .send({ intro: INTRO })
      .expect(200);
    const edited = (await request(http).get(draft()).set(bearer(teacher.token)).expect(200)).body;
    const published = (
      await request(http).post(draft('/publish')).set(bearer(teacher.token)).send({ version: '1.0.0' }).expect(200)
    ).body as PublishVersionResult;
    const cohort = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).send({ name: 'Tuesday' }).expect(201);
    redactor.name(cohort.body.joinCode, 'join-code');
    const assignable = (
      await request(http).get(`/api/v1/instructor/cohorts/${cohort.body.id}/project/assignable`).set(bearer(teacher.token)).expect(200)
    ).body;
    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohort.body.id}/project`)
      .set(bearer(teacher.token))
      .send({ projectVersionId: published.versionId, reason: 'Tuesday books rooms this term.' })
      .expect(200);

    const copyLearner = await account('copy-learner', 'Ixa Pellowmere');
    await request(http).post('/api/v1/enrollments/join').set(bearer(copyLearner.token)).send({ code: cohort.body.joinCode }).expect(200);
    const copyBoard = (await request(http).post('/api/v1/enrollments').set(bearer(copyLearner.token)).send({}).expect(201)).body as EnrollmentView;

    const plainLearner = await account('plain-learner', 'Oru Vantelli');
    const plainBoard = (
      await request(http).post('/api/v1/enrollments').set(bearer(plainLearner.token)).send({ projectSlug: platform.slug }).expect(201)
    ).body as EnrollmentView;

    // A locked phase's detail is refused (403), so the two later phases are
    // opened by one declared repository write each (the named shortcut of
    // copy-becomes-own.e2e-spec.ts): what is recorded is the read, not
    // the walk to it.
    const open = async (board: EnrollmentView) => {
      for (const key of ['design', 'implementation'] as PhaseKey[]) {
        await db.getRepository(PhaseStateEntity).update({ id: idOf(board, key) }, { status: 'in_progress', unlockedAt: new Date().toISOString() });
      }
    };
    await open(copyBoard);
    await open(plainBoard);
    const copyPhases = Object.fromEntries(
      await Promise.all(
        (['requirements', 'design', 'implementation'] as PhaseKey[]).map(async (key) => [key, elideFiles(await detailOf(copyLearner.token, idOf(copyBoard, key)))]),
      ),
    ) as Record<string, PhaseDetail>;
    const plainPhases = Object.fromEntries(
      await Promise.all(
        (['requirements', 'design', 'implementation'] as PhaseKey[]).map(async (key) => [key, elideFiles(await detailOf(plainLearner.token, idOf(plainBoard, key)))]),
      ),
    ) as Record<string, PhaseDetail>;

    /* ----------------------------- the pins, by value ---------------------------- */

    // The copy, before any edit: every phase the reference's.
    for (const phase of copied.phases) expect([phase.key, phase.provenance?.rollup]).toEqual([phase.key, 'reference']);
    expect(intro.body.phase.provenance.intro).toBe('own');
    const editedReq = edited.phases.find((one: any) => one.key === 'requirements');
    expect(editedReq.provenance).toMatchObject({ rollup: 'mixed', intro: 'own', roomTask: 'reference' });

    // The class card: one written phase mixed, one the reference's, the application named.
    const card = assignable.find((one: any) => one.versionId === published.versionId);
    expect(card.provenance).toMatchObject({ ownPhases: 0, mixedPhases: 1, referencePhases: 1 });
    expect(typeof card.provenance.applicationFrom).toBe('string');

    // The default enrolment: projectIsDefault true, every summary the reference's,
    // both written rooms the reference's.
    expect(plainBoard.projectIsDefault).toBe(true);
    for (const summary of plainBoard.phases) expect([summary.key, summary.scenario]).toEqual([summary.key, 'reference']);
    expect(plainPhases.requirements.provenance?.roomTask).toBe('reference');
    expect(plainPhases.design.provenance?.roomTask).toBe('reference');
    expect(plainPhases.implementation.provenance?.application).toBe(card.provenance.applicationFrom);

    // The copy's enrolment: projectIsDefault false, Requirements mixed, the rest the reference's.
    expect(copyBoard.projectIsDefault).toBe(false);
    const scenarios = Object.fromEntries(copyBoard.phases.map((one) => [one.key, one.scenario]));
    expect(scenarios).toEqual({
      requirements: 'mixed',
      design: 'reference',
      implementation: 'reference',
      testing: 'reference',
      deployment: 'reference',
      maintenance: 'reference',
    });
    const introOpening = copyBoard.phases.find((one) => one.key === 'requirements')!.intro ?? '';
    expect(introOpening.length).toBeGreaterThan(0);
    expect(INTRO.startsWith(introOpening.replace(/…$/, ''))).toBe(true);
    expect(copyPhases.requirements.provenance).toMatchObject({ rollup: 'mixed', intro: 'own', roomTask: 'reference' });
    expect(copyPhases.design.provenance).toMatchObject({ rollup: 'reference', roomTask: 'reference' });
    expect(copyPhases.implementation.provenance?.application).toBe(card.provenance.applicationFrom);

    // The teacher's record of changes, which the web's AuditList labels: the
    // intro write leaves `project.phase`, drawn by
    // apps/web/test/authoring-audit-wiring.test.tsx.
    const teacherTrail = (await request(http).get('/api/v1/instructor/audit').set(bearer(teacher.token)).expect(200)).body as any[];
    const trailNames = new Set(teacherTrail.map((one) => one.event));
    for (const name of ['project.create', 'project.phase', 'project.publish', 'cohort.project']) {
      expect([name, trailNames.has(name)]).toEqual([name, true]);
    }

    const { live } = holdContract(
      'copy-provenance',
      'apps/api/test/copy-provenance-contract-wiring.e2e-spec.ts',
      {
        teacherDraftCopied: { phases: copied.phases.map((one: any) => ({ key: one.key, provenance: one.provenance })) },
        teacherPhaseAfterIntro: intro.body.phase,
        // The whole draft the editor mounts on (the web's ProjectEditor reads
        // it), less the scoped package names in the stack list, whose `@` no
        // recording may hold (the seam here is provenance).
        teacherDraftEdited: {
          ...edited,
          supportedStacks: { ...edited.supportedStacks, node: (edited.supportedStacks?.node ?? []).filter((one: string) => !one.includes('@')) },
        },
        assignableCard: card,
        copyEnrollment: copyBoard,
        copyPhases,
        defaultEnrollment: plainBoard,
        defaultPhases: plainPhases,
        teacherTrail,
      },
      redactor,
    );
    // The recording itself carries the pins (what the web tests read).
    expect((live.defaultEnrollment as EnrollmentView).projectIsDefault).toBe(true);
    expect((live.copyEnrollment as EnrollmentView).projectIsDefault).toBe(false);
  }, 180000);
});
