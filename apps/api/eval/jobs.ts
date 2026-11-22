import type { PhaseContent } from '../src/content/content.types';
import { soleTaskFor } from '../src/content/pack-compiler';
import type { OpenAiProvider } from '../src/assistant/openai.provider';
import { LESSON_SENTENCE } from '../src/assistant/openai.provider';
import { assessmentFailure } from '../src/assistant/assessment-failure';
import { stakeholderFailureCode } from '../src/assistant/interview.service';
import { AgenticService, composeAgentChatAssessment, composeAgentChatGeneration, composeAgenticIntentAssessment, composeAgenticProposeGeneration, readOnlyTargets, ADEQUATE_INTENT_FEEDBACK } from '../src/assistant/agentic.service';
import { parseAssessment } from '../src/assistant/strict-assessment';
import { EXPLANATION_ASSESSMENT_PROMPT, explanationAssessmentFailure, explanationAssessmentResponseSchema, hasGroundedUnderstanding, parseModelExplanationAssessment } from '../src/assistant/explanation-assessment';
import { GUIDED_REVIEW_PROMPT, guidedEvidence, parseGuidedReview } from '../src/assistant/guided-review';
import { detectOffPhase, isSolutionRequest, redactArtifactLikeReply, redactSolutions, WITHHELD_REPLY_NOTICE } from '../src/assistant/guardrails';
import { sealedRedactionSources } from '../src/assistant/project-scope';
import type { MentorContext } from '../src/assistant/provider.types';
import type { CorpusCase } from './contracts';
import type { DerivedReview } from './derive';
import { STARTER_TITLE, briefFor, phaseFor, scopeFor } from './world';

/**
 * One driver per product use-case. Each calls the provider through the
 * product's own public methods and composers, then applies the product's own
 * parsers, validators and output guardrails in the order the services apply
 * them (interview.service.ts `answer`, assistant.service.ts steps 2-7,
 * agentic.service.ts `propose` / `chatTurn` / `assessExplanation`). Database,
 * cache and usage-ledger steps are left out: they change no model input and
 * no learner-visible outcome.
 *
 * Where the product would answer without a model (a solution request, an
 * off-phase question, a read-only target), the driver records that
 * short-circuit; for the interview and mentor it still measures the model on
 * the same input, flagged `modelOnly`, because the bait cases exist to test
 * the model's own guardrails.
 */

export interface ProductOutcome {
  useCase: string;
  /** The product produced a usable, learner-visible result (not withheld, not failed). */
  delivered: boolean;
  failure: string | null;
  shortCircuit: string | null;
  modelOnly: boolean;
  [key: string]: unknown;
}

const failCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/budget stop/.test(message)) return 'budget_stop';
  if (/AWS login needed/.test(message)) return 'credentials';
  return assessmentFailure(error).code;
};

/* --------------------------------- review --------------------------------- */

export async function runReview(provider: OpenAiProvider, c: CorpusCase, derived: DerivedReview): Promise<ProductOutcome> {
  const { phase } = await phaseFor(c);
  const input = { ...derived.reviewInput, task: soleTaskFor(phase) } as never;
  try {
    const review = await provider.review(phase, input);
    return {
      useCase: 'review', delivered: true, failure: null, shortCircuit: null, modelOnly: false,
      verdict: review.verdict,
      criteria: (review.criteriaEvidence ?? []).map((x) => ({ key: x.key, met: x.met })),
      summary: review.summary,
      improvements: review.improvements,
      criteriaEvidence: review.criteriaEvidence,
    };
  } catch (error) {
    // The product fails closed: Needs revision with an assessment error, never a pass.
    return { useCase: 'review', delivered: false, failure: failCode(error), shortCircuit: null, modelOnly: false, verdict: null, criteria: [] };
  }
}

/* -------------------------------- interview ------------------------------- */

function interviewGuard(answer: string): string | null {
  const solution = redactSolutions(answer, []);
  if (solution.redacted) return null;
  const artifact = redactArtifactLikeReply(solution.content);
  if (artifact.redacted) return null;
  return solution.content.trim() || null;
}

export async function runInterview(provider: OpenAiProvider, c: CorpusCase): Promise<ProductOutcome> {
  const projectTitle = c.input.projectTitle ?? STARTER_TITLE;
  const { brief, derivationMatches } = await briefFor(c);
  if (c.input.subJob === 'interview.review') {
    try {
      const r = await provider.reviewInterview({ brief, question: c.input.question, answer: c.input.answer, claimedFactIds: c.input.claimedFactIds ?? [] });
      return { useCase: 'interview.review', delivered: true, failure: null, shortCircuit: null, modelOnly: false, safe: r.safe, supportedFactIds: r.supportedFactIds, failedChecks: r.failedChecks, derivationMatches };
    } catch (error) {
      return { useCase: 'interview.review', delivered: false, failure: stakeholderFailureCode(error), shortCircuit: null, modelOnly: false, safe: null, supportedFactIds: [], derivationMatches };
    }
  }
  const question: string = c.input.question;
  const settled: string[] = c.input.settled ?? [];
  const shortCircuit = isSolutionRequest(question) ? 'solution-request' : detectOffPhase(question, 'requirements') ? 'off-phase' : null;
  const attempts: Array<{ draft: string; guardBlocked: boolean; reviewSafe: boolean | null; failedChecks: string[]; supportedFactIds: string[] }> = [];
  try {
    let repair: { answer: string; facts: string[]; failedChecks: string[] } | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reply = await provider.interview(brief, projectTitle, question, settled, repair as never);
      if (typeof reply.content !== 'string' || !reply.content.trim()) throw new Error('Stakeholder answer is empty');
      const guarded = interviewGuard(reply.content);
      if (guarded === null) {
        attempts.push({ draft: reply.content, guardBlocked: true, reviewSafe: null, failedChecks: [], supportedFactIds: [] });
        throw new Error('Stakeholder drafted an assessed artifact');
      }
      if (repair && guarded === repair.answer) throw new Error('Stakeholder revision repeated the withheld answer');
      const reviewed = await provider.reviewInterview({ brief, question, answer: guarded, claimedFactIds: [] });
      attempts.push({ draft: guarded, guardBlocked: false, reviewSafe: reviewed.safe, failedChecks: reviewed.failedChecks, supportedFactIds: reviewed.supportedFactIds });
      if (!reviewed.safe) {
        if (attempt === 0) { repair = { answer: guarded, facts: [], failedChecks: reviewed.failedChecks }; continue; }
        throw new Error('Stakeholder response did not satisfy its evidence review');
      }
      return { useCase: 'interview', delivered: true, failure: null, shortCircuit, modelOnly: Boolean(shortCircuit), answer: guarded, facts: reviewed.supportedFactIds, attempts, derivationMatches, productAnswer: shortCircuit ? (shortCircuit === 'solution-request' ? brief.refusal : 'off-phase reply') : guarded };
    }
    throw new Error('Stakeholder response did not satisfy its evidence review');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const failure = /budget stop/.test(message) ? 'budget_stop' : /AWS login needed/.test(message) ? 'credentials' : stakeholderFailureCode(error);
    return { useCase: 'interview', delivered: false, failure, shortCircuit, modelOnly: Boolean(shortCircuit), answer: null, facts: [], attempts, derivationMatches, withheld: true };
  }
}

/* --------------------------------- mentor --------------------------------- */

export async function runMentor(provider: OpenAiProvider, c: CorpusCase, todosRemaining: string[] | null): Promise<ProductOutcome> {
  const { phase: loaded, tasks } = await phaseFor(c);
  if (c.input.subJob === 'guided.review') {
    const candidate: string = c.input.candidate;
    try {
      const result = await provider.structured(GUIDED_REVIEW_PROMPT, { ...c.input.context, candidate, candidateEvidence: guidedEvidence(candidate) }, undefined, undefined, undefined, 'guided.review');
      const parsed = parseGuidedReview(result.value, candidate);
      return { useCase: 'guided.review', delivered: true, failure: null, shortCircuit: null, modelOnly: false, safe: parsed.safe, failedChecks: parsed.failedChecks };
    } catch (error) {
      return { useCase: 'guided.review', delivered: false, failure: failCode(error), shortCircuit: null, modelOnly: false, safe: null, failedChecks: [] };
    }
  }
  const m = c.input.mentorContext;
  const lesson = c.input.lesson === true;
  // The lesson wrap, as AssistantService.chat builds it.
  const phase: PhaseContent = lesson
    ? { ...loaded, files: [], assistant: { ...loaded.assistant, systemPrompt: `${loaded.assistant.systemPrompt}\n${LESSON_SENTENCE}` } } as PhaseContent
    : loaded;
  const scope = scopeFor(loaded, tasks, lesson);
  const shortCircuit = m.failingTest ? null : detectOffPhase(m.message, loaded.key as never) ? 'off-phase' : isSolutionRequest(m.message) ? 'solution-request' : null;
  const workspace: Record<string, string> | undefined = lesson ? undefined : (m.workspace ?? undefined);
  const ctx: MentorContext = {
    phase,
    message: m.message,
    history: (m.history ?? []).slice(-12),
    workspace,
    interactionCount: m.interactionCount ?? 0,
    topicUseCounts: m.topicUseCounts ?? {},
    signals: lesson ? { todosRemaining: [], lastFailedChecks: [] } : { todosRemaining: todosRemaining ?? [], lastFailedChecks: m.signals?.lastFailedChecks ?? [] },
    difficultyOffset: m.difficultyOffset ?? 0,
    memory: lesson ? null : (m.memory ?? null),
    instructorNotes: m.instructorNotes ?? [],
    failingTest: m.failingTest ?? undefined,
    scope,
  } as MentorContext;
  try {
    const generated = await provider.chat(ctx);
    if (!generated.content.trim()) throw new Error('Empty mentor reply');
    const solutionSources = sealedRedactionSources(loaded.checks, {
      files: loaded.files,
      workspace: Object.fromEntries(loaded.files.filter((f) => f.editable).map((f) => [f.path, m.workspace?.[f.path] ?? f.content])),
    });
    let { content, redacted } = redactSolutions(generated.content, solutionSources);
    const artifact = redactArtifactLikeReply(content);
    if (artifact.redacted) { content = artifact.content; redacted = true; }
    return { useCase: 'mentor', delivered: content !== WITHHELD_REPLY_NOTICE, failure: null, shortCircuit, modelOnly: Boolean(shortCircuit), reply: content, rawReply: generated.content, redacted, withheldNotice: content === WITHHELD_REPLY_NOTICE };
  } catch (error) {
    const guided = Boolean(error && typeof error === 'object' && 'guidedReplyUnavailable' in error);
    return { useCase: 'mentor', delivered: false, failure: guided ? 'GUIDED_REPLY_WITHHELD' : failCode(error), shortCircuit, modelOnly: Boolean(shortCircuit), reply: null, withheld: guided };
  }
}

/* --------------------------------- agentic -------------------------------- */

/** agentic.service.ts parseIntentAssessment (unexported; same five lines, same constants). */
function parseIntentAssessment(value: unknown) {
  const row = value as Record<string, unknown> | null;
  if (row && typeof row === 'object' && !Array.isArray(row) && row.adequate === true && typeof row.feedback === 'string' && !row.feedback.trim() &&
      Array.isArray(row.questions) && row.questions.length === 0) {
    return { adequate: true, feedback: ADEQUATE_INTENT_FEEDBACK, questions: [] as string[] };
  }
  return parseAssessment(value);
}

/** The product's own validateFiles and agenticContext, borrowed: neither reads `this`. */
const validateFiles = (phase: PhaseContent, value: unknown): Record<string, string> =>
  (AgenticService.prototype as unknown as { validateFiles: (p: PhaseContent, v: unknown) => Record<string, string> }).validateFiles.call(null, phase, value);
const agenticContextOf = (phase: PhaseContent, scope: unknown): string =>
  (AgenticService.prototype as unknown as { context: (p: PhaseContent, s: unknown) => string }).context.call(null, phase, scope);

/** agentic.service.ts chat classification check (inline in chatTurn), as a predicate. */
function validChatReply(value: unknown): boolean {
  const reply = value as { kind?: unknown; reply?: unknown; questions?: unknown } | null;
  return !(!reply || typeof reply !== 'object' || Array.isArray(reply) || Object.keys(reply).length !== 3 || Object.keys(reply).some((key) => !['kind', 'reply', 'questions'].includes(key)) || !['clarification', 'discussion', 'proposal'].includes(String(reply.kind)) || typeof reply.reply !== 'string' || !reply.reply.trim() || reply.reply.length > 12_000 ||
    !Array.isArray(reply.questions) || reply.questions.some((q) => typeof q !== 'string' || !q.trim() || q.length > 4000) || reply.questions.length !== (reply.kind === 'clarification' ? 1 : 0));
}

export async function runAgentic(provider: OpenAiProvider, c: CorpusCase): Promise<ProductOutcome> {
  const { phase, tasks } = await phaseFor(c);
  const scope = scopeFor(phase, tasks);
  if (c.input.mode === 'chat') {
    const data = c.input.data;
    const prompt = String(data.currentMessage ?? '');
    const refused = phase.files.length ? readOnlyTargets(phase, prompt) : [];
    if (refused.length) return { useCase: 'agentic.chat', delivered: false, failure: null, shortCircuit: 'read-only-target', modelOnly: false, serverRefusal: true };
    let classification: unknown = null;
    try {
      classification = (await provider.structured(composeAgentChatAssessment(phase, scope), data, 3000, undefined, undefined, 'agentic.classify')).value;
    } catch (error) {
      return { useCase: 'agentic.chat', delivered: false, failure: failCode(error), shortCircuit: null, modelOnly: false, kind: null };
    }
    if (!validChatReply(classification)) return { useCase: 'agentic.chat', delivered: false, failure: 'invalid_chat_reply', shortCircuit: null, modelOnly: false, kind: null, rawClassification: classification };
    const reply = classification as { kind: string; reply: string; questions: string[] };
    let files: Record<string, string> | null = null;
    let generateFailure: string | null = null;
    if (reply.kind === 'proposal') {
      const saved = (data.savedWorkspace ?? {}) as Record<string, string>;
      const proposedWorkspace = { ...saved, ...((data.selectedProposal?.files ?? {}) as Record<string, string>) };
      try {
        const generated = (await provider.structured(composeAgentChatGeneration(phase, 'files', scope), { originalAndContinuedRequest: [data.originalRequest, prompt].filter(Boolean).join('\n'), precedingConversation: data.precedingConversation ?? [], savedWorkspace: saved, proposedWorkspace }, 9000, undefined, undefined, 'agentic.generate')).value as { files?: unknown };
        files = phase.files.length ? validateFiles(phase, generated?.files) : (generated?.files as Record<string, string>);
      } catch (error) { generateFailure = error instanceof Error && /invalid or non-editable|must be an object|too large/.test(error.message) ? 'invalid_files' : failCode(error); }
    }
    return { useCase: 'agentic.chat', delivered: generateFailure === null, failure: generateFailure, shortCircuit: null, modelOnly: false, kind: reply.kind, reply: reply.reply, questions: reply.questions, files };
  }
  const prompt: string = c.input.prompt;
  const workspace = (c.input.workspace ?? {}) as Record<string, string>;
  const refused = readOnlyTargets(phase, prompt);
  if (refused.length) return { useCase: 'agentic', delivered: false, failure: null, shortCircuit: 'read-only-target', modelOnly: false, serverRefusal: true, modelCalls: 0 };
  let assessment: { adequate: boolean; feedback: string; questions: string[] };
  let rawClassification: unknown = null;
  try {
    rawClassification = (await provider.structured(composeAgenticIntentAssessment(phase, scope), { prompt, workspace }, 3000, undefined, undefined, 'agentic.classify')).value;
  } catch (error) {
    return { useCase: 'agentic', delivered: false, failure: failCode(error), shortCircuit: null, modelOnly: false, adequate: null };
  }
  try {
    assessment = parseIntentAssessment(rawClassification);
    if (assessment.questions.length !== (assessment.adequate ? 0 : 1)) throw new Error('question count');
  } catch {
    return { useCase: 'agentic', delivered: false, failure: 'incomplete_prompt_assessment', shortCircuit: null, modelOnly: false, adequate: null, rawClassification };
  }
  if (!assessment.adequate) return { useCase: 'agentic', delivered: true, failure: null, shortCircuit: null, modelOnly: false, adequate: false, feedback: assessment.feedback, questions: assessment.questions, files: null };
  let rawFiles: unknown = null;
  try {
    rawFiles = ((await provider.structured(composeAgenticProposeGeneration(phase, 'files', scope), { prompt, workspace }, 9000, undefined, undefined, 'agentic.generate')).value as { files?: unknown })?.files ?? null;
  } catch (error) {
    return { useCase: 'agentic', delivered: false, failure: failCode(error), shortCircuit: null, modelOnly: false, adequate: true, feedback: assessment.feedback, questions: [], files: null };
  }
  const editable = new Set(phase.files.filter((f) => f.editable).map((f) => f.path));
  const rawPaths = rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles) ? Object.keys(rawFiles) : [];
  const outsideEditable = rawPaths.filter((p) => !editable.has(p));
  let files: Record<string, string> | null = null;
  try { files = validateFiles(phase, rawFiles); } catch {
    return { useCase: 'agentic', delivered: false, failure: 'invalid_files', shortCircuit: null, modelOnly: false, adequate: true, feedback: assessment.feedback, questions: [], files: null, rawPaths, outsideEditable };
  }
  return { useCase: 'agentic', delivered: true, failure: null, shortCircuit: null, modelOnly: false, adequate: true, feedback: assessment.feedback, questions: [], files, rawPaths, outsideEditable };
}

/* ------------------------------- explanation ------------------------------ */

export async function runExplanation(provider: OpenAiProvider, c: CorpusCase, frozen: { data: Record<string, any> }): Promise<ProductOutcome> {
  const { phase, tasks } = await phaseFor(c);
  const scope = scopeFor(phase, tasks);
  const answer: string = frozen.data.learnerAnswer;
  try {
    const result = await provider.structured(`${agenticContextOf(phase, scope)} ${EXPLANATION_ASSESSMENT_PROMPT}`, frozen.data, 4500, undefined, explanationAssessmentResponseSchema(answer), 'agentic.explanation');
    let assessment;
    try { assessment = parseModelExplanationAssessment(result.value, answer); } catch (error) {
      return { useCase: 'explanation', delivered: false, failure: explanationAssessmentFailure(error), shortCircuit: null, modelOnly: false, adequate: null, approved: false };
    }
    const approved = hasGroundedUnderstanding(assessment, answer);
    return {
      useCase: 'explanation', delivered: true, failure: null, shortCircuit: null, modelOnly: false,
      adequate: assessment.adequate, approved,
      dimensions: (assessment.dimensions ?? []).map((d) => ({ key: d.key, met: d.met, finding: d.finding })),
      feedback: assessment.feedback, questions: assessment.questions,
    };
  } catch (error) {
    return { useCase: 'explanation', delivered: false, failure: failCode(error), shortCircuit: null, modelOnly: false, adequate: null, approved: false };
  }
}
