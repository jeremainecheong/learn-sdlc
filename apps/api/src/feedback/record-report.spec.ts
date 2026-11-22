import { CHANGE_REQUEST_JSON, EMPTY_RUNBOOK, RUNBOOK_FLOOR_IDS, RUNBOOK_JSON, serialiseChangeRequest, serialiseRunbook, type Runbook } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { soleTaskFor } from '../content/pack-compiler';
import { FIXED_WORKSPACE, fixedState, graderFor } from '../../test/verdict-golden';
import { olderTaskTrackrPack } from '../../test/legacy-phase';
import { layoutFromManifest } from '../content/legacy-layout';
import { RECORD_TICKET, recordPack } from '../../test/record-pack';
import { recordFloorScores } from './record-report';

const runbook: Runbook = {
  environment: [{ id: 'E1', name: 'TASKTRACKR_DB', purpose: 'Database path.', kind: 'config' }, { id: 'E2', name: 'API_URL', purpose: 'Where web sends /api.', kind: 'config' }],
  health: [{ id: 'H1', name: 'Selfcheck', how: 'python3 api/main.py --selfcheck', expected: 'selfcheck: web reaches api' }],
  rollback: [{ id: 'R1', step: 'Retag the previous images', verify: 'docker compose ps' }, { id: 'R2', step: 'docker compose up -d', verify: 'The selfcheck passes' }],
  data: [{ id: 'D1', what: 'The database file', how: 'sqlite3 .backup', where: 'tasktrackr-data' }],
  incident: { rootCause: 'API_URL named localhost', fix: 'http://api:8000', actionItem: 'Lint compose in CI' },
};

describe('recordFloorScores', () => {
  it('scores each record criterion by the share of floor rules that pass, with one evidence line each', () => {
    const out = recordFloorScores({ passThreshold: 70, criteria: [{ key: 'a', title: 'A', weight: 0.5, description: '' }, { key: 'b', title: 'B', weight: 0.5, description: '' }] }, ['b'], [
      { id: 'x', label: 'X', passed: true, detail: 'ok' }, { id: 'y', label: 'Y', passed: false, detail: 'no' },
    ]);
    expect([...out.scores]).toEqual([['b', 50]]);
    expect(out.evidence.get('b')).toEqual(['✓ X', '✗ Y: no']);
    expect(out.checks.map((c) => [c.id, c.status])).toEqual([['x', 'passed'], ['y', 'failed']]);
  });
});

describe('the graders with a record', () => {
  const content = new ContentService();
  content.loadAll();
  const project = content.loadProject(recordPack());
  const { service } = graderFor(content);
  const grade = async (key: string, order: number, extra: Record<string, string>) => {
    const phase = project.phases.find((p) => p.key === key)!;
    const task = soleTaskFor(phase);
    const state = { ...fixedState(phase, order), workspace: { ...(FIXED_WORKSPACE[key] ?? {}), ...extra } };
    return service.buildReport(phase, state as never, [task], task);
  };

  it('grades the runbook floor into runbook_quality beside the file rules and the smoke run', async () => {
    const report = await grade('deployment', 5, { [RUNBOOK_JSON]: serialiseRunbook(runbook) });
    expect(report.checks.filter((c) => c.id.startsWith('runbook.')).map((c) => c.id)).toEqual([...RUNBOOK_FLOOR_IDS]);
    expect(report.checks.filter((c) => c.id.startsWith('runbook.')).every((c) => c.status === 'passed')).toBe(true);
    expect(report.criteria.find((c) => c.key === 'runbook_quality')?.score).toBe(100);
    expect(report.checks.some((c) => c.id.startsWith('runbook-'))).toBe(false);
  });
  it('fails the runbook floor on the empty record', async () => {
    // the empty record sent explicitly, so the case holds when TaskTrackr 5.0.0 ships a starting runbook with named items
    const report = await grade('deployment', 5, { [RUNBOOK_JSON]: serialiseRunbook(EMPTY_RUNBOOK) });
    const failed = report.checks.filter((c) => c.id.startsWith('runbook.') && c.status === 'failed').map((c) => c.id);
    expect(failed).toEqual(['runbook.environment.min', 'runbook.health.min', 'runbook.rollback.min', 'runbook.data.min', 'runbook.incident']);
    expect(report.criteria.find((c) => c.key === 'runbook_quality')?.score).toBe(Math.round((100 * 2) / 7));
  });
  it('grades the change floor into change_request beside the four fixed keys', async () => {
    // T1 covers every acceptance id of the ticket, so the trace holds for CR-2's three lines and for a ticket of seven
    const every = RECORD_TICKET.acceptance.map((a) => a.id);
    const change = { impact: { operations: ['listComments', 'addComment'], screens: [], files: ['api/routes/comments.py'] }, contract: [{ id: 'C1', method: 'GET', path: '/api/tasks/{id}/comments', change: 'added' as const, why: 'reads' }, { id: 'C2', method: 'POST', path: '/api/tasks/{id}/comments', change: 'added' as const, why: 'adds' }], tests: [{ id: 'T1', suite: 'tests/test_comments_api.py', covers: every, result: 'pass' as const }, { id: 'T2', suite: 'TaskRow', covers: ['AC-3'], result: 'pass' as const }], release: { version: '2.1.0', summary: 'Comments', changes: [{ id: 'L1', line: 'Comments', covers: [] }], rollback: 'redeploy' } };
    const report = await grade('maintenance', 6, { [CHANGE_REQUEST_JSON]: serialiseChangeRequest(change) });
    expect(report.checks.filter((c) => c.id.startsWith('change.')).map((c) => [c.id, c.status])).toEqual([
      ['change.record', 'passed'], ['change.impact.min', 'passed'], ['change.contract.min', 'passed'], ['change.tests.min', 'passed'],
      ['change.release', 'passed'], ['change.trace', 'passed'], ['change.named', 'passed'],
    ]);
    expect(report.criteria.map((c) => c.key)).toEqual(['correctness_hidden', 'visible_tests', 'code_quality', 'process', 'change_request']);
    expect(report.criteria.find((c) => c.key === 'change_request')?.score).toBe(100);
  });
  describe("the drill's diagnosis, read through drillWithIncident over the learner's own workspace", () => {
    const deployment = project.phases.find((p) => p.key === 'deployment')!;
    const withIncident = (rootCause: string) => serialiseRunbook({ ...runbook, incident: { rootCause, fix: 'set it to http://api:8000', actionItem: 'Lint compose in CI' } });
    const stored = (rootCause: string) => ({ fault: 'web-points-at-localhost', pagedAt: 'p', runbookBefore: null, healthRanAt: null, healthExit: null, fixAppliedAt: null, resolvedAt: null, incident: { rootCause, fix: 'x', actionItem: 'y' } });
    /** The drill section `reportExtras` builds over the learner's workspace; its execution files always carry the seeded record. */
    const names = async (extra: Record<string, string>, drill: unknown, phase = deployment): Promise<boolean> => {
      const workspace = { ...(FIXED_WORKSPACE.deployment ?? {}), ...extra };
      const state = { ...fixedState(phase, 5), workspace, drill };
      const extras = await (service as any).reportExtras(phase, state, {}, { ok: true, stdout: '' }, soleTaskFor(phase));
      return extras.drill.diagnosisNamesFault;
    };

    it('names the fault from a saved record whose root cause names API_URL', async () => {
      expect(await names({ [RUNBOOK_JSON]: withIncident('API_URL named localhost') }, null)).toBe(true);
    });
    it('keeps an older drill\'s stored incident when the workspace holds no record', async () => {
      expect(await names({}, stored('API_URL named localhost'))).toBe(true);
    });
    it('names nothing with no record and no drill, though the execution files carry the seeded record', async () => {
      expect(await names({}, null)).toBe(false);
    });
    it('reads a vague saved record over a stored incident that names API_URL', async () => {
      expect(await names({ [RUNBOOK_JSON]: withIncident('the site was broken') }, stored('API_URL named localhost'))).toBe(false);
    });
    it('reads no incident on a Deployment without a runbook record, whatever the drill stored', async () => {
      const plain = new ContentService().loadProject(layoutFromManifest(olderTaskTrackrPack()).source).phases.find((p) => p.key === 'deployment')!;
      expect((plain.checks as { drill?: unknown }).drill).toBeDefined();
      expect(await names({}, stored('API_URL named localhost'), plain)).toBe(false);
    });
  });

  // TaskTrackr 4.0.0's Deployment, the frozen older shape (loadAll() reads 5.0.0, which carries the record).
  it('leaves a phase without a record unchanged', async () => {
    const plain = new ContentService().loadProject(layoutFromManifest(olderTaskTrackrPack()).source).phases.find((p) => p.key === 'deployment')!;
    const task = soleTaskFor(plain);
    const report = await service.buildReport(plain, fixedState(plain, 5) as never, [task], task);
    expect(report.checks.some((c) => c.id.startsWith('runbook.'))).toBe(false);
    expect(report.checks.some((c) => c.id === 'runbook-env')).toBe(true);
    expect(RECORD_TICKET.id).toBe('CR-2');
  });
});
