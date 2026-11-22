'use client';

/**
 * The mentor's other rooms: the customer interview, the stuck flag
 * a learner raises from the workspace, the instructor's answer to it, and the
 * notes an instructor writes for a whole class.
 *
 * Its own module rather than lines in `lib/api.ts` and `lib/api-instructor.ts`:
 * those two are read by every page in the product, and none of this is. A page
 * that never opens an interview never pulls any of it into its bundle.
 *
 * Both halves live here (the learner's calls and the staff calls) because
 * they are two ends of the same feature. A stuck flag is one row: the learner
 * raises it and clears it, the instructor lists it and answers it, and putting
 * those four calls in two files would only mean reading two files to see one
 * exchange.
 */
import type {
  AgentAssessment,
  AgentAssessmentDimension,
  AgentProposal as SharedAgentProposal,
  AssistantChatResponse,
  AssistantMessageView,
  ExplainSource,
  ExplainTestResponse,
  InstructorNoteKind,
  InstructorNoteView,
  InterviewAskResponse,
  InterviewState,
  PhaseKey,
  StuckFlag,
  StuckItem,
} from '@learnsdlc/shared';
import { REVIEWED_AI_TIMEOUT_MS, request } from './api';
import { seg } from './api-fetch';

export type { AgentAssessment, AgentAssessmentDimension };

/** A proposal as this client reads it: the shared contract and the field below. */
export interface AgentProposal extends SharedAgentProposal {
  /**
   * The AI's short summary, in the present tense, of what this proposal changes,
   * what to read before explaining it and, where the phase has something to run,
   * what to run after Apply, written in the same generation call and shown
   * above the diff. Never why it is right: the learner's own explanation is
   * still what unlocks Apply. Null or absent when the model wrote none, and on
   * every proposal made before it existed.
   *
   * Stored as checked by the API (`checkSummaryPaths`, on a proposal that holds
   * a file), so it may be the server's words rather than the model's: one that
   * names an editable file the proposal does not hold, or whose proposal left a
   * code or configuration file out as unchanged, is replaced by the server's
   * `Files in this proposal: …` sentence and a sentence naming those files; one
   * that names another path the proposal does not hold and none it holds is
   * replaced by that `Files in this proposal: …` sentence alone; and one that
   * names a held file but leaves another held file unnamed keeps its words and
   * gains that sentence.
   */
  summary?: string | null;
}


/**
 * A learner with no flag is a **200 with an empty body**, not `null` in JSON:
 * Nest serialises a null return that way, and `request()` (which parses the
 * body and falls back to `{}` when there is none) hands that back as an empty
 * object. An empty object is truthy, so without this every learner who had
 * never asked for help would be told "your instructor can see this" the moment
 * they opened a phase. A flag is a flag only if it says when it was raised.
 */
function asFlag(value: StuckFlag | null): StuckFlag | null {
  return value && typeof value.raisedAt === 'string' ? value : null;
}

/** What a note is written or edited with; the API fills in the rest. */
export interface WriteNote {
  kind: InstructorNoteKind;
  cohortId: string;
  /** Null or absent means every phase. */
  phaseKey?: PhaseKey | null;
  /** Null or absent means every project. */
  projectSlug?: string | null;
  text: string;
  /** `"<phaseKey>:<title>"` when a derived lecture point was pinned. */
  sourceId?: string | null;
  done?: boolean;
}

export const mentorApi = {
  /* ------------------------------ the learner ----------------------------- */

  /** Private Guided teaching, available even while this project phase is locked. */
  lessonHistory: (phaseStateId: string) =>
    request<AssistantMessageView[]>('GET', `/phases/${seg(phaseStateId)}/lesson/mentor`),
  lessonChat: (phaseStateId: string, message: string) =>
    request<AssistantChatResponse>('POST', `/phases/${seg(phaseStateId)}/lesson/mentor`, { message }, { timeoutMs: REVIEWED_AI_TIMEOUT_MS }),

  /** 404 "this phase has no interview" when the pack declares none. */
  interview: (phaseStateId: string) =>
    request<InterviewState>('GET', `/phases/${seg(phaseStateId)}/interview`),
  /** 409 once `turnsLeft` is 0; the composer disables before that happens. */
  ask: (phaseStateId: string, question: string) =>
    request<InterviewAskResponse>('POST', `/phases/${seg(phaseStateId)}/interview/ask`, {
      question,
    }, { timeoutMs: REVIEWED_AI_TIMEOUT_MS }),

  /**
   * Ask the reviewer why one test fails. 404 when the named case is
   * not in that result any more, which is what a learner sees once a newer run
   * has replaced the one the button was drawn from.
   */
  explainTest: (
    phaseStateId: string,
    body: { testName: string; source: ExplainSource; sourceId?: string; step?: string },
  ) =>
    request<ExplainTestResponse>('POST', `/phases/${seg(phaseStateId)}/explain-test`, body, { timeoutMs: REVIEWED_AI_TIMEOUT_MS }),

  /** The learner's own flag on one phase, or null. This is what the column polls. */
  stuck: (phaseStateId: string) =>
    request<StuckFlag | null>('GET', `/phases/${seg(phaseStateId)}/stuck`).then(asFlag),
  /** 409 "you already have a flag open on this phase" while one is unanswered. */
  raiseStuck: (phaseStateId: string, question: string, tried: string) =>
    request<StuckFlag>('POST', `/phases/${seg(phaseStateId)}/stuck`, { question, tried }),
  /** Clearing is the learner's act, never the instructor's. Empty body, same trap. */
  clearStuck: (phaseStateId: string) =>
    request<StuckFlag | null>('POST', `/phases/${seg(phaseStateId)}/stuck/clear`, {}).then(asFlag),

  /* ------------------------------- the staff ------------------------------ */

  /** Oldest first, at most 50. `open` means not yet cleared, answered or not. */
  stuckList: (options: { project?: string; state?: 'open' | 'all'; cohortId?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.project) params.set('project', options.project);
    if (options.state) params.set('state', options.state);
    if (options.cohortId) params.set('cohortId', options.cohortId);
    const query = params.toString();
    return request<StuckItem[]>('GET', `/instructor/stuck${query ? `?${query}` : ''}`);
  },
  /** 409 when the learner cleared the flag while the answer was being typed. */
  answerStuck: (phaseStateId: string, answer: string) =>
    request<StuckItem>('POST', `/instructor/stuck/${seg(phaseStateId)}/answer`, { answer }),

  /** Newest first, at most 100, narrowed to the caller's own classes. */
  notes: (query: { cohortId?: string; kind?: InstructorNoteKind; phaseKey?: PhaseKey } = {}) => {
    const params = new URLSearchParams();
    if (query.cohortId) params.set('cohortId', query.cohortId);
    if (query.kind) params.set('kind', query.kind);
    if (query.phaseKey) params.set('phaseKey', query.phaseKey);
    const search = params.toString();
    return request<InstructorNoteView[]>('GET', `/instructor/notes${search ? `?${search}` : ''}`);
  },
  writeNote: (note: WriteNote) => request<InstructorNoteView>('POST', '/instructor/notes', note),
  updateNote: (id: string, patch: Partial<WriteNote>) =>
    request<InstructorNoteView>('PATCH', `/instructor/notes/${seg(id)}`, patch),
  deleteNote: (id: string) =>
    request<{ deleted: true }>('DELETE', `/instructor/notes/${seg(id)}`),
};

export interface AgentChatRequest {
  requestId: string;
  message: string;
  parentTurnId?: string;
  proposalId?: string;
  proposalHash?: string;
}
export interface AgentTurnResponse {
  kind: 'clarification' | 'discussion' | 'proposal' | 'explanation';
  reply: string;
  questions: string[];
  /** Historical snapshot only; refresh the current proposal before Apply. */
  proposal: AgentProposal | null;
}
export interface AgentTurn {
  id: string; phaseStateId: string; requestId: string;
  kind: 'chat' | 'explain'; status: 'pending' | 'completed' | 'failed';
  message: string;
  parentTurnId: string | null; parentProposalId: string | null;
  parentProposalHash: string | null; baseWorkspaceHash: string;
  proposalId: string | null; response: AgentTurnResponse | null;
  errorCode: string | null; createdAt: string; updatedAt: string;
  /** A refused or unchanged structured proposal's fixed sentence (`errorCode` story_proposal_refused, design_proposal_refused, design_proposal_unchanged, runbook_proposal_refused or change_proposal_refused), or a generated proposal whose files the server could not read (files_proposal_refused), followed by the rule's own reason when the server knows one. */
  errorMessage?: string;
  /**
   * Best effort, server generated, and meaningful only while `status` is
   * `'pending'`: `'proposing'` says the second model call of a chat turn (the
   * one that writes the proposed file contents) has started. Absent, null or a
   * value this client does not know all mean "nothing to report", which is
   * also what every explanation turn answers with. Never a
   * fragment of a reply: the panel would be showing unreviewed text.
   */
  stage?: 'proposing' | null;
}
export interface AgentTurnPage {
  items: AgentTurn[]; nextCursor: string | null;
  /** Current owned editable bytes, independent of the bounded proposal list. */
  currentWorkspaceHash?: string;
}
export const agentApi = {
  chat: (phaseId: string, input: AgentChatRequest) =>
    request<AgentTurn>('POST', `/phases/${seg(phaseId)}/agent/chat`, input, { timeoutMs: REVIEWED_AI_TIMEOUT_MS }),
  turns: (phaseId: string, cursor?: string) =>
    request<AgentTurnPage>('GET', `/phases/${seg(phaseId)}/agent/turns${cursor ? `?cursor=${seg(cursor)}` : ''}`),
  turn: (phaseId: string, requestId: string) =>
    request<AgentTurn>('GET', `/phases/${seg(phaseId)}/agent/turns/${seg(requestId)}`),
  explainTurn: (phaseId: string, proposal: Pick<AgentProposal, 'id' | 'proposalHash'>, explanation: string, requestId: string, parentTurnId?: string) =>
    request<AgentTurn>('POST', `/phases/${seg(phaseId)}/agent/proposals/${seg(proposal.id)}/explain`,
      { proposalHash: proposal.proposalHash, explanation, requestId, ...(parentTurnId ? { parentTurnId } : {}) }, { timeoutMs: REVIEWED_AI_TIMEOUT_MS }),
  list: (phaseId: string) => request<AgentProposal[]>('GET', `/phases/${seg(phaseId)}/agent/proposals`),
  proposal: (phaseId: string, proposalId: string) =>
    request<AgentProposal>('GET', `/phases/${seg(phaseId)}/agent/proposals/${seg(proposalId)}`),
  propose: (phaseId: string, prompt: string) => request<AgentProposal>('POST', `/phases/${seg(phaseId)}/agent/propose`, { prompt }, { timeoutMs: REVIEWED_AI_TIMEOUT_MS }),
  edit: (phaseId: string, proposal: AgentProposal, files: Record<string, string>) => request<AgentProposal>('POST', `/phases/${seg(phaseId)}/agent/proposals/${seg(proposal.id)}/edit`, { proposalHash: proposal.proposalHash, files }),
  explain: (phaseId: string, proposal: AgentProposal, explanation: string) => request<AgentProposal>('POST', `/phases/${seg(phaseId)}/agent/proposals/${seg(proposal.id)}/explain`, { proposalHash: proposal.proposalHash, explanation }, { timeoutMs: REVIEWED_AI_TIMEOUT_MS }),
  apply: (phaseId: string, proposal: AgentProposal) => request<{ proposal: AgentProposal; workspace: Record<string, string> }>('POST', `/phases/${seg(phaseId)}/agent/proposals/${seg(proposal.id)}/apply`, { proposalHash: proposal.proposalHash }),
};
