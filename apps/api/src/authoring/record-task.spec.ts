// The harness is design-task.spec.ts's: a TaskTrackr imported into an
// in-memory database, then copied by a teacher, whose draft is what
// `updateTask` and `replaceFile` edit. The pack imported is `recordPack()`
// (TaskTrackr with its Deployment and Maintenance in the record shape), so the
// copy's rows carry the runbook and the change request; `useRecordPack` would
// only swap the loader's in-memory map and leave the imported rows as they were.
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import {
  CHANGE_REQUEST_JSON,
  DEPLOYMENT_UPLOAD_ONLY,
  EMPTY_CHANGE_REQUEST,
  EMPTY_RUNBOOK,
  NO_CHANGE_CRITERION,
  NO_RUNBOOK_CRITERION,
  ONLY_DEPLOYMENT_RUNBOOK,
  QUIZ_ONLY_ADD_REFUSAL,
  ONLY_MAINTENANCE_CHANGE,
  RUNBOOK_DRILL_START_NOT_EMPTY,
  RUNBOOK_JSON,
  STARTING_CHANGE_UNREADABLE,
  TICKET_WITH_CHANGE,
  inheritedTaskRefusal,
  lockedCriterionRefusal,
  serialiseChangeRequest,
  serialiseRunbook,
  ticketCoveredRefusal,
  validateChangeRequestRecord,
  type PhaseKey,
} from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { ProjectRegistryService } from '../content/project-registry.service';
import { ProjectEntity, ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import { RECORD_TICKET, recordPack } from '../../test/record-pack';
import { UpdateTaskDto } from './authoring.dto';
import { AuthoringService } from './authoring.service';
import { quizNeedsQuestionsRefusal } from './quiz-rows';
import { memoryDataSource } from '../../test/support/memory-db';

const teacher = { id: 'teacher-1', role: 'INSTRUCTOR' as const, cohort: 'default' };
const EMPTY_FLOOR = { minEnvironment: 0, minHealth: 0, minRollback: 0, minData: 0, requireIncident: false };
const CHANGE_FLOOR = { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true };

const world = {} as { dataSource: DataSource; service: AuthoringService; importer: ProjectImporterService; importedVersionId: string };
type At = { projectId: string; versionId: string };
let copies = 0;

/** A fresh teacher's copy of the imported record pack. */
async function copy(): Promise<At> {
  copies += 1;
  const slug = `record-edit-${copies}`;
  const made = await world.service.createProject(teacher, { title: slug, slug, fromVersionId: world.importedVersionId });
  return { projectId: made.project.id, versionId: made.draftVersionId };
}

/** A draft file row's bytes, read through the files door the builder reads a starting record with. */
async function startingText(at: At, phaseKey: PhaseKey, path: string): Promise<string> {
  const files = await world.service.listFiles(teacher, at.projectId, at.versionId);
  const row = files.find((one) => one.phaseKey === phaseKey && one.path === path);
  if (!row || row.content === null) throw new Error(`the draft mounts no readable ${path} in ${phaseKey}`);
  return row.content;
}

/**
 * A copy (so the draft mounts its starting runbook and change request rows)
 * whose source version mounts neither: a published version of a second
 * project, stored by hand from the imported version's snapshot with
 * `deployment/runbook.json` taken out of Deployment's files and
 * `maintenance/change-request.json` out of Maintenance's, and the draft's
 * `forkedFromVersionId` pointed at it.
 * Importing TaskTrackr's own 4.0.0 tree beside the record pack is refused
 * (both are slug `tasktrackr`, version 4.0.0, different bytes), and a copy of
 * a version without the record mounts no record row, so the reset would be
 * refused as an unmounted file before it read the source.
 */
async function copyOfOlderVersion(): Promise<At> {
  const at = await copy();
  const projects = world.dataSource.getRepository(ProjectEntity);
  const versions = world.dataSource.getRepository(ProjectVersionEntity);
  const imported = await versions.findOneByOrFail({ id: world.importedVersionId });
  const compiled = JSON.parse(JSON.stringify(imported.compiled)) as NonNullable<ProjectVersionEntity['compiled']>;
  const deployment = compiled.content.phases.find((one) => one.key === 'deployment')!;
  deployment.files = deployment.files.filter((one) => one.path !== RUNBOOK_JSON);
  const maintenance = compiled.content.phases.find((one) => one.key === 'maintenance')!;
  maintenance.files = maintenance.files.filter((one) => one.path !== CHANGE_REQUEST_JSON);
  let older = await projects.findOneBy({ slug: 'tasktrackr-older' });
  if (!older) older = await projects.save(projects.create({ slug: 'tasktrackr-older', title: 'TaskTrackr (older)', platformOwned: true, ownerUserId: null, isDefault: false, origin: 'seed' }));
  const source = await versions.save(versions.create({
    projectId: older.id, version: '3.9.0', status: 'published', manifest: imported.manifest, compiled,
    validation: null, contentDigest: null, sandboxBudget: null, forkedFromVersionId: null, publishedAt: new Date().toISOString(), publishedByUserId: null, notes: null,
  }));
  await versions.update({ id: at.versionId }, { forkedFromVersionId: source.id });
  return at;
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  world.dataSource = await memoryDataSource();
  const content = new ContentService();
  const importer = new ProjectImporterService(content, world.dataSource);
  const registry = new ProjectRegistryService(content, world.dataSource, {
    importedContent: [],
  } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
  const imported = await importer.importPack(recordPack(), { origin: 'seed', platformOwned: true });
  await world.dataSource.getRepository(ProjectEntity).update({ id: imported.projectId }, { isDefault: true });
  await registry.load();
  world.service = new AuthoringService(world.dataSource, importer, registry);
  world.importer = importer;
  world.importedVersionId = imported.projectVersionId;
});

afterAll(async () => {
  if (world.dataSource?.isInitialized) await world.dataSource.destroy();
});

describe('the runbook arm', () => {
  it('saves the floor, the words, the rubric and the sign-off mark of Deployment\'s task', async () => {
    const at = await copy();
    const result = await world.service.updateTask(teacher, at.projectId, at.versionId, 'deployment', 'main', {
      title: 'Ship it', brief: 'Ship the two services.', objectives: ['Fill the runbook'],
      runbook: { floor: { minEnvironment: 3, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true } },
      rubric: { passThreshold: 70, criteria: [
        { key: 'config_completeness', title: 'Config', description: 'd', weight: 0.4 },
        { key: 'build_smoke', title: 'Smoke', description: 'd', weight: 0.3 },
        { key: 'runbook_quality', title: 'Runbook', description: 'd', weight: 0.2 },
        { key: 'operator_tone', title: 'Written for the operator', description: 'Every step names the command and what success prints.', weight: 0.1 },
      ] },
      signOff: true,
    });
    const task = result.phase.tasks.find((one) => one.taskKey === 'main')!;
    expect(task.runbook).toEqual({ record: RUNBOOK_JSON, floor: { minEnvironment: 3, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true }, drill: true });
    expect(task.rubric.criteria.map((c) => c.key)).toEqual(['config_completeness', 'build_smoke', 'runbook_quality', 'operator_tone']);
    expect(task.rubric.criteria[3]).toMatchObject({ title: 'Written for the operator', description: 'Every step names the command and what success prints.', weight: 0.1 });
    expect(task.signOff).toBe(true);
    expect(task.title).toBe('Ship it');
    expect(task.brief).toBe('Ship the two services.');
    expect(task.objectives).toEqual(['Fill the runbook']);
  });
  it.each([
    ['a run', { runs: [] }, DEPLOYMENT_UPLOAD_ONLY],
    ['a quiz', { quiz: {} }, DEPLOYMENT_UPLOAD_ONLY],
    ['a path the task owns', { owns: ['docker-compose.yml'] }, DEPLOYMENT_UPLOAD_ONLY],
    ['a rubric without build_smoke', { rubric: { passThreshold: 70, criteria: [{ key: 'config_completeness', title: 'c', description: 'd', weight: 0.5 }, { key: 'runbook_quality', title: 'r', description: 'd', weight: 0.5 }] } }, lockedCriterionRefusal('build_smoke', 'Isolated syntax and entrypoint selfcheck')],
    ['a rubric with no runbook criterion', { rubric: { passThreshold: 70, criteria: [{ key: 'config_completeness', title: 'c', description: 'd', weight: 0.5 }, { key: 'build_smoke', title: 'b', description: 'd', weight: 0.5 }] } }, NO_RUNBOOK_CRITERION],
    ['a rubric whose weights miss 1', { rubric: { passThreshold: 70, criteria: [{ key: 'config_completeness', title: 'c', description: 'd', weight: 0.5 }, { key: 'build_smoke', title: 'b', description: 'd', weight: 0.2 }, { key: 'runbook_quality', title: 'r', description: 'd', weight: 0.2 }] } }, 'Weights must sum to 1.'],
    ['a floor out of range', { runbook: { floor: { ...EMPTY_FLOOR, minHealth: 99 } } }, 'runbook.floor.minHealth must be between'],
  ])('refuses %s', async (_name, body, message) => {
    const at = await copy();
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'deployment', 'main', body as never)).rejects.toThrow(message);
  });
  it('refuses a runbook on another phase', async () => {
    const at = await copy();
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'testing', 'main', { runbook: { floor: EMPTY_FLOOR } } as never)).rejects.toThrow(ONLY_DEPLOYMENT_RUNBOOK);
  });
  it('keeps the task required: the required door still refuses a config task', async () => {
    const at = await copy();
    const title = (await world.service.readDraft(teacher, at.projectId, at.versionId)).phases.find((p) => p.key === 'deployment')!.tasks.find((one) => one.taskKey === 'main')!.title;
    await expect(world.service.setTaskRequired(teacher, at.projectId, at.versionId, 'deployment', 'main', { required: false })).rejects.toThrow(inheritedTaskRefusal(title));
  });
  it('hands the builder the file rules with their targets, the smoke run and the drill', async () => {
    const at = await copy();
    const view = await world.service.readDraft(teacher, at.projectId, at.versionId);
    const task = view.phases.find((p) => p.key === 'deployment')!.tasks.find((one) => one.taskKey === 'main')!;
    expect('rules' in task).toBe(false);
    expect(task.config!.fileRules).toHaveLength(10);
    expect(task.config!.fileRules.every((rule) => rule.target.length > 0 && rule.criterion === 'config_completeness')).toBe(true);
    expect(task.config!.smoke).toMatchObject({ dockerfile: 'api/Dockerfile', commands: [['python3', 'api/main.py', '--selfcheck']] });
    expect(task.config!.drill).toMatchObject({ fault: 'web-points-at-localhost', faultedFiles: ['docker-compose.yml'] });
    // the drill's faulted files by path only: their bytes are the sealed drill's, never the view's
    expect(Object.keys(task.config!.drill!).sort()).toEqual(['description', 'fault', 'faultedFiles']);
  });
  it('lets the runbook, ticket and change bodies through the whitelist, and holds their caps there too', async () => {
    const strict = { whitelist: true, forbidNonWhitelisted: true };
    const good = { runbook: { floor: EMPTY_FLOOR }, ticket: RECORD_TICKET, change: { contract: true, floor: CHANGE_FLOOR } };
    expect(await validate(plainToInstance(UpdateTaskDto, good), strict)).toEqual([]);
    const bad = plainToInstance(UpdateTaskDto, { runbook: { floor: { ...EMPTY_FLOOR, minData: 99 } }, change: { contract: 'yes', floor: CHANGE_FLOOR } });
    expect((await validate(bad, strict)).map((e) => e.property)).toEqual(['runbook', 'change']);
  });
});

describe('the executable arm of Maintenance', () => {
  it('saves the ticket, the change switch and floor, and the rubric', async () => {
    const at = await copy();
    const ticket = { id: 'CHG-7', title: 'Badges', summary: 'Show badges.', acceptance: [{ id: 'AC-1', line: 'A badge shows.' }] };
    const result = await world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', {
      ticket, change: { contract: false, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true } },
      rubric: { passThreshold: 70, criteria: [
        { key: 'correctness_hidden', title: 'h', description: 'd', weight: 0.4 }, { key: 'visible_tests', title: 'v', description: 'd', weight: 0.15 },
        { key: 'code_quality', title: 'q', description: 'd', weight: 0.15 }, { key: 'process', title: 'p', description: 'd', weight: 0.15 },
        { key: 'change_request', title: 'The change, recorded', description: 'Every acceptance line is traced to a test.', weight: 0.15 },
      ] },
    });
    const task = result.phase.tasks.find((one) => one.taskKey === 'main')!;
    expect(task.change).toEqual({ ticket, contract: false, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true } });
    expect(task.rubric.criteria.find((c) => c.key === 'change_request')).toMatchObject({ title: 'The change, recorded', description: 'Every acceptance line is traced to a test.', weight: 0.15 });
  });
  it('refuses a ticket on another phase, and a rubric without a change criterion', async () => {
    const at = await copy();
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'implementation', 'main', { ticket: { id: 'X', title: 't', summary: '', acceptance: [] } } as never)).rejects.toThrow(ONLY_MAINTENANCE_CHANGE);
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { rubric: { passThreshold: 70, criteria: [
      { key: 'correctness_hidden', title: 'h', description: 'd', weight: 0.55 }, { key: 'visible_tests', title: 'v', description: 'd', weight: 0.15 },
      { key: 'code_quality', title: 'q', description: 'd', weight: 0.15 }, { key: 'process', title: 'p', description: 'd', weight: 0.15 },
    ] } })).rejects.toThrow(NO_CHANGE_CRITERION);
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { rubric: { passThreshold: 70, criteria: [
      { key: 'correctness_hidden', title: 'h', description: 'd', weight: 0.55 }, { key: 'visible_tests', title: 'v', description: 'd', weight: 0.15 },
      { key: 'code_quality', title: 'q', description: 'd', weight: 0.15 }, { key: 'change_request', title: 'c', description: 'd', weight: 0.15 },
    ] } })).rejects.toThrow(lockedCriterionRefusal('process'));
  });
  it('refuses a ticket edit that drops an acceptance id the starting record covers', async () => {
    const at = await copy();
    const covering = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, tests: [{ id: 'T1', suite: 's', covers: ['AC-2'], result: 'not-run' }] });
    await world.service.replaceFile(teacher, at.projectId, at.versionId, 'maintenance', { path: CHANGE_REQUEST_JSON, content: covering });
    const dropped = { id: 'CR-2', title: 't', summary: 's', acceptance: [{ id: 'AC-1', line: 'one' }] };
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { ticket: dropped })).rejects.toThrow(ticketCoveredRefusal('AC-2'));
  });
  it('switching the contract off deletes the starting record\'s amendments', async () => {
    const at = await copy();
    const amended = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, contract: [{ id: 'C1', method: 'GET', path: '/x', change: 'added', why: 'w' }] });
    await world.service.replaceFile(teacher, at.projectId, at.versionId, 'maintenance', { path: CHANGE_REQUEST_JSON, content: amended });
    // a rubric-only save never rewrites the starting record: its bytes stay exactly as stored
    const before = await startingText(at, 'maintenance', CHANGE_REQUEST_JSON);
    expect(JSON.parse(before).contract).toHaveLength(1);
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { rubric: { passThreshold: 70, criteria: [
      { key: 'correctness_hidden', title: 'h', description: 'd', weight: 0.4 }, { key: 'visible_tests', title: 'v', description: 'd', weight: 0.15 },
      { key: 'code_quality', title: 'q', description: 'd', weight: 0.15 }, { key: 'process', title: 'p', description: 'd', weight: 0.15 },
      { key: 'change_request', title: 'c', description: 'd', weight: 0.15 },
    ] } });
    expect(await startingText(at, 'maintenance', CHANGE_REQUEST_JSON)).toBe(before);
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { change: { contract: false, floor: { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true } } });
    expect(JSON.parse(await startingText(at, 'maintenance', CHANGE_REQUEST_JSON)).contract).toEqual([]);
  });
  it('stores a starting change request sent while the contract is off with no amendments', async () => {
    const at = await copy();
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { change: { contract: false, floor: { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true } } });
    const amended = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, contract: [{ id: 'C1', method: 'GET', path: '/x', change: 'added', why: 'w' }] });
    await world.service.replaceFile(teacher, at.projectId, at.versionId, 'maintenance', { path: CHANGE_REQUEST_JSON, content: amended });
    expect(validateChangeRequestRecord(await startingText(at, 'maintenance', CHANGE_REQUEST_JSON), null).change!.contract).toEqual([]);
  });
  // A starting change request that does not parse never skips the covered-id guard or the contract-off rewrite
  /** A copy whose starting change request is `{not json`, written through the importer's starting-record door. */
  const unreadableStart = async (): Promise<At> => {
    const at = await copy();
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: at.versionId, key: 'maintenance' });
    const row = await world.dataSource.getRepository(ProjectFileEntity).findOneByOrFail({ projectVersionId: at.versionId, ownerKind: 'phase', ownerId: phase.id, path: CHANGE_REQUEST_JSON });
    await world.dataSource.transaction((manager) => world.importer.replaceFileBytes(manager, [row.id], '{not json', { startingRecord: true }));
    expect(await startingText(at, 'maintenance', CHANGE_REQUEST_JSON)).toBe('{not json');
    return at;
  };
  it('refuses a ticket save over an unreadable starting change request, in the fixed sentence', async () => {
    const at = await unreadableStart();
    const ticket = { id: 'CR-9', title: 't', summary: 's', acceptance: [{ id: 'AC-1', line: 'one' }] };
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { ticket })).rejects.toThrow(STARTING_CHANGE_UNREADABLE);
    expect(await startingText(at, 'maintenance', CHANGE_REQUEST_JSON)).toBe('{not json');
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: at.versionId, key: 'maintenance' });
    const task = await world.dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: phase.id, taskKey: 'main' });
    expect((task.checks as { ticket?: { id: string } }).ticket?.id).not.toBe('CR-9');
  });
  it('refuses a contract-off save over an unreadable starting change request, in the fixed sentence', async () => {
    const at = await unreadableStart();
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { change: { contract: false, floor: CHANGE_FLOOR } })).rejects.toThrow(STARTING_CHANGE_UNREADABLE);
    expect(await startingText(at, 'maintenance', CHANGE_REQUEST_JSON)).toBe('{not json');
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: at.versionId, key: 'maintenance' });
    expect(((await world.dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: phase.id, taskKey: 'main' })).checks as { change?: { contract: boolean } }).change?.contract).toBe(true);
  });
  it('still takes a rubric-only save over an unreadable starting change request, which changes neither the ticket nor the record', async () => {
    const at = await unreadableStart();
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { rubric: { passThreshold: 70, criteria: [
      { key: 'correctness_hidden', title: 'h', description: 'd', weight: 0.4 }, { key: 'visible_tests', title: 'v', description: 'd', weight: 0.15 },
      { key: 'code_quality', title: 'q', description: 'd', weight: 0.15 }, { key: 'process', title: 'p', description: 'd', weight: 0.15 },
      { key: 'change_request', title: 'c', description: 'd', weight: 0.15 },
    ] } });
    expect(await startingText(at, 'maintenance', CHANGE_REQUEST_JSON)).toBe('{not json');
  });
  it('refuses the change request record as a path the task owns', async () => {
    const at = await copy();
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { owns: [CHANGE_REQUEST_JSON] } as never))
      .rejects.toThrow('maintenance/change-request.json is the change request record, never an editable target.');
  });
  it('refuses a ticket and a change request that do not travel together the first time', async () => {
    const at = await copy();
    // a task carrying a change request but no ticket (stored by hand): a change save alone is refused
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: at.versionId, key: 'maintenance' });
    const row = await world.dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: phase.id, taskKey: 'main' });
    const { ticket: _ticket, ...bare } = row.checks as unknown as Record<string, unknown>;
    await world.dataSource.getRepository(ProjectTaskEntity).update({ id: row.id }, { checks: bare as never });
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { change: { contract: true, floor: CHANGE_FLOOR } })).rejects.toThrow(TICKET_WITH_CHANGE);
  });
});

describe('a task without a record keeps the doors it had', () => {
  /** The copy's task with its record stripped by hand: the shape TaskTrackr 4.0.0 copies carry. */
  async function strip(at: At, phaseKey: PhaseKey, member: 'runbook' | 'change'): Promise<void> {
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: at.versionId, key: phaseKey });
    const row = await world.dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: phase.id, taskKey: 'main' });
    const { [member]: _gone, ticket: _ticket, ...bare } = row.checks as unknown as Record<string, unknown>;
    await world.dataSource.getRepository(ProjectTaskEntity).update({ id: row.id }, { checks: bare as never });
  }
  it('refuses a Deployment config task\'s words as an inherited task, takes its mark alone, shows it as older, and converts it at its first runbook save', async () => {
    const at = await copy();
    await strip(at, 'deployment', 'runbook');
    const title = (await world.service.readDraft(teacher, at.projectId, at.versionId)).phases.find((p) => p.key === 'deployment')!.tasks.find((one) => one.taskKey === 'main')!.title;
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'deployment', 'main', { title: 'Ship it' })).rejects.toThrow(inheritedTaskRefusal(title));
    const marked = await world.service.updateTask(teacher, at.projectId, at.versionId, 'deployment', 'main', { signOff: true });
    const task = marked.phase.tasks.find((one) => one.taskKey === 'main')!;
    expect(task.signOff).toBe(true);
    // the view is what its first runbook save would convert it to, its Files-and-checks card included
    expect(task.recordOlderFormat).toBe(true);
    expect(task.config!.fileRules).toHaveLength(10);
    // and its starting record is the application's file again: the files door refuses it
    await expect(world.service.replaceFile(teacher, at.projectId, at.versionId, 'deployment', { path: RUNBOOK_JSON, content: serialiseRunbook(EMPTY_RUNBOOK) })).rejects.toThrow('so their files cannot be replaced here.');
    // a task that is merely older is converted by its first runbook save, never told only Deployment carries one
    await world.service.updateTask(teacher, at.projectId, at.versionId, 'deployment', 'main', { runbook: { floor: EMPTY_FLOOR } } as never);
    const converted = (await world.service.readDraft(teacher, at.projectId, at.versionId)).phases.find((p) => p.key === 'deployment')!.tasks.find((one) => one.taskKey === 'main')!;
    expect(converted.runbook!.floor).toEqual(EMPTY_FLOOR);
    expect(converted.recordOlderFormat).toBeUndefined();
  });
  it('converts a Maintenance code task without a change request at a rubric save, then holds the rubric to the locked keys, storing nothing when refused', async () => {
    const at = await copy();
    await strip(at, 'maintenance', 'change');
    const rubric = { passThreshold: 70, criteria: [{ key: 'correctness_hidden', title: 'h', description: 'd', weight: 1 }] };
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { rubric })).rejects.toThrow(lockedCriterionRefusal('visible_tests'));
    const view = await world.service.readDraft(teacher, at.projectId, at.versionId);
    expect(view.phases.find((p) => p.key === 'maintenance')!.tasks.find((one) => one.taskKey === 'main')!.recordOlderFormat).toBe(true);
    // a member no conversion starts keeps the executable arm's sentence
    await expect(world.service.updateTask(teacher, at.projectId, at.versionId, 'maintenance', 'main', { criteria: [] } as never)).rejects.toThrow('is graded by running tests, not by rules');
  });
});

describe('replaceFile on the two record paths', () => {
  it('stores a starting runbook as validated and refuses a drill phase\'s non-empty incident', async () => {
    const at = await copy();
    await world.service.replaceFile(teacher, at.projectId, at.versionId, 'deployment', { path: RUNBOOK_JSON, content: JSON.stringify({ ...EMPTY_RUNBOOK, extra: 1 }) });
    expect(await startingText(at, 'deployment', RUNBOOK_JSON)).toBe(serialiseRunbook(EMPTY_RUNBOOK));
    const noisy = serialiseRunbook({ ...EMPTY_RUNBOOK, incident: { rootCause: 'x', fix: '', actionItem: '' } });
    await expect(world.service.replaceFile(teacher, at.projectId, at.versionId, 'deployment', { path: RUNBOOK_JSON, content: noisy })).rejects.toThrow(RUNBOOK_DRILL_START_NOT_EMPTY);
  });
  it('refuses a malformed starting record, and a starting change request naming an acceptance id the ticket lacks', async () => {
    const at = await copy();
    await expect(world.service.replaceFile(teacher, at.projectId, at.versionId, 'deployment', { path: RUNBOOK_JSON, content: '{"environment": 1}' })).rejects.toThrow('The starting runbook is not valid');
    const stray = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, tests: [{ id: 'T1', suite: 's', covers: ['AC-9'], result: 'not-run' }] });
    await expect(world.service.replaceFile(teacher, at.projectId, at.versionId, 'maintenance', { path: CHANGE_REQUEST_JSON, content: stray })).rejects.toThrow('The starting change request is not valid');
  });
  it('compiles an edited starting runbook and change request into the draft\'s snapshot, which is what publish compiles', async () => {
    const at = await copy();
    const runbook = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'Where web sends /api.', kind: 'config' }] });
    const change = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, tests: [{ id: 'T1', suite: 's', covers: ['AC-1'], result: 'not-run' }] });
    await world.service.replaceFile(teacher, at.projectId, at.versionId, 'deployment', { path: RUNBOOK_JSON, content: runbook });
    // the second save loads the draft again, so the runbook below is the one a reload compiles
    await world.service.replaceFile(teacher, at.projectId, at.versionId, 'maintenance', { path: CHANGE_REQUEST_JSON, content: change });
    const compiled = (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: at.versionId })).compiled!.content;
    const bytesAt = (phaseKey: PhaseKey, path: string) => compiled.phases.find((p) => p.key === phaseKey)!.files.find((f) => f.path === path)!.content;
    expect(bytesAt('deployment', RUNBOOK_JSON)).toBe(runbook);
    expect(bytesAt('maintenance', CHANGE_REQUEST_JSON)).toBe(change);
  });
  it('resets to the source version, and says so when the source has no starting record', async () => {
    const at = await copy();
    const pack = new ContentService().loadProject(recordPack());
    const sourceOf = (phaseKey: PhaseKey, path: string) => pack.phases.find((p) => p.key === phaseKey)!.files.find((f) => f.path === path)!.content;
    // a starting runbook that differs from the source's (one entry, the incident empty as a drill phase needs), then reset
    const variant = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'Where web sends /api.', kind: 'config' }] });
    await world.service.replaceFile(teacher, at.projectId, at.versionId, 'deployment', { path: RUNBOOK_JSON, content: variant });
    expect(await startingText(at, 'deployment', RUNBOOK_JSON)).toBe(variant);
    await world.service.replaceFile(teacher, at.projectId, at.versionId, 'deployment', { path: RUNBOOK_JSON, reset: 'source' });
    expect(await startingText(at, 'deployment', RUNBOOK_JSON)).toBe(sourceOf('deployment', RUNBOOK_JSON));
    // the change request's twin: a starting record that differs from the source's, then reset
    const changed = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, tests: [{ id: 'T1', suite: 's', covers: ['AC-1'], result: 'not-run' }] });
    await world.service.replaceFile(teacher, at.projectId, at.versionId, 'maintenance', { path: CHANGE_REQUEST_JSON, content: changed });
    expect(await startingText(at, 'maintenance', CHANGE_REQUEST_JSON)).toBe(changed);
    await world.service.replaceFile(teacher, at.projectId, at.versionId, 'maintenance', { path: CHANGE_REQUEST_JSON, reset: 'source' });
    expect(await startingText(at, 'maintenance', CHANGE_REQUEST_JSON)).toBe(sourceOf('maintenance', CHANGE_REQUEST_JSON));
    const older = await copyOfOlderVersion();   // a draft whose source version (stored by hand) mounts neither starting record
    await expect(world.service.replaceFile(teacher, older.projectId, older.versionId, 'deployment', { path: RUNBOOK_JSON, reset: 'source' }))
      .rejects.toThrow('The version this draft came from has no starting runbook. Start empty, or edit this one.');
    await expect(world.service.replaceFile(teacher, older.projectId, older.versionId, 'maintenance', { path: CHANGE_REQUEST_JSON, reset: 'source' }))
      .rejects.toThrow('The version this draft came from has no starting change request. Start empty, or edit this one.');
  });
});

describe('addTask after the markdown kind', () => {
  it('refuses a non-quiz task on a phase that holds its own task, on Testing and on Requirements', async () => {
    const at = await copy();
    for (const phaseKey of ['testing', 'requirements'] as const) {
      await expect(world.service.addTask(teacher, at.projectId, at.versionId, phaseKey, { taskKey: 'extra', title: 'Extra', brief: 'b', artefactType: 'document' } as never))
        .rejects.toThrow(QUIZ_ONLY_ADD_REFUSAL);
    }
  });
  it('brings a removed Requirements story task back as a story task, and the draft compiles', async () => {
    const at = await copy();
    // the story task removed by hand: no door removes a phase's own task
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: at.versionId, key: 'requirements' });
    await world.dataSource.getRepository(ProjectTaskEntity).delete({ projectPhaseId: phase.id, taskKey: 'main' });
    await world.service.addTask(teacher, at.projectId, at.versionId, 'requirements', { taskKey: 'story', title: 'The story', brief: 'Write the story.', artefactType: 'user-story' });
    const task = (await world.service.readDraft(teacher, at.projectId, at.versionId)).phases.find((p) => p.key === 'requirements')!.tasks.find((t) => t.taskKey === 'story')!;
    expect(task.checkKind).toBe('story');
    expect((await world.service.validate(teacher, at.projectId, at.versionId)).blocking).toEqual([]);
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: at.versionId });
    expect(version.compiled!.content.phases.find((one) => one.key === 'requirements')!.checks.kind).toBe('story');
  });
  it('refuses a quiz without a paper and a code task where the removed story task comes back, and adds nothing', async () => {
    const at = await copy();
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: at.versionId, key: 'requirements' });
    await world.dataSource.getRepository(ProjectTaskEntity).delete({ projectPhaseId: phase.id, taskKey: 'main' });
    const held = await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: phase.id });
    await expect(world.service.addTask(teacher, at.projectId, at.versionId, 'requirements', { taskKey: 'story', title: 'The story', brief: 'Write the story.', artefactType: 'quiz' }))
      .rejects.toThrow(quizNeedsQuestionsRefusal());
    await expect(world.service.addTask(teacher, at.projectId, at.versionId, 'requirements', { taskKey: 'story', title: 'The story', brief: 'Write the story.', artefactType: 'code' }))
      .rejects.toThrow('A Requirements phase holds a story task, so its type is user-story; a code task cannot be added there.');
    await expect(world.service.addTask(teacher, at.projectId, at.versionId, 'requirements', { taskKey: 'story', title: 'The story', brief: 'Write the story.', artefactType: 'document' }))
      .rejects.toThrow('A Requirements phase holds a story task, so its type is user-story; a document task cannot be added there.');
    expect(await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: phase.id })).toEqual(held);
  });
});
