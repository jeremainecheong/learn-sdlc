import { olderFormatPhase, phaseCheckKind } from './phase-grading';
import { requirementsGrading } from './requirements-grading';

/** A compiled snapshot reduced to what the readings read: each phase's checks kind. */
const snapshot = (kinds: Record<string, string>) =>
  ({ content: { phases: Object.entries(kinds).map(([key, kind]) => ({ key, checks: { kind } })) } }) as never;

describe('what a version grades, phase by phase', () => {
  it('reads a phase\'s checks kind, and nothing for a phase, a snapshot or content that is not there', () => {
    expect(phaseCheckKind(snapshot({ requirements: 'story', design: 'markdown' }), 'design')).toBe('markdown');
    expect(phaseCheckKind(snapshot({ requirements: 'story' }), 'design')).toBeUndefined();
    expect(phaseCheckKind(null, 'design')).toBeUndefined();
    expect(phaseCheckKind({} as never, 'requirements')).toBeUndefined();
  });

  it('names the older format phase, Requirements first, and null when both are structured', () => {
    expect(olderFormatPhase(snapshot({ requirements: 'markdown', design: 'markdown' }))).toBe('requirements');
    expect(olderFormatPhase(snapshot({ requirements: 'story', design: 'markdown' }))).toBe('design');
    expect(olderFormatPhase(snapshot({ requirements: 'story', design: 'design' }))).toBeNull();
    expect(olderFormatPhase(undefined)).toBeNull();
  });

  it('requirementsGrading reads its kind the same way', () => {
    expect(requirementsGrading(snapshot({ requirements: 'markdown' })).kind).toBe('markdown');
    expect(requirementsGrading(null)).toEqual({ kind: undefined, storyId: undefined });
  });
});
