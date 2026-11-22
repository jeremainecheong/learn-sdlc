'use client';
import { CHANGE_REQUEST_JSON, RUNBOOK_JSON, type FieldChange, type PhaseDetail } from '@learnsdlc/shared';
import type { AgentProposal } from '@/lib/api-mentor';
import { isRoomRecordPath } from '@/components/workspace/records';
import { proposalStillPending, useProposalComparison, type ComparisonArgs } from './useStoryComparison';

/**
 * A runbook or change-request proposal's overlay data, read when
 * the learner asks for the comparison, as `useDesignComparison` reads a
 * design's: the record's label, its changed fields and what the proposal
 * keeps as saved, the other files it touches beside their saved text, and the
 * saved record its changes are numbered by (an Apply reads it to mark the
 * fields the assistant wrote). `key` is the proposal version they were read
 * for, so an edited or replaced proposal never shows them.
 */
export type RecordComparison = {
  key: string;
  label: 'Runbook' | 'Change request';
  changes: FieldChange[];
  carried: string[];
  files: { path: string; before?: string; after: string }[];
  saved: string | undefined;
};

/** Whether a proposal is a record one: it carries `changes` and touches the runbook or the change request, pending or not. */
export const isRecordProposal = (proposal: AgentProposal) => Boolean(proposal.changes) && Object.keys(proposal.files).some(isRoomRecordPath);

/**
 * Whether a proposal is a record proposal still to be decided on. A record
 * path is mounted only in a phase whose detail carries `runbook` or `change`,
 * so a proposal touching one is on such a phase.
 */
export function recordProposalPending(proposal: AgentProposal | null, proposals: readonly AgentProposal[], workspaceHash: string | null): boolean {
  return proposalStillPending(proposal, proposals, workspaceHash, (files) => Object.keys(files).some(isRoomRecordPath));
}

/** The saved text of a path in a phase's detail. */
export const savedTextOf = (detail: Pick<PhaseDetail, 'files'>, path: string): string | undefined => detail.files.find((file) => file.path === path)?.content;

/** The comparison hook the story overlay uses, building the record's comparison from the proposal's `changes` and `carried`. */
export function useRecordComparison(args: ComparisonArgs) {
  return useProposalComparison<RecordComparison>({
    ...args,
    failure: 'Your saved record could not be loaded for the comparison. Your proposal is kept.',
    build: (detail, fresh, key) => {
      const record = detail.runbook ? RUNBOOK_JSON : detail.change ? CHANGE_REQUEST_JSON : null;
      // A record path is mounted only beside its spec; without one, the hook's failure sentence is said.
      if (!record) throw new Error('This phase keeps no record.');
      return {
        key,
        label: record === RUNBOOK_JSON ? 'Runbook' : 'Change request',
        changes: fresh.changes ?? [],
        carried: fresh.carried ?? [],
        files: Object.entries(fresh.files)
          // the other files the proposal writes, each one only when it differs from the saved copy
          .filter(([path, after]) => !isRoomRecordPath(path) && savedTextOf(detail, path) !== after)
          .map(([path, after]) => ({ path, before: savedTextOf(detail, path), after })),
        saved: savedTextOf(detail, record),
      };
    },
  });
}
