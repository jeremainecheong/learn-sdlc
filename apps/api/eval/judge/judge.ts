import * as fs from 'fs';
import * as path from 'path';
import type { OpenAiProvider } from '../../src/assistant/openai.provider';
import { makeProvider } from '../arms';
import { unitIsTransient, unitStore, type UnitContext } from '../capture';
import { JUDGE_SLOTS, useCaseOf, type CorpusCase, type EvalModel, type UseCase } from '../contracts';
import { readDerived, type DerivedReview } from '../derive';
import type { ExecTruth } from '../exec-truth';
import { say, writeJson } from '../io';
import { execPath, judgePath, rawPath, readIf, unitId } from '../ledger';
import { budgetHooks, HARNESS_STOP, TRANSIENT_BREAKER, TRANSIENT_STOP, type RawRecord, type RunCtx } from '../runner';
import { awsLoginNeeded, harnessFault } from '../transport/aws';
import { judgeReplay } from '../transport/stub';
import { absoluteSchema, absoluteSystemPrompt, pairwiseSchema, pairwiseSystemPrompt, parseAbsolute, parsePairwise, RUBRIC_VERSION } from './rubrics';
import { judgeContext, renderOutput } from './payload';
import { repairJudgeJson } from './repair';
import { blindLabel, combinePairwise, pairwiseOrders, seededShuffle, stratifiedSample, type PairVerdict } from './sampling';
import { TIER_NAMES, TierReserve, orderByTier, runtimeAdmits, tierOf } from './tiers';
import { costOf, priceRowOf, tokensFromBytes } from '../budget';

/**
 * The LLM-as-judge stages: three small
 * judges from three families, read from models.json `slate`: judge A
 * (gpt-oss-120b, reasoning at its minimum), judge B (Qwen3 32B, thinking off),
 * judge C (Amazon Nova Lite). All three are also candidates, so a judge never
 * scores or pairwise-compares its own outputs (self-exclusion, enforced when
 * units are built and again before each call). Each model's primary judge is
 * the first of A, B, C that is not itself; the others are secondary. Absolute
 * rubric scores, pairwise preference against the reference (position-swapped)
 * and a 10% re-judge for self-consistency. Each judge is one lane with one call
 * in flight; the lanes run in parallel, after the candidate stage, so no model
 * ever has two requests in flight. Judgements go through the product's
 * `structured()` envelope, so the candidate output is fenced as untrusted data.
 */

export interface JudgePlan {
  primaryReviewProposalFraction: number;
  secondaryFraction: number;
  pairwise: boolean;
  pairwiseCases: number;
  /** When set, pairwise compares exactly this many (model, case) cells against the reference, instead of every model on `pairwiseCases` cases (the pilot). */
  pairwiseCells?: number;
  rejudgeFraction: number;
}

export const DEFAULT_JUDGE_PLAN: JudgePlan = { primaryReviewProposalFraction: 1, secondaryFraction: 1, pairwise: true, pairwiseCases: 40, rejudgeFraction: 0.1 };

/**
 * The pilot: the primary judge (A; B on A's own
 * outputs) on every pilot cell, the secondary judges on about half of the cases
 * (stratified by job type, the same cases for every model), 10 pairwise cells
 * (one per model, spread over the job types) by every non-self judge, no re-judge.
 */
export const PILOT_JUDGE_PLAN: JudgePlan = { primaryReviewProposalFraction: 1, secondaryFraction: 0.5, pairwise: true, pairwiseCases: 0, pairwiseCells: 10, rejudgeFraction: 0 };

/** `n` (model, case) cells for pairwise: models in a seeded order, job types round-robin, a seeded case per job type. */
function pairwiseCellSample<M extends { key: string }>(cases: CorpusCase[], models: readonly M[], n: number, has: (m: M, c: CorpusCase) => boolean, salt: string): Array<{ m: M; c: CorpusCase }> {
  const jobs = seededShuffle([...new Set(cases.map((c) => c.jobType))], `${salt}|PJ`);
  const order = seededShuffle(models, `${salt}|PM`);
  const out: Array<{ m: M; c: CorpusCase }> = [];
  const taken = new Set<string>();
  for (let i = 0; out.length < n && i < n * Math.max(1, jobs.length) * 2; i += 1) {
    const m = order[out.length % Math.max(1, order.length)];
    if (!m) break;
    const job = jobs[i % jobs.length];
    const pool = seededShuffle(cases.filter((c) => c.jobType === job && has(m, c) && !taken.has(`${m.key}|${c.id}`)), `${salt}|PC|${job}|${m.key}`);
    if (!pool.length) continue;
    taken.add(`${m.key}|${pool[0].id}`);
    out.push({ m, c: pool[0] });
  }
  return out;
}

export interface JudgeUnit {
  kind: 'absolute' | 'pairwise' | 'rejudge';
  judge: EvalModel;
  model: EvalModel;
  c: CorpusCase;
  /** The model's primary judge (first non-self of A, B, C): the protected tiers. */
  primary: boolean;
}

/** The judge-models in slot order A, B, C (runnable only). */
export const judgesOf = (models: readonly EvalModel[]): EvalModel[] =>
  JUDGE_SLOTS.map((slot) => models.find((m) => m.judgeSlot === slot && m.runnable)).filter((m): m is EvalModel => !!m);

/** The first judge that is not the model itself. */
export const primaryJudgeFor = (model: Pick<EvalModel, 'key'>, judges: readonly EvalModel[]): EvalModel | null => judges.find((j) => j.key !== model.key) ?? null;

/** Self-exclusion: a judge never scores or compares its own outputs. Thrown, never skipped silently. */
function assertNotSelf(u: Pick<JudgeUnit, 'judge' | 'model'>): void {
  if (u.judge.key === u.model.key) throw new Error(`self-exclusion violated: judge ${u.judge.key} was asked to judge its own output`);
}

const judgedModels = (ctx: RunCtx) => ctx.models.filter((m) => (m.role === 'candidate' || m.role === 'reference') && m.runnable);
const hasRaw = (ctx: RunCtx, m: EvalModel, c: CorpusCase) => fs.existsSync(rawPath(ctx.runDir, m.key, c.jobType, c.id));

/**
 * The reviewer-only sub-jobs (interview.review, guided.review on a fixed
 * candidate) are classifiers scored exactly by the fixed metrics, and the
 * server-refused Agentic case makes no model call: none of them is judged.
 */
export const judgeable = (c: CorpusCase): boolean => !c.input.subJob && c.reference.expected?.modelCall !== false;

/** The case samples each stage judges: the same cases for every model, so models stay comparable. */
function judgeSamples(all: CorpusCase[], plan: JudgePlan, salt: string) {
  const cases = all.filter(judgeable);
  const byUse = (u: UseCase[]) => cases.filter((c) => u.includes(useCaseOf(c.jobType)));
  const full = byUse(['interview', 'mentor', 'explanation']);
  const rp = byUse(['review', 'agentic']);
  const primary = [...full, ...stratifiedSample(rp, plan.primaryReviewProposalFraction, (c) => c.jobType, `${salt}|A`)];
  const secondary = stratifiedSample(cases, plan.secondaryFraction, (c) => c.jobType, `${salt}|B`);
  const pairwise = plan.pairwise && !plan.pairwiseCells ? stratifiedSample(cases, Math.min(1, plan.pairwiseCases / Math.max(1, cases.length)), (c) => c.jobType, `${salt}|P`) : [];
  return { primary, secondary, pairwise };
}

export type SelfExclusion = Record<string, { absolute: number; pairwise: number }>;

export function buildJudgeUnits(ctx: RunCtx, plan: JudgePlan, judges: readonly EvalModel[]): { units: JudgeUnit[]; selfExcluded: SelfExclusion } {
  const s = judgeSamples(ctx.cases, plan, ctx.salt);
  const inPrimary = new Set(s.primary.map((c) => c.id));
  const inSecondary = new Set(s.secondary.map((c) => c.id));
  const models = judgedModels(ctx);
  const units: JudgeUnit[] = [];
  const selfExcluded: SelfExclusion = Object.fromEntries(judges.map((j) => [j.key, { absolute: 0, pairwise: 0 }]));
  const sampled = ctx.cases.filter((c) => inPrimary.has(c.id) || inSecondary.has(c.id));
  for (const c of sampled) for (const m of models) {
    if (!hasRaw(ctx, m, c)) continue;
    const first = primaryJudgeFor(m, judges);
    for (const j of judges) {
      if (j.key === m.key) {
        // Counted where this judge would otherwise have scored the cell.
        if (inPrimary.has(c.id) || inSecondary.has(c.id)) selfExcluded[j.key].absolute += 1;
        continue;
      }
      const primary = j === first;
      if (primary ? inPrimary.has(c.id) : inSecondary.has(c.id)) units.push({ kind: 'absolute', judge: j, model: m, c, primary });
    }
  }
  const ref = models.find((m) => m.role === 'reference');
  const pairCell = (m: EvalModel, c: CorpusCase) => {
    for (const j of judges) {
      if (j.key === m.key) { selfExcluded[j.key].pairwise += 1; continue; }
      units.push({ kind: 'pairwise', judge: j, model: m, c, primary: j === primaryJudgeFor(m, judges) });
    }
  };
  if (ref && plan.pairwise && plan.pairwiseCells) {
    const judgedCases = ctx.cases.filter(judgeable);
    for (const { m, c } of pairwiseCellSample(judgedCases, models.filter((m) => m !== ref), plan.pairwiseCells, (m, c) => hasRaw(ctx, m, c) && hasRaw(ctx, ref, c), ctx.salt)) pairCell(m, c);
  } else if (ref) for (const c of s.pairwise) for (const m of models) {
    if (m === ref || !hasRaw(ctx, m, c) || !hasRaw(ctx, ref, c)) continue;
    pairCell(m, c);
  }
  if (plan.rejudgeFraction > 0) {
    const abs = units.filter((u) => u.kind === 'absolute');
    for (const u of stratifiedSample(abs, plan.rejudgeFraction, (x) => `${x.judge.key}|${useCaseOf(x.c.jobType)}`, `${ctx.salt}|R`)) units.push({ ...u, kind: 'rejudge' });
  }
  for (const u of units) assertNotSelf(u);
  return { units, selfExcluded };
}

function outputFor(ctx: RunCtx, m: EvalModel, c: CorpusCase): string {
  const raw = readIf<RawRecord>(rawPath(ctx.runDir, m.key, c.jobType, c.id));
  const exec = readIf<ExecTruth>(execPath(ctx.runDir, m.key, c.id));
  return raw ? renderOutput(c, raw as never, exec) : '(no output)';
}

/** structured(): the untrusted-data rule, the JSON line and the schema block (as plan.ts). */
const ENVELOPE_BYTES = 1400;
const JUDGE_MARGIN = 1.15;
export const JUDGE_MAX_TOKENS = { absolute: 1200, pairwise: 600 };
export const JUDGE_EXPECTED_OUT = { absolute: 450, pairwise: 250 };

/** A judge unit's expected and worst-case cost, from its exact payload size. */
function judgeUnitCost(ctx: RunCtx, u: JudgeUnit, contextCache = new Map<string, unknown>()): { estUsd: number; worstUsd: number } {
  const price = priceRowOf(u.judge);
  const useCase = useCaseOf(u.c.jobType);
  let context = contextCache.get(u.c.id);
  if (context === undefined) {
    context = judgeContext(u.c, useCase === 'review' ? readDerived<DerivedReview>(ctx.root, u.c) : null);
    contextCache.set(u.c.id, context);
  }
  if (u.kind === 'pairwise') {
    const ref = judgedModels(ctx).find((m) => m.role === 'reference');
    const bytes = Buffer.byteLength(pairwiseSystemPrompt(useCase)) + Buffer.byteLength(JSON.stringify({ useCase, context, A: { text: outputFor(ctx, u.model, u.c) }, B: { text: ref ? outputFor(ctx, ref, u.c) : '' } })) + ENVELOPE_BYTES;
    return {
      estUsd: 2 * costOf(price, tokensFromBytes(bytes), JUDGE_EXPECTED_OUT.pairwise) * JUDGE_MARGIN,
      worstUsd: 2 * costOf(price, tokensFromBytes(bytes), JUDGE_MAX_TOKENS.pairwise),
    };
  }
  const bytes = Buffer.byteLength(absoluteSystemPrompt(useCase)) + Buffer.byteLength(JSON.stringify({ useCase, context, output: { id: 'out-0000000000', text: outputFor(ctx, u.model, u.c) } })) + ENVELOPE_BYTES;
  return {
    estUsd: costOf(price, tokensFromBytes(bytes), JUDGE_EXPECTED_OUT.absolute) * JUDGE_MARGIN,
    worstUsd: costOf(price, tokensFromBytes(bytes), JUDGE_MAX_TOKENS.absolute),
  };
}

/**
 * The product's structured() call, with the judge-only format tolerance of
 * repair.ts when the product refuses the text as "not JSON": the last call's
 * raw text is repaired (closing brackets only) and the adaptation is returned
 * so the judge record names it. Judges only; candidates never come through here.
 */
export async function structuredForJudge(call: () => Promise<{ value: unknown }>, lastText: () => string | null): Promise<{ value: unknown; adaptation: string | null }> {
  try { return { value: (await call()).value, adaptation: null }; } catch (error) {
    if (!/structured response was not JSON/.test(String((error as Error)?.message))) throw error;
    const text = lastText();
    if (!text) throw error;
    try { return repairJudgeJson(text); } catch { throw error; }
  }
}

const lastResponseText = (): string | null => {
  const calls = unitStore.getStore()?.calls ?? [];
  const last = calls[calls.length - 1];
  return last && last.outcome === 'ok' ? last.responseText : null;
};

async function judgeOne(ctx: RunCtx, provider: OpenAiProvider, u: JudgeUnit): Promise<Record<string, unknown>> {
  assertNotSelf(u);
  const useCase = useCaseOf(u.c.jobType);
  const derived = useCase === 'review' ? readDerived<DerivedReview>(ctx.root, u.c) : null;
  const context = judgeContext(u.c, derived);
  if (u.kind === 'pairwise') {
    const ref = judgedModels(ctx).find((m) => m.role === 'reference')!;
    const [first, second] = pairwiseOrders(outputFor(ctx, u.model, u.c), outputFor(ctx, ref, u.c));
    const verdicts: PairVerdict[] = [];
    const justifications: string[] = [];
    const adaptations: Array<string | null> = [];
    for (const order of [first, second]) {
      const result = await structuredForJudge(() => provider.structured(pairwiseSystemPrompt(useCase), { useCase, context, A: { text: order.A }, B: { text: order.B } }, JUDGE_MAX_TOKENS.pairwise, undefined, pairwiseSchema(useCase), 'structured.other'), lastResponseText);
      const parsed = parsePairwise(result.value);
      verdicts.push({ winner: parsed.winner, candidateIs: order.candidateIs });
      justifications.push(parsed.justification);
      adaptations.push(result.adaptation);
    }
    return { orders: verdicts, outcome: combinePairwise(verdicts[0], verdicts[1]), justifications, adaptations };
  }
  const label = blindLabel(u.model.key, u.c.id, ctx.salt);
  const result = await structuredForJudge(() => provider.structured(absoluteSystemPrompt(useCase), { useCase, context, output: { id: label, text: outputFor(ctx, u.model, u.c) } }, JUDGE_MAX_TOKENS.absolute, undefined, absoluteSchema(useCase), 'structured.other'), lastResponseText);
  return { blindLabel: label, scores: parseAbsolute(useCase, result.value), adaptation: result.adaptation };
}

export interface JudgeRecordFile {
  kind: 'absolute' | 'pairwise' | 'rejudge';
  useCase: UseCase;
  modelKey: string;
  caseId: string;
  failure: string | null;
  result: Record<string, unknown> | null;
  calls: Array<{ outcome: string; responseText: string | null }>;
  reparsed?: { at: string; failureBefore: string; note: string };
}

/**
 * The same judge-only tolerance applied offline to a judgement already on disk
 * (the pilot ran before repair.ts existed): from the stored raw text, with no
 * new call. Returns the corrected record, or null when nothing changes.
 */
export function reparseJudgeRecord(rec: JudgeRecordFile, salt: string): JudgeRecordFile | null {
  if (rec.failure !== 'invalid_judgement') return null;
  const texts = rec.calls.map((c) => (c.outcome === 'ok' ? c.responseText : null));
  try {
    let result: Record<string, unknown>;
    if (rec.kind === 'pairwise') {
      if (texts.length !== 2 || texts.some((t) => !t)) return null;
      const orders: Array<'A' | 'B'> = ['A', 'B'];
      const parsed = texts.map((t) => repairJudgeJson(t!));
      const verdicts: PairVerdict[] = parsed.map((p, i) => ({ winner: parsePairwise(p.value).winner, candidateIs: orders[i] }));
      result = { orders: verdicts, outcome: combinePairwise(verdicts[0], verdicts[1]), justifications: parsed.map((p) => parsePairwise(p.value).justification), adaptations: parsed.map((p) => p.adaptation) };
    } else {
      if (!texts.length || !texts[texts.length - 1]) return null;
      const p = repairJudgeJson(texts[texts.length - 1]!);
      result = { blindLabel: blindLabel(rec.modelKey, rec.caseId, salt), scores: parseAbsolute(rec.useCase, p.value), adaptation: p.adaptation };
    }
    return { ...rec, result, failure: null, reparsed: { at: new Date().toISOString(), failureBefore: rec.failure, note: 'judge-only format tolerance (judge/repair.ts) applied to the stored raw text; no new call' } };
  } catch { return null; }
}

/** Re-parse every failed judgement of a run in place; returns counts per judge. */
export function reparseRun(runDir: string, salt: string): Record<string, { checked: number; repaired: number }> {
  const out: Record<string, { checked: number; repaired: number }> = {};
  const base = path.join(runDir, 'judge');
  const list = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
  for (const judge of list(base)) for (const kind of list(path.join(base, judge))) for (const model of list(path.join(base, judge, kind))) for (const f of list(path.join(base, judge, kind, model))) {
    const file = path.join(base, judge, kind, model, f);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as JudgeRecordFile;
    const row = (out[`${judge}/${kind}`] ??= { checked: 0, repaired: 0 });
    if (rec.failure) row.checked += 1;
    const fixed = reparseJudgeRecord(rec, salt);
    if (fixed) { writeJson(file, fixed); row.repaired += 1; }
  }
  return out;
}

interface LaneBudget { reserve: TierReserve; costs: Map<JudgeUnit, { estUsd: number; worstUsd: number }>; settled: Set<JudgeUnit> }

const settleOnce = (lb: LaneBudget, u: JudgeUnit) => {
  if (lb.settled.has(u)) return;
  lb.settled.add(u);
  lb.reserve.settle(tierOf(u), lb.costs.get(u)!.estUsd);
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One judge lane, one call in flight. A unit below the protected tier that
 * only the reserve blocks (the stop could pay for it, but not while the tiers
 * ahead still owe) is deferred, not cut: once every tier ahead of it has
 * finished, it gets a final check against the stop and runs or is recorded as
 * `cut_at_runtime`. So a lower tier never spends what a higher tier was owed,
 * and a higher tier is never cut while a lower one later spends.
 */
async function judgeLane(ctx: RunCtx, judge: EvalModel, units: JudgeUnit[], lb: LaneBudget): Promise<string | null> {
  let provider: OpenAiProvider;
  try { provider = await makeProvider(judge, { mode: ctx.mode, stubPort: ctx.stubPort }); } catch (error) {
    for (const u of units) settleOnce(lb, u);
    return /AWS login needed/.test(String((error as Error).message)) ? 'AWS login needed' : 'judge provider unavailable';
  }
  let n = 0;
  let transientRun = 0;
  const deferred: JudgeUnit[] = [];

  const one = async (u: JudgeUnit, final: boolean): Promise<'next' | 'deferred' | string> => {
    if (ctx.capHit) return 'stopped_at_cap';
    if (awsLoginNeeded()) return 'AWS login needed';
    if (harnessFault()) return HARNESS_STOP;
    const stage = u.kind === 'absolute' ? `judge${judge.judgeSlot}` : u.kind;
    const model = `${judge.key}>${u.model.key}`;
    const unit = unitId(ctx.runId, stage, model, u.c.jobType, u.c.id);
    const st = ctx.ledger.status(unit);
    if (st.done) { settleOnce(lb, u); return 'next'; }
    const tier = tierOf(u);
    const cost = lb.costs.get(u)!;
    if (st.failed || st.attempts >= 2) { if (!st.failed) await ctx.ledger.append({ unit, stage, model, jobType: u.c.jobType, case: u.c.id, event: 'failed', costUsd: 0 }); settleOnce(lb, u); return 'next'; }
    if (!runtimeAdmits({ committed: ctx.guard.committed, cap: ctx.guard.cap }, lb.reserve, tier, cost.worstUsd)) {
      const fitsAlone = ctx.guard.committed + cost.worstUsd <= ctx.guard.cap + 1e-12;
      if (fitsAlone && !final && lb.reserve.activeAhead(tier) > 1e-12) { deferred.push(u); return 'deferred'; }
      await ctx.ledger.append({ unit, stage, model, jobType: u.c.jobType, case: u.c.id, event: 'cut_at_runtime', costUsd: 0, worstUsd: cost.worstUsd });
      settleOnce(lb, u);
      return 'next';
    }
    await ctx.ledger.append({ unit, stage, model, jobType: u.c.jobType, case: u.c.id, event: 'started', costUsd: 0, worstUsd: ctx.mode === 'stub' ? 0 : cost.worstUsd });
    const unitCtx: UnitContext = { unitId: unit, modelKey: judge.key, caseId: u.c.id, jobType: u.c.jobType, calls: [], current: null, budget: budgetHooks(judge, ctx), ...(ctx.mode === 'stub' ? { replay: judgeReplay() } : {}) };
    let result: Record<string, unknown> | null = null;
    let failure: string | null = null;
    try { result = await unitStore.run(unitCtx, () => judgeOne(ctx, provider, u)); } catch (error) {
      failure = /structured response was not JSON|judge|pairwise/.test(String((error as Error).message)) ? 'invalid_judgement' : 'judge_call_failed';
    }
    settleOnce(lb, u);
    const spent = unitCtx.calls.reduce((s, x) => s + (x.costUsd || 0), 0);
    if (harnessFault() || unitCtx.calls.some((x) => x.outcome === 'harness_fault')) {
      await ctx.ledger.append({ unit, stage, model, jobType: u.c.jobType, case: u.c.id, event: 'failed:harness', costUsd: spent });
      ctx.ledger.writeSpend({ mode: ctx.mode });
      return HARNESS_STOP;
    }
    const event = ctx.capHit ? 'stopped_at_cap' : awsLoginNeeded() ? 'failed:credentials' : 'done';
    if (event !== 'done') { await ctx.ledger.append({ unit, stage, model, jobType: u.c.jobType, case: u.c.id, event, costUsd: spent }); return event === 'stopped_at_cap' ? 'stopped_at_cap' : 'AWS login needed'; }
    if (failure && unitIsTransient(unitCtx.calls)) {
      // A network drop, a 5xx or exhausted throttling is not a judgement: no record, retried on resume.
      await ctx.ledger.append({ unit, stage, model, jobType: u.c.jobType, case: u.c.id, event: 'failed:transient', costUsd: spent });
      transientRun += 1;
      if (transientRun >= TRANSIENT_BREAKER) { (ctx.transientStops ??= []).push(`${stage}:${judge.key}`); ctx.ledger.writeSpend({ mode: ctx.mode }); return TRANSIENT_STOP; }
      return 'next';
    }
    transientRun = 0;
    writeJson(judgePath(ctx.runDir, judge.key, u.kind, u.model.key, u.c.id), {
      version: `eval-judge-${RUBRIC_VERSION}`, judge: judge.key, judgeSlot: judge.judgeSlot, primary: u.primary, kind: u.kind, modelKey: u.model.key, caseId: u.c.id, jobType: u.c.jobType,
      useCase: useCaseOf(u.c.jobType), result, failure,
      calls: unitCtx.calls.map((x) => ({ label: x.label, outcome: x.outcome, tokensIn: x.tokensIn, tokensOut: x.tokensOut, latencyMs: x.latencyMs, costUsd: x.costUsd, requestSha256: x.requestSha256, reasoningBlocks: x.reasoningBlocks, reasoningTokens: x.reasoningTokens, reasoningFieldsSent: x.reasoningFieldsSent, responseText: x.responseText })),
      costUsd: spent,
    });
    await ctx.ledger.append({ unit, stage, model, jobType: u.c.jobType, case: u.c.id, event: 'done', costUsd: spent });
    n += 1;
    if (n % 25 === 0) { ctx.ledger.writeSpend({ mode: ctx.mode }); say(`  ${judge.key}: ${n} judgements; run spend US$${ctx.ledger.spent().toFixed(4)}`); }
    return 'next';
  };

  try {
    for (const u of units) {
      const r = await one(u, false);
      if (r !== 'next' && r !== 'deferred') return r;
    }
    // Deferred units: wait until every tier ahead has finished (or been settled), then decide once.
    for (const u of deferred) {
      const tier = tierOf(u);
      while (lb.reserve.activeAhead(tier) > 1e-12 && !ctx.capHit && !awsLoginNeeded()) await pause(ctx.mode === 'stub' ? 20 : 500);
      const r = await one(u, true);
      if (r !== 'next' && r !== 'deferred') return r;
    }
    ctx.ledger.writeSpend({ mode: ctx.mode });
    return null;
  } finally {
    // Whatever this lane did not reach is not owed by this session.
    for (const u of units) settleOnce(lb, u);
  }
}

export type JudgeStage = 'A' | 'B' | 'C' | 'pairwise' | 'rejudge';

export async function runJudges(ctx: RunCtx, plan: JudgePlan, which: JudgeStage[]): Promise<Record<string, string | null>> {
  const judges = judgesOf(ctx.models);
  const { units: all, selfExcluded } = buildJudgeUnits(ctx, plan, judges);
  writeJson(path.join(ctx.runDir, 'judge-selfexclusion.json'), {
    note: 'Cells a judge did not score or compare because the model under test is the judge itself. Units built for this sample and plan.',
    judges: judges.map((j) => ({ slot: j.judgeSlot, key: j.key })), selfExcluded, at: new Date().toISOString(),
  });
  const want = (u: JudgeUnit) => (u.kind === 'absolute' && which.includes(u.judge.judgeSlot as JudgeStage)) || (u.kind === 'pairwise' && which.includes('pairwise')) || (u.kind === 'rejudge' && which.includes('rejudge'));
  const selected = all.filter(want);
  // One lane per judge-model, in the priority tiers (primary chat/explanation, primary reviews/proposals, secondary, pairwise), shuffled within a tier.
  const lanes = judges.map((j) => ({ judge: j, units: orderByTier(selected.filter((u) => u.judge === j), `${ctx.salt}|order${j.judgeSlot}`) }));
  // One reserve across all lanes: what each tier still needs, from each unit's exact payload.
  const reserve = new TierReserve();
  const costs = new Map<JudgeUnit, { estUsd: number; worstUsd: number }>();
  const settled = new Set<JudgeUnit>();
  const contextCache = new Map<string, unknown>();
  const stageOf = (u: JudgeUnit) => (u.kind === 'absolute' ? `judge${u.judge.judgeSlot}` : u.kind);
  for (const u of lanes.flatMap((l) => l.units)) {
    const c = judgeUnitCost(ctx, u, contextCache);
    costs.set(u, c);
    const st = ctx.ledger.status(unitId(ctx.runId, stageOf(u), `${u.judge.key}>${u.model.key}`, u.c.jobType, u.c.id));
    // Finished units owe nothing; everything else is owed by its tier until it runs, fails or is cut.
    if (st.done || st.failed) settled.add(u); else reserve.add(tierOf(u), c.estUsd);
  }
  // The re-judge runs after this call; while the other stages run, its money is kept back.
  if (!which.includes('rejudge')) {
    for (const u of all.filter((x) => x.kind === 'rejudge')) {
      if (!ctx.ledger.status(unitId(ctx.runId, 'rejudge', `${u.judge.key}>${u.model.key}`, u.c.jobType, u.c.id)).done) reserve.add(tierOf(u), judgeUnitCost(ctx, u, contextCache).estUsd, { later: true });
    }
  }
  const excluded = Object.entries(selfExcluded).map(([k, v]) => `${k} ${v.absolute}+${v.pairwise}`).join(', ');
  say(`judges: ${lanes.map((l) => `${l.judge.judgeSlot}=${l.judge.key} ${l.units.length} units`).join('; ')} (${ctx.mode}); self-excluded (absolute+pairwise): ${excluded}; still owed by tier: ${TIER_NAMES.map((n, t) => `${n} US$${(reserve.ahead(t + 1) - reserve.ahead(t)).toFixed(2)}`).join(', ')}`);
  const lb: LaneBudget = { reserve, costs, settled };
  const results = await Promise.all(lanes.map(async (l) => [`judge${l.judge.judgeSlot}`, l.units.length ? await judgeLane(ctx, l.judge, l.units, lb) : null] as const));
  return Object.fromEntries(results);
}
