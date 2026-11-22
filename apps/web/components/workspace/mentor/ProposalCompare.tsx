'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CHANGE_REQUEST_JSON, RUNBOOK_JSON, STORY_JSON, andList, type Story } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { StoryCompare } from '@/components/workspace/panels/requirements/StoryCompare';
import { DesignCompare } from '@/components/workspace/panels/design/DesignCompare';
import type { DesignCompareDocument } from '@/components/workspace/panels/design/designChanges';
import {
  SECTION_LABEL,
  SECTION_ORDER,
  changeCount,
  changedPaths,
  touchedSections,
  type StoryChange,
} from '@/components/workspace/panels/requirements/storyChanges';
import { ProposedFileDiff } from './ProposalComparison';
import { RecordFields, changedLineCount, type RecordCompareProps } from './RecordCompare';
import { InventoryList } from './InventoryList';
import { summaryBesideList } from './proposalFilesSentence';
import { ReviewDimensions } from './ReviewDimensions';
import { changedDocuments, inventoryCount, inventoryNoun, type InventoryLine, type RevealTarget } from './proposalInventory';
import './ProposalCompare.css';

/** The overlay's gate and frame, the same for every subject. */
export interface CompareGateProps {
  open: boolean;
  onClose: () => void;
  mentorName: string;
  explanation: string;
  onExplanationChange: (value: string) => void;
  canExplain: boolean;
  onExplain: () => void;
  canApply: boolean;
  onApply: () => void;
  busy: boolean;
  /**
   * What the gate has to say about this version, drawn above the explanation:
   * the wait while the explanation is reviewed, the review's feedback, an
   * error. The overlay draws it as given and never grades anything itself.
   */
  feedback?: ReactNode;
  /** The proposal's AI-written summary of what it changes, drawn above the diff; nothing when absent. */
  summary?: string | null;
  /**
   * What the proposal holds, file by file, with each file's status and count
   * (`proposalInventory`): drawn above the comparison when it says more
   * than the comparison does (a file unchanged, missing or beside the record).
   */
  inventory?: InventoryLine[];
  /** The line saying which files the learner's request names and this proposal does not change (namedNotHeld.ts); nothing when null. */
  requestNote?: string | null;
  /**
   * The proposal's file paths, in its own order. With them, a summary that is
   * only the API's file sentence over these paths is left out where the
   * inventory under it lists every one of them (review 2, m-4).
   */
  held?: readonly string[];
  /** The file to open the comparison at (a changed line on the card was chosen); the first document otherwise. */
  focusPath?: string | null;
  /** The stored explanation review of this version, drawn as the four-dimension row above the explanation. */
  assessment?: unknown;
  /**
   * This exact version's explanation was accepted and no
   * draft is kept: the learner's accepted words, drawn read-only where the
   * field was, with no Explain button (a second explanation would only revoke
   * the approval). An empty string when the words are not at hand. Absent while
   * the version still needs an explanation: the field and Explain are drawn.
   */
  acceptedExplanation?: string | null;
}

/**
 * The count a proposal of several files is named by, by the card's
 * own rule (`inventoryCount` over the same lines, with the card's noun), so the
 * card, the overlay's title and its Apply say one total in one noun: "3 files"
 * on all three where code sits beside a record. `apply` is Apply's name, from
 * what Apply changes: the files that differ from their saved copies, once every
 * one is counted (`changedDocuments`), else every file held. Without an
 * inventory (a caller that passes none) the dialog's own entries are counted,
 * in the noun the card would use.
 */
export function proposalTotal(inventory: readonly InventoryLine[] | undefined, fallback: { count: number; noun: 'file' | 'document' }): { words: string; apply: string } {
  const held = (inventory ?? []).filter(line => line.status !== 'missing');
  const nouns = (count: number, noun: string) => `${count} ${count === 1 ? noun : `${noun}s`}`;
  if (held.length > 0) {
    const noun = inventoryNoun(inventory!);
    return { words: inventoryCount(inventory!, noun), apply: applyAllLabel(changedDocuments(inventory!) ?? held.length, noun) };
  }
  return { words: nouns(fallback.count, fallback.noun), apply: applyAllLabel(fallback.count, fallback.noun) };
}

/**
 * Apply's name over several documents, by how many it changes:
 * "Apply all 3 files", "Apply the changed file" when one of several changes,
 * and plain "Apply" when none does. Every form starts "Apply".
 */
export function applyAllLabel(changed: number, noun: string): string {
  if (changed > 1) return `Apply all ${changed} ${noun}s`;
  return changed === 1 ? `Apply the changed ${noun}` : 'Apply';
}

/** The explanation field's starting height: six rows, about seven lines of text. */
export const EXPLANATION_ROWS = 6;

/**
 * Grow the explanation field to its text, up to its CSS max-height, and never
 * shrink it: a height the learner set with the resize handle stays unless the
 * text outgrows it. Nothing here touches the text.
 */
export function growToFit(element: HTMLTextAreaElement) {
  if (element.scrollHeight <= element.clientHeight) return;
  const max = parseFloat(getComputedStyle(element).maxHeight);
  const border = element.offsetHeight - element.clientHeight;
  const next = element.scrollHeight + Math.max(0, border);
  element.style.height = `${Number.isFinite(max) && max > 0 ? Math.min(next, max) : next}px`;
}

/**
 * The element "Show the change" scrolls to: the changed row at a line the
 * finding named, else the first changed line or field of what is shown.
 */
export function changeAnchor(region: HTMLElement, line?: number): HTMLElement | null {
  const rows = Array.from(region.querySelectorAll<HTMLElement>('tr[data-change="+"], tr[data-change="-"]'));
  if (line !== undefined) {
    const at = rows.find(row => row.querySelector('td')?.textContent?.trim() === String(line));
    if (at) return at;
  }
  return rows[0] ?? region.querySelector<HTMLElement>('.apv-changed, .apv-new') ?? region.querySelector<HTMLElement>('.apv-was');
}

/** The words under a proposal summary, the same on the card and in the overlay. */
export const PROPOSAL_SUMMARY_CHECK = 'Check it against the proposal before you explain the change in your own words.';

/** A story proposal: the saved story beside the proposed one. Existing callers pass no `subject`. */
export interface StoryCompareProps extends CompareGateProps {
  subject?: 'story';
  storyId: string;
  /** The saved story, or null when nothing is saved yet. */
  before: Story | null;
  after: Story;
  changes: StoryChange[];
  /** Files beside the record the proposal also writes, drawn with the existing file diff. */
  otherFiles: { path: string; before?: string; after: string }[];
}

/** A design proposal: its changes over up to three documents (the record and the switched-on contracts). */
export interface DesignCompareProps extends CompareGateProps {
  subject: 'design';
  /** The touched documents, record first (`designCompareDocuments`). */
  documents: DesignCompareDocument[];
  /** What the proposal keeps as saved ('entity E1', 'the status of D1'), from the proposal's `carried`. */
  carried: string[];
}

export type ProposalCompareProps = StoryCompareProps | DesignCompareProps | RecordCompareProps;

type View = 'side' | 'flip';
type Side = 'before' | 'after';
/** What the main area shows: the story, or one of the other touched files by path. */
type Focus = { kind: 'story' } | { kind: 'file'; path: string };

/** "a", "a and b", "a, b and c". */
const keptLine = (parts: string[]) => parts.length ? `Kept as you saved ${parts.length === 1 ? 'it' : 'them'}: ${andList(parts)}.` : '';

/**
 * The fields a proposal never changes (the story id, its epics, its parent
 * epic), named as kept so they never read as changes or go unmentioned.
 */
function carriedLine(story: Story): string {
  return keptLine([
    ...(story.id ? [`the story id ${story.id}`] : []),
    ...(story.epics?.length ? [`${story.epics.length} ${story.epics.length === 1 ? 'epic' : 'epics'}`] : []),
    ...(story.parentEpicId ? [`the parent epic ${story.parentEpicId}`] : []),
  ]);
}

/**
 * The before/after overlay for an Agentic proposal: the saved state beside
 * the proposed one, the changed fields marked on both sides, and the
 * explanation gate in the footer. For a story proposal it draws the story;
 * for a design proposal, the changed fields of each touched document. A modal
 * dialog, so the keyboard stays inside it and Escape closes it without
 * applying anything; on close, focus goes back to whatever opened it.
 *
 * It presents and forwards. Whether Explain and Apply are available is the
 * caller's decision (`canExplain`, `canApply`), exactly as on the proposal card.
 */
export function ProposalCompare(props: ProposalCompareProps) {
  if (!props.open) return null;
  if (props.subject === 'record') return <RecordDialog {...props} />;
  return props.subject === 'design' ? <DesignDialog {...props} /> : <CompareDialog {...props} />;
}

/**
 * The dialog every subject shares: its open and close effects, the header with
 * the Side by side / Flip switch and the close button, the rail when there is
 * one, and the footer gate. `actions` are the footer's buttons after Close and
 * Explain.
 */
function CompareFrame({
  ariaLabel, title, view, onView, rail, children, actions, onReveal,
  onClose, explanation, onExplanationChange, canExplain, onExplain, busy, feedback, summary, inventory, assessment, requestNote, held, acceptedExplanation,
}: Pick<CompareGateProps, 'onClose' | 'explanation' | 'onExplanationChange' | 'canExplain' | 'onExplain' | 'busy' | 'feedback' | 'summary' | 'inventory' | 'assessment' | 'requestNote' | 'held' | 'acceptedExplanation'> & {
  ariaLabel: string;
  title: string;
  view: View;
  onView: (view: View) => void;
  rail?: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  /** Show this file in the main area ("Show the change"); the dialog that knows its files does it. */
  onReveal?: (path: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const ids = useId();
  // A "Show the change" press, counted so that pressing it again after scrolling away scrolls back.
  const [reveal, setReveal] = useState<{ line?: number; n: number } | null>(null);

  // The field grows with what the learner types, never past its max-height and never smaller.
  useLayoutEffect(() => { if (field.current) growToFit(field.current); }, [explanation]);

  // After the file is shown, bring its first changed line (or the line named) into view in the one scrolling body.
  useEffect(() => {
    if (!reveal || !scroller.current) return;
    changeAnchor(scroller.current, reveal.line)?.scrollIntoView({ block: 'center' });
  }, [reveal]);
  const showChange = (target: RevealTarget) => {
    if (target.path) onReveal?.(target.path);
    setReveal(current => ({ line: target.line, n: (current?.n ?? 0) + 1 }));
  };
  const listed = inventory && (inventory.length > 1 || inventory.some(line => line.status !== 'changed')) ? inventory : null;
  // The API's file sentence says what the list under it, headed "Files in this proposal", already lists: where
  // that list holds every one of its files it is left out of the summary, whether it is the whole summary or heads
  // the API's sentence about a file the answer named and the proposal does not change; elsewhere the summary
  // is drawn whole.
  const listsHeld = Boolean(listed && held && held.every(path => listed.some(line => line.path === path && line.status !== 'missing')));
  const summaryText = !summary ? '' : listsHeld && held ? summaryBesideList(summary, held) : summary;
  const summaryShown = Boolean(summaryText);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    return () => {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
      if (previous?.isConnected && !previous.closest('[hidden]')) previous.focus({ preventScroll: true });
    };
  }, []);

  // A control that goes away while the dialog is open (a Retry once its turn
  // settles) drops focus to the page, outside the modal: keep it in the dialog.
  useEffect(() => {
    const element = dialog.current;
    if (element?.open && (!document.activeElement || document.activeElement === document.body)) element.focus({ preventScroll: true });
  });

  const explainId = `${ids}-explain`;
  return <dialog
    ref={dialog}
    className="jira-issue-dialog apv-dialog"
    tabIndex={-1}
    aria-label={ariaLabel}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}
  >
    <header>
      <span>{title}</span>
      <div className="apv-seg" role="group" aria-label="Compare mode">
        <button type="button" className={view === 'side' ? 'apv-seg-on' : ''} aria-pressed={view === 'side'} onClick={() => onView('side')}>Side by side</button>
        <button type="button" className={view === 'flip' ? 'apv-seg-on' : ''} aria-pressed={view === 'flip'} onClick={() => onView('flip')}>Flip</button>
      </div>
      <button type="button" aria-label="Close the comparison" onClick={onClose}><Icon name="cross" size={18} /></button>
    </header>
    <div className={rail ? 'apv-shell' : 'apv-body'}>
      {rail && <nav className="apv-rail" aria-label="What this proposal touches">
        <span className="apv-rail-title">Touched by this proposal</span>
        {rail}
      </nav>}
      {/* One scrolling body: the summary, the file list and both columns move together. */}
      <div ref={scroller} className="apv-main apv-scroll" data-testid="apv-scroll">
        {summaryShown && <div className="apv-summary" data-testid="agentic-compare-summary"><strong>What this proposal changes</strong><p>{summaryText}</p><small>{PROPOSAL_SUMMARY_CHECK}</small></div>}
        {/* The room's documents by their names alone, as the card names them; a file beside the record keeps its path, its only name. */}
        {listed && <div className="apv-unchanged apv-inventory"><strong>Files in this proposal</strong><InventoryList lines={listed} withPath={false} testId="apv-inventory" /></div>}
        {requestNote && <p className="apv-unchanged" data-testid="apv-named-not-held">{requestNote}</p>}
        {children}
      </div>
    </div>
    <footer className="apv-foot">
      {feedback && <div className="apv-feedback">{feedback}</div>}
      {assessment ? <ReviewDimensions assessment={assessment} inventory={inventory ?? []} onShowChange={showChange} /> : null}
      {acceptedExplanation != null
        ? <div className="apv-gate apv-gate-accepted" data-testid="apv-accepted-explanation">
            <p className="label-sm font-medium">Your accepted explanation</p>
            {acceptedExplanation.trim() ? <blockquote>{acceptedExplanation}</blockquote> : <p>Your explanation of this version was accepted.</p>}
          </div>
        : <div className="apv-gate">
            <label className="label-sm font-medium" htmlFor={explainId}>Explain why the changes are right: <span className="purpose">what they do, why they fit the request, and how you would verify them</span></label>
            <textarea ref={field} id={explainId} className="field resize-y text-[13px]" rows={EXPLANATION_ROWS} value={explanation} disabled={busy} onChange={event => onExplanationChange(event.currentTarget.value)} placeholder="Say what the changes do, why they fit the request, and how you would check them." />
          </div>}
      <div className="apv-foot-actions">
        <button type="button" className="btn-secondary btn-sm" onClick={onClose}>Close</button>
        {acceptedExplanation == null && <button type="button" className="btn-secondary btn-sm" disabled={busy || !canExplain || !explanation.trim()} onClick={onExplain}>Explain to unlock Apply</button>}
        {actions}
      </div>
    </footer>
  </dialog>;
}

/**
 * BEFORE and AFTER side by side, or one at a time under the flip bar. `body`
 * draws one side; `subject` names what BEFORE is ("your story", "your design").
 */
function Columns({ view, side, onSide, subject, body }: { view: View; side: Side; onSide: (side: Side) => void; subject: string; body: (tone: Side) => ReactNode }) {
  const ids = useId();
  const column = (tone: Side, heading: boolean) => {
    const titleId = `${ids}-${tone}`;
    return <section className={`apv-col apv-${tone}`} aria-labelledby={titleId}>
      {heading
        ? <header className="apv-col-head"><div><span id={titleId} className="apv-col-title">{tone === 'before' ? 'BEFORE' : 'AFTER'}</span><span className="apv-col-sub">{tone === 'before' ? `${subject} as it is saved now` : 'if you apply the proposal'}</span></div></header>
        : <span id={titleId} className="sr-only">{tone === 'before' ? 'BEFORE' : 'AFTER'}</span>}
      <div className="apv-col-body">{body(tone)}</div>
    </section>;
  };
  return view === 'side'
    ? <div className="apv-cols">
      {column('before', true)}
      <div className="apv-arrow" aria-hidden="true"><span>→</span></div>
      {column('after', true)}
    </div>
    : <div className="apv-view">
      <div className="apv-flip-bar" role="group" aria-label="Which state to show">
        <button type="button" className={`apv-flip-btn apv-flip-before ${side === 'before' ? 'apv-flip-on' : ''}`} aria-pressed={side === 'before'} onClick={() => onSide('before')}>BEFORE <small>as saved now</small></button>
        <button type="button" className={`apv-flip-btn apv-flip-after ${side === 'after' ? 'apv-flip-on' : ''}`} aria-pressed={side === 'after'} onClick={() => onSide('after')}>AFTER <small>with the proposal</small></button>
      </div>
      <div className="apv-flip-stage">{column(side, false)}</div>
    </div>;
}

function CompareDialog({
  onClose, mentorName, storyId, before, after, changes, otherFiles, focusPath,
  explanation, onExplanationChange, canExplain, onExplain, canApply, onApply, busy, feedback, summary, inventory, assessment, requestNote, held, acceptedExplanation,
}: StoryCompareProps) {
  const [view, setView] = useState<View>('side');
  const [side, setSide] = useState<Side>('before');
  const [showAll, setShowAll] = useState(false);
  const focusOf = (path?: string | null): Focus => path && path !== STORY_JSON && otherFiles.some(file => file.path === path) ? { kind: 'file', path } : { kind: 'story' };
  const [focus, setFocus] = useState<Focus>(() => focusOf(focusPath));

  const changed = useMemo(() => changedPaths(changes), [changes]);
  const touched = useMemo(() => touchedSections(changed), [changed]);
  const count = changeCount(changed);
  // A proposal whose record changes nothing still draws the whole story.
  const sections = showAll || touched.length === 0 ? SECTION_ORDER : touched;
  const untouched = SECTION_ORDER.filter(key => !touched.includes(key));
  const rail = otherFiles.length > 0;
  const shownFile = focus.kind === 'file' ? otherFiles.find(file => file.path === focus.path) : undefined;
  const filesWord = `${otherFiles.length} other ${otherFiles.length === 1 ? 'file' : 'files'}`;
  const countWord = count === 0 ? 'no field changes' : `${count} ${count === 1 ? 'change' : 'changes'}`;
  // With files beside the story, the card's one total in the card's noun, on the title and on Apply.
  const total = proposalTotal(inventory, { count: 1 + otherFiles.length, noun: 'file' });
  const title = rail ? `${mentorName}'s proposal for ${storyId} (${total.words})` : `${mentorName}'s proposal for ${storyId} (${countWord})`;
  const carried = before ? carriedLine(before) : '';
  const applyLabel = rail ? total.apply : `Apply to ${storyId}`;

  const storyView = <>
    {carried && <p className="apv-unchanged" data-testid="apv-carried">{carried}</p>}
    {untouched.length > 0 && touched.length > 0 && <div className="apv-unchanged">
      {showAll
        ? <>Every section is shown. <button type="button" className="apv-link" onClick={() => setShowAll(false)}>Hide unchanged</button></>
        : <>Unchanged, so not shown: {untouched.map((key, index) => <span key={key}>{index > 0 && ', '}<strong>{SECTION_LABEL[key]}</strong></span>)}. <button type="button" className="apv-link" onClick={() => setShowAll(true)}>Show them</button></>}
    </div>}
    <Columns view={view} side={side} onSide={setSide} subject="your story" body={tone => {
      const story = tone === 'before' ? before : after;
      return story
        ? <StoryCompare story={story} other={tone === 'before' ? after : before} changed={changed} tone={tone} sections={sections} />
        : <p className="apv-muted">No story saved yet.</p>;
    }} />
  </>;

  return <CompareFrame
    ariaLabel={`Compare before and after: ${mentorName}'s proposal for ${storyId}`}
    title={title}
    view={view}
    onView={setView}
    rail={rail ? <>
      <button type="button" className={`apv-rail-item ${focus.kind === 'story' ? 'apv-rail-on' : ''}`} aria-current={focus.kind === 'story' ? 'true' : undefined} onClick={() => setFocus({ kind: 'story' })}>
        <span className="mono">{storyId}</span><span className="apv-rail-name">{after.title.trim() || 'Untitled story'}</span><span className="apv-rail-count">{countWord}</span>
      </button>
      {otherFiles.map(file => <button key={file.path} type="button" className={`apv-rail-item ${shownFile?.path === file.path ? 'apv-rail-on' : ''}`} aria-current={shownFile?.path === file.path ? 'true' : undefined} onClick={() => setFocus({ kind: 'file', path: file.path })}>
        <span className="mono apv-rail-path">{file.path}</span><span className="apv-rail-count">{file.before === undefined ? 'New file' : 'Changed file'}</span>
      </button>)}
    </> : undefined}
    actions={<button type="button" className="btn btn-sm" disabled={busy || !canApply} onClick={onApply}>{applyLabel}</button>}
    onReveal={path => setFocus(focusOf(path))}
    onClose={onClose} explanation={explanation} onExplanationChange={onExplanationChange} canExplain={canExplain} onExplain={onExplain} busy={busy} feedback={feedback} summary={summary} requestNote={requestNote} held={held} inventory={inventory} assessment={assessment} acceptedExplanation={acceptedExplanation}
  >
    {shownFile
      ? <div className="apv-file"><h3 className="mono">{shownFile.path}</h3><ProposedFileDiff path={shownFile.path} original={shownFile.before} content={shownFile.after} /></div>
      : storyView}
  </CompareFrame>;
}

/**
 * A design proposal over its touched documents: the rail names each one with
 * its count when more than one is touched, the columns show the selected
 * one, "Next" moves to the next, and one explanation and one Apply cover the
 * whole proposal. No floor status: the overlay compares, it never grades.
 */
function DesignDialog({
  onClose, mentorName, documents, carried, focusPath,
  explanation, onExplanationChange, canExplain, onExplain, canApply, onApply, busy, feedback, summary, inventory, assessment, requestNote, held, acceptedExplanation,
}: DesignCompareProps) {
  const [view, setView] = useState<View>('side');
  const [side, setSide] = useState<Side>('before');
  const indexOf = (path?: string | null) => Math.max(0, documents.findIndex(doc => doc.path === path));
  const [selected, setSelected] = useState(() => indexOf(focusPath));
  const at = Math.min(selected, Math.max(0, documents.length - 1));
  const shown = documents[at];
  const count = documents.reduce((sum, doc) => sum + doc.changes.length, 0);
  const changesWord = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;
  const rail = documents.length > 1;
  // Over several documents, the card's one total in the card's noun, on the title and on Apply.
  const total = proposalTotal(inventory, { count: documents.length, noun: 'document' });
  const title = rail ? `${mentorName}'s proposal for your design (${total.words})` : `${mentorName}'s proposal for your design (${count === 0 ? 'no field changes' : changesWord(count)})`;
  const next = rail ? documents[(at + 1) % documents.length] : undefined;
  const kept = keptLine(carried);
  // the document's own label lower-cased, but an acronym (API) kept as it is written
  const lowered = (label: string) => label.replace(/\b([A-Z])([a-z]+)\b/g, (_whole, first: string, rest: string) => first.toLowerCase() + rest);
  const applyLabel = documents.length > 1 ? total.apply : `Apply to the ${lowered(documents[0]?.label ?? 'design')}`;

  return <CompareFrame
    ariaLabel={`Compare before and after: ${mentorName}'s proposal for your design`}
    title={title}
    view={view}
    onView={setView}
    rail={rail ? documents.map((doc, i) => <button key={doc.path} type="button" className={`apv-rail-item ${i === at ? 'apv-rail-on' : ''}`} aria-current={i === at ? 'true' : undefined} onClick={() => setSelected(i)}>
      <span className="apv-rail-name apv-rail-doc">{doc.label}</span><span className="apv-rail-count apv-rail-doc">{changesWord(doc.changes.length)}</span>
    </button>) : undefined}
    actions={<>
      {next && <button type="button" className="btn-secondary btn-sm" onClick={() => setSelected((at + 1) % documents.length)}>Next: {next.label}</button>}
      <button type="button" className="btn btn-sm" disabled={busy || !canApply} onClick={onApply}>{applyLabel}</button>
    </>}
    onReveal={path => { if (documents.some(doc => doc.path === path)) setSelected(indexOf(path)); }}
    onClose={onClose} explanation={explanation} onExplanationChange={onExplanationChange} canExplain={canExplain} onExplain={onExplain} busy={busy} feedback={feedback} summary={summary} requestNote={requestNote} held={held} inventory={inventory} assessment={assessment} acceptedExplanation={acceptedExplanation}
  >
    {kept && <p className="apv-unchanged" data-testid="apv-carried">{kept}</p>}
    {shown
      ? <Columns view={view} side={side} onSide={setSide} subject="your design" body={tone => <DesignCompare document={shown} tone={tone} />} />
      : <p className="apv-unchanged">This proposal changes no field of your design.</p>}
  </CompareFrame>;
}

/**
 * A runbook or change-request proposal over the record and the files it also
 * touches: the rail names the record with its change count and each file with
 * its changed lines when more than one document is touched, "Next" moves on,
 * the kept line names what the proposal carries, and one explanation and one
 * Apply cover the whole proposal. No floor status: the overlay
 * compares, it never grades.
 */
function RecordDialog({
  onClose, mentorName, label, changes, carried, files, saved, focusPath,
  explanation, onExplanationChange, canExplain, onExplain, canApply, onApply, busy, feedback, summary, inventory, assessment, requestNote, held, acceptedExplanation,
}: RecordCompareProps) {
  const [view, setView] = useState<View>('side');
  const [side, setSide] = useState<Side>('before');
  const recordPath = label === 'Runbook' ? RUNBOOK_JSON : CHANGE_REQUEST_JSON;
  // The rail's entries are the record, then each file beside it: a path's place among them, or the record.
  const indexOf = (path?: string | null) => path === recordPath ? 0 : files.findIndex(file => file.path === path) + 1;
  const [selected, setSelected] = useState(() => indexOf(focusPath));
  const changesWord = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;
  const entries = [
    { key: 'record', name: label, count: changesWord(changes.length) },
    ...files.map((file) => { const n = changedLineCount(file.before, file.after); return { key: file.path, name: file.path, count: `${n} ${n === 1 ? 'line' : 'lines'}` }; }),
  ];
  // Over the record and the files beside it, the card's one total in the card's noun ("3 files"), on the title and on Apply.
  const total = proposalTotal(inventory, { count: entries.length, noun: files.length ? 'file' : 'document' });
  const at = Math.min(selected, entries.length - 1);
  const rail = entries.length > 1;
  const next = rail ? entries[(at + 1) % entries.length] : undefined;
  const file = at > 0 ? files[at - 1] : undefined;
  const subject = `your ${label.toLowerCase()}`;
  const kept = keptLine(carried);
  const applyLabel = entries.length > 1 ? total.apply : `Apply to the ${label.toLowerCase()}`;
  return <CompareFrame
    ariaLabel={`Compare before and after: ${mentorName}'s proposal for ${subject}`}
    title={`${mentorName}'s proposal for ${subject} (${entries.length > 1 ? total.words : changes.length === 0 ? 'no field changes' : changesWord(changes.length)})`}
    view={view}
    onView={setView}
    rail={rail ? entries.map((entry, i) => <button key={entry.key} type="button" data-testid={`record-compare-rail-${entry.key}`} aria-label={`${entry.name}, ${entry.count}`} className={`apv-rail-item ${i === at ? 'apv-rail-on' : ''}`} aria-current={i === at ? 'true' : undefined} onClick={() => setSelected(i)}>
      {/* The count on its own line under the name, as the design rail draws it, so a long path never leaves ", 4 lines" wrapping alone; its name keeps "name, count" for a screen reader. */}
      <span className="apv-rail-name apv-rail-doc">{entry.name}</span><span className="apv-rail-count apv-rail-doc">{entry.count}</span>
    </button>) : undefined}
    actions={<>
      {next && <button type="button" className="btn-secondary btn-sm" onClick={() => setSelected((at + 1) % entries.length)}>Next: {next.name}</button>}
      <button type="button" className="btn btn-sm" disabled={busy || !canApply} onClick={onApply}>{applyLabel}</button>
    </>}
    onReveal={path => { if (path === recordPath || files.some(row => row.path === path)) setSelected(indexOf(path)); }}
    onClose={onClose} explanation={explanation} onExplanationChange={onExplanationChange} canExplain={canExplain} onExplain={onExplain} busy={busy} feedback={feedback} summary={summary} requestNote={requestNote} held={held} inventory={inventory} assessment={assessment} acceptedExplanation={acceptedExplanation}
  >
    {kept && <p className="apv-unchanged" data-testid="apv-carried">{kept}</p>}
    {file
      ? <div className="apv-file"><h3 className="mono">{file.path}</h3><ProposedFileDiff path={file.path} original={file.before} content={file.after} /></div>
      : changes.length > 0
        ? <Columns view={view} side={side} onSide={setSide} subject={subject} body={tone => <RecordFields changes={changes} tone={tone} saved={saved} />} />
        : <p className="apv-unchanged">{`This proposal changes no field of ${subject}.`}</p>}
  </CompareFrame>;
}
