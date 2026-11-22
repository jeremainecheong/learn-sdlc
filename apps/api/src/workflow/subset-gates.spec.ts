import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import type { PhaseKey } from '@learnsdlc/shared';
import { CohortProjectService } from '../classroom/cohort-project.service';
import { ContentService } from '../content/content.service';
import type { ProjectContent } from '../content/content.types';
import { COMPILER_IDENTITY, soleTaskFor } from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ProjectEntity,
  ProjectVersionEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { WorkflowService } from './workflow.service';

/** TaskTrackr's phases cut to a subset and renumbered 1 to n, as the draft compiler numbers them (`contentForDraft` in draft.ts). */
function subsetOf(shipped: ProjectContent, slug: string, keys: PhaseKey[]): ProjectContent {
  const phases = shipped.phases.filter((one) => keys.includes(one.key)).map((one, at) => ({ ...one, order: at + 1 }));
  return { ...shipped, slug, phases };
}

/** TaskTrackr's phases cut to a subset under stored orders not numbered 1 to n, as an upload can keep them. */
function storedAs(shipped: ProjectContent, slug: string, keys: PhaseKey[], orders: number[]): ProjectContent {
  const phases = shipped.phases.filter((one) => keys.includes(one.key)).map((one, at) => ({ ...one, order: orders[at] }));
  return { ...shipped, slug, phases };
}

/*
 * The versions this file installs, under ids shaped like
 * `project_versions.id`, because the class door reads a version id as a UUID
 * before it looks the row up.
 */
const V_SIX = '00000000-0000-4000-8000-000000000006';
const V_THREE = '00000000-0000-4000-8000-000000000003';
const V_ONE = '00000000-0000-4000-8000-000000000001';
const V_ODD = '00000000-0000-4000-8000-000000000135';
const V_LATE = '00000000-0000-4000-8000-000000000034';
/** One teacher project's two published versions: 1.0.0 holds the six phases, 1.1.0 three of them. */
const V_OWN_SIX = '00000000-0000-4000-8000-000000000a06';
const V_OWN_THREE = '00000000-0000-4000-8000-000000000a03';
const V_SHELFISH = '00000000-0000-4000-8000-000000000b02';

/** The refusal `advance` gives on the last phase while any phase of the version is unpassed. */
const COMPLETION_REFUSAL = 'Course completion requires a strict, evidenced Pass in every phase.';

describe('the gates follow the subset', () => {
  const learner = 'subset-learner';
  let dataSource: DataSource;
  let content: ContentService;
  let service: WorkflowService;
  let phaseStates: Repository<PhaseStateEntity>;
  let shipped: ProjectContent;
  let three: ProjectContent;
  let ownSix: ProjectContent;
  let ownThree: ProjectContent;

  /**
   * A phase the learner can act on: unlocked, and optionally already passed
   * with a strict-evidence submission. `workflow.service.spec.ts`'s helper,
   * reading the phase (and so its rubric) from the learner's own version.
   */
  const open = async (id: string, over: Partial<PhaseStateEntity> = {}): Promise<PhaseStateEntity> => {
    const state = await phaseStates.findOneByOrFail({ id });
    Object.assign(state, { status: 'in_progress', ...over });
    const saved = await phaseStates.save(state);
    if (over.status === 'passed') {
      const enrollment = await dataSource.manager.findOneByOrFail(EnrollmentEntity, { id: state.enrollmentId });
      const phase = content.getPhaseForEnrollment(enrollment, state.phaseKey);
      await dataSource.getRepository(SubmissionEntity).save({
        userId: state.userId,
        phaseStateId: id,
        status: 'completed',
        passed: true,
        workspaceSnapshot: {
          fixture: 'subset gate authority test evidence',
          ...(state.phaseKey === 'design'
            ? { 'shared/contract/screens.json': JSON.stringify({ screens: [{ route: '#/overdue', title: 'Overdue', empty: 'No overdue tasks.' }] }) }
            : {}),
        },
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: {
          assessmentMode: 'strict_binary',
          passed: true,
          checks: [{ id: 'fixture', label: 'Mocked assessment fixture', status: 'passed', detail: 'The subset test isolates persisted gate authority.' }],
          tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] },
          aiReview: {
            provider: 'mock-ai',
            verdict: 'pass',
            criteriaEvidence: phase.rubric.criteria.map((c) => ({ key: c.key, met: true, evidence: 'Fixture evidence for the subset gate only.', issue: '', nextStep: '' })),
          },
        } as never,
      });
    }
    return saved;
  };

  /** Every version this file reads, in one registry: `installVersions` replaces what it held. */
  const installAll = (): void => {
    const one = subsetOf(shipped, 'one', ['testing']);
    const odd = storedAs(shipped, 'odd', ['requirements', 'implementation', 'maintenance'], [1, 3, 5]);
    const late = storedAs(shipped, 'late', ['implementation', 'testing'], [3, 4]);
    // Requirements and Testing, its provided stories numbered SH-n as a teacher's own application numbers them
    const shelfish = subsetOf(shipped, 'shelfish', ['requirements', 'testing']);
    shelfish.phases = shelfish.phases.map((one) =>
      one.key !== 'requirements' ? one : {
        ...one,
        checks: { ...(one.checks as any), providedStories: (one.checks as any).providedStories.map((story: { id: string }) => ({ ...story, id: story.id.replace(/^US-/, 'SH-') })) },
      },
    );
    content.installVersions(
      ([[V_SIX, shipped], [V_THREE, three], [V_ONE, one], [V_ODD, odd], [V_LATE, late], [V_OWN_SIX, ownSix], [V_OWN_THREE, ownThree], [V_SHELFISH, shelfish]] as const).map(([versionId, project]) => ({
        versionId,
        content: project,
        phases: project.phases.map((phase) => ({ key: phase.key, tasks: [soleTaskFor(phase)] })),
        compiler: COMPILER_IDENTITY,
      })),
    );
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    shipped = content.getProject('tasktrackr');
    three = subsetOf(shipped, 'three', ['requirements', 'design', 'implementation']);
    ownSix = { ...subsetOf(shipped, 'own', ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance']), version: '1.0.0' };
    ownThree = { ...subsetOf(shipped, 'own', ['requirements', 'design', 'implementation']), version: '1.1.0' };
    installAll();
    phaseStates = dataSource.getRepository(PhaseStateEntity);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    const feedback = { latestFor: async () => null, runSmokeCheck: jest.fn() } as unknown as FeedbackService;
    service = new WorkflowService(dataSource.getRepository(EnrollmentEntity), phaseStates, dataSource.getRepository(ReleaseRecordEntity), content, feedback, dataSource);
  });

  it('enrols a three-phase project with three states, the first open and the rest locked', async () => {
    const view = await service.enroll(learner, 'three');
    expect(view.phases.map((one) => [one.key, one.order, one.status])).toEqual([
      ['requirements', 1, 'in_progress'], ['design', 2, 'locked'], ['implementation', 3, 'locked'],
    ]);
    expect(view.currentPhaseOrder).toBe(1);
  });

  it('opens a one-phase project on its only phase, Testing at order 1', async () => {
    const view = await service.enroll(learner, 'one');
    expect(view.phases.map((one) => [one.key, one.order, one.status])).toEqual([['testing', 1, 'in_progress']]);
  });

  it('advances to the next phase the project holds, and completes on its last', async () => {
    const ids = Object.fromEntries((await service.enroll(learner, 'three')).phases.map((one) => [one.key, one.id]));
    await open(ids.requirements, { status: 'passed' });
    await service.advance(learner, ids.requirements);
    expect((await phaseStates.findOneByOrFail({ id: ids.design })).status).toBe('in_progress');
    await open(ids.design, { status: 'passed' });
    await service.advance(learner, ids.design);
    expect((await phaseStates.findOneByOrFail({ id: ids.implementation })).status).toBe('in_progress');
    await open(ids.implementation, { status: 'passed' });
    const done = await service.advance(learner, ids.implementation);
    expect(done.completed).toBe(true);
    expect(done.completedAt).toEqual(expect.any(String));
    expect(done.releases?.map((one) => one.version)).toEqual(['v1', 'v2', 'v3']);
  });

  it('completes a one-phase project on its pass', async () => {
    const ids = Object.fromEntries((await service.enroll(learner, 'one')).phases.map((one) => [one.key, one.id]));
    await open(ids.testing, { status: 'passed' });
    const done = await service.advance(learner, ids.testing);
    expect(done.completed).toBe(true);
    expect(done.releases?.map((one) => one.version)).toEqual(['v1']);
  });

  it('does not complete while a phase of the project is unpassed', async () => {
    const ids = Object.fromEntries((await service.enroll(learner, 'three')).phases.map((one) => [one.key, one.id]));
    await open(ids.requirements, { status: 'passed' });
    await open(ids.design, { status: 'in_progress' });
    await open(ids.implementation, { status: 'passed' });
    await dataSource.manager.update(EnrollmentEntity, { userId: learner }, { currentPhaseOrder: 3 });
    await expect(service.advance(learner, ids.implementation)).rejects.toThrow(COMPLETION_REFUSAL);
    expect((await dataSource.manager.findOneByOrFail(EnrollmentEntity, { userId: learner })).completed).toBe(false);
  });

  it("carries each phase's place and the project's count on the phase detail", async () => {
    const ids = Object.fromEntries((await service.enroll(learner, 'three')).phases.map((one) => [one.key, one.id]));
    const detail = await service.phaseDetail(learner, ids.requirements);
    expect([detail.order, detail.place, detail.count]).toEqual([1, 1, 3]);
    await open(ids.implementation);
    const last = await service.phaseDetail(learner, ids.implementation, 'summary');
    expect([last.order, last.place, last.count]).toEqual([3, 3, 3]);
    const only = Object.fromEntries((await service.enroll('subset-other', 'one')).phases.map((one) => [one.key, one.id]));
    const testing = await service.phaseDetail('subset-other', only.testing);
    expect([testing.order, testing.place, testing.count]).toEqual([1, 1, 1]);
  });

  it("tells the Testing room the prefixes its version's own stories use, US when the version holds no Requirements stories (the harvest ruling)", async () => {
    const six = Object.fromEntries((await service.enroll(learner, 'tasktrackr')).phases.map((one) => [one.key, one.id]));
    await open(six.testing);
    expect((await service.phaseDetail(learner, six.testing)).storyPrefixes).toEqual(['US']);
    expect(await service.phaseDetail(learner, six.requirements)).not.toHaveProperty('storyPrefixes');
    const sh = Object.fromEntries((await service.enroll('subset-shelf', 'shelfish')).phases.map((one) => [one.key, one.id]));
    await open(sh.testing);
    expect((await service.phaseDetail('subset-shelf', sh.testing, 'summary')).storyPrefixes).toEqual(['SH']);
    const only = Object.fromEntries((await service.enroll('subset-other', 'one')).phases.map((one) => [one.key, one.id]));
    expect((await service.phaseDetail('subset-other', only.testing)).storyPrefixes).toEqual(['US']);
  });

  it('follows a stored version numbered 1, 3 and 5 by key: the completion arm only on its last, the next phase by place, releases v1 to v3', async () => {
    const view = await service.enroll(learner, 'odd');
    expect(view.phases.map((one) => [one.key, one.order, one.status])).toEqual([
      ['requirements', 1, 'in_progress'], ['implementation', 3, 'locked'], ['maintenance', 5, 'locked'],
    ]);
    const ids = Object.fromEntries(view.phases.map((one) => [one.key, one.id]));
    await open(ids.requirements, { status: 'passed' });
    const first = await service.phaseDetail(learner, ids.requirements);
    expect([first.order, first.place, first.count]).toEqual([1, 1, 3]);
    // No phase has order 2, and Requirements is not the last: no completion arm here.
    expect(first.evidenceNeeded).toBeUndefined();
    await service.advance(learner, ids.requirements);
    expect((await phaseStates.findOneByOrFail({ id: ids.implementation })).status).toBe('in_progress');
    await open(ids.implementation, { status: 'passed' });
    await service.advance(learner, ids.implementation);
    await open(ids.maintenance, { status: 'passed' });
    const last = await service.phaseDetail(learner, ids.maintenance);
    expect([last.order, last.place, last.count]).toEqual([5, 3, 3]);
    const done = await service.advance(learner, ids.maintenance);
    expect(done.completed).toBe(true);
    expect(done.releases?.map((one) => one.version)).toEqual(['v1', 'v2', 'v3']);
  });

  it('enrols a stored version numbered 3 and 4 with its first phase open, place 1 of 2', async () => {
    const view = await service.enroll(learner, 'late');
    expect(view.phases.map((one) => [one.key, one.order, one.status])).toEqual([
      ['implementation', 3, 'in_progress'], ['testing', 4, 'locked'],
    ]);
    expect(view.currentPhaseOrder).toBe(3);
    const ids = Object.fromEntries(view.phases.map((one) => [one.key, one.id]));
    const first = await service.phaseDetail(learner, ids.implementation);
    expect([first.order, first.place, first.count]).toEqual([3, 1, 2]);
  });

  it('a learner pinned to six phases keeps six after the class is assigned a three-phase version of the same project (Review Focus 4)', async () => {
    const save = <T extends object>(entity: new () => T, fields: Partial<T>): Promise<T> =>
      dataSource.manager.save(dataSource.manager.create(entity, fields as never));
    const teacher = await save(UserEntity, { email: 'dana@learnsdlc.test', passwordHash: 'x', displayName: 'Dana', role: 'INSTRUCTOR' });
    const cohort = await save(CohortEntity, { name: 'Tuesday class', joinCode: 'ABCDEFGH', ownerUserId: teacher.id });
    const pupil = await save(UserEntity, { email: 'lee@learnsdlc.test', passwordHash: 'x', displayName: 'Lee', cohort: cohort.id });
    const later = await save(UserEntity, { email: 'kim@learnsdlc.test', passwordHash: 'x', displayName: 'Kim', cohort: cohort.id });
    // The teacher's own project, with two published versions: 1.0.0 holds the six phases, 1.1.0 three of them.
    const own = await save(ProjectEntity, { slug: 'own', title: ownSix.title, platformOwned: false, ownerUserId: teacher.id, isDefault: false, origin: 'fork' } as Partial<ProjectEntity>);
    for (const [id, project] of [[V_OWN_SIX, ownSix], [V_OWN_THREE, ownThree]] as const) {
      await save(ProjectVersionEntity, {
        id,
        projectId: own.id,
        version: project.version,
        status: 'published',
        manifest: { tagline: project.tagline, description: project.description, language: project.language, languages: project.languages },
        compiled: { slug: 'own', version: project.version, content: project, compiler: COMPILER_IDENTITY },
        publishedAt: new Date().toISOString(),
        publishedByUserId: teacher.id,
      } as never);
    }
    const door = new CohortProjectService(dataSource, content);
    const dana = { id: teacher.id, role: 'INSTRUCTOR' as const, cohort: cohort.id };

    // The class is on 1.0.0 and the learner starts it: six phases, pinned to 1.0.0.
    await door.assign(dana, cohort.id, { projectVersionId: V_OWN_SIX, reason: 'the class starts on my six-phase project' });
    const six = await service.enroll(pupil.id, 'own');
    expect(six.phases).toHaveLength(6);
    const before = await dataSource.manager.findOneByOrFail(EnrollmentEntity, { userId: pupil.id, projectSlug: 'own' });
    expect(before.projectVersionId).toBe(V_OWN_SIX);

    // The class door's assign moves only the assignment: the same project's three-phase 1.1.0 does not
    // take the learner, whose pin, states, count and places stay their own version's six.
    await door.assign(dana, cohort.id, { projectVersionId: V_OWN_THREE, reason: 'the class moves to the three-phase version' });
    const after = await dataSource.manager.findOneByOrFail(EnrollmentEntity, { id: before.id });
    expect(after.projectVersionId).toBe(V_OWN_SIX);
    expect(after.packVersion).toBe(before.packVersion);
    // starting the project again is the same enrolment, still on 1.0.0
    await service.enroll(pupil.id, 'own');
    expect(await dataSource.manager.countBy(EnrollmentEntity, { userId: pupil.id, projectSlug: 'own' })).toBe(1);
    expect((await dataSource.manager.findOneByOrFail(EnrollmentEntity, { id: before.id })).projectVersionId).toBe(V_OWN_SIX);
    const states = await phaseStates.find({ where: { enrollmentId: before.id }, order: { phaseOrder: 'ASC' } });
    expect(states.map((one) => [one.phaseKey, one.phaseOrder])).toEqual([
      ['requirements', 1], ['design', 2], ['implementation', 3], ['testing', 4], ['deployment', 5], ['maintenance', 6],
    ]);
    const again = await service.myEnrollment(pupil.id, 'own');
    expect(again?.phases.map((one) => one.key)).toEqual(['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance']);
    // Their place labels and their completion count read their own version's six.
    await open(states[1].id);
    const design = await service.phaseDetail(pupil.id, states[1].id, 'summary');
    expect([design.place, design.count]).toEqual([2, 6]);

    // A learner who starts now is given the class's 1.1.0, three phases.
    const fresh = await service.enroll(later.id, 'own');
    expect(fresh.phases.map((one) => one.key)).toEqual(['requirements', 'design', 'implementation']);
    expect((await dataSource.manager.findOneByOrFail(EnrollmentEntity, { userId: later.id, projectSlug: 'own' })).projectVersionId).toBe(V_OWN_THREE);
  });
});
