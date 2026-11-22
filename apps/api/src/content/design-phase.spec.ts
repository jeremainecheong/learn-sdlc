import { DESIGN_JSON, evaluateDesignFloor, serialiseDesign } from '@learnsdlc/shared';
import { ContentService } from './content.service';
import type { DesignChecks, PhaseContent } from './content.types';
import { DESIGN_ARTEFACT, DESIGN_RECORD } from '../../../../e2e/golden-records';
import { FACT_EXPECTS_ERROR, FACT_HIGH_FIRST } from '../../../web/components/workspace/panels/design/contradictions';

describe('TaskTrackr 4.0.0 Design', () => {
  let content: ContentService;
  let phase: PhaseContent;
  let checks: DesignChecks;
  beforeAll(() => {
    content = new ContentService();
    content.loadAll();
    phase = content.getPhase('tasktrackr', 'design');
    if (phase.checks.kind !== 'design') throw new Error('expected design checks');
    checks = phase.checks;
  });
  it('is three editable documents and no markdown', () => {
    expect(phase.files.map((f) => [f.path, f.editable])).toEqual([[DESIGN_JSON, true], ['shared/contract/api.json', true], ['shared/contract/screens.json', true]]);
    expect(phase.files.some((f) => f.path.endsWith('.md'))).toBe(false);
    expect(phase.intro.length).toBeLessThanOrEqual(2000);
    expect(`${phase.intro}\n${phase.taskPanel}`).not.toMatch(/^#|```|\|\s*-{3}|\.md\b/m);
  });
  it("keeps architecture.md's one exception in the Background, in plain words: the front end owns one rule", () => {
    expect(phase.intro).toContain('lib/overdue.ts holds the one rule the front end owns');
    expect(phase.intro).not.toContain('`');
    expect(phase.intro.split(/\n[ \t]*\n/)).toHaveLength(6);
  });
  it('lists US-2, US-3 and US-4 with the floor the spec gives', () => {
    expect(checks.stories.map((s) => s.id)).toEqual(['US-2', 'US-3', 'US-4']);
    expect(checks.contracts).toEqual({ api: true, screens: true });
    expect(checks.sequence).toBe(true);
    expect(checks.floor).toEqual({ minEntities: 3, minRelations: 2, minOperations: 3, operationShape: true, minDecisions: 1, decisionShape: true, traceEveryStory: true, minEndpoints: 3, requireErrorCatalogue: true, minScreens: 1, screenShape: true });
    expect(phase.rubric.criteria.map((c) => [c.key, c.weight])).toEqual([['traceability', 0.25], ['data_model', 0.25], ['api_contract', 0.25], ['screen_contract', 0.15], ['decision_justification', 0.1]]);
  });
  it("carries the wording the Review tab's contradiction rules read in the story lines", () => {
    const line = (id: string) => checks.stories.find((s) => s.id === id)!.line;
    // the Review tab's own patterns, imported: the ordering rule and the error rule
    expect(line('US-3')).toMatch(FACT_HIGH_FIRST);
    expect(line('US-2')).toMatch(FACT_EXPECTS_ERROR);
    expect(line('US-2')).toContain('task_not_found');
  });
  it('turns the starting point back, with its gaps named', () => {
    const files = content.executionFiles(phase, {});
    const failed = evaluateDesignFloor(files, checks).filter((r) => !r.passed).map((r) => r.id);
    // the folded 3.0.0 record has no sequence, so the switched-on sequence rule is one of the gaps
    expect(failed).toEqual(expect.arrayContaining(['design.entities.min', 'design.relations.min', 'design.operations.shape', 'design.decisions.shape', 'design.trace', 'design.api.errors', 'design.screens.shape', 'design.sequence']));
  });
  it('passes the worked design on every line', () => {
    const files = content.executionFiles(phase, { ...DESIGN_ARTEFACT, [DESIGN_JSON]: serialiseDesign(DESIGN_RECORD) });
    expect(evaluateDesignFloor(files, checks).filter((r) => !r.passed)).toEqual([]);
  });
});
