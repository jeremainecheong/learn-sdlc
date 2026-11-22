/**
 * The six phases, and nothing else.
 *
 * These three declarations live in a module with no imports of its own, which
 * `index.ts` re-exports like every other. `map.ts` reads `PHASE_ORDER` while
 * its own module body runs, so it must come from a module that cannot be in a
 * cycle: were it declared in a module that re-exports `map.ts`, the
 * re-exported module would be evaluated first, `PHASE_ORDER` would still be in
 * its temporal dead zone, and the load would fail with "Cannot read properties
 * of undefined (reading 'reduce')".
 */
export type PhaseKey =
  | 'requirements'
  | 'design'
  | 'implementation'
  | 'testing'
  | 'deployment'
  | 'maintenance';

export const PHASE_ORDER: PhaseKey[] = [
  'requirements',
  'design',
  'implementation',
  'testing',
  'deployment',
  'maintenance',
];

export type PhaseStatus = 'locked' | 'in_progress' | 'submitted' | 'passed';
