'use client';

import { PhaseBriefIntro } from '@/components/workspace/PhaseBriefIntro';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { briefHref } from '@/components/shell/routes';
import { useInterviewAbsent, useProjectName, useReferenceScaffolding } from '@/lib/scenario';
import { Chip, Notice, SectionHead } from '@/components/ui';
import type { StatusState } from '@/lib/phase';
import { LEARNER_PICKS, STORY_CAPS, STORY_ID_NEEDED, floorSentence, storyReviewProjection, type PhaseDetail, type ProvidedStory } from '@learnsdlc/shared';
import { StoryChecks } from './Checks';
import { CriterionCard } from './Criteria';
import { AddRow, Box, FIELD_CAP, GrowRow, IconButton } from './Fields';
import {
  newCriterion,
  renumber,
  shownStoryId,
  type AcceptanceCriterion,
  type Story,
} from './story';
import { StoryCard } from './StoryCard';
import { criterionState, storyStarted, type StoryView } from './useStory';
import { isTouched, readTouched } from './touched';
import { REFERENCE_COPY } from '../../reference/copy';

/** What a disabled add control says once its list holds as many as the record may. */
const LIST_FULL = `This list is full (${STORY_CAPS.listItems} at most).`;
const full = (list: readonly unknown[] | undefined) => (list?.length ?? 0) >= STORY_CAPS.listItems;
const capped = (text: string) => text.slice(0, FIELD_CAP);

const TID = 'phase-requirements';

export interface IssueDeskProps {
  phaseId?: string;
  /** The shared Requirements layout owns navigation, brief and mentor. */
  embedded?: boolean;
  active?: boolean;
  /** The stories the project supplies, read-only, from the phase's story spec. */
  providedStories?: ProvidedStory[];
  /**
   * The phase's story spec: the id (fixed, or the learner's to pick), the
   * pack's hints for the sentence, and the floor the checks read.
   */
  spec?: PhaseDetail['story'];
  reviewOpen?: boolean;
  onReviewOpenChange?: (open: boolean) => void;
  reviewContent?: ReactNode;
  /** A modal draft is not saved evidence and must be resolved before agentic apply. */
  onPendingDraftChange?: (pending: boolean) => void;
  /** Optional outer workspace preference; hiding the brief keeps this desk mounted. */
  briefPanel?: { id: string; open: boolean };
  disabled?: boolean;
  view: StoryView;
  projectTitle: string;
  /** "In review", "Passed": where the story stands with the product owner. */
  statusLabel: string;
  /**
   * The header state chip's tone for the same word (`storyStatusTone`):
   * `neutral` is a passing review waiting on the teacher's countersignature,
   * `outline` "In progress" as the header draws it.
   */
  statusTone: 'accent' | 'pass' | 'warn' | 'neutral' | 'outline';
  /** The state square the learner's backlog row carries. */
  storyState: StatusState;
  assignedTo: string;
  /** `requirements/story.json` is writable. Without it the form cannot keep a record. */
  canRecord: boolean;
  /** Write the record. The page saves it; this never fetches. */
  setStory: (next: Story) => void;
  /** "Check the story" and "Submit for review": the page owns both. */
  footerRight?: ReactNode;
  /** The footer's save state ("Saved 11:02"), as Design's footer says it; the page owns the save. */
  saveState?: ReactNode;
}

/** Native dialogs provide focus trapping and Escape without a second UI framework. */
export function IssueDialog({ title, children, onClose, wide = false, active = true }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; active?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element || !active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => {
      element.close();
      if (previous?.isConnected && !previous.closest('[hidden]')) previous.focus({ preventScroll: true });
    };
  }, [active]);
  return <dialog ref={dialog} className={`jira-issue-dialog ${wide?'jira-wide-dialog':''}`} aria-label={title} onCancel={event=>{event.preventDefault();onClose();}}><header><span><Icon name="requirements" size={17}/>{title}</span><button type="button" onClick={onClose} aria-label="Close issue dialog"><Icon name="cross" size={18}/></button></header>{children}</dialog>;
}

/**
 * What Save story says when the story has no title.
 *
 * An untitled story saved without a word would surface only after a full AI
 * review had failed it on the teacher's criteria. The title is what the
 * review reads first, so it is asked for when the learner saves, in the
 * dialog they are in.
 */
export const STORY_TITLE_NEEDED = 'Give the story a title before you save it. The review reads the title first.';

/**
 * The backlog's one "add" control. It opens a choice between an
 * epic and the learner's one story (which, once started, is edited rather than
 * created), so it names neither "issue", a word the backlog uses nowhere else,
 * nor "story" alone.
 */
export const ADD_TO_BACKLOG = 'Add to backlog';

/**
 * An empty "Open questions" box is a story with nothing left to ask, not a
 * missing part: the box says so before anything is typed.
 */
export const OPEN_QUESTIONS_NONE = 'None yet. Write here any question the stakeholder left unanswered.';

export function IssueDesk(props: IssueDeskProps) {
 // The header names the learner's project and the interview door names no
 // persona, so neither spells TaskTrackr's on every project.
 const named = useProjectName();
 // The desk's remaining words are
 // the reference story's: US-4, the overdue report. They stay on a phase that
 // is still the reference project's and are neutral everywhere else.
 const reference = useReferenceScaffolding('requirements');
 const noInterview = useInterviewAbsent(props.phaseId);
 const projectKicker = named ? `${named.toUpperCase()} PROJECT` : 'YOUR PROJECT';
 const {view,phaseId,disabled,setStory,footerRight,active=true}=props;
 const story=view.story;
 // 'US-4' is EMPTY_STORY's default id, the reference story's;
 // off the reference room the desk names only the learner's own id.
 const ownId=shownStoryId(story.id,reference);
 const [draft,setDraft]=useState<Story|null>(null);
 const [draftError,setDraftError]=useState('');
 const [epic,setEpic]=useState<{id:string;title:string;outcome:string}|null>(null);
 const [selected,setSelected]=useState<ProvidedStory|null>(null);
 const [filter,setFilter]=useState('');
 const [epicFilter,setEpicFilter]=useState('all');
 const [kind,setKind]=useState<'all'|'story'|'epic'>('all');
 const [createOpen,setCreateOpen]=useState(false);
 const [localChecks,setLocalChecks]=useState(false);
 const showChecks=props.reviewOpen??localChecks;
 const setShowChecks=props.onReviewOpenChange??setLocalChecks;
 const pendingDraft=Boolean(draft||epic);
 useEffect(()=>{props.onPendingDraftChange?.(pendingDraft);},[pendingDraft,props.onPendingDraftChange]);
 const modalActive=active&&!disabled;
 // A fixed id is the learner's own row, so a provided story of the same id is
 // left out; a learner-picked id never hides a provided story (the editor
 // names the clash instead).
 const picksId=props.spec?.id===LEARNER_PICKS;
 const provided=picksId?(props.providedStories??[]):(props.providedStories??[]).filter(item=>item.id!==story.id);
 const epicsFull=full(story.epics);
 const matches=(id:string,title:string)=>`${id} ${title}`.toLowerCase().includes(filter.toLowerCase());
 const createEpic=()=>{if(disabled||!active||epicsFull)return;const ids=(story.epics??[]).map(item=>Number(item.id.replace('EP-',''))||0);setEpic({id:`EP-${Math.max(0,...ids)+1}`,title:'',outcome:''});setCreateOpen(false);};
 const editStory=()=>{if(disabled||!active)return;setDraftError('');setDraft(structuredClone(story));setCreateOpen(false);};
 const saveDraft=()=>{if(!modalActive||!draft)return;if(!draft.title.trim()){setDraftError(STORY_TITLE_NEEDED);return;}setStory(draft);setDraft(null);setDraftError('');};
 const rows=provided.filter(item=>matches(item.id,item.title)&&epicFilter==='all');
 const ownVisible=matches(ownId,story.title)&&(epicFilter==='all'||story.parentEpicId===epicFilter);
 const visibleEpics=(story.epics??[]).filter(item=>matches(item.id,item.title)&&(epicFilter==='all'||item.id===epicFilter));
 const visibleCount=(kind!=='story'?visibleEpics.length:0)+(kind!=='epic'?rows.length+Number(ownVisible):0);
 const noEpicsYet=kind==='epic'&&!story.epics?.length&&!filter.trim()&&epicFilter==='all';
 return <div className="issue-desk jira-issue-desk" ref={node=>{if(node)node.inert=Boolean(disabled);}}>
  {!props.embedded&&<aside id={props.briefPanel?.id} data-workspace-panel={props.briefPanel ? 'brief' : undefined} hidden={props.briefPanel ? !props.briefPanel.open : undefined}><PhaseBriefIntro phaseKey="requirements"/><div className="jira-evidence-tip"><Icon name="link" size={16}/><p>{reference?REFERENCE_COPY.requirements.evidenceTip:'Keep your story connected to the stakeholder’s evidence. The approved stories define the work around it.'}</p></div></aside>}
  <section className="jira-backlog-room" data-testid={`${TID}-editor`}>
   {phaseId&&!props.embedded&&<nav className="phase-room-nav" aria-label="Requirements working area">{!noInterview&&<Link href={`/workspace/${phaseId}/interview`}>Stakeholder interview</Link>}<Link href={briefHref({id:phaseId})}>Case file</Link><button type="button" aria-pressed={!showChecks} onClick={()=>setShowChecks(false)}>My backlog</button><button type="button" aria-pressed={showChecks} onClick={()=>setShowChecks(true)}>Review</button></nav>}
   {props.embedded&&<nav className="jira-view-nav" aria-label="Backlog views"><button type="button" aria-pressed={!showChecks} onClick={()=>setShowChecks(false)}>Backlog</button><button type="button" aria-pressed={showChecks} onClick={()=>setShowChecks(true)}>Review</button></nav>}
   <header className="jira-backlog-heading"><div><small>{projectKicker}</small><h2>Requirements backlog</h2><p>Shape the work before it becomes code.</p></div><button type="button" className="btn btn-sm" onClick={()=>setCreateOpen(true)}><Icon name="plus" size={15}/>{ADD_TO_BACKLOG}</button></header>
   {showChecks?<div className="jira-backlog-review">{props.reviewContent}{view.results.length>0&&<><StoryChecks results={view.results}/>{props.spec&&<p data-testid={`${TID}-floor`}>The story needs {floorSentence(props.spec.floor)}.</p>}</>}<h3>Story evidence</h3><StoryCard story={story} full testId={`${TID}-story-card`}/><button className="btn-secondary btn-sm" type="button" onClick={editStory}>{reference?REFERENCE_COPY.requirements.refineStory:'Refine your story'}</button></div>:<>
   <div className="jira-backlog-filters"><label><Icon name="search" size={15}/><input aria-label="Search backlog" value={filter} onChange={event=>setFilter(event.target.value)} placeholder="Search this backlog"/></label><select aria-label="Issue type filter" value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="all">All work types</option><option value="story">Stories</option><option value="epic">Epics</option></select></div>
   <div className="jira-backlog-body"><aside className="jira-epic-list"><header><strong>Epics</strong><button type="button" aria-label="Create epic" onClick={createEpic} disabled={epicsFull} title={epicsFull?LIST_FULL:undefined}><Icon name="plus" size={15}/></button></header><button type="button" aria-pressed={epicFilter==='all'} onClick={()=>setEpicFilter('all')}>All stories <span>{provided.length+1}</span></button>{(story.epics??[]).map(item=><div key={item.id}><button type="button" aria-pressed={epicFilter===item.id} onClick={()=>setEpicFilter(item.id)}><span className="jira-type-epic"><Icon name="sparkles" size={12}/></span><span>{item.title||'Untitled epic'}<small>{item.id}</small></span></button><button type="button" className="jira-epic-edit" onClick={()=>setEpic({...item})} aria-label={`Edit ${item.id}`}><Icon name="edit" size={12}/></button></div>)}{!story.epics?.length&&<p>Give related work a shared outcome.<button type="button" onClick={createEpic}>Create your first epic</button></p>}</aside>
   <div className="jira-issue-list"><header><strong>Backlog</strong><span>{kind==='epic'?'Epics':'Stories and outcomes'}</span></header>
   {kind!=='story'&&visibleEpics.map(item=><button type="button" className="jira-issue-row" key={item.id} onClick={()=>setEpic({...item})}><span className="jira-type-epic"><Icon name="sparkles" size={12}/></span><code>{item.id}</code><span>{item.title||'Untitled epic'}</span><small>EPIC</small></button>)}
   {kind!=='epic'&&rows.map(item=><button type="button" className="jira-issue-row" key={item.id} onClick={()=>setSelected(item)}><span className="jira-type-story"><Icon name="check" size={12}/></span><code>{item.id}</code><span>{item.title}</span><small>PROVIDED</small><Icon name="lock" size={12}/></button>)}
   {kind!=='epic'&&ownVisible&&<button type="button" className="jira-issue-row jira-own-story" onClick={editStory}><span className="jira-type-story"><Icon name="check" size={12}/></span>{(reference||ownId)&&<code>{ownId}</code>}<span>{story.title||(reference?REFERENCE_COPY.requirements.storyTitle:'Specify your story')}{story.parentEpicId&&<em>{story.parentEpicId}</em>}</span><Chip tone={props.statusTone} testId={`${TID}-story-status`}>{props.statusLabel}</Chip><Icon name="edit" size={13}/></button>}
   {visibleCount===0&&<div className="p-4 text-sm text-muted" role="status"><p>{noEpicsYet?'No epics yet. Create one to group related work.':'No issues match these filters.'}</p>{!noEpicsYet&&<button type="button" className="btn-secondary btn-sm mt-2" onClick={()=>{setFilter('');setKind('all');setEpicFilter('all');}}>Clear filters</button>}</div>}
   <button type="button" className="jira-add-story" onClick={editStory}><Icon name="plus" size={14}/>{storyStarted(story)?'Edit your story':reference?REFERENCE_COPY.requirements.createStory:'Create your story'}</button><p className="jira-list-note">{reference?REFERENCE_COPY.requirements.storyListNote:'This story is yours to define.'}{provided.length>0&&' The supplied stories remain part of the project contract.'}</p></div></div></>}
   <footer className="jira-backlog-footer"><span className="flex items-center gap-3.5">{props.saveState??'Saved work follows your project'}</span>{footerRight}</footer>
  </section>
  {createOpen&&<IssueDialog active={modalActive} title={ADD_TO_BACKLOG} onClose={()=>setCreateOpen(false)}><div className="jira-create-options"><p>Choose the kind of work you want to define.</p><button type="button" onClick={createEpic} disabled={epicsFull} title={epicsFull?LIST_FULL:undefined}><span className="jira-type-epic"><Icon name="sparkles" size={18}/></span><span><strong>Epic</strong><small>A larger outcome that groups related work.</small></span><Icon name="arrow-right" size={16}/></button><button type="button" onClick={editStory}><span className="jira-type-story"><Icon name="check" size={18}/></span><span><strong>{reference?REFERENCE_COPY.requirements.storyId:'Story'}</strong><small>{reference?REFERENCE_COPY.requirements.storyPurpose:'The story you are defining for this project.'}</small></span><Icon name="arrow-right" size={16}/></button></div></IssueDialog>}
  {epic&&<IssueDialog active={modalActive} title={`${story.epics?.some(item=>item.id===epic.id)?'Edit':'Create'} epic`} onClose={()=>setEpic(null)}><form className="jira-epic-form" onSubmit={event=>{event.preventDefault();if(!modalActive)return;setStory({...story,epics:[...(story.epics??[]).filter(item=>item.id!==epic.id),epic]});setEpic(null);}}><small>{epic.id}</small><label>Epic title<input autoFocus required maxLength={FIELD_CAP} value={epic.title} onChange={event=>setEpic({...epic,title:capped(event.target.value)})} placeholder="Name the larger outcome"/></label><label>Intended outcome<textarea required rows={5} maxLength={FIELD_CAP} value={epic.outcome} onChange={event=>setEpic({...epic,outcome:capped(event.target.value)})} placeholder="What will improve, and for whom?"/></label><footer>{story.epics?.some(item=>item.id===epic.id)&&<button type="button" className="btn-ghost btn-sm" onClick={()=>{if(!modalActive)return;setStory({...story,epics:story.epics!.filter(item=>item.id!==epic.id),...(story.parentEpicId===epic.id?{parentEpicId:''}:{})});setEpic(null);}}>Remove epic</button>}<button type="button" className="btn-secondary btn-sm" onClick={()=>setEpic(null)}>Cancel</button><button type="submit" className="btn btn-sm" disabled={!modalActive}>Save epic</button></footer></form></IssueDialog>}
  {draft&&<IssueDialog active={modalActive} title={reference||ownId?`Edit story ${ownId}`:'Edit story'} onClose={()=>setDraft(null)} wide><StoryEditor {...props} view={{...view,story:draft}} setStory={next=>{setDraft(next);if(next.title.trim())setDraftError('');}} footerRight={<>{draftError&&<p role="alert" className="text-[12.5px] text-fail" data-testid="story-title-needed">{draftError}</p>}<button type="button" className="btn-secondary btn-sm" onClick={()=>{setDraft(null);setDraftError('');}}>Cancel</button><button type="button" className="btn btn-sm" disabled={!modalActive} onClick={saveDraft}>Save story</button></>}/></IssueDialog>}
  {selected&&<IssueDialog active={modalActive} title={`${selected.id}: ${selected.title}`} onClose={()=>setSelected(null)}><div className="jira-provided-issue"><span className="jira-provided-label"><Icon name="lock" size={15}/>Provided project contract</span><p>{reference?REFERENCE_COPY.requirements.providedStory:'This approved story supplies the surrounding behavior. Write your story so it agrees with these requirements.'}</p><StoryCard story={selected} heading={false} testId={`${TID}-provided-card`}/></div></IssueDialog>}
 </div>;
}

/**
 * The issue itself: the backlog and the checks down the left, US-4 as a form in
 * the middle. Everything it shows is derived from `requirements/story.json` by
 * {@link StoryView}: the desk only lays it out and hands edits back.
 */
function StoryEditor({
  phaseId,
  disabled = false,
  view,
  statusLabel,
  statusTone,
  assignedTo,
  canRecord,
  setStory,
  footerRight,
  spec,
  providedStories = [],
}: IssueDeskProps) {
  const story = view.story;
  // The example words are the reference story's only where
  // the phase still is the reference project's.
  const reference = useReferenceScaffolding('requirements');
  // No default 'US-4' off the reference room.
  const ownId = shownStoryId(story.id, reference);
  // The fields an applied Agentic proposal wrote, with what it wrote there. A
  // field is marked only while it still holds that text, so an edit drops the
  // mark and a cancelled edit leaves it (see `touched.ts`).
  const [touched] = useState(() => readTouched(phaseId));
  const now = useMemo(() => storyReviewProjection(story), [story]);
  const mark = (on: boolean) => on ? <Chip tone="outline" testId="story-touched">Changed by the assistant</Chip> : null;
  const marked = (path: string) => mark(isTouched(touched, now, path));
  // Any of a criterion's paths holds the whole criterion as the assistant wrote
  // it, so the card is marked only while all four of its values still match.
  const criterionMarked = (n: number) => mark(['given', 'when', 'then', 'tag'].some((field) => isTouched(touched, now, `story/ac-${n}/${field}`)));
  const patch = (fields: Partial<Story>) => setStory({ ...story, ...fields });
  // Where the learner picks the id they type it; otherwise it is the phase's.
  const picksId = spec?.id === LEARNER_PICKS;
  const hints = spec?.hints ?? {};
  // An empty picked id is refused by the save in this same sentence
  // (`STORY_ID_NEEDED`), so the form says it first. A provided story's id is
  // one the grader takes, so the form says so rather than refusing the save.
  const idNote = !picksId
    ? ''
    : !story.id.trim()
      ? STORY_ID_NEEDED
      : providedStories.some((one) => one.id === story.id)
        ? `${story.id} is a provided story; pick another id.`
        : '';
  const criteriaFull = full(story.criteria);
  const exclusionsFull = full(story.scopeExclusions);
  const criteriaCount = story.criteria.length;
  const runnable = story.criteria.filter((c) => criterionState(c) === 'runnable').length;

  const setCriterion = (index: number, fields: Partial<AcceptanceCriterion>) =>
    patch({ criteria: story.criteria.map((c, i) => (i === index ? { ...c, ...fields } : c)) });
  const addCriterion = () => {
    if (!criteriaFull) patch({ criteria: [...story.criteria, newCriterion(story.criteria.length)] });
  };
  const removeCriterion = (index: number) =>
    patch({ criteria: renumber(story.criteria.filter((_, i) => i !== index)) });
  const moveCriterion = (index: number, delta: number) => {
    const next = [...story.criteria];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    patch({ criteria: renumber(next) });
  };

  const setExclusion = (index: number, value: string) =>
    patch({ scopeExclusions: story.scopeExclusions.map((s, i) => (i === index ? value : s)) });
  const addExclusion = () => {
    if (!exclusionsFull) patch({ scopeExclusions: [...story.scopeExclusions, ''] });
  };
  const removeExclusion = (index: number) =>
    patch({ scopeExclusions: story.scopeExclusions.filter((_, i) => i !== index) });

  return (
    <div className="jira-story-editor flex min-h-0 flex-1 flex-col" ref={node => { if (node) node.inert = disabled; }}>

      <section
        className="flex min-w-0 flex-1 flex-col overflow-hidden"
        data-testid={`${TID}-editor`}
      >
        <header className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b-1.5 border-edge px-5 py-3">
          {picksId ? (
            <>
              <label htmlFor={`${TID}-story-id`} className="sr-only">
                Story id
              </label>
              <input
                id={`${TID}-story-id`}
                data-testid={`${TID}-story-id`}
                className="field mono w-[96px] shrink-0 text-[13px] font-semibold"
                value={story.id}
                placeholder="Story id"
                maxLength={STORY_CAPS.learnerPickedId}
                onChange={(event) => patch({ id: event.target.value.replace(/\s+/g, '') })}
              />
              {idNote && (
                <span role="note" data-testid={`${TID}-story-id-note`} className="label-sm basis-full text-warn">
                  {idNote}
                </span>
              )}
            </>
          ) : (
            (reference || ownId) && <span className="mono shrink-0 text-[13px] font-semibold text-muted">{ownId}</span>
          )}
          <label htmlFor={`${TID}-title`} className="sr-only">
            Story title
          </label>
          <GrowRow
            id={`${TID}-title`}
            testId={`${TID}-title`}
            variant="title"
            className="jira-story-title"
            value={story.title}
            placeholder={reference ? REFERENCE_COPY.requirements.titlePlaceholder : 'A short name for the story'}
            onChange={(title) => patch({ title: title.replace(/[\r\n\u2028\u2029]+/g, ' ') })}
          />
          {marked('story/title')}
          {/* Where the story stands, as the header's state chip and the backlog
              row draw the same word: one state, one chip. */}
          <Chip tone={statusTone} testId={`${TID}-story-status-dialog`}>{statusLabel}</Chip>
          <Chip>Must have</Chip>
          <span className="label-sm whitespace-nowrap">Assigned to {assignedTo}</span>
          <span className="label-sm whitespace-nowrap">Reported by the product owner</span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
          {!canRecord && (
            <Notice tone="warn" testId={`${TID}-no-record`}>
              The story record is missing from this workspace. Reload the project before
              editing so the form can save your work.
            </Notice>
          )}

          <label className="label-sm">Parent epic<select aria-label="Parent epic" className="field mt-1 block w-full" value={story.parentEpicId ?? ''} onChange={event => patch({ parentEpicId: event.target.value })}><option value="">No parent selected</option>{(story.epics ?? []).map(epic => <option key={epic.id} value={epic.id}>{epic.id}: {epic.title || 'Untitled epic'}</option>)}</select></label>
          <div className="grid min-w-0 gap-3 md:grid-cols-3">
            <Box
              id={`${TID}-persona`}
              testId={`${TID}-persona`}
              label="As a"
              note={marked('story/as-a')}
              rows={2}
              value={story.persona}
              placeholder={hints.persona || (reference ? REFERENCE_COPY.requirements.personaPlaceholder : 'the person who needs this')}
              onChange={(v) => patch({ persona: v })}
            />
            <Box
              id={`${TID}-capability`}
              testId={`${TID}-capability`}
              label="I want"
              note={marked('story/i-want')}
              rows={2}
              value={story.capability}
              placeholder={hints.capability || (reference ? REFERENCE_COPY.requirements.capabilityPlaceholder : 'what they want to be able to do')}
              onChange={(v) => patch({ capability: v })}
            />
            <Box
              id={`${TID}-benefit`}
              testId={`${TID}-benefit`}
              label="So that"
              note={marked('story/so-that')}
              rows={2}
              value={story.benefit}
              placeholder={hints.benefit || (reference ? REFERENCE_COPY.requirements.benefitPlaceholder : 'why it matters to them')}
              onChange={(v) => patch({ benefit: v })}
            />
          </div>

          <SectionHead
            title="Acceptance criteria"
            purpose="Given / When / Then. A row whose Then can be checked becomes a hidden test in phase 3 and one of your own tests in phase 4."
            right={
              <span className="label-sm whitespace-nowrap">
                {/* "0 of 0 runnable" is a measurement of nothing. */}
                {criteriaCount === 0
                  ? 'None yet'
                  : `${runnable} of ${criteriaCount} runnable`}
              </span>
            }
          />
          {/* The cards and the row that adds one are a single stack: the dashed
              row ends the list, so it sits at the list's own spacing. */}
          <div className="flex min-w-0 flex-col gap-2">
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {story.criteria.map((c, i) => (
                <CriterionCard
                  key={c.id}
                  criterion={c}
                  index={i}
                  count={story.criteria.length}
                  note={criterionMarked(i + 1)}
                  actions={{
                    set: (fields) => setCriterion(i, fields),
                    move: (delta) => moveCriterion(i, delta),
                    remove: () => removeCriterion(i),
                  }}
                />
              ))}
              {story.criteria.length === 0 && (
                <li className="purpose">No criteria yet. The review wants at least two.</li>
              )}
            </ul>
            <AddRow label="Add a criterion" testId={`${TID}-criterion-add`} onClick={addCriterion} disabled={criteriaFull} title={criteriaFull ? LIST_FULL : undefined} />
          </div>

          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="label-sm font-medium">Out of scope</span>
              <div className="flex min-h-[52px] min-w-0 flex-col gap-1 rounded-ctl border-1.5 border-edge2 bg-surface p-2">
                {story.scopeExclusions.map((s, i) => (
                  <div key={i} className="flex min-w-0 items-start gap-1">
                    <label htmlFor={`${TID}-scope-${i + 1}`} className="sr-only">
                      Exclusion {i + 1}
                    </label>
                    <GrowRow
                      id={`${TID}-scope-${i + 1}`}
                      testId={`${TID}-scope-${i + 1}`}
                      value={s}
                      placeholder={reference ? REFERENCE_COPY.requirements.scopePlaceholder : 'something this story leaves out'}
                      onChange={(v) => setExclusion(i, v)}
                    />
                    {marked(`story/scope/${i + 1}`)}
                    <IconButton
                      label={`Remove exclusion ${i + 1}`}
                      icon="trash"
                      onClick={() => removeExclusion(i)}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  data-testid={`${TID}-scope-add`}
                  className="flex items-center gap-1.5 self-start rounded-[6px] px-1.5 py-0.5 text-[12.5px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted"
                  onClick={addExclusion}
                  disabled={exclusionsFull}
                  title={exclusionsFull ? LIST_FULL : undefined}
                >
                  <span aria-hidden>+</span> Add an exclusion
                </button>
              </div>
            </div>
            <Box
              id={`${TID}-notes`}
              testId={`${TID}-notes`}
              label="Open questions"
              note={marked('story/notes')}
              rows={2}
              value={story.notes}
              placeholder={OPEN_QUESTIONS_NONE}
              onChange={(v) => patch({ notes: v })}
            />
          </div>

        </div>

        <footer className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3.5 gap-y-2 border-t-1.5 border-edge bg-surface px-5 py-2.5">
          <span className="flex-1" />
          {footerRight}
        </footer>
      </section>
    </div>
  );
}
