import { describe, expect, it } from 'vitest';
import type { PhaseSummary } from '@learnsdlc/shared';
import { isCreditOnly, type PassKind } from '@/lib/pass-kind';

/*
 * A phase a teacher marked as passed with no reviewed pass behind it is a
 * credit, not a pass. The board says which kind of pass each phase holds
 * (`passKind`, the gate's own predicate), and every reader asks `isCreditOnly`
 * before it says "Pass". A reviewed pass, and a payload with no `passKind`,
 * read as a pass.
 */
const summary = (passKind?: PassKind, over: Partial<PhaseSummary> = {}): PhaseSummary & { passKind?: PassKind } => ({
  id: 'phase-1',
  key: 'requirements',
  order: 1,
  title: 'Requirements',
  status: 'passed',
  bestScore: 70,
  attempts: 2,
  reflection: null,
  passedAt: '2026-11-09T10:00:00.000Z',
  opensAt: null,
  dueAt: null,
  ...(passKind ? { passKind } : {}),
  ...over,
});

describe('isCreditOnly', () => {
  it('is true only on a passed phase the board names as credit', () => {
    expect(isCreditOnly(summary('credit'))).toBe(true);
    expect(isCreditOnly(summary('reviewed'))).toBe(false);
    expect(isCreditOnly(summary())).toBe(false);
    expect(isCreditOnly(summary('credit', { status: 'in_progress' }))).toBe(false);
  });
});
