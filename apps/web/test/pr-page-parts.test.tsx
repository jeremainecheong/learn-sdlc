// @vitest-environment jsdom
/**
 * The pull request page's and the planted bugs page's
 * own parts, the working-area row's words, and the review components.
 *
 * - The row's review entry is "Pull request" in every code phase.
 * - The page's own Submit is "Submit PR-<n>" / "Submit PR-<n> again", primary only while
 *   handing in is the next step.
 * - A first submission is drawn as whole files, not as "+13 -0" of additions.
 * - A room of its own's pull request is titled by one rule.
 * - The planted bugs page's figures, its one phrase for a test no bug depends on, and the line over its
 *   to-do list that points at red only where something is red.
 * - Checks every criterion shares are listed once; the Pass card does not say how to continue; a code span is drawn as code and a rule whose floor is 0 is not drawn as done.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackReport, MutantRow, PhaseDetail, SubmissionView } from '@learnsdlc/shared';

const mocks = vi.hoisted(() => ({ getSubmissionWithFiles: vi.fn(), teacherEvidence: vi.fn(), teacherFeedback: vi.fn(), submissionSignOff: vi.fn() }));
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, getSubmissionWithFiles: mocks.getSubmissionWithFiles } };
});
vi.mock('@/lib/api-experience', async (original) => {
  const actual = await original<typeof import('@/lib/api-experience')>();
  return { ...actual, experienceApi: { ...actual.experienceApi, teacherEvidence: mocks.teacherEvidence, teacherFeedback: mocks.teacherFeedback, submissionSignOff: mocks.submissionSignOff } };
});
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const { AREA_REVIEW_LABEL, areaEntries } = await import('@/components/workspace/AreaNav');
const { prSubmitLabel, prSubmitLeads } = await import('@/components/pr/submitName');
const { DiffView } = await import('@/components/pr/DiffView');
const { fileDiff } = await import('@/components/pr/diff');
const { MergeCard } = await import('@/components/pr/MergeCard');
const { ownPrTitle, prHeadline, firstSentence } = await import('@/components/pr/headline');
const { checkRows } = await import('@/components/pr/ChecksCard');
const { withInlineCode } = await import('@/components/pr/inlineCode');
const { zeroFloorChecks, withoutZeroFloor } = await import('@/components/pr/floorZero');
const { sharedEvidence } = await import('@/components/pr/criteriaEvidence');
const { FeedbackPanel, passedLine } = await import('@/components/workspace/FeedbackPanel');
const { SubmissionEvidence } = await import('@/components/experience/SubmissionEvidence');
const { MatrixCard, MatrixGrid, NO_BUG_BEHIND, WhatToDo, whatToDoPurpose } = await import('@/components/workspace/panels/testing/MatrixDoc');
const { matrixView } = await import('@/components/workspace/panels/testing/lib');

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.teacherFeedback.mockResolvedValue([]);
  mocks.submissionSignOff.mockResolvedValue(null);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/* ------------------------------------------------------------- the row */

describe('the row names the review page "Pull request" in every code phase', () => {
  for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as const) {
    it(`${key}: the entry that opens /pr reads Pull request`, () => {
      expect(AREA_REVIEW_LABEL[key]).toBe('Pull request');
      const entry = areaEntries({ id: 'p', key, change: { ticket: { id: 'CR-1', title: 'T', summary: '', acceptance: [] }, contract: false, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true } } } as never)
        .find((one) => one.page === 'pr');
      expect(entry?.label).toBe('Pull request');
      expect(entry?.href).toBe('/workspace/p/pr');
    });
  }
  it('no row entry says Reviews', () => {
    for (const key of ['implementation', 'testing', 'deployment'] as const) {
      expect(areaEntries({ id: 'p', key } as never).map((one) => one.label)).not.toContain('Reviews');
    }
  });
});

/* --------------------------------------------------------- the submit */

describe('the page\'s own Submit', () => {
  it('is named by the pull request, then "again"', () => {
    expect(prSubmitLabel(4, false)).toBe('Submit PR-4');
    expect(prSubmitLabel(4, true)).toBe('Submit PR-4 again');
  });
  it('leads only while handing in is the next step', () => {
    expect(prSubmitLeads({ merged: false, reviewPassed: false, credited: false })).toBe(true);
    expect(prSubmitLeads({ merged: false, reviewPassed: true, credited: false })).toBe(false);
    expect(prSubmitLeads({ merged: false, reviewPassed: true, credited: true })).toBe(true);
    expect(prSubmitLeads({ merged: true, reviewPassed: false, credited: false })).toBe(false);
  });
  const card = (submitLeads: boolean | undefined, submitReason?: string) => (
    <MergeCard pr="PR-6" merged={false} gateMet={false} reviewPassed score={null} gate={70} attempt={1} reason="" reflection={null}
      next={null} nextHref="/x" busy={false} submitLabel="Submit PR-6 again" submitLeads={submitLeads} submitReason={submitReason}
      onMerge={async () => undefined} onSubmitAgain={() => undefined} commitMessage="" setCommitMessage={() => undefined} />
  );
  it('the merge card draws it secondary after a Pass, and keeps it in place, held, while the sign-off is awaited', () => {
    act(() => root.render(card(false, 'Waiting for your teacher.')));
    const button = byTestId('pr-submit-again') as HTMLButtonElement;
    expect(button.textContent).toContain('Submit PR-6 again');
    expect(button.className.split(/\s+/)).toContain('btn-secondary');
    expect(button.className.split(/\s+/)).not.toContain('btn');
    expect(button.disabled).toBe(true);
  });
  it('before any submission the card draws no Submit at all (the header\'s is the one in view); once one exists it does', () => {
    const before = (
      <MergeCard pr="PR-6" merged={false} gateMet={false} reviewPassed={false} score={null} gate={70} attempt={null} reason="" reflection={null}
        next={null} nextHref="/x" busy={false} submitLabel="Submit PR-6" submitLeads onMerge={async () => undefined} onSubmitAgain={() => undefined}
        commitMessage="" setCommitMessage={() => undefined} />
    );
    act(() => root.render(before));
    expect(byTestId('pr-submit-again')).toBeNull();
    expect(byTestId('pr-merge')?.textContent).toContain('Submit your work for an evidence-based review.');
    expect([...(byTestId('pr-merge')?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).toEqual(['Merge PR-6']);
    act(() => root.render(card(true)));
    expect((byTestId('pr-submit-again') as HTMLButtonElement).textContent).toContain('Submit PR-6 again');
  });
  it('the merge card draws it primary while it leads, and when the prop is left out', () => {
    // The primary look is the plain `btn` class (components/ui Button).
    act(() => root.render(card(true)));
    expect((byTestId('pr-submit-again') as HTMLButtonElement).className.split(/\s+/)).toContain('btn');
    act(() => root.render(card(undefined)));
    expect((byTestId('pr-submit-again') as HTMLButtonElement).className.split(/\s+/)).toContain('btn');
  });
});

/* -------------------------------------------------------------- the diff */

describe('a first submission is drawn whole, not as additions', () => {
  const text = Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join('\n');
  const diff = fileDiff('web/src/lib/overdue.ts', undefined, text, [], []);
  it('whole: the size in lines, no "+13 −0", no added tint or mark', () => {
    act(() => root.render(<DiffView diff={diff} threads={[]} phaseKey="implementation" whole />));
    expect(byTestId('pr-file-whole')!.textContent).toBe('Whole file, 13 lines');
    const head = host.querySelector('header')!;
    expect(head.textContent).not.toContain('+13');
    expect(host.querySelectorAll('tr.bg-passtint')).toHaveLength(0);
    expect([...host.querySelectorAll('[data-diff-column="mark"]')].map((cell) => cell.textContent).join('')).toBe('');
    expect(host.querySelector('table')!.getAttribute('aria-label')).toBe('web/src/lib/overdue.ts as submitted');
  });
  it('a file added against an earlier submission is still drawn as added', () => {
    act(() => root.render(<DiffView diff={diff} threads={[]} phaseKey="implementation" />));
    expect(byTestId('pr-file-whole')).toBeNull();
    expect(host.querySelector('header')!.textContent).toContain('+13');
    expect(host.querySelectorAll('tr.bg-passtint')).toHaveLength(13);
  });
});

/* ------------------------------------------------------------- the title */

describe('one rule for a room of its own\'s pull request title', () => {
  const own = (over: Partial<PhaseDetail>) => ({ key: 'implementation', intro: '', files: [], ...over }) as PhaseDetail;
  it('the intro\'s first sentence, without its full stop, in every phase, never a file path', () => {
    expect(prHeadline(own({ intro: 'Fill one TODO in the overdue helper so the failing test passes.', files: [{ path: 'web/src/lib/overdue.ts', editable: true, content: '', language: 'ts' }] }), false))
      .toBe('Fill one TODO in the overdue helper so the failing test passes');
    expect(prHeadline(own({ key: 'testing', intro: 'Add one test that catches a wrong boundary.' }), false)).toBe('Add one test that catches a wrong boundary');
    expect(prHeadline(own({ key: 'deployment', intro: 'Fix one deployment setting, run the selfcheck, then run the drill and close the incident.\n\nMore.' }), false))
      .toBe('Fix one deployment setting, run the selfcheck, then run the drill and close the incident');
  });
  it('the change request\'s id and title where the phase works one', () => {
    expect(ownPrTitle({ key: 'maintenance', intro: 'Change request CR-1: a completed task is never overdue. Change the helper and keep the rest.', change: { ticket: { id: 'CR-1', title: 'Completed tasks are not overdue', summary: '', acceptance: [] }, contract: false, floor: {} as never } }))
      .toBe('CR-1 Completed tasks are not overdue');
  });
  it('the first sentence only; an empty intro reads the neutral line', () => {
    expect(firstSentence('One. Two.')).toBe('One');
    expect(firstSentence('Version 1.2 ships today. Then more.')).toBe('Version 1.2 ships today');
    expect(ownPrTitle({ key: 'testing', intro: '' })).toBe('Write the tests the brief asks for');
  });
});

/* ------------------------------------------------------- the planted bugs */

const fn = (name: string) => ({ name, path: 'web/src/lib/overdue.test.ts', line: 1 });
const mutant = (name: string, cases: { name: string; status: 'passed' | 'failed' }[]): MutantRow =>
  ({ mutant: name, description: name, killed: cases.some((c) => c.status !== 'passed'), cases }) as MutantRow;
const TESTS = ['a task due yesterday is overdue', 'a task due today is not overdue'];
const caught = matrixView([mutant('due_today', [{ name: TESTS[0], status: 'passed' }, { name: TESTS[1], status: 'failed' }])], TESTS.map(fn));
const alive = matrixView([mutant('due_today', [{ name: TESTS[0], status: 'passed' }, { name: TESTS[1], status: 'passed' }])], TESTS.map(fn));
const phase = { id: 'p-4', key: 'testing', status: 'passed', tasks: [], runClock: null } as unknown as PhaseDetail;

describe('the planted bugs page', () => {
  it('points at red only where a bug survives', () => {
    expect(whatToDoPurpose(alive, 2)).toBe('Read the red columns first: the bugs no test catches. In order:');
    expect(whatToDoPurpose(caught, 1)).toBe('Nothing is red: every planted bug is caught. One thing to know:');
    act(() => root.render(<WhatToDo view={caught} />));
    expect(byTestId('phase-testing-matrix-todo')!.textContent).toContain('Nothing is red');
    expect(byTestId('phase-testing-matrix-todo')!.textContent).not.toContain('Read the red');
  });
  it('one phrase for a test no planted bug depends on: the figure, the chip and the square', () => {
    act(() => root.render(<MatrixCard view={caught} detail={phase} />));
    const text = host.textContent ?? '';
    expect(text.split(NO_BUG_BEHIND).length - 1).toBe(2);
    expect(text).not.toContain('No bug behind it');
    expect(text).not.toContain('depends on this');
    expect(text).not.toContain('mutant');
    expect(host.querySelector(`[aria-label="${NO_BUG_BEHIND}"]`)).not.toBeNull();
    expect(renderToStaticMarkup(<MatrixGrid view={caught} />)).not.toContain('No planted bug depends on it');
  });
  it('the four figures share one grid of four columns from 1280 px (two by two below)', () => {
    act(() => root.render(<MatrixCard view={caught} detail={phase} />));
    const figures = byTestId('phase-testing-matrix-figures')!;
    expect(figures.className).toContain('grid-cols-2');
    expect(figures.className).toContain('xl:grid-cols-4');
    expect(figures.children).toHaveLength(4);
  });
});

/* ------------------------------------------------------------ the review */

const runbookReport = (): FeedbackReport => ({
  assessmentMode: 'strict_binary', overall: 100, passed: true,
  criteria: [
    { key: 'build_smoke', title: 'Selfcheck', weight: 0.3, score: 100, evidence: ['Source syntax and isolated selfcheck passed, isolated process invoked from Dockerfile command `python3 ops/selfcheck.py`. This checks source syntax.'] },
    { key: 'runbook', title: 'Runbook and incident', weight: 0.3, score: 100, evidence: ['✓ The runbook record', '✓ At least 1 health check', '✓ At least 0 data entries'] },
  ],
  checks: [
    { id: 'runbook.health.min', label: 'At least 1 health check', status: 'passed', detail: '1 health check' },
    { id: 'runbook.data.min', label: 'At least 0 data entries', status: 'passed', detail: '0 data entries' },
  ],
  aiReview: { verdict: 'pass', summary: 'Fine.', strengths: [], improvements: [], processNote: '', provider: 'openai', criteriaEvidence: [] },
  aiReliance: { hintsThisPhase: 0, index: 0 },
  integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
}) as unknown as FeedbackReport;
const storyReport = (): FeedbackReport => ({
  ...runbookReport(),
  criteria: ['story', 'criteria', 'scope'].map((key) => ({ key, title: key, weight: 0.3, score: 100, evidence: ['✓ The story record', '✓ A full story sentence'] })),
  checks: [],
}) as unknown as FeedbackReport;
const sub = (report: FeedbackReport): SubmissionView =>
  ({ id: 'sub-1', status: 'completed', passed: true, score: 100, verifiedPass: true, report, createdAt: '2026-11-17T03:00:00Z', attempt: 1, workspaceSnapshot: {} }) as unknown as SubmissionView;
const RUNBOOK_FLOOR = { runbook: { floor: { minEnvironment: 1, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true }, drill: true } };

describe('the Pass card says the evidence is accepted and leaves the way on to the band', () => {
  it('on a phase with one task, before the last phase and on it', () => {
    expect(passedLine(undefined, undefined)).toBe('All required evidence accepted.');
    expect(passedLine(undefined, undefined, null, true)).toBe('All required evidence accepted.');
  });
});

describe('checks every criterion shares are listed once', () => {
  it('the helper: identical non-empty lists only', () => {
    expect(sharedEvidence([['a', 'b'], ['a', 'b']])).toEqual(['a', 'b']);
    expect(sharedEvidence([['a'], ['a', 'b']])).toBeNull();
    expect(sharedEvidence([['a']])).toBeNull();
    expect(sharedEvidence([[], []])).toBeNull();
  });
  it('the IDE review: one list under the criteria, none in the rows; the rows keep their chips', () => {
    act(() => root.render(<FeedbackPanel submission={sub(storyReport())} />));
    const rows = [...host.querySelectorAll('tbody tr')].slice(0, 3);
    for (const row of rows) expect(row.querySelector('ul')).toBeNull();
    const shared = byTestId('criteria-shared-evidence')!;
    expect([...shared.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['✓ The story record', '✓ A full story sentence']);
    expect(host.textContent!.split('A full story sentence').length - 1).toBe(1);
  });
  it('the IDE review: different lists stay with their criteria', () => {
    act(() => root.render(<FeedbackPanel submission={sub(runbookReport())} />));
    expect(byTestId('criteria-shared-evidence')).toBeNull();
  });
  it('the feedback page\'s evidence: one shared list after the criteria', async () => {
    mocks.getSubmissionWithFiles.mockResolvedValue(sub(storyReport()));
    await act(async () => root.render(<SubmissionEvidence submissionId="sub-1" />));
    await act(async () => { await Promise.resolve(); });
    expect(byTestId('criteria-shared-evidence')!.textContent).toContain('A full story sentence');
    expect(host.textContent!.split('A full story sentence').length - 1).toBe(1);
  });
});

describe('code spans and floors of 0', () => {
  it('a code span is drawn as code without its backticks; a lone backtick is left alone', () => {
    act(() => root.render(<p>{withInlineCode('run `python3 ops/selfcheck.py`. Done')}</p>));
    expect(byTestId('review-inline-code')!.textContent).toBe('python3 ops/selfcheck.py');
    expect(host.textContent).toBe('run python3 ops/selfcheck.py. Done');
    expect(withInlineCode('a ` b')).toBe('a ` b');
  });
  it('the floors of 0 are read from the phase, never from the words', () => {
    expect([...zeroFloorChecks(RUNBOOK_FLOOR as never)]).toEqual(['runbook.data.min']);
    expect(zeroFloorChecks(undefined).size).toBe(0);
    expect(zeroFloorChecks({ runbook: { floor: { ...RUNBOOK_FLOOR.runbook.floor, minData: 2 }, drill: true } } as never).size).toBe(0);
    const zero = zeroFloorChecks(RUNBOOK_FLOOR as never);
    const report = runbookReport();
    expect(withoutZeroFloor(report.criteria[1].evidence, report.checks, zero)).toEqual(['✓ The runbook record', '✓ At least 1 health check']);
  });
  it('the IDE review: the code span as code, the rule of 0 neither ticked in the criterion nor Passed in the checks', () => {
    act(() => root.render(<FeedbackPanel submission={sub(runbookReport())} floors={RUNBOOK_FLOOR as never} />));
    expect(byTestId('review-inline-code')!.textContent).toBe('python3 ops/selfcheck.py');
    expect(host.textContent).not.toContain('`');
    const criteria = [...host.querySelectorAll('section')].find((one) => one.querySelector('h3')?.textContent === 'Criteria')!;
    expect(criteria.textContent).not.toContain('At least 0 data entries');
    expect(criteria.textContent).toContain('At least 1 health check');
    expect(byTestId('check-not-required')!.textContent).toBe('Not required');
    expect(byTestId('check-not-required')!.closest('tr')!.textContent).toContain('At least 0 data entries');
  });
  it('left without the phase\'s floors, the review draws the report as it is', () => {
    act(() => root.render(<FeedbackPanel submission={sub(runbookReport())} />));
    expect(byTestId('check-not-required')).toBeNull();
    expect(host.textContent).toContain('✓ At least 0 data entries');
  });
  it('the pull request\'s checks: Not required in the neutral tone', () => {
    const rows = checkRows(runbookReport(), zeroFloorChecks(RUNBOOK_FLOOR as never));
    expect(rows.find((row) => row.key === 'runbook.data.min')).toMatchObject({ result: 'Not required', tone: 'neutral', state: 'todo' });
    expect(rows.find((row) => row.key === 'runbook.health.min')).toMatchObject({ result: 'Passed', tone: 'pass' });
    expect(checkRows(runbookReport()).find((row) => row.key === 'runbook.data.min')?.result).toBe('Passed');
  });
  it('the feedback page\'s evidence: the rule of 0 reads Not required, and its line is not under the criterion', async () => {
    mocks.getSubmissionWithFiles.mockResolvedValue(sub(runbookReport()));
    await act(async () => root.render(<SubmissionEvidence submissionId="sub-1" floors={RUNBOOK_FLOOR as never} />));
    await act(async () => { await Promise.resolve(); });
    const rows = [...host.querySelectorAll('.exp-evidence-row')];
    const rule = rows.find((row) => row.querySelector('strong')?.textContent === 'At least 0 data entries')!;
    expect(rule.querySelector('.exp-caption')!.textContent).toBe('Not required');
    expect(rule.querySelector('[data-testid="evidence-not-required-icon"]')).not.toBeNull();
    const runbook = rows.find((row) => row.querySelector('strong')?.textContent === 'Runbook and incident')!;
    expect(runbook.textContent).not.toContain('At least 0 data entries');
    expect(byTestId('review-inline-code')!.textContent).toBe('python3 ops/selfcheck.py');
  });
});
