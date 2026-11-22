import { blindLabel, combinePairwise, pairwiseOrders, seededShuffle, stratifiedSample } from './sampling';

/* Shuffling, blinding and the position swap. */
describe('seededShuffle', () => {
  it('is a deterministic permutation for a seed and differs across seeds', () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const a = seededShuffle(items, 'run-1');
    expect(seededShuffle(items, 'run-1')).toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    expect(seededShuffle(items, 'run-2')).not.toEqual(a);
    expect(a).not.toEqual(items);
  });
});

describe('stratifiedSample', () => {
  it('takes at least one per stratum and about the fraction overall', () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => ({ s: 'review', i })),
      ...Array.from({ length: 10 }, (_, i) => ({ s: 'mentor', i })),
      { s: 'rare', i: 0 },
    ];
    const out = stratifiedSample(items, 0.1, (x) => x.s, 'seed');
    const by = (s: string) => out.filter((x) => x.s === s).length;
    expect(by('review')).toBe(2);
    expect(by('mentor')).toBe(1);
    expect(by('rare')).toBe(1);
    expect(stratifiedSample(items, 0.1, (x) => x.s, 'seed')).toEqual(out);
  });
});

describe('pairwiseOrders and combinePairwise', () => {
  it('shows the candidate first and then second, never by name', () => {
    const [first, second] = pairwiseOrders('cand text', 'ref text');
    expect(first).toEqual({ A: 'cand text', B: 'ref text', candidateIs: 'A' });
    expect(second).toEqual({ A: 'ref text', B: 'cand text', candidateIs: 'B' });
  });
  it('counts a win only when both orders agree; anything else is a tie', () => {
    expect(combinePairwise({ winner: 'A', candidateIs: 'A' }, { winner: 'B', candidateIs: 'B' })).toBe('win');
    expect(combinePairwise({ winner: 'B', candidateIs: 'A' }, { winner: 'A', candidateIs: 'B' })).toBe('loss');
    // position bias: the judge picked A both times
    expect(combinePairwise({ winner: 'A', candidateIs: 'A' }, { winner: 'A', candidateIs: 'B' })).toBe('tie');
    expect(combinePairwise({ winner: 'tie', candidateIs: 'A' }, { winner: 'B', candidateIs: 'B' })).toBe('tie');
  });
});

describe('blindLabel', () => {
  it('hides the model key behind a salted opaque label', () => {
    const label = blindLabel('llama33-70b', 'case-1', 'salt');
    expect(label).toMatch(/^out-[0-9a-f]{10}$/);
    expect(label).not.toContain('llama');
    expect(blindLabel('llama33-70b', 'case-1', 'salt')).toBe(label);
    expect(blindLabel('llama33-70b', 'case-1', 'other')).not.toBe(label);
  });
});
