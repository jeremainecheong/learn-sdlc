// @vitest-environment jsdom
/**
 * The Requirements and Design rooms: the backlog's words and chips, the
 * frame sheet, announcing an Apply, and a stalled review (Design's Submit
 * staying in the room is in design-submit.test.tsx).
 *
 * The REAL RequirementsWorkspace is mounted over the shell's seam, as in
 * signoff-chip-wiring, with the real `useAgentWorkspace`, so an applied
 * proposal is announced the way the mentor announces one (`refreshAgentWorkspace`).
 */
import { act, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moduleText, webSource } from './support/source-text';
import type { EnrollmentView, FieldChange, InterviewFactView, InterviewTurn, PhaseDetail, PhaseKey, PhaseSummary } from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR, EMPTY_STORY, STORY_JSON, serialiseStory } from '@learnsdlc/shared';

const PHASE_ID = 's21-requirements';
const rig = vi.hoisted(() => ({
  project: null as unknown,
  request: vi.fn(),
  push: vi.fn(),
  pathname: '/workspace/s21-requirements/issue',
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: 's21-requirements' }),
  usePathname: () => rig.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: rig.push, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => rig.project,
  useProjectMaybe: () => rig.project,
  invalidateProject: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  request: rig.request,
}));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
// The crumbs a page hands the shell, read where the shell takes them; the shell still gets them.
const shellSeen = vi.hoisted(() => ({ crumbs: [] as { label: string; href?: string }[] }));
vi.mock('@/components/shell/ShellProvider', async (original) => {
  const real = await original<typeof import('@/components/shell/ShellProvider')>();
  return { ...real, useShellConfig: (config: Parameters<typeof real.useShellConfig>[0]) => { shellSeen.crumbs = (config.crumbs ?? []) as typeof shellSeen.crumbs; real.useShellConfig(config); } };
});
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));
vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 's21-learner', role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
  // the save belongs to this sign-in, so "Check the story" can save
  getSession: () => ({ id: 's21-learner', role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
}));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));

import { TOKEN_KEY } from '@/lib/session';
import { api } from '@/lib/api';
import { APPLIED_NOTICE, RequirementsWorkspace, storyCheckedNotice, storyStatusTone } from '@/components/workspace/requirements/RequirementsWorkspace';
import { REVIEW_STEPS } from '@/components/workspace/ReviewSteps';
import { refreshAgentWorkspace } from '@/components/workspace/mentor/useAgentWorkspace';
import { Room, interviewCountSentence, settledTopicLabel } from '@/components/workspace/interview/Room';
import { StoryCard } from '@/components/workspace/panels/requirements/StoryCard';
import { designCompareDocuments, designValueText } from '@/components/workspace/panels/design/designChanges';

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const STORY = serialiseStory({ ...EMPTY_STORY, id: 'US-1', title: 'Overdue task badge', persona: 'team member', capability: 'an overdue badge', benefit: 'I see what is late' });

function phaseDetail(provided: boolean): PhaseDetail {
  return {
    id: PHASE_ID, key: 'requirements', order: 1, title: 'Requirements', status: 'in_progress',
    attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null,
    projectSlug: 'deadline-badge', intro: 'Write the story.', taskPanel: 'The brief.', objectives: [], artifactKind: 'story',
    files: [{ path: STORY_JSON, content: STORY, editable: true, language: 'json' }],
    story: {
      id: 'US-1', hints: {}, floor: DEFAULT_STORY_FLOOR,
      providedStories: provided ? [{ id: 'SH-1', title: 'Browse the list', persona: 'member', capability: 'to browse', benefit: 'I find a task' }] : [],
    },
    rubric: { passThreshold: 70, criteria: [{ key: 'c1', title: 'Story', description: '', weight: 1 }] },
    tasks: [], taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
    canRun: false, canPreview: false, runLabel: 'Run tests', links: [],
    lastSubmission: null,
    updatedAt: '2026-11-17T03:00:00.000Z', workspaceUpdatedAt: '2026-11-17T02:50:00.000Z',
    stakeholder: { name: 'Team Lead', role: 'plans the team\'s week' }, scenario: 'own',
  } as unknown as PhaseDetail;
}

function shell(detail: PhaseDetail) {
  const phases = KEYS.map((key, at) =>
    at === 0
      ? ({ ...detail, view: undefined } as unknown as PhaseSummary)
      : ({ id: `s21-${key}`, key, order: at + 1, title: key[0].toUpperCase() + key.slice(1), status: 'locked', attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null, scenario: 'own' } as PhaseSummary),
  );
  const enrollment = {
    id: 's21-enrolment', projectSlug: 'deadline-badge', projectTitle: 'Deadline badge', currentPhaseOrder: 1, completed: false,
    startedAt: '2026-11-17T00:00:00Z', completedAt: null, projectIsDefault: false, phases,
  } as unknown as EnrollmentView;
  return { enrollment, currentPhase: phases[0], details: { [PHASE_ID]: detail }, analytics: null, loading: false, revalidating: false, error: '', reload: () => Promise.resolve() };
}

let host: HTMLDivElement;
let root: Root;
const reads: string[] = [];
beforeEach(() => {
  rig.pathname = `/workspace/${PHASE_ID}/issue`;
  rig.push.mockReset();
  rig.request.mockReset();
  reads.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(TOKEN_KEY, 's21-learner-token');
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(provided = true, over: Partial<PhaseDetail> = {}) {
  const detail = { ...phaseDetail(provided), ...over } as PhaseDetail;
  rig.project = shell(detail);
  rig.request.mockImplementation(async (method: string, path: string) => {
    reads.push(`${method} ${path}`);
    if (method === 'GET' && path === `/phases/${PHASE_ID}`) return detail;
    if (method === 'PUT' && path === `/phases/${PHASE_ID}/workspace`) return { saved: true, version: '2026-11-17T03:00:01.000Z' };
    if (path.includes('/interview')) return { persona: { name: 'Team Lead', role: 'Lead' }, opening: 'Ask me.', startedAt: null, turns: [], facts: [], factsExpected: 0, turnsLeft: 10, closedAt: null };
    return [];
  });
  await act(async () => { root.render(<RequirementsWorkspace phaseId={PHASE_ID} />); });
  await act(async () => { await Promise.resolve(); });
}
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const backlogNotice = () => host.querySelector('#requirements-backlog-panel .ui-notice')?.textContent ?? null;

describe('the record rooms\' breadcrumbs agree', () => {
  it('Requirements reads "<project> › Requirements › Requirements workspace", as Design reads "… › Design › Design workspace"', async () => {
    await mount();
    expect(shellSeen.crumbs.map((one) => [one.label, one.href ?? null])).toEqual([
      ['Deadline badge', '/dashboard'],
      ['Requirements', '/phases?phase=requirements'],
      ['Requirements workspace', null],
    ]);
    // Design's own crumbs are read off the rendered Design room in `design-room-header.test.tsx`.
  });
});

/*
 * The Requirements review hands the shared review the phase it holds, so a floor rule
 * the teacher set to 0 reads "Not required" in the Review view as on the pull request page. Fails if the call site
 * stops passing `floors={detail}` (the row then reads Passed).
 */
describe('the Review view reads a floor of 0 as "Not required"', () => {
  it('from the phase the room holds', async () => {
    const zero = { id: 'story.scope.min', label: 'At least 0 out-of-scope items', status: 'passed', detail: '0 out-of-scope items' };
    const reviewed = {
      id: 'review-floor', taskKey: null, status: 'completed', passed: true, score: 100, attempt: 1, createdAt: '2026-11-17T02:55:00.000Z',
      report: {
        assessmentMode: 'strict_binary', overall: 100, passed: true,
        criteria: [{ key: 'c1', title: 'Story', weight: 1, score: 100, evidence: ['✓ The story record', '✓ At least 0 out-of-scope items'] }],
        checks: [zero],
        aiReview: { verdict: 'pass', summary: 'Fine.', strengths: [], improvements: [], processNote: '', provider: 'openai', criteriaEvidence: [] },
        aiReliance: { hintsThisPhase: 0, index: 0 },
        integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
      },
    };
    const base = phaseDetail(true);
    await mount(true, {
      lastSubmission: reviewed as unknown as PhaseDetail['lastSubmission'],
      story: { ...base.story!, floor: { ...DEFAULT_STORY_FLOOR, minExclusions: 0 } },
    });
    const nav = host.querySelector('nav[aria-label="Backlog views"]')!;
    act(() => Array.from(nav.querySelectorAll('button')).find((one) => one.textContent === 'Review')!.click());
    const chip = byTestId('check-not-required');
    expect(chip?.textContent).toBe('Not required');
    expect(chip!.closest('tr')!.textContent).toContain('At least 0 out-of-scope items');
  });
});

describe('an Apply in Requirements is announced on the page, as in Design', () => {
  it('the notice Design shows, in the backlog\'s notice place, and the room turns to the backlog from the interview', async () => {
    rig.pathname = `/workspace/${PHASE_ID}/interview`;
    await mount();
    expect(backlogNotice()).toBeNull();
    const before = reads.filter((one) => one === `GET /phases/${PHASE_ID}`).length;
    await act(async () => { await refreshAgentWorkspace(PHASE_ID); });
    expect(reads.filter((one) => one === `GET /phases/${PHASE_ID}`).length).toBeGreaterThan(before);
    expect(backlogNotice()).toBe(APPLIED_NOTICE);
    expect(APPLIED_NOTICE).toBe('The reviewed proposal is saved in this workspace.');
    expect(rig.push).toHaveBeenCalledWith(`/workspace/${PHASE_ID}/issue`, { scroll: false });
  });

  it('on the backlog already: the notice, and the Backlog view rather than the Review view; no navigation', async () => {
    await mount();
    const nav = host.querySelector('nav[aria-label="Backlog views"]')!;
    act(() => Array.from(nav.querySelectorAll('button')).find((one) => one.textContent === 'Review')!.click());
    await act(async () => { await refreshAgentWorkspace(PHASE_ID); });
    expect(backlogNotice()).toBe(APPLIED_NOTICE);
    expect(nav.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Backlog');
    expect(rig.push).not.toHaveBeenCalled();
  });
});

describe('"Check the story" answers as "Check the design" does, under one heading', () => {
  it('the notice counts the checks; the Review view has one heading over them', async () => {
    await mount();
    await act(async () => { byTestId('phase-requirements-render')!.click(); });
    await act(async () => { await Promise.resolve(); });
    const rows = host.querySelectorAll('[data-testid^="phase-requirements-rule-"]');
    const passing = Array.from(rows).filter((row) => (row.textContent ?? '').includes('Passed')).length;
    expect(rows.length).toBeGreaterThan(0);
    expect(backlogNotice()).toBe(`Story checked: ${passing} of ${rows.length} checks pass.`);
    expect(host.textContent).not.toContain('Saved your story');
    expect(host.textContent).not.toContain('Draft structure checks');
    const review = host.querySelector('.jira-backlog-review')!;
    // the headings drawn over the review's parts, in order: one over the checks, one over the story
    expect(Array.from(review.querySelectorAll('h3, .h3')).map((one) => one.textContent)).toEqual(['Story checks', 'Story evidence']);
  });

  it('the words, for any count', () => {
    expect(storyCheckedNotice(5, 5)).toBe('Story checked: 5 of 5 checks pass.');
    expect(storyCheckedNotice(0, 1)).toBe('Story checked: 0 of 1 check passes.');
    expect(storyCheckedNotice(0, 0)).toBe('Your story is saved.');
  });
});

describe('the backlog\'s words, chips and footer', () => {
  it('no supplied story, no sentence about supplied stories', async () => {
    await mount(false);
    expect(host.querySelector('.jira-list-note')?.textContent).toBe('This story is yours to define.');
  });

  it('with a supplied story, the sentence stays', async () => {
    await mount(true);
    expect(host.querySelector('.jira-list-note')?.textContent).toBe('This story is yours to define. The supplied stories remain part of the project contract.');
  });

  it('one state, one chip: the header, the backlog row and the story dialog draw "In progress" alike', async () => {
    await mount();
    const header = byTestId('phase-state')!;
    const row = byTestId('phase-requirements-story-status')!;
    expect(row.textContent).toBe('In progress');
    expect(row.className).toBe(header.className);
    expect(row.className).toContain('chip-outline');
    act(() => host.querySelector<HTMLButtonElement>('.jira-own-story')!.click());
    const dialogChip = byTestId('phase-requirements-story-status-dialog')!;
    expect(dialogChip.textContent).toBe('In progress');
    expect(dialogChip.className).toBe(header.className);
  });

  it('"Add to backlog", not "Create issue", beside "Edit your story"', async () => {
    await mount();
    const labels = Array.from(host.querySelectorAll('#requirements-backlog-panel button')).map((one) => (one.textContent ?? '').trim());
    expect(labels).toContain('Add to backlog');
    expect(labels).toContain('Edit your story');
    expect(host.textContent).not.toContain('Create issue');
  });

  it('the footer says the save state in Design\'s words', async () => {
    await mount();
    expect(host.querySelector('.jira-backlog-footer [data-testid="save-state"]')?.textContent).toBe('Saved');
    expect(host.textContent).not.toContain('Saved work follows your project');
  });

  it('the tones follow the header\'s state chip', () => {
    const none = { credited: false, passed: false, awaiting: false };
    expect(storyStatusTone('In progress', none)).toBe('outline');
    expect(storyStatusTone('In review', none)).toBe('outline');
    expect(storyStatusTone('Needs revision', none)).toBe('accent');
    expect(storyStatusTone('Review passed', { ...none, passed: true })).toBe('pass');
    expect(storyStatusTone('Credit awarded', { ...none, passed: true, credited: true })).toBe('warn');
    expect(storyStatusTone("Awaiting your teacher's sign-off", { ...none, awaiting: true })).toBe('neutral');
  });
});

describe('an empty "Open questions" reads as none, not as a missing part', () => {
  it('the story card says None, and the box says none yet before anything is typed', async () => {
    const card = renderToStaticMarkup(<StoryCard story={{ ...EMPTY_STORY, notes: '' }} full />);
    expect(card.replace(/<[^>]+>/g, '|')).toContain('|Open questions|None|');
    expect(renderToStaticMarkup(<StoryCard story={{ ...EMPTY_STORY, notes: 'Badge colour?' }} full />)).toContain('Badge colour?');
    await mount();
    act(() => host.querySelector<HTMLButtonElement>('.jira-own-story')!.click());
    const box = host.querySelector<HTMLTextAreaElement>('[data-testid="phase-requirements-notes"]')!;
    expect(box.getAttribute('placeholder')).toBe('None yet. Write here any question the stakeholder left unanswered.');
    expect(host.querySelector('label[for="phase-requirements-notes"]')?.textContent ?? box.closest('div')?.textContent).toContain('Open questions');
  });
});

describe('the interview says the pack\'s two numbers and draws the settled topics as chips', () => {
  const facts = [
    { id: 'F1', topic: 'US-1: who it is for', uncovered: true },
    { id: 'F2', topic: 'US-1/AC-1: a task due yesterday', uncovered: true },
    { id: 'F3', topic: 'US-1: what is out of scope', uncovered: false },
  ] as InterviewFactView[];
  const room = (turns: InterviewTurn[], expected?: number) => renderToStaticMarkup(
    <Room persona={{ name: 'Team Lead', role: 'Lead' }} opening="Ask me." turns={turns} facts={facts} factsExpected={expected}
      outgoing={[]} onRetry={() => undefined} canRetry busy={false} scrollRef={createRef<HTMLDivElement>()} />,
  );

  it('seven topics, five enough: neither number is said as the other', () => {
    expect(interviewCountSentence(7, 5)).toBe('Seven things can be settled; five are enough to write your story.');
    expect(interviewCountSentence(5, 5)).toBe('Five things can be settled, and all five are needed to write your story.');
    expect(interviewCountSentence(7)).toBe('Seven things can be settled.');
    expect(interviewCountSentence(0, 5)).toBe('');
    expect(room([], 2)).toContain('Three things can be settled; two are enough to write your story.');
  });

  it('an answer\'s settled topics are chips, without the story or criterion id, the whole topic kept as the title', () => {
    const html = room([{ id: 't1', question: 'Who and when?', answer: 'Everyone.', facts: ['F1', 'F2'], provider: 'openai', createdAt: '2026-11-17T03:00:00Z' } as unknown as InterviewTurn], 2);
    const settled = /data-testid="interview-settled-1"[^>]*>([\s\S]*?)<\/span><\/p>/.exec(html)?.[1] ?? '';
    expect(settled).toContain('<span class="chip chip-outline " title="US-1: who it is for">who it is for</span>');
    expect(settled).toContain('<span class="chip chip-outline " title="US-1/AC-1: a task due yesterday">a task due yesterday</span>');
    expect(settled).not.toContain('Settled:');
    // a list named "Settled", one item per topic, so a screen reader says them one by one
    expect(html).toMatch(/<span[^>]*data-testid="interview-settled-1"[^>]*role="list"[^>]*aria-label="Settled"/);
    expect(settled).toContain('<span class="label-sm font-medium text-ink2" aria-hidden="true">Settled</span>');
    expect(settled.match(/<span role="listitem"><span class="chip chip-outline "/g)).toHaveLength(2);
    expect(settledTopicLabel('Who books a room')).toBe('Who books a room');
    expect(settledTopicLabel('Why: the reason')).toBe('Why: the reason');
    expect(settledTopicLabel('SH-5: ')).toBe('SH-5: ');
  });
});

describe('Design\'s Compare in the board\'s order and words', () => {
  const changes: FieldChange[] = [
    { path: 'design/sequence', after: 'Task list -> isOverdue: isOverdue(task, today)' },
    { path: 'design/notes', after: 'US-1 is served by Task and isOverdue.' },
    { path: 'design/entity-1/name', after: 'Task (task)' },
    { path: 'design/entity-1/kind', after: 'class' },
    { path: 'design/operation-1/name', after: 'isOverdue: isOverdue(task, today)' },
    { path: 'design/decision-1/title', after: 'D1: Compare dates' },
    { path: 'design/relation-1', after: 'Task (task) uses List (E2)' },
  ];
  it('entities, relations, operations, decisions, then the sequence diagram and the notes', () => {
    const [record] = designCompareDocuments(changes, { api: false, screens: false });
    expect(record.changes.map((one) => one.path)).toEqual([
      'design/entity-1/name', 'design/entity-1/kind', 'design/relation-1', 'design/operation-1/name', 'design/decision-1/title', 'design/sequence', 'design/notes',
    ]);
  });

  it('a name whose id is itself in other letters is said once; the kind as the board names it; other values as sent', () => {
    expect(designValueText(changes[2], 'after')).toBe('Task');
    expect(designValueText({ path: 'design/entity-2/name', after: 'List (E2)' }, 'after')).toBe('List (E2)');
    expect(designValueText(changes[3], 'after')).toBe('Class');
    expect(designValueText(changes[4], 'after')).toBe('isOverdue(task, today)');
    expect(designValueText({ path: 'design/operation-1/name', after: 'O3: getOverdue(today)' }, 'after')).toBe('O3: getOverdue(today)');
    expect(designValueText(changes[0], 'after')).toBe(changes[0].after);
    expect(designValueText(changes[2], 'before')).toBeUndefined();
    // two sides that would read alike keep their ids, so a change never reads as none
    // a relation's two ends: an id that is the name in other letters goes, another id stays
    expect(designValueText(changes[6], 'after')).toBe('Task uses List (E2)');
    expect(designValueText({ path: 'design/relation-2', after: 'List (E2) composition Task (task), 1 to *: holds' }, 'after')).toBe('List (E2) composition Task, 1 to *: holds');
    expect(designValueText({ path: 'design/relation-3', after: 'Subtask (task) uses Task (task)' }, 'after')).toBe('Subtask (task) uses Task');
    expect(designValueText({ path: 'design/relation-4', before: 'Task (task) uses List (list)', after: 'Task (TASK) uses List (list)' }, 'after')).toBe('Task (TASK) uses List (list)');
    const recased = { path: 'design/entity-1/name', before: 'Task (task)', after: 'Task (TASK)' };
    expect([designValueText(recased, 'before'), designValueText(recased, 'after')]).toEqual(['Task (task)', 'Task (TASK)']);
  });
});

describe('the Design room\'s frame sheet', () => {
  const css = webSource('components/workspace/panels/design/design-frame.css');
  // A stylesheet import is not in any render; it is read from the page's own text.
  const page = moduleText('app/(app)/workspace/[phaseId]/design/page.tsx');
  it('the row outside the room carries the tool palette in both themes, and the page imports the sheet', () => {
    expect(css).toMatch(/\.design-frame-toolbar\{[^}]*--tool-surface:#fff/);
    expect(css).toMatch(/html\[data-theme=graphite\] \.design-frame-toolbar\{[^}]*--tool-surface:#172a39/);
    expect(page).toContain("import '@/components/workspace/panels/design/design-frame.css';");
  });
  it('the notices\' box is not laid out as a pane: a notice keeps its icon on its line', () => {
    expect(css).toContain('.design-tool-room [data-testid=phase-design-editor]>div.design-room-notices:not([hidden]){gap:10px;padding-bottom:0}');
  });
});

/*
 * A Requirements review stuck in the queue held Submit on
 * "In review" for ever (`busy` read `reviewPending`, with no age-out), and ⌘↵
 * returned before the API, so the learner could never submit again. The room
 * now holds Submit by the code rooms' and Design's rule (`pendingRevision` /
 * `inFlightAgesOutIn` in signoff-status): only while the review is inside the
 * API's ten-minute age-out window.
 */
describe('a stalled Requirements review holds Submit only inside the age-out window', () => {
  const NOW = Date.parse('2026-11-17T04:00:00.000Z');
  const MINUTE = 60_000;
  const SUBMIT = `POST /phases/${PHASE_ID}/submit`;
  const row = (id: string, createdAt: number, status: 'queued' | 'running' | 'completed' = 'queued') => ({
    id, status, score: null, passed: status === 'completed' ? true : null, report: null, createdAt: new Date(createdAt).toISOString(),
  });
  // What the API holds: the phase's newest revision, the one a submit returns,
  // and what a read of each revision answers.
  let server: { last: ReturnType<typeof row> | null; next: ReturnType<typeof row>; answers: Record<string, ReturnType<typeof row>> };

  // `api.submit` and `api.getSubmission` call the module's own `request`, so
  // they are routed through the rig here, where every call is recorded.
  let spies: { mockRestore: () => void }[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    spies = [
      vi.spyOn(api, 'submit').mockImplementation((id: string) => rig.request('POST', `/phases/${id}/submit`)),
      vi.spyOn(api, 'getSubmission').mockImplementation((id: string) => rig.request('GET', `/submissions/${id}`)),
    ];
  });
  afterEach(() => { spies.forEach((spy) => spy.mockRestore()); vi.useRealTimers(); });

  async function open(last: ReturnType<typeof row> | null) {
    const detail = { ...phaseDetail(true), lastSubmission: last, attempts: last ? 1 : 0 } as unknown as PhaseDetail;
    server = { last, next: row('review-1', NOW), answers: last ? { [last.id]: last } : {} };
    rig.project = shell(detail);
    rig.request.mockImplementation(async (method: string, path: string) => {
      reads.push(`${method} ${path}`);
      if (method === 'GET' && path === `/phases/${PHASE_ID}`) return { ...detail, lastSubmission: server.last };
      if (method === 'PUT' && path === `/phases/${PHASE_ID}/workspace`) return { saved: true, version: '2026-11-17T03:00:01.000Z' };
      if (method === 'POST' && path === `/phases/${PHASE_ID}/submit`) {
        server.next = { ...server.next, createdAt: new Date(Date.now()).toISOString() };
        server.answers[server.next.id] = server.next;
        server.last = server.next;
        return server.next;
      }
      if (method === 'GET' && path.startsWith('/submissions/')) return server.answers[path.slice('/submissions/'.length)];
      if (path.includes('/interview')) return { persona: { name: 'Team Lead', role: 'Lead' }, opening: 'Ask me.', startedAt: null, turns: [], facts: [], factsExpected: 0, turnsLeft: 10, closedAt: null };
      return [];
    });
    await act(async () => { root.render(<RequirementsWorkspace phaseId={PHASE_ID} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
  const button = () => byTestId('phase-requirements-submit') as HTMLButtonElement;
  const submits = () => reads.filter((one) => one === SUBMIT).length;
  const polls = (id: string) => reads.filter((one) => one === `GET /submissions/${id}`).length;
  const press = async () => { await act(async () => { button().click(); }); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
  const shortcut = async () => {
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  };
  const later = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  it('within the window nothing is sent and Submit reads as held; past it Submit is on, one press submits once, and a press while that review runs sends nothing', async () => {
    // queued nine and a half minutes ago: thirty seconds of the window left
    await open(row('review-0', NOW - 9.5 * MINUTE));
    expect(button().textContent).toContain('In review');
    expect(button().disabled).toBe(true);
    expect(byTestId('phase-requirements-render')!.hasAttribute('disabled')).toBe(true);
    await press();
    await shortcut();
    expect(submits()).toBe(0);
    expect(polls('review-0')).toBeGreaterThan(0);

    // the window passes: the room draws again on its own, Submit and Check are on, and the stalled row is not polled again
    await later(31_000);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('Submit again');
    expect(byTestId('phase-requirements-render')!.hasAttribute('disabled')).toBe(false);
    const polled = polls('review-0');
    await later(MINUTE);
    expect(polls('review-0')).toBe(polled);

    // one press reaches the API once, and the new review holds Submit
    await press();
    expect(submits()).toBe(1);
    expect(button().textContent).toContain('In review');
    expect(button().disabled).toBe(true);
    await shortcut();
    await press();
    expect(submits()).toBe(1);
    expect(polls('review-1')).toBeGreaterThan(0);
  });

  it('the Review view draws the story steps and the running clock under the running notice', async () => {
    await open(row('review-0', NOW - 2 * 1_000, 'running'));
    const nav = host.querySelector('nav[aria-label="Backlog views"]')!;
    act(() => Array.from(nav.querySelectorAll('button')).find((one) => one.textContent === 'Review')!.click());
    const steps = byTestId('review-steps')!;
    expect(steps, 'the steps are drawn while the review runs').not.toBeNull();
    expect([...steps.querySelectorAll('li')].map((item) => item.textContent)).toEqual([...REVIEW_STEPS.story]);
    expect(byTestId('review-elapsed')!.textContent).toBe('Running for 2 s');
  });

  it('a reload with a review already past the window: Submit is on from the start, ⌘↵ submits once, and a second ⌘↵ while it runs sends nothing', async () => {
    await open(row('review-0', NOW - 11 * MINUTE));
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('Submit again');
    await later(5_000);
    expect(polls('review-0')).toBe(0);
    await shortcut();
    expect(submits()).toBe(1);
    expect(button().textContent).toContain('In review');
    await shortcut();
    expect(submits()).toBe(1);
  });

  it('unchanged: a first submit is held while it runs and lets go when it settles normally, well inside the window', async () => {
    await open(null);
    expect(button().disabled).toBe(false);
    await press();
    expect(submits()).toBe(1);
    expect(button().textContent).toContain('In review');
    await shortcut();
    expect(submits()).toBe(1);
    // the verdict lands a minute later; Submit is on again and the phase is read again
    const phaseReads = reads.filter((one) => one === `GET /phases/${PHASE_ID}`).length;
    server.answers['review-1'] = { ...server.answers['review-1'], status: 'completed', passed: true };
    server.last = server.answers['review-1'];
    await later(MINUTE);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('Submit again');
    expect(reads.filter((one) => one === `GET /phases/${PHASE_ID}`).length).toBeGreaterThan(phaseReads);
    const polled = polls('review-1');
    await later(MINUTE);
    expect(polls('review-1')).toBe(polled);
  });
});

/*
 * The backlog footer's Submit by the code rooms' rule, with the REAL Button. Before the
 * first submission it reads and looks as it always did (primary, "Submit for review"); after a Pass it is secondary,
 * so it never stands primary under the band's "Continue to next phase", and reads "Submit again"; while a review runs
 * it is today's busy "In review"; after a review that asked for a revision it leads again and reads "Submit again",
 * since a submission exists and handing in a revision is the next step.
 */
describe('Requirements\' Submit after a submission', () => {
  const NOW = Date.parse('2026-11-17T04:00:00.000Z');
  const SUBMIT = `POST /phases/${PHASE_ID}/submit`;
  type Row = { id: string; status: string; score: number | null; passed: boolean | null; report: null; createdAt: string };
  const row = (id: string, status: 'queued' | 'completed', passed: boolean | null = null): Row => ({
    id, status, score: null, passed, report: null, createdAt: new Date(NOW - 60_000).toISOString(),
  });
  let answers: Record<string, Row> = {};
  let spies: { mockRestore: () => void }[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    spies = [
      vi.spyOn(api, 'submit').mockImplementation((id: string) => rig.request('POST', `/phases/${id}/submit`)),
      vi.spyOn(api, 'getSubmission').mockImplementation((id: string) => rig.request('GET', `/submissions/${id}`)),
    ];
  });
  afterEach(() => { spies.forEach((spy) => spy.mockRestore()); vi.useRealTimers(); });

  async function open(last: Row | null, status = 'in_progress') {
    let held = last;
    const detail = () => ({ ...phaseDetail(true), status, lastSubmission: held, attempts: held ? 1 : 0 }) as unknown as PhaseDetail;
    answers = last ? { [last.id]: last } : {};
    rig.project = shell(detail());
    rig.request.mockImplementation(async (method: string, path: string) => {
      reads.push(`${method} ${path}`);
      if (method === 'GET' && path === `/phases/${PHASE_ID}`) return detail();
      if (method === 'PUT' && path === `/phases/${PHASE_ID}/workspace`) return { saved: true, version: '2026-11-17T03:00:01.000Z' };
      if (method === 'POST' && path === `/phases/${PHASE_ID}/submit`) {
        held = { ...row('review-1', 'queued'), createdAt: new Date(Date.now()).toISOString() };
        answers[held.id] = held;
        return held;
      }
      if (method === 'GET' && path.startsWith('/submissions/')) return answers[path.slice('/submissions/'.length)];
      if (path.includes('/interview')) return { persona: { name: 'Team Lead', role: 'Lead' }, opening: 'Ask me.', startedAt: null, turns: [], facts: [], factsExpected: 0, turnsLeft: 10, closedAt: null };
      return [];
    });
    await act(async () => { root.render(<RequirementsWorkspace phaseId={PHASE_ID} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
  const button = () => byTestId('phase-requirements-submit') as HTMLButtonElement;
  const look = () => ({
    label: (button().textContent ?? '').replace('⌘↵', ''),
    variant: button().className.split(/\s+/).includes('btn-secondary') ? 'secondary' : button().className.split(/\s+/).includes('btn') ? 'primary' : 'other',
    disabled: button().disabled,
  });
  const press = async () => { await act(async () => { button().click(); }); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };

  it('before any submission: primary, "Submit for review"', async () => {
    await open(null);
    expect(look()).toEqual({ label: 'Submit for review', variant: 'primary', disabled: false });
  });
  it('a passed phase opened again: secondary, "Submit again"', async () => {
    await open(row('review-0', 'completed', true), 'passed');
    expect(look()).toEqual({ label: 'Submit again', variant: 'secondary', disabled: false });
  });
  it('while the first review runs: today\'s busy "In review", primary; once it passes in the room: secondary, "Submit again"', async () => {
    await open(null);
    await press();
    expect(reads.filter((one) => one === SUBMIT)).toHaveLength(1);
    expect(look()).toEqual({ label: 'In review', variant: 'primary', disabled: true });
    answers['review-1'] = { ...answers['review-1'], status: 'completed', passed: true };
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(look()).toEqual({ label: 'Submit again', variant: 'secondary', disabled: false });
  });
  it('after a review that asked for a revision: it leads, "Submit again"', async () => {
    await open(row('review-0', 'completed', false), 'submitted');
    expect(look()).toEqual({ label: 'Submit again', variant: 'primary', disabled: false });
  });
});

describe('the interview evidence beside the brief names the room\'s own story', () => {
  it('reads the id from the room\'s story file, never from the project', async () => {
    const detail = phaseDetail(true);
    rig.project = shell(detail);
    rig.request.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === `/phases/${PHASE_ID}`) return detail;
      if (path.includes('/interview')) {
        return { persona: { name: 'Team Lead', role: 'Lead' }, opening: 'Ask me.', startedAt: null, turns: [],
          facts: [{ id: 'F1', topic: 'When a task is late', uncovered: true }], factsExpected: 1, turnsLeft: 10, closedAt: null };
      }
      return [];
    });
    await act(async () => { root.render(<RequirementsWorkspace phaseId={PHASE_ID} />); });
    await act(async () => { await Promise.resolve(); });
    // The story file holds US-1; the project is deadline-badge.
    expect(byTestId('interview-enough')?.textContent).toContain('You have enough to write US-1.');
  });
});
