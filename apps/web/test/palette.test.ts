import { describe, expect, it } from 'vitest';
import type { EnrollmentView, ProjectMapData } from '@learnsdlc/shared';
import { PALETTE_GROUP_CAP, visibleGroups } from '../components/shell/Palette';
import { projectPalette } from '@/lib/palette';
import type { PaletteGroup } from '../components/shell/types';

/*
 * ⌘K searches everything, not only what it would have shown anyway. If the
 * sources handed over a list already sliced to twelve, then with TaskTrackr's
 * five-story backlog the criteria group would be US-1 and US-2 and nothing
 * else, and typing "overdue" (the example `lib/palette.ts`'s own doc comment
 * gives) or "US-4" would answer with nothing.
 */
const criteria = (n: number): PaletteGroup => ({
  label: 'Criteria',
  items: Array.from({ length: n }, (_, i) => ({
    label: i === n - 1 ? 'Overdue report' : `Add a task ${i}`,
    detail: i === n - 1 ? 'US-4, yours to write' : `US-1.${i}, Add a task`,
    hint: 'not yet',
    icon: 'requirements' as const,
    href: `/x/${i}`,
  })),
});

describe('the palette', () => {
  it('finds a row past the cap, which is what a search is for', () => {
    const groups = [criteria(26)];
    expect(visibleGroups(groups, '').flat).toHaveLength(PALETTE_GROUP_CAP);
    const found = visibleGroups(groups, 'overdue');
    expect(found.flat).toHaveLength(1);
    expect(found.flat[0].label).toBe('Overdue report');
    expect(visibleGroups(groups, 'US-4').flat).toHaveLength(1);
  });

  it('caps each group for the eye, after the query and not before', () => {
    const groups = [criteria(40)];
    // Every row matches, so the cap is the only thing bounding it.
    expect(visibleGroups(groups, 'a').flat.length).toBeLessThanOrEqual(PALETTE_GROUP_CAP);
    expect(visibleGroups(groups, 'a', 3).flat).toHaveLength(3);
  });

  it('drops a group the query empties, and searches label, detail and hint', () => {
    const groups: PaletteGroup[] = [
      criteria(2),
      { label: 'Tests', items: [{ label: 'test_overdue', detail: 'tests/x.py', hint: 'failing', icon: 'testing', href: '/t' }] },
    ];
    expect(visibleGroups(groups, 'failing').kept.map((g) => g.label)).toEqual(['Tests']);
    expect(visibleGroups(groups, 'tests/x.py').flat).toHaveLength(1);
    expect(visibleGroups(groups, 'nothing here').kept).toEqual([]);
  });
});

/**
 * What ⌘K finds beyond the phases and the verbs is the project map, and the
 * map is fetched rather than built here, so the palette takes one, and has
 * to be given the right one.
 */
describe('the project rows', () => {
  const enrollment = { id: 'e1', projectSlug: 'tasktrackr', phases: [] } as unknown as EnrollmentView;
  const map: ProjectMapData = {
    nodes: [
      { id: 'crit:US-4.1', phase: 'requirements', kind: 'criterion', label: 'The overdue report', sub: 'US-4', state: 'todo' },
      { id: 'crit:US-4.2', phase: 'requirements', kind: 'criterion', label: 'A task due today', sub: 'US-4', state: 'pass' },
      { id: 'fn:overdue', phase: 'implementation', kind: 'function', label: 'overdue()', file: 'api/repository/tasks.py', line: 12, state: 'pass' },
      { id: 'test:t1', phase: 'testing', kind: 'test', label: 'overdue_boundary', state: 'fail' },
      // The locked phases the map draws as one block each. FULL_MAP asks for
      // them because the map page wants them; the palette must never list one.
      { id: 'ph:maintenance', phase: 'maintenance', kind: 'placeholder', label: 'A change request', sub: 'Opens in phase 6', state: 'todo' },
    ],
    edges: [],
  };

  it('reads its rows off the map it is handed', () => {
    const groups = projectPalette(enrollment, map);
    expect(groups.map((g) => g.label)).toEqual(['Criteria', 'Code', 'Tests']);
    const criteria = groups.find((g) => g.label === 'Criteria')!;
    expect(criteria.items.map((i) => i.label)).toEqual(['The overdue report', 'A task due today']);
    // The outcome is on the right, which is what makes the list an answer.
    expect(criteria.items[1].hint).toBe('passing');
    expect(groups.find((g) => g.label === 'Tests')!.items[0].hint).toBe('failing');
  });

  it('never lists the placeholder a locked phase draws, whichever map it was handed', () => {
    const rows = projectPalette(enrollment, map).flatMap((g) => g.items.map((i) => i.label));
    expect(rows).not.toContain('A change request');
    // Which is what lets one fetched map serve both ⌘K and the map page.
    const withoutLocked: ProjectMapData = {
      nodes: map.nodes.filter((n) => n.kind !== 'placeholder'),
      edges: [],
    };
    expect(projectPalette(enrollment, withoutLocked)).toEqual(projectPalette(enrollment, map));
  });

  it('holds its phases and nothing else until the map has been asked for', () => {
    // The landing does not pay for ⌘K: the map is fetched when the palette is
    // opened (components/shell/Palette.tsx), and until then there is none.
    expect(projectPalette(enrollment, null)).toEqual([]);
    expect(projectPalette(null, map)).toEqual([]);
  });
});
