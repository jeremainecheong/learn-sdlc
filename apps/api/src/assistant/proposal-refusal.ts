import { BadRequestException } from '@nestjs/common';
import { CHANGE_PROPOSAL_REFUSED, DESIGN_PROPOSAL_REFUSED, DESIGN_PROPOSAL_UNCHANGED, RUNBOOK_PROPOSAL_REFUSED } from '@learnsdlc/shared';

export const STORY_PROPOSAL_REFUSED = "The assistant's proposal was not a valid story and was discarded.";
/**
 * A generated proposal the server cannot read against the learner's files: an
 * edit list the expander refuses, or a file map `validateFiles` refuses.
 * Any phase, any kind; the reason names the rule and at
 * most an editable path.
 */
export const FILES_PROPOSAL_REFUSED = "The assistant's proposal did not fit your current files and was discarded.";

/** The fixed sentence of each structured kind's refused (or unchanged, discarded) proposal, by the code its failed turn carries. */
const REFUSED_PROPOSAL_SENTENCE = {
  story_proposal_refused: STORY_PROPOSAL_REFUSED,
  design_proposal_refused: DESIGN_PROPOSAL_REFUSED,
  design_proposal_unchanged: DESIGN_PROPOSAL_UNCHANGED,
  runbook_proposal_refused: RUNBOOK_PROPOSAL_REFUSED,
  change_proposal_refused: CHANGE_PROPOSAL_REFUSED,
  files_proposal_refused: FILES_PROPOSAL_REFUSED,
} as const;
export type RefusedProposalCode = keyof typeof REFUSED_PROPOSAL_SENTENCE;

/**
 * Which rule refused the proposal: a fixed token for the log line, never a
 * word of the record. `invalid_record` and `invalid_document` are the
 * validator's own refusals (the model wrote a record the schema does not
 * read); `path_not_allowed` a document this phase does not have;
 * `carried_invalid` a record that stopped validating once the saved ids were
 * carried back in; `carried_changed` a learner's edit, or a stored proposal,
 * that would change what a proposal keeps as saved; `switched_off` a change to
 * a part the teacher switched off; `unchanged` a proposal with nothing left;
 * `edit_list` a generated edit list the expander refused and `invalid_files` a
 * generated file map `validateFiles` refused.
 */
export type RefusalClause = 'invalid_record' | 'invalid_document' | 'path_not_allowed' | 'carried_invalid' | 'carried_changed' | 'switched_off' | 'unchanged' | 'edit_list' | 'invalid_files';

/** The most of a reason that is kept on the turn; the validator's sentences are far shorter. */
const REFUSAL_DETAIL_MAX_CHARS = 400;

/**
 * A structured proposal refused: the story, design, runbook and change-request
 * doors all throw this one class, as does a generated proposal of any phase
 * whose files the server cannot read (`files_proposal_refused`), so the chat turn that fails on it carries
 * the kind's fixed sentence and, when the rule that refused it can say why,
 * the reason after the sentence. With the fixed sentence alone a learner
 * would retry blind, with no way to tell, for example, that the model had
 * written one decision's `satisfies` as a text instead of a list.
 *
 * `detail` is the validator's own sentence for the record ("The design record
 * is not valid: decision D1 satisfies is not a list."): the schema's words and
 * at most an item id of the record, never the model's prose. It goes to the
 * learner on the turn and in the HTTP message; the log line names the clause
 * only.
 */
export class RefusedProposalException extends BadRequestException {
  readonly code: RefusedProposalCode;
  readonly clause: RefusalClause;
  readonly detail: string | null;
  constructor(code: RefusedProposalCode, clause: RefusalClause, detail: string | null = null) {
    const kept = detail?.trim() ? detail.trim().slice(0, REFUSAL_DETAIL_MAX_CHARS) : null;
    super(refusedProposalMessage(code, kept));
    this.code = code;
    this.clause = clause;
    this.detail = kept;
  }
}

/** The fixed sentence, followed by the reason when there is one. */
export function refusedProposalMessage(code: RefusedProposalCode, detail: string | null | undefined): string {
  const sentence = REFUSED_PROPOSAL_SENTENCE[code];
  return detail ? `${sentence} ${detail}` : sentence;
}

export const isRefusedProposalCode = (code: string | null | undefined): code is RefusedProposalCode =>
  !!code && Object.prototype.hasOwnProperty.call(REFUSED_PROPOSAL_SENTENCE, code);
