/**
 * At 1280 px the project map's Testing lane (about 214 to 218 px) has no room for its note "Tests and planted bugs"
 * beside its title and its count of 110. Where the full note does not fit, the lane draws the shorter "Tests and
 * bugs" where that fits, so it still says it holds planted bugs as well as tests; where the full note fits (1440 px),
 * it is drawn. No other lane is affected.
 *
 * The lanes are laid out from the finished learner's counts (Requirements 20, Design 10, Implementation 21, Testing 110,
 * Deployment 4, Maintenance 3). BEFORE is their layout recorded with the full note only; every lane but Testing at
 * 1280 px must still match it.
 */
import { describe, expect, it } from 'vitest';
import { layoutMap } from '@/components/map/layout';

const COUNTS: Record<string, number> = { requirements: 20, design: 10, implementation: 21, testing: 110, deployment: 4, maintenance: 3 };
const data = {
  nodes: Object.entries(COUNTS).flatMap(([phase, n]) => Array.from({ length: n }, (_, i) => ({ id: `${phase}-${i}`, phase, kind: 'test', label: `block ${i}`, state: 'done' }))),
  edges: [],
} as never;
type Row = [string, number, string, boolean, boolean, boolean];
const columns = (width: number): Row[] =>
  layoutMap(data, width, 300).columns.map((c) => [c.key, Math.round(c.w), c.note, c.showNote, c.fullTitle, c.showCount]);

/** [key, width, note, showNote, fullTitle, showCount], as recorded. 1091 and 1110 are the map at 1280 px; 1270 at 1440. */
const BEFORE: Record<number, Row[]> = {
  1091: [['requirements', 232, 'Stories and criteria', false, true, true], ['design', 196, 'Contracts', false, true, true], ['implementation', 178, 'Functions', false, true, true], ['testing', 214, 'Tests and planted bugs', false, true, true], ['deployment', 134, 'Runbook and CI', false, true, true], ['maintenance', 125, 'Change request', false, false, true]],
  1110: [['requirements', 236, 'Stories and criteria', false, true, true], ['design', 200, 'Contracts', false, true, true], ['implementation', 181, 'Functions', false, true, true], ['testing', 218, 'Tests and planted bugs', false, true, true], ['deployment', 136, 'Runbook and CI', false, true, true], ['maintenance', 127, 'Change request', false, true, true]],
  1270: [['requirements', 270, 'Stories and criteria', true, true, true], ['design', 229, 'Contracts', true, true, true], ['implementation', 208, 'Functions', false, true, true], ['testing', 250, 'Tests and planted bugs', true, true, true], ['deployment', 156, 'Runbook and CI', false, true, true], ['maintenance', 146, 'Change request', false, true, true]],
  1500: [['requirements', 320, 'Stories and criteria', true, true, true], ['design', 271, 'Contracts', true, true, true], ['implementation', 246, 'Functions', true, true, true], ['testing', 295, 'Tests and planted bugs', true, true, true], ['deployment', 184, 'Runbook and CI', false, true, true], ['maintenance', 172, 'Change request', false, true, true]],
};

describe('the Testing lane keeps a note at 1280 px', () => {
  for (const width of [1091, 1110]) {
    it(`at ${width} px of map (1280 px window) the Testing lane says "Tests and bugs", with its count of 110`, () => {
      const testing = columns(width).find((c) => c[0] === 'testing')!;
      expect(testing.slice(2)).toEqual(['Tests and bugs', true, true, true]);
      expect(layoutMap(data, width, 300).columns.find((c) => c.key === 'testing')!.count).toBe(110);
    });
  }

  it('at 1440 px and wider the Testing lane says "Tests and planted bugs"', () => {
    for (const width of [1270, 1500]) expect(columns(width)).toEqual(BEFORE[width]);
  });

  it('every other lane, at every width, keeps the columns it is given without the note', () => {
    for (const width of [1091, 1110, 1270, 1500]) {
      expect(columns(width).filter((c) => c[0] !== 'testing')).toEqual(BEFORE[width].filter((c) => c[0] !== 'testing'));
    }
  });

  it('a lane too narrow for the shorter note too draws none', () => {
    const testing = columns(900).find((c) => c[0] === 'testing')!;
    expect(testing[3]).toBe(false);
  });
});
