import { useCaseOf, type CorpusCase } from '../contracts';
import { seededShuffle } from './sampling';

/**
 * The priority order, enforced at run time. plan.json
 * applies the cuts before the run; this keeps them true while it runs, when
 * actual spend can differ from the estimate. With three judges that are also
 * candidates, each model has a primary judge (the first of A, B, C that is not
 * itself) and secondary judges (the other non-self judges):
 *
 *   0  the primary judge on every chat and explanation case: protected, never gated;
 *   1  the primary judge on reviews and proposals;
 *   2  the secondary judges;
 *   3  the 10% re-judge (κ; not on the cut list, so it ranks above
 *      the first thing cut);
 *   4  pairwise against the reference (the first cut).
 *
 * A unit in tier t > 0 runs only if committed spend + the estimated cost of
 * every unit still to run in tiers < t + this unit's worst case stays within
 * the stop. Otherwise it is skipped and recorded as `cut_at_runtime`.
 */
export const TIER = { protectedChat: 0, primaryReviewProposal: 1, secondary: 2, rejudge: 3, pairwise: 4 } as const;
export const TIER_NAMES = ['primary-chat-explanation', 'primary-review-proposal', 'secondary-judges', 'rejudge', 'pairwise'];

interface TierUnit { kind: 'absolute' | 'pairwise' | 'rejudge'; primary?: boolean; c: Pick<CorpusCase, 'jobType'> }

export function tierOf(u: TierUnit): number {
  if (u.kind === 'rejudge') return TIER.rejudge;
  if (u.kind === 'pairwise') return TIER.pairwise;
  if (!u.primary) return TIER.secondary;
  const use = useCaseOf(u.c.jobType as never);
  return use === 'review' || use === 'agentic' ? TIER.primaryReviewProposal : TIER.protectedChat;
}

/** Ascending tier; a seeded shuffle within each tier (resumable, blind to order effects). */
export function orderByTier<T extends TierUnit>(units: readonly T[], seed: string): T[] {
  const tiers = [...new Set(units.map(tierOf))].sort((a, b) => a - b);
  return tiers.flatMap((t) => seededShuffle(units.filter((u) => tierOf(u) === t), `${seed}|tier${t}`));
}

/**
 * What each tier still needs, shared by the parallel judge lanes. A "later"
 * amount is owed by a stage that runs after this call (the re-judge, which
 * samples judge A's finished units): it is kept back from lower tiers, but no
 * lane waits for it.
 */
export class TierReserve {
  private readonly now = new Map<number, number>();
  private readonly later = new Map<number, number>();
  add(tier: number, usd: number, options: { later?: boolean } = {}): void {
    const m = options.later ? this.later : this.now;
    m.set(tier, (m.get(tier) ?? 0) + usd);
  }
  /** A unit of this tier finished, failed or was cut: its estimate is not owed. */
  settle(tier: number, usd: number): void { this.now.set(tier, Math.max(0, (this.now.get(tier) ?? 0) - usd)); }
  /** Everything owed by the tiers ahead, including later stages. */
  ahead(tier: number): number { return sumBelow(this.now, tier) + sumBelow(this.later, tier); }
  /** Owed by tiers ahead that are running in this call: what a deferred unit waits for. */
  activeAhead(tier: number): number { return sumBelow(this.now, tier); }
}

function sumBelow(m: Map<number, number>, tier: number): number {
  let sum = 0;
  for (const [t, usd] of m) if (t < tier) sum += usd;
  return sum;
}

export function runtimeAdmits(guard: { committed: number; cap: number }, reserve: TierReserve, tier: number, worstUsd: number): boolean {
  if (tier === TIER.protectedChat) return true;
  return guard.committed + reserve.ahead(tier) + worstUsd <= guard.cap + 1e-12;
}
