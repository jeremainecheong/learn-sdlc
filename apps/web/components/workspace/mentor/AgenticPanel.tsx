'use client';
import { namedNotHeld, namedNotHeldLine } from './namedNotHeld';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CHANGE_REQUEST_JSON, RUNBOOK_JSON, STORY_JSON, type PhaseKey } from '@learnsdlc/shared';
import { agentApi, type AgentProposal, type AgentTurn } from '@/lib/api-mentor';
import { ApiError, api, describeError } from '@/lib/api';
import { getSession, useSession } from '@/lib/session';
import { useProjectMaybe } from '@/lib/useProject';
import { AGENT_BUSY, prepareAgentOperation, refreshAgentWorkspace } from './useAgentWorkspace';
import { useRoomUnsaved } from './roomUnsaved';
import { Button } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { DeferredMarkdown } from '@/components/DeferredMarkdown';
import { elapsedWords, useElapsedMs } from '@/components/workspace/ReviewSteps';
import { PHASE_EXPERIENCE } from '@/components/phases/experience';
import { ProposalComparison } from './ProposalComparison';
import { ExplanationFindings } from './ExplanationFindings';
import { PROPOSAL_SUMMARY_CHECK, ProposalCompare } from './ProposalCompare';
import { storyProposalPending, useStoryComparison } from './useStoryComparison';
import { designProposalPending, isDesignProposal, savedDesignOf, useDesignComparison } from './useDesignComparison';
import { isRecordProposal, recordProposalPending, savedTextOf, useRecordComparison } from './useRecordComparison';
import { readRunbookTouched, recordRunbookTouched, touchedRunbook } from '@/components/workspace/panels/deployment/runbook-edit';
import { StructuredProposalSummary } from './StructuredProposalSummary';
import { changedPaths } from '@/components/workspace/panels/requirements/storyChanges';
import { readStoryRecord } from '@/components/workspace/panels/requirements/useStory';
import { recordAppliedDesign, recordTouched } from '@/components/workspace/panels/requirements/touched';
import { recordAppliedChange } from '@/components/workspace/panels/maintenance/change-edit';
import { InventoryList } from './InventoryList';
import { summaryBesideList } from './proposalFilesSentence';
import { asksForPathNotHeld, inventoryCount, inventoryNoun, missingAsked, proposalInventory, proposalKind, readExplainDraft, readReceipt, writeExplainDraft, writeReceipt, type DifferingFile, type InventoryLine } from './proposalInventory';
import { MAX_REQUEST_CHARS } from './proposalChange';
import { failureLine, waitLine, waitStepName, type DisplayTurn } from './agenticCopy';
import './AgenticPanel.css';

type ExplanationTarget = { id: string; hash: string };
/** How long a pending turn waits before the panel asks the server how it stands. */
const RECONCILE_POLL_MS = 3_000;
/** Within this many px of the transcript's foot, the learner is reading the newest turn. */
const NEAR_BOTTOM_PX = 100;
/** The gap left above a proposal card brought to the top of the transcript. */
const CARD_TOP_OFFSET_PX = 8;
const scopeOf = (target: ExplanationTarget | null) => target ? `explain:${target.id}:${target.hash}` : 'chat';
const turnScope = (turn: AgentTurn) => turn.kind === 'explain' ? `explain:${turn.parentProposalId}:${turn.parentProposalHash}` : 'chat';
const chronological = (rows: DisplayTurn[]) => [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
/**
 * A pending turn's `stage` is the server's best effort and is held in memory, so
 * a later answer for the same request can carry none: which means "nothing to
 * report", never "that step stopped". Keep a stage the same pending request has
 * already reported, so its wait sentence only ever moves forward and is never
 * announced a second time. A settled row keeps nothing: it shows no wait at all.
 */
const replaceTurn = (rows: DisplayTurn[], turn: DisplayTurn) => {
  const held = rows.find(row => row.requestId === turn.requestId);
  const next = held?.stage && !turn.stage && turn.status === 'pending' ? { ...turn, stage: held.stage } : turn;
  return chronological([...rows.filter(row => row.requestId !== turn.requestId), next]);
};
const legacyRequestText = (prompt: string) => {
  if (prompt.length > MAX_REQUEST_CHARS) return null;
  try { const value: unknown = JSON.parse(prompt); if (value && typeof value === 'object') return null; } catch { /* Legacy requests are plain text. */ }
  return prompt;
};
const revoke = (proposal: AgentProposal): AgentProposal => proposal.appliedAt ? proposal : { ...proposal, approvedAt: null, explanationAssessment: null };
function WaitStep({ turn }: { turn: DisplayTurn }) {
  const elapsedMs = useElapsedMs(turn.createdAt);
  return <p className="agentic-wait-step" data-testid="agentic-wait-step"><span data-testid="agentic-wait-step-name">{waitStepName(turn)}</span>{elapsedMs !== null && <span className="agentic-wait-elapsed" data-testid="agentic-wait-elapsed">{elapsedWords(elapsedMs)}</span>}</p>;
}

/**
 * One phase conversation. Server turns are authoritative; understanding and Apply remain explicit.
 *
 * `onProposalOpen`: told, once this phase's conversation has loaded and again whenever it changes, whether the
 * proposal the panel shows is open (not applied). The mentor keeps it for the phase's next page (`mentorMode.ts`).
 */
export function AgenticPanel({ phaseId, phaseKey = 'implementation', onBusyChange, onProposalOpen }: { phaseId?: string; phaseKey?: PhaseKey; onBusyChange?: (busy: boolean) => void; onProposalOpen?: (open: boolean) => void }) {
  const session = useSession();
  const owner = `${session?.id ?? 'signed-out'}:${phaseId ?? ''}`;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [stateOwner, setStateOwner] = useState(owner);
  const [turns, setTurns] = useState<DisplayTurn[]>([]);
  const [proposals, setProposals] = useState<AgentProposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fileDrafts, setFileDrafts] = useState<Record<string, Record<string, string>>>({});
  const [target, setTarget] = useState<ExplanationTarget | null>(null);
  const [parentTurnId, setParentTurnId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshPending, setRefreshPending] = useState(false);
  const [workspaceHash, setWorkspaceHash] = useState<string | null>(null);
  const appliedWorkspace = useRef<Record<string, string> | undefined>(undefined);
  const [newReplies, setNewReplies] = useState(false);
  // The file a changed inventory line opens the comparison at, the counts kept when a proposal
  // was applied, and the files beside the record a comparison found differing (kept after it closes).
  const [compareFocus, setCompareFocus] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, InventoryLine[]>>({});
  const [seenOthers, setSeenOthers] = useState<{ key: string; others: DifferingFile[] } | null>(null);
  const serial = useRef(0);
  const lock = useRef(false);
  const alive = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const review = useRef<HTMLElement>(null);
  const nearBottom = useRef(true);
  // The explanation turns this mount has seen refused, by request id.
  const refusedHere = useRef(new Set<string>());
  const mentor = PHASE_EXPERIENCE[phaseKey].name;
  const proposal = proposals.find(row => row.id === selectedId) ?? null;
  const proposalKey = proposal ? `${proposal.id}:${proposal.proposalHash}` : '';
  const edits = fileDrafts[proposalKey] ?? {};
  const hasEdits = Object.keys(edits).length > 0;
  const scope = scopeOf(target);
  const draft = drafts[scope] ?? '';
  const pending = turns.find(row => row.status === 'pending' || row.localState === 'unconfirmed');
  const operationBusy = busy || Boolean(pending);
  const explanationDraft = proposal ? drafts[scopeOf({ id: proposal.id, hash: proposal.proposalHash })] ?? '' : '';
  // A record proposal's Apply waits while the room's forms hold an unsaved edit.
  const roomUnsaved = useRoomUnsaved(phaseId);
  const recordWaits = roomUnsaved && Boolean(proposal && isRecordProposal(proposal));
  const approved = Boolean(proposal?.assessment.adequate && proposal.approvedAt && proposal.explanationAssessment?.adequate && !proposal.appliedAt && !hasEdits && !explanationDraft.trim() && !operationBusy && !refreshPending && !recordWaits);
  // The overlay is offered only for a story, a record (runbook or change request) or a design proposal still to be decided on.
  // The record is asked before the design: a change request's proposal may also touch the API contract file,
  // and a record proposal, runbook or change request, is never drawn in the design comparison.
  const pendingStory = storyProposalPending(proposal, proposals, workspaceHash);
  const pendingRecord = !pendingStory && recordProposalPending(proposal, proposals, workspaceHash);
  const pendingDesign = !pendingStory && !pendingRecord && !(proposal && isRecordProposal(proposal)) && designProposalPending(proposal, proposals, workspaceHash);
  const pendingCompare = pendingStory || pendingRecord || pendingDesign;

  const valid = (expectedOwner: string, expectedSerial: number) => alive.current && ownerRef.current === expectedOwner && serial.current === expectedSerial && `${getSession()?.id ?? 'signed-out'}:${phaseId ?? ''}` === expectedOwner;
  const remember = (next: AgentProposal) => {
    if (next.phaseStateId !== phaseId) return;
    setProposals(rows => [next, ...rows.filter(row => row.id !== next.id)]);
  };
  const stories = useStoryComparison({
    phaseId, proposal, pending: pendingStory, onFresh: remember,
    guard: () => { const expectedOwner = owner; const generation = serial.current; return () => valid(expectedOwner, generation); },
  });
  const designs = useDesignComparison({
    phaseId, proposal, pending: pendingDesign, onFresh: remember,
    guard: () => { const expectedOwner = owner; const generation = serial.current; return () => valid(expectedOwner, generation); },
  });
  const records = useRecordComparison({
    phaseId, proposal, pending: pendingRecord, onFresh: remember,
    guard: () => { const expectedOwner = owner; const generation = serial.current; return () => valid(expectedOwner, generation); },
  });
  const compareOpen = Boolean(stories.comparison || designs.comparison || records.comparison);
  const openedOthers = stories.comparison ? { key: stories.comparison.key, others: stories.comparison.otherFiles } : records.comparison ? { key: records.comparison.key, others: records.comparison.files } : null;
  useEffect(() => { if (openedOthers) setSeenOthers(openedOthers); }, [openedOthers?.key, openedOthers?.others]); // eslint-disable-line react-hooks/exhaustive-deps
  // The learner's unsent explanation of the selected proposal is kept in this tab's storage, so it
  // survives a reload as it survives closing the overlay; it is put back only into an empty draft, and only
  // ever the learner's own typing is kept or put back. Sending, discarding or applying removes it.
  const explainScope = proposal ? scopeOf({ id: proposal.id, hash: proposal.proposalHash }) : '';
  const explainHeld = proposal ? drafts[explainScope] : undefined;
  useEffect(() => {
    if (!proposal || proposal.appliedAt || stateOwner !== owner) return;
    const kept = readExplainDraft(owner, proposal.id);
    if (kept) setDrafts(rows => rows[explainScope] === undefined ? { ...rows, [explainScope]: kept } : rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, stateOwner, proposal?.id, proposal?.proposalHash, proposal?.appliedAt]);
  useEffect(() => {
    if (!proposal || explainHeld === undefined || stateOwner !== owner) return;
    writeExplainDraft(owner, proposal.id, explainHeld);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, stateOwner, proposal?.id, explainHeld]);
  const comparer = pendingRecord ? records : pendingDesign ? designs : stories;
  const closeCompare = () => { stories.close(); designs.close(); records.close(); };
  // When the overlay closes because its proposal stopped being pending (an
  // Apply), nothing it can hand focus back to is left: focus the card instead
  // of letting it fall to the page.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !compareOpen && (!document.activeElement || document.activeElement === document.body)) review.current?.focus({ preventScroll: true });
    wasOpen.current = compareOpen;
  }, [compareOpen]);
  const restoreDraft = (turn: AgentTurn) => setDrafts(current => {
    const key = turnScope(turn);
    return current[key] ? current : { ...current, [key]: turn.message };
  });
  const receive = async (turn: AgentTurn, current: () => boolean) => {
    if (!current() || turn.phaseStateId !== phaseId) return;
    setTurns(rows => replaceTurn(rows, turn));
    if (turn.proposalId || turn.response?.proposal || turn.kind === 'explain' && turn.parentProposalId) {
      const id = turn.proposalId ?? turn.response?.proposal?.id ?? turn.parentProposalId!;
      // Conversation snapshots describe past events. Only an authoritative
      // current proposal can expose approval or editable bytes.
      try {
        const next = await agentApi.proposal(phaseId!, id);
        if (next.id !== id || next.phaseStateId !== phaseId) throw new Error('The returned proposal belongs to a different selection.');
        if (current()) {
          remember(turn.kind === 'explain' && turn.status === 'failed' ? revoke(next) : next); setSelectedId(next.id);
          if (turn.kind === 'explain' && turn.status === 'completed' && !next.explanationAssessment?.adequate) refusedHere.current.add(turn.requestId);
          // An accepted explanation ends the explaining: the composer goes back to the conversation.
          if (turn.kind === 'explain' && turn.status === 'completed' && next.explanationAssessment?.adequate && next.approvedAt && !next.appliedAt) setTarget(null);
          // A proposal the conversation has just produced was made against the
          // saved workspace as it is now, which may have moved since history loaded.
          if (turn.kind === 'chat' && turn.response?.proposal?.id === next.id) setWorkspaceHash(next.baseWorkspaceHash);
        }
      } catch (err) {
        if (current()) {
          setProposals(rows => rows.map(row => row.id === id ? revoke(row) : row));
          setError(describeError(err, 'The message is saved, but the current proposal could not be loaded. Reload it before applying.'));
        }
      }
    }
    if (current() && turn.status === 'failed') restoreDraft(turn);
    // An explanation the review did not accept goes back into the box it was sent from (only an empty
    // box: newer typing is the learner's too), so it is edited rather than written again. An accepted one is not put
    // back: it is drawn read-only, and a kept draft would hold Apply.
    if (current() && turn.kind === 'explain' && turn.status === 'completed' && refusedHere.current.has(turn.requestId)) restoreDraft(turn);
    if (current() && turn.status === 'completed') setParentTurnId(turn.id);
  };
  const scrollNewest = () => {
    nearBottom.current = true;
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'auto' });
    setNewReplies(false);
  };

  const loadHistory = async (expectedOwner = owner, expectedSerial = serial.current) => {
    if (!phaseId) { setLoading(false); return; }
    setLoading(true);
    setHistoryError('');
    try {
      const [saved, page] = await Promise.all([agentApi.list(phaseId), agentApi.turns(phaseId)]);
      if (!valid(expectedOwner, expectedSerial)) return;
      setProposals(saved);
      setTurns(chronological(page.items));
      setCursor(page.nextCursor);
      setWorkspaceHash(page.currentWorkspaceHash ?? null);
      setSelectedId(saved.find(row => !page.currentWorkspaceHash || row.appliedAt || row.baseWorkspaceHash === page.currentWorkspaceHash)?.id ?? null);
      const appliedAt = saved.reduce((last, row) => row.appliedAt && row.appliedAt > last ? row.appliedAt : last, '');
      // Applied proposals can fall outside the newest-30 list. Keep their old
      // turns visible, but continue only the server's current workspace bytes.
      setParentTurnId(chronological(page.items).filter(row => row.status === 'completed' && row.createdAt > appliedAt &&
        (!page.currentWorkspaceHash || row.baseWorkspaceHash === page.currentWorkspaceHash)).at(-1)?.id ?? null);
      setLoading(false);
    } catch (err) {
      if (valid(expectedOwner, expectedSerial)) { setLoading(false); setHistoryError(describeError(err, 'The conversation could not be loaded. Retry loading it before sending.')); }
    }
  };
  useEffect(() => {
    alive.current = true;
    const generation = ++serial.current;
    lock.current = false;
    setStateOwner(owner); setTurns([]); setProposals([]); setSelectedId(null); setDrafts({}); setFileDrafts({}); setTarget(null); setParentTurnId(null);
    setCompareFocus(null); setReceipts({}); setSeenOthers(null);
    setCursor(null); setLoading(true); setBusy(false); setHistoryError(''); setError(''); setNotice(''); setRefreshPending(false); setNewReplies(false); appliedWorkspace.current = undefined;
    setWorkspaceHash(null); stories.reset(); designs.reset(); records.reset();
    nearBottom.current = true;
    void loadHistory(owner, generation);
    return () => { alive.current = false; serial.current++; };
    // Each identity owns its request callbacks and private drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  // Said only for this identity's loaded conversation: before the load (or after one that failed) the panel knows nothing.
  const proposalOpen = Boolean(proposal && !proposal.appliedAt);
  const loadedHere = stateOwner === owner && !loading && !historyError;
  useEffect(() => {
    if (loadedHere) onProposalOpen?.(proposalOpen);
  }, [loadedHere, proposalOpen, onProposalOpen]);
  useEffect(() => {
    onBusyChange?.(stateOwner === owner && operationBusy);
    return () => onBusyChange?.(false);
  }, [onBusyChange, operationBusy, owner, stateOwner]);
  useEffect(() => {
    if (!phaseId) return;
    window.dispatchEvent(new CustomEvent(AGENT_BUSY, { detail: { phaseId, busy: operationBusy } }));
    return () => { window.dispatchEvent(new CustomEvent(AGENT_BUSY, { detail: { phaseId, busy: false } })); };
  }, [phaseId, operationBusy]);
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    if (nearBottom.current) element.scrollTop = element.scrollHeight;
    else setNewReplies(true);
  }, [turns, notice]);
  useEffect(() => {
    const element = log.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (nearBottom.current) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [turns, proposalKey, notice]);
  /*
   * A proposal card that has just come into the log opens at its heading. Following the newest entry
   * puts the log's bottom in view, so a card taller than the log opened scrolled to its foot, its heading and summary
   * cut under the mode switch. Once per card (by id and version), and only where its top would be out of view: the
   * log is scrolled to the card's top, and stops following the newest entry if that leaves the bottom out of view
   * ("Latest messages" then says there is more below). A card that fits is left where it is.
   */
  const cardOpened = useRef('');
  useEffect(() => {
    const element = log.current;
    const card = review.current;
    if (!element || !card || !proposalKey || proposal?.appliedAt || cardOpened.current === proposalKey) return;
    cardOpened.current = proposalKey;
    const above = card.getBoundingClientRect().top - element.getBoundingClientRect().top;
    if (above >= 0) return;
    element.scrollTop = Math.max(0, element.scrollTop + above - CARD_TOP_OFFSET_PX);
    nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (!nearBottom.current) setNewReplies(true);
  }, [proposalKey, proposal?.appliedAt, turns]);

  const reconcile = async (turn: DisplayTurn) => {
    if (!phaseId || lock.current) return;
    const expectedOwner = owner; const generation = serial.current;
    lock.current = true; setBusy(true);
    try {
      const saved = await agentApi.turn(phaseId, turn.requestId);
      if (valid(expectedOwner, generation)) await receive(saved, () => valid(expectedOwner, generation));
    } catch (err) {
      if (valid(expectedOwner, generation)) setTurns(rows => replaceTurn(rows, { ...turn, localState: 'unconfirmed', deliveryMissing: err instanceof ApiError && err.status === 404, localError: err instanceof ApiError && err.status === 404 ? 'No saved message was found. You can retry delivery with the same request identifier.' : describeError(err, 'Delivery could not be confirmed. Check the saved message status before sending again.') }));
    } finally { if (valid(expectedOwner, generation)) { lock.current = false; setBusy(false); } }
  };
  useEffect(() => {
    if (!pending || pending.localState || busy) return;
    const timer = window.setTimeout(() => void reconcile(pending), RECONCILE_POLL_MS);
    return () => window.clearTimeout(timer);
    // Poll the exact request ID; never repeat an AI mutation in the background.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.requestId, pending?.updatedAt, pending?.localState, busy, owner]);

  const run = async (work: (current: () => boolean) => Promise<void>, prepare = true) => {
    if (!phaseId || lock.current || pending || refreshPending) return;
    const expectedOwner = owner; const generation = serial.current;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    const current = () => valid(expectedOwner, generation);
    try { if (prepare) await prepareAgentOperation(phaseId); if (current()) await work(current); }
    catch (err) { if (current()) setError(describeError(err, 'This action could not be completed.')); }
    finally { if (current()) { lock.current = false; setBusy(false); } }
  };
  /** `explaining`: send that proposal's explanation draft, as the overlay's Explain does, whatever the composer is set to. */
  const send = async (retry?: DisplayTurn, explaining?: ExplanationTarget) => {
    const text = (retry?.message ?? (explaining ? drafts[scopeOf(explaining)] ?? '' : draft)).trim();
    if (!phaseId || !text || loading || historyError || operationBusy || lock.current || refreshPending) return;
    const sendingTarget = retry?.kind === 'explain' ? { id: retry.parentProposalId!, hash: retry.parentProposalHash! } : retry ? null : explaining ?? target;
    const selected = sendingTarget ? proposals.find(row => row.id === sendingTarget.id && row.proposalHash === sendingTarget.hash) : retry ? proposals.find(row => row.id === retry.parentProposalId && row.proposalHash === retry.parentProposalHash) ?? null : proposal?.appliedAt ? null : proposal;
    if (retry?.parentProposalId && !selected) { setError('This proposal has changed. Review its current files and send a new message instead of retrying the old context.'); return; }
    if (selected && Object.keys(fileDrafts[`${selected.id}:${selected.proposalHash}`] ?? {}).length) { setError('Save the changed proposal before discussing or explaining this version. Your message is kept.'); return; }
    if (sendingTarget && (!selected || !selected.assessment.adequate || hasEdits || selected.appliedAt)) { setError('Review the current saved proposal before explaining it.'); return; }
    const requestId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const parent = retry ? retry.parentTurnId : parentTurnId;
    const optimistic: DisplayTurn = {
      id: requestId, phaseStateId: phaseId, requestId, kind: sendingTarget ? 'explain' : 'chat', status: 'pending', message: text,
      parentTurnId: parent, parentProposalId: selected?.id ?? null, parentProposalHash: selected?.proposalHash ?? null,
      baseWorkspaceHash: selected?.baseWorkspaceHash ?? '', proposalId: null, response: null, errorCode: null, createdAt, updatedAt: createdAt, localState: 'sending',
    };
    const sentScope = scopeOf(sendingTarget);
    // Clear only the sent draft; a retry never replaces a newer question.
    setDrafts(current => ({ ...current, [sentScope]: retry && current[sentScope]?.trim() !== text ? current[sentScope] : '' }));
    // The emptied box shows its placeholder from the first line, not scrolled to where the sent text ended.
    requestAnimationFrame(() => { if (composer.current && !composer.current.value) composer.current.scrollTop = 0; });
    setTurns(rows => replaceTurn(rows, optimistic));
    nearBottom.current = true;
    if (sendingTarget && selected) remember(revoke(selected));
    // While the overlay is open (its Explain, or a Retry from its footer) the
    // composer is behind a modal and inert, so focus is left to the overlay.
    if (!explaining && !compareOpen) composer.current?.focus({ preventScroll: true });
    await run(async current => {
      try { await prepareAgentOperation(phaseId); }
      catch (err) {
        if (current()) {
          setTurns(rows => replaceTurn(rows, { ...optimistic, status: 'failed', localState: undefined, errorCode: 'WORKSPACE_NOT_SAVED', localError: describeError(err, 'Save the workspace before sending this message.') }));
          restoreDraft(optimistic);
        }
        return;
      }
      if (!current()) return;
      try {
        const saved = sendingTarget && selected
          ? await agentApi.explainTurn(phaseId, selected, text, requestId, parent ?? undefined)
          : await agentApi.chat(phaseId, { requestId, message: text, ...(parent ? { parentTurnId: parent } : {}), ...(selected ? { proposalId: selected.id, proposalHash: selected.proposalHash } : {}) });
        if (current()) await receive(saved, current);
      } catch (err) {
        if (!current()) return;
        // The response may have been lost after persistence. Reconcile by ID,
        // without automatically creating another paid request.
        try {
          const saved = await agentApi.turn(phaseId, requestId);
          if (current()) await receive(saved, current);
        } catch (lookupError) {
          if (current()) {
            const rejected = lookupError instanceof ApiError && lookupError.status === 404 && err instanceof ApiError && err.status >= 400 && err.status < 500;
            const notRetryable = rejected && err instanceof ApiError && (err.body as { retryable?: unknown } | undefined)?.retryable === false;
            setTurns(rows => replaceTurn(rows, { ...optimistic, status: rejected ? 'failed' : 'pending', localState: rejected ? undefined : 'unconfirmed', errorCode: rejected ? 'REQUEST_REJECTED' : null, notRetryable, deliveryMissing: !rejected && lookupError instanceof ApiError && lookupError.status === 404, localError: describeError(err, 'Delivery could not be confirmed. Check the saved message status.') }));
            restoreDraft(optimistic);
          }
        }
      }
    }, false);
  };
  const retryDelivery = async (turn: DisplayTurn) => {
    if (!phaseId || lock.current || !turn.deliveryMissing) return;
    const expectedOwner = owner; const generation = serial.current;
    const current = () => valid(expectedOwner, generation);
    lock.current = true; setBusy(true);
    try {
      // A confirmed absent row can be created with its ORIGINAL identifier.
      // A delayed original claim will therefore be reused, never duplicated.
      const saved = turn.kind === 'explain' && turn.parentProposalId && turn.parentProposalHash
        ? await agentApi.explainTurn(phaseId, { id: turn.parentProposalId, proposalHash: turn.parentProposalHash }, turn.message, turn.requestId, turn.parentTurnId ?? undefined)
        : await agentApi.chat(phaseId, { requestId: turn.requestId, message: turn.message, ...(turn.parentTurnId ? { parentTurnId: turn.parentTurnId } : {}), ...(turn.parentProposalId && turn.parentProposalHash ? { proposalId: turn.parentProposalId, proposalHash: turn.parentProposalHash } : {}) });
      if (current()) await receive(saved, current);
    } catch (err) {
      if (current()) setTurns(rows => replaceTurn(rows, { ...turn, localError: describeError(err, 'Delivery is still unconfirmed. Check the saved status before trying again.'), deliveryMissing: false }));
    } finally { if (current()) { lock.current = false; setBusy(false); } }
  };
  const refreshApplied = async () => {
    if (!phaseId || lock.current) return;
    const expectedOwner = owner; const generation = serial.current;
    lock.current = true; setBusy(true); setRefreshPending(true);
    try {
      await refreshAgentWorkspace(phaseId, appliedWorkspace.current);
      if (valid(expectedOwner, generation)) { appliedWorkspace.current = undefined; setRefreshPending(false); setError(''); nearBottom.current = true; setNotice('Proposal applied. Your saved workspace is up to date.'); }
    } catch {
      if (valid(expectedOwner, generation)) setError('Your proposal was saved, but the workspace could not refresh. Retry loading it before editing; the proposal will not be applied again.');
    } finally { if (valid(expectedOwner, generation)) { lock.current = false; setBusy(false); } }
  };
  const apply = async () => {
    if (!proposal || !approved || !phaseId) return;
    // A room record's proposal (runbook or change request) is tested before the design: a change-request
    // proposal may also edit shared/contract/api.json, which would read as a design proposal, and its marks
    // belong to its room. The saved record its changes are numbered by is read with the record comparison
    // the Apply comes from, when that comparison is of the same record, or else read now, before the Apply moves it.
    const savedRecord = (label: 'Runbook' | 'Change request', path: string) =>
      records.comparison?.label === label && records.comparison.saved !== undefined
        ? Promise.resolve(records.comparison.saved)
        : api.phase(phaseId).then((detail) => savedTextOf(detail, path), () => undefined);
    const runbook = Boolean(proposal.changes) && proposal.files[RUNBOOK_JSON] !== undefined;
    const changeRecord = Boolean(proposal.changes) && proposal.files[CHANGE_REQUEST_JSON] !== undefined;
    const savedRunbook = runbook ? await savedRecord('Runbook', RUNBOOK_JSON) : undefined;
    const savedChange = changeRecord ? await savedRecord('Change request', CHANGE_REQUEST_JSON) : undefined;
    // The saved documents a design proposal's changes are numbered by: read with the comparison the Apply comes from,
    // or, for a proposal applied from its card (superseded, or made against older work), read now.
    const design = !isRecordProposal(proposal) && isDesignProposal(proposal);
    const savedDesign = design ? designs.comparison?.saved ?? await api.phase(phaseId).then(savedDesignOf, () => undefined) : undefined;
    // What Apply changes, counted now, before the saved documents hold the proposal and its `changes` read empty.
    const appliedLines = inventory.filter(line => line.status !== 'missing');
    await run(async current => {
      const result = await agentApi.apply(phaseId, proposal);
      if (!current()) return;
      if (appliedLines.length) { writeReceipt(phaseId, proposal.id, appliedLines); setReceipts(rows => ({ ...rows, [proposal.id]: appliedLines })); }
      writeExplainDraft(owner, proposal.id, '');
      // The story form marks the fields the assistant wrote while they still hold its text.
      if (proposal.changes && proposal.files[STORY_JSON] !== undefined) recordTouched(phaseId, changedPaths(proposal.changes), readStoryRecord(proposal.files[STORY_JSON]));
      // The Runbook tab marks the fields it wrote, by item id, with the text the applied record holds there (before Design's test).
      // A later Apply adds its marks to the earlier ones, as the change room's do; the Runbook tab draws only the marks whose field still holds the assistant's text.
      else if (proposal.changes && runbook) recordRunbookTouched(phaseId, { ...readRunbookTouched(phaseId), ...touchedRunbook(savedRunbook, proposal.changes, result.workspace?.[RUNBOOK_JSON] ?? proposal.files[RUNBOOK_JSON]) });
      // The change room marks them too, by item id, while each field holds the applied text (before Design's test).
      else if (changeRecord && proposal.changes) recordAppliedChange(phaseId, proposal.changes, savedChange, result.workspace[CHANGE_REQUEST_JSON] ?? proposal.files[CHANGE_REQUEST_JSON]);
      // The Design room marks them too, each on its item (by id) in the applied documents.
      else if (proposal.changes && savedDesign) recordAppliedDesign(phaseId, proposal.changes, savedDesign, proposal.files, result.workspace);
      closeCompare();
      appliedWorkspace.current = result.workspace;
      // The applied notice is brought into view on every room. Compare (or an opened
      // saved-file comparison) stops the log following the newest entry; an Apply is a new entry the learner made, so
      // the log follows it again and the notice is scrolled to, rather than waiting behind "Latest messages".
      nearBottom.current = true; setNewReplies(false);
      remember(result.proposal); setParentTurnId(null); setTarget(null); setNotice('Proposal applied. Loading the saved workspace…'); setRefreshPending(true);
      try { await refreshAgentWorkspace(phaseId, result.workspace); if (current()) { appliedWorkspace.current = undefined; setRefreshPending(false); nearBottom.current = true; setNotice('Proposal applied. Your saved workspace is up to date.'); } }
      catch { if (current()) setError('Your proposal was saved, but the workspace could not refresh. Retry loading it before editing; the proposal will not be applied again.'); }
    });
  };
  const newRequest = () => {
    if (operationBusy || refreshPending) return;
    setParentTurnId(null); setSelectedId(null); setTarget(null); setError('');
    setNotice('Your next message will use the current saved workspace.');
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
  };
  /**
   * Set a story proposal aside without applying it. Nothing is deleted: it
   * stays under Saved proposals, and the next message uses the current saved
   * workspace, as New request does.
   */
  const discardProposal = () => {
    if (operationBusy || refreshPending) return;
    closeCompare(); setParentTurnId(null); setSelectedId(null); setTarget(null); setError('');
    setNotice('The proposal is set aside. Nothing in your workspace changed, and your next message will use the current saved workspace.');
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
  };
  const selectProposal = (next: AgentProposal) => {
    if (operationBusy || !phaseId) return;
    setSelectedId(next.id); setTarget(null); setError('');
    remember(revoke(next));
    void run(async current => {
      const saved = await agentApi.proposal(phaseId, next.id);
      if (saved.id !== next.id || saved.phaseStateId !== phaseId) throw new Error('The returned proposal belongs to a different selection.');
      if (!current()) return;
      remember(saved);
      requestAnimationFrame(() => { if (current()) review.current?.scrollIntoView({ block: 'nearest' }); });
    }, false);
  };
  const explainProposal = () => {
    if (!proposal || !proposal.assessment.adequate || operationBusy || hasEdits || proposal.appliedAt) return;
    setTarget({ id: proposal.id, hash: proposal.proposalHash });
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
  };
  const saveFiles = () => {
    if (!proposal || !phaseId || !hasEdits) return;
    const selected = proposal;
    void run(async current => {
      const next = await agentApi.edit(phaseId, selected, { ...selected.files, ...edits });
      if (!current()) return;
      remember(next); setFileDrafts(rows => { const kept = { ...rows }; delete kept[proposalKey]; return kept; }); setTarget(null);
      setNotice('The changed proposal is saved. Explain this version before applying it.');
    });
  };
  const loadOlder = () => {
    if (!phaseId || !cursor || busy) return;
    const before = log.current?.scrollHeight ?? 0;
    void run(async current => {
      const page = await agentApi.turns(phaseId, cursor);
      if (!current()) return;
      nearBottom.current = false;
      setTurns(rows => page.items.reduce(replaceTurn, rows)); setCursor(page.nextCursor);
      requestAnimationFrame(() => { if (log.current) log.current.scrollTop += log.current.scrollHeight - before; });
    }, false);
  };

  // A discussion can reference a proposal without being a new review event.
  // Keep its current review beside the last proposal/explanation, so a later
  // answer stays at the end of the chronological conversation.
  const reviewTurn = proposal ? [...turns].reverse().find(turn =>
    (turn.response?.kind === 'proposal' || turn.response?.kind === 'explanation') &&
    (turn.proposalId ?? turn.response.proposal?.id ?? turn.parentProposalId) === proposal.id) : undefined;
  const originalRequest = proposal && !reviewTurn ? legacyRequestText(proposal.prompt) : null;
  // The learner's own words for the turn that produced this proposal. The
  // stored prompt is a JSON context envelope on the chat path, so it is read
  // only on the legacy plain-text path and never quoted as a request otherwise.
  //
  // Held against the conversation rather than rebuilt: this panel re-renders on
  // every keystroke in the composer and in every proposed-file textarea, and
  // copying and reversing the whole turn list is work the answer never changes
  // for. It moves only when the conversation or the selected proposal does.
  const proposalRequest = useMemo(
    () => proposal
      ? [...turns].reverse().find(turn => turn.response?.kind === 'proposal' && (turn.proposalId ?? turn.response.proposal?.id) === proposal.id)?.message ?? legacyRequestText(proposal.prompt)
      : null,
    [proposal, turns],
  );
  // One line per file the proposal holds, counted from its `changes` and, for a file beside the
  // record, from the comparison once it has read the saved copy; and the count beside the card's heading.
  const structured = Boolean(proposal?.changes) && proposalKind(proposal?.files ?? {}, proposal?.changes) !== 'files';
  const others = openedOthers?.key === proposalKey ? openedOthers.others : seenOthers?.key === proposalKey ? seenOthers.others : null;
  // The phase's editable paths, read at most once per pending proposal (one GET of the phase's summary
  // view, no file bodies, no AI call, after the card first draws), and only when the request asks for a path
  // the proposal does not hold (`asksForPathNotHeld`, the same rule that decides each "asked for" line). If
  // the read fails the card says only what it holds, with no retry.
  const [workspacePaths, setWorkspacePaths] = useState<{ key: string; paths: string[] } | null>(null);
  const pathsKey = `${owner}:${proposalKey}`;
  const pathsWanted = Boolean(phaseId && proposal && !proposal.appliedAt && asksForPathNotHeld(proposalRequest, Object.keys(proposal.files)));
  useEffect(() => {
    if (!pathsWanted || !phaseId || workspacePaths?.key === pathsKey) return;
    let live = true;
    api.phaseSummary(phaseId).then(detail => {
      if (live && detail.id === phaseId) setWorkspacePaths({ key: pathsKey, paths: detail.files.filter(file => file.editable).map(file => file.path) });
    }, () => { /* Without the list the card says only what it holds. */ });
    return () => { live = false; };
  }, [pathsWanted, phaseId, pathsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const workspace = workspacePaths?.key === pathsKey ? workspacePaths.paths : null;
  // The room already holds this phase's detail (the project context, keyed by the phase state id), so the
  // phase's editable paths are at hand without a read; the summary read above, when it answered, is fresher.
  const roomDetail = useProjectMaybe()?.details?.[phaseId ?? ''];
  const roomPaths = useMemo(() => roomDetail?.files.filter(file => file.editable).map(file => file.path) ?? null, [roomDetail]);
  // The editable files the learner's own request for this proposal names and the proposal does not change,
  // said in one line under the files list (literal matching, see namedNotHeld.ts). Nothing while the request
  // text or the phase's file list is not at hand, and nothing once the proposal is applied. A file the API's own
  // sentence in the summary already names is left to that sentence.
  const namedMissing = useMemo(
    () => proposal && !proposal.appliedAt ? namedNotHeld(proposalRequest, workspace ?? roomPaths, Object.keys(proposal.files), proposal.summary) : [],
    [proposal, proposalRequest, workspace, roomPaths],
  );
  const inventory = useMemo(
    () => proposal && structured ? proposalInventory({ files: proposal.files, changes: proposal.changes, others, request: proposalRequest, workspace }) : [],
    [proposal, structured, others, proposalRequest, workspace],
  );
  // A plain file proposal has no inventory; the files its request asked for and it lacks are still said.
  const askedMissing = useMemo(
    () => proposal && !structured && !proposal.appliedAt ? missingAsked(proposal.files, proposalRequest, workspace) : [],
    [proposal, structured, proposalRequest, workspace],
  );
  const receipt = useMemo(() => proposal ? receipts[proposal.id] ?? readReceipt(phaseId, proposal.id) : null, [phaseId, proposal, receipts]);
  const openCompareAt = (path: string | null) => { setCompareFocus(path); nearBottom.current = false; void comparer.open(); };
  // The explanation review, drawn on the card and again in the overlay's footer, where the four dimensions have
  // their own row above the explanation field in place of the cited-sentence list.
  const understandingOf = (findings: boolean) => proposal && <>
    {proposal.explanationAssessment && <div className="agentic-understanding"><strong>{approved || !!proposal.appliedAt ? 'Understanding accepted' : 'Explanation review'}</strong><p>{proposal.explanationAssessment.feedback}</p>{proposal.explanationAssessment.questions.map((question, index) => <p key={index}>{question}</p>)}{findings && <ExplanationFindings assessment={proposal.explanationAssessment} />}</div>}
    {!proposal.appliedAt && proposal.explanationAssessment?.adequate && !proposal.approvedAt && <p className="agentic-review-note">This saved version needs a new explanation before it can be applied.</p>}
  </>;
  const understanding = understandingOf(true);
  // A kept explanation draft is why an accepted version still cannot be applied.
  const draftKept = proposal && !proposal.appliedAt && explanationDraft.trim() && <p className="agentic-review-note">An explanation draft is kept. Send it, or <button type="button" className="underline" disabled={operationBusy} onClick={() => setDrafts(rows => ({ ...rows, [scopeOf({ id: proposal.id, hash: proposal.proposalHash })]: '' }))}>discard the explanation draft</button> before applying.</p>;
  // What a failed or unconfirmed turn offers, in the transcript and, for an explanation, in the overlay.
  // An explanation refused because the proposal moved is not offered a retry: it would re-send the old
  // hash, which the panel refuses; its line says to explain the current version.
  const recovery = (turn: DisplayTurn) => <>
    {!(turn.status === 'failed' && (turn.notRetryable || turn.kind === 'explain' && turn.errorCode === 'proposal_changed')) && <Button size="sm" variant="secondary" disabled={busy || turn.status === 'failed' && Boolean(pending)} onClick={() => turn.status === 'failed' ? void send(turn) : void reconcile(turn)}>{turn.status === 'failed' ? 'Retry this message' : 'Check message status'}</Button>}{turn.deliveryMissing && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void retryDelivery(turn)}>Retry delivery</Button>}
  </>;
  // The latest explanation of this exact version: its wait, or its failure, is
  // said in the overlay too. Held against the conversation like
  // `proposalRequest`, for the same reason: every keystroke re-renders here.
  const lastExplanation = useMemo(
    () => proposal ? [...turns].reverse().find(turn => turn.kind === 'explain' && turn.parentProposalId === proposal.id && turn.parentProposalHash === proposal.proposalHash) : undefined,
    [proposal, turns],
  );
  const explanationWaiting = Boolean(lastExplanation && (lastExplanation.localState === 'sending' || lastExplanation.status === 'pending' && !lastExplanation.localState));
  const explanationTrouble = Boolean(lastExplanation && (lastExplanation.status === 'failed' || lastExplanation.localState === 'unconfirmed'));
  const overlayDraftKept = Boolean(proposal?.approvedAt && draftKept);
  /*
   * This exact version's explanation is accepted, nothing in it was edited since and no
   * draft is kept. Then the learner's accepted words are shown read-only (the proposal's stored explanation, else
   * the turn that sent it), and nothing asks for an explanation again: no Explain button on the card or in Compare,
   * and no "Apply becomes available after your explanation is accepted." under the Apply it has made available.
   */
  const accepted = Boolean(proposal && !proposal.appliedAt && proposal.approvedAt && proposal.explanationAssessment?.adequate && !hasEdits && !explanationDraft.trim());
  const acceptedText = accepted && proposal ? (proposal.explanation ?? (lastExplanation?.status === 'completed' ? lastExplanation.message : '')) : null;
  const reviewShown = Boolean(proposal?.explanationAssessment);
  const comparison = stories.comparison;
  const designComparison = designs.comparison;
  const recordComparison = records.comparison;
  // One gate for either subject: the same explanation, review, Apply and feedback.
  const gate = proposal && {
    explanation: explanationDraft,
    onExplanationChange: (value: string) => setDrafts(rows => ({ ...rows, [scopeOf({ id: proposal.id, hash: proposal.proposalHash })]: value })),
    canExplain: proposal.assessment.adequate && !operationBusy && !hasEdits && !refreshPending && !loading && !historyError,
    onExplain: () => void send(undefined, { id: proposal.id, hash: proposal.proposalHash }),
    canApply: approved,
    onApply: () => void apply(),
    busy: operationBusy || refreshPending,
    feedback: recordWaits || explanationWaiting || explanationTrouble || error || overlayDraftKept || reviewShown ? <>
      {recordWaits && <p role="status" className="agentic-review-note" data-testid="agentic-record-waits-overlay">Apply waits until your last edit is saved.</p>}
      {explanationWaiting && lastExplanation && <><p role="status" className="agentic-review-note">{waitLine(lastExplanation, mentor)}</p><WaitStep turn={lastExplanation} /></>}
      {explanationTrouble && lastExplanation && <div role="alert" className="agentic-action-error"><p>{failureLine(lastExplanation)}</p>{recovery(lastExplanation)}</div>}
      {error && <p role="alert" className="agentic-action-error">{error}</p>}
      {understandingOf(false)}
      {overlayDraftKept && draftKept}
    </> : undefined,
    // A plain code card's lines are the files its request asked for and it lacks: whatever compares it says what the card says.
    inventory: structured ? inventory : askedMissing,
    requestNote: namedNotHeldLine(namedMissing, Boolean(pendingCompare)),
    held: Object.keys(proposal.files),
    focusPath: compareFocus,
    assessment: proposal.explanationAssessment ?? undefined,
    acceptedExplanation: acceptedText,
  };
  const overlay = compareOpen && proposal && gate && (recordComparison ? <ProposalCompare
    subject="record"
    open
    onClose={records.close}
    mentorName={mentor}
    label={recordComparison.label}
    changes={recordComparison.changes}
    carried={recordComparison.carried}
    files={recordComparison.files}
    saved={recordComparison.saved}
    summary={proposal.summary}
    {...gate}
  /> : designComparison ? <ProposalCompare
    subject="design"
    open
    onClose={designs.close}
    mentorName={mentor}
    documents={designComparison.documents}
    carried={designComparison.carried}
    summary={proposal.summary}
    {...gate}
  /> : comparison && <ProposalCompare
    open
    onClose={stories.close}
    mentorName={mentor}
    storyId={comparison.after.id || 'your story'}
    before={comparison.before}
    after={comparison.after}
    changes={proposal.changes ?? []}
    otherFiles={comparison.otherFiles}
    summary={proposal.summary}
    {...gate}
  />);
  // The card's own file list, headed "Files in this proposal": the API's file sentence over the same files is left
  // out of the summary above it (review 2, m-4), whether it is the whole summary or heads the API's sentence about a
  // file the answer named and the proposal does not change; the summary is drawn whole wherever that list is not.
  const inventoryShown = Boolean(proposal && !receipt && structured && !proposal.appliedAt && inventory.length > 0);
  const summaryText = !proposal?.summary ? '' : inventoryShown ? summaryBesideList(proposal.summary, Object.keys(proposal.files)) : proposal.summary;
  const summaryShown = Boolean(summaryText);
  const reviewCard = proposal && Object.keys(proposal.files).length > 0 && <section ref={review} tabIndex={-1} className="agentic-proposal-review" aria-label="Current proposal" data-testid="agentic-proposal" data-proposal-id={proposal.id} data-proposal-hash={proposal.proposalHash}>
        <header><strong>{proposal.appliedAt ? 'Applied proposal' : 'Proposed changes'}</strong><small data-testid="agentic-proposal-count">{receipt ? inventoryCount(receipt, inventoryNoun(receipt)) : structured && !proposal.appliedAt ? inventoryCount(inventory, inventoryNoun(inventory)) : `${Object.keys(proposal.files).length} ${proposal.changes ? (Object.keys(proposal.files).length === 1 ? 'document' : 'documents') : Object.keys(proposal.files).length === 1 ? 'file' : 'files'}${askedMissing.length ? `, ${askedMissing.length} missing` : ''}`}</small></header>
        {summaryShown && <div className="agentic-proposal-summary" data-testid="agentic-proposal-summary"><strong>What this proposal changes</strong><p>{summaryText}</p><small>{PROPOSAL_SUMMARY_CHECK}</small></div>}
        {originalRequest && <details className="agentic-request-context"><summary>Original request</summary><p>{originalRequest}</p></details>}
        {/* What the proposal holds, file by file; a changed line opens Compare at that file. Once applied, the counts as they were then. */}
        {receipt ? <div className="agentic-inventory"><strong>When you applied it</strong><InventoryList lines={receipt} withPath={false} applied testId="agentic-inventory" /></div>
          : inventoryShown && <div className="agentic-inventory"><strong>Files in this proposal</strong><InventoryList lines={inventory} withPath={false} onOpen={pendingCompare ? path => openCompareAt(path) : undefined} disabled={comparer.comparing} testId="agentic-inventory" /></div>}
        {pendingCompare && namedMissing.length > 0 && <p className="agentic-review-note" data-testid="agentic-named-not-held">{namedNotHeldLine(namedMissing, true)}</p>}
        {pendingCompare ? <>
          <div className="agentic-proposal-actions"><Button size="sm" testId="agentic-compare" onClick={() => openCompareAt(null)}>{comparer.comparing ? (pendingRecord ? 'Loading your saved record…' : pendingDesign ? 'Loading your saved design…' : 'Loading your saved story…') : 'Compare before and after'}</Button><Button size="sm" variant="secondary" disabled={operationBusy || refreshPending} onClick={discardProposal}>Discard</Button></div>
          <p className="agentic-review-note" data-testid="agentic-compare-note">{accepted ? 'Your explanation is accepted. Apply in Compare before and after.' : 'Explain and apply in Compare before and after. Apply stays locked until your explanation is accepted.'} Applying saves your {pendingRecord ? (proposal.files[RUNBOOK_JSON] !== undefined ? 'runbook' : 'change request') : pendingDesign ? 'design' : 'story'}; it does not submit or pass the phase.</p>
          {pendingRecord && recordWaits && <p role="status" className="agentic-review-note">Apply waits until your last edit is saved.</p>}
          {comparer.error && <p role="alert" className="agentic-action-error">{comparer.error}</p>}
        </> : <>
        {/* A story or design proposal is never drawn as files: once it is not pending, its documents and changed fields. */}
        {proposal.changes ? <StructuredProposalSummary files={proposal.files} changes={proposal.changes} applied={Boolean(proposal.appliedAt)} /> : <>
        {phaseId && <ProposalComparison key={`${owner}:${proposalKey}`} phaseId={phaseId} files={{ ...proposal.files, ...edits }} request={proposalRequest} onInspect={() => { nearBottom.current = false; }} />}
        {askedMissing.length > 0 && <div className="agentic-inventory"><InventoryList lines={askedMissing} label="Asked for, not in this proposal" testId="agentic-inventory-missing" /></div>}
        {Object.entries(proposal.files).map(([path, content]) => <details key={`${proposalKey}:${path}`}><summary>{path}</summary><label>Proposed file: inspect or edit<textarea aria-label="Proposed file: inspect or edit" disabled={operationBusy || !!proposal.appliedAt || refreshPending} rows={10} value={edits[path] ?? content} onChange={event => { const value = event.currentTarget.value; setFileDrafts(rows => ({ ...rows, [proposalKey]: { ...rows[proposalKey], [path]: value } })); }} /></label></details>)}
        {namedMissing.length > 0 && <p className="agentic-review-note" data-testid="agentic-named-not-held">{namedNotHeldLine(namedMissing, false)}</p>}
        </>}
        </>}
        {hasEdits && <><p>Edited files need a new explanation review.</p><Button size="sm" variant="secondary" disabled={operationBusy || refreshPending} onClick={saveFiles}>Save changed proposal</Button></>}
        {understanding}
        {!pendingCompare && draftKept}
        {/* A story or design proposal that offers the overlay has one explanation gate: the overlay's footer. */}
        {!pendingCompare && !proposal.appliedAt && <div className="agentic-proposal-actions">{!accepted && <Button size="sm" variant="secondary" disabled={!proposal.assessment.adequate || operationBusy || hasEdits || refreshPending} onClick={explainProposal}>Explain this proposal</Button>}<Button size="sm" disabled={!approved} onClick={() => void apply()}>Apply this reviewed proposal</Button></div>}
        {/* A record proposal the card applies (superseded or made against older work) waits for the room's save as the overlay's does, and says so. */}
        {!pendingCompare && !proposal.appliedAt && recordWaits && <p role="status" className="agentic-review-note" data-testid="agentic-record-waits">Apply waits until your last edit is saved.</p>}
        {!pendingCompare && !proposal.appliedAt && <p className="agentic-review-note" data-testid="agentic-apply-note">{accepted ? '' : 'Read the changes, then explain the intended behavior and a boundary they preserve in your own words. Apply becomes available after your explanation is accepted. '}Applying saves {proposal.changes ? 'your work' : 'files'}; it does not run, submit or pass the phase.</p>}
        {/* A declared looseness, said on screen rather than in a document. A
            phase may hold several tasks, and this panel is not scoped to one
            of them: a proposal is scoped to the phase's editable files and
            the explanation that unlocks it is approved for the phase.

            The sentence names the editable files and not "any file in this
            phase", which the server does not allow: `agentic.service.ts` sends the model
            `phase.files.filter(f => f.editable)` and refuses a proposal over
            anything else with "The proposal contains invalid or non-editable
            files." Most files in most phases are read-only, so the looser
            sentence would promise a reach the learner does not have. The
            looseness itself is that the unit is the phase and not the task. */}
        {!proposal.changes && <p className="agentic-review-note">A proposal can touch any file you can edit in this phase, and you approve it for the phase.</p>}
      </section>;

  if (stateOwner !== owner) return <p role="status">Opening this phase conversation…</p>;
  // The overlay is mounted beside the conversation rather than inside it, so
  // the conversation's own label and textarea rules do not reach its footer.
  return <><section className="agentic-conversation" aria-label={`${mentor} Agentic conversation`} data-testid="agentic-conversation">

    <div ref={log} role="log" aria-label="Agentic conversation" aria-live="polite" aria-busy={operationBusy} className="agentic-transcript" data-testid="agentic-transcript" onScroll={() => {
      const el = log.current; if (!el) return;
      nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      if (nearBottom.current) setNewReplies(false);
    }}>
      {proposals.length > 0 && <details className="agentic-saved-proposals"><summary>Saved proposals</summary><label>Earlier proposals<select aria-label="Earlier proposals" disabled={operationBusy} value={selectedId ?? ''} onChange={event => { const next = proposals.find(row => row.id === event.target.value); if (next) selectProposal(next); }}><option value="" disabled>Select a proposal</option>{proposals.map(row => <option key={row.id} value={row.id}>{new Date(row.createdAt).toLocaleString()}: {row.appliedAt ? 'Applied' : row.approvedAt ? 'Reviewed' : 'Draft'}</option>)}</select></label><p>These are saved proposal states. Earlier messages are shown only when retained in the conversation.</p></details>}
      {loading && <p role="status">Loading your conversation…</p>}
      {historyError && <div className="agentic-action-error" role="alert"><p>{historyError}</p><Button size="sm" variant="secondary" disabled={loading} onClick={() => void loadHistory()}>Retry loading conversation</Button></div>}
      {(turns.length > 0 || proposals.length > 0) && <div className="agentic-conversation-tools"><Button size="sm" variant="ghost" disabled={operationBusy || refreshPending} onClick={newRequest}>New request</Button></div>}
      {cursor && <Button size="sm" variant="ghost" disabled={operationBusy} onClick={loadOlder}>Load earlier messages</Button>}
      {!loading && !turns.length && <p className="mentor-welcome">Tell me what you want to change. We can discuss it, review a proposal, and talk through why it is correct before you apply it.</p>}
      {!reviewTurn && reviewCard}
      {turns.map(turn => <div key={turn.requestId} className="agentic-turn" data-agent-turn={turn.id} data-request-id={turn.requestId}>
        <div data-testid="msg-user" className="agentic-learner-message"><div className="chat-message-copy">{turn.message}</div>{turn.kind === 'explain' && <small>Explanation of the selected proposal</small>}</div>
        {(turn.localState === 'sending' || turn.status === 'pending' && !turn.localState) && <><div className="agentic-turn-status"><p role="status">{waitLine(turn, mentor)}</p>{!turn.localState && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reconcile(turn)}>Check saved message status</Button>}</div><WaitStep turn={turn} /></>}
        {turn.response && <div data-testid="msg-assistant"><div className="chat-message-copy"><DeferredMarkdown>{turn.response.reply}</DeferredMarkdown>{turn.response.questions.map((question, index) => <p key={index}>{question}</p>)}</div>
          {/* One control per proposal. Where this turn's proposal is the one whose card is drawn, the card's
              own controls (Compare before and after, Explain, Apply) are the way in, so no second button is drawn. */}
          {turn.response.proposal && !(reviewCard && proposal?.id === turn.response.proposal.id) && <Button size="sm" variant="secondary" disabled={operationBusy} onClick={() => selectProposal(proposals.find(row => row.id === turn.response!.proposal!.id) ?? turn.response!.proposal!)}>Review this proposal</Button>}
        </div>}
        {(turn.status === 'failed' || turn.localState === 'unconfirmed') && <div className="agentic-action-error" role="alert" data-testid="agentic-turn-error"><p>{failureLine(turn)}</p>
          {recovery(turn)}
        </div>}
        {reviewTurn?.requestId === turn.requestId && reviewCard}
      </div>)}


      {notice && <p role="status" className="agentic-action-notice">{notice}</p>}
      {error && <p role="alert" className="agentic-action-error">{error}</p>}
      {refreshPending && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refreshApplied()}>Retry workspace refresh</Button>}
    </div>
    {newReplies && <button className="agentic-new-replies" type="button" onClick={scrollNewest}>Latest messages <span aria-hidden="true">↓</span></button>}
    <div className="agentic-composer" data-testid="agentic-composer">
      {target && <div className="agentic-composer-context"><span>Explaining the reviewed files</span><button type="button" disabled={busy} onClick={() => setTarget(null)}>Back to chat</button></div>}
      <div className="agentic-compose-row"><textarea ref={composer} className="field" data-explaining={target ? 'true' : undefined} aria-label={target ? 'Explain why these changes are correct' : `Message ${mentor}`} data-testid="agentic-input" placeholder={!phaseId ? 'Open a project phase to chat' : target ? 'Why are these changes correct? Walk through the behavior and boundaries.' : 'What would you like to change or discuss?'} readOnly={!phaseId} value={draft} onChange={event => setDrafts(rows => ({ ...rows, [scope]: event.target.value }))} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }}/><button type="button" className="btn" aria-label={target ? 'Send explanation' : 'Send'} data-testid="agentic-send" disabled={!phaseId || !draft.trim() || operationBusy || loading || !!historyError || refreshPending} onClick={() => void send()}><Icon name="send" size={15}/></button></div>
      <div className="chat-composer-tools"><span>Shift + Enter for a new line</span>{operationBusy && <span role="status">Waiting for this message</span>}</div>
    </div>
  </section>{overlay}</>;
}
