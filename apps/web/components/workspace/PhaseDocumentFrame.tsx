'use client';

import { useSyncExternalStore, type ComponentProps, type ReactNode, type Ref } from 'react';
import Link from 'next/link';
import type { PhaseDetail } from '@learnsdlc/shared';
import { DocPage, PhaseStrip, WorkPage } from '@/components/shell';
import { PersonaPanel } from '@/components/shell/PersonaPanel';
import { useInterviewAbsent } from '@/lib/scenario';
import { PhaseBriefIntro } from './PhaseBriefIntro';
import { ShellPhaseGateBanner } from './PhaseGateBanner';
import { useQuickCheckInMore } from './PhaseHeader';
import { QuickCheckLine, useClaimedQuickCheck } from './QuickCheck';
import { WorkspacePanelControls, WorkspaceMentorBoundary, useWorkspacePanels } from './WorkspacePanels';
import { scrollFocusRef, useScrollFocusRef } from '@/lib/scroll-focus';
import { AREA_VIEW_PARAM, PhaseAreaNav, inWorkFrame, type AreaPage } from './AreaNav';
import { usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import { PhaseFrameFolds, holdsFolds } from './PhaseFrameFolds';
import { frameState } from './frameState';

type Props = Omit<ComponentProps<typeof DocPage>, 'aside'> & {
 /**
  * The phase this page belongs to. The optional fields are what a code
  * phase's working-area row and door read (whether a Maintenance opens the
  * change room, and whether the phase has a preview view and what it is
  * called); a caller holding the phase's detail passes it whole.
  */
 phase: Pick<PhaseDetail,'id'|'key'|'title'> & Partial<Pick<PhaseDetail,'artifactKind'|'change'|'provenance'|'canPreview'|'previewUnsupported'|'files'|'status'|'view'|'tasks'|'lastSubmission'|'evidenceNeeded'|'notReachedYet'>>;
 view: 'change'|'pr'|'matrix'|'drill'|'brief'|'solution';
 mentor?: ReactNode;
 contentRef?: Ref<HTMLDivElement>;
 toolNav?: ReactNode;
 /**
  * A room's own sections (the change page's Request, Contract, Checks and
  * Release), drawn as a second row under the heading so the working-area row
  * above keeps one order and one set of words on every Maintenance page.
  */
 subNav?: ReactNode;
 /**
  * What this room settles before the learner is handed on, for a route that
  * has something to settle. The change request and the incident drill hold a
  * debounced workspace buffer whose only other flush leaves with the page,
  * unawaited and after the router has moved, so they pass their own; the four
  * documents that are only read pass nothing. May reject: the refusal reaches
  * the merge sheet and nothing is recorded.
  */
 onBeforeContinue?: () => Promise<void>;
 /** The band's Continue did not go ahead: a page that holds its own "Continue pressed here" lets it go. */
 onContinueFailed?: () => void;
 /**
  * The case file's words, folded in the brief panel under "Mission and review
  * criteria", for a room a phase's door opens (the change room): no door opens
  * a case file page of its own.
  */
 mission?: ReactNode;
};
// From 1024 px the room is three columns, as the workspace is; below it the
// page stacks. A browser with no matchMedia reads wide, as the server does.
const WIDE_ROOM = '(min-width: 1024px)';
const wideRoomSnapshot = () => typeof window.matchMedia !== 'function' || window.matchMedia(WIDE_ROOM).matches;
const wideRoomServerSnapshot = () => true;
function subscribeWideRoom(listener: () => void) {
 if (typeof window.matchMedia !== 'function') return () => undefined;
 const media = window.matchMedia(WIDE_ROOM);
 media.addEventListener('change', listener);
 return () => media.removeEventListener('change', listener);
}

// `frameState` lives in its own module, so the header's Submit (HeaderSubmit.tsx) reads it without this frame.
export { frameState };

/**
 * The header of a document page in the workspace's frame (every code phase).
 *
 * Mounted, it claims the optional quick check, so the phase layout draws no
 * row above the header for it, and it places the line by the workspace
 * header's own rule (`useQuickCheckInMore`): on the header's row where that
 * header keeps it on its row, inside the strip's Details where that header
 * keeps it in More. Only this frame mounts it; every other document page
 * leaves the offer on the row the phase layout draws.
 */
function WorkFrameStrip({phase,right}:{phase:Props['phase'];right:Props['right']}){
 const offer=useClaimedQuickCheck();
 const inMore=useQuickCheckInMore();
 return <PhaseStrip phase={phase} titleLevel={1} right={right} workHeader
  rowLine={inMore?undefined:<QuickCheckLine offer={offer} inline/>}
  menuLine={inMore?<QuickCheckLine offer={offer} menu/>:undefined}
  state={frameState(phase)}/>;
}

/** Specialized evidence is another view of the same phase working environment. */
export function PhaseDocumentFrame({phase,view,crumbs,nav,title,purpose,right,children,testId,titleTestId,mentor,toolNav,subNav,contentRef,onBeforeContinue,onContinueFailed,mission}:Props){
 const panels = useWorkspacePanels();
 // The document and the brief scroll; while they do, the keyboard can reach
 // them (the change page's document at 1280, for example).
 const content = useScrollFocusRef(contentRef);
 // The interview door names no persona (such as TaskTrackr's), because it is
 // drawn on every project. It says what the room is, in the words the
 // Requirements room's own tab uses.
 const base=`/workspace/${phase.id}`;
 // A Requirements phase whose teacher
 // removed the interview has no door to it.
 const noInterview=useInterviewAbsent(phase.id);
 /*
  * One frame for a code phase (Implementation, Testing, Deployment and
  * Maintenance). The document pages its working-area row leads to
  * (`inWorkFrame`: Maintenance's change request and pull request where its
  * door is the change room, Implementation's pull request, Testing's planted
  * bugs and reviews, Deployment's incident drill and reviews) are drawn in the
  * workspace's frame, so going between them and the workspace changes the
  * centre of the page and nothing around it: the workspace's working-area row
  * (same entries, order, icons, classes and label, with the brief and mentor
  * switches at its right end from 1024 px rather than on a row of their own),
  * the workspace's left column (the "Your task" and "Files" tabs over the
  * brief, as every code phase's workspace draws them), the
  * workspace's mentor with both of its modes, and the optional quick check
  * inside the header, placed by the workspace header's rule, rather than on a
  * row above it. Every other document page keeps its frame. Below 1024 px the
  * page stacks as every document page does: the switches keep their row and
  * the brief is the box it was; the row's entries, the mentor's modes and the
  * quick check's place are the same at every width.
  */
 const workFrame=inWorkFrame(phase,view);
 // The phase's tutorial is ready on every page of the frame once the page holds the phase's whole detail,
 // as on the workspace, so Details offers Replay tutorial on each of them (its steps already land on these pages,
 // tours.ts). A summary, or a page outside the frame, registers nothing.
 usePhaseTutorialReady(workFrame&&phase.status&&Array.isArray(phase.files)?{...phase,status:phase.status,files:phase.files}:null);
 // The workspace's two folds at the foot of the left column, from the detail the page holds.
 const folds=workFrame&&holdsFolds(phase)?<PhaseFrameFolds detail={phase} mission={mission}/>:mission;
 // The workspace's own two tabs over its left column, which every code phase's workspace draws.
 const leftTabs=workFrame;
 const wide=useSyncExternalStore(subscribeWideRoom,wideRoomSnapshot,wideRoomServerSnapshot);
 // The review page is "Pull request" in every code phase's row, this fallback row included.
 const routes=phase.key==='requirements'?[...(noInterview?[]:[['interview','Stakeholder interview',`${base}/interview`]]),['brief','Case file',`${base}/brief`],['issue','My backlog',`${base}/issue`]]:phase.key==='design'?[['design','Design workspace',`${base}/design`],['brief','Case file',`${base}/brief`]]:phase.key==='maintenance'?[['change','Change request',`${base}/change`],['code','Edit files',base],['pr','Pull request',`${base}/pr`]]:phase.key==='testing'?[['code','Write tests',base],['matrix','Planted bugs',`${base}/matrix`],['pr','Pull request',`${base}/pr`]]:phase.key==='deployment'?[['code','Pipeline',base],['drill','Incident drill',`${base}/drill`],['pr','Pull request',`${base}/pr`]]:[['code','Code and preview',base],['pr','Pull request',`${base}/pr`]];
 return (
  <WorkPage crumbs={crumbs} nav={nav} testId={testId} strip={workFrame?<WorkFrameStrip phase={phase} right={right}/>:<PhaseStrip phase={phase} titleLevel={1} right={right}/>}>
   {/* Every document view of a passed phase says so and offers the way on.
       All six of these routes draw the banner and the Continue control.
       A room that holds unsaved work gets to finish it first. */}
   <ShellPhaseGateBanner phaseId={phase.id} onBeforeContinue={onBeforeContinue} onContinueFailed={onContinueFailed}/>
   {!(workFrame&&wide)&&<WorkspacePanelControls panels={panels}/>}
   <div className={`phase-document-room phase-document-view-${view}${workFrame?' phase-document-room--work':''}`}>
    {workFrame&&wide
     ? <aside id={panels.briefId} data-workspace-panel="brief" hidden={!panels.briefOpen} className="phase-document-brief phase-document-brief--work">
        {/* The workspace's two tabs over its left column. Here both are links: this page is the task's (marked
            current, where the workspace marks its pressed tab), and the file tree belongs to the editor, so Files
            opens it there. Every code phase's workspace draws these tabs, so every page of
            its frame does. The brief scrolls under them, so the inner box is the one the keyboard reaches. */}
        {leftTabs&&<nav className="phase-room-nav" aria-label="Phase context"><Link href={`${base}/${view}`} aria-current="page">Your task</Link><Link href={`${base}?panel=${AREA_VIEW_PARAM.files}`}>Files</Link></nav>}
        <div className="phase-workspace-context"><div ref={scrollFocusRef} className="phase-task-content"><PhaseBriefIntro phaseKey={phase.key}/>{folds}</div></div>
       </aside>
     : <aside ref={scrollFocusRef} id={panels.briefId} data-workspace-panel="brief" hidden={!panels.briefOpen} className="phase-document-brief"><PhaseBriefIntro phaseKey={phase.key}/>{folds}</aside>}
    <section className="phase-document-center">
     {workFrame
      ? <PhaseAreaNav phase={phase} current={view as AreaPage} tools={wide?<WorkspacePanelControls panels={panels} placement="strip"/>:undefined}/>
      : <nav className="phase-room-nav" aria-label={`${phase.title} working area`}>{toolNav??routes.map(([key,label,href])=><Link key={key} href={href} aria-current={view===key?'page':undefined}>{label}</Link>)}</nav>}
     <header className="phase-document-heading"><h2 data-testid={titleTestId}>{title}</h2>{purpose&&<p>{purpose}</p>}</header>
     {subNav}
     <div ref={content} className="phase-document-content">{children}</div>
    </section>
    <aside id={panels.mentorId} data-workspace-panel="mentor" hidden={!panels.mentorOpen} className="phase-document-mentor">
     <WorkspaceMentorBoundary panels={panels}>{mentor ?? <PersonaPanel phaseKey={phase.key} phaseStateId={phase.id} guidedOnly={!workFrame}/>}</WorkspaceMentorBoundary>
    </aside>
   </div>
  </WorkPage>
 );
}
