import * as fs from 'fs';
import * as path from 'path';
import type { CorpusCase, EvalModel, UseCase } from '../contracts';
import { DEFAULT_EVAL_CALL_TIMEOUT_MS, displayLabel, JUDGE_SLOTS, REASONING_MINIMUM_NOTE, REFERENCE_MODEL_ID, useCaseOf } from '../contracts';
import { EVAL_TEMPERATURE } from '../provider/converse';
import { HARD_STOP_USD } from '../budget';
import { BALANCE } from './balanced';
import { ensureDir, readJson, writeAtomic, writeJson } from '../io';
import { assertNoPrivateData, redactForStdout } from '../privacy';
import { rubricAppendix } from '../judge/rubrics';
import { judgeable, judgesOf, primaryJudgeFor } from '../judge/judge';
import { renderOutput, judgeContext, clip } from '../judge/payload';
import { seededShuffle, stratifiedSample } from '../judge/sampling';
import { Ledger, execPath, rawPath, readIf } from '../ledger';
import type { RawRecord } from '../runner';
import type { ExecTruth } from '../exec-truth';
import type { UnitScore } from '../score/score';
import { BALANCED_CSV_COLUMNS, buildBalanced } from './balanced-report';
import { MIX, USE_CASES, WEIGHTS, FIXED_WEIGHT, JUDGE_WEIGHT, cellJudgeMean, costPer1000, isSelfJudgement, judgeReliability, loadJudgements, overall, recommend, scorecards, sensitivity, type JudgeRecord, type Scorecard } from './analysis';

/**
 * The report: report.md, report.html (self-contained: tables and inline SVG
 * bars, no external script), scores.csv, rankings.json,
 * summary-for-sponsor.md, judge-prompts.md and the human spot-check sheet.
 * Every file is privacy-scanned before it is written; a hit refuses the write.
 */

const f2 = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));
const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(0)}%`);
const usd = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? 'n/a' : `$${x.toFixed(d)}`);
const sec = (ms: number | null | undefined) => (ms === null || ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);

const CAVEAT = 'Quality was measured on Bedrock-hosted weights of the same open models. On-premise latency and throughput depend on the sponsor\'s hardware and serving stack and are not measured here. Structured-output validity measured here is a lower bound for an on-prem server that enforces JSON schemas (vLLM, TGI or llama.cpp server behind the product\'s existing OpenAI-compatible path, which sends `response_format: json_schema, strict: true`).';
const ONPREM_NOTE = 'The review and Guided-review prompts are long (median about 11k tokens). An on-prem deployment must use an OpenAI-compatible server with at least 32k context (64k or more preferred).';

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export interface ReportInputs {
  runId: string; runDir: string; root: string; mode: string; models: EvalModel[]; cases: CorpusCase[]; units: UnitScore[];
  run: Record<string, any>; plan: Record<string, any> | null; spend: Record<string, any> | null; droppedModels: string[]; salt: string;
}

export function buildReport(input: ReportInputs) {
  const judgements = loadJudgements(input.runDir);
  const scored = input.models.filter((m) => m.role === 'candidate' || m.role === 'reference');
  const judges = judgesOf(input.models);
  const cards = scorecards(input.units, judgements, scored);
  const keys = scored.filter((m) => cards.some((c) => c.modelKey === m.key)).map((m) => m.key);
  const ranking = keys.map((k) => ({ k, s: overall(cards, k) })).sort((a, b) => (b.s ?? -1) - (a.s ?? -1));
  const sens = sensitivity(cards, keys);
  const recs = recommend(cards, scored);
  const rel = judgeReliability(judgements);
  // A model that fits its one GPU only quantised to Int4 carries that in its name everywhere.
  const label = (k: string) => { const m = input.models.find((x) => x.key === k); return m ? `${displayLabel(m)}${m.class === 'onprem' && /Int4/.test(m.hardware) ? ' (Int4)' : ''}` : k; };
  const cls = (k: string) => { const m = input.models.find((x) => x.key === k); return m?.role === 'reference' ? 'reference (cloud)' : m?.class === 'onprem' ? `on-prem tier ${m.tier}` : 'cloud'; };
  const judgeName = (sl: string) => { const j = judges.find((x) => x.judgeSlot === sl); return j ? `judge ${sl} (${displayLabel(j)})` : `judge ${sl}`; };
  const selfEx = readIf<{ selfExcluded: Record<string, { absolute: number; pairwise: number }> }>(path.join(input.runDir, 'judge-selfexclusion.json'))?.selfExcluded ?? {};
  const holdsAll = (r: { holdsUnder: Record<string, boolean | null> }) => { const v = Object.values(r.holdsUnder); return v.some((x) => x === null) ? 'n/a' : v.every(Boolean) ? 'yes' : `no (${JUDGE_SLOTS.filter((sl) => r.holdsUnder[sl] === false).join(', ')})`; };
  const reasoningOf = (k: string) => input.models.find((m) => m.key === k)?.reasoning;
  const stagesRan = input.spend?.byStage ?? {};
  const notRun = input.models.filter((m) => !m.runnable);
  const dry = input.mode === 'stub';
  const bal = buildBalanced({ units: input.units, judgements, models: input.models, scored, cards, label, cls, keys });

  const md: string[] = [];
  md.push(`# LearnSDLC model evaluation: on-premise vs cloud models`, '');
  md.push(`LearnSDLC from SMU SCIS. Run \`${input.runId}\`${dry ? ': **DRY RUN against the loopback stub: every number below is synthetic and says nothing about any model**' : ''}. Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`, '');
  md.push(bal.md, '');
  md.push(`## Quality-only summary (before the latency balance)`, '');
  md.push(table(['Recommendation', 'Model', 'Overall (0-1)', 'Cost / 1,000 interactions', 'Action p95', 'Holds under each judge alone'], recs.map((r) => [r.slot, r.modelKey ? `${label(r.modelKey)} (\`${r.modelKey}\`)` : 'n/a', f2(r.overall), usd(r.costPer1000), sec(r.p95), holdsAll(r)])), '');
  for (const r of recs) md.push(`- **${r.slot}:** ${r.modelKey ? label(r.modelKey) : 'none'}: ${r.note}.`);
  md.push('', `**On-prem caveat.** ${CAVEAT}`, '', ONPREM_NOTE, '');

  md.push(`## Overall ranking`, '', `Weights: ${USE_CASES.map((u) => `${u} ${WEIGHTS[u]}`).join(', ')}. Per use-case combined score = ${FIXED_WEIGHT} × fixed + ${JUDGE_WEIGHT} × judge, where the judge score of each output is the mean of the judges that are not the model under test (three judges for most models, two for the three judge-models; a judge never scores its own outputs), averaged over cases and normalised (score − 1) / 4; a use-case with no judge score uses the fixed score alone. Every on-prem model runs on one GPU: tier 1 = one 24-48 GB GPU, tier 2 = one 80 GB GPU (Llama 4 Scout only at Int4). gpt-oss rows are marked "${REASONING_MINIMUM_NOTE}".`, '');
  md.push(table(['#', 'Model', 'Class', ...USE_CASES, 'Overall', 'Cost / 1,000', 'Licence'], ranking.map((r, i) => [String(i + 1), label(r.k), cls(r.k), ...USE_CASES.map((u) => f2(cards.find((c) => c.modelKey === r.k && c.useCase === u)?.combined ?? null)), f2(r.s), usd(costPer1000(cards, r.k)), input.models.find((m) => m.key === r.k)?.licence ?? ''])), '');
  md.push(`### On-prem results by tier (one GPU)`, '');
  for (const [title, pick] of [['Tier 1: one 24-48 GB GPU', (m: EvalModel) => m.class === 'onprem' && m.tier === 1], ['Tier 2: one 80 GB GPU', (m: EvalModel) => m.class === 'onprem' && m.tier === 2], ['Cloud small models and the reference', (m: EvalModel) => m.class === 'cloud']] as Array<[string, (m: EvalModel) => boolean]>) {
    const rows = ranking.filter((r) => { const m = input.models.find((x) => x.key === r.k); return m ? pick(m) : false; });
    if (!rows.length) continue;
    md.push(`**${title}**`, '', table(['#', 'Model', 'Overall', 'Cost / 1,000', 'Indicative hardware'], rows.map((r, i) => [String(i + 1), label(r.k), f2(r.s), usd(costPer1000(cards, r.k)), input.models.find((m) => m.key === r.k)?.hardware || 'n/a'])), '');
  }

  md.push(`### Sensitivity (each weight ×0.75 and ×1.25, others renormalised)`, '', `Baseline top three: ${sens.baseline.slice(0, 3).map(label).join(', ')}.`, '');
  md.push(table(['Use-case weight', 'Factor', 'Leader', 'Top three', 'Top three unchanged'], sens.rows.map((r) => [r.useCase, `×${r.factor}`, label(r.leader), r.top3.map(label).join(', '), r.sameTop3 ? 'yes' : 'no'])), '');

  for (const u of USE_CASES) {
    const list = cards.filter((c) => c.useCase === u).sort((a, b) => (b.combined ?? -1) - (a.combined ?? -1));
    if (!list.length) continue;
    md.push(`## Use-case: ${u}`, '', `Fixed score = mean of: ${list[0].fixed.fixedComponents.join('; ')}.`, '');
    const selfMark = (c: Scorecard, sl: string) => (input.models.find((m) => m.key === c.modelKey)?.judgeSlot === sl ? 'self (excluded)' : f2(c.judgeBy[sl as 'A']));
    md.push(table(['#', 'Model', 'n', 'Fixed', 'Judge A (1-5)', 'Judge B (1-5)', 'Judge C (1-5)', 'Judges, non-self mean (1-5)', 'Pairwise vs reference (W/T/L)', 'Combined', 'JSON raw / after fence', 'Validator accepts', 'Call p50 / p95', '> 20 s', 'Cost / action'],
      list.map((c, i) => [String(i + 1), label(c.modelKey), String(c.fixed.n), f2(c.fixed.fixedScore), selfMark(c, 'A'), selfMark(c, 'B'), selfMark(c, 'C'), f2(c.judgeMean), c.pairwise ? `${c.pairwise.win}/${c.pairwise.tie}/${c.pairwise.loss}` : 'n/a', f2(c.combined), `${pct(c.fixed.jsonRawValidRate)} / ${pct(c.fixed.jsonAfterFenceRate)}`, pct(c.fixed.validatorAcceptRate), `${sec(c.fixed.callP50)} / ${sec(c.fixed.callP95)}`, pct(c.fixed.over20sShare), usd(c.fixed.meanCostPerAction, 5)])), '');
    const metricKeys = Object.keys(list[0].fixed.metrics);
    md.push(table(['Model', ...metricKeys], list.map((c) => [label(c.modelKey), ...metricKeys.map((k) => { const v = c.fixed.metrics[k]; return v === null || v === undefined ? 'n/a' : Number.isInteger(v) ? String(v) : f2(v); })])), '');
    md.push(table(['Model', 'refusal', 'empty', 'timeout', 'context limit', 'incomplete', 'HTTP error', 'failures'], list.map((c) => [label(c.modelKey), pct(c.fixed.refusalRate), pct(c.fixed.emptyRate), pct(c.fixed.timeoutRate), pct(c.fixed.contextLimitRate), pct(c.fixed.incompleteRate), pct(c.fixed.httpErrorRate), Object.entries(c.fixed.failures).map(([k, v]) => `${k}×${v}`).join(', ') || '—'])), '');
  }

  md.push(`## Cost and operations`, '', `Cost per 1,000 learner interactions uses the measured mean cost per action (repairs and retries included) and the stated mix: ${USE_CASES.map((u) => `${MIX[u]} ${u}`).join(', ')}. Prices are from models.json (Bedrock rows at the AWS Price List on-demand price in the evaluation's region; the reference at its OpenAI price).`, '');
  md.push(table(['Model', 'Class', '$ in / out per 1M', 'Cost / 1,000 interactions', 'Output tokens/s', 'Context', 'Max output'], scored.filter((m) => keys.includes(m.key)).map((m) => [label(m.key), cls(m.key), `${m.priceIn} / ${m.priceOut}`, usd(costPer1000(cards, m.key)), f2(mean2(cards.filter((c) => c.modelKey === m.key).map((c) => c.fixed.outTokensPerSec)), 1), m.contextTokens ? (m.contextTokens >= 1_000_000 ? `${(m.contextTokens / 1_000_000).toFixed(m.contextTokens % 1_000_000 ? 2 : 0)}M` : `${Math.round(m.contextTokens / 1024)}k`) : 'n/a', String(m.maxOutputTokens)])), '');
  md.push('Throughput note: every model ran with one request in flight (the product\'s gate of one), so tokens/s here is single-stream Bedrock-hosted speed, not an on-prem capacity figure.', '');

  md.push(`## Judge reliability`, '');
  md.push(`Three small judges from three families, each also a candidate: ${judges.map((j) => judgeName(j.judgeSlot!)).join(', ')}. A judge never scores or pairwise-compares its own outputs.`, '');
  md.push(table(['Judge', 'Absolute cells self-excluded', 'Pairwise comparisons self-excluded', 'Self-judgements found in the records (ignored)'], judges.map((j) => [judgeName(j.judgeSlot!), String(selfEx[j.key]?.absolute ?? 0), String(selfEx[j.key]?.pairwise ?? 0), String(judgements.filter((x) => isSelfJudgement(x) && x.judge === j.key).length)])), '');
  md.push(`Self-consistency (each judge re-judging a ${pct(input.plan?.judgePlan?.rejudgeFraction ?? 0.1)} stratified sample of its own judgements; Cohen's κ on scores binned 1-2 / 3 / 4-5):`, '');
  md.push(table(['Judge', 'κ', 'Criterion scores', 'Units'], JUDGE_SLOTS.map((sl) => [judgeName(sl), f2(rel.selfConsistency[sl].kappa), String(rel.selfConsistency[sl].pairs), String(rel.selfConsistency[sl].units)])), '');
  md.push(`Inter-judge agreement, pairwise (same output scored by both judges; never an output of either judge):`, '');
  md.push(table(['Judges', 'κ (criteria)', 'Criterion scores', 'Outputs', 'Mean abs. difference', 'Within one point'], Object.entries(rel.interJudge).map(([k, v]) => [k.split('-').map((sl) => `judge ${sl}`).join(' vs '), f2(v.kappa), String(v.pairs), String(v.outputs), f2(v.meanAbsDiff), pct(v.within1)])), '');
  md.push(`- ${rel.flaggedOver1.length} outputs differ by more than one point between some pair of judges and are flagged in scores.csv.`);
  md.push(`- Judge calls that returned no valid judgement: ${rel.judgeFailures}.`);
  const absOf = (key: string) => judgements.filter((j) => j.kind === 'absolute' && j.judge === key);
  const repaired = (j: JudgeRecord) => !!(j.result?.adaptation || j.result?.adaptations?.some(Boolean));
  md.push(`- Judgements that parsed only after the judge-only format tolerance (closing brackets appended; judge/repair.ts; candidates never get it), all kinds: ${Object.entries(rel.judgeAdaptations ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; absolute judgements: ${judges.map((j) => { const a = absOf(j.key); const n = a.filter(repaired).length; return `${judgeName(j.judgeSlot!)} ${n} of ${a.length} (${pct(a.length ? n / a.length : null)})`; }).join(', ')}.`);
  const posRows = judges.map((j) => {
    const pw = judgements.filter((x) => x.kind === 'pairwise' && x.judge === j.key && !x.failure && (x.result as { orders?: Array<{ winner?: string }> } | null)?.orders?.length === 2);
    const same = pw.filter((x) => { const o = (x.result as unknown as { orders: Array<{ winner?: string }> }).orders; return o[0].winner === o[1].winner && (o[0].winner === 'A' || o[0].winner === 'B'); }).length;
    return { j, same, n: pw.length };
  });
  md.push('', `Position consistency in the pairwise comparisons (the same position picked in both orders, whatever the content; such pairs count as ties):`, '');
  md.push(table(['Judge', 'Same position in both orders', 'Valid two-order comparisons', 'Share'], posRows.map((p) => [judgeName(p.j.judgeSlot!), String(p.same), String(p.n), pct(p.n ? p.same / p.n : null)])), '');
  const kOf = (sl: string) => rel.selfConsistency[sl as 'A']?.kappa ?? null;
  const weakest = [...JUDGE_SLOTS].filter((sl) => kOf(sl) !== null).sort((x, y) => kOf(x)! - kOf(y)!)[0];
  if (weakest) {
    const inter = Object.entries(rel.interJudge).filter(([k]) => k.split('-').includes(weakest) && rel.interJudge[k].kappa !== null).sort((x, y) => x[1].kappa! - y[1].kappa!)[0];
    md.push(`- Of the three, ${judgeName(weakest)} gives the least reliable scores: self-consistency κ ${f2(kOf(weakest))}${inter ? `, κ ${f2(inter[1].kappa)} against judge ${inter[0].split('-').find((x) => x !== weakest)}` : ''}; read its per-judge columns with that in mind.`);
  }
  md.push(`- Human spot-check: \`spotcheck.csv\` (up to 20 blind cases, 4 per use-case where the run has them); judge-vs-human agreement appears here once the sheet is ingested (\`run.sh spotcheck --ingest\`).`, '');
  const human = readIf<Record<string, unknown>>(path.join(input.runDir, 'report', 'spotcheck-agreement.json'));
  if (human) md.push(`- Human vs the judges (non-self mean): ${JSON.stringify(human)}`, '');

  md.push(`## Method`, '');
  const counts = USE_CASES.map((u) => `${u} ${input.cases.filter((c) => useCaseOf(c.jobType) === u).length}`).join(', ');
  md.push(`- **Corpus:** ${input.cases.length} cases (${counts}); provenance and label tiers as the corpus documents them. The deterministic half of every review input was derived once with the product's own grader and frozen in corpus-derived/, so every model saw identical bytes; labels whose stated condition the grader did not confirm were downgraded to unlabelled.`);
  md.push(`- **Product paths:** every call went through the product's own provider class: \`OpenAiProvider\` for the reference, and for Bedrock models the harness's \`BedrockProvider\`, the same class with its transport answered by Converse. So every prompt builder, the Guided self-review and repair, the stakeholder review, the Agentic envelope, the strict review parser with its grounding checks, the explanation gate and the output guardrails are the product's code. Drivers replay the services' order of steps (interview.service, assistant.service, agentic.service). Bait turns the product would answer without a model (a solution request, an off-phase question) were still sent to the model and flagged model-only.`);
  md.push(`- **Settings:** one request in flight per model (models in parallel); the reference arm at concurrency 1; temperature ${EVAL_TEMPERATURE} and JSON in text with the schema in a fenced system block; thinking off for every Bedrock model, candidates and judges: each model was sent its documented switch (table below) and every response was asserted to carry no reasoning block, no reasoning-token count and no think text (a response with reasoning would have stopped the run as a harness fault, never been scored); gpt-oss-120b and gpt-oss-20b have no off switch and ran at reasoning_effort low, marked "${REASONING_MINIMUM_NOTE}" (reasoning blocks in this run: ${input.units.reduce((n, u) => n + Number(u.m.reasoningBlocks ?? 0), 0)}, all from those two); max output tokens as the product sets them, clamped to a model's documented maximum where lower; per-call timeout ${Math.round((Number(input.run.settings?.perCallTimeoutMs) || DEFAULT_EVAL_CALL_TIMEOUT_MS) / 1000)} s with latency recorded (the report shows the share over the production 20 s); exponential backoff on throttling (1-32 s) inside the call, recorded apart from latency.`);
  md.push(`- **Executable truth (Agentic proposals):** each proposal was applied to the case's workspace in a scratch copy and graded by the product's own grader (\`FeedbackService.buildReport\`), which ran the pack's visible and hidden pytest/vitest suites through the product's runner (\`apps/api/runner/sandbox_runner.py\`) and the static analyser (\`runner/analyzer.py\`, complexity limit 8), each job a fresh process under macOS \`sandbox-exec\` with all network denied; exec allowed only for the pinned Python, the pinned Node and the runner's baked runtime (no \`open\`, no \`osascript\`, no Apple Events); file contents under the user's home unreadable except the two toolchains, with the credential folders, the evaluation folder and the repository's node_modules denied by name; writes confined to that job's scratch directory; an empty environment; and a 60 s wall clock. A live canary under the same profile proved the fence before any job ran (a file in the home folder and the checkout's .env unreadable, osascript and open refused, a TCP connect refused, Python and Node able to start); had it failed, executable truth would have been marked not run. The runner's in-process defences stayed on as a second line. Docker and local AI models were not used. Where sandbox-exec is unavailable, executable truth is marked not run; model-written code is never run unsandboxed.`);
  md.push(`- **Judges:** three small judges from three families: ${judges.map((j) => judgeName(j.judgeSlot!)).join(', ')}. All three are also candidates, so the harness enforces self-exclusion: a judge never scores or pairwise-compares its own outputs (enforced when the units are built and again before each call); a cell's judge score is the mean of the judges that are not the model under test. Each model's primary judge is the first of A, B, C that is not itself (judge A, or judge B for judge A's own outputs); the others are secondary, which matters only for the budget priority. Rubrics v1 (appendix), 1-5 per criterion with a one-sentence justification, strict JSON through the product's structured() envelope; outputs blind-labelled and shuffled; judges never see model names; pairwise against the reference (${REFERENCE_MODEL_ID}) by every non-self judge in both orders, a win only when both orders agree. Same-family note: judge B shares a family with Qwen3 Coder 30B and judge C with the other Nova models; each judge's score is shown separately and the recommendations say whether they hold under each judge alone.`);
  md.push('', `Reasoning switch per Bedrock model (sent in Converse additionalModelRequestFields; each verified against the model's documentation):`, '');
  md.push(table(['Model', 'Policy', 'Sent', 'Source'], input.models.filter((m) => m.provider === 'bedrock').map((m) => [label(m.key), m.reasoning.policy === 'minimum' ? REASONING_MINIMUM_NOTE : m.reasoning.policy === 'off' ? 'off (switch sent)' : 'no thinking mode', m.reasoning.fields ? `\`${JSON.stringify(m.reasoning.fields)}\`` : 'nothing', m.reasoning.source])), '');
  md.push(`- **Privacy:** no learner email, name or id is in any prompt, output or this report (the learner is "the learner"); every report file passed the privacy scan before it was written. Private-looking strings that models themselves wrote (for example an invented address in a code sample) are counted per output in scores.csv (\`outputPrivacyFlags\`; total ${input.units.reduce((n, u) => n + Number(u.m.outputPrivacyFlags ?? 0), 0)}), kept only in raw/ for audit, and masked in the spot-check sheet.`, '');

  md.push(`## What ran, and what was cut`, '');
  const noJudgement = (stage: string) => { const m = /^judge([ABC])$/.exec(stage); const list = m ? judgements.filter((j) => j.kind === 'absolute' && j.judgeSlot === m[1]) : stage === 'pairwise' || stage === 'rejudge' ? judgements.filter((j) => j.kind === stage) : null; return list ? String(list.filter((j) => j.failure).length) : '—'; };
  md.push(table(['Stage', 'Done', 'Failed', 'No valid judgement', 'Stopped at cap', 'AWS login needed', 'Transient (retry on resume)', 'Cut at run time', 'Cost (US$)'], Object.entries(stagesRan).map(([k, v]: [string, any]) => [k, String(v.done), String(v.failed), noJudgement(k), String(v.stopped), String(v.credentials), String(v.transient ?? 0), String(v.cutAtRuntime ?? 0), f2(v.costUsd, 4)])), '');
  md.push(`"Done" counts judge units the ledger closed; "No valid judgement" counts those whose judge call failed or returned no usable judgement (judge_call_failed or invalid_judgement). Those cells carry no score from that judge: ${judges.map((j) => { const pw = judgements.filter((x) => x.kind === 'pairwise' && x.judge === j.key); return `${judgeName(j.judgeSlot!)} completed ${pw.filter((x) => !x.failure && x.result?.outcome).length} of ${pw.length} pairwise comparisons`; }).join('; ')}.`, '');
  md.push(`Total spend this run: ${usd(input.spend?.spentUsd ?? 0, 4)}${dry ? ' (simulated: the dry run bills nothing)' : ''}. Stop: US$${input.plan?.stopUsd ?? HARD_STOP_USD} across pilot, full run and judges.`, '');
  const cuts = (input.plan?.cuts ?? []) as Array<{ note: string }>;
  md.push(cuts.length ? cuts.map((c) => `- Cut by the plan: ${c.note}`).join('\n') : '- Nothing was cut by the budget plan.', '');
  const runtimeCuts = runtimeCutsOf(input.runDir, input.runId, input.models);
  md.push(runtimeCuts.length
    ? runtimeCuts.map((c) => `- Cut at run time by the live guard (to keep the higher-priority stages funded under the stop): ${c.tier}, ${c.units} unit(s) not judged.`).join('\n')
    : '- Nothing was cut at run time.', '');
  if (notRun.length) md.push(...notRun.map((m) => `- Not run: ${m.label}: ${m.notRunReason}.`), '');
  if (input.droppedModels.length) md.push(`- Dropped from models.json by its slate: ${input.droppedModels.join(', ')}.`, '');

  md.push(`## Licences and indicative on-prem hardware (to be verified)`, '');
  md.push(table(['Model', 'Class', 'Licence', 'Indicative hardware'], input.models.filter((m) => m.role !== 'reference').map((m) => [label(m.key), `${cls(m.key)}${m.judgeSlot ? ` + judge ${m.judgeSlot}` : ''}`, m.licence, m.hardware || 'n/a'])), '');
  md.push(`## Appendix: judge prompts`, '', rubricAppendix());
  const reportMd = `${md.join('\n')}\n`;

  // scores.csv: one row per (model, jobType, case)
  const jByUnit = new Map<string, JudgeRecord[]>();
  for (const j of judgements) jByUnit.set(`${j.modelKey}|${j.caseId}`, [...(jByUnit.get(`${j.modelKey}|${j.caseId}`) ?? []), j]);
  const flagged = new Set(rel.flaggedOver1);
  const metricNames = [...new Set(input.units.flatMap((u) => Object.keys(u.m).filter((k) => k !== 'criteriaPairs')))].sort();
  const esc = (v: unknown) => csvCell(v === null || v === undefined ? '' : String(v));
  const csvHead = ['model', 'class', 'reasoning', 'jobType', 'useCase', 'case', 'labelTier', 'delivered', 'failure', 'shortCircuit', 'modelOnly', 'calls', 'jsonCalls', 'jsonRawValid', 'jsonValidAfterFence', 'actionLatencyMs', 'over20sCalls', 'tokensIn', 'tokensOut', 'costUsd', ...metricNames, 'judgeA_mean', 'judgeB_mean', 'judgeC_mean', 'judges_nonself_mean', 'judgeSelfExcluded', 'pairwise_by_judge', 'judgesDifferOver1', ...BALANCED_CSV_COLUMNS];
  const csv = [csvHead.join(',')];
  for (const u of input.units) {
    const js = jByUnit.get(`${u.modelKey}|${u.caseId}`) ?? [];
    const m = (slot: string) => { const j = js.find((x) => x.kind === 'absolute' && x.judgeSlot === slot && x.result?.scores && !isSelfJudgement(x)); return j ? (Object.values(j.result!.scores!).reduce((s, x) => s + x.score, 0) / Object.keys(j.result!.scores!).length).toFixed(2) : ''; };
    const cell = cellJudgeMean(js, u.modelKey, u.caseId);
    const own = input.models.find((x) => x.key === u.modelKey)?.judgeSlot ?? '';
    const pw = JUDGE_SLOTS.map((sl) => { const p = js.find((x) => x.kind === 'pairwise' && x.judgeSlot === sl && !isSelfJudgement(x)); return p?.result?.outcome ? `${sl}:${p.result.outcome}` : ''; }).filter(Boolean).join(' ');
    csv.push([u.modelKey, cls(u.modelKey), reasoningOf(u.modelKey)?.policy === 'minimum' ? REASONING_MINIMUM_NOTE : reasoningOf(u.modelKey)?.policy ?? '', u.jobType, u.useCase, u.caseId, u.labelTier ?? '', u.delivered, u.failure ?? '', u.shortCircuit ?? '', u.modelOnly, u.calls, u.jsonCalls, u.jsonRawValid, u.jsonValidAfterFence, u.actionLatencyMs, u.over20s, u.tokensIn, u.tokensOut, u.costUsd.toFixed(6), ...metricNames.map((k) => u.m[k]), m('A'), m('B'), m('C'), cell === null ? '' : cell.toFixed(2), own, pw, flagged.has(`${u.modelKey}|${u.caseId}`), 'case', ...BALANCED_CSV_COLUMNS.slice(1).map(() => '')].map(esc).join(','));
  }
  for (const row of bal.rows) {
    csv.push(csvHead.map((h) => (h === 'reasoning' ? (reasoningOf(String(row.model))?.policy === 'minimum' ? REASONING_MINIMUM_NOTE : reasoningOf(String(row.model))?.policy ?? '') : row[h])).map(esc).join(','));
  }
  const scoresCsv = `${csv.join('\n')}\n`;

  const rankings = { runId: input.runId, mode: input.mode, balanced: bal.rankings, weights: WEIGHTS, overall: ranking.map((r) => ({ model: r.k, overall: r.s, costPer1000: costPer1000(cards, r.k) })), perUseCase: Object.fromEntries(USE_CASES.map((u) => [u, cards.filter((c) => c.useCase === u).sort((a, b) => (b.combined ?? -1) - (a.combined ?? -1)).map((c) => ({ model: c.modelKey, fixed: c.fixed.fixedScore, judgeBy: c.judgeBy, judgeNonSelfMean: c.judgeMean, combined: c.combined }))])), recommendations: recs, sensitivity: sens, reliability: rel, judges: judges.map((j) => ({ slot: j.judgeSlot, key: j.key })), selfExcluded: selfEx, tiers: Object.fromEntries(scored.map((m) => [m.key, m.tier])), reasoning: Object.fromEntries(scored.map((m) => [m.key, m.reasoning.policy])) };

  const qualitySummary = [
    `# Model evaluation: one-page summary for the sponsor`, '',
    `LearnSDLC from SMU SCIS. ${dry ? '**DRY RUN: synthetic numbers.** ' : ''}${input.cases.length} test cases across the product's five AI uses (rubric reviews in six phases, the mentor chat, Agentic proposals, explanation checks, stakeholder interviews), ${keys.length} models (on-prem models that each run on one GPU, grouped by tier; small cloud models; the product's current model as the reference), scored by fixed checks and three small judge models from three families that never score their own outputs.`, '',
    ...recs.map((r) => `- **${r.slot}:** ${r.modelKey ? label(r.modelKey) : 'none'}: overall ${f2(r.overall)}, ${usd(r.costPer1000)} per 1,000 learner interactions, action p95 ${sec(r.p95)}; ${r.note}.`), '',
    `**Caveat.** ${CAVEAT}`, '',
    `Grading integrity first: the report shows each model's false-pass count on reviews and false-accept count on explanations before anything else in those sections.`, '',
    `Full method, per use-case scorecards, sensitivity and licences: report.md / report.html.`,
  ].join('\n');

  const summary = `${dry ? '**DRY RUN: synthetic numbers.**\n\n' : ''}${bal.summary}`;
  void qualitySummary;
  return { bal, reportMd, scoresCsv, rankings, summary, cards, ranking, recs, label, cls, rel, judgements };
}

const mean2 = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

/* ----------------------------------- html ---------------------------------- */

/**
 * One CSV cell. Model text and case ids can begin with =, +, -, @, | or %,
 * with or without leading blanks of any kind, or carry a control character,
 * and a spreadsheet would run such a cell as a formula or a DDE command when
 * the sheet is opened. Such a cell is prefixed with an apostrophe and always
 * quoted, so every reader keeps it as text. Quotes, commas and newlines are
 * quoted the usual way.
 */
function csvCell(raw: string): string {
  const risky = /^[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*[=+\-@|%]|[\x00-\x1f\x7f]/.test(raw);
  const s = risky ? `'${raw}` : raw;
  return risky || /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mdToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  const inline = (s: string) => escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i += 1; }
      out.push(`<pre>${escapeHtml(buf.join('\n'))}</pre>`);
      i += 1;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i].slice(1, -1).split('|').map((c) => c.trim())); i += 1; }
      const [head, , ...body] = rows;
      out.push(`<div class="tw"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const h = /^(#{1,4}) (.*)$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i += 1; continue; }
    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) { items.push(`<li>${inline(lines[i].slice(2))}</li>`); i += 1; }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    i += 1;
  }
  return out.join('\n');
}

function barChart(title: string, rows: Array<{ label: string; value: number | null; kind: string }>, max: number, fmt: (v: number) => string): string {
  const w = 640;
  const rowH = 22;
  const labelW = 210;
  const h = rows.length * rowH + 30;
  const bars = rows.map((r, i) => {
    const v = r.value ?? 0;
    const bw = Math.round((max > 0 ? Math.max(1, ((w - labelW - 70) * v) / max) : 1) * 10) / 10;
    const y = 24 + i * rowH;
    return `<text x="${labelW - 8}" y="${y + 14}" text-anchor="end" class="lbl">${escapeHtml(r.label)}</text><rect x="${labelW}" y="${y + 3}" width="${r.value === null ? 0 : bw}" height="${rowH - 8}" class="bar ${r.kind}"/><text x="${labelW + bw + 6}" y="${y + 14}" class="val">${r.value === null ? 'n/a' : escapeHtml(fmt(r.value))}</text>`;
  }).join('');
  return `<figure><figcaption>${escapeHtml(title)}</figcaption><svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${escapeHtml(title)}">${bars}</svg></figure>`;
}

function renderHtml(r: ReturnType<typeof buildReport>, runId: string, dry: boolean): string {
  const kind = (k: string) => (r.cls(k).startsWith('reference') ? 'ref' : r.cls(k).startsWith('on-prem') ? 'onprem' : 'cloud');
  const bc = r.bal.balancedRanking;
  const perUse = USE_CASES.flatMap((u) => {
    const list = r.cards.filter((c) => c.useCase === u).sort((a, b) => (b.combined ?? -1) - (a.combined ?? -1));
    if (!list.length) return [];
    const rowsOf = (v: (c: Scorecard) => number | null) => list.map((c) => ({ label: r.label(c.modelKey), value: v(c), kind: kind(c.modelKey) }));
    const pw = (c: Scorecard) => (c.pairwise ? c.pairwise.win / Math.max(1, c.pairwise.win + c.pairwise.tie + c.pairwise.loss) : null);
    const cpa = (c: Scorecard) => (c.fixed.meanCostPerAction === null ? null : 1000 * c.fixed.meanCostPerAction);
    return [
      `<h2>Use-case: ${u}</h2>`,
      barChart(`${u}: fixed metrics score (0-1)`, rowsOf((c) => c.fixed.fixedScore), 1, (v) => v.toFixed(2)),
      barChart(`${u}: judges, non-self mean (1-5)`, rowsOf((c) => c.judgeMean), 5, (v) => v.toFixed(2)),
      barChart(`${u}: pairwise win rate vs the reference`, rowsOf(pw), 1, (v) => `${(100 * v).toFixed(0)}%`),
      barChart(`${u}: action p95 (s; product target 20 s)`, rowsOf((c) => (c.fixed.actionP95 === null ? null : c.fixed.actionP95 / 1000)), Math.max(20, ...list.map((c) => (c.fixed.actionP95 ?? 0) / 1000)), (v) => `${v.toFixed(1)} s`),
      barChart(`${u}: cost per 1,000 actions (US$)`, rowsOf(cpa), Math.max(0.0001, ...list.map((c) => cpa(c) ?? 0)), (v) => `$${v.toFixed(2)}`),
      barChart(`${u}: balanced score (0-1)`, list.map((c) => ({ label: r.label(c.modelKey), value: r.bal.byUseCase.find((x) => x.modelKey === c.modelKey && x.useCase === u)?.balanced ?? null, kind: kind(c.modelKey) })), 1, (v) => v.toFixed(2)),
    ];
  });
  const charts = [
    barChart(`Overall balanced score (quality ${BALANCE.quality} + latency ${BALANCE.latency})`, bc.map((x) => ({ label: r.label(x.k), value: x.b, kind: kind(x.k) })), 1, (v) => v.toFixed(2)),
    barChart('Overall quality-only score (0-1)', r.ranking.map((x) => ({ label: r.label(x.k), value: x.s, kind: kind(x.k) })), 1, (v) => v.toFixed(2)),
    barChart('Cost per 1,000 learner interactions (US$)', r.ranking.map((x) => ({ label: r.label(x.k), value: costPer1000(r.cards, x.k), kind: kind(x.k) })), Math.max(0.0001, ...r.ranking.map((x) => costPer1000(r.cards, x.k) ?? 0)), (v) => `$${v.toFixed(2)}`),
  ].join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Model Evaluation Report</title>
<style>
:root{--bg:#ffffff;--fg:#1a1a1a;--muted:#5c5c5c;--line:#e3e3e3;--onprem:#2f6f4e;--cloud:#2c5d8f;--ref:#8a5a00;--code:#f4f4f4}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#141414;--fg:#ececec;--muted:#a8a8a8;--line:#333;--onprem:#5fb88a;--cloud:#6ea4dc;--ref:#d9a441;--code:#1f1f1f}}
:root[data-theme="dark"]{--bg:#141414;--fg:#ececec;--muted:#a8a8a8;--line:#333;--onprem:#5fb88a;--cloud:#6ea4dc;--ref:#d9a441;--code:#1f1f1f}
html,body{background:var(--bg);color:var(--fg);margin:0}
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px;max-width:1100px;margin:0 auto}
h1{font-size:24px;margin:0 0 8px}h2{font-size:19px;margin:32px 0 8px;border-top:1px solid var(--line);padding-top:16px}h3{font-size:16px}
.tw{overflow-x:auto;margin:8px 0 16px}table{border-collapse:collapse;font-size:13px;min-width:100%}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:600}
code,pre{background:var(--code);border-radius:3px}pre{padding:10px;overflow-x:auto;white-space:pre-wrap;font-size:12px}code{padding:0 3px}
figure{margin:16px 0}figcaption{font-weight:600;margin-bottom:4px}.lbl,.val{font-size:12px;fill:var(--fg)}.val{fill:var(--muted)}
.bar.onprem{fill:var(--onprem)}.bar.cloud{fill:var(--cloud)}.bar.ref{fill:var(--ref)}
.legend span{display:inline-block;margin-right:16px;font-size:13px}.legend i{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:middle}
.banner{border:1px solid var(--ref);padding:8px 12px;margin:8px 0 16px}
</style></head><body>
${dry ? '<p class="banner"><strong>Dry run against the loopback stub.</strong> Every number is synthetic and says nothing about any model.</p>' : ''}
<p class="legend"><span><i style="background:var(--onprem)"></i>on-prem candidate (one GPU; tier in the label tables)</span><span><i style="background:var(--cloud)"></i>cloud candidate</span><span><i style="background:var(--ref)"></i>reference (${REFERENCE_MODEL_ID})</span></p>
${charts}
${mdToHtml(r.reportMd)}
<h2>Charts per use-case</h2>
${perUse.join('\n')}
<p style="color:var(--muted);font-size:12px">Run ${escapeHtml(runId)}.</p>
</body></html>
`;
}

/* ------------------------------- spot-check -------------------------------- */

function writeSpotcheck(input: ReportInputs, reportDir: string): number {
  const scored = input.models.filter((m) => m.role === 'candidate' || m.role === 'reference');
  const cases = input.cases.filter((c) => judgeable(c) && scored.filter((m) => fs.existsSync(rawPath(input.runDir, m.key, c.jobType, c.id))).length >= 2);
  // 20 cases, stratified over the five use-cases (4 each).
  const picked = stratifiedSample(cases, 1, (c) => useCaseOf(c.jobType), input.salt);
  const byUse = new Map<string, CorpusCase[]>();
  for (const c of seededShuffle(picked, `${input.salt}|spot`)) byUse.set(useCaseOf(c.jobType), [...(byUse.get(useCaseOf(c.jobType)) ?? []), c]);
  const chosen: CorpusCase[] = [];
  for (const u of USE_CASES) chosen.push(...(byUse.get(u) ?? []).slice(0, 4));
  const rows: string[][] = [['sheet_id', 'use_case', 'context', 'output_1', 'output_2', 'output_3', 'score_1 (1-5)', 'score_2 (1-5)', 'score_3 (1-5)', 'notes']];
  const key: Record<string, Record<string, string>> = {};
  chosen.forEach((c, i) => {
    const sheetId = `S${String(i + 1).padStart(2, '0')}`;
    const ref = scored.find((m) => m.role === 'reference');
    const others = seededShuffle(scored.filter((m) => m.role === 'candidate' && fs.existsSync(rawPath(input.runDir, m.key, c.jobType, c.id))), `${input.salt}|${c.id}`).slice(0, ref && fs.existsSync(rawPath(input.runDir, ref.key, c.jobType, c.id)) ? 2 : 3);
    const slots = seededShuffle([...(ref && fs.existsSync(rawPath(input.runDir, ref.key, c.jobType, c.id)) ? [ref] : []), ...others], `${input.salt}|slots|${c.id}`);
    key[sheetId] = { case: c.id };
    const outs = slots.map((m, j) => {
      key[sheetId][`output_${j + 1}`] = m.key;
      const raw = readIf<RawRecord>(rawPath(input.runDir, m.key, c.jobType, c.id));
      const exec = readIf<ExecTruth>(execPath(input.runDir, m.key, c.id));
      // Model text can contain anything; private-looking strings are masked before the sheet is written.
      return raw ? redactForStdout(clip(renderOutput(c, raw as never, exec), 3000)) : '';
    });
    while (outs.length < 3) outs.push('');
    rows.push([sheetId, useCaseOf(c.jobType), redactForStdout(clip(JSON.stringify(judgeContext(c, null)), 3000)), ...outs, '', '', '', '']);
  });
  const esc = csvCell;
  const csv = `${rows.map((r) => r.map(esc).join(',')).join('\n')}\n`;
  assertNoPrivateData(csv, 'spotcheck.csv');
  writeAtomic(path.join(reportDir, 'spotcheck.csv'), csv);
  writeJson(path.join(input.runDir, 'spotcheck-key.json'), { note: 'Label key for the blind spot-check sheet. Keep apart from the sheet.', key });
  return chosen.length;
}

export function ingestSpotcheck(runDir: string, csvFile: string): Record<string, unknown> {
  const text = fs.readFileSync(csvFile, 'utf8');
  const rows = parseCsv(text);
  const head = rows.shift() ?? [];
  const key = readJson<{ key: Record<string, Record<string, string>> }>(path.join(runDir, 'spotcheck-key.json')).key;
  const judgements = loadJudgements(runDir).filter((j) => j.kind === 'absolute' && j.result?.scores && !isSelfJudgement(j));
  const pairs: Array<[number, number]> = [];
  for (const r of rows) {
    const sheet = r[head.indexOf('sheet_id')];
    for (let s = 1; s <= 3; s += 1) {
      const human = Number(r[head.indexOf(`score_${s} (1-5)`)]);
      const model = key[sheet]?.[`output_${s}`];
      if (!model || !Number.isFinite(human) || human < 1 || human > 5) continue;
      // The judges' cell score: the mean of the judges that are not the model under test.
      const mean = cellJudgeMean(judgements, model, key[sheet].case);
      if (mean === null) continue;
      pairs.push([human, mean]);
    }
  }
  const within1 = pairs.length ? pairs.filter(([h, m]) => Math.abs(h - m) <= 1).length / pairs.length : null;
  const mad = pairs.length ? pairs.reduce((s, [h, m]) => s + Math.abs(h - m), 0) / pairs.length : null;
  const out = { pairs: pairs.length, meanAbsDiff: mad, within1 };
  writeJson(path.join(runDir, 'report', 'spotcheck-agreement.json'), out);
  return out;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function writeReport(input: ReportInputs, outDir?: string): { dir: string; files: string[] } {
  const r = buildReport(input);
  const dir = ensureDir(outDir ?? path.join(input.runDir, 'report'));
  const html = renderHtml(r, input.runId, input.mode === 'stub');
  const files: Array<[string, string]> = [
    ['report.md', r.reportMd],
    ['report.html', html],
    ['scores.csv', r.scoresCsv],
    ['rankings.json', `${JSON.stringify(r.rankings, null, 2)}\n`],
    [outDir ? 'SUMMARY.md' : 'summary-for-sponsor.md', `${r.summary}\n`],
    ['judge-prompts.md', `# Judge prompts (fixed, versioned)\n\n${rubricAppendix()}`],
  ];
  for (const [name, body] of files) assertNoPrivateData(body, name);
  for (const [name, body] of files) writeAtomic(path.join(dir, name), body);
  const spot = writeSpotcheck(input, dir);
  return { dir, files: [...files.map(([n]) => n), `spotcheck.csv (${spot} cases)`] };
}

export type { UseCase, Scorecard };

/** Judge units the live guard skipped, by priority tier, not later judged. */
function runtimeCutsOf(runDir: string, runId: string, models: EvalModel[] = []): Array<{ tier: string; units: number }> {
  const judges = judgesOf(models);
  const lines = new Ledger(runDir, runId).all();
  const done = new Set(lines.filter((l) => l.event === 'done').map((l) => l.unit));
  const seen = new Set<string>();
  const by = new Map<string, number>();
  for (const l of lines) {
    if (l.event !== 'cut_at_runtime' || done.has(l.unit) || seen.has(l.unit)) continue;
    seen.add(l.unit);
    const use = useCaseOf(l.jobType as never);
    const [judgeKey, modelKey] = String(l.model).split('>');
    const primary = /^judge[ABC]$/.test(l.stage) && primaryJudgeFor({ key: modelKey }, judges)?.key === judgeKey;
    const tier = /^judge[ABC]$/.test(l.stage) ? (primary ? (use === 'review' || use === 'agentic' ? 'primary judge on reviews/proposals' : 'primary judge on chat/explanation') : `secondary judge (${l.stage})`) : l.stage;
    by.set(tier, (by.get(tier) ?? 0) + 1);
  }
  return [...by.entries()].map(([tier, units]) => ({ tier, units }));
}
