'use client';
import { useEffect, useRef, useState } from 'react';
export const AGENT_PREPARE = 'learnsdlc:agent-prepare';
export const AGENT_BUSY = 'learnsdlc:agent-busy';
export const AGENT_APPLIED = 'learnsdlc:agent-applied';
export interface AgentPrepareDetail { phaseId: string; waitUntil: (work: Promise<unknown>) => void }
export interface AgentAppliedDetail extends AgentPrepareDetail { workspace?: Record<string, string> }
/** Flush learner buffers and freeze edits while a proposal operation owns its source snapshot. */
export function useAgentWorkspace(phaseId: string, flushSave: () => Promise<void>, refreshWorkspace: (workspace?: Record<string, string>) => Promise<unknown>) {
 const [busy, setBusy] = useState(false);
 const [needsRefresh, setNeedsRefresh] = useState(false);
 const refreshBlocked = useRef(false);
 const currentPhase = useRef(phaseId);
 currentPhase.current = phaseId;
 useEffect(() => { refreshBlocked.current = false; setNeedsRefresh(false); setBusy(false); }, [phaseId]);
 useEffect(() => {
  const prepare = (event: Event) => { const detail = (event as CustomEvent<AgentPrepareDetail>).detail; if (detail.phaseId === phaseId) detail.waitUntil(refreshBlocked.current ? Promise.reject(new Error('Refresh the applied workspace before starting another proposal.')) : flushSave()); };
  const lock = (event: Event) => { const detail = (event as CustomEvent<{ phaseId: string; busy: boolean }>).detail; if (detail.phaseId === phaseId) setBusy(detail.busy); };
  const applied = (event: Event) => {
   const detail = (event as CustomEvent<AgentAppliedDetail>).detail;
   if (detail.phaseId !== phaseId) return;
   refreshBlocked.current = true; setNeedsRefresh(true);
   detail.waitUntil(Promise.resolve().then(() => refreshWorkspace(detail.workspace)).then(() => {
    if (currentPhase.current === phaseId) { refreshBlocked.current = false; setNeedsRefresh(false); }
   }));
  };
  window.addEventListener(AGENT_PREPARE, prepare); window.addEventListener(AGENT_BUSY, lock); window.addEventListener(AGENT_APPLIED, applied);
  return () => { window.removeEventListener(AGENT_PREPARE, prepare); window.removeEventListener(AGENT_BUSY, lock); window.removeEventListener(AGENT_APPLIED, applied); };
 }, [phaseId, flushSave, refreshWorkspace]);
 return busy || needsRefresh;
}
export async function prepareAgentOperation(phaseId: string) {
 const pending: Promise<unknown>[] = [];
 window.dispatchEvent(new CustomEvent<AgentPrepareDetail>(AGENT_PREPARE, { detail: { phaseId, waitUntil: work => pending.push(work) } }));
 await Promise.all(pending);
}

/** Refresh the saved revision in place. Failure must not reapply the proposal. */
export async function refreshAgentWorkspace(phaseId: string, workspace?: Record<string, string>) {
 const pending: Promise<unknown>[] = [];
 window.dispatchEvent(new CustomEvent<AgentAppliedDetail>(AGENT_APPLIED, { detail: { phaseId, workspace, waitUntil: work => pending.push(work) } }));
 if (!pending.length) throw new Error('Open the project workspace to load the applied changes.');
 await Promise.all(pending);
}
