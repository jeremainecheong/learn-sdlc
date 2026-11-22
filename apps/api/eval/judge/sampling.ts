import { createHash } from 'crypto';

/**
 * Shuffling, stratified sampling, blinding and the pairwise position swap.
 * Deterministic from a seed so a resumed run judges the same sample in the
 * same order.
 */

/** A small seeded PRNG (mulberry32 over a sha256 of the seed). */
export function rng(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** round(fraction × stratum size), at least one per stratum; strata in first-seen order. */
export function stratifiedSample<T>(items: readonly T[], fraction: number, strata: (item: T) => string, seed: string): T[] {
  if (fraction >= 1) return [...items];
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = strata(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const out: T[] = [];
  for (const [key, group] of groups) {
    const take = Math.max(1, Math.round(group.length * fraction));
    out.push(...seededShuffle(group, `${seed}|${key}`).slice(0, take));
  }
  return out;
}

export interface PairOrder { A: string; B: string; candidateIs: 'A' | 'B' }

/** Candidate first, then the reference first: the two orders that cancel position bias. */
export function pairwiseOrders(candidate: string, reference: string): [PairOrder, PairOrder] {
  return [
    { A: candidate, B: reference, candidateIs: 'A' },
    { A: reference, B: candidate, candidateIs: 'B' },
  ];
}

export type PairVerdict = { winner: 'A' | 'B' | 'tie'; candidateIs: 'A' | 'B' };

/** A win or a loss only when both orders agree on the same output; anything else is a tie. */
export function combinePairwise(first: PairVerdict, second: PairVerdict): 'win' | 'tie' | 'loss' {
  const read = (v: PairVerdict): 'cand' | 'ref' | 'tie' => (v.winner === 'tie' ? 'tie' : v.winner === v.candidateIs ? 'cand' : 'ref');
  const a = read(first);
  const b = read(second);
  if (a === 'cand' && b === 'cand') return 'win';
  if (a === 'ref' && b === 'ref') return 'loss';
  return 'tie';
}

/** An opaque, salted label for one model's output on one case. Judges see only this. */
export function blindLabel(modelKey: string, caseId: string, salt: string): string {
  return `out-${createHash('sha256').update(`${salt}|${modelKey}|${caseId}`).digest('hex').slice(0, 10)}`;
}
