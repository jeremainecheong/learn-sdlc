import { TIER, TierReserve, orderByTier, runtimeAdmits, tierOf } from './tiers';

/*
 * The priority order held at run time, not only in plan.json: judge A on
 * chat/explanation is protected; then judge A on
 * reviews/proposals; then judge B; then the re-judge; then pairwise. A unit
 * below the protected tier runs only if the stop still covers every unit of
 * the tiers ahead of it.
 */
// slot 'A' = the model's primary judge, 'B' = a secondary judge (the third judge is secondary too).
const u = (kind: 'absolute' | 'pairwise' | 'rejudge', slot: 'A' | 'B', jobType: string, id = 'x') => ({ kind, primary: slot === 'A', judge: { judgeSlot: slot }, c: { jobType, id } }) as never;

describe('tierOf', () => {
  it('ranks the stages in priority order (pairwise is the first cut; the re-judge is not on the cut list)', () => {
    expect(TIER.pairwise).toBeGreaterThan(TIER.rejudge);
    expect(TIER.rejudge).toBeGreaterThan(TIER.secondary);
    expect(tierOf(u('absolute', 'A', 'interview-turn'))).toBe(TIER.protectedChat);
    expect(tierOf(u('absolute', 'A', 'mentor-turn'))).toBe(TIER.protectedChat);
    expect(tierOf(u('absolute', 'A', 'explanation-assessment'))).toBe(TIER.protectedChat);
    expect(tierOf(u('absolute', 'A', 'review-design'))).toBe(TIER.primaryReviewProposal);
    expect(tierOf(u('absolute', 'A', 'agentic-proposal'))).toBe(TIER.primaryReviewProposal);
    expect(tierOf(u('absolute', 'B', 'interview-turn'))).toBe(TIER.secondary);
    expect(tierOf(u('pairwise', 'A', 'interview-turn'))).toBe(TIER.pairwise);
    expect(tierOf(u('rejudge', 'A', 'interview-turn'))).toBe(TIER.rejudge);
  });
});

describe('orderByTier', () => {
  it('puts every protected unit first, then reviews/proposals, then pairwise, shuffled only within a tier', () => {
    const units = [
      ...Array.from({ length: 6 }, (_, i) => u('pairwise', 'A', 'interview-turn', `p${i}`)),
      ...Array.from({ length: 6 }, (_, i) => u('absolute', 'A', 'review-design', `r${i}`)),
      ...Array.from({ length: 6 }, (_, i) => u('absolute', 'A', 'mentor-turn', `m${i}`)),
    ];
    const ordered = orderByTier(units, 'seed');
    expect(ordered.map(tierOf)).toEqual([...Array(6).fill(TIER.protectedChat), ...Array(6).fill(TIER.primaryReviewProposal), ...Array(6).fill(TIER.pairwise)]);
    expect(orderByTier(units, 'seed')).toEqual(ordered);
    const firstSix = ordered.slice(0, 6).map((x: any) => x.c.id);
    expect(firstSix).not.toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  });
});

describe('TierReserve and runtimeAdmits', () => {
  it('keeps the money the tiers ahead still need', () => {
    const r = new TierReserve();
    r.add(TIER.protectedChat, 0.5);
    r.add(TIER.protectedChat, 0.5);
    r.add(TIER.primaryReviewProposal, 2);
    r.add(TIER.secondary, 3);
    expect(r.ahead(TIER.protectedChat)).toBe(0);
    expect(r.ahead(TIER.secondary)).toBeCloseTo(3, 9);
    expect(r.ahead(TIER.pairwise)).toBeCloseTo(6, 9);
    r.add(TIER.rejudge, 1, { later: true });
    expect(r.ahead(TIER.pairwise)).toBeCloseTo(7, 9);
    expect(r.activeAhead(TIER.pairwise)).toBeCloseTo(6, 9);
    r.settle(TIER.protectedChat, 0.5);
    expect(r.ahead(TIER.secondary)).toBeCloseTo(2.5, 9);
  });

  it('never gates the protected tier, and cuts a lower tier that would eat the protected reserve', () => {
    const r = new TierReserve();
    r.add(TIER.protectedChat, 4);
    // committed 40, cap 45: protected still needs 4, a judge-B unit with worst 1.5 would pass the stop
    expect(runtimeAdmits({ committed: 40, cap: 45 }, r, TIER.protectedChat, 4.9)).toBe(true);
    expect(runtimeAdmits({ committed: 40, cap: 45 }, r, TIER.secondary, 1.5)).toBe(false);
    expect(runtimeAdmits({ committed: 40, cap: 45 }, r, TIER.secondary, 0.9)).toBe(true);
  });
});
