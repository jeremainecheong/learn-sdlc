/**
 * The concept-quiz client: the status route it reads for a phase, and how a
 * check's kind maps to its task key, its room and back from the address.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, request: rig.request };
});

import { conceptApi, conceptHref, conceptKindFrom, conceptTaskKey, type ConceptQuizzes } from '@/lib/api-concept';

const quizzes: ConceptQuizzes = {
  phaseKey: 'requirements',
  before: { taskKey: 'concept-before', status: 'open', scorePct: null, questionCount: 6 },
  after: { taskKey: 'concept-after', status: 'locked', scorePct: null, questionCount: 6 },
};

beforeEach(() => {
  rig.request.mockReset();
});

describe('the concept-quiz client', () => {
  it('reads the status route for the phase in the address', async () => {
    rig.request.mockResolvedValueOnce(quizzes);
    await conceptApi.status('phase /1');
    expect(rig.request).toHaveBeenCalledWith('GET', '/phases/phase%20%2F1/concept-quizzes');
  });

  it('maps a kind to its task key and its room, and reads a kind from the address', () => {
    expect(conceptTaskKey('before')).toBe('concept-before');
    expect(conceptTaskKey('after')).toBe('concept-after');
    expect(conceptHref('p 1', 'after')).toBe('/workspace/p%201/concept?kind=after');
    expect(conceptKindFrom('after')).toBe('after');
    expect(conceptKindFrom('before')).toBe('before');
    expect(conceptKindFrom(null)).toBe('before');
    expect(conceptKindFrom('nonsense')).toBe('before');
  });
});
