/**
 * The tours' steps: each phase's tutorial and each page's tour, as coach marks.
 * Replayable tours explain existing controls and never act on them.
 * The replay bus (`tour-replay.ts`) and what the browser remembers about tours
 * (`tour-seen.ts`) are re-exported here, so every caller imports from this file.
 */
import { PHASE_TITLES, type PhaseKey } from '@learnsdlc/shared';
import { runsReferenceApplication } from '@/components/workspace/application';
import type { TourDesign, TourPage, TourProvenance } from './tour-seen';
export {
  COACH_KEY,
  TOUR_PAGES,
  type TourPage,
  type SeenTours,
  type PhaseTutorialScope,
  type TourProvenance,
  type TourDesign,
  phaseTutorialKey,
  phaseTutorialSeen,
  markPhaseTutorialSeen,
  readSeenTours,
  tourSeen,
  markTourSeen,
} from './tour-seen';
export { TOUR_EVENT, registerTourReplay, replayTour } from './tour-replay';

export interface CoachMark {
  target: string;
  altTarget?: string;
  /** A maintained layout selector when the target is not an individual test control. */
  selector?: string;
  /** Tried only after the primary selector has no visible control. */
  fallbackSelector?: string | string[];
  title: string;
  body: string;
  above?: boolean;
}

export function phaseTutorialTitle(key: PhaseKey): string { return `${PHASE_TITLES[key]} tutorial`; }

const PANEL_TARGET = '.workspace-panel-controls[aria-label="Workspace panels"]';

/**
 * Under 1024 px, while the code room's pane switcher (Brief, Files, Code,
 * Mentor) is up, the panel switches' own row is not drawn: the
 * switcher's Brief and Mentor do the same, so the step points at it.
 */
const PANE_SWITCHER = '[role="tablist"][aria-label="Workspace pane"]';

const RUNTIME_TARGET = '[aria-label="Phase working area"]';

/** The row's entries on a Maintenance document page, where they are links to the workspace's views. */
const EDIT_FILES_LINK = `${RUNTIME_TARGET} > a[data-view="code"]`;

const EVIDENCE_LINK = `${RUNTIME_TARGET} > a[data-view="evidence"]`;

const IMPLEMENTATION_TARGET = '[aria-label="Implementation working area"]';

/**
 * An entry of a code phase's working-area row by what it is, never by its
 * position. The workspace's view buttons and its document pages' links
 * to the same views carry the view's name (`data-view`), and a page's entry is
 * its link's address, so each step points at the same entry on the workspace
 * and on every page that draws the row, however many entries come before it
 * (the preview's, the review page's).
 *
 * The run and review steps on a document page use them as fallbacks. Run is
 * drawn on the workspace only, so on a page of the phase its step falls back
 * to the row's edit entry, the view the run belongs to; Submit is not drawn on
 * the planted bugs or the incident drill, so its step falls back to the row's
 * review page. Both come before `.phase-room-nav`, which on these pages is the
 * left column's "Your task | Files". The planted bugs page's own Submit comes
 * first where it is drawn.
 */
const rowView = (row: string, view: 'code' | 'evidence' | 'preview') => `${row} > [data-view="${view}"]`;

const rowPage = (row: string, page: 'matrix' | 'drill' | 'pr') => `${row} > a[href$="/${page}"]`;

/**
 * The work room's More toggle. A room that is ready, review passed or awaiting
 * a sign-off puts Submit inside More, so the review
 * step falls back to the menu that holds it before the room's tabs.
 */
const MORE_TOGGLE = '[data-testid="phase-more-toggle"]';

// The strip draws "Optional phase guide" only where the phase offers its
// lesson, so the last step names it, and falls back to it, only there. Every
// work room keeps Replay tutorial (and the guide) inside its header's closed
// More menu, which the tour does not open, so the step falls back to the More
// toggle itself (CoachMarks skips a target inside a closed menu). Its words
// name no menu. The document pages drawn in the workspace's frame
// (Maintenance's change request and
// pull request, Testing's planted bugs and reviews, Deployment's incident
// drill and reviews, Implementation's pull request) keep Replay tutorial and
// the guide inside their strip's closed Details, as the workspace keeps them
// in More, and draw no More toggle: on a code phase the step falls back to
// that Details' summary. Every other document
// page keeps Replay tutorial on its visible row.
const STRIP_DETAILS = '.phase-header--doc > details.phase-strip-details > summary';

const CODE_PHASES: PhaseKey[] = ['implementation', 'testing', 'deployment', 'maintenance'];

const help = (key: PhaseKey, lessons = true): CoachMark => ({ target: `${key}-tutorial-help`, selector: '[data-testid="phase-tutorial-replay"]', fallbackSelector: ['[data-testid="phase-more-toggle"]', ...(CODE_PHASES.includes(key) ? [STRIP_DETAILS] : []), lessons ? '.phase-strip-guide' : '[data-testid="phase-title"]'], title: 'Return whenever you need help', body: `Replay tutorial brings these steps back. ${lessons ? 'Optional phase guide opens the lessons. ' : ''}In the workspace mentor, Guided offers hints. Agentic proposes changes: compare them, explain this exact version in your own words, then choose Apply only if your explanation is accepted. A changed proposal needs a new explanation.` });

const mentor = (key: PhaseKey): CoachMark => ({ target: `${key}-tutorial-panels`, selector: PANEL_TARGET, fallbackSelector: PANE_SWITCHER, title: 'Keep the brief close', body: 'Show brief to revisit the task and review criteria. Show mentor opens optional guidance. You can hide either panel to make space; your work and conversations stay in their own phase.' });

/**
 * Each phase's own steps remain readable even when a tool is in a closed panel.
 *
 * Requirements' steps name no persona and no story (not "Ask Dana about the
 * overdue report" or "create or edit US-4"): these steps are shown on every
 * project, so naming TaskTrackr's would send a class on a teacher's project to
 * TaskTrackr's interview by its own tutorial.
 */
export function phaseTutorialMarks(key: PhaseKey, lessons = true, provenance?: TourProvenance, design?: TourDesign): CoachMark[] {
  // A room that is not the reference project's (its room task says so): the
  // steps name only what its pack switched on. The reference
  // project's tour, and a payload that does not say, keep every step.
  const ownRoom = Boolean(provenance?.roomTask) && provenance?.roomTask !== 'reference';
  switch (key) {
    // A phase that holds no interview draws no interview tab
    // and no Interview evidence; its tour starts at the brief.
    case 'requirements': return provenance?.interview === null ? [
      { target: 'requirements-tutorial-brief', selector: PANEL_TARGET, title: 'Start with the brief', body: 'Show brief opens the case file. Its Brief explains the task and how the review judges it. Use it to decide what the work must do.' },
      ...phaseTutorialMarks(key, lessons).slice(2),
    ] : [
      { target: 'requirements-tutorial-interview', selector: '#requirements-interview-tab', title: 'First, interview the stakeholder', body: 'Open Stakeholder interview, marked Required: your story is built from it. Ask the stakeholder what they need and why, and clarify the topics in Interview evidence before you write your story. The mentor, marked Optional, is there if you get stuck.' },
      { target: 'requirements-tutorial-brief', selector: PANEL_TARGET, title: 'Use the brief and interview evidence', body: 'Show brief opens the case file. Its Brief explains the task; Interview evidence keeps the topics settled by the conversation. Use what you learn to decide what the work must do.' },
      { target: 'requirements-tutorial-backlog', selector: '#requirements-backlog-tab', title: 'Next, shape your backlog', body: 'Open My backlog to write the story this phase asks for, beside any stories the project supplies. Write it and its acceptance criteria in its form, then choose Save story and check the save status.' },
      { target: 'requirements-tutorial-check', selector: '[data-testid="phase-requirements-render"]', fallbackSelector: '#requirements-backlog-tab', title: 'Check your saved story', body: 'In My backlog, choose Check the story to inspect its structure. Resolve missing fields before you ask for a review. A structural check does not pass the phase.' },
      { target: 'requirements-tutorial-review', selector: '[data-testid="phase-requirements-submit"]', fallbackSelector: '#requirements-backlog-tab', title: 'Submit, read feedback, revise', body: 'Submit sends the saved story. Open the backlog’s Review view for its actual feedback. Revise the story and resubmit when needed; only a recorded passing review opens the next phase.' }, help(key, lessons),
    ];
    case 'design': if (ownRoom && design) return ownDesignMarks(design, help(key, lessons));
      return [
      designModelMark(1),
      designContractsMark(2),
      designSequenceMark(3, true),
      { target: 'design-tutorial-decisions', selector: designTab(4), fallbackSelector: '.phase-room-nav', title: 'Explain your design decisions', body: 'Use Decisions to record why you chose this design and what tradeoffs it makes. Keep the explanation consistent with the model and contracts.' },
      designReviewMark(5), help(key, lessons),
    ];
    case 'implementation': return [
      // A teacher's own application has no Design contracts to implement: its step names the brief.
      runsReferenceApplication(provenance) ? { target: 'implementation-tutorial-code', selector: rowView(IMPLEMENTATION_TARGET, 'code'), fallbackSelector: '.phase-room-nav', title: 'Implement the agreed contracts', body: 'Open Code and use Files to inspect the supplied project. Work in the editable files for this task, using the contracts and brief to guide your changes. Watch the save status as you edit.' } : { target: 'implementation-tutorial-code', selector: rowView(IMPLEMENTATION_TARGET, 'code'), fallbackSelector: '.phase-room-nav', title: 'Work in the editable files', body: 'Open Code and use Files to inspect the supplied project. Work in the editable files for this task, using the brief to guide your changes. Watch the save status as you edit.' },
      { target: 'implementation-tutorial-run', selector: '[data-testid="header-run"]', fallbackSelector: [rowView(IMPLEMENTATION_TARGET, 'code'), '.phase-room-nav'], title: 'Run the tests', body: 'Choose Run tests when you are ready to check your work. Read the actual output and failures. If execution is unavailable, it provides no successful result; keep that limitation visible.' },
      // A teacher's own application has no App
      // preview button, so the step is left out.
      ...(runsReferenceApplication(provenance) ? [{ target: 'implementation-tutorial-preview', selector: rowView(IMPLEMENTATION_TARGET, 'preview'), fallbackSelector: '.phase-room-nav', title: 'Inspect the app preview', body: 'App preview shows the app when a supported runtime is available. Use the preview’s run control to start it yourself. An idle, failed or unavailable preview is not evidence that the app works.' }] : []),
      mentor(key),
      { target: 'implementation-tutorial-review', selector: '[data-testid="header-submit"]', fallbackSelector: [MORE_TOGGLE, rowPage(IMPLEMENTATION_TARGET, 'pr'), '.phase-room-nav'], title: 'Submit the saved implementation', body: 'Submit your saved version for review. Open its feedback and exact submitted files, revise the identified behavior, then run and submit again as needed. Running tests alone does not pass the phase.' }, help(key, lessons),
    ];
    case 'testing': return [
      { target: 'testing-tutorial-suite', selector: rowView(RUNTIME_TARGET, 'code'), fallbackSelector: '.phase-room-nav > :first-child', title: 'Write the test suite', body: 'Open Write tests and choose an editable test file. Cover the required behavior and edge cases from the brief, then check that your work has saved.' },
      { target: 'testing-tutorial-run', selector: '[data-testid="header-run"]', fallbackSelector: [rowView(RUNTIME_TARGET, 'code'), '.phase-room-nav'], title: 'Run and inspect the tests', body: 'Run tests executes the suite when the runner is available. Open Execution evidence to read the actual output. A failed or unavailable run needs attention before it can support your review.' },
      // The planted bugs' own entry. By position (the third) this step landed on App preview wherever the room has
      // one (TaskTrackr's Testing does), and on Planted bugs only where it has none.
      { target: 'testing-tutorial-mutations', selector: rowPage(RUNTIME_TARGET, 'matrix'), fallbackSelector: '.phase-room-nav a[href$="/matrix"]', title: 'Challenge your tests with planted bugs', body: 'Open Test coverage to inspect which planted bugs the suite detects. Use the available run control when you choose to test it; a surviving bug points to behavior your assertions may not cover.' },
      mentor(key),
      { target: 'testing-tutorial-review', selector: '[data-testid="header-submit"]', fallbackSelector: [MORE_TOGGLE, '[data-testid="phase-testing-submit"]', rowPage(RUNTIME_TARGET, 'pr'), '.phase-room-nav'], title: 'Submit tests with their evidence', body: 'Submit your saved tests for review and read the recorded feedback. Strengthen assertions that miss behavior, then check and submit again. An empty evidence view is not a passing result.' }, help(key, lessons),
    ];
    case 'deployment': return [
      { target: 'deployment-tutorial-config', selector: rowView(RUNTIME_TARGET, 'code'), fallbackSelector: '.phase-room-nav > :first-child', title: 'Inspect the release configuration', body: 'Open Configuration to work through the pipeline and configuration files. Use the brief to understand what this isolated deployment exercise checks.' },
      { target: 'deployment-tutorial-selfcheck', selector: '[data-testid="header-run"]', fallbackSelector: [rowView(RUNTIME_TARGET, 'code'), '.phase-room-nav'], title: 'Run the configuration selfcheck', body: 'Run selfcheck checks the saved configuration when its runner is available. It does not demonstrate Docker builds, CI execution, Compose startup or live HTTP health probes.' },
      { target: 'deployment-tutorial-evidence', selector: rowView(RUNTIME_TARGET, 'evidence'), fallbackSelector: '.phase-room-nav > :first-child', title: 'Read the pipeline evidence', body: 'Open Pipeline for the actual check output. Use failures to revise the configuration. If the runner is unavailable, no successful execution can be claimed.' },
      { target: 'deployment-tutorial-drill', selector: rowPage(RUNTIME_TARGET, 'drill'), fallbackSelector: '.phase-room-nav a[href$="/drill"]', title: 'Work through the incident drill', body: 'Open Incident drill to inspect its evidence, choose an investigation action and explain your response. The drill stays separate from a real deployment.' },
      { target: 'deployment-tutorial-review', selector: '[data-testid="header-submit"]', fallbackSelector: [MORE_TOGGLE, rowPage(RUNTIME_TARGET, 'pr'), '.phase-room-nav'], title: 'Submit the saved release work', body: 'Submit the saved configuration and required evidence for review. Revisit specific feedback before resubmitting; only a valid passing review completes the phase.' }, help(key, lessons),
    ];
    case 'maintenance': {
      // The runtime nav is [Change request, Edit files, Execution evidence,
      // preview, Pull request]; an own application's room may draw no
      // Change request and no preview, so the steps aim at the link's address
      // and at the first and second buttons, never at a position that shifts.
      // TaskTrackr's tour keeps every step.
      // On the change request and the pull request the same row is
      // drawn as links (`data-view` names the view a link opens), so the
      // steps that aim at a view's button name its link there as well and
      // point at the same entry on all three pages.
      const reference = runsReferenceApplication(provenance);
      return [
        // The first step is true for the page as it opens. On the change request page it points at the
        // request itself (its heading), not at a control that opens it or at the icon-only panel switches; elsewhere at
        // the row's Change request; and only where the room draws no change request at all, at the brief's switch. Its
        // words name no control, so they are true at each of those places.
        { target: 'maintenance-tutorial-change', selector: '[data-testid="change-title"]', fallbackSelector: [`${RUNTIME_TARGET} a[href$="/change"]`, '.phase-document-view-change .phase-room-nav > :first-child', '.phase-room-nav a[href$="/change"]', ...(reference ? [] : [PANEL_TARGET, PANE_SWITCHER])], title: reference ? 'Understand the change request' : 'Understand the requested change', body: reference ? 'Read the change request: the behavior that must change, its constraints, and the existing behavior that must keep working.' : 'Read what this change asks for: the behavior that must change, its constraints, and the existing behavior that must keep working.' },
        reference ? { target: 'maintenance-tutorial-files', selector: `${RUNTIME_TARGET} > button:first-of-type, ${EDIT_FILES_LINK}`, fallbackSelector: '.phase-room-nav > :nth-child(2)', title: 'Make a focused change', body: 'From Change request, open Edit files. It holds the editable files for this request. Keep the change small enough to explain and check the save status before testing.' } : { target: 'maintenance-tutorial-files', selector: `${RUNTIME_TARGET} > button:first-of-type, ${EDIT_FILES_LINK}`, title: 'Make a focused change', body: 'Open Edit files. It holds the editable files for this change. Keep the change small enough to explain and check the save status before testing.' },
        reference ? { target: 'maintenance-tutorial-check', selector: '[data-testid="header-run"]', fallbackSelector: [EDIT_FILES_LINK, '.phase-document-view-change .phase-room-nav > :nth-child(2)', '.phase-room-nav'], title: 'Check for regressions', body: 'Open Edit files to run tests when the runner is available, then inspect Execution evidence. Use failures to revise the change; an unavailable run supplies no regression evidence.' } : { target: 'maintenance-tutorial-check', selector: '[data-testid="header-run"]', fallbackSelector: `${RUNTIME_TARGET} > button:nth-of-type(2), ${EVIDENCE_LINK}`, title: 'Check for regressions', body: 'Run tests when the runner is available, then open Execution evidence. Use failures to revise the change; an unavailable run supplies no regression evidence.' },
        reference ? { target: 'maintenance-tutorial-pr', selector: `${RUNTIME_TARGET} a[href$="/pr"]`, fallbackSelector: '.phase-room-nav a[href$="/pr"]', title: 'Explain the pull request', body: 'Open Pull request to review saved changes and their evidence. Explain the intended effect, compatibility risks and checks so the change can be assessed.' } : { target: 'maintenance-tutorial-pr', selector: `${RUNTIME_TARGET} a[href$="/pr"]`, title: 'Explain the pull request', body: 'Open Pull request to review your saved changes and their evidence. Explain the intended effect, compatibility risks and checks so the change can be assessed.' },
        { target: 'maintenance-tutorial-review', selector: '[data-testid="header-submit"], [data-testid="phase-maintenance-submit"]', fallbackSelector: [MORE_TOGGLE, '.phase-room-nav'], title: 'Use the review to finish the change', body: 'Submit your saved work when ready. Read the recorded feedback and revise any gaps before submitting again. A documentation edit or successful test run alone does not complete the phase.' }, help(key, lessons),
      ];
    }
  }
}

/** The Design room's tab at place `n` (from 1) in its working-area row. */
const designTab = (n: number) => `[aria-label="Design working area"] > :nth-child(${n})`;

/**
 * The Design steps both Design tours share, each aimed at the tab at place `n`. The Sequence step
 * names the contracts only where the API contract is drawn; the Review step points at Submit, or
 * at the Review tab at place `n`.
 */
const designModelMark = (n: number): CoachMark => ({ target: 'design-tutorial-model', selector: designTab(n), fallbackSelector: '.phase-room-nav', title: 'Start with the UML model', body: 'Open UML model to inspect and edit the model’s fields and operations. Use the accepted requirements and phase brief to decide what the model must represent.' });

const designContractsMark = (n: number): CoachMark => ({ target: 'design-tutorial-contracts', selector: designTab(n), fallbackSelector: '.phase-room-nav', title: 'Define the API contracts', body: 'Open API contracts. Record each operation’s inputs, outputs and error cases, and finish any open contract form before leaving it.' });

const designSequenceMark = (n: number, contracts: boolean): CoachMark => ({ target: 'design-tutorial-sequence', selector: designTab(n), fallbackSelector: '.phase-room-nav', title: 'Trace a sequence', body: `Open Sequence diagram to describe how the parts interact. Check that the messages match your ${contracts ? 'contracts and model' : 'model'}.` });

const designReviewMark = (n: number): CoachMark => ({ target: 'design-tutorial-review', selector: '[data-testid="design-submit"]', fallbackSelector: `${designTab(n)}, .phase-room-nav`, title: 'Review the design as a whole', body: 'Open Review to inspect inconsistencies, check the saved design, then choose Submit. Use the returned evidence to revise any gaps before trying again.' });

/**
 * The Design tour of a room that is not the reference project's:
 * a step for each tab the room draws (`designTabs`: UML model, the API
 * contract, the Screens and the Sequence diagram only while the pack switched
 * them on, Decisions, Review), each aimed at that tab's own place in the row.
 * The API contract step keeps the reference tour's words; the Sequence step
 * names contracts only where the API contract is on; the Decisions step names
 * no contract.
 */
function ownDesignMarks(design: NonNullable<TourDesign>, last: CoachMark): CoachMark[] {
  const marks: CoachMark[] = [designModelMark(1)];
  let n = 1;
  if (design.contracts.api) marks.push(designContractsMark(++n));
  if (design.contracts.screens) n += 1;
  if (design.sequence) marks.push(designSequenceMark(++n, design.contracts.api));
  marks.push(
    { target: 'design-tutorial-decisions', selector: designTab(++n), fallbackSelector: '.phase-room-nav', title: 'Explain your design decisions', body: 'Use Decisions to record a choice worth explaining and what it trades away. Keep it consistent with the rest of your design.' },
    designReviewMark(++n),
    last,
  );
  return marks;
}

export function tourPageFromPath(pathname: string | null | undefined): TourPage | undefined {
  if (!pathname) return undefined;
  const path = pathname.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (path === '/dashboard') return 'home';
  if (path === '/progress' || path === '/profile' || path === '/learn') return path.slice(1) as TourPage;
  if (/^\/learn\/[^/]+$/.test(path)) return 'lesson';
  const workspace = /^\/workspace\/[^/]+(?:\/([^/]+))?$/.exec(path);
  if (workspace) {
    if (workspace[1] === 'interview') return 'issue';
    if (workspace[1] === 'brief' || workspace[1] === 'issue' || workspace[1] === 'design') return workspace[1];
    return 'ide';
  }
  return 'page';
}

const NAV: CoachMark = { target: 'sidebar', altTarget: 'rail', selector: '.shell-primary-nav [aria-current="page"]', title: 'Move between your pages', body: 'Use the navigation to return to your pages. Project phases keep their normal access rules; this tour does not open or complete any work.' };

const SEARCH: CoachMark = { target: 'jump-to', title: 'Find a page quickly', body: 'Search for a page or an available project space. You can also find Show me around here to replay the tour of the page you are on.' };

const ACCOUNT: CoachMark = { target: 'nav-user', title: 'Your account and appearance', body: 'Open your account menu for your profile, settings, appearance and sign out. Show me around is always here when you want another look.' };

export const DEFAULT_MARKS: CoachMark[] = [
  { target: 'dashboard-resume', selector: '.exp-resume .exp-actions', title: 'Pick up your project', body: 'Your current phase and next project action live here. Continue opens the appropriate phase space without skipping its gate.' },
  { target: 'dashboard-journey', selector: '.exp-dashboard-journey .exp-section-heading', title: 'See the phase journey', body: 'See where each phase of your project stands. A phase passes only when its submitted work receives a valid passing review.' }, NAV, ACCOUNT,
];

export const PROGRESS_MARKS: CoachMark[] = [
  { target: 'progress-summary', selector: '.exp-progress-page .exp-hero .exp-stats', title: 'Your progress, in view', body: 'This summary counts recorded submissions and verified phase passes. Continue my project returns to your available work; the completion record shows what you have earned so far.' },
  { target: 'progress-chart', selector: '.exp-progress-page .exp-review-dot, .exp-progress-page .exp-journey-empty', title: 'Every review has a place', body: 'Each point represents one saved submission. After this tour, focus or hover over a point for its details, then select it to open that exact work and feedback. With no reviews yet, the chart stays empty.' },
  { target: 'progress-path', selector: '.exp-progress-page .exp-phase-path > :first-child', title: 'Follow your phase gates', body: 'The phase path shows your current phase and the phases ahead. Complete the required review before the next phase opens.' },
  { target: 'progress-history', selector: '.exp-progress-page .exp-panel:last-child .exp-section-heading', title: 'Return to earlier feedback', body: 'Submission history keeps earlier reviews, including attempts that needed revision. Open a row to revisit its saved evidence rather than your current draft.' }, ACCOUNT,
];

export const BRIEF_MARKS: CoachMark[] = [
  { target: 'brief-page', selector: '[data-testid="brief-page"] h1, .phase-brief-card h2, [data-testid="phase-title"]', title: 'Read the phase brief', body: 'Start with the task, supplied material and review criteria. These explain what this phase asks you to learn and submit.' },
  { target: 'go-to-workspace', title: 'Open the phase space', body: 'Go to the workspace takes you into this phase when it is available. Reading this tour does not change the phase gate.' }, ACCOUNT,
];

export const ISSUE_MARKS: CoachMark[] = [
  // The three steps below name no story and no persona, so they fit any project.
  { target: 'interview-page', selector: '[data-testid="interview-composer"]', title: 'Ask the stakeholder', body: 'Use the interview to understand what the stakeholder needs before writing your story. Questions and reviewed replies stay in this conversation; a reply may settle one of the topics in your brief.' },
  { target: 'requirements-primary-tabs', selector: '[aria-label="Requirements workspace"]', title: 'Interview and backlog', body: 'Use Interview to ask the stakeholder what they need. My backlog is where you create or edit your story.' },
  { target: 'requirements-backlog', selector: '.jira-backlog-room .jira-backlog-heading', title: 'Write the story in its form', body: 'Open your story to edit it and its acceptance criteria. Choose Save story, then check the save status before leaving.' },
  { target: 'workspace-panel-controls', selector: '.workspace-panel-controls[aria-label="Workspace panels"]', title: 'Make space for your work', body: 'Show or hide the brief and mentor independently. Hiding a panel keeps its draft and conversation; opening the tour does not send a question.' }, ACCOUNT,
];

export const DESIGN_MARKS: CoachMark[] = [
  { target: 'phase-design-editor', selector: '[aria-label="Design working area"]', title: 'Explore the design tools', body: 'Switch between the data model, API contracts and design notes. Use the supplied examples and your phase brief to explain your choices.' },
  { target: 'workspace-panel-controls', selector: '.workspace-panel-controls[aria-label="Workspace panels"]', title: 'Choose the panels you need', body: 'The brief and mentor can be shown or hidden independently. On a narrow screen, focus on one part of the workspace at a time.' }, ACCOUNT,
];

export const IDE_MARKS: CoachMark[] = [
  { target: 'requirements-workspace', title: 'Two parts of Requirements', body: 'Interview lets you question the stakeholder. My backlog holds your story and its editing form. The tour only points things out; it does not send questions or edit a story.' },
  { target: 'editor-host', selector: '[aria-label="Implementation working area"], [aria-label="Phase working area"]', title: 'Choose your work view', body: 'Use these tabs to move between the work and its preview or execution evidence. Watch the save status when editing files, and keep changes within this phase’s task.' },
  { target: 'phase-document-workspace', selector: '[aria-label="Maintenance working area"], [data-testid="back-workspace"], [data-testid="pr-tab-conversation"]', title: 'Your phase workspace', body: 'Use the tools and supplied evidence for this phase. Run or review controls perform real work only when you choose them after the tour.' },
  { target: 'workspace-panel-controls', selector: '.workspace-panel-controls[aria-label="Workspace panels"]', title: 'Show the brief or mentor', body: 'Use these controls to make more room. The optional mentor belongs to this phase and does not replace your own work.' },
  { target: 'header-run', title: 'Run before reviewing', body: 'Run checks the current saved work and shows its actual output. A successful run is useful evidence; it does not itself pass the phase.' },
  { target: 'header-submit', title: 'Submit a saved version', body: 'Submit asks for a review of the saved version. Its result and evidence are kept in your history, including attempts that need revision.' }, ACCOUNT,
];

export function marksFor(page: TourPage): CoachMark[] {
  switch (page) {
    case 'home': return DEFAULT_MARKS;
    case 'progress': return PROGRESS_MARKS;
    case 'profile': return [
      { target: 'profile-portrait', selector: '.exp-profile-hero .exp-portrait-button', title: 'Make this profile yours', body: 'Choose your portrait and check how your name appears. Your profile also shows whether you are learning independently or with a class.' },
      { target: 'profile-form', selector: '.exp-profile-page .exp-form .exp-field', title: 'Save profile changes', body: 'Edit your details, then save. If a save fails, your draft stays available for recovery; check the notice before replacing it.' }, ACCOUNT,
    ];
    case 'learn': return [
      { target: 'learn-catalogue', selector: '[data-testid="learn-catalogue"] .learn-library-hero h2', title: 'Your optional learning library', body: 'Explore the phase guides your project offers, with authored explanations, examples and exercises. You can read a guide without passing its project phase.' },
      { target: 'learn-guides', selector: '.learn-phase-list > li:first-child > a', title: 'Choose a guide', body: 'Open the guide you need and return to it as your project grows. Reading a lesson does not submit work or change your phase status.' }, NAV,
    ];
    case 'lesson': return [
      { target: 'lesson-chapters', selector: '.lesson-chapters > button[aria-current="step"]', title: 'Move between chapters', body: 'Choose a chapter or use Next chapter below the article. Your selected chapter is part of the page address, so Back and shared links keep your place.' },
      { target: 'lesson-article', selector: '.lesson-article > h2', title: 'Learn, try, and check', body: 'Read the worked examples and diagrams, try the practice questions, then reveal the rationale. These authored lessons work without a chat.' },
      { target: 'lesson-actions', selector: '.lesson-actions', title: 'Help when you want it', body: 'Ask the optional lesson mentor for guidance. If your project phase is available, Open project space returns you to the actual task.' }, ACCOUNT,
    ];
    case 'brief': return BRIEF_MARKS;
    case 'issue': return ISSUE_MARKS;
    case 'design': return DESIGN_MARKS;
    case 'ide': return IDE_MARKS;
    default: return [NAV, SEARCH, ACCOUNT];
  }
}
