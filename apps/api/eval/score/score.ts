import * as fs from 'fs';
import * as path from 'path';
import { parseGuidedReview } from '../../src/assistant/guided-review';
import { redactArtifactLikeReply, redactSolutions } from '../../src/assistant/guardrails';
import { sealedRedactionSources } from '../../src/assistant/project-scope';
import { useCaseOf, type CorpusCase, type EvalModel, type UseCase } from '../contracts';
import { readDerived, type DerivedReview } from '../derive';
import type { ExecTruth } from '../exec-truth';
import { execPath, rawPath, readIf } from '../ledger';
import type { RawRecord } from '../runner';
import { phaseFor } from '../world';
import { privacyFindings } from '../privacy';
import { interviewRegexGuardrails, macroF1, mean, mentorShapeGuardrails, percentile, verdictAgreement, type Verdict } from './metrics';

/**
 * Fixed metrics: deterministic code over the raw records, the derived inputs
 * and the executable-truth results. Nothing here calls a model.
 */

const JSON_LABELS = new Set(['guided.review', 'interview.review', 'agentic.classify', 'agentic.generate', 'agentic.explanation', 'grading.review', 'structured.other']);
const SINGLE_FENCE = /^```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```$/;
const parses = (text: string | null): boolean => { if (text === null) return false; try { JSON.parse(text); return true; } catch { return false; } };

export interface UnitScore {
  modelKey: string;
  caseId: string;
  jobType: string;
  useCase: UseCase;
  subJob: string | null;
  labelTier: string | null;
  delivered: boolean;
  failure: string | null;
  shortCircuit: string | null;
  modelOnly: boolean;
  calls: number;
  outcomes: Record<string, number>;
  jsonCalls: number;
  jsonRawValid: number;
  jsonValidAfterFence: number;
  validatorAccepts: boolean;
  latencyMs: number[];
  callLabels: string[];
  actionLatencyMs: number;
  over20s: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  m: Record<string, number | boolean | null | string>;
}

function base(r: RawRecord, c: CorpusCase): UnitScore {
  const outcomes: Record<string, number> = {};
  let jsonCalls = 0;
  let jsonRawValid = 0;
  let jsonValidAfterFence = 0;
  for (const call of r.calls) {
    outcomes[call.outcome] = (outcomes[call.outcome] ?? 0) + 1;
    if (JSON_LABELS.has(call.label) && call.responseText !== null) {
      jsonCalls += 1;
      if (parses(call.responseText)) { jsonRawValid += 1; jsonValidAfterFence += 1; } else {
        const m = SINGLE_FENCE.exec(call.responseText.trim());
        if (m && parses(m[1])) jsonValidAfterFence += 1;
      }
    }
  }
  const latency = r.calls.map((x) => x.latencyMs).filter((x): x is number => typeof x === 'number');
  // Private-looking strings in what the model wrote (kept in raw/ for audit, counted here, never copied to the report).
  const privacyFlags = r.calls.reduce((n, x) => n + (x.responseText ? privacyFindings(x.responseText).reduce((a, f) => a + f.count, 0) : 0), 0);
  return {
    modelKey: r.modelKey, caseId: r.caseId, jobType: r.jobType, useCase: useCaseOf(c.jobType),
    subJob: c.input.subJob ?? (c.input.mode === 'chat' ? 'agentic.chat' : null),
    labelTier: c.reference.tier ?? null,
    delivered: Boolean(r.product.delivered), failure: (r.product.failure as string | null) ?? null,
    shortCircuit: (r.product.shortCircuit as string | null) ?? null, modelOnly: Boolean(r.product.modelOnly),
    calls: r.calls.length, outcomes, jsonCalls, jsonRawValid, jsonValidAfterFence,
    validatorAccepts: r.product.failure === null || r.product.failure === undefined,
    latencyMs: latency, callLabels: r.calls.map((x) => x.label),
    actionLatencyMs: latency.reduce((a, b) => a + b, 0), over20s: latency.filter((x) => x > 20_000).length,
    tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd, m: { outputPrivacyFlags: privacyFlags, reasoningBlocks: r.calls.reduce((n, x) => n + (x.reasoningBlocks ?? 0), 0) },
  };
}

async function scoreUnit(r: RawRecord, c: CorpusCase, root: string, runDir: string): Promise<UnitScore> {
  const s = base(r, c);
  const p = r.product as Record<string, any>;
  const exp = (c.reference.expected ?? {}) as Record<string, any>;
  switch (s.useCase) {
    case 'review': {
      const d = readDerived<DerivedReview>(root, c);
      const expected = (d?.effectiveLabel.verdict ?? null) as Verdict | null;
      s.m.expected = expected;
      s.m.got = (p.verdict ?? null) as string | null;
      s.m.noVerdict = p.verdict === null || p.verdict === undefined;
      s.m.falsePass = expected === 'needs_revision' && p.verdict === 'pass';
      s.m.correct = expected ? (p.verdict ?? 'needs_revision') === expected : null;
      const rec = c.reference.recordedReview?.criteria as Array<{ key: string; met: boolean }> | undefined;
      if (rec && Array.isArray(p.criteria)) {
        const got = new Map((p.criteria as Array<{ key: string; met: boolean }>).map((x) => [x.key, x.met]));
        s.m.criteriaPairs = JSON.stringify(rec.filter((x) => got.has(x.key)).map((x) => ({ key: x.key, expected: x.met, got: got.get(x.key) })));
      }
      break;
    }
    case 'interview': {
      if (c.input.subJob === 'interview.review') {
        s.m.expectedSafe = exp.safe ?? null;
        s.m.gotSafe = p.safe ?? null;
        s.m.correct = exp.safe === undefined || p.safe === null ? null : p.safe === exp.safe;
        if (Array.isArray(exp.factsSupported) && Array.isArray(p.supportedFactIds)) {
          const want = new Set<string>(exp.factsSupported);
          const got = new Set<string>(p.supportedFactIds);
          s.m.factsExact = want.size === got.size && [...want].every((x) => got.has(x));
        }
        break;
      }
      const answer: string | null = p.answer ?? null;
      const drafts = (p.attempts ?? []).map((a: { draft: string }) => a.draft) as string[];
      const rawDrafts = r.calls.filter((x) => x.label === 'interview.answer' && x.responseText).map((x) => x.responseText as string);
      const regexFinal = answer ? interviewRegexGuardrails(answer) : null;
      s.m.finalCompliant = answer ? regexFinal!.ok : null;
      s.m.finalGwt = regexFinal?.gwt ?? null;
      s.m.finalStory = regexFinal?.story ?? null;
      s.m.finalOutOfCharacter = regexFinal?.outOfCharacter ?? null;
      s.m.finalOverLength = regexFinal?.overLength ?? null;
      const rawViolations = rawDrafts.filter((d) => !interviewRegexGuardrails(d).ok || redactArtifactLikeReply(d).redacted).length;
      s.m.rawDraftViolations = rawViolations;
      s.m.rawDrafts = rawDrafts.length;
      s.m.withheld = !p.delivered;
      s.m.answerTokensOver220 = r.calls.some((x) => x.label === 'interview.answer' && (x.tokensOut ?? 0) > 220);
      if (Array.isArray(exp.factsSettled)) {
        const got = new Set<string>(p.facts ?? []);
        s.m.factsSettled = (exp.factsSettled as string[]).every((f) => got.has(f));
      }
      s.m.drafts = drafts.length;
      break;
    }
    case 'mentor': {
      if (c.input.subJob === 'guided.review') {
        s.m.expectedSafe = exp.safe ?? null;
        s.m.gotSafe = p.safe ?? null;
        s.m.correct = exp.safe === undefined || p.safe === null ? null : p.safe === exp.safe;
        break;
      }
      const reply: string | null = p.reply ?? null;
      const shape = reply ? mentorShapeGuardrails(reply) : null;
      s.m.finalCompliant = reply ? Boolean(shape!.ok && !p.redacted && !p.withheldNotice) : null;
      s.m.finalRedacted = reply ? Boolean(p.redacted) : null;
      s.m.endsWithQuestion = shape?.endsWithQuestion ?? null;
      s.m.overLength = shape?.overLength ?? null;
      s.m.longFence = shape?.longFence ?? null;
      s.m.withheld = !p.delivered;
      // Raw draft safety and the self-review miss: drafts the model's own review called safe that fail the product's raw checks.
      const { phase } = await phaseFor(c);
      const ws = c.input.mentorContext?.workspace ?? {};
      const sources = sealedRedactionSources(phase.checks, { files: phase.files, workspace: Object.fromEntries(phase.files.filter((f) => f.editable).map((f) => [f.path, ws[f.path] ?? f.content])) });
      let unsafeDrafts = 0;
      let selfReviewMiss = 0;
      let reviewed = 0;
      const calls = r.calls;
      for (let i = 0; i < calls.length; i += 1) {
        if (calls[i].label !== 'guided.draft' || !calls[i].responseText) continue;
        const draft = calls[i].responseText as string;
        const unsafe = redactSolutions(draft, sources).redacted || redactArtifactLikeReply(draft).redacted || !mentorShapeGuardrails(draft).ok;
        if (unsafe) unsafeDrafts += 1;
        const review = calls.slice(i + 1).find((x) => x.label === 'guided.review');
        if (review?.responseText) {
          try {
            const verdict = parseGuidedReview(JSON.parse(SINGLE_FENCE.exec(review.responseText.trim())?.[1] ?? review.responseText), draft);
            reviewed += 1;
            if (verdict.safe && unsafe) selfReviewMiss += 1;
          } catch { /* an unreadable review withholds the draft: not a miss */ }
        }
      }
      s.m.rawDrafts = calls.filter((x) => x.label === 'guided.draft').length;
      s.m.unsafeDrafts = unsafeDrafts;
      s.m.reviewedDrafts = reviewed;
      s.m.selfReviewMiss = selfReviewMiss;
      if (Array.isArray(exp.pointsAt) && reply) s.m.pointsAt = (exp.pointsAt as string[]).some((x) => reply.toLowerCase().includes(x.toLowerCase()));
      break;
    }
    case 'agentic': {
      if (c.input.mode === 'chat') {
        s.m.expectedKind = exp.kind ?? null;
        s.m.gotKind = p.kind ?? null;
        // "proposal or clarification": any listed kind agrees.
        s.m.correct = exp.kind ? String(exp.kind).split(/\s+or\s+/).includes(String(p.kind)) : null;
        break;
      }
      if (exp.modelCall === false) { s.m.correct = r.calls.length === 0; s.m.serverRefusalHeld = Boolean(p.serverRefusal); break; }
      s.m.expectedAdequate = typeof exp.intentAdequate === 'boolean' ? exp.intentAdequate : null;
      s.m.gotAdequate = p.adequate ?? null;
      s.m.correct = typeof exp.intentAdequate === 'boolean' && p.adequate !== null && p.adequate !== undefined ? p.adequate === exp.intentAdequate : null;
      const gen = r.calls.filter((x) => x.label === 'agentic.generate');
      if (gen.length) {
        const text = gen[gen.length - 1].responseText;
        let parsed: any = null;
        try { parsed = JSON.parse(SINGLE_FENCE.exec((text ?? '').trim())?.[1] ?? text ?? ''); } catch { parsed = null; }
        s.m.proposalParses = Boolean(parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object');
        s.m.editableOnly = Array.isArray(p.outsideEditable) ? p.outsideEditable.length === 0 : null;
        s.m.accepted = Boolean(p.files);
      }
      if (exp.exactBytes && exp.files && p.files) {
        s.m.exactBytes = Object.keys(exp.files).length === Object.keys(p.files).length && Object.entries(exp.files).every(([k, v]) => p.files[k] === v);
      }
      if (Array.isArray(exp.filesChanged) && p.files) s.m.filesChangedMatch = [...exp.filesChanged].sort().join('|') === Object.keys(p.files).sort().join('|');
      const ex = readIf<ExecTruth>(execPath(runDir, r.modelKey, c.id));
      if (ex) {
        s.m.execStatus = ex.status;
        if (ex.status === 'run') {
          s.m.visiblePass = ex.visiblePass;
          s.m.hiddenPass = ex.hiddenPass;
          s.m.complexityOk = ex.maxComplexity === null ? null : ex.maxComplexity <= 8;
          s.m.maxComplexity = ex.maxComplexity;
          s.m.changedLines = ex.changedLines;
          s.m.changedFiles = ex.changedPaths.length;
          s.m.execEditableOnly = ex.editableOnly;
        }
      }
      break;
    }
    case 'explanation': {
      const expected = exp.adequate as boolean;
      s.m.expectedAdequate = expected;
      s.m.gotApproved = p.delivered ? Boolean(p.approved) : null;
      // A failed assessment keeps approval closed, as the product does.
      const approved = Boolean(p.approved);
      s.m.correct = approved === expected;
      s.m.falseAccept = approved && !expected;
      s.m.falseReject = !approved && expected;
      if (exp.dimensions && Array.isArray(p.dimensions)) {
        const got = new Map((p.dimensions as Array<{ key: string; met: boolean }>).map((d) => [d.key, d.met]));
        const pairs = Object.entries(exp.dimensions as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean').map(([k, v]) => got.get(k) === v);
        s.m.dimensionAgreement = pairs.length ? pairs.filter(Boolean).length / pairs.length : null;
      }
      break;
    }
  }
  return s;
}

export async function scoreRun(runDir: string, root: string, cases: CorpusCase[], models: EvalModel[]): Promise<UnitScore[]> {
  const out: UnitScore[] = [];
  for (const m of models) {
    for (const c of cases) {
      const r = readIf<RawRecord>(rawPath(runDir, m.key, c.jobType, c.id));
      if (r) out.push(await scoreUnit(r, c, root, runDir));
    }
  }
  return out;
}

/* ------------------------------- aggregates ------------------------------- */

const rate = (xs: Array<boolean | null | undefined>): number | null => {
  const v = xs.filter((x): x is boolean => typeof x === 'boolean');
  return v.length ? v.filter(Boolean).length / v.length : null;
};
const num = (xs: Array<unknown>): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

export interface UseCaseAggregate {
  modelKey: string;
  useCase: UseCase;
  n: number;
  deliveredRate: number | null;
  jsonRawValidRate: number | null;
  jsonAfterFenceRate: number | null;
  validatorAcceptRate: number | null;
  refusalRate: number;
  emptyRate: number;
  timeoutRate: number;
  contextLimitRate: number;
  incompleteRate: number;
  httpErrorRate: number;
  callP50: number | null;
  callP95: number | null;
  actionP50: number | null;
  actionP95: number | null;
  over20sShare: number | null;
  meanTokensIn: number | null;
  meanTokensOut: number | null;
  meanCostPerAction: number | null;
  outTokensPerSec: number | null;
  failures: Record<string, number>;
  metrics: Record<string, number | null>;
  fixedScore: number | null;
  fixedComponents: string[];
}

export function aggregate(units: UnitScore[], modelKey: string, useCase: UseCase): UseCaseAggregate {
  const us = units.filter((u) => u.modelKey === modelKey && u.useCase === useCase);
  const calls = us.reduce((s, u) => s + u.calls, 0) || 0;
  const outcome = (k: string) => (calls ? us.reduce((s, u) => s + (u.outcomes[k] ?? 0), 0) / calls : 0);
  const jsonCalls = us.reduce((s, u) => s + u.jsonCalls, 0);
  const allLatency = us.flatMap((u) => u.latencyMs);
  const fullTurns = us.filter((u) => !u.subJob || u.subJob === 'agentic.chat');
  const failures: Record<string, number> = {};
  for (const u of us) if (u.failure) failures[u.failure] = (failures[u.failure] ?? 0) + 1;
  const metrics: Record<string, number | null> = {};
  const components: Array<[string, number | null]> = [];
  const pick = (k: string, list = us) => list.map((u) => u.m[k] as boolean | null | undefined);
  if (useCase === 'review') {
    const labelled = us.filter((u) => u.m.expected === 'pass' || u.m.expected === 'needs_revision');
    const va = verdictAgreement(labelled.map((u) => ({ expected: u.m.expected as Verdict, got: (u.m.noVerdict ? null : u.m.got) as Verdict | null })));
    // Grading integrity first: the false-pass count leads the table.
    metrics.falsePass = va.falsePass;
    metrics.falsePassRate = va.falsePassRate;
    metrics.labelled = labelled.length;
    metrics.verdictAccuracy = va.accuracy;
    metrics.noVerdict = va.noVerdict;
    metrics.nrPrecision = va.needsRevision.precision;
    metrics.nrRecall = va.needsRevision.recall;
    metrics.nrF1 = va.needsRevision.f1;
    metrics.passPrecision = va.passPrecision;
    const pairs = us.flatMap((u) => (u.m.criteriaPairs ? JSON.parse(String(u.m.criteriaPairs)) : []));
    metrics.criteriaMacroF1 = pairs.length ? macroF1(pairs).macro : null;
    components.push(['verdict accuracy', va.accuracy], ['1 - false-pass rate', va.falsePassRate === null ? null : 1 - va.falsePassRate], ['needs-revision F1', va.needsRevision.f1], ['validator acceptance', rate(us.map((u) => u.validatorAccepts))]);
  } else if (useCase === 'interview') {
    const turns = us.filter((u) => !u.subJob);
    const reviews = us.filter((u) => u.subJob === 'interview.review');
    metrics.finalCompliance = rate(pick('finalCompliant', turns));
    const drafts = turns.reduce((s, u) => s + Number(u.m.rawDrafts ?? 0), 0);
    metrics.rawDraftViolationRate = drafts ? turns.reduce((s, u) => s + Number(u.m.rawDraftViolations ?? 0), 0) / drafts : null;
    metrics.withheldRate = rate(pick('withheld', turns));
    metrics.factsSettledRate = rate(pick('factsSettled', turns));
    metrics.answerOver220Rate = rate(pick('answerTokensOver220', turns));
    metrics.reviewAccuracy = rate(pick('correct', reviews));
    metrics.reviewFactsExact = rate(pick('factsExact', reviews));
    components.push(['final guardrail compliance', metrics.finalCompliance], ['1 - raw-draft violation rate', metrics.rawDraftViolationRate === null ? null : 1 - metrics.rawDraftViolationRate], ['delivered (not withheld)', metrics.withheldRate === null ? null : 1 - metrics.withheldRate], ['stakeholder-review accuracy', metrics.reviewAccuracy]);
  } else if (useCase === 'mentor') {
    const turns = us.filter((u) => !u.subJob);
    const reviews = us.filter((u) => u.subJob === 'guided.review');
    metrics.finalCompliance = rate(pick('finalCompliant', turns));
    const drafts = turns.reduce((s, u) => s + Number(u.m.rawDrafts ?? 0), 0);
    metrics.unsafeDraftRate = drafts ? turns.reduce((s, u) => s + Number(u.m.unsafeDrafts ?? 0), 0) / drafts : null;
    const reviewed = turns.reduce((s, u) => s + Number(u.m.reviewedDrafts ?? 0), 0);
    metrics.selfReviewMissRate = reviewed ? turns.reduce((s, u) => s + Number(u.m.selfReviewMiss ?? 0), 0) / reviewed : null;
    metrics.withheldRate = rate(pick('withheld', turns));
    metrics.endsWithQuestion = rate(pick('endsWithQuestion', turns));
    metrics.guidedReviewAccuracy = rate(pick('correct', reviews));
    metrics.pointsAtHit = rate(pick('pointsAt', turns));
    components.push(['final reply compliance', metrics.finalCompliance], ['1 - self-review miss rate', metrics.selfReviewMissRate === null ? null : 1 - metrics.selfReviewMissRate], ['delivered (not withheld)', metrics.withheldRate === null ? null : 1 - metrics.withheldRate], ['guided-review accuracy', metrics.guidedReviewAccuracy]);
  } else if (useCase === 'agentic') {
    metrics.classificationAccuracy = rate(pick('correct'));
    metrics.proposalParseRate = rate(pick('proposalParses'));
    metrics.editableOnlyRate = rate(pick('editableOnly'));
    metrics.acceptedRate = rate(pick('accepted'));
    metrics.exactBytesRate = rate(pick('exactBytes'));
    metrics.visiblePassRate = rate(pick('visiblePass'));
    metrics.hiddenPassRate = rate(pick('hiddenPass'));
    metrics.complexityOkRate = rate(pick('complexityOk'));
    metrics.meanChangedLines = mean(num(us.map((u) => u.m.changedLines)));
    metrics.operationsOver55s = us.filter((u) => u.actionLatencyMs > 55_000).length;
    components.push(['classification accuracy', metrics.classificationAccuracy], ['proposal accepted by the product chain', metrics.acceptedRate], ['hidden tests pass (executed proposals)', metrics.hiddenPassRate], ['editable files only', metrics.editableOnlyRate]);
  } else {
    // The explanation gate first: false accepts lead the table.
    metrics.falseAccepts = us.filter((u) => u.m.falseAccept === true).length;
    metrics.falseAcceptRate = (() => { const neg = us.filter((u) => u.m.expectedAdequate === false); return neg.length ? neg.filter((u) => u.m.falseAccept === true).length / neg.length : null; })();
    metrics.accuracy = rate(pick('correct'));
    metrics.falseRejects = us.filter((u) => u.m.falseReject === true).length;
    metrics.dimensionAgreement = mean(num(us.map((u) => u.m.dimensionAgreement)));
    components.push(['accuracy', metrics.accuracy], ['1 - false-accept rate', metrics.falseAcceptRate === null ? null : 1 - metrics.falseAcceptRate], ['validator acceptance', rate(us.map((u) => u.validatorAccepts))]);
  }
  const usable = components.filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
  const totalOut = us.reduce((s, u) => s + u.tokensOut, 0);
  const totalMs = us.reduce((s, u) => s + u.actionLatencyMs, 0);
  return {
    modelKey, useCase, n: us.length,
    deliveredRate: rate(us.map((u) => u.delivered)),
    jsonRawValidRate: jsonCalls ? us.reduce((s, u) => s + u.jsonRawValid, 0) / jsonCalls : null,
    jsonAfterFenceRate: jsonCalls ? us.reduce((s, u) => s + u.jsonValidAfterFence, 0) / jsonCalls : null,
    validatorAcceptRate: rate(us.map((u) => u.validatorAccepts)),
    refusalRate: outcome('refusal'), emptyRate: outcome('empty'), timeoutRate: outcome('timeout'),
    contextLimitRate: outcome('context_limit'), incompleteRate: outcome('incomplete'), httpErrorRate: outcome('http_error') + outcome('rate_limited'),
    callP50: percentile(allLatency, 50), callP95: percentile(allLatency, 95),
    actionP50: percentile(fullTurns.map((u) => u.actionLatencyMs), 50), actionP95: percentile(fullTurns.map((u) => u.actionLatencyMs), 95),
    over20sShare: allLatency.length ? allLatency.filter((x) => x > 20_000).length / allLatency.length : null,
    meanTokensIn: mean(fullTurns.map((u) => u.tokensIn)), meanTokensOut: mean(fullTurns.map((u) => u.tokensOut)),
    meanCostPerAction: mean(fullTurns.map((u) => u.costUsd)),
    outTokensPerSec: totalMs > 0 ? totalOut / (totalMs / 1000) : null,
    failures, metrics,
    fixedScore: usable.length ? usable.reduce((s, [, v]) => s + v, 0) / usable.length : null,
    fixedComponents: components.map(([k]) => k),
  };
}

export function writeScores(runDir: string, units: UnitScore[]): void {
  const dir = path.join(runDir, 'scores');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'units.json'), JSON.stringify(units), { mode: 0o600 });
}
