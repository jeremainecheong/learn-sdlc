// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, getByRole, queryByText } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, RUNBOOK_JSON, RUNBOOK_OLDER_FORMAT_ROOM, serialiseChangeRequest, type ChangeRequest, type PhaseDetail } from '@learnsdlc/shared';

// Real document pages, real versioned saver, real owner-stamped localStorage
// helpers and real Maintenance derivation. Network and visual-only children
// are controlled; no private accounts, provider, runner or browser is used.
const rig = vi.hoisted(() => ({
  phaseId: 'document-phase', owner: 'document-owner', token: 'document-token', kind: 'change' as 'change' | 'drill',
  seed: null as PhaseDetail | null,
  hasDrill: true, load: vi.fn(), save: vi.fn(), submit: vi.fn(), getSubmission: vi.fn(), start: vi.fn(), health: vi.fn(), resolve: vi.fn(),
  request: vi.fn(), poll: vi.fn(), setProject: vi.fn(), invalidate: vi.fn(), router: { push: vi.fn(), replace: vi.fn() },
  jobWake: vi.fn(), wake: vi.fn(),
  /** Has a teacher added a concept quiz beside this phase's own task? */
  split: false,
  // What the room hands the pass banner through the frame, captured as the
  // frame itself would receive it. Null means the room passed nothing.
  beforeContinue: null as (() => Promise<void>) | null,
  /** Draw the start-over control; what the page hands the Contract card and the unreadable record's notice. */
  reset: false, contractEditable: [] as boolean[], canStartEmpty: [] as boolean[],
  /** The phase's run log, and what the change room hands its regression card from it. */
  runs: vi.fn(), lastRun: [] as unknown[],
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: rig.phaseId }), useRouter: () => rig.router }));
// The rest props matter: the task panel's rows carry their `data-testid` and
// `aria-current` on the anchor, and a stub that dropped them would make a door
// unfindable rather than red.
vi.mock('next/link', () => ({ default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api', () => {
  class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
  return { ApiError, API_URL: '/api/v1', api: { phase: rig.load, saveWorkspace: rig.save, submit: rig.submit, getSubmission: rig.getSubmission,
    drillStart: rig.start, drillHealth: rig.health, drillResolve: rig.resolve, runs: rig.runs },
    describeError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
    getToken: () => rig.token, onSessionLeaving: () => () => {}, onSignOut: () => () => {}, tokenAtSessionEnd: () => null, request: rig.request };
});
// `ownedByToken` for lib/commit, which the drill's header Submit reads the commit draft from: one session throughout.
vi.mock('@/lib/session', () => ({ getSession: () => ({ id: rig.owner }), useSession: () => ({ id: rig.owner }), onSessionEnd: () => () => undefined, subscribe: () => () => {}, ownedByToken: () => () => undefined }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: null, analytics: null }), fullDetail: () => rig.seed, invalidateProject: rig.invalidate }));
vi.mock('@/lib/project', () => ({ setActiveProject: rig.setProject }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: rig.poll, useRecoverWhenBack: () => {} }));
// The socket's nudge to the submission poll. Named here so the page's own
// wiring of it can be asserted: nothing else in the suite reaches a real one.
vi.mock('@/lib/job-signal', () => ({ jobWake: rig.jobWake }));
vi.mock('@/components/shell', async () => ({
  ...await import('@/components/shell/routes'),
  DocPage: ({ children, title }: { children: ReactNode; title: string }) => <main><h1>{title}</h1>{children}</main>,
}));
vi.mock('@/components/workspace/PhaseDocumentFrame', async () => {
  const { Children, Fragment, isValidElement } = await import('react');
  // The header's controls placed as WorkPage's strip places them: a control that says where it
  // goes (`headerPlacement`, the header's Submit) is drawn on the row or inside Details, so a verdict that moves
  // Submit remounts it there, as on the real page.
  const flat = (node: ReactNode): ReactNode[] => Children.toArray(node).flatMap(child => isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment ? flat(child.props.children) : [child]);
  const inDetails = (node: ReactNode) => isValidElement(node) && typeof node.type === 'function' && (node.type as { headerPlacement?: (props: unknown) => string }).headerPlacement?.(node.props) === 'details';
  return { PhaseDocumentFrame: ({ children, right, toolNav, subNav, title, onBeforeContinue }: { children: ReactNode; right: ReactNode; toolNav: ReactNode; subNav?: ReactNode; title: string; onBeforeContinue?: () => Promise<void> }) => {
    // The frame hands this straight to the pass banner, so holding it here is
    // holding exactly what the banner would call.
    rig.beforeContinue = onBeforeContinue ?? null;
    const controls = flat(right);
    return <main><h1>{title}</h1><header>{controls.filter(node => !inDetails(node))}<details>{controls.filter(inDetails)}</details></header><nav>{toolNav}</nav>{subNav}{children}</main>;
  } };
});
vi.mock('@/components/ui', () => {
  const Block = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Avatar: () => null, Chip: Block, Notice: Block, SectionHead: Block,
    Section: ({ children, title }: { children: ReactNode; title: string }) => <section><h2>{title}</h2>{children}</section>,
    EmptyState: ({ action, body }: { action: ReactNode; body: string }) => <section>{body}{action}</section>,
    Button: ({ children, onClick, disabled, busy, testId, href, reason }: { children: ReactNode; onClick?: () => void; disabled?: boolean; busy?: boolean; testId?: string; href?: string; reason?: string }) =>
      href ? <a href={href} data-testid={testId}>{children}</a> : <button type="button" data-testid={testId} data-reason={reason} disabled={disabled || busy} onClick={onClick}>{children}</button>,
  };
});
vi.mock('@/components/workspace/panels/maintenance/ChangeCards', () => ({
  ChangeTicket: () => null, ChangeImpactCard: () => null, ReleaseRecordCard: () => null,
  RegressionTable: ({ lastRun }: { lastRun?: unknown }) => { rig.lastRun.push(lastRun ?? null); return null; },
  // The real card draws its "does not carry an editable design/contracts.json" notice exactly when `editable` is false.
  ContractV2: ({ editable }: { editable: boolean }) => { rig.contractEditable.push(editable); return <div data-testid="contract-card" />; },
  AcceptanceChecks: () => null,
}));
// The release form's summary stands for the room's buffer: the change request record, written whole on each edit.
vi.mock('@/components/workspace/panels/maintenance/ChangeForms', () => ({
  RequestForm: () => null, AmendmentsForm: () => null, TestsForm: () => null, ChangeFloorCheck: () => null, ChangeRoomOlderNotice: () => null,
  // The real notice offers "Start empty" exactly when `canStartEmpty` is true.
  ChangeRecordUnreadable: ({ canStartEmpty }: { canStartEmpty: boolean }) => { rig.canStartEmpty.push(canStartEmpty); return canStartEmpty ? <button type="button">Start empty</button> : <p data-testid="record-unreadable" />; },
  ReleaseForm: ({ change, onChange }: { change: ChangeRequest; onChange: (next: ChangeRequest) => void }) =>
    <textarea aria-label="Release entry" value={change.release.summary} onChange={event => onChange({ ...change, release: { ...change.release, summary: event.target.value } })} />,
}));
// The start-over control as a teacher's authored list draws it (the rig's phases have none, so the real one draws nothing).
vi.mock('@/components/workspace/TaskResetControl', () => ({ TaskResetControl: () => rig.reset ? <button type="button" data-testid="task-reset-open">Start this task over</button> : null }));
vi.mock('@/components/workspace/panels/deployment/DrillDoc', async () => ({
  ...(await vi.importActual<object>('@/components/workspace/panels/deployment/DrillDoc')),
  // The drill report the page hands the diagnosis, by its fault line (which revision's report is read).
  FaultedDeployment: ({ report }: { report: { faultDescription?: string } | null }) => report ? <p data-testid="drill-report">{report.faultDescription}</p> : null, ResolveChecklist: () => null,
  IncidentWriteUp: ({ value, onChange }: { value: Record<string, string>; onChange: (value: Record<string, string>) => void }) =>
    <div>{['rootCause', 'fix', 'actionItem'].map(key => <textarea key={key} aria-label={key} value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })} />)}</div>,
}));
// Only the dialog host is replaced for JSDOM. The real comparison content,
// reviewed version, and both explicit resolution buttons remain mounted.
vi.mock('@/components/workspace/panels/requirements/IssueDesk', () => ({ IssueDialog: ({ children, title }: { children: ReactNode; title: string }) => <div role="dialog" aria-label={title}>{children}</div> }));

import ChangePage from '@/app/(app)/workspace/[phaseId]/change/page';
import DrillPage from '@/app/(app)/workspace/[phaseId]/drill/page';
import { ApiError } from '@/lib/api';
import { readVersionedWorkspaceDraft } from '@/lib/api-workspace';
import { AGENT_BUSY, prepareAgentOperation, refreshAgentWorkspace } from '@/components/workspace/mentor/useAgentWorkspace';
import { PollTimeoutError } from '@/lib/poll';
import { commitDraft, setCommitDraft } from '@/lib/commit';
import { readRunbookTouched, recordRunbookTouched } from '@/components/workspace/panels/deployment/runbook-edit';
import { REVISION_IN_FLIGHT_REASON, SIGN_OFF_SUBMIT_REASON } from '@/components/workspace/signoff-status';
import { PROPOSAL_HOLD_REASON, PROPOSAL_HOLD_RESOLVE_REASON, PROPOSAL_HOLD_RUN_REASON, READ_BACK_HOLD_REASON, READ_BACK_HOLD_RESOLVE_REASON, READ_BACK_HOLD_RUN_REASON, READ_BACK_NOTICE } from '@/components/workspace/signoff-status';
const initial = '2026-09-15T11:00:00.000Z', next = '2026-09-15T11:01:00.000Z', later = '2026-09-15T11:02:00.000Z';
const activeDrill = () => ({ id: 'incident', startedAt: initial, resolvedAt: null, runbookBefore: 'original runbook' });
/** The change request record whose release summary is `summary`, as the room serialises it. */
const changeRecord = (summary: string) => serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, release: { ...EMPTY_CHANGE_REQUEST.release, summary } });
const TICKET = { id: 'CR-2', title: 'Comments on tasks', summary: 'Tasks carry comments.', acceptance: [{ id: 'AC-1', line: 'A task lists its comments.' }] };
function phase(id = rig.phaseId, version = initial, content = rig.kind === 'change' ? 'original entry' : 'original runbook'): PhaseDetail {
  return { id, key: rig.kind === 'change' ? 'maintenance' : 'deployment', title: rig.kind === 'change' ? 'Maintenance' : 'Deployment',
    order: rig.kind === 'change' ? 6 : 5, place: rig.kind === 'change' ? 6 : 5, count: 6, status: 'in_progress', projectSlug: 'tasktrackr', workspaceUpdatedAt: version,
    artifactKind: rig.kind === 'change' ? 'code' : 'config',
    ...(rig.kind === 'change' ? { change: { ticket: TICKET, contract: true, floor: { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true } } } : {}),
    // Deployment's runbook is the record, written in the IDE's Runbook tab: the drill page holds no editor.
    ...(rig.kind === 'drill' ? { runbook: { floor: { minEnvironment: 0, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true }, drill: true } } : {}),
    files: rig.kind === 'change' ? [
      { path: CHANGE_REQUEST_JSON, content: changeRecord(content), editable: true, language: 'json' },
      { path: 'design/contracts.json', content: '{"operations":[]}', editable: true, language: 'json' },
    ] : [{ path: RUNBOOK_JSON, content, editable: true, language: 'json' }],
    attempts: 0, bestScore: null, rubric: { criteria: [], passThreshold: 100 }, objectives: [], taskPanel: '', links: [],
    canRun: true, canPreview: false, runLabel: 'Run tests', lastSubmission: null,
    drill: rig.kind === 'drill' && rig.hasDrill ? activeDrill() : null,
    ...(rig.split ? { tasks: splitTasks(), taskCounts: { total: 2, required: 2, passed: 0, passedRequired: 0 } } : {}),
  } as unknown as PhaseDetail;
}
/**
 * Maintenance split by a teacher: the room's own change request task and a concept
 * quiz beside it, the one task a teacher adds. The quiz's row is a door out of
 * a room that holds an unsaved buffer.
 */
const splitTasks = () => [
  { key: 'main', order: 1, required: true, title: 'The change request', artefactType: 'code' as const,
    artefactPath: CHANGE_REQUEST_JSON, primaryPath: CHANGE_REQUEST_JSON, files: [CHANGE_REQUEST_JSON],
    evidence: 'reviewed' as const, sealed: true, status: 'in_progress' as const, awaitingSignOff: false,
    attempts: 0, bestScore: null, passedAt: null, lastSubmissionId: null, resetAt: null,
    solution: { available: false, files: 0, readAt: null } },
  { key: 'concepts', order: 2, required: true, title: 'The upgrade concepts', artefactType: 'quiz' as const,
    files: [],
    evidence: 'automated' as const, sealed: true, status: 'in_progress' as const, awaitingSignOff: false,
    attempts: 0, bestScore: null, passedAt: null, lastSubmissionId: null, resetAt: null,
    solution: { available: false, files: 0, readAt: null } },
];
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; }
let root: Root, host: HTMLDivElement, sequence = 0;
const render = () => act(async () => { root.render(rig.kind === 'change' ? <ChangePage /> : <DrillPage />); });
const textarea = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Release entry"]')!;
const type = (value: string) => {
  if (textarea().closest('[hidden]')) act(() => fireEvent.click(getByRole(host, 'button', { name: 'Release' })));
  act(() => fireEvent.change(textarea(), { target: { value } }));
};
const click = (name: string) => act(async () => { fireEvent.click(getByRole(host, 'button', { name })); });
const debounce = () => act(async () => { await vi.advanceTimersByTimeAsync(700); });
const contentOf = (body: string) => rig.kind === 'change' ? changeRecord(body) : body;
const pathOf = () => rig.kind === 'change' ? CHANGE_REQUEST_JSON : RUNBOOK_JSON;
const status = () => host.querySelector('[data-testid="save-state"]')?.textContent;
const actionName = () => rig.kind === 'change' ? 'Submit PR-6' : 'Run the selfcheck';
const actionMock = () => rig.kind === 'change' ? rig.submit : rig.health;
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); window.localStorage.clear();
  rig.owner = `document-owner-${++sequence}`; rig.token = `document-token-${sequence}`; rig.phaseId = `document-phase-${sequence}`; rig.hasDrill = true; rig.seed = null; rig.beforeContinue = null; rig.split = false; rig.reset = false; rig.contractEditable = []; rig.canStartEmpty = []; rig.lastRun = [];
  rig.runs.mockResolvedValue([]);
  rig.load.mockImplementation(async () => phase()); rig.save.mockResolvedValue({ saved: true, version: next });
  rig.submit.mockResolvedValue({ id: 'submission', status: 'completed', attempt: 1 }); rig.getSubmission.mockResolvedValue({ id: 'submission', status: 'completed' });
  rig.poll.mockResolvedValue({ id: 'submission', status: 'completed', attempt: 1 }); rig.health.mockResolvedValue({ exit: 0 });
  rig.jobWake.mockImplementation(() => rig.wake);
  rig.start.mockResolvedValue(activeDrill()); rig.resolve.mockResolvedValue({ ...activeDrill(), resolvedAt: later });
  rig.request.mockRejectedValue(new Error('Unexpected API-workspace request'));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: next }) })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

for (const kind of ['change', 'drill'] as const) describe(`${kind} page with the actual versioned saver`, () => {
  beforeEach(() => { rig.kind = kind; });
  if (kind === 'drill') it('draws the runbook view as the door to the IDE\'s Runbook tab, and no editor', async () => {
    await render(); await click('Runbook');
    expect(host.querySelector('[data-testid="drill-open-runbook"]')?.getAttribute('href')).toBe(`/workspace/${rig.phaseId}?panel=runbook`);
    expect(host.querySelector('textarea[aria-label="Runbook content"]')).toBeNull();
  });
  // The working-area row is the frame's (the workspace's own row, read in maintenance-frame), so the
  // change page hands the frame none of its own; its sections stay a second, labelled row; "Files changed"
  // is the review page's own tab, not this page's.
  if (kind === 'change') it('hands the frame no working-area row of its own, and draws its sections as a second row', async () => {
    await render();
    const [top] = host.querySelectorAll('nav');
    expect(top.children).toHaveLength(0);
    const sections = host.querySelector('nav[aria-label="Change request sections"]')!;
    expect(sections).not.toBe(top);
    expect([...sections.classList]).toEqual(['phase-room-nav', 'phase-room-nav--sections']);
    expect([...sections.querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Request', 'true'], ['Contract', 'false'], ['Checks', 'false'], ['Release', 'false'],
    ]);
    expect(host.textContent).not.toContain('Files changed');
    await click('Checks');
    expect(getByRole(host, 'button', { name: 'Checks' }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole(host, 'button', { name: 'Request' }).getAttribute('aria-pressed')).toBe('false');
  });

  /*
   * The change room beside an assistant with both of its modes. The room takes part in the three signals the
   * workspace and the design room exchange with the assistant panel, here sent as the panel sends them.
   */
  if (kind === 'change') it('a proposal operation first saves the room\'s unsaved edit, so it reads the saved workspace', async () => {
    await render(); type('typed just before asking');
    expect(rig.save).not.toHaveBeenCalled();
    await act(async () => { await prepareAgentOperation(rig.phaseId); });
    expect(rig.save).toHaveBeenCalledTimes(1);
    expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { [pathOf()]: contentOf('typed just before asking') }, initial);
    expect(status()).toBe('Saved');
  });
  if (kind === 'change') it('while an operation runs the forms and the start-over control are inert, and Submit and its key are held with the sentence', async () => {
    await render();
    const held = () => host.querySelector<HTMLElement>('[data-testid="change-held"]')!;
    const submit = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-submit"]')!;
    const busy = (phaseId: string, on: boolean) => act(() => { window.dispatchEvent(new CustomEvent(AGENT_BUSY, { detail: { phaseId, busy: on } })); });
    expect(held().inert).toBe(false);
    expect(submit().disabled).toBe(false);
    busy(rig.phaseId, true);
    expect(held().inert).toBe(true);
    expect(held().getAttribute('aria-busy')).toBe('true');
    // the forms are inside the held box and are still drawn: nothing is unmounted while the operation runs
    expect(held().contains(textarea())).toBe(true);
    expect(submit().disabled).toBe(true);
    expect(submit().getAttribute('data-reason')).toBe(PROPOSAL_HOLD_REASON);
    act(() => { fireEvent.keyDown(window, { key: 'Enter', metaKey: true }); });
    expect(rig.submit).not.toHaveBeenCalled();
    busy(rig.phaseId, false);
    expect(held().inert).toBe(false);
    expect(held().hasAttribute('aria-busy')).toBe(false);
    expect(submit().disabled).toBe(false);
    expect(submit().getAttribute('data-reason')).toBeNull();
    // an operation on another phase is not this room's
    busy('another-phase', true);
    expect(held().inert).toBe(false);
    expect(submit().disabled).toBe(false);
  });
  if (kind === 'change') it('after an Apply the room reads the phase again: the form holds the applied record and the next hand edit saves on the applied version', async () => {
    await render();
    expect(textarea().value).toBe('original entry');
    rig.load.mockImplementation(async () => phase(rig.phaseId, later, 'applied by the assistant'));
    await act(async () => { await refreshAgentWorkspace(rig.phaseId); });
    expect(textarea().value).toBe('applied by the assistant');
    expect(rig.invalidate).toHaveBeenCalled();
    // the room is editable again and holds no conflict: the save queue is at the applied version
    expect(host.querySelector<HTMLElement>('[data-testid="change-held"]')!.inert).toBe(false);
    rig.save.mockResolvedValue({ saved: true, version: '2026-09-15T11:03:00.000Z' });
    type('a hand edit after the Apply'); await debounce();
    expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { [pathOf()]: contentOf('a hand edit after the Apply') }, later);
    expect(status()).toBe('Saved');
    expect(queryByText(host, /Compare versions/)).toBeNull();
  });

  /*
   * The change room announces an applied proposal as every room does, once it has
   * read the applied record back, and its regression card is handed the learner's newest run that counted tests.
   */
  if (kind === 'change') it('after an Apply is read back the page says so in its notice place, in the design room\'s words', async () => {
    await render();
    expect(host.textContent).not.toContain('The reviewed proposal is saved in this workspace.');
    rig.load.mockImplementation(async () => phase(rig.phaseId, later, 'applied by the assistant'));
    await act(async () => { await refreshAgentWorkspace(rig.phaseId); });
    expect(textarea().value).toBe('applied by the assistant');
    expect(host.textContent).toContain('The reviewed proposal is saved in this workspace.');
    // a submission clears it, as it clears every notice of the page
    await click('Submit PR-6');
    expect(host.textContent).not.toContain('The reviewed proposal is saved in this workspace.');
  });
  if (kind === 'change') it('the regression card is handed the learner\'s newest completed run that counted tests (never the review\'s), and nothing when the log will not load', async () => {
    const counted = (id: string, total: number, kind = 'run') => ({ id, status: 'completed', kind, createdAt: initial, result: { ok: true, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1, tests: { total, passed: total, failed: 0, errored: 0, cases: [] } } });
    // the review's own execution (`kind: 'submit'`) is newer, counted tests and is in the log: not the learner's run
    rig.runs.mockResolvedValue([counted('older', 3), counted('newest', 3), counted('no-tests', 0), counted('the-review', 4, 'submit'), { id: 'queued', status: 'queued', kind: 'run', createdAt: initial, result: null }]);
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(rig.runs).toHaveBeenCalledWith(rig.phaseId);
    expect((rig.lastRun.at(-1) as { id: string } | null)?.id).toBe('newest');
    act(() => root.unmount()); root = createRoot(host); rig.lastRun = [];
    rig.runs.mockRejectedValue(new Error('offline'));
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(rig.lastRun.at(-1)).toBeNull();
  });

  /*
   * The drill page beside an assistant with both of its modes. Its sections are a second row (the working-area
   * row is the frame's), and it takes part in the three signals as the change room does, with its own save queue.
   */
  if (kind === 'drill') it('hands the frame no working-area row of its own, and draws its sections as a second row', async () => {
    await render();
    const [top] = host.querySelectorAll('nav');
    expect(top.children).toHaveLength(0);
    const sections = host.querySelector('nav[aria-label="Incident drill working area"]')!;
    expect(sections).not.toBe(top);
    expect([...sections.classList]).toEqual(['phase-room-nav', 'phase-room-nav--sections']);
    expect([...sections.querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Diagnosis', 'true'], ['Runbook', 'false'], ['Incident record', 'false'],
    ]);
    // the "Pipeline" link is the frame's row's entry, not this page's
    expect([...host.querySelectorAll('a')].map((a) => a.textContent)).not.toContain('Pipeline');
    await click('Incident record');
    expect(getByRole(host, 'button', { name: 'Incident record' }).getAttribute('aria-pressed')).toBe('true');
  });
  if (kind === 'drill') it('a proposal operation first saves the runbook edit the page holds, so it reads the saved workspace', async () => {
    recoverRunbook('recovered just before asking');
    await render();
    expect(rig.save).not.toHaveBeenCalled();
    await act(async () => { await prepareAgentOperation(rig.phaseId); });
    expect(rig.save).toHaveBeenCalledTimes(1);
    expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { [RUNBOOK_JSON]: 'recovered just before asking' }, initial);
    expect(readVersionedWorkspaceDraft(rig.phaseId)).toBeNull();
    expect(status()).toBe('Saved');
  });
  if (kind === 'drill') it('while an operation runs the incident form is inert, and nothing is started or declared, by the buttons or the keys', async () => {
    await render();
    const held = () => host.querySelector<HTMLElement>('[data-testid="drill-held"]')!;
    const health = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-deployment-drill-health"]')!;
    const resolve = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-deployment-drill-resolve"]')!;
    const busy = (phaseId: string, on: boolean) => act(() => { window.dispatchEvent(new CustomEvent(AGENT_BUSY, { detail: { phaseId, busy: on } })); });
    await click('Incident record');
    for (const label of ['rootCause', 'fix', 'actionItem']) act(() => fireEvent.change(host.querySelector(`textarea[aria-label="${label}"]`)!, { target: { value: `A sufficiently explained ${label} with retained evidence.` } }));
    expect(held().inert).toBe(false);
    expect([health().disabled, resolve().disabled]).toEqual([false, false]);
    busy(rig.phaseId, true);
    expect(held().inert).toBe(true);
    expect(held().getAttribute('aria-busy')).toBe('true');
    // the form is inside the held box and still drawn, with what was typed: nothing is unmounted
    expect(held().contains(host.querySelector('textarea[aria-label="rootCause"]'))).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="fix"]')!.value).toBe('A sufficiently explained fix with retained evidence.');
    expect(resolve().disabled).toBe(true);
    // A sentence that is true of Declare resolved, which is not a Submit
    expect(resolve().getAttribute('data-reason')).toBe(PROPOSAL_HOLD_RESOLVE_REASON);
    expect(health().disabled).toBe(true);
    expect(health().getAttribute('data-reason')).toBe(PROPOSAL_HOLD_RUN_REASON);
    await act(async () => { fireEvent.keyDown(window, { key: 'Enter', metaKey: true }); });
    await act(async () => { fireEvent.keyDown(window, { key: 'H', metaKey: true, shiftKey: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(rig.resolve).not.toHaveBeenCalled();
    expect(rig.health).not.toHaveBeenCalled();
    busy(rig.phaseId, false);
    expect(held().inert).toBe(false);
    expect(held().hasAttribute('aria-busy')).toBe(false);
    expect([health().disabled, resolve().disabled]).toEqual([false, false]);
    expect(resolve().getAttribute('data-reason')).toBeNull();
    // an operation on another phase is not this page's
    busy('another-phase', true);
    expect(held().inert).toBe(false);
    expect(health().disabled).toBe(false);
    // and with the hold gone, the key declares the incident resolved again
    await act(async () => { fireEvent.keyDown(window, { key: 'Enter', metaKey: true }); });
    expect(rig.resolve).toHaveBeenCalledTimes(1);
  });
  // Start the drill is held by its own disabled state and sentence, outside any inert box,
  // so its sentence can be perceived (an inert subtree takes no pointer and leaves the accessibility tree).
  if (kind === 'drill') it('Start the drill is held too while an operation runs, with a sentence that can be read', async () => {
    rig.hasDrill = false;
    await render();
    const start = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-deployment-drill-start"]')!;
    act(() => { window.dispatchEvent(new CustomEvent(AGENT_BUSY, { detail: { phaseId: rig.phaseId, busy: true } })); });
    expect(start().disabled).toBe(true);
    expect(start().getAttribute('data-reason')).toBe(PROPOSAL_HOLD_RUN_REASON);
    expect(start().closest('[inert]')).toBeNull();
    for (let node: HTMLElement | null = start(); node; node = node.parentElement) expect(node.inert, node.tagName).toBeFalsy();
    await click('Start the drill');
    expect(rig.start).not.toHaveBeenCalled();
  });
  if (kind === 'drill') it('after an Apply the page reads the phase again, says the drill was taken before the change, and holds no conflict', async () => {
    await render();
    expect(host.querySelector('[data-testid="drill-applied-note"]')).toBeNull();
    rig.load.mockImplementation(async () => phase(rig.phaseId, later, 'applied runbook'));
    await act(async () => { await refreshAgentWorkspace(rig.phaseId); });
    expect(rig.load).toHaveBeenCalledTimes(2);
    expect(rig.invalidate).toHaveBeenCalled();
    const note = host.querySelector('[data-testid="drill-applied-note"]')!;
    // The notice every room leads with, then what the drill shows.
    expect(note.textContent).toBe('The reviewed proposal is saved in this workspace. What this drill shows was taken before it, so run the selfcheck again to check the change, or open Configuration to see it.');
    // the link opens the workspace's Configuration, the view the drill page's row names by that address
    expect(note.querySelector('a')!.getAttribute('href')).toBe(`/workspace/${rig.phaseId}?panel=code`);
    expect(note.querySelector('a')!.textContent).toBe('open Configuration');
    expect(host.querySelector<HTMLElement>('[data-testid="drill-held"]')!.inert).toBe(false);
    expect(queryByText(host, /Compare versions/)).toBeNull();
    expect(status()).toBe('Saved');
    // the next check reads the files as they are now; the note has said what it had to
    await click('Run the selfcheck');
    expect(rig.health).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="drill-applied-note"]')).toBeNull();
  });
  if (kind === 'drill') it('an Apply before the drill starts: the notice every room gives, alone, until Start', async () => {
    rig.hasDrill = false;
    await render();
    expect(host.querySelector('[data-testid="drill-applied-note"]')).toBeNull();
    await act(async () => { await refreshAgentWorkspace(rig.phaseId); });
    const note = host.querySelector('[data-testid="drill-applied-note"]')!;
    expect(note.textContent).toBe('The reviewed proposal is saved in this workspace.');
    expect(note.querySelector('a')).toBeNull();
    await click('Start the drill');
    expect(rig.start).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="drill-applied-note"]')).toBeNull();
  });

  /*
   * The details of the change room's hold (the start-over control, Start empty, the Contract card's notice), and
   * what the change room and the drill page hold, and say, when the read after an Apply fails.
   */
  const busyOn = (on: boolean) => act(() => { window.dispatchEvent(new CustomEvent(AGENT_BUSY, { detail: { phaseId: rig.phaseId, busy: on } })); });
  if (kind === 'change') it('the start-over control sits inside the held box: inert while an operation runs, live after', async () => {
    rig.reset = true;
    await render();
    const reset = host.querySelector<HTMLButtonElement>('[data-testid="task-reset-open"]')!;
    const held = host.querySelector<HTMLElement>('[data-testid="change-held"]')!;
    expect(held.contains(reset)).toBe(true);
    busyOn(true);
    expect(held.inert).toBe(true);
    busyOn(false);
    expect(held.inert).toBe(false);
  });
  if (kind === 'change') it('"Start empty" is not offered while an operation runs, and is again after it', async () => {
    rig.load.mockImplementation(async () => ({ ...phase(), files: [{ path: CHANGE_REQUEST_JSON, content: '{"not": "a change request', editable: true, language: 'json' }, ...phase().files.slice(1)] }));
    await render();
    expect(queryByText(host, 'Start empty')).not.toBeNull();
    busyOn(true);
    expect(queryByText(host, 'Start empty')).toBeNull();
    expect(rig.canStartEmpty.at(-1)).toBe(false);
    busyOn(false);
    expect(queryByText(host, 'Start empty')).not.toBeNull();
  });
  if (kind === 'change') it('the Contract card is handed an editable contract while an operation runs, so it draws no "not editable" notice', async () => {
    await render(); await click('Contract');
    expect(rig.contractEditable.at(-1)).toBe(true);
    busyOn(true);
    expect(rig.contractEditable.at(-1)).toBe(true);
    expect(host.querySelector('[data-testid="contract-card"]')).not.toBeNull();
  });
  if (kind === 'change') it('when the read after an Apply fails, the page says to retry it and keeps the forms and Submit held; a retry that reads releases them', async () => {
    await render();
    const held = () => host.querySelector<HTMLElement>('[data-testid="change-held"]')!;
    const submit = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-submit"]')!;
    rig.load.mockRejectedValueOnce(new Error('A network blip.'));
    await act(async () => { await expect(refreshAgentWorkspace(rig.phaseId)).rejects.toThrow('A network blip.'); });
    // the rig's Notice is a plain box, so the sentence is found by its words
    expect(queryByText(host, READ_BACK_NOTICE)).not.toBeNull();
    expect(submit().disabled).toBe(true);
    expect(submit().getAttribute('data-reason')).toBe(READ_BACK_HOLD_REASON);
    // the forms write through a save queue still at the version from before the Apply: they stay held
    expect(held().inert).toBe(true);
    await act(async () => { await refreshAgentWorkspace(rig.phaseId); });
    expect(queryByText(host, READ_BACK_NOTICE)).toBeNull();
    expect(held().inert).toBe(false);
    expect(submit().disabled).toBe(false);
  });
  if (kind === 'drill') it('when the read after an Apply fails, the page says to retry it, holds its runs and Declare resolved with that sentence, and releases the incident form', async () => {
    await render();
    const held = () => host.querySelector<HTMLElement>('[data-testid="drill-held"]')!;
    const health = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-deployment-drill-health"]')!;
    const resolve = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-deployment-drill-resolve"]')!;
    busyOn(true);
    expect(health().getAttribute('data-reason')).toBe(PROPOSAL_HOLD_RUN_REASON);
    expect(held().inert).toBe(true);
    busyOn(false);
    rig.load.mockRejectedValueOnce(new Error('A network blip.'));
    await act(async () => { await expect(refreshAgentWorkspace(rig.phaseId)).rejects.toThrow('A network blip.'); });
    // the rig's Notice is a plain box, so the sentence is found by its words
    expect(queryByText(host, READ_BACK_NOTICE)).not.toBeNull();
    expect(health().disabled).toBe(true);
    expect(health().getAttribute('data-reason')).toBe(READ_BACK_HOLD_RUN_REASON);
    expect(resolve().disabled).toBe(true);
    expect(resolve().getAttribute('data-reason')).toBe(READ_BACK_HOLD_RESOLVE_REASON);
    // the incident's three lines are the learner's own words in this page: they are not held for nothing
    expect(held().inert).toBe(false);
    expect(held().hasAttribute('aria-busy')).toBe(false);
    await act(async () => { fireEvent.keyDown(window, { key: 'Enter', metaKey: true }); });
    expect(rig.resolve).not.toHaveBeenCalled();
    await act(async () => { await refreshAgentWorkspace(rig.phaseId); });
    expect(queryByText(host, READ_BACK_NOTICE)).toBeNull();
    expect([health().disabled, resolve().disabled]).toEqual([false, false]);
  });
  if (kind === 'drill') it('before the drill, a failed read-back holds Start the drill with the sentence that says to retry', async () => {
    rig.hasDrill = false;
    await render();
    rig.load.mockRejectedValueOnce(new Error('A network blip.'));
    await act(async () => { await expect(refreshAgentWorkspace(rig.phaseId)).rejects.toThrow('A network blip.'); });
    const start = host.querySelector<HTMLButtonElement>('[data-testid="phase-deployment-drill-start"]')!;
    expect(start.disabled).toBe(true);
    expect(start.getAttribute('data-reason')).toBe(READ_BACK_HOLD_RUN_REASON);
  });

  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('autosaves exact bytes and uses the acknowledged revision for the next edit', async () => {
    await render(); type('first authored edit'); await debounce();
    expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { [pathOf()]: contentOf('first authored edit') }, initial);
    expect(status()).toBe('Saved');
    rig.save.mockResolvedValueOnce({ saved: true, version: later }); type('second authored edit'); await debounce();
    expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { [pathOf()]: contentOf('second authored edit') }, next);
    expect(readVersionedWorkspaceDraft(rig.phaseId)).toBeNull(); expect(status()).toBe('Saved');
  });

  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('keeps a 409 draft and requires the actual Compare choice before using the server version', async () => {
    await render(); rig.save.mockRejectedValueOnce(new ApiError(409, 'another writer saved'));
    rig.load.mockResolvedValue(phase(rig.phaseId, later, 'other saved copy'));
    type('retained local edit'); await debounce();
    expect(textarea().value).toBe('retained local edit');
    expect(readVersionedWorkspaceDraft(rig.phaseId)).toEqual({ files: { [pathOf()]: contentOf('retained local edit') }, baseVersion: initial });
    await click(actionName()); expect(actionMock()).not.toHaveBeenCalled(); expect(rig.save).toHaveBeenCalledTimes(1);
    await click('Compare versions'); expect(getByRole(host, 'dialog').textContent).toContain('other saved copy');
    expect(getByRole(host, 'dialog').textContent).toContain('retained local edit');
    rig.save.mockResolvedValueOnce({ saved: true, version: '2026-09-15T11:03:00.000Z' });
    await click('Save my draft');
    expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { [pathOf()]: contentOf('retained local edit') }, later);
    expect(readVersionedWorkspaceDraft(rig.phaseId)).toBeNull(); expect(status()).toBe('Saved');
  });

  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('loads an explicitly selected saved copy without issuing another write', async () => {
    await render(); rig.save.mockRejectedValueOnce(new ApiError(409, 'conflict')); rig.load.mockResolvedValue(phase(rig.phaseId, later, 'reviewed server copy'));
    type('local copy'); await debounce(); await click('Compare versions'); await click('Use saved version');
    expect(textarea().value).toBe('reviewed server copy'); expect(rig.save).toHaveBeenCalledTimes(1);
    expect(readVersionedWorkspaceDraft(rig.phaseId)).toBeNull();
    type('edit after comparison'); await debounce(); expect(rig.save.mock.calls.at(-1)?.[2]).toBe(later);
  });

  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('waits for the exact save acknowledgement before the phase action', async () => {
    const held = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(held.promise);
    await render(); type('must save before action'); await click(actionName());
    expect(rig.save).toHaveBeenCalledTimes(1); expect(actionMock()).not.toHaveBeenCalled();
    await act(async () => held.resolve({ saved: true, version: next }));
    expect(actionMock()).toHaveBeenCalledOnce(); expect(actionMock()).toHaveBeenCalledWith(rig.phaseId);
  });

  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('does not send the phase action when the save is interrupted', async () => {
    await render(); rig.save.mockRejectedValueOnce(new Error('offline')); type('unsaved body'); await click(actionName());
    expect(actionMock()).not.toHaveBeenCalled(); expect(textarea().value).toBe('unsaved body');
    expect(readVersionedWorkspaceDraft(rig.phaseId)?.baseVersion).toBe(initial);
  });

  /**
   * The pass banner the frame mounts records the reflection and the advance and
   * then routes away. This room's buffer is debounced, and its only other flush
   * is the one that leaves with the page (unawaited, after the router has
   * already moved) so Continue has to settle it first, exactly as the phase
   * room and the design studio do.
   */
  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('flushes the room’s buffer before the pass banner continues', async () => {
    await render(); type('written just before continuing');
    await act(async () => { await rig.beforeContinue!(); });
    expect(rig.save).toHaveBeenCalledExactlyOnceWith(rig.phaseId, { [pathOf()]: contentOf('written just before continuing') }, initial);
  });

  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('refuses to continue while the buffer is in conflict, and writes nothing', async () => {
    await render(); rig.save.mockRejectedValueOnce(new ApiError(409, 'another writer saved'));
    rig.load.mockResolvedValue(phase(rig.phaseId, later, 'other saved copy'));
    type('retained local edit'); await debounce();
    await act(async () => { await expect(rig.beforeContinue!()).rejects.toThrow('this phase was not closed'); });
    expect(rig.save).toHaveBeenCalledTimes(1);
    expect(readVersionedWorkspaceDraft(rig.phaseId)?.files[pathOf()]).toBe(contentOf('retained local edit'));
  });

  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('refuses to continue when the buffer will not save', async () => {
    await render(); rig.save.mockRejectedValueOnce(new Error('offline'));
    type('unsaved just before continuing');
    await act(async () => { await expect(rig.beforeContinue!()).rejects.toThrow('this phase was not closed'); });
    expect(rig.save).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('unsaved just before continuing');
  });

  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('restores a returning stale draft for comparison instead of silently replaying it', async () => {
    window.localStorage.setItem(`lsdlc_draft_${rig.phaseId}`, JSON.stringify({ at: Date.now(), by: rig.owner, baseVersion: initial, files: { [pathOf()]: contentOf('returning draft') } }));
    rig.load.mockResolvedValue(phase(rig.phaseId, later, 'saved on another visit'));
    await render(); await debounce(); expect(textarea().value).toBe('returning draft'); expect(rig.save).not.toHaveBeenCalled();
    await click('Compare versions'); await click('Use saved version');
    expect(textarea().value).toBe('saved on another visit'); expect(readVersionedWorkspaceDraft(rig.phaseId)).toBeNull();
  });

  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('does not adopt another owner’s late phase read after navigation', async () => {
    const held = deferred<PhaseDetail>(); const old = phase(); old.projectSlug = 'old-private-project'; rig.load.mockReturnValueOnce(held.promise);
    await render(); rig.owner = 'new-document-owner'; rig.token = 'new-document-token'; rig.phaseId = 'new-document-phase';
    await render(); await act(async () => held.resolve(old));
    expect(rig.setProject).not.toHaveBeenCalledWith('old-private-project'); expect(textarea().value).toBe(kind === 'change' ? 'original entry' : 'original runbook');
    type('new owner edit'); await debounce(); expect(rig.save.mock.calls.at(-1)?.[0]).toBe('new-document-phase');
  });

  // The drill page holds no editor, but it still flushes and conflict-blocks a runbook edit
  // recovered from the IDE's Runbook tab, and it reads its phase the same guarded way.
  if (kind === 'drill') it('flushes a recovered runbook record before the pass banner continues', async () => {
    recoverRunbook('written just before continuing');
    await render();
    await act(async () => { await rig.beforeContinue!(); });
    expect(rig.save).toHaveBeenCalledExactlyOnceWith(rig.phaseId, { [RUNBOOK_JSON]: 'written just before continuing' }, initial);
    expect(readVersionedWorkspaceDraft(rig.phaseId)).toBeNull();
  });

  if (kind === 'drill') it('refuses to continue while the recovered runbook record is in conflict, and writes nothing more', async () => {
    recoverRunbook('retained local edit');
    await render(); rig.save.mockRejectedValueOnce(new ApiError(409, 'another writer saved'));
    rig.load.mockResolvedValue(phase(rig.phaseId, later, 'other saved copy'));
    await act(async () => { await expect(rig.beforeContinue!()).rejects.toThrow('this phase was not closed'); });
    expect(rig.save).toHaveBeenCalledTimes(1);
    await act(async () => { await expect(rig.beforeContinue!()).rejects.toThrow('this phase was not closed'); });
    expect(rig.save).toHaveBeenCalledTimes(1);
    expect(readVersionedWorkspaceDraft(rig.phaseId)?.files[RUNBOOK_JSON]).toBe('retained local edit');
  });

  if (kind === 'drill') it('refuses to continue when the recovered runbook record will not save', async () => {
    recoverRunbook('unsaved just before continuing');
    await render(); rig.save.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await expect(rig.beforeContinue!()).rejects.toThrow('this phase was not closed'); });
    expect(rig.save).toHaveBeenCalledTimes(1);
    expect(readVersionedWorkspaceDraft(rig.phaseId)?.files[RUNBOOK_JSON]).toBe('unsaved just before continuing');
  });

  if (kind === 'drill') it('does not adopt another owner’s late phase read after navigation', async () => {
    const held = deferred<PhaseDetail>(); const old = phase(); old.projectSlug = 'old-private-project'; rig.load.mockReturnValueOnce(held.promise);
    await render(); rig.owner = 'new-document-owner'; rig.token = 'new-document-token'; rig.phaseId = 'new-document-phase';
    await render(); await act(async () => held.resolve(old));
    expect(rig.setProject).not.toHaveBeenCalledWith('old-private-project');
    expect(rig.load.mock.calls.at(-1)?.[0]).toBe('new-document-phase');
  });

  if (kind === 'drill') it('ignores an older failed background read after a newer action refresh succeeded', async () => {
    rig.seed = phase(); const held = deferred<PhaseDetail>();
    rig.load.mockReturnValueOnce(held.promise).mockResolvedValueOnce(phase(rig.phaseId, later));
    await render();
    await click(actionName());
    expect(rig.load).toHaveBeenCalledTimes(2);
    await act(async () => held.reject(new Error('STALE BACKGROUND FAILURE')));
    expect(queryByText(host, 'STALE BACKGROUND FAILURE')).toBeNull();
  });

  it('does not issue a clean phase action across a token change during its flush microtask', async () => {
    await render(); await act(async () => { fireEvent.click(getByRole(host, 'button', { name: actionName() })); rig.token = 'replacement-document-token'; });
    expect(actionMock()).not.toHaveBeenCalled();
  });

  it('does not show a late failed GET belonging to a replaced token', async () => {
    const held = deferred<PhaseDetail>(); rig.load.mockReturnValueOnce(held.promise); await render();
    rig.token = 'replacement-document-token';
    await act(async () => held.reject(new Error('OLD PRIVATE REQUEST FAILURE')));
    expect(queryByText(host, 'OLD PRIVATE REQUEST FAILURE')).toBeNull();
  });

  it('does not display or follow up on an action result from the replaced session', async () => {
    await render(); const held = deferred<unknown>(); actionMock().mockReturnValueOnce(held.promise);
    await click(actionName()); expect(actionMock()).toHaveBeenCalledOnce();
    rig.token = 'replacement-token-during-action';
    await act(async () => held.resolve(kind === 'change' ? { id: 'old-submission', status: 'completed', attempt: 99 } : { exit: 0 }));
    expect(rig.poll).not.toHaveBeenCalled(); expect(rig.load).toHaveBeenCalledTimes(1); expect(rig.invalidate).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('submission 99'); expect(host.textContent).not.toContain('The health check passes on your files.');
  });

  it('starts only one operation when native action clicks occur before a rerender', async () => {
    await render(); const held = deferred<unknown>(); actionMock().mockReturnValueOnce(held.promise);
    await act(async () => { const button = getByRole(host, 'button', { name: actionName() }); fireEvent.click(button); fireEvent.click(button); });
    expect(actionMock()).toHaveBeenCalledOnce();
    await act(async () => held.resolve(kind === 'change' ? { id: 'submission', status: 'completed', attempt: 1 } : { exit: 0 }));
  });

  it('refuses a mismatched phase response without adopting its files or project', async () => {
    const wrong = phase('wrong-phase'); wrong.projectSlug = 'wrong-phase-project'; rig.load.mockResolvedValueOnce(wrong);
    await render(); expect(textarea()).toBeNull(); expect(rig.setProject).not.toHaveBeenCalled(); expect(rig.save).not.toHaveBeenCalled();
  });

  // the change room's editor: the drill page holds none (the runbook is written in the IDE's Runbook tab)
  if (kind === 'change') it('ignores an older failed background read after a newer action refresh succeeded', async () => {
    rig.seed = phase(); const held = deferred<PhaseDetail>();
    rig.load.mockReturnValueOnce(held.promise).mockResolvedValueOnce(phase(rig.phaseId, later, 'latest acknowledged document'));
    await render();
    await click(actionName());
    expect(rig.load).toHaveBeenCalledTimes(2);
    expect(textarea().value).toBe('latest acknowledged document');
    await act(async () => held.reject(new Error('STALE BACKGROUND FAILURE')));
    expect(queryByText(host, 'STALE BACKGROUND FAILURE')).toBeNull();
  });

  it('shows the already-saved review or incident while refreshing the cached document', async () => {
    const seed = phase(); seed.lastSubmission = { id: 'retained-submission', attempt: 4, status: 'completed' } as PhaseDetail['lastSubmission'];
    rig.seed = seed; const held = deferred<PhaseDetail>(); rig.load.mockReturnValueOnce(held.promise);
    await render();
    if (kind === 'change') {
      expect(host.textContent).toContain('PR-6 open, submission 4');
      expect(host.textContent).not.toContain('PR-6 opens when you submit');
    } else {
      expect(getByRole(host, 'button', { name: 'Run the selfcheck' })).toBeDefined();
      expect(queryByText(host, 'The drill has not started')).toBeNull();
    }
    await act(async () => held.resolve(seed));
  });

  it('still displays the failure of the current document request', async () => {
    rig.load.mockRejectedValueOnce(new Error('CURRENT DOCUMENT FAILURE'));
    await render(); expect(queryByText(host, 'CURRENT DOCUMENT FAILURE')).not.toBeNull();
  });
});

/** An edit the IDE's Runbook tab left unsaved, recovered on the drill page. */
const recoverRunbook = (text: string) =>
  window.localStorage.setItem(`lsdlc_draft_${rig.phaseId}`, JSON.stringify({ at: Date.now(), by: rig.owner, baseVersion: initial, files: { [RUNBOOK_JSON]: text } }));

it('flushes a recovered runbook record before starting a drill and blocks start on conflict', async () => {
  rig.kind = 'drill'; rig.hasDrill = false;
  recoverRunbook('retained pre-drill edit');
  const held = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(held.promise);
  await render(); await click('Start the drill'); expect(rig.start).not.toHaveBeenCalled();
  rig.load.mockResolvedValue(phase(rig.phaseId, later, 'server runbook'));
  await act(async () => held.reject(new ApiError(409, 'conflict')));
  expect(rig.start).not.toHaveBeenCalled(); expect(readVersionedWorkspaceDraft(rig.phaseId)?.files[RUNBOOK_JSON]).toBe('retained pre-drill edit');
});

it('does not resolve the drill while the recovered runbook record is conflicted', async () => {
  rig.kind = 'drill'; recoverRunbook('local runbook'); await render(); rig.save.mockRejectedValueOnce(new ApiError(409, 'conflict')); rig.load.mockResolvedValue(phase(rig.phaseId, later, 'server runbook'));
  await click('Incident record');
  for (const label of ['rootCause', 'fix', 'actionItem']) act(() => fireEvent.change(host.querySelector(`textarea[aria-label="${label}"]`)!, { target: { value: `A sufficiently explained ${label} with retained evidence.` } }));
  await click('Declare resolved'); expect(rig.resolve).not.toHaveBeenCalled(); expect(rig.save).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('All three lines need at least 20 characters');
});

it('resolves with complete incident fields only after the recovered runbook record\'s save is acknowledged', async () => {
  rig.kind = 'drill'; recoverRunbook('corrected runbook'); const held = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(held.promise);
  await render(); await click('Incident record');
  const explanation = Object.fromEntries(['rootCause', 'fix', 'actionItem'].map(key => [key, `A sufficiently explained ${key} with retained evidence.`]));
  for (const [label, value] of Object.entries(explanation)) act(() => fireEvent.change(host.querySelector(`textarea[aria-label="${label}"]`)!, { target: { value } }));
  await click('Declare resolved'); expect(rig.resolve).not.toHaveBeenCalled();
  await act(async () => held.resolve({ saved: true, version: next }));
  expect(rig.resolve).toHaveBeenCalledWith(rig.phaseId, explanation);
});

it('an older-format Deployment (no runbook) draws the room\'s sentence and never resolves, by the button or by ⌘↵', async () => {
  rig.kind = 'drill';
  rig.load.mockImplementation(async () => { const older = phase() as unknown as Record<string, unknown>; delete older.runbook; return older as unknown as PhaseDetail; });
  await render();
  expect(host.textContent).toContain(RUNBOOK_OLDER_FORMAT_ROOM);
  await click('Incident record');
  for (const label of ['rootCause', 'fix', 'actionItem']) act(() => fireEvent.change(host.querySelector(`textarea[aria-label="${label}"]`)!, { target: { value: `A sufficiently explained ${label} with retained evidence.` } }));
  const resolve = host.querySelector<HTMLButtonElement>('[data-testid="phase-deployment-drill-resolve"]')!;
  expect(resolve.disabled).toBe(true);
  expect(resolve.getAttribute('data-reason')).toBe(RUNBOOK_OLDER_FORMAT_ROOM);
  await act(async () => { fireEvent.click(resolve); });
  await act(async () => { fireEvent.keyDown(window, { key: 'Enter', metaKey: true }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(700); });
  expect(rig.resolve).not.toHaveBeenCalled();
});

it('a Deployment with its runbook draws no older-format sentence and keeps Resolve on', async () => {
  rig.kind = 'drill'; await render();
  expect(host.textContent).not.toContain(RUNBOOK_OLDER_FORMAT_ROOM);
  const resolve = host.querySelector<HTMLButtonElement>('[data-testid="phase-deployment-drill-resolve"]')!;
  expect(resolve.disabled).toBe(false);
  expect(resolve.getAttribute('data-reason')).toBeNull();
});

it('does not make another submission poll after the active session changes', async () => {
  rig.kind = 'change'; await render(); const held = deferred<unknown>(); let pollRead!: () => Promise<unknown>;
  rig.poll.mockImplementationOnce((read: () => Promise<unknown>) => { pollRead = read; return held.promise; });
  await click('Submit PR-6'); expect(rig.submit).toHaveBeenCalledOnce(); expect(pollRead).toEqual(expect.any(Function));
  // The nudge names this exact submission and reaches the poll: a wake for the
  // wrong job, or one dropped on the way, would leave the learner watching at
  // the plain cadence with a socket that already knew the answer.
  expect(rig.jobWake).toHaveBeenCalledExactlyOnceWith('submission', 'submission');
  expect((rig.poll.mock.calls[0][2] as { wake: unknown }).wake).toBe(rig.wake);
  rig.token = 'changed-during-submission-poll';
  await expect(Promise.resolve().then(() => pollRead())).rejects.toThrow(); expect(rig.getSubmission).not.toHaveBeenCalled();
  await act(async () => held.resolve({ id: 'old-submission', status: 'completed', attempt: 99 }));
  expect(rig.load).toHaveBeenCalledTimes(1); expect(rig.invalidate).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('submission 99');
});

/**
 * The doors a split Maintenance phase puts in this room.
 *
 * Every other room with an editable buffer flushes it on the way out (the
 * backlog passes its `continueGuard`, the design board its `flushSave`, the IDE
 * its `flushSave`) because the only other write is the unawaited best-effort
 * one that leaves with the page, and that one returns without saving at all
 * while a conflict is open. If this room's rows were plain links, a click
 * inside the 700 ms debounce would carry the learner out with their words
 * still in the browser.
 */
describe('the change room when a teacher has split Maintenance', () => {
  const door = () => host.querySelector<HTMLAnchorElement>('[data-testid="task-open-concepts"]')!;
  const leaveError = () => host.querySelector('[data-testid="task-leave-error"]')?.textContent;
  beforeEach(() => { rig.kind = 'change'; rig.split = true; });

  it('draws the sibling task as a door and the room’s own task as the row it is on', async () => {
    await render();
    expect(host.querySelector('[data-testid="task-switcher"]')).not.toBeNull();
    expect(door().getAttribute('href')).toBe(`/workspace/${rig.phaseId}/quiz?task=concepts`);
    expect(host.querySelector('[data-testid="task-row-main"]')?.getAttribute('aria-current')).toBe('true');
  });

  it('writes the change request before the door opens, inside the debounce', async () => {
    await render(); type('a release entry typed a moment ago');
    // Still inside the debounce: nothing has reached the server.
    expect(rig.save).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(door()); });

    expect(rig.save).toHaveBeenCalledExactlyOnceWith(rig.phaseId, { [CHANGE_REQUEST_JSON]: contentOf('a release entry typed a moment ago') }, initial);
    expect(rig.router.push).toHaveBeenCalledWith(`/workspace/${rig.phaseId}/quiz?task=concepts`);
    expect(leaveError()).toBe('');
  });

  it('keeps the learner here when the buffer is in conflict, and says why', async () => {
    await render(); rig.save.mockRejectedValueOnce(new ApiError(409, 'another writer saved'));
    rig.load.mockResolvedValue(phase(rig.phaseId, later, 'other saved copy'));
    type('retained local edit'); await debounce();
    rig.save.mockClear();

    await act(async () => { fireEvent.click(door()); });

    // A conflict is not flushable: only the comparison in this room can settle
    // it, so the door that would carry the learner away from that dialog does
    // not open, and nothing further is written.
    expect(rig.router.push).not.toHaveBeenCalled();
    expect(rig.save).not.toHaveBeenCalled();
    // The door's own sentence. The learner pressed a task row, not Continue,
    // so "this phase was not closed" would answer a question they did not
    // ask.
    expect(leaveError()).toContain('so the other task was not opened');
    expect(leaveError()).not.toContain('this phase was not closed');
  });

  it('says the same door sentence when the save itself fails on the way out', async () => {
    await render(); type('a release entry typed a moment ago');
    rig.save.mockRejectedValueOnce(new Error('network down'));

    await act(async () => { fireEvent.click(door()); });

    expect(rig.router.push).not.toHaveBeenCalled();
    expect(leaveError()).toContain('so the other task was not opened');
    expect(leaveError()).not.toContain('this phase was not closed');
  });
});

/**
 * The answer-key door in the change room. The reference solution stays shut
 * until a strictly reviewed pass stands behind the board: a teacher's Pass
 * or Sign off writes `passed` with no review, and the API answers
 * `solution.awaitingReview`. These cases make a board-only condition in this
 * room turn red, as the pull request room's own suite does for that room.
 */
describe('the answer-key door in the change room', () => {
  const door = () => host.querySelector('[data-testid="solution-open"]');
  const passedWith = (solution: Record<string, unknown>) =>
    rig.load.mockImplementation(async () => ({ ...phase(), status: 'passed', solution }));
  beforeEach(() => { rig.kind = 'change'; });

  it('is drawn on a pass the review accepted', async () => {
    passedWith({ available: true, files: 2, readAt: null });
    await render();
    expect(host.querySelector('[data-testid="open-workspace"]')).not.toBeNull();
    expect(door()).not.toBeNull();
  });

  it('is not drawn where the board reads passed but no reviewed pass stands behind it', async () => {
    passedWith({ available: true, files: 2, readAt: null, awaitingReview: true });
    await render();
    expect(host.querySelector('[data-testid="open-workspace"]')).not.toBeNull();
    expect(door()).toBeNull();
  });
});

/**
 * The incident drill hands its frame the same door, so its header's
 * Details offers the reference solution as the phase's workspace and its
 * review page do, on the same rule.
 */
describe('the answer-key door on the incident drill', () => {
  const door = () => host.querySelector('header [data-testid="solution-open"]');
  const passedWith = (solution: Record<string, unknown>) =>
    rig.load.mockImplementation(async () => ({ ...phase(), status: 'passed', solution }));
  beforeEach(() => { rig.kind = 'drill'; });

  it('is handed to the header on a pass the review accepted', async () => {
    passedWith({ available: true, files: 2, readAt: null });
    await render();
    expect(door()?.textContent).toBe('Read the reference solution');
    expect(door()?.getAttribute('href')).toBe(`/workspace/${rig.phaseId}/solution`);
  });

  it('is not handed over where the board reads passed but no reviewed pass stands behind it', async () => {
    passedWith({ available: true, files: 2, readAt: null, awaitingReview: true });
    await render();
    // the page has loaded: its title, "Incident drill" since the rooms branch named the page once
    expect(host.querySelector('h1')?.textContent).toBe('Incident drill');
    expect(door()).toBeNull();
  });
});

/**
 * The incident drill's header
 * Submit, mounted in its page. It is held by the rules every other page of the
 * phase holds Submit by (the countersignature awaited, a revision in review, an
 * assistant operation and its read-back, an older record), and its own submit
 * sends the commit draft, clears the draft and the runbook's assistant marks
 * once the submission is taken, says the verdict with the way to the review,
 * and reads the new revision's drill report.
 */
describe('the incident drill’s header Submit', () => {
  const submitButton = () => host.querySelector<HTMLButtonElement>('header [data-testid="header-submit"]')!;
  const press = () => act(async () => { fireEvent.click(submitButton()); });
  const busyOn = (on: boolean) => act(() => { window.dispatchEvent(new CustomEvent(AGENT_BUSY, { detail: { phaseId: rig.phaseId, busy: on } })); });
  const signOffTask = (over: Record<string, unknown> = {}) => ({ key: 'main', order: 1, required: true, title: 'The runbook', artefactType: 'config', files: [RUNBOOK_JSON],
    evidence: 'signed-off', sealed: false, status: 'in_progress', awaitingSignOff: false, attempts: 1, bestScore: null, passedAt: null, lastSubmissionId: null, resetAt: null,
    solution: { available: false, files: 0, readAt: null }, ...over });
  const withDetail = (over: Record<string, unknown>) => rig.load.mockImplementation(async () => ({ ...phase(), ...over }));
  beforeEach(() => { rig.kind = 'drill'; });

  it('is drawn beside "Open the workspace" and is live with no hold', async () => {
    await render();
    expect(host.querySelector('header [data-testid="open-workspace"]')?.textContent).toBe('Open the workspace');
    expect(submitButton().textContent).toBe('Submit PR-5');
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().getAttribute('data-reason')).toBeNull();
  });
  it('is held, with the sentence, while the teacher’s countersignature is awaited', async () => {
    withDetail({ attempts: 1, tasks: [signOffTask({ status: 'submitted', awaitingSignOff: true })] });
    await render();
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute('data-reason')).toBe(SIGN_OFF_SUBMIT_REASON);
    await press();
    expect(rig.submit).not.toHaveBeenCalled();
  });
  it('is held, with the sentence, while a revision is still in review', async () => {
    withDetail({ attempts: 1, lastSubmission: { id: 'in-review', status: 'running', passed: null, attempt: 1, createdAt: new Date().toISOString() } });
    await render();
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute('data-reason')).toBe(REVISION_IN_FLIGHT_REASON);
    await press();
    expect(rig.submit).not.toHaveBeenCalled();
  });
  it('is held during an assistant operation, and until a failed read-back of its Apply is retried', async () => {
    await render();
    busyOn(true);
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute('data-reason')).toBe(PROPOSAL_HOLD_REASON);
    busyOn(false);
    expect(submitButton().disabled).toBe(false);
    rig.load.mockRejectedValueOnce(new Error('A network blip.'));
    await act(async () => { await expect(refreshAgentWorkspace(rig.phaseId)).rejects.toThrow('A network blip.'); });
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute('data-reason')).toBe(READ_BACK_HOLD_REASON);
    await press();
    expect(rig.submit).not.toHaveBeenCalled();
    await act(async () => { await refreshAgentWorkspace(rig.phaseId); });
    expect(submitButton().disabled).toBe(false);
  });
  it('with no hold: sends the commit draft, then waits for the verdict, then reads the phase again; the draft and the runbook’s marks are spent', async () => {
    withDetail({ lastSubmission: { id: 'older', status: 'completed', passed: false, attempt: 1, createdAt: initial, report: { drill: { faultDescription: 'The old revision’s fault.' } } } });
    await render();
    expect(host.querySelector('[data-testid="drill-report"]')?.textContent).toBe('The old revision’s fault.');
    setCommitDraft(rig.phaseId, 'Roll back the bad port.');
    recordRunbookTouched(rig.phaseId, { 'rollback/0/step': 'Revert the port.' });
    withDetail({ attempts: 2, lastSubmission: { id: 'submission', status: 'completed', passed: false, attempt: 2, createdAt: later, report: { drill: { faultDescription: 'The new revision’s fault.' } } } });
    rig.poll.mockResolvedValueOnce({ id: 'submission', status: 'completed', passed: false, attempt: 2 });
    const loadsBefore = rig.load.mock.calls.length;
    await press();
    expect(rig.submit).toHaveBeenCalledWith(rig.phaseId, 'Roll back the bad port.');
    expect(rig.poll).toHaveBeenCalledTimes(1);
    expect(rig.load.mock.calls.length).toBe(loadsBefore + 1);
    const order = [rig.submit.mock.invocationCallOrder[0], rig.poll.mock.invocationCallOrder[0], rig.load.mock.invocationCallOrder.at(-1)!];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rig.invalidate).toHaveBeenCalled();
    expect(commitDraft(rig.phaseId)).toBe('');
    expect(readRunbookTouched(rig.phaseId)).toEqual({});
    // The verdict is said here, with the way to the review; the report is the new revision's
    const verdict = host.querySelector('[data-testid="header-submit-verdict"]')!;
    expect(verdict.getAttribute('role')).toBe('status');
    expect(verdict.textContent).toBe('The review asked for a revision. Read the review');
    expect(verdict.querySelector('a')?.getAttribute('href')).toBe(`/workspace/${rig.phaseId}`);
    expect(host.querySelector('[data-testid="drill-report"]')?.textContent).toBe('The new revision’s fault.');
  });
  // RC-mentor-1: the phase read after a pass moves Submit into Details; the verdict stays on the header's row.
  const verdictOnRow = () => {
    const line = host.querySelector('header [data-testid="header-submit-verdict"]');
    return line && !line.closest('details') ? line : null;
  };
  it('a pass is said as a pass, on the row, once the phase read back has passed and Submit has moved into Details', async () => {
    await render();
    const passed = { id: 'submission', status: 'completed', passed: true, attempt: 1, createdAt: later };
    withDetail({ status: 'passed', attempts: 1, lastSubmission: passed });
    rig.poll.mockResolvedValueOnce(passed);
    await press();
    expect(submitButton().closest('details')).not.toBeNull();
    expect(verdictOnRow()?.getAttribute('role')).toBe('status');
    expect(verdictOnRow()?.textContent).toBe('The review passed. Read the review');
    expect(verdictOnRow()?.querySelector('a')?.getAttribute('href')).toBe(`/workspace/${rig.phaseId}`);
  });
  it('a pass awaiting the teacher’s countersignature is said as a pass, on the row, while Submit is held in Details', async () => {
    await render();
    const passed = { id: 'submission', status: 'completed', passed: true, attempt: 1, createdAt: later };
    withDetail({ attempts: 1, lastSubmission: passed, tasks: [signOffTask({ status: 'submitted', awaitingSignOff: true, lastSubmissionId: 'submission' })] });
    rig.poll.mockResolvedValueOnce(passed);
    await press();
    expect(submitButton().closest('details')).not.toBeNull();
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute('data-reason')).toBe(SIGN_OFF_SUBMIT_REASON);
    expect(verdictOnRow()?.textContent).toBe('The review passed. Read the review');
  });
  it('a review that could not finish is said so', async () => {
    await render();
    rig.poll.mockResolvedValueOnce({ id: 'submission', status: 'failed', passed: null, attempt: 1 });
    await press();
    expect(verdictOnRow()?.textContent).toBe('The review could not be completed. Read the review');
  });
  it('a refused submission is said beside the control and keeps the commit draft', async () => {
    await render();
    setCommitDraft(rig.phaseId, 'Keep these words.');
    rig.submit.mockRejectedValueOnce(new Error('The review queue is full.'));
    await press();
    expect(host.querySelector('[data-testid="header-submit-error"]')?.textContent).toBe('The review queue is full.');
    expect(rig.poll).not.toHaveBeenCalled();
    expect(commitDraft(rig.phaseId)).toBe('Keep these words.');
    expect(host.querySelector('[data-testid="header-submit-verdict"]')).toBeNull();
  });
  it('a review still running when the wait ends says where its verdict will be read, claims no verdict, and holds Submit while it runs', async () => {
    await render();
    // RC-mentor-2: the phase is read again, so the revision still in review holds Submit rather than leaving a second press to be refused.
    withDetail({ attempts: 1, lastSubmission: { id: 'submission', status: 'running', passed: null, attempt: 1, createdAt: new Date().toISOString() } });
    rig.poll.mockRejectedValueOnce(new PollTimeoutError({ id: 'submission', status: 'running' }));
    const loadsBefore = rig.load.mock.calls.length;
    await press();
    expect(host.querySelector('[data-testid="header-submit-error"]')?.textContent).toBe('The review is still running. Open the workspace to read its verdict when it is ready.');
    expect(host.querySelector('[data-testid="header-submit-verdict"]')).toBeNull();
    expect(rig.invalidate).toHaveBeenCalled();
    expect(rig.load.mock.calls.length).toBe(loadsBefore + 1);
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute('data-reason')).toBe(REVISION_IN_FLIGHT_REASON);
    rig.submit.mockClear();
    await press();
    expect(rig.submit).not.toHaveBeenCalled();
  });
});
