import { JUDGE_SLOTS, REFERENCE_MODEL_ID, type EvalModel, type JudgeSlot } from '../contracts';
import { EVAL_TEMPERATURE } from '../provider/converse';
import type { UnitScore } from '../score/score';
import { mean } from '../score/metrics';
import { FIXED_WEIGHT, JUDGE_WEIGHT, MIX, USE_CASES, WEIGHTS, costPer1000, norm, overall, isSelfJudgement, type JudgeRecord, type Scorecard } from './analysis';
import { BALANCE, REFERENCE_GAP, TARGET_MS, balancedCells, balancedOf, breaches, overallBalanced, planCost, routingPlan, weightVariants, type Cell, type Route, type Weights } from './balanced';

/**
 * The balanced-choice sections of the report: the case for
 * open weights per job, the one-GPU plan (one model on every job), the
 * multi-model routing plan with the GPUs it takes, the balanced
 * recommendations with the quality-only winner beside each, the ±25% weight
 * sensitivity, the weaknesses with their mitigations, and the aggregate rows of
 * scores.csv that every number in those sections is read from.
 *
 * Pick rule: the best balanced score among the models within the 20 s p95 rule;
 * balanced scores within TIE (0.01, the run's noise floor) are a tie, settled by
 * quality, then cost per 1,000 interactions.
 */

export const TIE = 0.01;
const f2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(2));
const f3 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(3));
const sgn3 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(3)}`);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(0)}%`);
const usd = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `$${x.toFixed(2)}`);
const sec = (ms: number | null | undefined) => (ms === null || ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
const wtl = (p: { win: number; tie: number; loss: number } | null | undefined) => (p ? `W${p.win}/T${p.tie}/L${p.loss}` : 'n/a');
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const num = (n: number) => WORDS[n] ?? String(n);

export const BALANCED_CSV_COLUMNS = ['rowType', 'scope', 'quality', 'latencyP95Ms', 'over20sShare', 'latencyTerm', 'balanced', 'balancedEligible', 'costPerAction', 'costPer1000', 'note'];

/** The precision an on-prem model needs to fit its one GPU, read from its models.json hardware line. */
export function oneGpuPrecision(m: EvalModel | undefined): string {
  if (!m || m.class !== 'onprem') return 'n/a (cloud)';
  if (/Int4/.test(m.hardware)) return 'Int4 quantised to fit, not measured at Int4';
  if (/MXFP4/.test(m.hardware)) return 'MXFP4 as released';
  if (/BF16/.test(m.hardware)) return 'BF16 full precision';
  return 'see the hardware table';
}

const MITIGATION: Record<string, string> = {
  invalid_json: 'schema-enforced decoding on the on-prem server (vLLM/TGI/llama.cpp `json_schema`, strict) through the product\'s OpenAI-compatible path; not measured here (Bedrock Converse has no schema enforcement); not fixed in this run',
  malformed_review: 'same as invalid JSON: schema-enforced decoding of the stakeholder-review object; not fixed in this run',
  GUIDED_REPLY_WITHHELD: 'the product\'s guardrail withheld the reply, so the learner got no answer for that turn (counted against the mentor score); not fixed',
  timeout: 'the 20 s p95 rule keeps the model off the job; not fixed',
  context_limit: 'serve with at least 32k context (64k preferred); not fixed in this run',
  refusal: 'not fixed',
  provider_failure: 'one retry in the product; not fixed',
  empty: 'one retry in the product; not fixed',
  missing_positive_evidence: 'the product\'s explanation validator rejected the assessment; not fixed',
  ungrounded_pass: 'refused by the product\'s strict review parser; not fixed',
};

interface Ranked { k: string; b: number | null; q: number | null; breaches: string[] }
interface Choice { pick: Ranked | null; rival: Ranked | null; tied: boolean; tieBroken: boolean; flagged: boolean }

/** Best balanced within the 20 s rule; balanced within TIE is a tie settled by quality, then cost. */
export function choose(rows: Ranked[], cost: (k: string) => number | null): Choice {
  const scored = rows.filter((r) => r.b !== null);
  const clean = scored.filter((r) => !r.breaches.length);
  const pool = clean.length ? clean : scored;
  if (!pool.length) return { pick: null, rival: null, tied: false, tieBroken: false, flagged: false };
  const byB = [...pool].sort((x, y) => y.b! - x.b!);
  const tiedSet = byB.filter((r) => r.b! >= byB[0].b! - TIE);
  const pick = [...tiedSet].sort((x, y) => ((y.q ?? -1) - (x.q ?? -1)) || ((cost(x.k) ?? Infinity) - (cost(y.k) ?? Infinity)) || (y.b! - x.b!))[0];
  const rival = byB.find((r) => r.k !== pick.k) ?? null;
  return { pick, rival, tied: tiedSet.length > 1, tieBroken: pick.k !== byB[0].k, flagged: !clean.length };
}

export function buildBalanced(a: { units: UnitScore[]; judgements: JudgeRecord[]; models: EvalModel[]; scored: EvalModel[]; cards: Scorecard[]; label: (k: string) => string; cls: (k: string) => string; keys: string[] }) {
  const { units, judgements, models, scored, cards, label, cls, keys } = a;
  const { byUseCase, byJob, jobs } = balancedCells(units, judgements, scored, cards);
  const model = (k: string | undefined | null) => models.find((m) => m.key === k);
  const isOnprem = (k: string) => model(k)?.class === 'onprem' && model(k)?.role === 'candidate';
  const refKey = scored.find((m) => m.role === 'reference')?.key ?? null;
  const routes = routingPlan(byJob, jobs, isOnprem, refKey);
  const routeCost = planCost(routes.map((r) => ({ job: r.job, useCase: r.useCase, costPerAction: r.pick?.costPerAction ?? null })));
  const refCost = refKey ? costPer1000(cards, refKey) : null;
  const cost = (k: string) => costPer1000(cards, k);
  const ob = (k: string) => overallBalanced(byUseCase, k);
  const oq = (k: string) => overall(cards, k);
  const balancedRanking = keys.map((k) => ({ k, b: ob(k), q: oq(k), breaches: breaches(byUseCase, k) })).sort((x, y) => (y.b ?? -1) - (x.b ?? -1));
  const useCell = (k: string, u: string) => byUseCase.find((c) => c.modelKey === k && c.useCase === u) ?? null;
  const reviewAcc = (k: string | undefined) => (k ? useCell(k, 'review')?.card.fixed.validatorAcceptRate ?? null : null);
  const reviewFalsePass = (k: string | undefined) => { const v = k ? useCell(k, 'review')?.card.fixed.metrics.falsePass : null; return v === null || v === undefined ? null : Number(v); };

  // ---- quality on a chosen judge panel (exact: per case, mean of the panel's non-self judges) ----
  const unitMean = (j: JudgeRecord) => mean(Object.values(j.result!.scores!).map((x) => x.score));
  const panelQuality = (card: Scorecard, panel: JudgeSlot[], job?: string): number | null => {
    const recs = judgements.filter((j) => j.kind === 'absolute' && j.result?.scores && !isSelfJudgement(j) && j.modelKey === card.modelKey && j.useCase === card.useCase && (!job || j.jobType === job) && j.judgeSlot && panel.includes(j.judgeSlot));
    const byCase = new Map<string, number[]>();
    for (const j of recs) { const v = unitMean(j); if (v !== null) byCase.set(j.caseId, [...(byCase.get(j.caseId) ?? []), v]); }
    const jm = mean([...byCase.values()].map((v) => mean(v)!));
    const fixed = card.fixed.fixedScore;
    const jn = norm(jm);
    return fixed === null ? jn : jn === null ? fixed : FIXED_WEIGHT * fixed + JUDGE_WEIGHT * jn;
  };
  /** Overall balanced and quality with a per-use-case quality function. */
  const overallWith = (k: string, q: (c: Cell) => number | null, w: Weights | typeof BALANCE = BALANCE) => {
    let tb = 0; let tq = 0; let s = 0; let sq = 0;
    for (const u of USE_CASES) {
      const c = useCell(k, u);
      if (!c) continue;
      const qq = q(c);
      const bb = balancedOf(qq, c.latency, w);
      if (bb !== null) { tb += WEIGHTS[u] * bb; s += WEIGHTS[u]; }
      if (qq !== null) { tq += WEIGHTS[u] * qq; sq += WEIGHTS[u]; }
    }
    return { b: s ? tb / s : null, q: sq ? tq / sq : null };
  };
  const ownSlot = (k: string) => model(k)?.judgeSlot ?? null;
  /** One judge alone; a judge's own outputs (which it never scored) keep the other judges' mean, as in the quality-only table. */
  const underJudge = (sl: JudgeSlot) => (c: Cell) => (ownSlot(c.modelKey) === sl ? c.quality : panelQuality(c.card, [sl]));

  const cands = scored.filter((m) => m.role === 'candidate');
  const classes: Array<[string, string[]]> = [
    ['Best on-premise, tier 1 (one 24-48 GB GPU)', cands.filter((m) => m.class === 'onprem' && m.tier === 1).map((m) => m.key)],
    ['Best on-premise, tier 2 (one 80 GB GPU)', cands.filter((m) => m.class === 'onprem' && m.tier === 2).map((m) => m.key)],
    ['Best on-premise overall (one GPU)', cands.filter((m) => m.class === 'onprem').map((m) => m.key)],
    ['Best small cloud model', cands.filter((m) => m.class === 'cloud').map((m) => m.key)],
    ['Best overall for LearnSDLC', scored.map((m) => m.key)],
  ];
  const recs = classes.map(([slot, list]) => {
    const ks = list.filter((k) => keys.includes(k));
    const ranked = balancedRanking.filter((r) => ks.includes(r.k));
    const ch = choose(ranked, cost);
    const pick = ch.pick;
    const qWinner = [...ranked].sort((x, y) => (y.q ?? -1) - (x.q ?? -1))[0] ?? null;
    const nearTie = ch.rival && pick && pick.b !== null && ch.rival.b !== null && Math.abs(pick.b - ch.rival.b) < TIE ? ch.rival : null;
    // Does the pick hold under each judge alone (same rule), and by what balanced margin over the best other model?
    const holds = JUDGE_SLOTS.map((sl) => {
      const rows = ranked.map((r) => ({ ...r, ...overallWith(r.k, underJudge(sl)) }));
      const c = choose(rows, cost);
      const mine = rows.find((r) => r.k === pick?.k);
      const best = rows.filter((r) => r.k !== pick?.k && r.b !== null && !r.breaches.length).sort((x, y) => y.b! - x.b!)[0];
      return { sl, holds: !!pick && c.pick?.k === pick.k, margin: mine?.b !== null && mine?.b !== undefined && best ? mine.b - best.b! : null, other: best?.k ?? null, winner: c.pick?.k ?? null };
    });
    // Same judge panel for the pick and its near-tie rival (neither judge-model judged by fewer judges than the other).
    let samePanel: { panel: JudgeSlot[]; pick: { b: number | null; q: number | null }; rival: { b: number | null; q: number | null } } | null = null;
    if (pick && nearTie) {
      const panel = JUDGE_SLOTS.filter((sl) => sl !== ownSlot(pick.k) && sl !== ownSlot(nearTie.k));
      if (panel.length < JUDGE_SLOTS.length) {
        const pq = (c: Cell) => panelQuality(c.card, panel);
        samePanel = { panel, pick: overallWith(pick.k, pq), rival: overallWith(nearTie.k, pq) };
      }
    }
    return { slot, pick, qWinner, runnerUp: nearTie, tieBroken: ch.tieBroken, cost: pick ? cost(pick.k) : null, flagged: ch.flagged, holds, samePanel };
  });
  const variants = weightVariants();
  const sens = variants.map((w) => {
    const order = keys.map((k) => ({ k, b: overallBalanced(byUseCase, k, w), q: oq(k), breaches: breaches(byUseCase, k) })).sort((x, y) => (y.b ?? -1) - (x.b ?? -1));
    const onpremPick = choose(order.filter((o) => isOnprem(o.k)), cost).pick;
    const rt = routingPlan(byJob, jobs, isOnprem, refKey, w);
    const onpremTop = order.filter((o) => isOnprem(o.k) && !o.breaches.length)[0] ?? null;
    return { w, leader: order[0], top3: order.slice(0, 3).map((o) => o.k), onpremLeader: onpremPick, onpremTop, routes: rt.map((r) => r.pick?.modelKey ?? null) };
  });
  const sensBase = sens[0];
  const pickSet = [...new Set(sens.map((v) => v.onpremLeader?.k).filter((k): k is string => !!k))];
  const topCount = new Map<string, number>();
  for (const v of sens) if (v.onpremTop) topCount.set(v.onpremTop.k, (topCount.get(v.onpremTop.k) ?? 0) + 1);
  const stability = () => `${pickSet.length === 1 ? `with the tie rule the on-prem pick is ${label(pickSet[0])} under all ${sens.length} weightings` : `the on-prem pick changes with the weights (${pickSet.map((k) => label(k)).join(', ')})`}; on balanced alone the lead ${topCount.size > 1 ? `alternates (${[...topCount.entries()].map(([k, n]) => `${label(k)} ${n} of ${sens.length}`).join(', ')})` : `stays with ${label([...topCount.keys()][0])}`}`;
  const unstable = jobs.map((job, i) => ({ job, picks: [...new Set(sens.map((v) => v.routes[i]).filter((k): k is string => !!k))] })).filter((x) => x.picks.length > 1);

  // ---- plans ----
  const planModels = [...new Set(routes.map((r) => r.pick?.modelKey).filter((k): k is string => !!k))];
  const gpuNeed = (ks: string[]) => {
    const t2 = ks.filter((k) => model(k)?.tier === 2).length;
    const t1 = ks.filter((k) => model(k)?.tier === 1).length;
    const parts = [t2 ? `${num(t2)} 80 GB GPU${t2 > 1 ? 's' : ''}` : '', t1 ? `${num(t1)} 24-48 GB GPU${t1 > 1 ? 's' : ''}` : ''].filter(Boolean);
    return { total: t1 + t2, text: parts.join(' and ') };
  };
  const need = gpuNeed(planModels);
  const multiTitle = need.total > 1 ? `Routing plan (multi-model: needs about ${need.text}, not one GPU)` : 'Routing plan (one GPU)';
  const single = recs[2];
  const sk = single.pick?.k;
  const ref = (job: string) => byJob.find((c) => c.job === job && c.modelKey === refKey) ?? null;
  const jobCell = (job: string, k?: string | null) => byJob.find((c) => c.job === job && c.modelKey === k) ?? null;
  const singleGap = (job: string) => { const c = jobCell(job, sk); const r = ref(job); return c?.quality !== null && c?.quality !== undefined && r?.quality !== null && r?.quality !== undefined ? c.quality - r.quality : null; };
  const singleClose = jobs.filter((j) => { const g = singleGap(j); return g !== null && g >= -REFERENCE_GAP; }).length;
  const singlePlanCost = sk ? cost(sk) : null;
  type WTL = { win: number; tie: number; loss: number };
  const sumW = (list: Array<WTL | null | undefined>): WTL => list.reduce<WTL>((acc, p) => ({ win: acc.win + (p?.win ?? 0), tie: acc.tie + (p?.tie ?? 0), loss: acc.loss + (p?.loss ?? 0) }), { win: 0, tie: 0, loss: 0 });
  const routePw = sumW(routes.map((r) => r.pick?.card.pairwise));
  const routeLostMore = routes.filter((r) => r.pick?.card.pairwise && r.pick.card.pairwise.loss > r.pick.card.pairwise.win).length;
  const singlePw = sumW(jobs.map((j) => jobCell(j, sk)?.card.pairwise));
  const singleLostMore = jobs.filter((j) => { const p = jobCell(j, sk)?.card.pairwise; return p && p.loss > p.win; }).length;
  const reviewRoutes = routes.filter((r) => r.useCase === 'review' && r.pick);
  const fixedRange = (xs: Array<number | null | undefined>) => { const v = xs.filter((x): x is number => typeof x === 'number'); return v.length ? `${f2(Math.min(...v))}-${f2(Math.max(...v))}` : 'n/a'; };
  const pickFixed = fixedRange(reviewRoutes.map((r) => r.pick!.card.fixed.fixedScore));
  const refFixed = fixedRange(reviewRoutes.map((r) => ref(r.job)?.card.fixed.fixedScore));
  const pwSentence = (who: string, p: { win: number; tie: number; loss: number }, lost: number, of: number) => `In blind, position-swapped comparisons against the reference, ${who} won ${p.win}, tied ${p.tie} and lost ${p.loss}; the judges preferred the reference ${lost === of ? 'on every job' : `on ${lost} of ${of} jobs`}.`;
  // Self-exclusion asymmetry: a judge-model pick is scored by the other judges only; the reference by all three.
  const panelGaps = routes.filter((r) => r.pick && ownSlot(r.pick.modelKey) && ref(r.job)).map((r) => {
    const panel = JUDGE_SLOTS.filter((sl) => sl !== ownSlot(r.pick!.modelKey));
    const rq = panelQuality(ref(r.job)!.card, panel, r.job);
    return { job: r.job, panel, gap: r.gap, same: r.pick!.quality !== null && rq !== null ? r.pick!.quality - rq : null };
  });
  const L = (k: string | null | undefined) => (k ? label(k) : 'none');
  const tierOf = (k: string | null | undefined) => { const t = model(k)?.tier; return t ? `tier ${t}` : 'n/a'; };
  const int4 = models.filter((m) => m.role === 'candidate' && m.class === 'onprem' && /Int4/.test(m.hardware));
  const int4Caveat = int4.map((m) => `${label(m.key)} fits one 80 GB GPU only at Int4; its quality here was measured on Bedrock's hosted weights, and quality at Int4 was not measured.`).join(' ');
  const holdsText = (r: (typeof recs)[number]) => (r.pick ? r.holds.map((h) => `${h.sl} ${h.holds ? 'yes' : `no (${L(h.winner)})`} ${sgn3(h.margin)}`).join('; ') : 'n/a');
  const tradeRow = (k: string) => { const r = balancedRanking.find((x) => x.k === k)!; return [L(k), tierOf(k), oneGpuPrecision(model(k)), f3(r.b), f3(r.q), usd(cost(k)), pct(reviewAcc(k)), String(reviewFalsePass(k) ?? 'n/a'), r.breaches.join(', ') || 'none']; };
  const tradeHead = ['Model', 'Tier', 'Precision on one GPU', 'Balanced', 'Quality', 'Cost / 1,000', 'Review validator acceptance', 'Review false passes', 'p95 over 20 s on'];
  const tieNote = (r: (typeof recs)[number]) => (r.runnerUp && r.pick ? `${L(r.pick.k)} and ${L(r.runnerUp.k)} are a tie within noise (balanced ${f3(r.pick.b)} vs ${f3(r.runnerUp.b)}, under the ${TIE.toFixed(2)} noise floor)${r.tieBroken ? `; the tie is settled by quality (${f3(r.pick.q)} vs ${f3(r.runnerUp.q)}), then cost (${usd(cost(r.pick.k))} vs ${usd(cost(r.runnerUp.k))} per 1,000)` : ''}${r.samePanel ? `; scored by the same judges (${r.samePanel.panel.join('+')}, per-case mean as in the main score) the balanced scores are ${f3(r.samePanel.pick.b)} vs ${f3(r.samePanel.rival.b)}` : ''}.` : '');

  // ------------------------------ scores.csv rows ------------------------------
  const rows: Array<Record<string, unknown>> = [];
  const cellRow = (c: Cell, rowType: string, note = '') => ({
    rowType, scope: c.scope, model: c.modelKey, class: cls(c.modelKey), jobType: c.scope === 'jobType' ? c.job : '', useCase: c.useCase, calls: undefined,
    quality: c.quality?.toFixed(4), latencyP95Ms: c.p95 === null ? '' : Math.round(c.p95), over20sShare: c.over20?.toFixed(4), latencyTerm: c.latency?.toFixed(4), balanced: c.balanced?.toFixed(4), balancedEligible: c.eligible, costPerAction: c.costPerAction?.toFixed(6),
    judgeA_mean: c.card.judgeBy.A?.toFixed(2), judgeB_mean: c.card.judgeBy.B?.toFixed(2), judgeC_mean: c.card.judgeBy.C?.toFixed(2), judges_nonself_mean: c.card.judgeMean?.toFixed(2),
    jsonRawValid: c.card.fixed.jsonRawValidRate?.toFixed(4), jsonValidAfterFence: c.card.fixed.jsonAfterFenceRate?.toFixed(4), accepted: c.card.fixed.validatorAcceptRate?.toFixed(4), falsePass: c.card.fixed.metrics.falsePass ?? '',
    pairwise_by_judge: c.card.pairwise ? `W${c.card.pairwise.win}/T${c.card.pairwise.tie}/L${c.card.pairwise.loss}` : '', note,
  });
  for (const c of byUseCase) rows.push(cellRow(c, 'useCase', `fixed=${f2(c.card.fixed.fixedScore)}`));
  for (const c of byJob) rows.push(cellRow(c, 'jobType'));
  for (const r of balancedRanking) rows.push({ rowType: 'overall', scope: 'all', model: r.k, class: cls(r.k), quality: r.q?.toFixed(4), balanced: r.b?.toFixed(4), costPer1000: cost(r.k)?.toFixed(4), note: r.breaches.length ? `p95 over 20 s on: ${r.breaches.join(' ')}` : '' });
  for (const r of routes) if (r.pick) rows.push({ ...cellRow(r.pick, 'route', `${r.note}; gap ${r.gap?.toFixed(4)}`), quality: r.pick.quality?.toFixed(4), costPer1000: '' });
  rows.push({ rowType: 'plan', scope: 'routing plan (multi-model)', model: 'routing-plan', costPer1000: routeCost?.toFixed(4), note: `models: ${planModels.join(' ')}; GPUs: ${need.text}; pairwise vs reference W${routePw.win}/T${routePw.tie}/L${routePw.loss}` });
  if (sk) rows.push({ rowType: 'plan', scope: 'one-GPU plan (single model)', model: sk, costPer1000: singlePlanCost?.toFixed(4), note: `jobs within ${REFERENCE_GAP} of the reference: ${singleClose}/${jobs.length}; pairwise vs reference W${singlePw.win}/T${singlePw.tie}/L${singlePw.loss}` });
  for (const v of sens) rows.push({ rowType: 'sensitivity', scope: v.w.name, model: v.leader?.k, quality: v.w.quality.toFixed(4), latencyTerm: v.w.latency.toFixed(4), balanced: v.leader?.b?.toFixed(4), note: `top3=${v.top3.join(' ')}; on-prem pick=${v.onpremLeader?.k ?? 'none'}; routes=${v.routes.join(' ')}` });
  for (const r of recs) if (r.pick) rows.push({ rowType: 'recommendation', scope: r.slot, model: r.pick.k, class: cls(r.pick.k), quality: r.pick.q?.toFixed(4), balanced: r.pick.b?.toFixed(4), costPer1000: r.cost?.toFixed(4), note: `quality-only winner=${r.qWinner?.k}${r.runnerUp ? `; tie (< ${TIE}) with ${r.runnerUp.k} balanced=${r.runnerUp.b?.toFixed(4)} quality=${r.runnerUp.q?.toFixed(4)}${r.tieBroken ? '; settled by quality then cost' : ''}` : ''}; holds under each judge alone: ${r.holds.map((h) => `${h.sl}=${h.holds}(${h.margin?.toFixed(4)})`).join(' ')}${r.flagged ? '; every model in this class breaches the 20 s rule on some job' : ''}` });

  // ------------------------------- narrative ------------------------------------
  const md: string[] = [];
  md.push(`## Can open-weight models on one GPU run LearnSDLC's AI jobs?`, '');
  md.push(`Picks use the **balanced score** (quality ${BALANCE.quality} + latency ${BALANCE.latency}, defined below), against the cloud reference ${REFERENCE_MODEL_ID}. Quality = the per-job combined score (${FIXED_WEIGHT} × fixed metrics + ${JUDGE_WEIGHT} × judges, 0-1). "Gap" = open-weight quality − reference quality on the same job. A model whose action p95 exceeds 20 s on a job is not eligible for that job. Balanced scores within ${TIE.toFixed(2)} are a tie within noise (one run per model), settled by quality, then cost.`, '');
  if (single.pick) {
    md.push(`- **On one GPU (one model on every job):** ${L(sk)} (${tierOf(sk)}, ${oneGpuPrecision(model(sk))}): balanced ${f3(single.pick.b)}, quality ${f3(single.pick.q)}, ${usd(singlePlanCost)} per 1,000 learner interactions (reference ${usd(refCost)}); within ${REFERENCE_GAP.toFixed(2)} of the reference's quality on ${singleClose} of ${jobs.length} jobs. ${pwSentence('it', singlePw, singleLostMore, jobs.length)} Details: "One-GPU plan" below.`);
    if (single.runnerUp) md.push(`- **Tie for the one-GPU pick:** ${tieNote(single)} The full trade-off is in the Recommendations section.`);
  }
  md.push(`- **With several GPUs (one model per job, the table below):** the per-job picks use ${num(planModels.length)} models, which together need about ${need.text}; ${usd(routeCost)} per 1,000 interactions.`, '');
  md.push(`The best open-weight result per product job (the multi-model routing plan's picks):`, '');
  md.push(table(['Job', 'Open-weight pick (balanced)', 'Tier', 'Quality', 'Action p95', '> 20 s', 'Balanced', 'Reference quality / p95', 'Gap', 'Pairwise vs reference (W/T/L)', 'Quality-only open-weight winner (p95)'],
    routes.map((r) => { const rf = ref(r.job); return [r.job, L(r.pick?.modelKey), tierOf(r.pick?.modelKey), f2(r.pick?.quality), sec(r.pick?.p95), pct(r.pick?.over20), f2(r.pick?.balanced), `${f2(rf?.quality)} / ${sec(rf?.p95)}`, f3(r.gap), wtl(r.pick?.card.pairwise), r.qualityWinner ? `${L(r.qualityWinner.modelKey)} ${f2(r.qualityWinner.quality)} (${sec(r.qualityWinner.p95)}${r.qualityWinner.eligible ? '' : ', over 20 s: not eligible'})` : 'n/a']; })), '');
  const close = routes.filter((r) => r.pick && !r.referenceAdvisable);
  md.push(`On ${close.length} of ${routes.length} jobs the balanced open-weight pick is within ${REFERENCE_GAP.toFixed(2)} of the reference's quality; on ${routes.length - close.length} it trails by more than ${REFERENCE_GAP.toFixed(2)} (listed in the routing plan as "reference advisable"). ${pwSentence('the routed picks', routePw, routeLostMore, routes.length)} The combined gap is small on the reviews mainly because the fixed checks (weight ${FIXED_WEIGHT}) are near-saturated there: fixed score ${pickFixed} for the picks and ${refFixed} for the reference.`, '');

  if (single.pick) {
    md.push(`## One-GPU plan: one model on every job`, '');
    md.push(`${L(sk)} on every job, loaded alone on one GPU (${tierOf(sk)}, ${oneGpuPrecision(model(sk))}): balanced ${f3(single.pick.b)}, quality ${f3(single.pick.q)}, ${usd(singlePlanCost)} per 1,000 interactions${single.pick.breaches.length ? `; p95 over 20 s on ${single.pick.breaches.join(', ')}` : '; within the 20 s p95 rule on every use-case'}; review validator acceptance ${pct(reviewAcc(sk))}, review false passes ${reviewFalsePass(sk) ?? 'n/a'}.${single.runnerUp ? ` A tie within noise with ${L(single.runnerUp.k)} (balanced ${f3(single.runnerUp.b)}), settled by quality, then cost; the full trade-off is under Recommendations.` : ''}`, '');
    md.push(table(['Job', `${L(sk)}: quality / p95`, 'Reference quality / p95', 'Gap', 'Pairwise vs reference (W/T/L)', ...(single.runnerUp ? [`${L(single.runnerUp.k)}: quality / p95`] : [])], jobs.map((j) => {
      const fmt = (x: Cell | null) => (x ? `${f2(x.quality)} / ${sec(x.p95)}${x.eligible ? '' : ' ✗'}` : 'not run');
      const c = jobCell(j, sk);
      return [j, fmt(c), fmt(ref(j)), f3(singleGap(j)), wtl(c?.card.pairwise), ...(single.runnerUp ? [fmt(jobCell(j, single.runnerUp.k))] : [])];
    })), '');
  }

  md.push(`## ${multiTitle}`, '');
  if (need.total > 1) md.push(`This plan does not fit one GPU: it serves ${num(planModels.length)} models, one GPU each (${planModels.map((k) => `${L(k)}, ${tierOf(k)}`).join('; ')}). On one GPU use the one-GPU plan above.`, '');
  md.push(`Per job, the open-weight model with the best balanced score among those whose action p95 is at most 20 s. The cloud reference is marked advisable where the pick trails it by more than ${REFERENCE_GAP.toFixed(2)} in quality. "JSON raw / after fence" shows where the harness-side format adaptation (one json fence stripped, recorded per call) closed a parsing gap; a schema-enforcing on-prem server would do the same in production.`, '');
  md.push(table(['Job', 'Route to', 'Balanced', 'Action p95', 'Cost / action', 'JSON raw / after fence', 'Review false passes', 'Pairwise vs reference (W/T/L)', 'Cloud reference advisable'],
    routes.map((r) => [r.job, r.pick ? `${L(r.pick.modelKey)} (${cls(r.pick.modelKey)})` : 'none eligible', f2(r.pick?.balanced), sec(r.pick?.p95), r.pick?.costPerAction === null || !r.pick ? 'n/a' : `$${r.pick.costPerAction.toFixed(5)}`, r.pick ? `${pct(r.pick.card.fixed.jsonRawValidRate)} / ${pct(r.pick.card.fixed.jsonAfterFenceRate)}` : 'n/a', r.useCase === 'review' && r.pick ? String(r.pick.card.fixed.metrics.falsePass ?? 'n/a') : '—', wtl(r.pick?.card.pairwise), r.referenceAdvisable ? `yes (gap ${f3(r.gap)})` : 'no'])), '');
  md.push(`- **Cost per 1,000 learner interactions for this plan:** ${usd(routeCost)} at Bedrock on-demand prices for the same weights (mix ${USE_CASES.map((u) => `${MIX[u]} ${u}`).join(', ')}; the review share is split equally across the review jobs), against ${usd(refCost)} for the reference alone${sk ? ` and ${usd(singlePlanCost)} for the one-GPU plan` : ''}. On-premise the marginal cost is the GPU's, not a per-token price; these figures size the token load.`);
  md.push(`- **Models in the plan:** ${planModels.map((k) => `${L(k)} (${cls(k)}, ${oneGpuPrecision(model(k))})`).join(', ')}.`);
  if (unstable.length) md.push(`- **Unstable routes:** ${unstable.map((u) => `${u.job} changes pick under the ±25% weights (${u.picks.map(L).join(', ')})`).join('; ')}; treat ${unstable.length > 1 ? 'these routes' : 'this route'} as undecided.`);
  md.push(`- **Deterministic checks + a small decider (phase 3):** not run in this evaluation (the decider tier was not built). In every review job the deterministic half of the evidence already comes from the product's own grader, frozen and identical for every model; the model writes the verdict over it, and the product's strict review parser refuses ungrounded passes.`, '');

  md.push(`## Recommendations (balanced score; quality-only winner beside each)`, '');
  md.push(table(['Recommendation', 'Balanced pick', 'Precision on one GPU', 'Balanced (0-1)', 'Quality (0-1)', 'Cost / 1,000', 'Review acceptance / false passes', 'Holds under each judge alone (margin)', 'Quality-only winner', 'Its quality / balanced', 'Its p95 rule breaches', 'Tie (balanced within 0.01)'],
    recs.map((r) => [r.slot, L(r.pick?.k), oneGpuPrecision(model(r.pick?.k)), f3(r.pick?.b), f3(r.pick?.q), usd(r.cost), `${pct(reviewAcc(r.pick?.k))} / ${reviewFalsePass(r.pick?.k) ?? 'n/a'}`, holdsText(r), L(r.qWinner?.k), `${f2(r.qWinner?.q)} / ${f2(r.qWinner?.b)}`, r.qWinner?.breaches.join(', ') || 'none', r.runnerUp ? `${L(r.runnerUp.k)} (${f3(r.runnerUp.b)} balanced, ${f3(r.runnerUp.q)} quality)${r.tieBroken ? '; settled by quality, then cost' : ''}` : '—'])), '');
  md.push(`A class pick must have action p95 at most 20 s on every use-case; if no model in a class does, the best balanced model is named and flagged.${recs.filter((r) => r.flagged).map((r) => ` Flagged: ${r.slot}.`).join('')} "Holds under each judge alone": the same rule applied with only that judge's scores (a judge's own outputs keep the other judges' mean); the margin is the pick's balanced score minus the best other model's in the class under that judge (a negative margin within ${TIE.toFixed(2)} is a tie settled by quality).`, '');
  const tied = recs.filter((r) => r.runnerUp && r.pick);
  const tiePairs = [...new Map(tied.map((r) => [`${r.pick!.k}|${r.runnerUp!.k}`, r])).values()];
  for (const r of tiePairs) {
    md.push(`**Tie: ${L(r.pick!.k)} / ${L(r.runnerUp!.k)}** (${tied.filter((x) => x.pick!.k === r.pick!.k && x.runnerUp!.k === r.runnerUp!.k).map((x) => x.slot).join('; ')}). ${tieNote(r)}`, '');
    md.push(table(tradeHead, [tradeRow(r.pick!.k), tradeRow(r.runnerUp!.k)]), '');
  }

  md.push(`## Balanced score: formula, ranking and sensitivity`, '');
  md.push(`- balanced = ${BALANCE.quality} × quality + ${BALANCE.latency} × latency, both 0-1, per use-case and per job; overall = the use-case weights (${USE_CASES.map((u) => `${u} ${WEIGHTS[u]}`).join(', ')}) applied to the per-use-case balanced scores.`);
  md.push(`- latency = min(p95 term, share term); p95 term = clamp((30 s − action p95) / 20 s, 0, 1), 1 at p95 ≤ 10 s and 0 at ≥ 30 s; share term = clamp((10% − share of calls over 20 s) / 10%, 0, 1), 1 at 0% and 0 at ≥ 10%. Action p95 is over learner actions (a full turn, a review, a proposal); the share over 20 s is over model calls. Target: the product's ${TARGET_MS / 1000} s per action.`);
  md.push(`- Eligibility: action p95 > 20 s on a job ⇒ not recommended for that job, whatever its quality.`);
  md.push(`- Ties: balanced scores within ${TIE.toFixed(2)} are not separable from noise (one run per model); the pick among tied models is the higher quality, then the lower cost per 1,000 interactions.`, '');
  md.push(table(['#', 'Model', 'Class', 'Balanced', 'Quality only', ...USE_CASES.map((u) => `${u} p95`), 'p95 over 20 s on'], balancedRanking.map((r, i) => [String(i + 1), L(r.k), cls(r.k), f3(r.b), f3(r.q), ...USE_CASES.map((u) => sec(useCell(r.k, u)?.p95)), r.breaches.join(', ') || '—'])), '');
  md.push(`Sensitivity: each of the two weights ×0.75 and ×1.25, renormalised to sum 1.`, '');
  md.push(table(['Weights', 'Quality / latency', 'Leader (incl. reference)', 'Top three', 'On-prem balanced leader within 20 s', 'On-prem pick (ties within 0.01 by quality)', 'Routing changes vs baseline'], sens.map((v) => { const ch = jobs.map((j, i) => ({ j, k: v.routes[i], was: sensBase.routes[i] })).filter((x) => x.k !== x.was); return [v.w.name, `${v.w.quality.toFixed(2)} / ${v.w.latency.toFixed(2)}`, `${L(v.leader?.k)} ${f3(v.leader?.b)}`, v.top3.map(L).join(', '), `${L(v.onpremTop?.k)} ${f3(v.onpremTop?.b)}`, `${L(v.onpremLeader?.k)} ${f3(v.onpremLeader?.b)}`, ch.length ? ch.map((x) => `${x.j}: ${L(x.was)} → ${L(x.k)}`).join('; ') : 'none']; })), '');
  if (unstable.length) md.push(`Unstable: ${unstable.map((u) => `the ${u.job} route takes ${num(u.picks.length)} different picks across the five weightings (${u.picks.map(L).join(', ')})`).join('; ')}.`, '');

  md.push(`## Per-job latency table`, '');
  md.push(table(['Job', ...keys.map(L)], jobs.map((j) => [j, ...keys.map((k) => { const c = jobCell(j, k); return c ? `${sec(c.p95)}${c.eligible ? '' : ' ✗'}` : 'not run'; })])), '');
  md.push(`✗ = action p95 over 20 s (not eligible for that job). Measured from this Mac against Bedrock-hosted weights (and OpenAI for the reference), one request in flight per model; on-prem latency depends on the sponsor's GPU and serving stack.`, '');

  md.push(`## Corpus provenance and label tiers (as the corpus documents them)`, '');
  md.push(`- **Sources:** recorded runs of the product on a hosted instance, on TaskTrackr and on the Shelf starter pack, the demo solution, a real TaskTrackr journey (one passing workspace per phase with its full deterministic report), the grading-boundary verification scenarios, the AI-request golden inputs, diagnostics written before any paid call, pack content (scaffolds, solutions, reference suites, transplanted mutants, planted Shelf defects) and bait/probe turns written for this corpus. No learner data.`);
  md.push(`- **Label tiers:** *recorded* = what the production model (${REFERENCE_MODEL_ID}) returned on a real submission and the evaluator accepted: the reference model's judgement, not independent ground truth, so it can favour the reference; *authored* = expectations written before any paid call; *rule* = follows from the product's own rules (precheck, scaffold gaps, planted defects, stated hard rules); *pack-reference* = the pack's own solution or suites; *unlabelled* = no verdict known (still measures validity, schema, latency, cost, guardrails, and feeds the judges).`);
  md.push(`- **Small pass sets:** each review phase has 28-35 cases with only 2-5 real or pack-reference passes, so pass precision rests on a small set; false-pass rate and needs-revision recall are the headline review numbers.`, '');
  md.push(`## Limitations`, '');
  md.push(`- One run per model at temperature ${EVAL_TEMPERATURE}; no repeat runs, so small differences (under about 0.01-0.02) are not separable from noise. Balanced scores within ${TIE.toFixed(2)} are treated as ties and settled by quality, then cost${single.runnerUp ? `; the one-GPU pick is such a tie (${L(sk)} / ${L(single.runnerUp.k)}): ${stability()} (sensitivity table)` : ''}.`);
  if (int4Caveat) md.push(`- ${int4Caveat}`);
  md.push(`- Latency was measured from this Mac against Bedrock-hosted weights (one request in flight per model) and the reference over the public OpenAI API; on-premise latency depends on the sponsor's GPU, quantisation and serving stack, and was not measured.`);
  md.push(`- JSON validity was measured without schema-enforced decoding (Bedrock Converse has none); an on-prem server that enforces the schema should remove most invalid-JSON and malformed-review failures, but that is not measured here.`);
  md.push(`- The three judges are also candidates (self-exclusion enforced); recorded labels come from the reference model; the decider tier (phase 3) was not run.`);
  if (panelGaps.length) md.push(`- Self-exclusion asymmetry: the three judge-models are scored by the other two judges (${models.filter((m) => m.judgeSlot).map((m) => `${label(m.key)} by ${JUDGE_SLOTS.filter((sl) => sl !== m.judgeSlot).join('+')}`).join(', ')}), everyone else by all three. Rescoring the reference on the routed pick's panel moves the gaps: ${panelGaps.map((g) => `${g.job} ${sgn3(g.gap)} → ${sgn3(g.same)} (${g.panel.join('+')})`).join(', ')}. ${panelGaps.every((g) => (g.gap ?? 0) >= -REFERENCE_GAP === ((g.same ?? 0) >= -REFERENCE_GAP)) ? `No job crosses the ${REFERENCE_GAP.toFixed(2)} line, so the routing conclusions do not change.` : `Some jobs cross the ${REFERENCE_GAP.toFixed(2)} line on the same panel.`}`);
  md.push(`- The pairwise comparisons are blind and position-swapped, but judges also show position bias (Judge reliability); a win needs both orders to agree, so position-biased pairs count as ties.`);
  md.push(`- Cost per 1,000 interactions uses Bedrock on-demand prices for the same weights; the on-prem cost is the GPU, not measured here. A multi-model routing plan needs GPU memory for every model it serves at once.`, '');
  md.push(`## Weaknesses and mitigations (every failure, per model)`, '');
  const failRows: string[][] = [];
  for (const k of keys) {
    const counts: Record<string, Record<string, number>> = {};
    for (const c of byUseCase.filter((x) => x.modelKey === k)) for (const [f, n] of Object.entries(c.card.fixed.failures)) (counts[f] ??= {})[c.useCase] = n;
    for (const [f, byU] of Object.entries(counts)) failRows.push([L(k), f, Object.entries(byU).map(([u, n]) => `${u} ${n}`).join(', '), MITIGATION[f] ?? 'not fixed']);
  }
  md.push(failRows.length ? table(['Model', 'Failure', 'Cases (by use-case)', 'Mitigation'], failRows) : 'No failures recorded.', '');

  // ----------------------------- sponsor one-pager -------------------------------
  const r2 = recs[2];
  const summary = [
    `# LearnSDLC AI on one GPU: summary for the sponsor`, '',
    `LearnSDLC from SMU SCIS. Open-weight models that fit on one GPU were tested on LearnSDLC's own AI jobs against the cloud model the product uses (${REFERENCE_MODEL_ID}). Picks use a balanced score: quality ${BALANCE.quality}, latency ${BALANCE.latency}. A model is not used for a job if more than 5% of its actions on that job take longer than 20 s (action p95 over 20 s). Balanced scores within ${TIE.toFixed(2)} are a tie within noise, settled by quality, then cost.`, '',
    `## Routing plan on one GPU: one model for every job`, '',
    ...(r2.pick ? [
      `**${L(sk)}** (${tierOf(sk)}, ${oneGpuPrecision(model(sk))}) on every job: balanced ${f3(r2.pick.b)}, quality ${f3(r2.pick.q)}, ${usd(singlePlanCost)} per 1,000 learner interactions; action p95 within 20 s on every job; within ${REFERENCE_GAP.toFixed(2)} of the reference's quality on ${singleClose} of ${jobs.length} jobs. ${pwSentence('it', singlePw, singleLostMore, jobs.length)}`, '',
      ...(r2.runnerUp ? [`${tieNote(r2)}`, '', table(tradeHead, [tradeRow(r2.pick.k), tradeRow(r2.runnerUp.k)]), ''] : []),
    ] : ['No open-weight model is within the 20 s rule on every job.', '']),
    `## ${need.total > 1 ? `Routing plan with several GPUs (needs about ${need.text})` : 'Routing plan per job'}`, '',
    need.total > 1 ? `One model per job; this does not fit one GPU (${num(planModels.length)} models, one GPU each).` : '', '',
    table(['Job', 'Open-weight model', 'Quality (reference)', 'Gap', 'Pairwise vs reference (W/T/L)', 'Action p95', 'Cloud advisable'], routes.map((r) => [r.job, r.pick ? `${L(r.pick.modelKey)} (${cls(r.pick.modelKey)})` : 'none within 20 s', `${f2(r.pick?.quality)} (${f2(ref(r.job)?.quality)})`, f3(r.gap), wtl(r.pick?.card.pairwise), sec(r.pick?.p95), r.referenceAdvisable ? 'yes' : 'no'])), '',
    `${pwSentence('the routed picks', routePw, routeLostMore, routes.length)} The combined gap is small on reviews mainly because the fixed checks are near-saturated there (fixed score ${pickFixed} for the picks, ${refFixed} for the reference).${unstable.length ? ` Unstable: ${unstable.map((u) => `${u.job} (${u.picks.map(L).join(' / ')} across the ±25% weights)`).join('; ')}.` : ''}`, '',
    `## Recommendations`, '',
    ...[recs[2], recs[3], recs[4]].map((r) => `- **${r.slot}:** ${L(r.pick?.k)}, balanced ${f3(r.pick?.b)}, quality ${f3(r.pick?.q)}, ${usd(r.cost)} per 1,000 interactions${r.runnerUp ? ` (tie with ${L(r.runnerUp.k)}, balanced ${f3(r.runnerUp.b)}${r.tieBroken ? '; settled by quality, then cost' : ''})` : ''}. Best on quality alone: ${L(r.qWinner?.k)} (${f2(r.qWinner?.q)})${r.qWinner?.breaches.length ? `, but its action p95 is over 20 s on ${r.qWinner.breaches.join(', ')}` : ''}.`),
    `- Per tier: tier 1, ${L(recs[0].pick?.k)} (balanced ${f3(recs[0].pick?.b)}); tier 2, ${L(recs[1].pick?.k)} (balanced ${f3(recs[1].pick?.b)})${recs[1].runnerUp ? `, tied with ${L(recs[1].runnerUp.k)} (${f3(recs[1].runnerUp.b)})` : ''}.`, '',
    `## Cost`, '',
    `On one GPU, ${L(sk)} costs ${usd(singlePlanCost)} per 1,000 learner interactions at Bedrock prices for the same weights. The multi-model routing plan costs ${usd(routeCost)}. The reference alone costs ${usd(refCost)}. On-premise, the cost is the GPU itself, not a price per token.`, '',
    `## Caveats`, '',
    `- Quality was measured on Bedrock-hosted copies of the same open weights. On-premise latency depends on the sponsor's GPU and serving stack and was not measured.`,
    ...(int4Caveat ? [`- ${int4Caveat}`] : []),
    `- Several models sometimes returned malformed JSON (counts per model in report.md). The product's validators rejected those replies, so the learner got no answer for that action. A serving stack that forces valid JSON (schema-enforced decoding) should fix this, but that was not measured here.`,
    `- One run per model: differences under about 0.01-0.02 are noise.${r2.runnerUp ? ` The one-GPU pick is a tie settled by quality, then cost; under ±25% weights ${stability()} (report.md, sensitivity).` : ''}`,
    `- gpt-oss models cannot turn reasoning off; they ran at the minimum setting. Thinking was off for every other model.`,
    `- The small-decider tier was not run. Weaknesses and mitigations are listed in full in report.md.`,
  ].join('\n');

  const rankings = { formula: { quality: BALANCE.quality, latency: BALANCE.latency, latency_term: 'min(clamp((30s-p95)/20s), clamp((10%-over20)/10%))', eligibility: 'action p95 <= 20 s', tie: `balanced within ${TIE}: settled by quality, then cost per 1,000` }, overall: balancedRanking, routes: routes.map((r) => ({ job: r.job, pick: r.pick?.modelKey ?? null, balanced: r.pick?.balanced ?? null, quality: r.pick?.quality ?? null, p95: r.pick?.p95 ?? null, gap: r.gap, pairwise: r.pick?.card.pairwise ?? null, qualityWinner: r.qualityWinner?.modelKey ?? null, referenceQuality: ref(r.job)?.quality ?? null, referenceAdvisable: r.referenceAdvisable })), planCostPer1000: routeCost, planGpus: need.text, planPairwise: routePw, oneGpuPlan: sk ? { model: sk, costPer1000: singlePlanCost, jobsWithinGap: singleClose, pairwise: singlePw } : null, recommendations: recs.map((r) => ({ slot: r.slot, pick: r.pick?.k ?? null, balanced: r.pick?.b ?? null, quality: r.pick?.q ?? null, qualityWinner: r.qWinner?.k ?? null, tieWith: r.runnerUp?.k ?? null, tieBroken: r.tieBroken, holdsUnder: r.holds, samePanel: r.samePanel })), sensitivity: sens.map((v) => ({ weights: v.w, leader: v.leader?.k, top3: v.top3, onpremPick: v.onpremLeader?.k ?? null, onpremBalancedLeader: v.onpremTop?.k ?? null, routes: v.routes })), unstableRoutes: unstable, selfExclusionGaps: panelGaps };
  return { md: md.join('\n'), summary, rows, rankings, byUseCase, byJob, balancedRanking, routes: routes as Route[], recs };
}
export { balancedOf };
