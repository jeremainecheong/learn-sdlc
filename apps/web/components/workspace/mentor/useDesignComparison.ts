'use client';
import { API_CONTRACT_JSON, DESIGN_JSON, DESIGN_OLDER_FORMAT_ROOM, SCREEN_CONTRACT_JSON, type DesignDocuments } from '@learnsdlc/shared';
import type { AgentProposal } from '@/lib/api-mentor';
import { designCompareDocuments, type DesignCompareDocument } from '@/components/workspace/panels/design/designChanges';
import { ComparisonRefusal, proposalStillPending, useProposalComparison, type ComparisonArgs } from './useStoryComparison';

/**
 * A design proposal's overlay data, read when the learner asks for the
 * comparison: the changes grouped by the documents they touch, what the
 * proposal keeps as saved, and the saved documents the changes are numbered
 * by (an Apply reads them to find each changed item in the applied
 * documents). `key` is the proposal version they were read for, so an edited
 * or replaced proposal never shows them.
 */
export type DesignComparison = { key: string; documents: DesignCompareDocument[]; carried: string[]; saved: DesignDocuments };

const DESIGN_DOCUMENTS = [DESIGN_JSON, API_CONTRACT_JSON, SCREEN_CONTRACT_JSON];

/** Whether a proposal is a design one: it carries `changes` and touches a design document, pending or not. */
export const isDesignProposal = (proposal: AgentProposal) => Boolean(proposal.changes) && Object.keys(proposal.files).some((path) => DESIGN_DOCUMENTS.includes(path));

/** The saved design documents in a phase's detail, the ones a design proposal's changes are numbered by. */
export function savedDesignOf(detail: { files: { path: string; content: string }[] }): DesignDocuments {
  return Object.fromEntries(detail.files.filter((file) => DESIGN_DOCUMENTS.includes(file.path)).map((file) => [file.path, file.content]));
}

/** Whether a proposal is a design proposal still to be decided on: it carries `changes` and touches a design document. */
export function designProposalPending(proposal: AgentProposal | null, proposals: readonly AgentProposal[], workspaceHash: string | null): boolean {
  return proposalStillPending(proposal, proposals, workspaceHash, files => Object.keys(files).some(path => DESIGN_DOCUMENTS.includes(path)));
}

/** The comparison hook the story overlay uses, building the design's documents from the proposal's `changes` and `carried`. */
export function useDesignComparison(args: ComparisonArgs) {
  return useProposalComparison<DesignComparison>({
    ...args,
    failure: 'Your saved design could not be loaded for the comparison. Your proposal is kept.',
    build: (detail, fresh, key) => {
      if (!detail.design) throw new ComparisonRefusal(DESIGN_OLDER_FORMAT_ROOM);
      const saved = savedDesignOf(detail);
      return { key, documents: designCompareDocuments(fresh.changes ?? [], detail.design.contracts), carried: fresh.carried ?? [], saved };
    },
  });
}
