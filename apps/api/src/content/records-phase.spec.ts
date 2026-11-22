import * as path from 'path';
import { CHANGE_REQUEST_JSON, RUNBOOK_JSON, evaluateChangeFloor, evaluateRunbookFloor, serialiseRunbook, validateRunbookRecord } from '@learnsdlc/shared';
import { ContentService, requireRecords } from './content.service';
import type { CodeChecks, ConfigChecks } from './content.types';
import { layoutFromManifest } from './legacy-layout';
import { DirectoryPackSource } from './pack-source';
import { olderTaskTrackrPack } from '../../test/legacy-phase';
import { CHANGE_REQUEST_RECORD, RUNBOOK_RECORD } from '../../test/fixtures/records-worked';
import { UPLOAD_PACKS_DIR } from '../../test/fixtures/paths';

/** A brief with no markdown in it: no heading, list marker, table, code span or code block, and no markdown file name. */
const MARKDOWN = /^#|^\s*[-*+]\s|^\s*\d+\.\s|```|`|\|\s*-{3}|RUNBOOK\.md|CHANGELOG\.md/m;
const UPLOAD_PACKS = UPLOAD_PACKS_DIR;

describe('TaskTrackr 6.0.0 Deployment and Maintenance', () => {
  const content = new ContentService();
  content.loadAll();
  const deployment = content.getPhase('tasktrackr', 'deployment');
  const maintenance = content.getPhase('tasktrackr', 'maintenance');
  const runbook = (deployment.checks as ConfigChecks).runbook!;
  const change = maintenance.checks as CodeChecks;
  it('mounts no markdown and keeps its briefs inline with no markdown in them', () => {
    for (const phase of [deployment, maintenance]) {
      expect(phase.files.some((f) => f.path.endsWith('.md'))).toBe(false);
      expect(phase.taskPanel).not.toMatch(MARKDOWN);
    }
    expect(content.getProject('tasktrackr').version).toBe('6.0.0');
  });
  it('is a platform pack: the loader refuses a TaskTrackr whose Deployment carries no runbook', () => {
    // TaskTrackr 5.0.0's older Deployment, converted once to the folder layout the loader reads
    expect(() => requireRecords(new ContentService().loadProject(layoutFromManifest(olderTaskTrackrPack()).source))).toThrow('tasktrackr: A Deployment phase of the config kind carries checks.runbook.');
  });
  it('carries the spec\'s floors, ticket and rubric', () => {
    expect(runbook.floor).toEqual({ minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: true });
    expect((deployment.checks as ConfigChecks).rules).toHaveLength(10);
    expect(change.ticket!.acceptance.map((a) => a.id)).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7']);
    expect(change.change).toEqual({ record: CHANGE_REQUEST_JSON, contract: true, floor: { minImpact: 3, minContract: 2, minTests: 2, requireRelease: true, traceEveryAcceptance: true } });
    expect(maintenance.rubric.criteria.map((c) => [c.key, c.weight])).toEqual([['correctness_hidden', 0.4], ['visible_tests', 0.15], ['code_quality', 0.15], ['process', 0.15], ['change_request', 0.15]]);
  });
  it('turns its starting records back, and passes the worked ones with the drill\'s incident', () => {
    const files = content.executionFiles(deployment, {});
    expect(evaluateRunbookFloor(files[RUNBOOK_JSON], runbook.floor).filter((r) => !r.passed).map((r) => r.id)).toEqual(['runbook.environment.min', 'runbook.health.min', 'runbook.rollback.min', 'runbook.data.min', 'runbook.incident']);
    const worked = serialiseRunbook({ ...validateRunbookRecord(RUNBOOK_RECORD).runbook!, incident: { rootCause: 'API_URL named localhost', fix: 'http://api:8000', actionItem: 'Lint compose in CI' } });
    expect(evaluateRunbookFloor(worked, runbook.floor).every((r) => r.passed)).toBe(true);
    const spec = { contract: true, floor: change.change!.floor, ticket: change.ticket! };
    expect(evaluateChangeFloor(content.executionFiles(maintenance, {})[CHANGE_REQUEST_JSON], spec).some((r) => !r.passed)).toBe(true);
    expect(evaluateChangeFloor(CHANGE_REQUEST_RECORD, spec).every((r) => r.passed)).toBe(true);
  });
});

describe('the three upload packs\' Deployment and Maintenance', () => {
  it.each(['shelf', 'shelf-preview', 'starter'])('%s keeps both briefs inline as plain prose', (pack) => {
    const project = new ContentService().loadProject(new DirectoryPackSource(path.join(UPLOAD_PACKS, pack)));
    for (const key of ['deployment', 'maintenance']) {
      const phase = project.phases.find((p) => p.key === key)!;
      expect(phase.taskPanel).not.toMatch(MARKDOWN);
      expect(phase.files.some((f) => f.path.endsWith('.md'))).toBe(false);
    }
  });
  it('opens Shelf\'s change room on CHG-1, whose trace rule names the uncovered acceptance ids of the starting record', () => {
    const shelf = new ContentService().loadProject(new DirectoryPackSource(path.join(UPLOAD_PACKS, 'shelf')));
    const maintenance = shelf.phases.find((p) => p.key === 'maintenance')!;
    const checks = maintenance.checks as CodeChecks;
    expect(checks.ticket!.id).toBe('CHG-1');
    const trace = evaluateChangeFloor(maintenance.files.find((f) => f.path === CHANGE_REQUEST_JSON)!.content, { contract: checks.change!.contract, floor: checks.change!.floor, ticket: checks.ticket! })
      .find((r) => r.id === 'change.trace')!;
    expect(trace).toMatchObject({ passed: false, detail: 'Acceptance items not covered by any change line or test: AC-1, AC-2, AC-3' });
  });
});
