// Implementation's and Testing's Criteria step: the executable arm of
// `updateTask` takes the fixed criteria's sentences and weights for the code
// task of `implementation` and the tests task of `testing`, held to the
// locked-key rule, and refuses a criterion outside the grader's own set. The
// harness is `authoring.service.spec.ts`'s: the shipped TaskTrackr imported as
// the platform's published default into an in-memory database, and a
// teacher's copy of it, whose draft is what `updateTask` edits.
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { fixedCriteriaRefusal, lockedCriterionRefusal } from '@learnsdlc/shared';
import { copyTaskTrackr, openForkWorld, S1_TEACHER as teacher, type Fork, type ForkWorld } from '../../test/tasktrackr-phase';
import { UpdateTaskDto } from './authoring.dto';
import { ProjectPhaseEntity, ProjectTaskEntity } from '../content/project.entities';

type Over = Partial<Record<string, { title?: string; description?: string; weight?: number }>>;

/** Implementation's four fixed criteria, each with a sentence of its own. */
const implementationRubric = (over: Over = {}) => ({
  passThreshold: 70,
  criteria: ['correctness_hidden', 'visible_tests', 'code_quality', 'process'].map((key, at) => ({
    key, title: `Title ${at}`, description: `Sentence ${at}`, weight: [0.5, 0.2, 0.2, 0.1][at], ...over[key],
  })),
});

/** Testing's three fixed criteria. */
const testingRubric = (over: Over = {}) => ({
  passThreshold: 70,
  criteria: ['tests_pass', 'mutants_killed', 'coverage_mapping'].map((key, at) => ({
    key, title: `Title ${at}`, description: `Sentence ${at}`, weight: [0.3, 0.45, 0.25][at], ...over[key],
  })),
});

let world: ForkWorld;
let copies = 0;
const copy = (): Promise<Fork> => copyTaskTrackr(world, `executable-rubric-${(copies += 1)}`);

beforeAll(async () => {
  Logger.overrideLogger(false);
  world = await openForkWorld();
});
afterAll(async () => {
  await world?.close();
});

describe("Implementation's and Testing's fixed criteria", () => {
  it("saves Implementation's fixed criteria with new sentences and weights", async () => {
    const at = await copy();
    const result = await world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', {
      rubric: implementationRubric({ process: { title: 'How you worked', weight: 0.1 } }),
    });
    const task = result.phase.tasks.find((one) => one.taskKey === 'main')!;
    expect(task.rubric.criteria.map((c) => [c.key, c.title])).toContainEqual(['process', 'How you worked']);
    expect(task.rubric.criteria.map((c) => c.weight)).toEqual([0.5, 0.2, 0.2, 0.1]);
    expect(task.rubric.criteria[0]).toMatchObject({ title: 'Title 0', description: 'Sentence 0' });
  });

  it('refuses a criterion outside the fixed set, in the fixed sentence', async () => {
    const at = await copy();
    const rubric = implementationRubric({ correctness_hidden: { weight: 0.5 } });
    rubric.criteria.push({ key: 'naming', title: 'Naming', description: 'Names say what they hold.', weight: 0 });
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', { rubric })).rejects.toThrow(
      'Implementation is scored by its fixed criteria. Change their sentences and weights; a new criterion has nothing to score it.');
    expect(fixedCriteriaRefusal('Implementation')).toBe(
      'Implementation is scored by its fixed criteria. Change their sentences and weights; a new criterion has nothing to score it.');
  });

  it('refuses a rubric that drops a fixed key, naming it', async () => {
    const at = await copy();
    const rubric = implementationRubric({ code_quality: { weight: 0.3 } });
    rubric.criteria = rubric.criteria.filter((c) => c.key !== 'process');
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', { rubric })).rejects.toThrow(
      lockedCriterionRefusal('process'));
  });

  it('refuses weights that do not sum to 1 and a pass mark over 100', async () => {
    const at = await copy();
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', {
      rubric: implementationRubric({ process: { weight: 0.3 } }),
    })).rejects.toThrow('Weights must sum to 1.');
    // the pass mark's range is the outer wall's, the one every rubric save passes (`RubricDto`)
    const strict = { whitelist: true, forbidNonWhitelisted: true };
    expect(await validate(plainToInstance(UpdateTaskDto, { rubric: implementationRubric() }), strict)).toEqual([]);
    const over = plainToInstance(UpdateTaskDto, { rubric: { ...implementationRubric(), passThreshold: 101 } });
    expect((await validate(over, strict)).map((e) => e.property)).toEqual(['rubric']);
  });

  it("saves Testing's three fixed criteria, and refuses a fourth in Testing's sentence", async () => {
    const at = await copy();
    const result = await world.service.updateTask(teacher, at.projectId, at.versionId, 'testing', 'main', {
      rubric: testingRubric({ mutants_killed: { title: 'Bugs your tests catch', description: 'Each broken copy your suite fails on.' } }),
    });
    const task = result.phase.tasks.find((one) => one.taskKey === 'main')!;
    expect(task.rubric.criteria.map((c) => c.key)).toEqual(['tests_pass', 'mutants_killed', 'coverage_mapping']);
    expect(task.rubric.criteria[1]).toMatchObject({ title: 'Bugs your tests catch', description: 'Each broken copy your suite fails on.' });
    const fourth = testingRubric({ tests_pass: { weight: 0.2 } });
    fourth.criteria.push({ key: 'process', title: 'Process', description: 'You ran the tests.', weight: 0.1 });
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'testing', 'main', { rubric: fourth })).rejects.toThrow(
      'Testing is scored by its fixed criteria. Change their sentences and weights; a new criterion has nothing to score it.');
    const dropped = testingRubric({ tests_pass: { weight: 0.55 } });
    dropped.criteria = dropped.criteria.filter((c) => c.key !== 'coverage_mapping');
    // Named by the saved criterion's title, never the key.
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'testing', 'main', { rubric: dropped })).rejects.toThrow(
      lockedCriterionRefusal('coverage_mapping', task.rubric.criteria[2].title));
  });

  it("keeps a TaskTrackr copy on the reference's application after a Criteria edit, and moves it off after a brief edit", async () => {
    const at = await copy();
    for (const [key, rubric] of [['implementation', implementationRubric()], ['testing', testingRubric()]] as const) {
      const before = (await world.service.readDraft(teacher, at.projectId, at.versionId)).phases.find((one) => one.key === key)!;
      expect([key, before.provenance?.application]).not.toEqual([key, null]);
      const saved = await world.service.updateTask(teacher, at.projectId, at.versionId, key, 'main', { rubric });
      expect([key, saved.phase.provenance?.application ?? null]).not.toEqual([key, null]);
      const reread = (await world.service.readDraft(teacher, at.projectId, at.versionId)).phases.find((one) => one.key === key)!;
      expect([key, reread.provenance?.application ?? null]).not.toEqual([key, null]);
      await world.service.updateTask(teacher, at.projectId, at.versionId, key, 'main', { brief: 'A new brief.' });
      const after = (await world.service.readDraft(teacher, at.projectId, at.versionId)).phases.find((one) => one.key === key)!;
      expect([key, after.provenance?.application ?? null]).toEqual([key, null]);
    }
  });

  it("still refuses a written task's criteria wording on Implementation's code task", async () => {
    // Maintenance with a change request keeps its own rubric arm; the arm here is only
    // Implementation's code task and Testing's tests task, so a written-phase member stays refused.
    const at = await copy();
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', {
      criteria: [{ key: 'process', title: 'x', description: 'y' }],
    } as never)).rejects.toThrow('is graded by running tests, not by rules');
  });

  it('still refuses a rubric on any other executable task: a Testing task graded as code', async () => {
    // The arm is keyed on the phase and the kind together; Testing's sole task with a code task's checks (a task
    // graded another way than its phase, `authoring.service.spec.ts`) is neither arm's, so either fixed set is refused and the row is unchanged.
    const at = await copy();
    const phases = world.dataSource.getRepository(ProjectPhaseEntity);
    const tasks = world.dataSource.getRepository(ProjectTaskEntity);
    const testing = await phases.findOneByOrFail({ projectVersionId: at.versionId, key: 'testing' });
    const implementation = await phases.findOneByOrFail({ projectVersionId: at.versionId, key: 'implementation' });
    const code = await tasks.findOneByOrFail({ projectPhaseId: implementation.id, taskKey: 'main' });
    await tasks.update({ projectPhaseId: testing.id, taskKey: 'main' }, { checks: code.checks, artefactType: code.artefactType });
    const before = JSON.stringify(await tasks.findOneByOrFail({ projectPhaseId: testing.id, taskKey: 'main' }));
    for (const rubric of [implementationRubric(), testingRubric()]) {
      await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'testing', 'main', { rubric })).rejects.toThrow(
        'is graded by running tests, not by rules');
    }
    expect(JSON.stringify(await tasks.findOneByOrFail({ projectPhaseId: testing.id, taskKey: 'main' }))).toBe(before);
  });
});
