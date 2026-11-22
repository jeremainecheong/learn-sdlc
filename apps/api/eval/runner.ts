import * as fs from 'fs';
import * as path from 'path';
import type { OpenAiProvider } from '../src/assistant/openai.provider';
import { makeProvider, type ArmMode } from './arms';
import { BudgetExceeded, costOf, priceRowOf, tokensFromBytes, type SpendGuard } from './budget';
import { unitIsTransient, unitStore, type CallRecord, type UnitContext } from './capture';
import { useCaseOf, type CorpusCase, type EvalModel } from './contracts';
import { readDerived, type DerivedReview } from './derive';
import { execTruth } from './exec-truth';
import { seatbeltPreflight } from './seatbelt-sandbox';
import { ensureDir, readJson, say, sha256, writeJson } from './io';
import { Ledger, execPath, rawPath, readIf, unitId } from './ledger';
import { runAgentic, runExplanation, runInterview, runMentor, runReview, type ProductOutcome } from './jobs';
import { awsLoginNeeded, harnessFault } from './transport/aws';
import { derivedPath } from './derive';
import { candidateReplay } from './transport/stub';

/**
 * The candidate stage and the local executable-truth stage. One lane per
 * model, each strictly one unit (and inside it one call) at a time; the lanes
 * run in parallel with each other. One process-wide spend guard holds the
 * US$45 stop across every lane and stage.
 */

export interface RunCtx {
  runId: string;
  runDir: string;
  root: string;
  mode: ArmMode;
  stubPort?: number;
  stopUsd: number;
  models: EvalModel[];
  cases: CorpusCase[];
  ledger: Ledger;
  guard: SpendGuard;
  scratch: string;
  salt: string;
  /** Set when the guard refused a call: every lane stops at its next unit. */
  capHit: boolean;
  /** Lanes stopped by the transient breaker ("stage:model"); the CLI exits non-zero when any did. */
  transientStops?: string[];
}

/** Three transient units in a row stop a lane: the network or the service is down, resume later. */
export const TRANSIENT_BREAKER = 3;
export const TRANSIENT_STOP = 'transient errors: resume later';
/** Reasoning came back where it is off (or the switch was not sent). Every lane stops; fix the switch, then resume. */
export const HARNESS_STOP = 'harness fault: reasoning switch';

export interface LaneDeps {
  makeProvider?: (model: EvalModel, options: { mode: ArmMode; stubPort?: number }) => Promise<OpenAiProvider>;
  drive?: (provider: OpenAiProvider, c: CorpusCase, root: string) => Promise<ProductOutcome | { skipped: string }>;
}

export const LABEL_EXPECTED_OUT: Record<string, number> = {
  'guided.draft': 150, 'guided.review': 500, 'interview.answer': 120, 'interview.review': 400,
  'agentic.classify': 300, 'agentic.generate': 2500, 'agentic.explanation': 700, 'grading.review': 1500,
  'structured.other': 500,
};
/** Models that reason at their lowest setting (gpt-oss: minimum, cannot be disabled): output ×3 until a pilot calibrates it. */
export const isReasoner = (m: Pick<EvalModel, 'reasoning'>): boolean => m.reasoning?.policy === 'minimum';

export function budgetHooks(model: EvalModel, ctx: RunCtx): NonNullable<UnitContext['budget']> {
  const price = priceRowOf(model);
  return {
    reserve: (bytes, maxTokens) => {
      const worst = costOf(price, tokensFromBytes(bytes), maxTokens);
      try { ctx.guard.reserve(worst); } catch (error) { if (error instanceof BudgetExceeded) ctx.capHit = true; throw error; }
      return worst;
    },
    settle: (reserved, tokensIn, tokensOut) => {
      const actual = tokensIn === null || tokensOut === null ? reserved : costOf(price, tokensIn, tokensOut);
      ctx.guard.settle(reserved, actual);
      return actual;
    },
  };
}

/** A unit's worst case for the `started` line: the maxTokens of its happy-path calls plus a conservative input. */
function unitWorstUsd(model: EvalModel, c: CorpusCase, plannedCalls?: Array<{ requestBytes: number; maxTokens: number }>): number {
  const price = priceRowOf(model);
  const calls = plannedCalls ?? defaultCalls(c);
  return calls.reduce((s, x) => s + costOf(price, tokensFromBytes(x.requestBytes), Math.min(x.maxTokens, model.maxOutputTokens)), 0);
}

function defaultCalls(c: CorpusCase): Array<{ requestBytes: number; maxTokens: number }> {
  switch (useCaseOf(c.jobType)) {
    case 'review': return [{ requestBytes: 70_000, maxTokens: 4000 }];
    case 'interview': return [{ requestBytes: 5000, maxTokens: 220 }, { requestBytes: 15_000, maxTokens: 2200 }, { requestBytes: 5000, maxTokens: 220 }, { requestBytes: 15_000, maxTokens: 2200 }];
    case 'mentor': return [{ requestBytes: 45_000, maxTokens: 400 }, { requestBytes: 135_000, maxTokens: 2200 }, { requestBytes: 45_000, maxTokens: 400 }, { requestBytes: 135_000, maxTokens: 2200 }];
    case 'agentic': return [{ requestBytes: 42_000, maxTokens: 3000 }, { requestBytes: 70_000, maxTokens: 9000 }];
    case 'explanation': return [{ requestBytes: 54_000, maxTokens: 4500 }];
  }
}

async function drive(provider: OpenAiProvider, c: CorpusCase, root: string): Promise<ProductOutcome | { skipped: string }> {
  switch (useCaseOf(c.jobType)) {
    case 'review': {
      const d = readDerived<DerivedReview>(root, c);
      if (!d) return { skipped: 'no derived review input: run the derive phase first' };
      return runReview(provider, c, d);
    }
    case 'interview': return runInterview(provider, c);
    case 'mentor': {
      const d = readDerived<{ todosRemaining: string[] | null }>(root, c);
      return runMentor(provider, c, d?.todosRemaining ?? null);
    }
    case 'agentic': return runAgentic(provider, c);
    case 'explanation': {
      const d = readDerived<{ data: Record<string, unknown> }>(root, c);
      if (!d) return { skipped: 'no derived explanation input: run the derive phase first' };
      return runExplanation(provider, c, d);
    }
  }
}

export interface RawRecord {
  version: 'eval-raw-v1';
  runId: string;
  stage: string;
  modelKey: string;
  caseId: string;
  jobType: string;
  useCase: string;
  mode: ArmMode;
  product: ProductOutcome;
  calls: CallRecord[];
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** sha256 of the frozen corpus-derived input this unit read (null when the job type has none): equal across models. */
  derivedSha256: string | null;
  startedAt: string;
  finishedAt: string;
}

/** The digest of a case's frozen derived input, as the drivers read it. */
function derivedSha256Of(root: string, c: CorpusCase): string | null {
  const file = derivedPath(root, c);
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}

/** One model lane over a list of cases. Returns why it stopped, if it stopped early. */
export async function candidateLane(ctx: RunCtx, model: EvalModel, cases: CorpusCase[], stage = 'candidates', deps: LaneDeps = {}): Promise<string | null> {
  let provider: OpenAiProvider;
  const driveUnit = deps.drive ?? drive;
  let transientRun = 0;
  try {
    provider = await (deps.makeProvider ?? makeProvider)(model, { mode: ctx.mode, stubPort: ctx.stubPort });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'provider construction failed';
    return /AWS login needed/.test(message) ? 'AWS login needed' : `provider unavailable (${message.replace(/arn:\S+/g, '[arn]')})`;
  }
  let n = 0;
  for (const c of cases) {
    if (ctx.capHit) return 'stopped_at_cap';
    if (awsLoginNeeded()) return 'AWS login needed';
    if (harnessFault()) return HARNESS_STOP;
    const unit = unitId(ctx.runId, stage, model.key, c.jobType, c.id);
    const st = ctx.ledger.status(unit);
    if (st.done) continue;
    if (st.failed || st.attempts >= 2) { if (!st.failed) await ctx.ledger.append({ unit, stage, model: model.key, jobType: c.jobType, case: c.id, event: 'failed', costUsd: 0 }); continue; }
    const worstUsd = ctx.mode === 'stub' ? 0 : unitWorstUsd(model, c);
    await ctx.ledger.append({ unit, stage, model: model.key, jobType: c.jobType, case: c.id, event: 'started', costUsd: 0, worstUsd });
    const unitCtx: UnitContext = {
      unitId: unit, modelKey: model.key, caseId: c.id, jobType: c.jobType, calls: [], current: null,
      budget: budgetHooks(model, ctx),
      ...(ctx.mode === 'stub' ? { replay: candidateReplay(c) } : {}),
    };
    const startedAt = new Date().toISOString();
    const derivedSha256 = derivedSha256Of(ctx.root, c);
    const outcome = await unitStore.run(unitCtx, () => driveUnit(provider, c, ctx.root));
    const cost = unitCtx.calls.reduce((s, x) => s + (x.costUsd || 0), 0);
    if (harnessFault() || unitCtx.calls.some((x) => x.outcome === 'harness_fault')) {
      // Never a model result: no raw record, not an attempt; the whole run stops for the switch to be fixed.
      await ctx.ledger.append({ unit, stage, model: model.key, jobType: c.jobType, case: c.id, event: 'failed:harness', costUsd: cost });
      ctx.ledger.writeSpend({ mode: ctx.mode });
      return HARNESS_STOP;
    }
    if ('skipped' in outcome) {
      await ctx.ledger.append({ unit, stage, model: model.key, jobType: c.jobType, case: c.id, event: 'skipped', costUsd: cost });
      continue;
    }
    if (ctx.capHit || unitCtx.calls.some((x) => x.outcome === 'budget_stop')) {
      await ctx.ledger.append({ unit, stage, model: model.key, jobType: c.jobType, case: c.id, event: 'stopped_at_cap', costUsd: cost });
      ctx.capHit = true;
      return 'stopped_at_cap';
    }
    if (awsLoginNeeded() || unitCtx.calls.some((x) => x.outcome === 'credentials')) {
      await ctx.ledger.append({ unit, stage, model: model.key, jobType: c.jobType, case: c.id, event: 'failed:credentials', costUsd: cost });
      return 'AWS login needed';
    }
    if (unitIsTransient(unitCtx.calls)) {
      // The infrastructure failed, not the model: not scored, not an attempt, retried on resume.
      await ctx.ledger.append({ unit, stage, model: model.key, jobType: c.jobType, case: c.id, event: 'failed:transient', costUsd: cost });
      transientRun += 1;
      if (transientRun >= TRANSIENT_BREAKER) {
        (ctx.transientStops ??= []).push(`${stage}:${model.key}`);
        ctx.ledger.writeSpend({ mode: ctx.mode });
        return TRANSIENT_STOP;
      }
      continue;
    }
    transientRun = 0;
    const record: RawRecord = {
      version: 'eval-raw-v1', runId: ctx.runId, stage, modelKey: model.key, caseId: c.id, jobType: c.jobType, useCase: useCaseOf(c.jobType), mode: ctx.mode,
      product: outcome, calls: unitCtx.calls, costUsd: cost,
      tokensIn: unitCtx.calls.reduce((s, x) => s + (x.tokensIn ?? 0), 0),
      tokensOut: unitCtx.calls.reduce((s, x) => s + (x.tokensOut ?? 0), 0),
      latencyMs: unitCtx.calls.reduce((s, x) => s + (x.latencyMs ?? 0), 0),
      derivedSha256,
      startedAt, finishedAt: new Date().toISOString(),
    };
    writeJson(rawPath(ctx.runDir, model.key, c.jobType, c.id), record);
    await ctx.ledger.append({ unit, stage, model: model.key, jobType: c.jobType, case: c.id, event: 'done', costUsd: cost });
    n += 1;
    if (n % 10 === 0) { ctx.ledger.writeSpend({ mode: ctx.mode }); say(`  ${model.key}: ${n} units this session; run spend US$${ctx.ledger.spent().toFixed(4)}`); }
  }
  ctx.ledger.writeSpend({ mode: ctx.mode });
  return null;
}

export async function runCandidates(ctx: RunCtx, options: { models?: string[]; perJob?: number } = {}): Promise<Record<string, string | null>> {
  const lanes = ctx.models.filter((m) => (m.role === 'candidate' || m.role === 'reference') && m.runnable && (!options.models || options.models.includes(m.key)));
  const cases = options.perJob ? pickPerJob(ctx.cases, options.perJob) : ctx.cases;
  say(`candidates: ${lanes.length} lanes × ${cases.length} cases (${ctx.mode}); stop at US$${ctx.stopUsd}`);
  const results = await Promise.all(lanes.map(async (m) => [m.key, await candidateLane(ctx, m, cases)] as const));
  return Object.fromEntries(results);
}

/** The first n cases of each job type, labelled cases first: the pilot's sample. */
export function pickPerJob(cases: CorpusCase[], n: number): CorpusCase[] {
  const out: CorpusCase[] = [];
  const by = new Map<string, CorpusCase[]>();
  for (const c of cases) by.set(c.jobType, [...(by.get(c.jobType) ?? []), c]);
  for (const list of by.values()) {
    const labelled = list.filter((c) => c.reference.status === 'labelled');
    out.push(...[...labelled, ...list.filter((c) => c.reference.status !== 'labelled')].slice(0, n));
  }
  return out;
}

/** Executable truth for every accepted proposal on a code phase: local, sandboxed, free. A few in parallel. */
export async function runExec(ctx: RunCtx, parallel = 3): Promise<{ run: number; notRun: number; skipped: number }> {
  const jobs: Array<{ model: string; c: CorpusCase }> = [];
  for (const m of ctx.models) {
    for (const c of ctx.cases.filter((x) => x.jobType === 'agentic-proposal' && x.input.executable)) {
      const raw = readIf<RawRecord>(rawPath(ctx.runDir, m.key, c.jobType, c.id));
      if (!raw) continue;
      if (fs.existsSync(execPath(ctx.runDir, m.key, c.id))) continue;
      jobs.push({ model: m.key, c });
    }
  }
  let run = 0;
  let notRun = 0;
  let skipped = 0;
  const scratch = ensureDir(path.join(ctx.scratch, `exec-${ctx.runId}`));
  if (jobs.length) {
    const preflight = await seatbeltPreflight(scratch);
    say(`exec: Seatbelt preflight ${preflight.ok ? 'passed' : `FAILED (${preflight.failures.join(', ')}): executable truth is not_run`}`);
  }
  const queue = [...jobs];
  await Promise.all(Array.from({ length: parallel }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const raw = readJson<RawRecord>(rawPath(ctx.runDir, job.model, job.c.jobType, job.c.id));
      const files = (raw.product.files ?? null) as Record<string, string> | null;
      const result = await execTruth(job.c, files, (raw.product.rawPaths as string[] | undefined) ?? Object.keys(files ?? {}), scratch);
      writeJson(execPath(ctx.runDir, job.model, job.c.id), { version: 'eval-exec-v1', modelKey: job.model, caseId: job.c.id, method: 'product grader + runner + analyser under macOS sandbox-exec (preflight canary passed; network denied; exec only the pinned Python/Node and the runner runtime; no open/osascript; home unreadable except the toolchains; writes confined; 60 s)', ...result });
      if (result.status === 'run') run += 1; else if (result.status === 'not_run') notRun += 1; else skipped += 1;
    }
  }));
  say(`exec: ${run} run, ${notRun} not run, ${skipped} not applicable`);
  return { run, notRun, skipped };
}

export function runIdFor(corpusDigest: string, modelsDigest: string, prefix = ''): string {
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
  return `${prefix}${stamp}-${sha256(`${corpusDigest}|${modelsDigest}`).slice(0, 8)}`;
}
