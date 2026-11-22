import * as fs from 'fs';
import * as path from 'path';
import { applyPriorityCuts, costOf, HARD_STOP_USD, priceRowOf, SpendGuard, tokensFromBytes, type StageEstimate } from './budget';
import { useCaseOf, type CorpusCase, type EvalModel } from './contracts';
import { readDerived, type DerivedReview } from './derive';
import { ensureDir, readJson, say, writeJson } from './io';
import { canonicalJson } from './transport/aws';
import { Ledger, rawPath, readIf } from './ledger';
import { candidateLane, isReasoner, LABEL_EXPECTED_OUT, type RawRecord, type RunCtx } from './runner';
import { absoluteSystemPrompt, pairwiseSystemPrompt } from './judge/rubrics';
import { judgeContext, renderOutput } from './judge/payload';
import { DEFAULT_JUDGE_PLAN, JUDGE_EXPECTED_OUT, JUDGE_MAX_TOKENS, judgeable, judgesOf, type JudgePlan } from './judge/judge';
import { percentile } from './score/metrics';

/**
 * The cost estimator, run before any paid phase.
 *
 * Exact request sizes come from composing every case through the real
 * drivers once, against the loopback stub (no network, nothing billed): every
 * call's request bytes and the product's maxTokens are recorded. Input tokens
 * are bytes/3.5 (conservative); output is min(maxTokens, the model's documented
 * maximum, the expected output for that call label), ×3 for models that
 * reason, or the p90 a pilot run measured, when `--calibrate <pilotRunId>` is
 * given. A 15% margin covers repairs and retries, on the candidates and on
 * every judge stage. Judge sizes come from the judge payload builder over the
 * same composed outputs; judge output is calibrated from the pilot's judge
 * records when it has them. Then the priority cuts
 * are applied against the stop less everything already spent by earlier
 * real runs (pilot included), and the plan records what was cut.
 */

export const MARGIN = 1.15;
/** The plan format: three self-excluding judges from the slate, primary and secondary stages, reasoning switches recorded. A plan in any other format is refused: re-plan. */
const PLAN_VERSION = 'eval-plan-v3';
const ENVELOPE_BYTES = 1400; // structured(): the untrusted-data rule, the JSON line and the schema block

export interface PlannedCase { caseId: string; jobType: string; judged: boolean; calls: Array<{ label: string; requestBytes: number; maxTokens: number }>; judgeBytes: number; outputBytes: number }

export async function composeSizes(ctx: RunCtx, probe: EvalModel): Promise<PlannedCase[]> {
  const reason = await candidateLane(ctx, { ...probe, key: 'plan-probe', maxOutputTokens: 1_000_000 }, ctx.cases, 'plan');
  if (reason) throw new Error(`plan composition stopped: ${reason}`);
  const out: PlannedCase[] = [];
  for (const c of ctx.cases) {
    const raw = readIf<RawRecord>(rawPath(ctx.runDir, 'plan-probe', c.jobType, c.id));
    if (!raw) continue;
    const output = renderOutput(c, raw as never, null);
    const derived = useCaseOf(c.jobType) === 'review' ? readDerived<DerivedReview>(ctx.root, c) : null;
    const data = JSON.stringify({ useCase: useCaseOf(c.jobType), context: judgeContext(c, derived), output: { id: 'out-0000000000', text: output } });
    out.push({
      caseId: c.id, jobType: c.jobType, judged: judgeable(c),
      calls: raw.calls.map((x) => ({ label: x.label, requestBytes: x.requestBytes ?? 0, maxTokens: x.maxTokensAsked ?? 0 })),
      judgeBytes: Buffer.byteLength(absoluteSystemPrompt(useCaseOf(c.jobType))) + Buffer.byteLength(data) + ENVELOPE_BYTES,
      outputBytes: Buffer.byteLength(output),
    });
  }
  return out;
}

/**
 * p90 output tokens per (model, label) from a pilot run's raw records, and per
 * judge from its judge records: `structured.other` for absolute and re-judge
 * calls, `pairwise` for each pairwise order.
 */
export function calibrationFrom(runDir: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number[]>> = {};
  const rawDir = path.join(runDir, 'raw');
  const list = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
  for (const model of list(rawDir)) {
    for (const job of list(path.join(rawDir, model))) {
      for (const f of list(path.join(rawDir, model, job))) {
        const r = readJson<RawRecord>(path.join(rawDir, model, job, f));
        for (const call of r.calls) if (call.tokensOut !== null && call.tokensOut !== undefined) ((out[model] ??= {})[call.label] ??= []).push(call.tokensOut);
      }
    }
  }
  const judgeDir = path.join(runDir, 'judge');
  for (const judge of list(judgeDir)) {
    for (const kind of list(path.join(judgeDir, judge))) {
      const label = kind === 'pairwise' ? 'pairwise' : 'structured.other';
      for (const model of list(path.join(judgeDir, judge, kind))) {
        for (const f of list(path.join(judgeDir, judge, kind, model))) {
          const r = readJson<{ calls?: Array<{ tokensOut: number | null }> }>(path.join(judgeDir, judge, kind, model, f));
          for (const call of r.calls ?? []) if (typeof call.tokensOut === 'number') ((out[judge] ??= {})[label] ??= []).push(call.tokensOut);
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([m, labels]) => [m, Object.fromEntries(Object.entries(labels).map(([l, v]) => [l, percentile(v, 90) ?? 0]))]));
}

export function expectedOut(model: EvalModel, label: string, maxTokens: number, calibration: Record<string, Record<string, number>>): number {
  const calibrated = calibration[model.key]?.[label];
  const base = calibrated ?? (LABEL_EXPECTED_OUT[label] ?? 500) * (isReasoner(model) ? 3 : 1);
  return Math.min(maxTokens, model.maxOutputTokens, base);
}

export function estimate(models: EvalModel[], sizes: PlannedCase[], plan: JudgePlan, calibration: Record<string, Record<string, number>> = {}) {
  const runnable = models.filter((m) => (m.role === 'candidate' || m.role === 'reference') && m.runnable);
  const perModel: Record<string, { calls: number; tokensIn: number; tokensOut: number; usd: number }> = {};
  let candidates = 0;
  for (const m of runnable) {
    const price = priceRowOf(m);
    let tin = 0;
    let tout = 0;
    let calls = 0;
    for (const s of sizes) for (const call of s.calls) {
      calls += 1;
      tin += tokensFromBytes(call.requestBytes);
      tout += expectedOut(m, call.label, call.maxTokens, calibration);
    }
    const usd = costOf(price, tin, tout) * MARGIN;
    perModel[m.key] = { calls, tokensIn: tin, tokensOut: tout, usd };
    candidates += usd;
  }
  // Judges carry the same margin as the candidates (repairs, retries, longer justifications).
  // Each judged model is scored by every judge that is not itself; its primary judge is the first such.
  const judges = judgesOf(models);
  const judgeCost = (judge: EvalModel, bytes: number, outTok: number) => costOf(priceRowOf(judge), tokensFromBytes(bytes), outTok) * MARGIN;
  const outAbs = (j: EvalModel) => Math.min(JUDGE_MAX_TOKENS.absolute, calibration[j.key]?.['structured.other'] ?? JUDGE_EXPECTED_OUT.absolute);
  const outPair = (j: EvalModel) => Math.min(JUDGE_MAX_TOKENS.pairwise, calibration[j.key]?.pairwise ?? JUDGE_EXPECTED_OUT.pairwise);
  const primary = { chat: 0, explanation: 0, review: 0, proposal: 0 };
  let secondary = 0;
  let pairwise = 0;
  const judgedSizes = sizes.filter((x) => x.judged);
  const nonRef = runnable.filter((m) => m.role !== 'reference').length;
  const pairFraction = plan.pairwiseCells
    ? Math.min(1, plan.pairwiseCells / Math.max(1, judgedSizes.length * nonRef))
    : Math.min(1, plan.pairwiseCases / Math.max(1, judgedSizes.length));
  for (const s of judgedSizes) {
    const u = useCaseOf(s.jobType as never);
    for (const m of runnable) {
      const own = judges.filter((j) => j.key !== m.key);
      own.forEach((j, i) => {
        const a = judgeCost(j, s.judgeBytes, outAbs(j));
        if (i > 0) { secondary += a; return; }
        if (u === 'interview' || u === 'mentor') primary.chat += a;
        else if (u === 'explanation') primary.explanation += a;
        else if (u === 'review') primary.review += a;
        else primary.proposal += a;
      });
      if (m.role !== 'reference') for (const j of own) pairwise += pairFraction * 2 * judgeCost(j, s.judgeBytes + s.outputBytes, outPair(j));
    }
  }
  const sumPrimary = primary.chat + primary.explanation + primary.review + primary.proposal;
  const est: StageEstimate = { candidates, primary, secondary, pairwise, rejudge: (sumPrimary + secondary) * plan.rejudgeFraction };
  return { est, perModel };
}

/**
 * The pilot's estimate: its own cases under the pilot judge plan (secondary
 * judges and the re-judge at the plan's fractions, pairwise on its cells),
 * checked against the pilot cap. Written to pilot-estimate.json beside plan.json.
 */
export function writePilotEstimate(runDir: string, models: EvalModel[], sizes: PlannedCase[], plan: JudgePlan, pilotCapUsd: number, calibration: Record<string, Record<string, number>>) {
  const { est, perModel } = estimate(models, sizes, plan, calibration);
  const primary = est.primary.chat + est.primary.explanation + est.primary.review + est.primary.proposal;
  const secondary = est.secondary * plan.secondaryFraction;
  const rejudge = (primary + secondary) * plan.rejudgeFraction;
  const pairwise = plan.pairwise ? est.pairwise : 0;
  const total = est.candidates + primary + secondary + rejudge + pairwise;
  const out = { version: PLAN_VERSION, at: new Date().toISOString(), cases: sizes.length, judgePlan: plan, pilotCapUsd, stages: { candidates: est.candidates, primary, secondary, pairwise, rejudge }, perModel, projectedTotalUsd: Number(total.toFixed(4)), fits: total <= pilotCapUsd };
  writeJson(path.join(runDir, 'pilot-estimate.json'), out);
  say(`pilot estimate: ${sizes.length} cases; candidates US$${est.candidates.toFixed(2)}, primary judge US$${primary.toFixed(2)}, secondary US$${secondary.toFixed(2)}, pairwise US$${pairwise.toFixed(2)}; total US$${total.toFixed(2)} of the US$${pilotCapUsd} pilot cap; fits=${out.fits}`);
  return out;
}

/** Spend booked by every real run (probe and pilot included), optionally leaving one run out. */
export function globalRealSpend(root: string, options: { exclude?: string } = {}): number {
  const runs = path.join(root, 'runs');
  if (!fs.existsSync(runs)) return 0;
  let total = 0;
  for (const id of fs.readdirSync(runs)) {
    if (id === options.exclude) continue;
    const run = readIf<{ mode?: string }>(path.join(runs, id, 'run.json'));
    if (!run || run.mode !== 'real') continue;
    total += new Ledger(path.join(runs, id), id).spent();
  }
  return total;
}

export function writePlan(runDir: string, models: EvalModel[], sizes: PlannedCase[], stopUsd: number, alreadySpent: number, calibration: Record<string, Record<string, number>>, calibratedFrom: string | null) {
  const first = estimate(models, sizes, DEFAULT_JUDGE_PLAN, calibration);
  const room = Math.max(0.0001, stopUsd - alreadySpent);
  const cut = applyPriorityCuts(first.est, Math.min(room, HARD_STOP_USD));
  const judgePlan: JudgePlan = { ...DEFAULT_JUDGE_PLAN, pairwise: cut.plan.pairwise, secondaryFraction: cut.plan.secondaryFraction, primaryReviewProposalFraction: cut.plan.primaryReviewProposalFraction };
  const plan = {
    version: PLAN_VERSION, at: new Date().toISOString(), stopUsd, alreadySpentUsd: Number(alreadySpent.toFixed(4)), roomUsd: Number(room.toFixed(4)),
    calibratedFrom, assumptions: { inputTokens: 'bytes / 3.5', margin: MARGIN, marginAppliesTo: 'candidates, primary judge, secondary judges, pairwise, re-judge', expectedOut: LABEL_EXPECTED_OUT, judgeExpectedOut: JUDGE_EXPECTED_OUT, reasoningMultiplier: { models: models.filter(isReasoner).map((m) => m.key), factor: 3 } },
    slate: models.map((m) => ({ key: m.key, label: m.label, role: m.role, class: m.class, tier: m.tier, judgeSlot: m.judgeSlot ?? null, runnable: m.runnable })),
    judges: judgesOf(models).map((j) => ({ slot: j.judgeSlot, key: j.key, reasoning: j.reasoning.policy })),
    selfExclusion: 'a judge never scores or pairwise-compares its own outputs; a cell judge score is the mean of the judges that are not the model under test',
    reasoningSwitches: Object.fromEntries(models.filter((m) => m.provider === 'bedrock').map((m) => [m.key, { policy: m.reasoning.policy, additionalModelRequestFields: m.reasoning.fields, source: m.reasoning.source, note: m.reasoning.note }])),
    cases: sizes.length,
    perModel: Object.fromEntries(Object.entries(first.perModel).map(([k, v]) => [k, { ...v, usd: Number(v.usd.toFixed(4)) }])),
    stages: first.est,
    cuts: cut.cuts,
    judgePlan,
    projectedTotalUsd: Number(cut.total.toFixed(4)),
    fits: cut.fits,
  };
  writeJson(path.join(runDir, 'plan.json'), plan);
  ensureDir(runDir);
  say(`plan: ${sizes.length} cases; candidates US$${first.est.candidates.toFixed(2)}, primary judge US$${(first.est.primary.chat + first.est.primary.explanation + first.est.primary.review + first.est.primary.proposal).toFixed(2)}, secondary judges US$${first.est.secondary.toFixed(2)}, pairwise US$${first.est.pairwise.toFixed(2)}, rejudge US$${first.est.rejudge.toFixed(2)}`);
  for (const [k, v] of Object.entries(first.perModel)) say(`  ${k.padEnd(18)} calls ${String(v.calls).padStart(5)}  in ${String(v.tokensIn).padStart(9)}  out ${String(v.tokensOut).padStart(8)}  US$${v.usd.toFixed(3)}`);
  say(`plan: already spent US$${alreadySpent.toFixed(4)}; room US$${room.toFixed(2)}; projected after cuts US$${cut.total.toFixed(2)}; fits=${cut.fits}`);
  for (const c of cut.cuts) say(`  cut: ${c.note}`);
  return plan;
}

/** Spend elsewhere may drift this far from what the plan assumed before the plan must be redone. */
const STALE_PLAN_USD = 0.25;

/**
 * A real run follows a plan that fits the stop and still describes the world:
 * if spend in other runs (a pilot, a probe) moved since the plan was made, or
 * the stop changed, the estimate does not hold: re-plan.
 */
export function refuseUnfitOrStalePlan(plan: { version?: string; fits: boolean; alreadySpentUsd: number; stopUsd?: number }, spentElsewhere: number, stopUsd: number): void {
  if (plan.version !== undefined && plan.version !== PLAN_VERSION) throw new Error(`plan.json is ${plan.version}, made by an older estimator: re-plan`);
  if (!plan.fits) throw new Error('plan.json does not fit the stop even after every priority cut: refusing to start a paid run (re-plan with a calibrated pilot or a smaller slate)');
  if (Math.abs(plan.alreadySpentUsd - spentElsewhere) > STALE_PLAN_USD) {
    throw new Error(`plan.json is stale: it assumed US$${plan.alreadySpentUsd.toFixed(2)} already spent elsewhere, the ledgers now say US$${spentElsewhere.toFixed(2)}: re-plan`);
  }
  if (plan.stopUsd !== undefined && plan.stopUsd !== stopUsd) throw new Error(`plan.json was made for a US$${plan.stopUsd} stop, this run asks US$${stopUsd}: re-plan`);
}

/** A real run refuses to start until every slate Bedrock model passed the reasoning probe with the switches it will be sent. */
export function refuseWithoutReasoningProbe(runDir: string, models: Array<{ key: string; provider: string; runnable: boolean; reasoning: { policy: string; fields: Record<string, unknown> | null } }>): void {
  const file = path.join(runDir, 'reasoning-probe.json');
  if (!fs.existsSync(file)) throw new Error('no reasoning-probe.json for this run: run `probe --run <id> --reasoning` first (every model\'s off switch is probed before any paid call)');
  const probe = readJson<{ mode?: string; models?: Record<string, { ok: boolean; fields: string | null }> }>(file);
  if (probe.mode !== 'real') throw new Error('reasoning-probe.json is from a stub probe: run the real probe first');
  for (const m of models.filter((x) => x.provider === 'bedrock' && x.runnable)) {
    const r = probe.models?.[m.key];
    const want = m.reasoning.fields ? canonicalJson(m.reasoning.fields) : null;
    if (!r || !r.ok) throw new Error(`reasoning probe has no passing result for ${m.key}: fix the switch, re-probe`);
    if (r.fields !== want) throw new Error(`reasoning probe for ${m.key} used ${r.fields ?? 'no fields'}, the slate now sends ${want ?? 'none'}: re-probe`);
  }
}

export { SpendGuard };
