import { readFileSync } from 'fs';
import * as path from 'path';
import {
  CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, EMPTY_RUNBOOK, ONLY_DEPLOYMENT_RUNBOOK, ONLY_MAINTENANCE_CHANGE, RUNBOOK_JSON, serialiseChangeRequest,
  serialiseRunbook, validateChangeRequestRecord, validateRunbookRecord,
  RUBRIC_CRITERIA_MAX, RUBRIC_CRITERION_DESCRIPTION_MAX, RUBRIC_CRITERION_KEY_MAX, RUBRIC_CRITERION_TITLE_MAX, rubricCapBreaches,
} from '@learnsdlc/shared';
import { executableDigestKey } from '../authoring/provenance';
import { RECORD_CHANGE_FLOOR, RECORD_RUNBOOK_FLOOR, RECORD_TICKET, recordPack } from '../../test/record-pack';
import { ContentService } from './content.service';
import { scoredKeysFor } from './rubric-scoring';
import { recordCriteriaOf, validateChangeChecks, validateRunbookChecks } from './checks-validation';
import { applicationDigest } from './reference-content';
import { gradedPathsOf, gradedUnitsOf } from './pack-compiler';
import type { CodeChecks, ConfigChecks, PhaseContent } from './content.types';

type PackEdit = NonNullable<Parameters<typeof recordPack>[0]>;
const load = (edit?: PackEdit) => new ContentService().loadProject(recordPack(edit));
const TASKTRACKR = path.join(__dirname, '../../../../content/tasktrackr');
/** A record as TaskTrackr ships it, from its phase folder's files/. */
const shipped = (folder: string, at: string): string => readFileSync(path.join(TASKTRACKR, 'phases', folder, 'files', at), 'utf-8');
/**
 * The folder layout mounts a file by where it sits: under files/ editable, under readonly/ locked,
 * at the learner's path, its language read from that path. `mount` puts `text` there in place of
 * any mount already at that path (TaskTrackr mounts both record paths itself); `unmount` takes a
 * mount out of the phase.
 */
const unmount = (folder: string, at: string) => (name: string) => name === `phases/${folder}/files/${at}` || name === `phases/${folder}/readonly/${at}`;
const mount = (folder: string, at: string, text: string, editable: boolean): Pick<PackEdit, 'extra' | 'drop'> => ({
  extra: { [`phases/${folder}/${editable ? 'files' : 'readonly'}/${at}`]: text },
  drop: unmount(folder, at),
});
const RUNBOOK_WITH_INCIDENT = serialiseRunbook({ ...EMPTY_RUNBOOK, incident: { rootCause: 'x', fix: '', actionItem: '' } });
const CHANGE_WITH_STRAY = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, tests: [{ id: 'T1', suite: 's', covers: ['AC-9'], result: 'not-run' }] });
const phase = (key: string, edit?: PackEdit): PhaseContent => load(edit).phases.find((p) => p.key === key)!;

describe('a Deployment with a runbook', () => {
  it('carries the floor, mounts the record editable and valid, mounts no markdown and grades the record as a unit', () => {
    const deployment = phase('deployment');
    const checks = deployment.checks as ConfigChecks;
    expect(checks.runbook).toEqual({ record: RUNBOOK_JSON, floor: RECORD_RUNBOOK_FLOOR });
    const record = deployment.files.find((f) => f.path === RUNBOOK_JSON)!;
    expect(record).toMatchObject({ editable: true, language: 'json' });
    expect(validateRunbookRecord(record.content).error).toBeNull();
    expect(deployment.files.some((f) => f.path.endsWith('.md'))).toBe(false);
    expect(gradedUnitsOf(deployment).at(-1)).toEqual({ kind: 'record', id: RUNBOOK_JSON });
    expect(gradedPathsOf(checks)).toContain(RUNBOOK_JSON);
    expect(recordCriteriaOf(checks, deployment.rubric)).toEqual(['runbook_quality']);
    expect([...scoredKeysFor(checks, deployment.rubric)].sort()).toEqual(['build_smoke', 'config_completeness', 'runbook_quality']);
  });
  it('seeds the empty record when the pack mounts none', () => {
    const unmounted = phase('deployment', { drop: unmount('05-deployment', RUNBOOK_JSON) });
    expect(unmounted.files.find((f) => f.path === RUNBOOK_JSON)).toMatchObject({ editable: true, language: 'json', content: serialiseRunbook(EMPTY_RUNBOOK) });
  });
  it('defaults the incident toggle to the drill', () => {
    expect(validateRunbookChecks({}, 'deployment', true).floor.requireIncident).toBe(true);
    expect(validateRunbookChecks({}, 'deployment', false).floor).toEqual({ minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: false });
  });
  it.each([
    ['on another phase', () => validateRunbookChecks({}, 'testing', false), 'Only Deployment carries a runbook.'],
    ['at another path', () => validateRunbookChecks({ record: 'RUNBOOK.json' }, 'deployment', false), 'The runbook lives at deployment/runbook.json.'],
    ['with a minimum past the cap', () => validateRunbookChecks({ floor: { minHealth: 21 } }, 'deployment', false), 'runbook.floor.minHealth must be between 0 and 20'],
    ['with a toggle that is not a flag', () => validateRunbookChecks({ floor: { requireIncident: 'yes' } }, 'deployment', false), 'runbook.floor.requireIncident must be true or false'],
  ])('refuses a runbook %s', (_name, act, message) => {
    expect(act).toThrow(message);
  });
  it.each<[string, PackEdit, string]>([
    ['a file rule with no target', { deployment: (s: any) => { delete s.checks.rules[0].target; } }, 'A file rule names the file it reads.'],
    // the folder layout holds a rule to a file the phase mounts, so the markdown target is mounted read-only
    ['a file rule on markdown', { deployment: (s: any) => { s.checks.rules[0].target = 'notes.md'; }, ...mount('05-deployment', 'notes.md', '# notes\n', false) }, 'A file rule cannot target a markdown file. The runbook is a record of its own.'],
    ['a markdown mount', mount('05-deployment', 'docs/ops.md', '# ops\n', false), 'A Deployment phase mounts no markdown file: docs/ops.md.'],
    ['a brief in a file', { deployment: (s: any) => { s.taskFile = 'task.md'; } }, 'Deployment keeps its brief in taskPanel, not in a file.'],
    ['a starting incident in a drill phase', mount('05-deployment', RUNBOOK_JSON, RUNBOOK_WITH_INCIDENT, true), 'A starting runbook in a phase with a drill has an empty incident: the drill writes it.'],
    ['no runbook criterion', { deployment: (s: any) => { s.rubric.criteria = s.rubric.criteria.filter((c: { key: string }) => c.key !== 'runbook_quality').map((c: { key: string; weight: number }) => ({ ...c, weight: c.key === 'build_smoke' ? 0.6 : 0.4 })); } }, 'a Deployment with a runbook needs at least one runbook criterion'],
    ['a ticket on the config Deployment', { deployment: (s: any) => { s.checks.ticket = RECORD_TICKET; } }, ONLY_MAINTENANCE_CHANGE],
    ['a read-only record', mount('05-deployment', RUNBOOK_JSON, shipped('05-deployment', RUNBOOK_JSON), false), 'deployment/runbook.json must be editable: the learner writes it.'],
  ])('refuses %s', (_name, edit, message) => {
    expect(() => load(edit)).toThrow(message);
  });
});

describe('a Maintenance with a ticket and a change request', () => {
  it('carries the ticket and the floor, mounts a valid record, keeps the record out of editableTargets', () => {
    const maintenance = phase('maintenance');
    const checks = maintenance.checks as CodeChecks;
    expect(checks.ticket).toEqual(RECORD_TICKET);
    expect(checks.change).toEqual({ record: CHANGE_REQUEST_JSON, contract: true, floor: RECORD_CHANGE_FLOOR });
    const record = maintenance.files.find((f) => f.path === CHANGE_REQUEST_JSON)!;
    expect(record).toMatchObject({ editable: true, language: 'json' });
    expect(validateChangeRequestRecord(record.content, RECORD_TICKET.acceptance.map((a) => a.id)).error).toBeNull();
    const unmounted = phase('maintenance', { drop: unmount('06-maintenance', CHANGE_REQUEST_JSON) });
    expect(unmounted.files.find((f) => f.path === CHANGE_REQUEST_JSON)?.content).toBe(serialiseChangeRequest(EMPTY_CHANGE_REQUEST));
    expect(checks.editableTargets).not.toContain(CHANGE_REQUEST_JSON);
    expect(gradedPathsOf(checks)).toEqual([...checks.editableTargets, CHANGE_REQUEST_JSON]);
    expect(gradedUnitsOf(maintenance).map((u) => `${u.kind}:${u.id}`)).toEqual(['run:api', 'run:web', `record:${CHANGE_REQUEST_JSON}`]);
    expect(recordCriteriaOf(checks, maintenance.rubric)).toEqual(['change_request']);
  });
  it.each([
    ['a change on another phase', () => validateChangeChecks({}, 'implementation'), 'Only Maintenance carries a ticket and a change request.'],
    ['a change at another path', () => validateChangeChecks({ record: 'CHANGELOG.json' }, 'maintenance'), 'The change request lives at maintenance/change-request.json.'],
    ['a contract switch that is not a flag', () => validateChangeChecks({ contract: 'on' }, 'maintenance'), 'change.contract must be true or false'],
  ])('refuses %s', (_name, act, message) => {
    expect(act).toThrow(message);
  });
  it.each<[string, PackEdit, string]>([
    ['a ticket without a change', { maintenance: (s: any) => { delete s.checks.change; } }, 'checks.ticket and checks.change go together'],
    ['a change without a ticket', { maintenance: (s: any) => { delete s.checks.ticket; } }, 'checks.ticket and checks.change go together'],
    ['a read-only record', mount('06-maintenance', CHANGE_REQUEST_JSON, shipped('06-maintenance', CHANGE_REQUEST_JSON), false), 'maintenance/change-request.json must be editable: the learner writes it.'],
    ['a starting record that covers an id the ticket lacks', mount('06-maintenance', CHANGE_REQUEST_JSON, CHANGE_WITH_STRAY, true), 'test T1 covers AC-9, which is not an acceptance item of the ticket'],
    ['no change criterion', { maintenance: (s: any) => { s.rubric.criteria = s.rubric.criteria.filter((c: { key: string }) => c.key !== 'change_request').map((c: { key: string; weight: number }) => ({ ...c, weight: c.key === 'correctness_hidden' ? 0.55 : c.weight })); } }, 'a Maintenance with a change request needs at least one change criterion'],
    ['a markdown mount', mount('06-maintenance', 'NOTES.md', 'x\n', true), 'A Maintenance phase mounts no markdown file: NOTES.md.'],
    ['the record as an editable target', { maintenance: (s: any) => { s.checks.editableTargets.push(CHANGE_REQUEST_JSON); } }, 'maintenance/change-request.json is the change request record, never an editable target.'],
    ['a runbook on the code Maintenance', { maintenance: (s: any) => { s.checks.runbook = { record: RUNBOOK_JSON }; } }, ONLY_DEPLOYMENT_RUNBOOK],
  ])('refuses %s', (_name, edit, message) => {
    expect(() => load(edit)).toThrow(message);
  });
});

describe('a ticket and a change request on Implementation', () => {
  it('is refused by name before the rest of the phase is read', () => {
    const ticketed = (s: any) => { s.checks.ticket = RECORD_TICKET; s.checks.change = { contract: true }; };
    expect(() => load({ implementation: ticketed })).toThrow(ONLY_MAINTENANCE_CHANGE);
    // the folder layout holds an editable target to a file under files/, so the record is mounted there
    const recordAsTarget = { implementation: (s: any) => { ticketed(s); s.checks.editableTargets.push(CHANGE_REQUEST_JSON); }, ...mount('03-implementation', CHANGE_REQUEST_JSON, serialiseChangeRequest(EMPTY_CHANGE_REQUEST), true) };
    expect(() => load(recordAsTarget)).toThrow(ONLY_MAINTENANCE_CHANGE);
  });
});

describe('provenance leaves the records out', () => {
  it('digests the checks without runbook, ticket and change, and the files without the record paths', () => {
    const deployment = phase('deployment');
    const bare = { ...deployment, checks: { ...(deployment.checks as ConfigChecks), runbook: undefined } };
    delete (bare.checks as Partial<ConfigChecks>).runbook;
    expect(executableDigestKey(deployment)).toBe(executableDigestKey(bare));
    const noRecord = { ...deployment, files: deployment.files.filter((f) => f.path !== RUNBOOK_JSON) };
    expect(applicationDigest(deployment)).toBe(applicationDigest(noRecord));
  });
  it('digests a Maintenance the same without its ticket and change, and the files without the record path', () => {
    const maintenance = phase('maintenance');
    const bare = { ...maintenance, checks: { ...(maintenance.checks as CodeChecks) } };
    delete (bare.checks as Partial<CodeChecks>).ticket;
    delete (bare.checks as Partial<CodeChecks>).change;
    expect(executableDigestKey(maintenance)).toBe(executableDigestKey(bare));
    const retold = { ...maintenance, checks: { ...(maintenance.checks as CodeChecks), ticket: { ...RECORD_TICKET, summary: 'reworded' } } };
    expect(executableDigestKey(maintenance)).toBe(executableDigestKey(retold));
    const noRecord = { ...maintenance, files: maintenance.files.filter((f) => f.path !== CHANGE_REQUEST_JSON) };
    expect(applicationDigest(maintenance)).toBe(applicationDigest(noRecord));
  });
});

describe('a phase without a record still loads', () => {
  /** Keeps only the `locked` rubric keys, reweighted to sum to 1: the record criteria go with the record. */
  const keepOnly = (s: any, locked: Set<string>) => {
    s.rubric.criteria = s.rubric.criteria.filter((c: { key: string }) => locked.has(c.key));
    const total = s.rubric.criteria.reduce((n: number, c: { weight: number }) => n + c.weight, 0);
    s.rubric.criteria = s.rubric.criteria.map((c: { weight: number }) => ({ ...c, weight: c.weight / total }));
  };
  // Written against the record pack with both records taken out, not against loadAll(), so it holds
  // whatever the shipped pack holds: loadProject keeps loading a phase without a record.
  it('loads a Deployment without a runbook and a Maintenance without a ticket or change: no record unit, no record arm', () => {
    const loaded = load({
      deployment: (s) => {
        delete s.checks.runbook;
        keepOnly(s, new Set([...s.checks.rules.map((r: { criterion: string }) => r.criterion), 'build_smoke']));
      },
      maintenance: (s) => {
        delete s.checks.ticket;
        delete s.checks.change;
        keepOnly(s, new Set(['correctness_hidden', 'visible_tests', 'code_quality', 'process']));
      },
    });
    const deployment = loaded.phases.find((p) => p.key === 'deployment')!;
    const maintenance = loaded.phases.find((p) => p.key === 'maintenance')!;
    expect((deployment.checks as ConfigChecks).runbook).toBeUndefined();
    expect(gradedUnitsOf(deployment).some((u) => u.kind === 'record')).toBe(false);
    expect((maintenance.checks as CodeChecks).ticket).toBeUndefined();
    expect((maintenance.checks as CodeChecks).change).toBeUndefined();
    expect(gradedUnitsOf(maintenance).some((u) => u.kind === 'record')).toBe(false);
    expect(recordCriteriaOf(deployment.checks, deployment.rubric)).toEqual([]);
  });
});

describe("the loader holds a pack's rubric to what the editor's Criteria step saves", () => {
  const breach = (change: (rubric: { passThreshold: number; criteria: { key: string; title: string; description?: string }[] }) => void) =>
    () => load({ deployment: (spec) => change(spec.rubric) });
  it('loads the record pack as it ships', () => {
    expect(() => load()).not.toThrow();
  });
  it.each([
    ['a title over the cap', (r: any) => { r.criteria[0].title = 't'.repeat(RUBRIC_CRITERION_TITLE_MAX + 1); }, `is ${RUBRIC_CRITERION_TITLE_MAX + 1} characters; the editor saves at most ${RUBRIC_CRITERION_TITLE_MAX}`],
    ['a description over the cap', (r: any) => { r.criteria[0].description = 'd'.repeat(RUBRIC_CRITERION_DESCRIPTION_MAX + 1); }, `the editor saves at most ${RUBRIC_CRITERION_DESCRIPTION_MAX}`],
    ['a pass mark that is not a whole number from 1 to 100', (r: any) => { r.passThreshold = 70.5; }, 'the editor saves a whole number from 1 to 100'],
  ])('refuses %s with the pack-loads sentence', (_name, change, sentence) => {
    expect(breach(change)).toThrow(sentence);
  });
  it('says the same sentence the content checker reports', () => {
    const rubric = { passThreshold: 70, criteria: [{ key: 'k'.repeat(RUBRIC_CRITERION_KEY_MAX + 1), title: 'T', description: 'd' }] };
    expect(rubricCapBreaches(rubric)).toEqual([`the rubric key "${rubric.criteria[0].key}" is ${RUBRIC_CRITERION_KEY_MAX + 1} characters; the editor saves at most ${RUBRIC_CRITERION_KEY_MAX}`]);
    const many = { passThreshold: 70, criteria: Array.from({ length: RUBRIC_CRITERIA_MAX + 1 }, (_, i) => ({ key: `k${i}`, title: 'T' })) };
    expect(rubricCapBreaches(many)).toEqual([`the rubric holds ${RUBRIC_CRITERIA_MAX + 1} criteria; the editor saves at most ${RUBRIC_CRITERIA_MAX}`]);
  });
});
