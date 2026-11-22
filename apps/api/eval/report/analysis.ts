import * as fs from 'fs';
import * as path from 'path';
import { JUDGE_SLOTS, type EvalModel, type JudgeSlot, type UseCase } from '../contracts';
import { readJson } from '../io';
import { aggregate, type UnitScore, type UseCaseAggregate } from '../score/score';
import { cohenKappa, mean } from '../score/metrics';

/**
 * Everything the report states, computed in one place from the scores and the
 * judgements: per use-case scorecards (fixed, judges A/B/C, the cell judge
 * mean over the judges that are not the model under test, pairwise, combined), the weighted overall, the ±25% sensitivity table, cost per 1,000
 * learner interactions, judge reliability, and the three recommendations.
 */

export const USE_CASES: UseCase[] = ['review', 'mentor', 'agentic', 'interview', 'explanation'];
export const WEIGHTS: Record<UseCase, number> = { review: 0.3, mentor: 0.25, agentic: 0.2, interview: 0.15, explanation: 0.1 };
export const MIX: Record<UseCase, number> = { mentor: 450, interview: 200, agentic: 150, explanation: 100, review: 100 };
export const FIXED_WEIGHT = 0.6;
export const JUDGE_WEIGHT = 0.4;

export interface JudgeRecord {
  judge: string; judgeSlot?: JudgeSlot; primary?: boolean; kind: 'absolute' | 'pairwise' | 'rejudge'; modelKey: string; caseId: string; jobType: string; useCase: UseCase;
  result: { scores?: Record<string, { score: number; justification: string }>; outcome?: 'win' | 'tie' | 'loss'; blindLabel?: string; adaptation?: string | null; adaptations?: Array<string | null> } | null;
  failure: string | null; costUsd: number;
}

/** Judgements that parsed only through the judge-only format tolerance (judge/repair.ts), per judge. */
export const judgeAdaptations = (judgements: JudgeRecord[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const j of judgements) if (j.result?.adaptation || j.result?.adaptations?.some(Boolean)) out[j.judge] = (out[j.judge] ?? 0) + 1;
  return out;
};

export function loadJudgements(runDir: string): JudgeRecord[] {
  const out: JudgeRecord[] = [];
  const dir = path.join(runDir, 'judge');
  if (!fs.existsSync(dir)) return out;
  for (const judge of fs.readdirSync(dir)) for (const kind of fs.readdirSync(path.join(dir, judge))) for (const model of fs.readdirSync(path.join(dir, judge, kind))) {
    for (const f of fs.readdirSync(path.join(dir, judge, kind, model))) out.push(readJson<JudgeRecord>(path.join(dir, judge, kind, model, f)));
  }
  return out;
}

const unitMean = (r: JudgeRecord): number | null => {
  const s = r.result?.scores;
  return s ? mean(Object.values(s).map((x) => x.score)) : null;
};
export const norm = (score: number | null): number | null => (score === null ? null : (score - 1) / 4);

/** A judgement counts only if a judge scored someone else's output (self-exclusion). */
export const isSelfJudgement = (j: JudgeRecord): boolean => j.judge === j.modelKey;
const validAbs = (judgements: JudgeRecord[]) => judgements.filter((j) => j.kind === 'absolute' && j.result?.scores && !isSelfJudgement(j));

/**
 * The judge score of one output: the mean of the judges that are not the
 * model under test (two for the three judge-models, three for everyone else),
 * each judge's score being the mean of its criteria.
 */
export function cellJudgeMean(judgements: JudgeRecord[], modelKey: string, caseId: string): number | null {
  return mean(validAbs(judgements).filter((j) => j.modelKey === modelKey && j.caseId === caseId).map(unitMean).filter((x): x is number => x !== null));
}

export interface Scorecard {
  modelKey: string;
  useCase: UseCase;
  fixed: UseCaseAggregate;
  /** Each judge's mean (1-5) on this model and use-case; null where it did not judge (its own outputs). */
  judgeBy: Record<JudgeSlot, number | null>;
  judgeByCriterion: Record<JudgeSlot, Record<string, number | null>>;
  judgeN: Record<JudgeSlot, number>;
  /** Mean over cases of the cell judge mean (non-self judges only), 1-5. */
  judgeMean: number | null;
  /** Self-judgements found in the records and ignored (always 0 unless the harness broke). */
  selfJudgedIgnored: number;
  pairwise: { win: number; tie: number; loss: number } | null;
  pairwiseBy: Record<JudgeSlot, { win: number; tie: number; loss: number } | null>;
  judgeNorm: number | null;
  combined: number | null;
}

const combine = (fixed: number | null, judge: number | null): number | null => (fixed === null ? judge : judge === null ? fixed : FIXED_WEIGHT * fixed + JUDGE_WEIGHT * judge);
const wtl = (list: JudgeRecord[]) => (list.length ? { win: list.filter((j) => j.result!.outcome === 'win').length, tie: list.filter((j) => j.result!.outcome === 'tie').length, loss: list.filter((j) => j.result!.outcome === 'loss').length } : null);

export function scorecards(units: UnitScore[], judgements: JudgeRecord[], models: EvalModel[]): Scorecard[] {
  const out: Scorecard[] = [];
  const abs = validAbs(judgements);
  for (const m of models) for (const u of USE_CASES) {
    const fixed = aggregate(units, m.key, u);
    if (!fixed.n) continue;
    const mine = abs.filter((j) => j.modelKey === m.key && j.useCase === u);
    const byCrit = (list: JudgeRecord[]) => {
      const keys = new Set(list.flatMap((j) => Object.keys(j.result?.scores ?? {})));
      return Object.fromEntries([...keys].map((k) => [k, mean(list.map((j) => j.result!.scores![k]?.score).filter((x): x is number => typeof x === 'number'))]));
    };
    const slot = (sl: JudgeSlot) => mine.filter((j) => j.judgeSlot === sl);
    const judgeBy = Object.fromEntries(JUDGE_SLOTS.map((sl) => [sl, mean(slot(sl).map(unitMean).filter((x): x is number => x !== null))])) as Record<JudgeSlot, number | null>;
    const caseIds = [...new Set(mine.map((j) => j.caseId))];
    const judgeMean = mean(caseIds.map((id) => cellJudgeMean(mine, m.key, id)).filter((x): x is number => x !== null));
    const pw = judgements.filter((j) => j.kind === 'pairwise' && j.modelKey === m.key && j.useCase === u && j.result?.outcome && !isSelfJudgement(j));
    const judgeNorm = norm(judgeMean);
    out.push({
      modelKey: m.key, useCase: u, fixed, judgeBy,
      judgeByCriterion: Object.fromEntries(JUDGE_SLOTS.map((sl) => [sl, byCrit(slot(sl))])) as Record<JudgeSlot, Record<string, number | null>>,
      judgeN: Object.fromEntries(JUDGE_SLOTS.map((sl) => [sl, slot(sl).length])) as Record<JudgeSlot, number>,
      judgeMean,
      selfJudgedIgnored: judgements.filter((j) => j.modelKey === m.key && j.useCase === u && isSelfJudgement(j)).length,
      pairwise: wtl(pw), pairwiseBy: Object.fromEntries(JUDGE_SLOTS.map((sl) => [sl, wtl(pw.filter((j) => j.judgeSlot === sl))])) as Record<JudgeSlot, { win: number; tie: number; loss: number } | null>,
      judgeNorm, combined: combine(fixed.fixedScore, judgeNorm),
    });
  }
  return out;
}

export function overall(cards: Scorecard[], modelKey: string, weights: Record<UseCase, number> = WEIGHTS, pickScore: (c: Scorecard) => number | null = (c) => c.combined): number | null {
  let total = 0;
  let w = 0;
  for (const u of USE_CASES) {
    const c = cards.find((x) => x.modelKey === modelKey && x.useCase === u);
    const v = c ? pickScore(c) : null;
    if (v === null) continue;
    total += weights[u] * v;
    w += weights[u];
  }
  return w ? total / w : null;
}

/** Each use-case weight at ×0.75 and ×1.25 (others renormalised): who leads, and whether the ranking moves. */
export function sensitivity(cards: Scorecard[], keys: string[]) {
  const rank = (weights: Record<UseCase, number>) => keys.map((k) => ({ k, s: overall(cards, k, weights) ?? -1 })).sort((a, b) => b.s - a.s).map((x) => x.k);
  const baseline = rank(WEIGHTS);
  const rows: Array<{ useCase: UseCase; factor: number; leader: string; top3: string[]; sameTop3: boolean }> = [];
  for (const u of USE_CASES) for (const f of [0.75, 1.25]) {
    const w = { ...WEIGHTS, [u]: WEIGHTS[u] * f };
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    const normed = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / sum])) as Record<UseCase, number>;
    const r = rank(normed);
    rows.push({ useCase: u, factor: f, leader: r[0], top3: r.slice(0, 3), sameTop3: r.slice(0, 3).join() === baseline.slice(0, 3).join() });
  }
  return { baseline, rows };
}

export function costPer1000(cards: Scorecard[], modelKey: string): number | null {
  let total = 0;
  for (const u of USE_CASES) {
    const c = cards.find((x) => x.modelKey === modelKey && x.useCase === u);
    if (!c || c.fixed.meanCostPerAction === null) return null;
    total += MIX[u] * c.fixed.meanCostPerAction;
  }
  return total;
}

export function judgeReliability(judgements: JudgeRecord[]) {
  const key = (j: JudgeRecord) => `${j.modelKey}|${j.caseId}`;
  const abs = validAbs(judgements);
  const bySlot = Object.fromEntries(JUDGE_SLOTS.map((sl) => [sl, new Map(abs.filter((j) => j.judgeSlot === sl).map((j) => [key(j), j]))])) as Record<JudgeSlot, Map<string, JudgeRecord>>;
  // Self-consistency per judge: the re-judge against that judge's first judgement, criterion by criterion.
  const selfConsistency = {} as Record<JudgeSlot, { kappa: number | null; pairs: number; units: number }>;
  const allA: number[] = [];
  const allB: number[] = [];
  for (const sl of JUDGE_SLOTS) {
    const re = judgements.filter((j) => j.kind === 'rejudge' && j.judgeSlot === sl && j.result?.scores && !isSelfJudgement(j));
    const a1: number[] = [];
    const a2: number[] = [];
    for (const r of re) {
      const first = bySlot[sl].get(key(r));
      if (!first) continue;
      for (const [k, v] of Object.entries(r.result!.scores!)) {
        const f = first.result!.scores![k];
        if (f) { a1.push(f.score); a2.push(v.score); }
      }
    }
    allA.push(...a1);
    allB.push(...a2);
    selfConsistency[sl] = { kappa: cohenKappa(a1, a2), pairs: a1.length, units: re.length };
  }
  // Inter-judge agreement for every pair of judges, on the outputs both scored (never their own).
  const interJudge: Record<string, { kappa: number | null; pairs: number; outputs: number; meanAbsDiff: number | null; within1: number | null }> = {};
  const flagged = new Set<string>();
  for (let i = 0; i < JUDGE_SLOTS.length; i += 1) for (let k = i + 1; k < JUDGE_SLOTS.length; k += 1) {
    const [x, y] = [JUDGE_SLOTS[i], JUDGE_SLOTS[k]];
    const c1: number[] = [];
    const c2: number[] = [];
    const diffs: number[] = [];
    for (const [id, a] of bySlot[x]) {
      const b = bySlot[y].get(id);
      if (!b) continue;
      for (const [crit, v] of Object.entries(a.result!.scores!)) {
        const w = b.result!.scores![crit];
        if (w) { c1.push(v.score); c2.push(w.score); }
      }
      const d = Math.abs(unitMean(a)! - unitMean(b)!);
      diffs.push(d);
      if (d > 1) flagged.add(id);
    }
    interJudge[`${x}-${y}`] = { kappa: cohenKappa(c1, c2), pairs: c1.length, outputs: diffs.length, meanAbsDiff: mean(diffs), within1: diffs.length ? diffs.filter((d) => d <= 1).length / diffs.length : null };
  }
  const failures = judgements.filter((j) => j.failure).length;
  const pairs = Object.values(interJudge);
  const outputs = pairs.reduce((n, p) => n + p.outputs, 0);
  return {
    selfConsistency, selfConsistencyKappa: cohenKappa(allA, allB), rejudgedPairs: allA.length, rejudgedUnits: judgements.filter((j) => j.kind === 'rejudge' && j.result?.scores).length,
    interJudge, interJudgePairs: outputs,
    interJudgeMeanAbsDiff: outputs ? pairs.reduce((s, p) => s + (p.meanAbsDiff ?? 0) * p.outputs, 0) / outputs : null,
    interJudgeWithin1: outputs ? pairs.reduce((s, p) => s + (p.within1 ?? 0) * p.outputs, 0) / outputs : null,
    flaggedOver1: [...flagged], judgeFailures: failures, judgeAdaptations: judgeAdaptations(judgements),
    selfJudgementsIgnored: judgements.filter(isSelfJudgement).length,
  };
}

export interface Recommendation { slot: string; modelKey: string | null; overall: number | null; costPer1000: number | null; p95: number | null; holdsUnder: Record<JudgeSlot, boolean | null>; note: string }

/** Quality first (overall within 0.01 is a tie), then cost per 1,000 interactions, then latency p95. */
export function recommend(cards: Scorecard[], models: EvalModel[]): Recommendation[] {
  const scoreOf = (k: string) => overall(cards, k);
  const p95 = (k: string) => mean(cards.filter((c) => c.modelKey === k).map((c) => c.fixed.actionP95).filter((x): x is number => x !== null));
  const order = (keys: string[], pick: (c: Scorecard) => number | null = (c) => c.combined) => [...keys].sort((a, b) => {
    const sa = overall(cards, a, WEIGHTS, pick) ?? -1;
    const sb = overall(cards, b, WEIGHTS, pick) ?? -1;
    if (Math.abs(sa - sb) > 0.01) return sb - sa;
    const ca = costPer1000(cards, a) ?? Infinity;
    const cb = costPer1000(cards, b) ?? Infinity;
    if (ca !== cb) return ca - cb;
    return (p95(a) ?? Infinity) - (p95(b) ?? Infinity);
  });
  const withScores = (list: EvalModel[]) => list.filter((m) => scoreOf(m.key) !== null).map((m) => m.key);
  // Under one judge alone; a judge's own outputs (which it never scored) keep the other judges' mean.
  const only = (sl: JudgeSlot) => (c: Scorecard) => combine(c.fixed.fixedScore, c.judgeBy[sl] !== null ? norm(c.judgeBy[sl]) : c.judgeNorm);
  const cands = models.filter((m) => m.role === 'candidate');
  const slots: Array<[string, EvalModel[]]> = [
    ['Best on-premise candidate, tier 1 (one 24-48 GB GPU)', cands.filter((m) => m.class === 'onprem' && m.tier === 1)],
    ['Best on-premise candidate, tier 2 (one 80 GB GPU)', cands.filter((m) => m.class === 'onprem' && m.tier === 2)],
    ['Best on-premise candidate overall (one GPU)', cands.filter((m) => m.class === 'onprem')],
    ['Best small cloud model', cands.filter((m) => m.class === 'cloud')],
    ['Best overall for this product', models.filter((m) => m.role === 'candidate' || m.role === 'reference')],
  ];
  return slots.map(([slot, list]) => {
    const keys = withScores(list);
    const none = Object.fromEntries(JUDGE_SLOTS.map((sl) => [sl, null])) as Record<JudgeSlot, boolean | null>;
    if (!keys.length) return { slot, modelKey: null, overall: null, costPer1000: null, p95: null, holdsUnder: none, note: 'no scored model in this class' };
    const best = order(keys)[0];
    const holdsUnder = Object.fromEntries(JUDGE_SLOTS.map((sl) => [sl, cards.some((c) => c.judgeBy[sl] !== null) ? order(keys, only(sl))[0] === best : null])) as Record<JudgeSlot, boolean | null>;
    const vals = Object.values(holdsUnder);
    const note = vals.some((v) => v === false)
      ? `the pick does not hold under every judge alone (fails under judge ${JUDGE_SLOTS.filter((sl) => holdsUnder[sl] === false).join(', ')}; see the per-judge columns)`
      : vals.every((v) => v === true) ? 'holds under judge A, judge B and judge C each alone' : 'judge coverage incomplete';
    return { slot, modelKey: best, overall: scoreOf(best), costPer1000: costPer1000(cards, best), p95: p95(best), holdsUnder, note };
  });
}
