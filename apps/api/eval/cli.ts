import './boot';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { SpendGuard, HARD_STOP_USD, pilotGuard } from './budget';
import { stratifiedSample } from './judge/sampling';
import { REFERENCE_KEY, loadCorpus, loadModels, type CorpusCase } from './contracts';
import { deriveAll } from './derive';
import { ensureDir, evalRoot, readJson, say, scratchRoot, sha256, writeJson } from './io';
import { Ledger, rawPath } from './ledger';
import { corpusPrivacyPatternsFile, loadCorpusPrivacyPatterns, privacyFindings } from './privacy';
import { HARNESS_STOP, runCandidates, runExec, runIdFor, pickPerJob, type RunCtx } from './runner';
import { DEFAULT_JUDGE_PLAN, PILOT_JUDGE_PLAN, judgesOf, reparseRun, runJudges, type JudgePlan, type JudgeStage } from './judge/judge';
import { composeSizes, calibrationFrom, globalRealSpend, refuseUnfitOrStalePlan, refuseWithoutReasoningProbe, writePilotEstimate, writePlan } from './plan';
import { scoreRun, writeScores } from './score/score';
import { ingestSpotcheck, writeReport } from './report/report';
import { EVAL_REGION, awsLoginNeeded, canonicalJson, evalConverseSend, harnessFault, stubConverseProbeInner } from './transport/aws';
import { newCall, unitStore, type UnitContext } from './capture';
import { budgetHooks } from './runner';
import { loadReferenceKey } from './arms';
import { starterFixtureState } from './world';
import { startStub } from './transport/stub';
import { assertReasoningOffFields } from './provider/bedrock-settings';
import { EVAL_TEMPERATURE } from './provider/converse';

/**
 * The evaluation CLI (apps/api/eval/README.md gives the order of phases):
 *
 *   derive   [--only id,id] [--force]
 *   plan     --run <id> [--calibrate <pilotRunId>] [--stop-usd 45]
 *   probe    --run <id> --reasoning [--stub]    (one short call per slate Bedrock model with its switch; required before a paid run)
 *   run      --run <id> [--stage candidates,exec,judgeA,judgeB,judgeC,pairwise,rejudge|all] [--models k,k] [--per-job N | --sample F] [--stop-usd 45] [--stub]
 *   score    --run <id>
 *   report   --run <id>
 *   spotcheck --run <id> --ingest <csv>
 *   reparse  --run <id>
 *   privacy  --run <id>
 *
 * Stdout carries aliases, counts and dollars only.
 */

const REASONING_PROBE_NOTE = 'Thinking is off for every Bedrock model. Each model is sent its documented switch (contracts.ts REASONING_SWITCHES, recorded in plan.json); every response is asserted to carry no reasoningContent block, no reasoning-token count and no <think> text, else the run stops as a harness fault (never a model result); gpt-oss runs at reasoning_effort low (reasoning: minimum, cannot be disabled). A real run refuses to start without a passing reasoning probe (probe --reasoning) for the same switches.';

/** The Bedrock model the plan composes every call through to size it (against the stub, so the choice costs nothing). */
const PLAN_COMPOSITION_MODEL = 'nova-micro';
/** The models an ad hoc probe calls when --models is not given. */
const PROBE_DEFAULT_MODELS = 'nova-micro,gpt-oss-20b';
/** How many files with privacy findings the privacy phase names before it stops listing. */
const PRIVACY_LINES_SHOWN = 40;

const args = process.argv.slice(2);
const phase = args[0];
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name: string): boolean => args.includes(`--${name}`);

function harnessDigest(): string {
  const dir = __dirname;
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
  walk(dir);
  files.push(path.join(dir, '..', 'src', 'assistant', 'openai.provider.ts'));
  return sha256(files.sort().map((f) => `${path.relative(dir, f)}\0${fs.readFileSync(f, 'utf8')}`).join('\0'));
}

async function openRun(root: string, mode: 'real' | 'stub', stopUsd: number) {
  const { cases, digest } = loadCorpus(root);
  const loaded = loadModels(root);
  const runId = opt('run') ?? runIdFor(digest, loaded.digest, mode === 'stub' ? 'dry-' : '');
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('bad run id');
  const runDir = ensureDir(path.join(root, 'runs', runId));
  const runFile = path.join(runDir, 'run.json');
  let run: Record<string, any>;
  if (fs.existsSync(runFile)) {
    run = readJson(runFile);
    if (run.mode !== mode) throw new Error(`run ${runId} is a ${run.mode} run; refusing to mix in ${mode} work`);
    if (run.corpusDigest !== digest) say('warning: the corpus changed since this run started; raw records from before stay as they are');
  } else {
    run = {
      version: 'eval-run-v1', runId, mode, createdAt: new Date().toISOString(), corpusDigest: digest, modelsDigest: loaded.digest, harnessDigest: harnessDigest(),
      settings: { perCallTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS), temperature: EVAL_TEMPERATURE, structured: 'text', concurrencyPerModel: 1, stopUsd, region: EVAL_REGION, reasoning: 'off for every Bedrock model; gpt-oss at its minimum, cannot be disabled',
        reasoningSwitches: Object.fromEntries(loaded.models.filter((m) => m.provider === 'bedrock').map((m) => [m.key, { policy: m.reasoning.policy, fields: m.reasoning.fields, source: m.reasoning.source }])),
        reasoningProbe: REASONING_PROBE_NOTE,
        judges: judgesOf(loaded.models).map((j) => ({ slot: j.judgeSlot, key: j.key })), selfExclusion: true },
      models: loaded.models.map((m) => ({ key: m.key, label: m.label, modelId: m.modelId, role: m.role, class: m.class, tier: m.tier, judgeSlot: m.judgeSlot ?? null, reasoning: m.reasoning.policy, runnable: m.runnable, notRunReason: m.notRunReason })),
      droppedModels: loaded.dropped,
      salt: randomBytes(12).toString('hex'),
    };
    writeJson(runFile, run);
  }
  // The Shelf starter the cases are composed against: recorded beside run.json, never mixed within a run.
  const starter = starterFixtureState();
  const inputsFile = path.join(runDir, 'inputs.json');
  if (!fs.existsSync(inputsFile)) writeJson(inputsFile, { version: 'eval-inputs-v1', runId, starterFixture: starter, note: 'state is the label in .eval-starter-state (unknown without one); sha256 covers every file of the starter fixture.', at: new Date().toISOString() });
  else {
    const was = readJson<{ starterFixture?: { sha256?: string; state?: string } }>(inputsFile).starterFixture;
    if (was?.sha256 && was.sha256 !== starter.sha256) {
      const why = `the Shelf starter fixture changed since this run started (was ${was.state ?? '?'}, now ${starter.state}); restore the fixture this run started with before resuming`;
      if (mode === 'real') throw new Error(why);
      say(`warning: ${why}`);
    }
  }
  if (phase === 'run' || phase === 'plan') say(`Shelf starter fixture: ${starter.state} (${starter.sha256.slice(0, 12)}, ${starter.files} files)`);
  const ledger = new Ledger(runDir, runId);
  const spentElsewhere = mode === 'real' ? globalRealSpend(root) : ledger.spent();
  const guard = new SpendGuard(stopUsd, spentElsewhere);
  const ctx: RunCtx = { runId, runDir, root, mode, stopUsd, models: loaded.models, cases, ledger, guard, scratch: scratchRoot(), salt: run.salt, capHit: false };
  return { ctx, run, dropped: loaded.dropped };
}

/**
 * One real `run` process at a time across all runs: two processes would put two
 * requests in flight for the same model, and two guards would not see each
 * other's reservations. The lock names a pid; a lock whose pid is gone is stale.
 */
function takeRunLock(root: string): void {
  const lock = path.join(ensureDir(path.join(root, 'runs')), '.run.lock');
  try {
    const held = Number(fs.readFileSync(lock, 'utf8'));
    if (held && held !== process.pid) {
      try { process.kill(held, 0); throw new Error('another real run is in progress (runs/.run.lock); one run at a time keeps one request in flight per model'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  fs.writeFileSync(lock, String(process.pid), { mode: 0o600 });
  process.on('exit', () => { try { if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock); } catch { /* gone */ } });
}

async function withStub<T>(ctx: RunCtx, work: () => Promise<T>): Promise<T> {
  if (ctx.mode !== 'stub') return work();
  const stub = await startStub();
  ctx.stubPort = stub.port;
  try { return await work(); } finally { stub.stop(); }
}

function stopUsdArg(): number {
  const v = Number(opt('stop-usd') ?? HARD_STOP_USD);
  if (!(v > 0) || v > HARD_STOP_USD) throw new Error(`--stop-usd must be in (0, ${HARD_STOP_USD}]`);
  return v;
}

async function main(): Promise<number> {
  const root = evalRoot();
  loadCorpusPrivacyPatterns(corpusPrivacyPatternsFile(root));
  if (phase === 'derive') {
    const { cases } = loadCorpus(root);
    const summary = await deriveAll(root, cases, scratchRoot(), { only: opt('only')?.split(','), force: flag('force') });
    say(`derive summary ${JSON.stringify(summary)}`);
    return 0;
  }
  if (phase === 'plan') {
    const stopUsd = stopUsdArg();
    const { ctx } = await openRun(root, flag('stub') ? 'stub' : 'real', stopUsd);
    // Composition runs against the loopback stub in a scratch run: nothing leaves the machine.
    const scratchRun = ensureDir(path.join(ctx.scratch, `plan-${ctx.runId}`));
    const planCtx: RunCtx = { ...ctx, runDir: scratchRun, mode: 'stub', ledger: new Ledger(scratchRun, `plan-${ctx.runId}`), guard: new SpendGuard(HARD_STOP_USD, 0), capHit: false };
    const probe = ctx.models.find((m) => m.key === PLAN_COMPOSITION_MODEL);
    if (!probe) throw new Error(`the plan composes every call through ${PLAN_COMPOSITION_MODEL}, which models.json does not list`);
    const sizes = await withStub(planCtx, () => composeSizes(planCtx, probe));
    const pilot = opt('calibrate');
    const calibration = pilot ? calibrationFrom(path.join(root, 'runs', pilot)) : {};
    writePlan(ctx.runDir, ctx.models, sizes, stopUsd, ctx.mode === 'real' ? globalRealSpend(root, { exclude: ctx.runId }) : 0, calibration, pilot ?? null);
    if (opt('pilot-per-job')) {
      // The pilot's own estimate (its cases, the pilot judge plan), recorded beside the full plan.
      const want = new Set(pickPerJob(ctx.cases, Number(opt('pilot-per-job'))).map((c) => c.id));
      writePilotEstimate(ctx.runDir, ctx.models, sizes.filter((x) => want.has(x.caseId)), PILOT_JUDGE_PLAN, Number(opt('pilot-cap') ?? 6), calibration);
    }
    say(`plan written for run ${ctx.runId}`);
    return 0;
  }
  if (phase === 'run') {
    const stopUsd = stopUsdArg();
    if (!flag('stub')) takeRunLock(root);
    const { ctx } = await openRun(root, flag('stub') ? 'stub' : 'real', stopUsd);
    const stages = (opt('stage') ?? 'all').split(',');
    const all = stages.includes('all');
    const perJob = opt('per-job') ? Number(opt('per-job')) : undefined;
    if (perJob) ctx.cases = pickPerJob(ctx.cases, perJob);
    if (opt('cases')) { const want = new Set(opt('cases')!.split(',')); ctx.cases = ctx.cases.filter((c: CorpusCase) => want.has(c.id)); }
    if (opt('sample')) {
      // A stratified sample by job type (at least one case per job type), seeded by the run's salt: the same cases on resume.
      const f = Number(opt('sample'));
      if (!(f > 0 && f <= 1)) throw new Error('--sample takes a fraction in (0, 1]');
      ctx.cases = stratifiedSample(ctx.cases, f, (c) => c.jobType, `${ctx.salt}|sample`);
      say(`sample: ${ctx.cases.length} cases (${Math.round(f * 100)}% stratified by job type)`);
    }
    const planFile = path.join(ctx.runDir, 'plan.json');
    const plan = fs.existsSync(planFile) ? readJson<{ version?: string; judgePlan: JudgePlan; fits: boolean; alreadySpentUsd: number; stopUsd: number }>(planFile) : null;
    if (flag('no-plan') && ctx.mode === 'real') throw new Error('--no-plan is for stub runs only: the estimate comes before any paid phase');
    if (ctx.mode === 'real') {
      if (!plan) throw new Error('no plan.json for this run: run the plan phase first (the estimate comes before any paid phase)');
      refuseUnfitOrStalePlan(plan, globalRealSpend(root, { exclude: ctx.runId }), stopUsd);
      refuseWithoutReasoningProbe(ctx.runDir, ctx.models);
    }
    const pilotPlan = opt('judge-plan') === 'pilot';
    if (opt('judge-plan') && !pilotPlan) throw new Error('--judge-plan takes only "pilot"');
    const judgePlan = pilotPlan ? PILOT_JUDGE_PLAN : plan?.judgePlan ?? DEFAULT_JUDGE_PLAN;
    if (opt('pilot-cap')) {
      // The pilot's cap sits inside the stop: at most this much on top of every other real run's spend.
      ctx.guard = pilotGuard({ stopUsd, spentElsewhere: ctx.mode === 'real' ? globalRealSpend(root, { exclude: ctx.runId }) : 0, spentThisRun: ctx.ledger.spent(), pilotCapUsd: Number(opt('pilot-cap')) });
      say(`pilot cap: US$${Number(opt('pilot-cap')).toFixed(2)} for this run; guard stops at US$${ctx.guard.cap.toFixed(4)} committed across all real runs`);
    }
    if (pilotPlan || opt('pilot-cap')) writeJson(path.join(ctx.runDir, 'pilot.json'), { judgePlan, pilotCapUsd: opt('pilot-cap') ? Number(opt('pilot-cap')) : null, guardCapUsd: ctx.guard.cap, perJob: perJob ?? null, cases: ctx.cases.length, at: new Date().toISOString() });
    say(`run ${ctx.runId} (${ctx.mode}); already committed US$${ctx.guard.committed.toFixed(4)} of US$${stopUsd}`);
    const outcome: Record<string, unknown> = {};
    await withStub(ctx, async () => {
      if (all || stages.includes('candidates')) outcome.candidates = await runCandidates(ctx, { models: opt('models')?.split(',') });
      if (!ctx.capHit && !awsLoginNeeded() && !harnessFault() && (all || stages.includes('exec'))) outcome.exec = await runExec(ctx);
      const judgeStages = (['A', 'B', 'C', 'pairwise', 'rejudge'] as JudgeStage[]).filter((s) => all || stages.includes(s.length === 1 ? `judge${s}` : s));
      const go = () => !ctx.capHit && !awsLoginNeeded() && !harnessFault();
      if (go() && judgeStages.length) {
        // Absolute (A, B, C) and pairwise first, one lane per judge-model; the re-judge samples the finished absolute units.
        const first = judgeStages.filter((s) => s !== 'rejudge');
        if (first.length) outcome.judges = await runJudges(ctx, judgePlan, first);
        if (go() && judgeStages.includes('rejudge')) outcome.rejudge = await runJudges(ctx, judgePlan, ['rejudge']);
      }
    });
    ctx.ledger.writeSpend({ mode: ctx.mode, stopUsd, capHit: ctx.capHit, awsLoginNeeded: awsLoginNeeded(), transientStops: ctx.transientStops ?? [], harnessFault: harnessFault() });
    say(`run outcome ${JSON.stringify(outcome)}`);
    if (harnessFault()) { say(`${HARNESS_STOP}: ${harnessFault()}. Nothing from the faulty unit was scored. Fix the switch in contracts.ts REASONING_SWITCHES, re-probe, then resume with the same command.`); return 7; }
    if (awsLoginNeeded()) { say('AWS login needed: run `aws login` (or `aws sso login`) for your AWS_PROFILE, then the same command again to resume'); return 4; }
    if (ctx.capHit) { say(`stopped_at_cap: the US$${stopUsd} stop was reached; the ledger records where`); return 5; }
    if (ctx.transientStops?.length) { say(`transient errors: resume later (lanes stopped: ${ctx.transientStops.join(', ')}); the same command resumes and retries those units`); return 6; }
    say(`run spend US$${ctx.ledger.spent().toFixed(4)}`);
    return 0;
  }
  if (phase === 'score' || phase === 'report') {
    const runId = opt('run');
    if (!runId) throw new Error('--run is required');
    const runDir = path.join(root, 'runs', runId);
    const run = readJson<Record<string, any>>(path.join(runDir, 'run.json'));
    const { cases } = loadCorpus(root);
    const loaded = loadModels(root);
    const units = await scoreRun(runDir, root, cases, loaded.models.filter((m) => m.role === 'candidate' || m.role === 'reference'));
    writeScores(runDir, units);
    say(`scored ${units.length} units`);
    if (phase === 'score') return 0;
    const plan = fs.existsSync(path.join(runDir, 'plan.json')) ? readJson<Record<string, any>>(path.join(runDir, 'plan.json')) : null;
    const spend = fs.existsSync(path.join(runDir, 'spend.json')) ? readJson<Record<string, any>>(path.join(runDir, 'spend.json')) : null;
    // The cases this run actually ran (a sampled or per-job run states its own count, not the corpus's).
    const ran = cases.filter((c) => loaded.models.some((m) => fs.existsSync(rawPath(runDir, m.key, c.jobType, c.id))));
    if (ran.length !== cases.length) say(`report covers the ${ran.length} of ${cases.length} corpus cases this run ran`);
    const out = writeReport({ runId, runDir, root, mode: run.mode, models: loaded.models, cases: ran, units, run, plan, spend, droppedModels: run.droppedModels ?? loaded.dropped, salt: run.salt }, opt('out') || undefined);
    say(`report written: ${out.files.join(', ')}`);
    return 0;
  }
  if (phase === 'probe') {
    // Transport check before a paid phase: one short Converse call per named model through the
    // eval's send (credentials, region, reasoning switch and the response assertion), and the
    // reference key read into memory. Billed as a real run so it counts toward the spend stop.
    // --reasoning probes every slate Bedrock model (candidates and judges) with its documented
    // switch and writes reasoning-probe.json, which a real run requires.
    const stub = flag('stub');
    if (stub && !flag('reasoning')) throw new Error('--stub is only for the reasoning probe');
    const { ctx } = await openRun(root, stub ? 'stub' : 'real', HARD_STOP_USD);
    const reasoningProbe = flag('reasoning');
    const keys = reasoningProbe ? ctx.models.filter((m) => m.provider === 'bedrock' && m.runnable).map((m) => m.key) : (opt('models') ?? PROBE_DEFAULT_MODELS).split(',');
    const noFields = opt('fields') === 'none';
    const probeFields = !reasoningProbe && opt('fields') && !noFields ? JSON.parse(opt('fields')!) as Record<string, unknown> : null;
    const probeMaxTokens = Math.min(64, Math.max(5, Number(opt('max-tokens') ?? (reasoningProbe ? 64 : 5))));
    const results: Record<string, string> = {};
    const verdicts: Record<string, { ok: boolean; policy: string; fields: string | null; reasoningBlocks: number; reasoningTokens: number; thinkText: boolean; tokensOut: number | null; stopReason: string | null; error: string | null }> = {};
    const stubHandle = stub ? await (await import('./transport/stub')).startStub() : null;
    try {
      for (const key of keys) {
        const model = ctx.models.find((m) => m.key === key && m.provider === 'bedrock');
        if (!model) { results[key] = 'not a Bedrock slate key'; continue; }
        if (harnessFault() && reasoningProbe) break;
        const unit = `probe|${key}|${Date.now()}`;
        await ctx.ledger.append({ unit, stage: 'probe', model: key, jobType: 'probe', case: 'probe', event: 'started', costUsd: 0, worstUsd: stub ? 0 : 0.001 });
        const record = newCall('probe', 1);
        const unitCtx: UnitContext = { unitId: unit, modelKey: key, caseId: 'probe', jobType: 'probe', calls: [record], current: record, budget: budgetHooks(model, ctx) };
        const fields = reasoningProbe ? model.reasoning.fields : noFields ? null : probeFields ?? model.additionalModelRequestFields;
        try {
          // The reasoning probe asserts exactly as the run does (the model's own policy); an ad hoc probe only counts.
          const send = evalConverseSend({ maxOutputTokens: model.maxOutputTokens, reasoning: reasoningProbe ? { policy: model.reasoning.policy, fields: model.reasoning.fields } : { policy: 'minimum', fields }, ...(stubHandle ? { inner: stubConverseProbeInner() } : {}) });
          if (fields) assertReasoningOffFields(fields);
          const input = { modelId: model.modelId, messages: [{ role: 'user' as const, content: [{ text: 'A shop sells pens at 3 for 2 dollars. How much do 12 pens cost? Reply with the number only.' }] }], inferenceConfig: { maxTokens: probeMaxTokens, temperature: EVAL_TEMPERATURE }, ...(fields ? { additionalModelRequestFields: fields as never } : {}) };
          await unitStore.run(unitCtx, () => send(input as never, AbortSignal.timeout(30_000)));
          const think = /<think>\s*\S/i.test(record.responseText ?? '');
          verdicts[key] = { ok: record.reasoningBlocks === 0 || model.reasoning.policy === 'minimum', policy: model.reasoning.policy, fields: fields ? canonicalJson(fields) : null, reasoningBlocks: record.reasoningBlocks, reasoningTokens: record.reasoningTokens, thinkText: think, tokensOut: record.tokensOut, stopReason: record.stopReason, error: null };
          results[key] = `ok policy=${model.reasoning.policy} fields=${fields ? JSON.stringify(fields) : 'none'} stop=${record.stopReason} in=${record.tokensIn} out=${record.tokensOut} reasoningBlocks=${record.reasoningBlocks} reasoningTokens=${record.reasoningTokens} thinkTagInText=${think} ${record.latencyMs}ms`;
        } catch (error) {
          const why = awsLoginNeeded() ? 'AWS login needed' : record.outcome === 'harness_fault' ? `HARNESS FAULT: ${harnessFault()}` : `failed (${record.errorName ?? 'error'}${record.httpStatus ? ` HTTP ${record.httpStatus}` : ''})`;
          verdicts[key] = { ok: false, policy: model.reasoning.policy, fields: fields ? canonicalJson(fields) : null, reasoningBlocks: record.reasoningBlocks, reasoningTokens: record.reasoningTokens, thinkText: false, tokensOut: record.tokensOut, stopReason: record.stopReason, error: why };
          results[key] = `${why} fields=${JSON.stringify(fields ?? null)}`;
        }
        await ctx.ledger.append({ unit, stage: 'probe', model: key, jobType: 'probe', case: 'probe', event: 'done', costUsd: record.costUsd });
        if (awsLoginNeeded()) break;
      }
    } finally { stubHandle?.stop(); }
    if (reasoningProbe) writeJson(path.join(ctx.runDir, 'reasoning-probe.json'), { version: 'eval-reasoning-probe-v1', mode: ctx.mode, at: new Date().toISOString(), models: verdicts, allOk: keys.every((k) => verdicts[k]?.ok) });
    if (flag('reference-key') && !stub) {
      try { await loadReferenceKey(); results[REFERENCE_KEY] = 'reference key read into memory from Secrets Manager (not printed, not written)'; } catch (error) { results[REFERENCE_KEY] = (error as Error).message; }
    }
    ctx.ledger.writeSpend({ mode: ctx.mode });
    for (const [k, v] of Object.entries(results)) say(`probe ${k}: ${v}`);
    say(`probe spend US$${ctx.ledger.spent().toFixed(6)}`);
    if (awsLoginNeeded()) return 4;
    if (harnessFault()) { say(`${HARNESS_STOP}: ${harnessFault()}`); return 7; }
    return reasoningProbe && !keys.every((k) => verdicts[k]?.ok) ? 8 : 0;
  }
  if (phase === 'reparse') {
    // Offline: the judge-only format tolerance (judge/repair.ts) over judgements already on disk; no call is made.
    const runId = opt('run');
    if (!runId) throw new Error('--run is required');
    const runDir = path.join(root, 'runs', runId);
    const run = readJson<Record<string, any>>(path.join(runDir, 'run.json'));
    say(`reparse ${JSON.stringify(reparseRun(runDir, run.salt))}`);
    return 0;
  }
  if (phase === 'privacy') {
    // Offline: the privacy scan over every file a run wrote. Prints the finding kinds per file, never the matched text.
    const runId = opt('run');
    if (!runId) throw new Error('--run is required');
    const runDir = path.join(root, 'runs', runId);
    let files = 0;
    const hits: Array<{ file: string; kinds: string[] }> = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) {
          files += 1;
          const kinds = [...new Set(privacyFindings(fs.readFileSync(file, 'utf8')).map((f) => f.kind))];
          if (kinds.length) hits.push({ file: path.relative(runDir, file), kinds });
        }
      }
    };
    walk(runDir);
    say(`privacy scan: ${files} files, ${hits.length} with findings`);
    for (const hit of hits.slice(0, PRIVACY_LINES_SHOWN)) say(`  ${hit.file}: ${hit.kinds.join(', ')}`);
    return hits.length ? 1 : 0;
  }
  if (phase === 'spotcheck') {
    const runId = opt('run');
    const csv = opt('ingest');
    if (!runId || !csv) throw new Error('--run and --ingest are required');
    const result = ingestSpotcheck(path.join(root, 'runs', runId), csv);
    say(`spot-check ingested: ${JSON.stringify(result)}; re-run the report phase to include it`);
    return 0;
  }
  say('usage: run.sh derive|plan|probe|run|score|report|spotcheck|reparse|privacy (see apps/api/eval/README.md)');
  return 3;
}

main().then((code) => process.exit(code)).catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  say(`error: ${message.replace(/arn:\S+/g, '[arn]')}`);
  process.exit(/AWS login needed/.test(message) ? 4 : 1);
});
