import * as fs from 'fs';
import * as path from 'path';
import type { FeedbackCheck } from '@learnsdlc/shared';
import { soleTaskFor } from '../src/content/pack-compiler';
import { AssistantService } from '../src/assistant/assistant.service';
import { explanationEvidence } from '../src/assistant/explanation-assessment';
import { learnerRecordedEvidence } from '../src/assistant/explanation-evidence';
import { workspaceHash } from '../src/assistant/agentic.service';
import type { CorpusCase } from './contracts';
import { gradeWorkspace, evalState } from './grader';
import { ensureDir, readJson, say, seg, sha256, writeJson } from './io';
import { SeatbeltSandbox, seatbeltPreflight } from './seatbelt-sandbox';
import { phaseFor } from './world';

/**
 * The model-independent half of every case, computed once and frozen under
 * `corpus-derived/<jobType>/<id>.json` under EVAL_ROOT, so every model reads identical
 * bytes:
 *
 * - review-*: the deterministic half of `ReviewInput` (criteria, checks,
 *   overall) from the product's real grader (`FeedbackService.buildReport`),
 *   with every test, mutation and smoke job run by the product's runner under
 *   Seatbelt (see seatbelt-sandbox.ts). Recorded halves are frozen as
 *   recorded. A `reference.condition` is evaluated against the derived checks;
 *   when it does not hold the label is downgraded to unlabelled.
 *   Where Seatbelt is unavailable, or a job could not run, the case is marked
 *   `derive-skipped` and keeps whatever the corpus recorded.
 * - mentor-turn: `signals.todosRemaining` from the product's own scanner.
 * - explanation-assessment: `evidence` from `learnerRecordedEvidence` and
 *   `answerEvidence` from `explanationEvidence`, with a fixed proposal time.
 */

const DERIVED_VERSION = 'eval-derive-v1';
/** The proposal time every explanation case is derived with: any fixed instant, so the derived evidence is byte-identical on every derive. */
const FIXED_PROPOSAL_AT = '2026-10-07T00:00:00.000Z';

export interface DerivedReview {
  version: string;
  caseId: string;
  method: 'recorded' | 'grader+seatbelt' | 'derive-skipped';
  reason: string | null;
  reviewInput: { workspace: Record<string, string>; criteria: unknown; checks: FeedbackCheck[]; overall: number | null; hints: number; ranBeforeSubmit: boolean };
  structural: { overall: number | null; failedChecks: string[] } | null;
  jobs: unknown[];
  recordedChecksAgree: boolean | null;
  condition: { text: string; holds: boolean | null } | null;
  effectiveLabel: { verdict: 'pass' | 'needs_revision' | null; tier: string | null; downgraded: boolean };
  inputSha256: string;
}

const failedIds = (checks: FeedbackCheck[]) => checks.filter((c) => c.status === 'failed').map((c) => c.id);

/**
 * Read a corpus condition against the derived checks. Needs-revision
 * conditions hold when a relevant check failed; pass conditions hold when the
 * relevant checks all passed. `null` means the text named nothing the checks
 * carry, and the label is kept and flagged.
 */
function conditionHolds(text: string, expected: 'pass' | 'needs_revision', checks: FeedbackCheck[]): boolean | null {
  const t = text.toLowerCase();
  const ids = checks.map((c) => c.id);
  const status = (id: string) => checks.find((c) => c.id === id)?.status;
  const pick = (re: RegExp) => ids.filter((id) => re.test(id));
  if (expected === 'pass') {
    const relevant = /tests-on-correct/.test(t)
      ? [...pick(/^tests-on-correct/), ...pick(/^mutation/)]
      : [...pick(/^visible-tests/), ...pick(/^hidden-tests/), ...pick(/^static-analysis/)];
    if (!relevant.length) return null;
    return relevant.every((id) => status(id) === 'passed' || (id.startsWith('static-analysis') && status(id) !== 'failed'));
  }
  const layer = /\bweb\b/.test(t) ? 'web' : /\bapi\b/.test(t) ? 'api' : null;
  const scoped = (list: string[]) => (layer ? list.filter((id) => id.endsWith(`-${layer}`) || id === `hidden-tests-${layer}`) : list);
  let relevant: string[] = [];
  if (/requirements-record-consistency/.test(t)) relevant = pick(/^requirements-record-consistency$/);
  else if (/mutation|mutant/.test(t) && /enough-tests/.test(t)) relevant = [...pick(/^mutation/), ...pick(/^enough-tests/)];
  else if (/tests-on-correct/.test(t)) relevant = [...pick(/^tests-on-correct/), ...pick(/^mutation/)];
  else if (/enough-tests/.test(t)) relevant = pick(/^enough-tests/);
  else if (/mutation|mutant/.test(t)) relevant = pick(/^mutation/);
  else if (/hidden/.test(t) && !/visible/.test(t)) relevant = scoped(pick(/^hidden-tests/));
  else relevant = [...pick(/^visible-tests/), ...pick(/^hidden-tests/)];
  if (!relevant.length) return null;
  // A mutation check with survivors reads `warning` (some killed) or `failed` (none killed): both report surviving mutants.
  return relevant.some((id) => status(id) === 'failed' || (id.startsWith('mutation') && status(id) === 'warning'));
}

async function deriveReview(c: CorpusCase, sandbox: SeatbeltSandbox | null): Promise<DerivedReview> {
  const ri = c.input.reviewInput;
  const expected = (c.reference.expected?.verdict ?? null) as 'pass' | 'needs_revision' | null;
  const base = { version: DERIVED_VERSION, caseId: c.id };
  const recordedFull = ri.criteria !== null && ri.checks !== null && ri.overall !== null;
  if (recordedFull) {
    const reviewInput = { workspace: ri.workspace, criteria: ri.criteria, checks: ri.checks, overall: ri.overall, hints: ri.hints ?? 0, ranBeforeSubmit: Boolean(ri.ranBeforeSubmit) };
    return { ...base, method: 'recorded', reason: null, reviewInput, structural: null, jobs: [], recordedChecksAgree: null, condition: null,
      effectiveLabel: { verdict: expected, tier: c.reference.tier ?? null, downgraded: false }, inputSha256: sha256(JSON.stringify(reviewInput)) };
  }
  const { phase, world } = await phaseFor(c);
  if (!world) throw new Error(`${c.id}: a review case needs a pack`);
  const task = soleTaskFor(phase);
  // Without the sandbox only a Markdown phase is graded here. The cast: a recorded case's
  // synthetic phase may carry a check kind the product's type does not list.
  if (!sandbox && (phase.checks.kind as string) !== 'markdown') {
    const reviewInput = { workspace: ri.workspace, criteria: ri.criteria, checks: ri.checks ?? [], overall: ri.overall, hints: ri.hints ?? 0, ranBeforeSubmit: Boolean(ri.ranBeforeSubmit) };
    return { ...base, method: 'derive-skipped', reason: 'sandbox-exec unavailable or its preflight canary failed: the runner was not started', reviewInput, structural: null, jobs: [], recordedChecksAgree: null,
      condition: c.reference.condition ? { text: c.reference.condition, holds: null } : null,
      effectiveLabel: { verdict: expected, tier: c.reference.tier ?? null, downgraded: false }, inputSha256: sha256(JSON.stringify(reviewInput)) };
  }
  const jobsBefore = sandbox?.jobs.length ?? 0;
  const { report, reviewInput: captured } = await gradeWorkspace(world.content, world.slug, phase, task, [task], ri.workspace, Boolean(ri.ranBeforeSubmit), sandbox as SeatbeltSandbox);
  const jobs = sandbox ? sandbox.jobs.slice(jobsBefore) : [];
  const unavailable = jobs.filter((j) => j.exitKind === 'unavailable');
  const checks = (captured?.checks ?? report.checks) as FeedbackCheck[];
  const reviewInput = {
    workspace: ri.workspace,
    criteria: captured?.criteria ?? report.criteria,
    checks,
    overall: captured?.overall ?? report.overall,
    hints: ri.hints ?? 0,
    ranBeforeSubmit: Boolean(ri.ranBeforeSubmit),
  };
  let recordedChecksAgree: boolean | null = null;
  if (Array.isArray(ri.checks)) {
    const rec = new Map((ri.checks as FeedbackCheck[]).map((x) => [x.id, x.status]));
    recordedChecksAgree = [...rec].every(([id, st]) => checks.find((x) => x.id === id)?.status === st);
  }
  let condition: DerivedReview['condition'] = null;
  let verdict = expected;
  let tier = c.reference.tier ?? null;
  let downgraded = false;
  if (c.reference.condition && expected) {
    const holds = unavailable.length ? null : conditionHolds(c.reference.condition, expected, checks);
    condition = { text: c.reference.condition, holds };
    if (holds === false) { verdict = null; tier = 'unlabelled'; downgraded = true; }
  }
  return {
    ...base,
    method: unavailable.length ? 'derive-skipped' : 'grader+seatbelt',
    reason: unavailable.length ? `${unavailable.length} runner job(s) could not run under Seatbelt; their checks read as the product reads an unavailable runner` : null,
    reviewInput,
    structural: { overall: report.overall, failedChecks: failedIds(checks) },
    jobs,
    recordedChecksAgree,
    condition,
    effectiveLabel: { verdict, tier, downgraded },
    inputSha256: sha256(JSON.stringify(reviewInput)),
  };
}

/** The scanner the mentor's signals come from, borrowed from the product (it reads only content and a memo). */
export function todosRemaining(world: { content: unknown }, phase: unknown, workspace: Record<string, string>): string[] {
  const scan = (AssistantService.prototype as unknown as { todosRemainingFor: (state: unknown, phase: unknown) => string[] }).todosRemainingFor;
  return scan.call({ content: world.content, todoMemo: new Map(), scans: 0 }, { workspace }, phase);
}

async function deriveMentor(c: CorpusCase) {
  if (!c.input.mentorContext) return { version: DERIVED_VERSION, caseId: c.id, todosRemaining: null };
  const { phase, world } = await phaseFor(c);
  const todos = world && !c.input.lesson ? todosRemaining(world, phase, c.input.mentorContext.workspace ?? {}) : [];
  return { version: DERIVED_VERSION, caseId: c.id, todosRemaining: todos };
}

function deriveExplanation(c: CorpusCase) {
  const data = c.input.data;
  const ref = data.reference;
  const evidence = learnerRecordedEvidence({ drill: null, runs: [], latestEdit: ref.latestEdit ?? null, proposedFiles: ref.proposedFiles, proposalAt: FIXED_PROPOSAL_AT });
  const recordedRuns = Array.isArray(data.evidence?.recordedRuns) && data.evidence.recordedRuns.length ? data.evidence.recordedRuns : evidence.recordedRuns;
  const frozen = {
    reference: { originalRequest: ref.originalRequest, before: ref.before, proposedFiles: ref.proposedFiles, proposalHash: workspaceHash(ref.proposedFiles), latestEdit: ref.latestEdit ?? null },
    evidence: { ...evidence, recordedRuns },
    learnerAnswer: data.learnerAnswer,
    answerEvidence: explanationEvidence(data.learnerAnswer),
  };
  return { version: DERIVED_VERSION, caseId: c.id, proposalHashMatchesCorpus: frozen.reference.proposalHash === ref.proposalHash, data: frozen };
}

export function derivedPath(root: string, c: CorpusCase): string {
  return path.join(root, 'corpus-derived', c.jobType, `${seg(c.id)}.json`);
}

export function readDerived<T>(root: string, c: CorpusCase): T | null {
  const file = derivedPath(root, c);
  return fs.existsSync(file) ? readJson<T>(file) : null;
}

/**
 * The cases a derive would write, and the frozen files it refuses to touch.
 * corpus-derived/ is frozen: every raw record carries the sha256 of the file
 * it read, so an existing file is never overwritten without --force.
 */
export function derivePlan(root: string, cases: CorpusCase[], options: { only?: string[]; force?: boolean } = {}): { todo: CorpusCase[]; frozen: number } {
  const relevant = cases.filter((c) => (!options.only || options.only.includes(c.id))
    && (c.jobType.startsWith('review-') || c.jobType === 'mentor-turn' || c.jobType === 'explanation-assessment'));
  const exists = (c: CorpusCase) => fs.existsSync(derivedPath(root, c));
  return { todo: options.force ? relevant : relevant.filter((c) => !exists(c)), frozen: options.force ? 0 : relevant.filter(exists).length };
}

export async function deriveAll(root: string, cases: CorpusCase[], scratch: string, options: { only?: string[]; force?: boolean } = {}) {
  ensureDir(path.join(root, 'corpus-derived'));
  const { todo, frozen } = derivePlan(root, cases, options);
  if (frozen) say(`derive: refusing to overwrite ${frozen} frozen file(s) in corpus-derived/ (recorded runs read them); pass --force to recompute`);
  if (!todo.length) return { review: { recorded: 0, derived: 0, skipped: 0, downgraded: 0, conditionUnknown: 0 }, mentor: 0, explanation: 0, frozen };
  // The fence is proved live before any pack code runs; a failed canary means no runner job at all.
  const preflight = await seatbeltPreflight(ensureDir(path.join(scratch, 'derive-jobs')));
  if (!preflight.ok) say(`derive: Seatbelt preflight failed (${preflight.failures.join(', ')}); code reviews are derive-skipped`);
  const sandbox = preflight.ok ? new SeatbeltSandbox(ensureDir(path.join(scratch, 'derive-jobs'))) : null;
  const summary = { review: { recorded: 0, derived: 0, skipped: 0, downgraded: 0, conditionUnknown: 0 }, mentor: 0, explanation: 0, frozen };
  for (const c of todo) {
    const out = derivedPath(root, c);
    if (c.jobType.startsWith('review-')) {
      const d = await deriveReview(c, sandbox);
      writeJson(out, d);
      if (d.method === 'recorded') summary.review.recorded += 1;
      else if (d.method === 'derive-skipped') summary.review.skipped += 1;
      else summary.review.derived += 1;
      if (d.effectiveLabel.downgraded) summary.review.downgraded += 1;
      if (d.condition && d.condition.holds === null) summary.review.conditionUnknown += 1;
      say(`derive ${c.jobType} ${c.id}: ${d.method}${d.effectiveLabel.downgraded ? ' (label downgraded)' : ''}`);
    } else if (c.jobType === 'mentor-turn') {
      writeJson(out, await deriveMentor(c));
      summary.mentor += 1;
    } else if (c.jobType === 'explanation-assessment') {
      writeJson(out, deriveExplanation(c));
      summary.explanation += 1;
    }
  }
  return summary;
}

export { evalState };
