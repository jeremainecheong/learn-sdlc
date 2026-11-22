import type { EvalModel, UseCase } from '../contracts';
import type { UnitScore } from '../score/score';
import { MIX, USE_CASES, WEIGHTS, scorecards, type JudgeRecord, type Scorecard } from './analysis';

/**
 * The balanced choice: latency weighs as
 * much as quality. balanced = (wq × quality + wl × latency) / (wq + wl), with
 * quality the per-job combined score (0-1) and latency a 0-1 term from the
 * measured action p95 and the share of calls over the product's 20 s target:
 *   p95 term   = clamp((30 s − p95) / 20 s)        (1 at ≤ 10 s, 0 at ≥ 30 s)
 *   share term = clamp((10% − share over 20 s) / 10%)  (1 at 0%, 0 at ≥ 10%)
 *   latency    = min(p95 term, share term)
 * A model whose action p95 exceeds 20 s on a job is not recommended for it.
 */
export const BALANCE = { quality: 0.6, latency: 0.4 };
export const TARGET_MS = 20_000;
export const REFERENCE_GAP = 0.05;
const clamp = (x: number) => Math.max(0, Math.min(1, x));

export function latencyTerm(p95Ms: number | null, over20Share: number | null): number | null {
  if (p95Ms === null || over20Share === null || !Number.isFinite(p95Ms)) return null;
  return Math.min(clamp((30_000 - p95Ms) / 20_000), clamp((0.1 - over20Share) / 0.1));
}
export function balancedOf(quality: number | null, latency: number | null, w = BALANCE): number | null {
  return quality === null || latency === null ? null : (w.quality * quality + w.latency * latency) / (w.quality + w.latency);
}
export const eligibleForJob = (p95Ms: number | null): boolean => p95Ms !== null && p95Ms <= TARGET_MS;

export interface Weights { name: string; quality: number; latency: number }
export function weightVariants(): Weights[] {
  const v = (name: string, q: number, l: number) => ({ name, quality: q / (q + l), latency: l / (q + l) });
  return [v('baseline', 0.6, 0.4), v('quality ×0.75', 0.45, 0.4), v('quality ×1.25', 0.75, 0.4), v('latency ×0.75', 0.6, 0.3), v('latency ×1.25', 0.6, 0.5)];
}

export interface Cell {
  modelKey: string; scope: 'useCase' | 'jobType'; job: string; useCase: UseCase; card: Scorecard;
  quality: number | null; p95: number | null; over20: number | null; latency: number | null; balanced: number | null; eligible: boolean; costPerAction: number | null;
}
const cellOf = (card: Scorecard, scope: Cell['scope'], job: string): Cell => {
  const latency = latencyTerm(card.fixed.actionP95, card.fixed.over20sShare);
  return { modelKey: card.modelKey, scope, job, useCase: card.useCase, card, quality: card.combined, p95: card.fixed.actionP95, over20: card.fixed.over20sShare, latency, balanced: balancedOf(card.combined, latency), eligible: eligibleForJob(card.fixed.actionP95), costPerAction: card.fixed.meanCostPerAction };
};

export function balancedCells(units: UnitScore[], judgements: JudgeRecord[], models: EvalModel[], cards: Scorecard[]) {
  const byUseCase = cards.map((c) => cellOf(c, 'useCase', c.useCase));
  const jobs = [...new Set(units.map((u) => u.jobType))].sort();
  const byJob: Cell[] = [];
  for (const jt of jobs) for (const c of scorecards(units.filter((u) => u.jobType === jt), judgements.filter((j) => j.jobType === jt), models)) byJob.push(cellOf(c, 'jobType', jt));
  return { byUseCase, byJob, jobs };
}

export function overallBalanced(cells: Cell[], modelKey: string, w: Weights | typeof BALANCE = BALANCE): number | null {
  let t = 0; let s = 0;
  for (const u of USE_CASES) {
    const c = cells.find((x) => x.modelKey === modelKey && x.useCase === u && x.scope === 'useCase');
    const v = c ? balancedOf(c.quality, c.latency, w) : null;
    if (v === null) continue;
    t += WEIGHTS[u] * v; s += WEIGHTS[u];
  }
  return s ? t / s : null;
}
export const breaches = (cells: Cell[], modelKey: string): string[] => cells.filter((c) => c.modelKey === modelKey && !c.eligible).map((c) => c.job);

const argmax = (cells: Cell[], pick: (c: Cell) => number | null) => cells.filter((c) => pick(c) !== null).sort((a, b) => pick(b)! - pick(a)!)[0] ?? null;

export interface Route { job: string; useCase: UseCase; pick: Cell | null; qualityWinner: Cell | null; reference: Cell | null; gap: number | null; referenceAdvisable: boolean; note: string }

/** Per job: the open-weight balanced pick among models within the 20 s p95 rule, the quality-only winner, and the reference. */
export function routingPlan(byJob: Cell[], jobs: string[], isOnprem: (k: string) => boolean, referenceKey: string | null, w: Weights | typeof BALANCE = BALANCE): Route[] {
  return jobs.map((job) => {
    const here = byJob.filter((c) => c.job === job);
    const open = here.filter((c) => isOnprem(c.modelKey));
    const pick = argmax(open.filter((c) => c.eligible), (c) => balancedOf(c.quality, c.latency, w));
    const qualityWinner = argmax(open, (c) => c.quality);
    const reference = here.find((c) => c.modelKey === referenceKey) ?? null;
    const gap = pick && reference && pick.quality !== null && reference.quality !== null ? pick.quality - reference.quality : null;
    const referenceAdvisable = !pick || (gap !== null && gap < -REFERENCE_GAP);
    const note = !pick ? 'no open-weight model within the 20 s p95 rule' : referenceAdvisable ? `open-weight pick trails the reference by more than ${REFERENCE_GAP.toFixed(2)}` : 'open-weight pick within reach of the reference';
    return { job, useCase: here[0]?.useCase ?? (open[0]?.useCase as UseCase), pick, qualityWinner, reference, gap, referenceAdvisable, note };
  });
}

/** Cost per 1,000 learner interactions for a routing (MIX per use-case; a use-case with several jobs splits its share equally). */
export function planCost(routes: Array<{ job: string; useCase: UseCase; costPerAction: number | null }>): number | null {
  let total = 0;
  for (const u of USE_CASES) {
    const rs = routes.filter((r) => r.useCase === u);
    if (!rs.length) continue;
    for (const r of rs) { if (r.costPerAction === null) return null; total += (MIX[u] / rs.length) * r.costPerAction; }
  }
  return total;
}
