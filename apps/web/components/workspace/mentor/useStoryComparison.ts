'use client';
import { useEffect, useRef, useState } from 'react';
import { STORY_JSON, type PhaseDetail, type Story } from '@learnsdlc/shared';
import { agentApi, type AgentProposal } from '@/lib/api-mentor';
import { api, describeError } from '@/lib/api';
import { storyView } from '@/components/workspace/panels/requirements/useStory';

/**
 * The two stories a story proposal's overlay draws, read from the saved files
 * when the learner asked for the comparison. `key` is the proposal version
 * they were read for, so an edited or replaced proposal never shows them.
 */
export type StoryComparison = { key: string; before: Story | null; after: Story; otherFiles: { path: string; before?: string; after: string }[] };

const keyOf = (proposal: Pick<AgentProposal, 'id' | 'proposalHash'>) => `${proposal.id}:${proposal.proposalHash}`;

/**
 * Whether a structured proposal is still the one to decide on: it carries
 * `changes`, `touches` its files, and it is not applied, not overtaken by a
 * later proposal or apply, and made against the workspace the conversation
 * knows as current (`workspaceHash`, null when unknown).
 *
 * The API computes `changes` against the CURRENT saved documents, so they
 * describe this proposal only while all of that holds. This is the client's
 * best knowledge; the server's 409 on Apply remains the guard.
 */
export function proposalStillPending(
  proposal: AgentProposal | null,
  proposals: readonly AgentProposal[],
  workspaceHash: string | null,
  touches: (files: Record<string, string>) => boolean,
): boolean {
  if (!proposal?.changes || !touches(proposal.files) || proposal.appliedAt) return false;
  const superseded = proposals.some(row => row.id !== proposal.id && (row.createdAt > proposal.createdAt || Boolean(row.appliedAt && row.appliedAt > proposal.createdAt)));
  return !superseded && (!workspaceHash || proposal.baseWorkspaceHash === workspaceHash);
}

/** Whether a proposal is a story proposal still to be decided on, the only story kind the overlay is offered for. */
export function storyProposalPending(proposal: AgentProposal | null, proposals: readonly AgentProposal[], workspaceHash: string | null): boolean {
  return proposalStillPending(proposal, proposals, workspaceHash, files => files[STORY_JSON] !== undefined);
}

/**
 * A comparison its builder refuses with a sentence of its own (a Design phase
 * still in the older format), said on the card as it is written rather than
 * replaced by the hook's `failure`.
 */
export class ComparisonRefusal extends Error {}

export interface ComparisonArgs {
  phaseId?: string;
  proposal: AgentProposal | null;
  pending: boolean;
  guard: () => () => boolean;
  onFresh: (next: AgentProposal) => void;
}

/**
 * An overlay's data for the selected proposal: on request, the saved files
 * and the proposal itself are read together (the saved-file comparison's own
 * read-only GET, and the proposal's GET), so BEFORE and `changes` describe the
 * same moment. `guard` captures the caller's owner at the start of a read and
 * says whether its answer is still wanted; `onFresh` hands the re-read
 * proposal back to the caller's list. `build` turns the two reads into the
 * overlay's data, or throws a `ComparisonRefusal` that says why there is
 * none; `failure` is said when they cannot be read.
 */
export function useProposalComparison<T extends { key: string }>({ phaseId, proposal, pending, guard, onFresh, build, failure }: ComparisonArgs & {
  build: (detail: PhaseDetail, fresh: AgentProposal, key: string) => T;
  failure: string;
}) {
  const [comparison, setComparison] = useState<T | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const key = proposal ? keyOf(proposal) : '';
  // A failed read belongs to the selection it was made for.
  useEffect(() => { setError(''); }, [key]);

  /**
   * The button that calls this stays enabled and focused while it loads, so
   * closing the overlay can hand focus straight back to it.
   */
  const open = async () => {
    if (!proposal || !phaseId || inFlight.current || !pending) return;
    const selected = proposal;
    const current = guard();
    inFlight.current = true; setComparing(true); setError('');
    try {
      const [detail, fresh] = await Promise.all([api.phase(phaseId), agentApi.proposal(phaseId, selected.id)]);
      if (!current()) return;
      if (detail.id !== phaseId) throw new Error('The saved files belong to a different phase.');
      if (fresh.id !== selected.id || fresh.phaseStateId !== phaseId) throw new Error('The returned proposal belongs to a different selection.');
      onFresh(fresh);
      setComparison(build(detail, fresh, keyOf(fresh)));
    } catch (err) {
      if (current()) setError(err instanceof ComparisonRefusal ? err.message : describeError(err, failure));
    } finally {
      inFlight.current = false;
      if (current()) setComparing(false);
    }
  };
  const close = () => setComparison(null);
  const reset = () => { setComparison(null); setComparing(false); setError(''); inFlight.current = false; };
  return {
    /** The comparison for the selected version, while it is still pending; null otherwise. */
    comparison: pending && comparison?.key === key ? comparison : null,
    comparing, error, open, close, reset,
  };
}

/** The two stories a story proposal's overlay draws. */
export function useStoryComparison(args: ComparisonArgs) {
  return useProposalComparison<StoryComparison>({
    ...args,
    failure: 'Your saved story could not be loaded for the comparison. Your proposal is kept.',
    build: (detail, fresh, key) => {
      const saved: Record<string, string> = Object.fromEntries(detail.files.filter(file => file.editable).map(file => [file.path, file.content]));
      const savedStory = storyView(saved[STORY_JSON] ?? '', detail.story);
      const otherFiles = Object.entries(fresh.files).filter(([path, content]) => path !== STORY_JSON && saved[path] !== content).map(([path, content]) => ({ path, before: saved[path], after: content }));
      return { key, before: savedStory.started ? savedStory.story : null, after: storyView(fresh.files[STORY_JSON] ?? '', detail.story).story, otherFiles };
    },
  });
}
