// @vitest-environment jsdom
/**
 * The content of the learner's code-phase pages.
 *
 * - The change request's forms, and the runbook's, sit in padded
 *   boxes with spaced rows, as the design room's record forms do; the Add
 *   control sits beside its field, not on the box's bottom edge.
 * - The Request section's lists say what the saved record holds
 *   ("None listed yet." over an empty list) and the phase's files are offered
 *   under their own label, never drawn as entries of the record.
 * - The line the paged run printed is kept for the tab, keyed by the
 *   drill, and the IDE's drill shows it after the page that started the drill
 *   has gone.
 * - The runbook's incident timeline reads its stored instants on
 *   the local clock, the machine value in `dateTime`.
 * - Before any verdict the release record never reads "Added:
 *   nothing. Changed: nothing.", names its blank lines, and its tag names the
 *   record's version.
 * - Beside "Not measured", a Code quality Met says what it rests on.
 * - The review's provider is a labelled fact, not a bare id.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_CHANGE_REQUEST, EMPTY_RUNBOOK, serialiseRunbook,
  type AnalyzerReport, type ChangeRequest, type DrillState, type FeedbackReport, type PhaseDetail, type SubmissionView,
} from '@learnsdlc/shared';
import { ChangeFloorCheck, FORM_PANEL, ReleaseForm, RequestForm, TestsForm, AmendmentsForm } from '@/components/workspace/panels/maintenance/ChangeForms';
import { RunbookTab } from '@/components/workspace/panels/deployment/RunbookTab';
import { heldDrillAlert, rememberDrillAlert } from '@/components/workspace/panels/deployment/alert-text';
import { clearSession } from '@/lib/session';
import { DRILL_ALERT_PREFIX } from '@/lib/drill-alert-key';
import deploymentPanel from '@/components/workspace/panels/deployment';
import { NOT_READ_YET, blanksSentence, buildRelease, type ReleaseInput } from '@/components/workspace/panels/maintenance/release';
import { ReleaseRecordCard } from '@/components/workspace/panels/maintenance/ChangeCards';
import type { MaintenanceModel } from '@/components/workspace/panels/maintenance/useMaintenance';
import { Thumb } from '@/components/shell/Thumb';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';
import { MET_BY_REVIEWER_NOTE } from '@/components/pr/analysisReach';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => <a href={href} {...rest}>{children}</a>,
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); sessionStorage.clear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const render = (node: ReactNode) => act(() => root.render(node));
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const classes = (el: Element | null) => [...(el?.classList ?? [])];

const TICKET = { id: 'CR-1', title: 'Completed tasks are not overdue', summary: 'A done task is never overdue.', acceptance: [{ id: 'AC-1', line: 'A completed task is never overdue.' }] };
const FILES = ['web/src/lib/overdue.test.ts', 'web/src/lib/overdue.ts'];
const record = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({ ...EMPTY_CHANGE_REQUEST, ...over }) as ChangeRequest;

/* ----------------------------- padded forms ------------------------------ */

describe('the change request\'s forms and the runbook\'s sections are padded boxes', () => {
  it('every form box of the Request, Contract, Checks and Release sections carries the inner padding and row gap', () => {
    const withItems = record({
      contract: [{ id: 'C1', method: 'GET', path: '/tasks', change: 'changed', why: 'w' }],
      tests: [{ id: 'T1', suite: 's', covers: ['AC-1'], result: 'pass' }],
      release: { version: '1.1.0', summary: 's', changes: [{ id: 'L1', line: 'l', covers: ['AC-1'] }], rollback: 'r' },
    } as Partial<ChangeRequest>);
    render(<>
      <RequestForm ticket={TICKET} change={withItems} files={FILES} editable onChange={() => {}} />
      <AmendmentsForm change={withItems} editable onChange={() => {}} />
      <TestsForm ticket={TICKET} change={withItems} editable onChange={() => {}} />
      <ReleaseForm ticket={TICKET} change={withItems} editable onChange={() => {}} />
      <ChangeFloorCheck text="{}" spec={{ contract: false, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true }, ticket: TICKET }} />
    </>);
    const boxes = ['change-ticket', 'change-impact-operations', 'change-impact-screens', 'change-impact-files', 'change-amendments', 'change-tests', 'change-release', 'change-floor'];
    for (const id of boxes) {
      const box = q(id);
      expect(box, id).not.toBeNull();
      expect(classes(box), id).toEqual(expect.arrayContaining(['panel', 'p-3.5', 'gap-3', 'flex', 'flex-col']));
    }
    expect(FORM_PANEL).toBe('flex flex-col gap-3 p-3.5');
    // The Add control sits beside its field on one wrapping row, and the field takes the room left.
    for (const list of ['operations', 'screens', 'files']) {
      const form = q(`change-impact-${list}-input`)!.closest('form')!;
      expect(classes(form), list).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'gap-2']));
      expect(classes(q(`change-impact-${list}-input`)), list).toContain('flex-1');
      expect(form.contains(q(`change-impact-${list}-add`)), list).toBe(true);
    }
    // The list's own Add buttons keep their width rather than stretching across the box.
    for (const id of ['change-amendment-add', 'change-test-add', 'change-line-add', 'change-check']) expect(classes(q(id)), id).toContain('self-start');
  });

  it('every runbook section carries the same padding and gap', () => {
    const detail = { key: 'deployment', artifactKind: 'config', runbook: { floor: { minEnvironment: 0, minHealth: 0, minRollback: 0, minData: 0, requireIncident: false }, drill: true }, files: [] } as unknown as PhaseDetail;
    render(<RunbookTab detail={detail} text={serialiseRunbook(EMPTY_RUNBOOK)} onChange={() => {}} editable />);
    for (const id of ['runbook-section-environment', 'runbook-section-health', 'runbook-section-rollback', 'runbook-section-data', 'runbook-section-incident', 'runbook-section-notes']) {
      expect(classes(q(id)), id).toEqual(expect.arrayContaining(['panel', 'p-3.5', 'gap-3']));
    }
    expect(classes(q('runbook-add-environment'))).toContain('self-start');
  });
});

/* -------------------------- the Request section -------------------------- */

describe('the Request section lists what the saved record holds, and offers the phase\'s files apart', () => {
  it('an empty record reads "None listed yet." in each list, and the files are offers under their own label', () => {
    render(<RequestForm ticket={TICKET} change={record()} files={FILES} editable onChange={() => {}} />);
    for (const list of ['operations', 'screens', 'files']) expect(q(`change-impact-${list}-listed`)!.textContent, list).toBe('None listed yet.');
    const offers = q('change-impact-files-offers')!;
    expect(offers.getAttribute('role')).toBe('group');
    expect(offers.getAttribute('aria-label')).toBe('Files this phase can change');
    expect(offers.textContent).toContain('Files this phase can change. Press one to list it.');
    for (const path of FILES) {
      const offer = q(`change-impact-files-offer-${path}`)!;
      expect(offers.contains(offer), path).toBe(true);
      expect(q('change-impact-files-listed')!.contains(offer), path).toBe(false);
    }
  });

  it('a listed file is in the listed row, with its Remove, and is no longer offered; pressing an offer lists it', () => {
    const onChange = vi.fn();
    render(<RequestForm ticket={TICKET} change={record({ impact: { operations: [], screens: [], files: [FILES[1]] } })} files={FILES} editable onChange={onChange} />);
    expect(q('change-impact-files-listed')!.textContent).toContain(FILES[1]);
    expect(q('change-impact-files-listed')!.querySelector(`button[aria-label="Remove ${FILES[1]}"]`)).not.toBeNull();
    expect(q(`change-impact-files-offer-${FILES[1]}`)).toBeNull();
    act(() => { fireEvent.click(q(`change-impact-files-offer-${FILES[0]}`)!); });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ impact: expect.objectContaining({ files: [FILES[1], FILES[0]] }) }));
  });

  it('a record that can no longer be edited reads "None listed." with no "yet"', () => {
    render(<RequestForm ticket={TICKET} change={record()} files={FILES} editable={false} onChange={() => {}} />);
    for (const list of ['operations', 'screens', 'files']) expect(q(`change-impact-${list}-listed`)!.textContent, list).toBe('None listed.');
  });

  it('every file listed: no offers group is drawn', () => {
    render(<RequestForm ticket={TICKET} change={record({ impact: { operations: [], screens: [], files: [...FILES] } })} files={FILES} editable onChange={() => {}} />);
    expect(q('change-impact-files-offers')).toBeNull();
  });
});

/* ------------------------- the paged run's line -------------------------- */

const PAGED = '2026-11-17T03:12:04.506Z';
const drill = (over: Partial<DrillState> = {}): DrillState => ({
  fault: 'api-url', pagedAt: PAGED, runbookBefore: null, pagedExit: 1, healthRanAt: null, healthExit: null,
  fixAppliedAt: null, resolvedAt: null, incident: null, ...over,
});
const ALERT = 'selfcheck: API_URL points at 127.0.0.1:8000, which is the web container itself';
const SENTENCE = 'no longer holds the alert text';

describe('the paged run\'s line is kept for the tab while that drill is open', () => {
  it('reads back for the same drill, and never for another or a resolved one (each clears it), nor with no drill', () => {
    rememberDrillAlert('p-5', PAGED, ALERT);
    expect(heldDrillAlert('p-5', drill())).toBe(ALERT);
    expect(heldDrillAlert('p-6', drill())).toBe('');
    expect(heldDrillAlert('p-5', drill({ pagedAt: '2026-11-17T04:00:00.000Z' }))).toBe('');
    // the stale entry was cleared, so the first drill does not read it back either
    expect(heldDrillAlert('p-5', drill())).toBe('');
    rememberDrillAlert('p-5', PAGED, ALERT);
    expect(heldDrillAlert('p-5', drill({ resolvedAt: '2026-11-17T03:13:00.000Z' }))).toBe('');
    expect(heldDrillAlert('p-5', drill())).toBe('');
    // No drill (a page before the phase has loaded) reads nothing and clears nothing.
    rememberDrillAlert('p-5', PAGED, ALERT);
    expect(heldDrillAlert('p-5', null)).toBe('');
    expect(heldDrillAlert('p-5', drill())).toBe(ALERT);
  });

  it('signing out leaves nothing of the drill for the next account in the tab, and nothing else is touched', () => {
    rememberDrillAlert('p-5', PAGED, ALERT);
    rememberDrillAlert('p-9', PAGED, ALERT);
    sessionStorage.setItem('another-key', 'kept');
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith('learnsdlc:drill-alert:'))).toHaveLength(2);
    clearSession();
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith('learnsdlc:drill-alert:'))).toEqual([]);
    expect(sessionStorage.getItem('another-key')).toBe('kept');
  });

  it('signing out on a page that never loaded the drill\'s code (Home after a reload) still removes them, by the one shared prefix', async () => {
    // What a page of the phase kept before the reload, written by the drill's own code.
    rememberDrillAlert('p-5', PAGED, ALERT);
    rememberDrillAlert('p-9', PAGED, ALERT);
    sessionStorage.setItem('another-key', 'kept');
    // the drill's code writes under the shared prefix, so the sweep below cannot drift from it
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith(DRILL_ALERT_PREFIX))).toHaveLength(2);
    // The page after a full load: the session module loaded afresh, the drill's module not, so no sweep of its own is
    // registered with this session.
    vi.resetModules();
    const fresh = await import('@/lib/session');
    expect(fresh.clearSession).not.toBe(clearSession);
    fresh.clearSession();
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith(DRILL_ALERT_PREFIX))).toEqual([]);
    expect(sessionStorage.getItem('another-key')).toBe('kept');
  });

  it('storage that throws keeps nothing and reads nothing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => rememberDrillAlert('p-5', PAGED, ALERT)).not.toThrow();
    expect(heldDrillAlert('p-5', drill())).toBe('');
  });

  const toolsProps = (state: DrillState | null, start = vi.fn()) => ({
    detail: { id: 'p-5', key: 'deployment', title: 'Deployment', artifactKind: 'config', projectSlug: 'deadline-badge', files: [], provenance: { application: 'own' }, lastSubmission: null } as unknown as PhaseDetail,
    files: {}, setFile: vi.fn(), activePath: '', submission: null, run: null, enrollment: null, theme: 'paper', links: [], setLinks: vi.fn(),
    runClock: null, setRunClock: vi.fn(), submissions: [], runs: [], drill: state,
    drillApi: { start, health: vi.fn(), resolve: vi.fn() }, reloadPhase: vi.fn(),
    helpers: { runNow: vi.fn(), submitNow: vi.fn(), flushSave: vi.fn(async () => {}), openFile: vi.fn(), fileText: () => '', loadSubmission: vi.fn(), setPane: vi.fn(), setTab: vi.fn(), setNotice: vi.fn(), setError: vi.fn(), busy: false, saving: 'idle' },
  }) as unknown as PhasePanelProps;
  const Tools = deploymentPanel.Tools!;
  const before = () => q('phase-deployment-drill-before')!.textContent ?? '';

  it('the IDE\'s drill keeps the line after the page that started the drill has gone, and only for that drill', async () => {
    const start = vi.fn(async () => ({ ...drill(), beforeStderr: ALERT }));
    render(<Tools {...toolsProps(null, start)} />);
    await act(async () => { fireEvent.click(q('phase-deployment-drill-start')!); });
    expect(start).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    // The learner comes back (another page of the phase, or the workspace again): a fresh mount, the drill re-read.
    root = createRoot(host);
    render(<Tools {...toolsProps(drill())} />);
    await act(async () => {});
    expect(before()).toContain(ALERT);
    expect(before()).not.toContain(SENTENCE);
    // A drill paged at another moment never shows it.
    act(() => root.unmount()); root = createRoot(host);
    render(<Tools {...toolsProps(drill({ pagedAt: '2026-11-17T05:00:00.000Z' }))} />);
    await act(async () => {});
    expect(before()).toContain(SENTENCE);
    expect(before()).not.toContain(ALERT);
  });

  it('with nothing kept the sentence stays', async () => {
    render(<Tools {...toolsProps(drill())} />);
    await act(async () => {});
    expect(before()).toContain(`You were paged at`);
    expect(before()).toContain(SENTENCE);
  });
});

/* ------------------------- the incident timeline ------------------------- */

describe('the runbook\'s incident timeline reads one kind of time', () => {
  const detail = { key: 'deployment', artifactKind: 'config', runbook: { floor: { minEnvironment: 0, minHealth: 0, minRollback: 0, minData: 0, requireIncident: true }, drill: true }, files: [] } as unknown as PhaseDetail;
  const withTimeline = (timeline: { at: string; event: string }[]) =>
    serialiseRunbook({ ...EMPTY_RUNBOOK, incident: { rootCause: '', fix: '', actionItem: '', timeline } });

  it('a stored instant reads on the local 24-hour clock to the second, the instant kept in dateTime', () => {
    const at = '2026-11-17T03:12:04.506Z';
    render(<RunbookTab detail={detail} text={withTimeline([{ at, event: 'Paged: the check against the faulted copy failed.' }])} onChange={() => {}} editable />);
    const line = q('runbook-incident-timeline-0')!;
    const time = line.querySelector('time')!;
    expect(time.getAttribute('dateTime')).toBe(at);
    const local = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    expect(time.textContent).toBe(local);
    expect(line.textContent).toBe(`${local} Paged: the check against the faulted copy failed.`);
    expect(line.textContent).not.toContain('2026-11-17T');
    expect(line.textContent).not.toContain('Z ');
  });

  it('words a learner typed as the "at" are drawn as written', () => {
    render(<RunbookTab detail={detail} text={withTimeline([{ at: 'just after lunch', event: 'Noticed.' }])} onChange={() => {}} editable />);
    const line = q('runbook-incident-timeline-0')!;
    expect(line.querySelector('time')).toBeNull();
    expect(line.textContent).toBe('just after lunch Noticed.');
  });
});

/* ------------------ the release record before a verdict ------------------ */

describe('the release record before any verdict', () => {
  const RECORD = record({ release: { version: '1.1.0', summary: 'Completed tasks no longer show as overdue', changes: [{ id: 'L1', line: 'Treat completed tasks as not overdue', covers: ['AC-1'] }], rollback: 'Revert the overdue change.' } } as Partial<ChangeRequest>);
  const input = (over: Partial<ReleaseInput> = {}): ReleaseInput => ({
    projectTitle: 'Deadline badge', ticket: { id: 'CR-1', title: 't', summary: 'A task that is done never shows the overdue badge.' },
    change: null, signature: 'isOverdue', contractTab: false, report: null, impactRead: false, marks: [], added: [], record: RECORD,
    enrollment: null, phaseOrder: 6, ...over,
  });
  const card = (release: ReturnType<typeof buildRelease>) => {
    const m = { ticket: { id: 'CR-1', title: 't', summary: '', acceptance: [] }, release } as unknown as MaintenanceModel;
    render(<ReleaseRecordCard m={m} pr="PR-6" />);
    return q('phase-maintenance-release')!;
  };

  it('the card states what the saved record holds, never "Added: nothing. Changed: nothing.", and names the blank lines', () => {
    const release = buildRelease(input());
    const section = card(release);
    const text = section.textContent ?? '';
    expect(text).not.toContain('Added: nothing');
    expect(text).not.toContain('Changed: nothing');
    expect(text).toContain('Release: Completed tasks no longer show as overdue. Treat completed tasks as not overdue.');
    expect(text).toContain('Rollback: Revert the overdue change.');
    expect(text).toContain('2 lines are still blank: What changed and Tests. The record is published when PR-6 merges.');
    // the merge publishes the record; it does not write the blank lines (the review does, on Submit)
    expect(text).not.toContain('Written when');
    expect(release.lines.find((l) => l.label === 'What changed')).toEqual({ label: 'What changed', text: '', state: 'todo', todo: NOT_READ_YET });
  });

  it('a reading where nothing moved is a blank line: not printed as written, and named as blank', () => {
    const report = { passed: true, tests: { passed: 1, failed: 0, errored: 0, total: 1, cases: [{ name: 'a', status: 'passed' }] } } as unknown as FeedbackReport;
    const release = buildRelease(input({ report, impactRead: true, marks: [], added: [] }));
    const what = release.lines.find((l) => l.label === 'What changed')!;
    expect(what.state).toBe('todo');
    expect(what.text).not.toBe('');
    const text = card(release).textContent ?? '';
    expect(text).not.toContain('What changed:');
    expect(text).not.toContain('Added: nothing');
    expect(text).toContain('One line is still blank: What changed.');
  });

  it('the tag names the record\'s version and no other', () => {
    const section = card(buildRelease(input()));
    const tag = section.querySelector('svg[data-thumb="release"]')!;
    expect(tag.querySelector('text')!.textContent).toBe('1.1.0');
    expect(tag.innerHTML).not.toMatch(/>1\.1</);
    expect(section.textContent).toContain('Release record 1.1.0');
  });

  it('with no version written the tag names none', () => {
    const unversioned = record({ release: { ...RECORD.release, version: '' } });
    const section = card(buildRelease(input({ record: unversioned })));
    expect(section.querySelector('svg[data-thumb="release"] text')).toBeNull();
  });

  it('the drawing alone keeps its own "1.1", a long version is set smaller, and a label is escaped', () => {
    expect(renderToStaticMarkup(<Thumb kind="release" />)).toContain('>1.1</text>');
    const long = renderToStaticMarkup(<Thumb kind="release" label="10.20.300" />);
    expect(long).toMatch(/font-size="(\d+(\.\d+)?)"[^>]*>10\.20\.300</);
    expect(Number(/font-size="([\d.]+)"[^>]*>10\.20\.300</.exec(long)![1])).toBeLessThan(12);
    const odd = renderToStaticMarkup(<Thumb kind="release" label={'<b>&'} />);
    expect(odd).not.toContain('<b>');
    expect(odd).toContain('&#60;b&#62;&#38;');
  });

  it('one blank line is named in the singular', () => {
    const release = buildRelease(input({ report: { passed: true, tests: { passed: 1, failed: 0, errored: 0, total: 1, cases: [{ name: 'a', status: 'passed' }] } } as unknown as FeedbackReport }));
    const tests = release.lines.find((l) => l.label === 'Tests')!;
    expect(tests.state).not.toBe('todo');
    expect(blanksSentence(release)).toBe('Every line is written.');
    const noTests = buildRelease(input({ report: { passed: false } as unknown as FeedbackReport }));
    expect(blanksSentence(noTests)).toBe('One line is still blank: Tests.');
  });
});

/* --------------------- code quality and the provider ---------------------- */

const NOTHING_READ: AnalyzerReport = { issues: [], metrics: { files: 0, functions: 0, todosRemaining: 0, maxComplexity: 0, docstringCoverage: 1 }, functions: [], imports: [] } as AnalyzerReport;
const TWO_FILES: AnalyzerReport = { issues: [], metrics: { files: 2, functions: 5, todosRemaining: 0, maxComplexity: 3, docstringCoverage: 0.8 } } as AnalyzerReport;
const report = (staticAnalysis: AnalyzerReport, codeQuality: { met: boolean; evidence: string; issue?: string }, provider = 'openai'): FeedbackReport => ({
  assessmentMode: 'strict_binary', overall: 100, passed: true,
  criteria: [
    { key: 'correctness_hidden', title: 'Hidden tests', weight: 0.4, score: 100, evidence: ['5/5 passed'] },
    { key: 'code_quality', title: 'Code quality', weight: 0.15, score: 100, evidence: [] },
  ],
  checks: [
    { id: 'hidden-tests', label: 'Hidden test suite (edge cases)', status: 'passed', detail: '5/5 passed' },
    { id: 'static-analysis', label: 'Static analysis', status: 'passed', detail: 'No findings.' },
  ],
  staticAnalysis,
  aiReview: {
    verdict: 'pass', summary: 'Fine.', strengths: [], improvements: [], processNote: '', provider,
    criteriaEvidence: [
      { key: 'correctness_hidden', met: true, evidence: 'ok', issue: '', nextStep: '' },
      { key: 'code_quality', met: codeQuality.met, evidence: codeQuality.evidence, issue: codeQuality.issue ?? '', nextStep: '' },
    ],
  },
  aiReliance: { hintsThisPhase: 0, index: 0 },
  integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
}) as unknown as FeedbackReport;
const submission = (r: FeedbackReport) => ({ id: 's-1', status: 'completed', passed: true, attempt: 1, createdAt: '2026-11-17T03:00:00.000Z', report: r }) as unknown as SubmissionView;
const EVIDENCE = 'web/src/lib/overdue.ts keeps isOverdue small and readable.';

describe('Code quality Met beside Not measured says what it rests on', () => {
  it('nothing measured and Met: the reviewer\'s reading, with its evidence', async () => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(NOTHING_READ, { met: true, evidence: EVIDENCE }))} />));
    const note = q('criterion-met-by-reviewer')!;
    expect(note.textContent).toBe(`${MET_BY_REVIEWER_NOTE} The reviewer wrote: ${EVIDENCE}`);
    expect(MET_BY_REVIEWER_NOTE).toBe("Met is the reviewer's reading of the submitted code, not a measurement.");
    // the not-measured note above it is unchanged
    expect(q('criterion-not-measured')!.textContent).toBe('No file in this phase is one the analyzer reads, so nothing was measured for this criterion.');
  });

  it('nothing measured and not met: no Met sentence', async () => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(NOTHING_READ, { met: false, evidence: '', issue: 'Too long.' }))} />));
    expect(q('criterion-met-by-reviewer')).toBeNull();
    expect(q('criterion-not-measured')).not.toBeNull();
  });

  it('files measured: no Met sentence', async () => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(TWO_FILES, { met: true, evidence: EVIDENCE }))} />));
    expect(q('criterion-met-by-reviewer')).toBeNull();
  });
});

describe('the review\'s provider is a labelled fact', () => {
  const chip = () => q('ai-review')!.querySelector('.chip')!.textContent;
  it.each([
    ['openai', 'Reviewed by OpenAI'],
    ['local-mentor', 'Reviewed by Built-in mentor'],
    ['unavailable', 'No model answered'],
    ['not-applicable', 'Marked by the key'],
  ])('%s reads "%s"', async (provider, words) => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(TWO_FILES, { met: true, evidence: 'ok' }, provider))} />));
    expect(chip()).toBe(words);
    expect(q('ai-review')!.textContent).not.toMatch(/(^|[^A-Za-z])openai([^A-Za-z]|$)/);
  });
});
