import { CHANGE_REQUEST_JSON, RUNBOOK_JSON, changeRequestCarried, changeRequestChangeSet, designCarried, designChangeSet, runbookCarried, runbookChangeSet, type FieldChange } from '@learnsdlc/shared';
import { recordPathOf } from '../content/checks-validation';
import type { PhaseContent } from '../content/content.types';
import { storyCarried, storyChangeSet } from './story-proposal';

/**
 * A structured kind's proposal as the overlay shows it and the explanation
 * gate reads it: the field change set from `before` (the documents the
 * proposal is read against) and what it carries. A story proposal that
 * touches the record, any design proposal that holds a document, and a
 * runbook or change-request proposal that touches the record; null for every
 * other phase, whose views and explanation calls stay as they were.
 */
export function structuredReference(phase: PhaseContent, before: Record<string, string>, proposed: Record<string, string>): { changes: FieldChange[]; carried: string[] } | null {
  const checks = phase.checks;
  if (checks?.kind === 'story' && proposed[checks.record] !== undefined) {
    return { changes: storyChangeSet(before[checks.record], proposed[checks.record]), carried: storyCarried(before[checks.record]) };
  }
  // a proposal with no files (an inadequate request) has nothing to measure
  if (checks?.kind === 'design' && Object.keys(proposed).length > 0) {
    const after = { ...before, ...proposed };
    // kept means in both: a removed item is a removal in the change set, and a new one is new, so neither is carried
    const saved = new Set(designCarried(before));
    return { changes: designChangeSet(before, after, checks), carried: designCarried(after).filter((kept) => saved.has(kept)) };
  }
  const record = recordPathOf(checks);
  if (record && proposed[record] !== undefined) {
    const keptBefore = (text: string | undefined) => (record === RUNBOOK_JSON
      ? runbookCarried(text, checks?.kind === 'config' && !!checks.drill)
      : changeRequestCarried(text, checks?.kind === 'code' && !!checks.change?.contract));
    // kept means in both, as the design's: a removed item is a removal, a new one is new
    const saved = new Set(keptBefore(before[record]));
    const changes = record === RUNBOOK_JSON
      ? runbookChangeSet(before[record], proposed[record])
      : changeRequestChangeSet(before[record], proposed[record], checks?.kind === 'code' && !!checks.change?.contract);
    return { changes, carried: keptBefore(proposed[record]).filter((kept) => saved.has(kept)) };
  }
  return null;
}

/**
 * The documents whose explanation gate reads the field change set in place of
 * whole files, read through `changeSetDocumentOf`: the story, the design, a
 * config phase's runbook and a code phase's change request. Implementation
 * (code without a change request) keeps its file evidence.
 */
export type ChangeSetDocument = 'story' | 'design' | 'runbook' | 'change';

/** The phase's change-set document: a runbook or a change request exactly when `recordPathOf` names that record. */
export function changeSetDocumentOf(phase: PhaseContent): ChangeSetDocument | null {
  const checks = phase.checks;
  if (checks?.kind === 'story') return 'story';
  if (checks?.kind === 'design') return 'design';
  const record = recordPathOf(checks);
  return record === RUNBOOK_JSON ? 'runbook' : record === CHANGE_REQUEST_JSON ? 'change' : null;
}

/**
 * The explanation call's reference. A story or design proposal: its change
 * set and carried list. A runbook or change proposal that touches
 * the record: the record's change set and carried list, and `before` and
 * `proposedFiles` for the other files it touches only (`mixed`). Any other
 * proposal: its before and proposed files.
 */
export function explanationReference(
  phase: PhaseContent, before: Record<string, string>, files: Record<string, string>,
  head: { originalRequest: string; proposalHash: string; latestEdit: unknown },
): { reference: Record<string, unknown>; structured: boolean; mixed: boolean } {
  const document = changeSetDocumentOf(phase);
  const structured = document ? structuredReference(phase, before, files) : null;
  if (!structured) {
    return { reference: { originalRequest: head.originalRequest, before, proposedFiles: files, proposalHash: head.proposalHash, latestEdit: head.latestEdit }, structured: false, mixed: false };
  }
  const record = document === 'runbook' || document === 'change' ? recordPathOf(phase.checks) : null;
  const others = record ? Object.fromEntries(Object.entries(files).filter(([path]) => path !== record)) : {};
  const mixed = Object.keys(others).length > 0;
  return {
    reference: {
      originalRequest: head.originalRequest, changes: structured.changes, carried: structured.carried,
      ...(mixed ? { before: Object.fromEntries(Object.keys(others).map((path) => [path, before[path] ?? ''])), proposedFiles: others } : {}),
      proposalHash: head.proposalHash, latestEdit: head.latestEdit,
    },
    structured: true,
    mixed,
  };
}
