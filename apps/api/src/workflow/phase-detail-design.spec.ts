import { phaseDetailDesign } from './phase-detail-design';
import { DEFAULT_DESIGN_FLOOR } from '@learnsdlc/shared';
describe('phaseDetailDesign', () => {
  it('is undefined for another kind', () => {
    expect(phaseDetailDesign({ kind: 'markdown', targets: ['x'], rules: [] } as never)).toBeUndefined();
  });
  it('copies the three switches, the stories and the floor of a design phase', () => {
    const checks = { kind: 'design' as const, record: 'design/design.json' as const, contracts: { api: true, screens: false }, sequence: true, stories: [{ id: 'US-4', title: 'Overdue', line: 'x' }], floor: DEFAULT_DESIGN_FLOOR };
    const out = phaseDetailDesign(checks)!;
    expect(out).toEqual({ contracts: { api: true, screens: false }, sequence: true, stories: [{ id: 'US-4', title: 'Overdue', line: 'x' }], floor: DEFAULT_DESIGN_FLOOR });
    expect(out.stories).not.toBe(checks.stories);
  });
});
