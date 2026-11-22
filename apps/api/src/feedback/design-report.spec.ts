import { buildDesignReport, designWorkspaceForReview } from './design-report';
import { DEFAULT_DESIGN_FLOOR, DESIGN_JSON, serialiseDesign, type DesignChecksSpec } from '@learnsdlc/shared';

const checks: DesignChecksSpec = { kind: 'design', record: DESIGN_JSON, contracts: { api: false, screens: false }, sequence: false, stories: [{ id: 'US-4', title: 'Overdue', line: 'x' }], floor: { ...DEFAULT_DESIGN_FLOOR, minEntities: 1, minRelations: 0, minOperations: 1, minDecisions: 0 } };
const rubric = { passThreshold: 70, criteria: [{ key: 'a', title: 'A', weight: 0.5, description: 'x' }, { key: 'b', title: 'B', weight: 0.5, description: 'y' }] };
const record = serialiseDesign({ entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: [], satisfies: ['US-4'] }], relations: [], operations: [{ id: 'O1', name: 'getOverdue', inputs: ['today'], returns: 'Task[]', errors: [], satisfies: ['US-4'] }], decisions: [], notes: 'n' });

describe('buildDesignReport', () => {
  it('scores 100 when the record and the floor pass, with one check per rule', () => {
    const p = buildDesignReport(rubric, checks, { [DESIGN_JSON]: record });
    expect(p.checks.map((c) => c.id)).toEqual(['design.record', 'design.entities.min', 'design.relations.min', 'design.operations.min', 'design.operations.shape', 'design.decisions.min', 'design.decisions.shape', 'design.trace']);
    expect(p.checks.every((c) => c.status === 'passed')).toBe(true);
    expect(p.criteria.map((c) => c.score)).toEqual([100, 100]);
  });
  it('fails the record and scores the rest against an empty record when it is missing', () => {
    const p = buildDesignReport(rubric, checks, {});
    expect(p.checks[0]).toMatchObject({ id: 'design.record', status: 'failed', detail: 'The design record is missing or not valid' });
    expect(p.overall).toBeLessThan(100);
  });
  it('adds the sequence rule last only when the sequence diagram is on, and passes it when the diagram names an operation', () => {
    const on = { ...checks, sequence: true };
    const missing = buildDesignReport(rubric, on, { [DESIGN_JSON]: record });
    expect(missing.checks.map((c) => c.id).at(-1)).toBe('design.sequence');
    expect(missing.checks.at(-1)).toMatchObject({ status: 'failed', detail: 'The sequence diagram is missing or names none of the operations' });
    expect(missing.criteria[0].score).toBe(Math.round((100 * 8) / 9));
    const named = serialiseDesign({ ...JSON.parse(record), sequence: 'Browser -> Api: getOverdue' });
    expect(buildDesignReport(rubric, on, { [DESIGN_JSON]: named }).checks.every((c) => c.status === 'passed')).toBe(true);
  });
});
describe('designWorkspaceForReview', () => {
  it('is the labelled projection, and holds no file path', () => {
    const w = designWorkspaceForReview(checks, { [DESIGN_JSON]: record });
    expect(w['design/operation-1/inputs']).toBe('today');
    expect(Object.keys(w)).not.toContain(DESIGN_JSON);
    expect(Object.keys(w)).not.toContain('design/sequence');
    expect(Object.keys(designWorkspaceForReview({ ...checks, sequence: true }, { [DESIGN_JSON]: record }))).toContain('design/sequence');
  });
});
