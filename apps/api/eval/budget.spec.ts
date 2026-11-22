import { BudgetExceeded, SpendGuard, applyPriorityCuts, costOf, priceRowOf } from './budget';

/*
 * The cost estimator, the live budget stop and the priority cuts.
 */
const PRICES = {
  cheap: { priceIn: 0.1, priceOut: 0.4 },
  dear: { priceIn: 1, priceOut: 5 },
};

describe('priceRowOf', () => {
  it('refuses a selected model that has no price', () => {
    expect(() => priceRowOf({ key: 'nameless', priceIn: null, priceOut: 0.2 } as never)).toThrow(/no price/);
    expect(() => priceRowOf({ key: 'nameless', priceIn: 0.1 } as never)).toThrow(/no price/);
    expect(priceRowOf({ key: 'ok', priceIn: 0.1, priceOut: 0.2 } as never)).toEqual({ priceIn: 0.1, priceOut: 0.2 });
  });
});

describe('costOf', () => {
  it('prices tokens per million', () => {
    expect(costOf(PRICES.dear, 1_000_000, 200_000)).toBeCloseTo(1 + 1, 9);
  });
});

/* The estimator the plan uses (expectedOut, estimate, writePlan) is specified in plan.spec.ts. */

describe('SpendGuard (the US$45 hard stop)', () => {
  it('admits a call only when spent + its worst case stays within the cap', () => {
    const guard = new SpendGuard(1.0, 0.9);
    expect(guard.admits(0.05)).toBe(true);
    expect(guard.admits(0.2)).toBe(false);
  });
  it('charges actual usage after the call and refuses once the cap is reached', () => {
    const guard = new SpendGuard(1.0, 0);
    guard.reserve(0.6);
    guard.settle(0.6, 0.5);
    expect(guard.spent).toBeCloseTo(0.5, 9);
    expect(() => guard.reserve(0.6)).toThrow(BudgetExceeded);
    expect(guard.spent).toBeCloseTo(0.5, 9);
  });
  it('counts a reservation that never settled (a crash mid-call) at its worst case', () => {
    const guard = new SpendGuard(10, 0);
    guard.reserve(2);
    expect(guard.committed).toBeCloseTo(2, 9);
  });
  it('never allows a cap above US$45', () => {
    expect(() => new SpendGuard(46, 0)).toThrow(/45/);
  });
});

describe('applyPriorityCuts', () => {
  const base = {
    candidates: 20,
    primary: { chat: 4, explanation: 1, review: 8, proposal: 2 },
    secondary: 10,
    pairwise: 6,
    rejudge: 1,
  };
  it('keeps everything when it fits', () => {
    const out = applyPriorityCuts(base, 60 as never, { capOverride: true });
    expect(out.cuts).toEqual([]);
  });
  it('refuses a cap above US$45 unless a test overrides it', () => {
    expect(() => applyPriorityCuts(base, 60 as never)).toThrow(/45/);
  });
  it('cuts the pairwise first, then the secondary judges to 15%, then the primary judge on reviews/proposals to 35%', () => {
    // total = 20 + 15 + 10 + 6 + 1 = 52
    const a = applyPriorityCuts(base, 46.5 as never, { capOverride: true });
    expect(a.cuts.map((c) => c.stage)).toEqual(['pairwise']);
    expect(a.total).toBeCloseTo(46, 6);
    const b = applyPriorityCuts(base, 40 as never, { capOverride: true });
    expect(b.cuts.map((c) => c.stage)).toEqual(['pairwise', 'secondary-judges']);
    expect(b.plan.secondaryFraction).toBeCloseTo(0.15, 9);
    expect(b.total).toBeCloseTo(20 + 15 + 1.5 + 1, 6);
    const c = applyPriorityCuts(base, 35 as never, { capOverride: true });
    expect(c.cuts.map((x) => x.stage)).toEqual(['pairwise', 'secondary-judges', 'primary-review-proposal']);
    expect(c.plan.primaryReviewProposalFraction).toBeCloseTo(0.35, 9);
    // the primary judge keeps chat + explanation in full, 35% of review + proposal
    expect(c.total).toBeCloseTo(20 + 4 + 1 + 0.35 * 10 + 1.5 + 1, 6);
  });
  it('never cuts the candidates or the primary judge on chat/explanation, and says so when even that does not fit', () => {
    const out = applyPriorityCuts(base, 10 as never, { capOverride: true });
    expect(out.fits).toBe(false);
    expect(out.cuts.map((c) => c.stage)).toContain('primary-review-proposal');
  });
});
