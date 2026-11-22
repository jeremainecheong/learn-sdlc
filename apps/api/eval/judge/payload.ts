import type { CorpusCase, UseCase } from '../contracts';
import { useCaseOf } from '../contracts';
import type { ExecTruth } from '../exec-truth';

/**
 * What a judge sees for one output: the case's trusted context (trimmed), the
 * output rendered as the learner would see it, and for proposals the
 * executable-truth results as evidence. Never a model key, family or provider;
 * never hidden test sources or solution files.
 */

export const CAP = { context: 6000, file: 3000, output: 6000, workspace: 9000 };

export const clip = (text: unknown, n: number): string => {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? null);
  return s.length <= n ? s : `${s.slice(0, n)}\n…[truncated ${s.length - n} characters]`;
};

const clipFiles = (files: Record<string, string> | null | undefined, total: number): Record<string, string> => {
  const out: Record<string, string> = {};
  let left = total;
  for (const [p, body] of Object.entries(files ?? {})) {
    if (left <= 0) { out[p] = '…[omitted]'; continue; }
    const cut = clip(body, Math.min(CAP.file, left));
    out[p] = cut;
    left -= cut.length;
  }
  return out;
};

/** A compact unified-style diff of whole files, for judging a proposal. */
export function fileDiff(before: Record<string, string>, after: Record<string, string>, cap = CAP.output): string {
  const parts: string[] = [];
  for (const p of Object.keys(after).sort()) {
    const a = (before[p] ?? '').split('\n');
    const b = after[p].split('\n');
    const setA = new Set(a);
    const setB = new Set(b);
    parts.push(`--- ${p}`);
    for (const line of a) if (!setB.has(line)) parts.push(`- ${line}`);
    for (const line of b) if (!setA.has(line)) parts.push(`+ ${line}`);
  }
  return clip(parts.join('\n'), cap);
}

export interface RawUnit {
  modelKey: string;
  caseId: string;
  jobType: string;
  product: Record<string, any>;
  calls: Array<{ label: string; responseText: string | null }>;
}

/** The output as text, as the learner would see it (or the last draft the product withheld). */
export function renderOutput(c: CorpusCase, raw: RawUnit, exec?: ExecTruth | null): string {
  const p = raw.product ?? {};
  const lastDraft = (label: string) => [...raw.calls].reverse().find((x) => x.label === label && x.responseText)?.responseText ?? null;
  switch (useCaseOf(c.jobType)) {
    case 'interview':
      if (p.useCase === 'interview.review') return clip(JSON.stringify({ safe: p.safe, supportedFactIds: p.supportedFactIds, failedChecks: p.failedChecks ?? [] }), CAP.output);
      return p.delivered ? clip(p.answer, CAP.output) : `[The product withheld this reply (${p.failure ?? 'withheld'}). Last draft:]\n${clip(lastDraft('interview.answer') ?? '(no draft)', CAP.output)}`;
    case 'mentor':
      if (p.useCase === 'guided.review') return clip(JSON.stringify({ safe: p.safe, failedChecks: p.failedChecks }), CAP.output);
      return p.delivered ? clip(p.reply, CAP.output) : `[The product withheld this reply (${p.failure ?? 'withheld'}). Last draft:]\n${clip(lastDraft('guided.draft') ?? '(no draft)', CAP.output)}`;
    case 'agentic': {
      if (p.shortCircuit === 'read-only-target') return '[The server refused the request before any model call: it targets a read-only file.]';
      const head = p.useCase === 'agentic.chat'
        ? `Classification: ${p.kind ?? 'invalid'}\nReply: ${clip(p.reply ?? '', 1500)}\nQuestions: ${JSON.stringify(p.questions ?? [])}`
        : `Intent assessment: ${p.adequate === null || p.adequate === undefined ? 'invalid' : p.adequate ? 'adequate' : 'inadequate'}\nFeedback: ${clip(p.feedback ?? '', 1000)}\nQuestions: ${JSON.stringify(p.questions ?? [])}`;
      const files = p.files ? `\nProposed changes:\n${fileDiff((c.input.workspace ?? c.input.data?.savedWorkspace ?? {}) as Record<string, string>, p.files)}` : p.failure ? `\n[No proposal: ${p.failure}]` : '';
      const evidence = exec && exec.status === 'run'
        ? `\nEvidence from the product's runner (not model claims): visible tests ${exec.visiblePass === null ? 'n/a' : exec.visiblePass ? 'pass' : 'fail'}, hidden tests ${exec.hiddenPass === null ? 'n/a' : exec.hiddenPass ? 'pass' : 'fail'}, static analysis ${exec.staticAnalysis ?? 'n/a'}, max complexity ${exec.maxComplexity ?? 'n/a'} (limit 8), files outside the editable set: ${exec.editableOnly ? 'none' : 'yes'}.`
        : exec && exec.status === 'not_run' ? `\n[Executable truth not run: ${exec.reason}]` : '';
      return `${head}${files}${evidence}`;
    }
    case 'explanation':
      if (!p.delivered) return `[No assessment: ${p.failure}]`;
      return clip(JSON.stringify({ accepted: p.approved, dimensions: p.dimensions, feedback: p.feedback, questions: p.questions }, null, 1), CAP.output);
    case 'review':
      if (!p.delivered) return `[No verdict: the product failed closed (${p.failure}); the learner sees Needs revision with an assessment error.]`;
      return clip(JSON.stringify({ verdict: p.verdict, summary: p.summary, improvements: p.improvements, criteria: (p.criteriaEvidence ?? []).map((x: any) => ({ key: x.key, met: x.met, evidence: clip(x.evidence, 600), issue: clip(x.issue, 400), nextStep: clip(x.nextStep, 400) })) }, null, 1), CAP.output);
  }
}

/** The trusted context for the judge: what the learner asked or submitted, and the phase it was in. */
export function judgeContext(c: CorpusCase, derivedReview?: { reviewInput?: { checks?: Array<{ id: string; status: string; label?: string }> }; effectiveLabel?: { verdict: string | null } } | null): Record<string, unknown> {
  const phase = c.input.phase?.phaseKey ?? c.tags.phase ?? 'requirements';
  const u: UseCase = useCaseOf(c.jobType);
  const base = { phase, project: c.tags.project === 'starter' ? 'Shelf (a small library app)' : 'TaskTrackr (a task tracker)' };
  switch (u) {
    case 'interview':
      return { ...base, learnerQuestion: c.input.question, alreadySettledFacts: c.input.settled ?? [], teamExpectation: c.reference.expected?.expectation ?? null, hardRules: c.reference.expected?.guardrails ?? null, candidateAnswerUnderReview: c.input.subJob ? c.input.answer : undefined };
    case 'mentor': {
      const m = c.input.mentorContext ?? c.input.context ?? {};
      return { ...base, learnerMessage: m.message, recentHistory: clip(m.history ?? [], 1500), learnerFiles: clipFiles(m.workspace ?? {}, CAP.context), lesson: c.input.lesson === true, teamExpectation: c.reference.expected?.expectation ?? null, hardRules: c.reference.expected?.guardrails ?? null, candidateUnderReview: c.input.candidate };
    }
    case 'agentic':
      return c.input.mode === 'chat'
        ? { ...base, learnerMessage: c.input.data?.currentMessage, savedFiles: clipFiles(c.input.data?.savedWorkspace, CAP.context), teamExpectation: c.reference.expected ?? null }
        : { ...base, learnerRequest: c.input.prompt, editablePaths: c.input.editablePaths, savedFiles: clipFiles(c.input.workspace, CAP.context), teamExpectation: { intentAdequate: c.reference.expected?.intentAdequate ?? null } };
    case 'explanation': {
      const d = c.input.data ?? {};
      return { ...base, originalRequest: d.reference?.originalRequest, proposedChanges: fileDiff(d.reference?.before ?? {}, d.reference?.proposedFiles ?? {}, 3000), learnerExplanation: d.learnerAnswer, teamExpectation: { adequate: c.reference.expected?.adequate ?? null } };
    }
    case 'review': {
      const ri = c.input.reviewInput ?? {};
      return { ...base, submittedFiles: clipFiles(ri.workspace, CAP.workspace), serverChecks: (derivedReview?.reviewInput?.checks ?? []).map((x) => ({ id: x.id, status: x.status })), teamExpectedVerdict: derivedReview?.effectiveLabel?.verdict ?? c.reference.expected?.verdict ?? null };
    }
  }
}
