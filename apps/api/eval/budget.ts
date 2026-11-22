/**
 * The cost side of the evaluation: prices, the estimator, the live guard and
 * the priority cuts. The stop is at most US$45 and cannot be raised from the
 * command line: the evaluation's budget is about US$50, and the last US$5
 * covers estimator error.
 */

export const HARD_STOP_USD = 45;

export interface PriceRow { priceIn: number; priceOut: number }

/** A selected row without both prices is refused: a model we cannot price is a model we cannot cap. */
export function priceRowOf(row: { key?: string; priceIn?: unknown; priceOut?: unknown }): PriceRow {
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!ok(row.priceIn) || !ok(row.priceOut)) throw new Error(`model ${row.key ?? '?'} has no price in models.json; refusing to estimate or run it`);
  return { priceIn: row.priceIn as number, priceOut: row.priceOut as number };
}

/** USD for a token count at per-million prices. */
export const costOf = (price: PriceRow, tokensIn: number, tokensOut: number): number =>
  (tokensIn * price.priceIn + tokensOut * price.priceOut) / 1_000_000;

/** Conservative input estimate: bytes / 3.5 (fewer bytes per token than any slate model's tokeniser). */
export const tokensFromBytes = (bytes: number): number => Math.ceil(bytes / 3.5);

export class BudgetExceeded extends Error {
  constructor(readonly committed: number, readonly asked: number, readonly cap: number) {
    super(`budget stop: committed ${committed.toFixed(4)} + ${asked.toFixed(4)} would pass US$${cap}`);
    this.name = 'BudgetExceeded';
  }
}

/**
 * The live guard. Before a call it reserves the call's worst case; after it,
 * settles to the actual usage. `committed` (spent + open reservations) is what
 * the cap is checked against, so concurrent model lanes cannot together pass
 * the stop, and a reservation never settled (a crash mid-call) stays counted
 * at its worst case.
 */
export class SpendGuard {
  private open = 0;
  constructor(readonly cap: number, public spent: number) {
    if (!(cap > 0) || cap > HARD_STOP_USD) throw new Error(`the stop must be in (0, ${HARD_STOP_USD}] US$`);
  }
  get committed(): number { return this.spent + this.open; }
  admits(worstCase: number): boolean { return this.committed + worstCase <= this.cap + 1e-12; }
  reserve(worstCase: number): void {
    if (!this.admits(worstCase)) throw new BudgetExceeded(this.committed, worstCase, this.cap);
    this.open += worstCase;
  }
  settle(reserved: number, actual: number): void {
    this.open = Math.max(0, this.open - reserved);
    this.spent += actual;
  }
}

/**
 * The pilot's guard: a pilot run may spend at most
 * `pilotCapUsd` on top of what every other real run already spent, and never
 * more than the run's stop. `spentThisRun` is the pilot's own ledger, so a
 * resumed pilot keeps counting what it already spent against the same cap.
 */
export function pilotGuard(o: { stopUsd: number; spentElsewhere: number; spentThisRun: number; pilotCapUsd: number }): SpendGuard {
  if (!(o.pilotCapUsd > 0)) throw new Error('--pilot-cap must be a positive amount of US$');
  return new SpendGuard(Math.min(o.stopUsd, o.spentElsewhere + o.pilotCapUsd), o.spentElsewhere + o.spentThisRun);
}

/**
 * Judge stages with three judges that are also candidates: each model's primary judge is the first of A, B, C that is not the
 * model itself (A for everyone but A's own outputs, which B judges); every
 * other non-self judge is secondary.
 */
export interface StageEstimate {
  candidates: number;
  primary: { chat: number; explanation: number; review: number; proposal: number };
  secondary: number;
  pairwise: number;
  rejudge: number;
}

export interface CutPlan {
  pairwise: boolean;
  secondaryFraction: number;
  primaryReviewProposalFraction: number;
}

const sumPrimary = (a: StageEstimate['primary'], frac = 1) => a.chat + a.explanation + frac * (a.review + a.proposal);

/**
 * The priority order when the estimate does not fit the stop:
 *   1. drop the pairwise stage;
 *   2. the secondary judges down to a 15% stratified sample;
 *   3. the primary judge on reviews and proposals down to a 35% stratified sample.
 * The candidate run on the full corpus and the primary judge on every chat and
 * explanation case are never cut. Every cut is recorded for the report.
 */
export function applyPriorityCuts(est: StageEstimate, stopUsd: number, options: { capOverride?: boolean } = {}) {
  if (!options.capOverride && (stopUsd > HARD_STOP_USD || !(stopUsd > 0))) throw new Error(`the stop must be in (0, ${HARD_STOP_USD}] US$`);
  const plan: CutPlan = { pairwise: true, secondaryFraction: 1, primaryReviewProposalFraction: 1 };
  const cuts: Array<{ stage: string; from: number; to: number; note: string }> = [];
  const total = () => est.candidates + sumPrimary(est.primary, plan.primaryReviewProposalFraction) + est.secondary * plan.secondaryFraction + (plan.pairwise ? est.pairwise : 0) + est.rejudge;
  if (total() > stopUsd) {
    plan.pairwise = false;
    cuts.push({ stage: 'pairwise', from: est.pairwise, to: 0, note: 'pairwise vs the reference dropped (priority 1)' });
  }
  if (total() > stopUsd) {
    plan.secondaryFraction = 0.15;
    cuts.push({ stage: 'secondary-judges', from: est.secondary, to: est.secondary * 0.15, note: 'the secondary judges (every non-self judge after the primary) on a 15% stratified sample (priority 2)' });
  }
  if (total() > stopUsd) {
    plan.primaryReviewProposalFraction = 0.35;
    const full = est.primary.review + est.primary.proposal;
    cuts.push({ stage: 'primary-review-proposal', from: full, to: full * 0.35, note: 'the primary judge on reviews and proposals on a 35% stratified sample; chat and explanation kept in full (priority 3)' });
  }
  return { plan, cuts, total: total(), fits: total() <= stopUsd };
}
