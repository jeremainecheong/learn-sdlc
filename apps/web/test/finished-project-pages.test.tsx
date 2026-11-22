// @vitest-environment jsdom
/**
 * The pages outside the rooms, read on a finished project and
 * on one in progress. Each describe names the rule it pins; each
 * also pins the ordinary state it leaves alone.
 */
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closureText, webSource } from './support/source-text';
import type {
  EnrollmentView,
  InstructorPhaseView,
  LearnerDossier,
  PhaseDetail,
  PhaseSummary,
  ProjectMapData,
  SubmissionView,
} from '@learnsdlc/shared';
import type { LearningGain } from '@/lib/api-concept';
import type { PhaseRecords } from '@/lib/records';

const rig = vi.hoisted(() => ({
  classroom: vi.fn(),
  leave: vi.fn(),
  join: vi.fn(),
  learningGain: vi.fn(),
}));
vi.mock('@/lib/api-experience', async (actual) => ({
  ...(await actual<typeof import('@/lib/api-experience')>()),
  experienceApi: { classroom: rig.classroom, leave: rig.leave },
}));
vi.mock('@/lib/api-cohorts', async (actual) => ({
  ...(await actual<typeof import('@/lib/api-cohorts')>()),
  cohortsApi: { join: rig.join },
}));
vi.mock('@/lib/api-instructor', async (actual) => ({
  ...(await actual<typeof import('@/lib/api-instructor')>()),
  instructorApi: { learningGain: rig.learningGain, exportLearningGain: vi.fn() },
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ reload: vi.fn() }) }));
vi.mock('@/components/experience/shared', async (actual) => ({
  ...(await actual<typeof import('@/components/experience/shared')>()),
  ExperiencePage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import ClassroomPage from '@/app/(app)/classroom/page';
import { EditorNav } from '@/components/staff/projects/EditorNav';
import { EditorSaveProvider, SAVES_AS_YOU_GO, useEditorSaveReport } from '@/components/staff/projects/save-status';
import { FOLDED_LINE, MapFiguresRow, mapFigures } from '@/components/map/MapCard';
import { LearningGainSection, ONE_LEARNER_CARD, ONE_LEARNER_EACH } from '@/components/staff/quiz-results/LearningGainSection';
import { currentPhaseWords, revisionTaskPrefix } from '@/components/staff/console/teacher-portal-model';
import { acceptingReview, quizRevisionIds } from '@/components/dossier/completion';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import { PhasePath, phaseAttemptsLine, phaseTaskLines } from '@/components/experience/shared';

const css = () => webSource('components/experience/experience.css');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const render = async (node: ReactNode) => act(async () => root.render(node));
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/* ------------------------------------------------------------------------- */
describe('My classroom masks the class join code as the teacher pages do', () => {
  it('draws the code as ••••-•••• with Show code and Copy code, and never the code in the page', async () => {
    rig.classroom.mockResolvedValue({ id: 'class-a', name: 'Saved class', joinCode: 'ABCDEFGH' });
    await render(<ClassroomPage />);
    expect(q('classroom-join-code')?.textContent).toContain('Class join code');
    expect(q('join-code')?.textContent).toBe('••••-••••');
    // Before Show code the code is in no text node and no attribute.
    expect(host.innerHTML).not.toContain('ABCD');
    expect(host.innerHTML).not.toContain('EFGH');
    const show = q('join-code-show')!;
    expect(show.getAttribute('aria-pressed')).toBe('false');
    expect(show.textContent).toBe('Show code');
    await act(async () => fireEvent.click(show));
    expect(q('join-code')?.textContent).toBe('ABCD-EFGH');
    expect(show.textContent).toBe('Hide code');
    await act(async () => fireEvent.click(show));
    expect(q('join-code')?.textContent).toBe('••••-••••');
  });

  it('copies the formatted code without showing it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    rig.classroom.mockResolvedValue({ id: 'class-a', name: 'Saved class', joinCode: 'ABCDEFGH' });
    await render(<ClassroomPage />);
    await act(async () => fireEvent.click(q('join-code-copy')!));
    expect(writeText).toHaveBeenCalledWith('ABCD-EFGH');
    expect(q('join-code')?.textContent).toBe('••••-••••');
    expect(host.textContent).toContain('Copied.');
  });

  it('shows a learner with no class the join form', async () => {
    rig.classroom.mockResolvedValue(null);
    await render(<ClassroomPage />);
    expect(q('join-code')).toBeNull();
    expect(q('classroom-join-code')).toBeNull();
    const input = host.querySelector<HTMLInputElement>('form input')!;
    expect(input.placeholder).toBe('ABCD-EFGH');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('Join class');
  });

  it('takes the input rules the onboarding code field shares, and offers Join class only for eight letters and digits', async () => {
    rig.classroom.mockResolvedValue(null);
    await render(<ClassroomPage />);
    const input = host.querySelector<HTMLInputElement>('form input')!;
    expect(input.maxLength).toBe(24);
    expect(input.getAttribute('autocapitalize')).toBe('characters');
    expect(input.getAttribute('autocomplete')).toBe('off');
    const join = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Join class')!;
    const typed = async (value: string) => act(async () => { fireEvent.change(input, { target: { value } }); });
    await typed('ABCD-EFG');
    expect(join.disabled).toBe(true);
    await typed('abcd-efgh');
    expect(join.disabled).toBe(false);
    await typed('ABCD-EFGHI');
    expect(join.disabled).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
describe('the glued status squares: Presentation view lines', () => {
  it('puts the learner name on a line of its own, so "View as" never runs into it', () => {
    expect(css()).toMatch(/\.exp-learner-identity > div > strong \{\s*display: block;\s*\}/);
    // The row's name is still the cell's <strong>, inside the identity cell: asserted on the rendered class
    // page in `teacher-class-page-refresh.test.tsx`.
  });

  it('keeps a list title with its status square a flex row, the square 8px from the words', () => {
    expect(css()).toMatch(/\.exp-list strong\.inline-flex \{\s*display: flex;\s*\}/);
    // After the rule that made every list title a block, so it wins by specificity and order.
    expect(css().indexOf('.exp-list strong.inline-flex')).toBeGreaterThan(css().indexOf('.exp-list strong {'));
    expect(closureText('LearnerTasks')).toContain('<strong className="inline-flex items-center gap-2">');
    expect(closureText('ClassProjectCard')).toContain('<strong className="inline-flex items-center gap-2">');
  });

  it("puts a board cell's caption under its badge, not against it", () => {
    expect(css()).toMatch(/\.exp-cell-button:has\(> \.exp-caption\) \{\s*flex-direction: column;\s*align-items: flex-start;\s*\}/);
    expect(css()).toMatch(/\.exp-cell-button > \.exp-caption \{\s*margin: 4px 0 0 !important;\s*\}/);
    // The caption is still the cell button's own child, with its test id.
    expect(closureText('TeacherPortal')).toMatch(
      /<small\s+className="exp-caption block"\s+data-testid=\{`evidence-wait-\$\{learner\.userId\}-\$\{key\}`\}/,
    );
  });
});

/* ------------------------------------------------------------------------- */
function Reports({ state }: { state: 'saving' | 'saved' | null }) {
  const report = useEditorSaveReport();
  useEffect(() => {
    report('run', state ? { label: 'The run', state } : null);
  }, [report, state]);
  return null;
}
const nav = (readOnly: boolean | undefined, state: 'saving' | 'saved' | null = null) => (
  <EditorSaveProvider>
    <Reports state={state} />
    <EditorNav phases={[]} value="overview" onChange={() => undefined} {...(readOnly === undefined ? {} : { readOnly })} />
  </EditorSaveProvider>
);

describe('the editor does not say every change saves on a read-only version', () => {
  it('says it on a draft', async () => {
    await render(nav(undefined));
    const line = q('editor-save-status')!;
    expect(line.textContent).toBe(SAVES_AS_YOU_GO);
    expect(line.hidden).toBe(false);
    expect(line.getAttribute('role')).toBe('status');
    // the draft's line keeps its classes
    expect(line.className).toBe('label-sm wrap m-0');
    await render(nav(false));
    expect(q('editor-save-status')!.textContent).toBe('Every change saves as you make it.');
  });

  /*
   * The status region is never hidden. A live region that is unhidden in the same moment its words
   * arrive may not be announced, so while it is empty it is only taken out of the bar's flow (`sr-only`, no gap under
   * the tabs) and stays in the page; the words that arrive later land in the region that was already there.
   */
  it('leaves the line empty on a published version until something does save, the live region there all along', async () => {
    await render(nav(true));
    const line = q('editor-save-status')!;
    expect(line.textContent).toBe('');
    expect(line.hidden).toBe(false);
    expect(line.getAttribute('aria-hidden')).toBeNull();
    expect(line.getAttribute('role')).toBe('status');
    expect(line.className).toBe('sr-only');
    await render(nav(true, 'saving'));
    expect(q('editor-save-status')).toBe(line);
    expect(line.textContent).toBe('Saving…');
    expect(line.hidden).toBe(false);
    expect(line.className).toBe('label-sm wrap m-0');
  });

  it('is told the version is read-only by the editor, from the same reason its notice says', () => {
    expect(closureText('ProjectEditor')).toContain('readOnly={frozen !== null}');
  });
});

/* ------------------------------------------------------------------------- */
describe("Home's folded map says its counts are of groups", () => {
  const enrollment = { phases: [{ key: 'requirements', status: 'passed' }, { key: 'testing', status: 'passed' }] } as unknown as EnrollmentView;
  const node = (id: string, kind: string, folded?: string[]) => ({ id, phase: 'testing', kind, label: id, state: 'pass', ...(folded ? { folded } : {}) });

  it('names what is grouped and where each block is', async () => {
    const data = { nodes: [node('fold:test:f', 'test', ['t1', 't2']), node('fold:crit:US-1', 'criterion', ['s', 'c1', 'c2'])], edges: [] } as unknown as ProjectMapData;
    const figures = mapFigures(data, enrollment);
    expect(figures.folded).toBe('both');
    await render(<MapFiguresRow figures={figures} />);
    expect(q('map-figures-folded')?.textContent).toBe('Tests and given criteria grouped here; the full map shows every block');
    expect(mapFigures({ nodes: [node('fold:test:f', 'test', ['t1', 't2'])], edges: [] } as unknown as ProjectMapData, enrollment).folded).toBe('tests');
    expect(FOLDED_LINE.criteria).toBe('Given criteria grouped by story here; the full map shows every block');
  });

  it('says nothing more on the full map, or where no block stands for two', async () => {
    const full = { nodes: [node('test:t1', 'test'), node('test:t2', 'test')], edges: [] } as unknown as ProjectMapData;
    expect(mapFigures(full, enrollment)).toEqual({ blocks: 2, lines: 0, open: 2, phases: 2 });
    const single = { nodes: [node('fold:test:f', 'test', ['t1'])], edges: [] } as unknown as ProjectMapData;
    expect('folded' in mapFigures(single, enrollment)).toBe(false);
    await render(<MapFiguresRow figures={mapFigures(full, enrollment)} />);
    expect(q('map-figures-folded')).toBeNull();
    expect([...q('map-figures')!.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['2 blocks of your work', '2 of 2 phases open']);
  });
});

/* ------------------------------------------------------------------------- */
const gainPhase = (key: string, n: number) => ({
  phaseKey: key,
  title: key,
  n,
  beforeAvgPct: n ? 50 : null,
  afterAvgPct: n ? 100 : null,
  deltaPct: n ? 50 : null,
  learners: [],
});
const drawGain = async (gain: LearningGain) => {
  rig.learningGain.mockResolvedValue(gain);
  await render(<LearningGainSection cohortId="class-a" />);
};

describe('learning gain says when a figure rests on one learner', () => {
  it('says it once, above the cards, when every figure rests on one learner', async () => {
    await drawGain({ phases: [gainPhase('requirements', 1), gainPhase('design', 1), gainPhase('maintenance', 0)] });
    expect(q('learning-gain-one-each')?.textContent).toBe(ONE_LEARNER_EACH);
    expect(q('learning-gain-one-requirements')).toBeNull();
    expect(q('learning-gain-n-requirements')?.textContent).toContain('1');
  });

  it('says it on the one card that rests on one learner when others rest on more', async () => {
    await drawGain({ phases: [gainPhase('requirements', 3), gainPhase('design', 1)] });
    expect(q('learning-gain-one-each')).toBeNull();
    expect(q('learning-gain-one-design')?.textContent).toBe(ONE_LEARNER_CARD);
    expect(q('learning-gain-one-requirements')).toBeNull();
  });

  it('says nothing more where every figure rests on two or more', async () => {
    await drawGain({ phases: [gainPhase('requirements', 2), gainPhase('design', 4)] });
    expect(q('learning-gain-one-each')).toBeNull();
    expect(host.textContent).not.toContain('not a class trend');
  });
});

/* ------------------------------------------------------------------------- */
const task = (key: string, title: string, last: string | null) => ({ key, title, required: true, lastSubmission: last ? { id: last } : null });

describe("the teacher's history names the task a review was", () => {
  it("names each task's newest review on a split phase", () => {
    const phase = { tasks: [task('story', 'Requirements (class edit)', 'r1'), task('quiz', 'Story concepts', 'r2')] } as unknown as InstructorPhaseView;
    expect(revisionTaskPrefix(phase, 'r2')).toBe('Story concepts, ');
    expect(revisionTaskPrefix(phase, 'r1')).toBe('Requirements (class edit), ');
    expect(revisionTaskPrefix(phase, 'older')).toBe('');
  });

  it('adds nothing on a phase of one task', () => {
    expect(revisionTaskPrefix({ tasks: [task('story', 'Story', 'r1')] } as unknown as InstructorPhaseView, 'r1')).toBe('');
    expect(revisionTaskPrefix({} as InstructorPhaseView, 'r1')).toBe('');
    expect(revisionTaskPrefix(undefined, 'r1')).toBe('');
  });

  it('draws it in the history option between the review number and the date', () => {
    expect(closureText('TeacherPortal')).toMatch(
      /Review \{row\.attempt \?\? history\.length - index\},\{" "\}\s*\{revisionTaskPrefix\(selection\?\.phase, row\.id\)\}\s*\{formatDate\(row\.createdAt\)\}/,
    );
  });
});

describe("the tile's submission count is true with a quiz in the phase", () => {
  const quiz = { artefactType: 'quiz' as const };
  const story = { artefactType: 'user-story' as const };
  it('leaves the quiz out of the tasks it counts across, and says so', () => {
    expect(phaseAttemptsLine(1, 2, [story, quiz])).toBe('1 submission, not counting the quiz');
    expect(phaseAttemptsLine(4, 3, [story, story, quiz])).toBe('4 submissions across 2 tasks, not counting the quiz');
    expect(phaseAttemptsLine(2, 4, [story, story, quiz, quiz])).toBe('2 submissions across 2 tasks, not counting the quizzes');
  });

  it('counts every submission across the tasks with no quiz, or with no task list to read', () => {
    expect(phaseAttemptsLine(4, 3, [story, story, story])).toBe('4 submissions across 3 tasks');
    expect(phaseAttemptsLine(1, 2)).toBe('1 submission across 2 tasks');
    const phase = { key: 'requirements', status: 'passed', attempts: 1, taskCounts: { total: 2, required: 1, passed: 2, passedRequired: 1 } } as unknown as PhaseSummary;
    expect(phaseTaskLines(phase)?.attempts).toBe('1 submission across 2 tasks');
    expect(phaseTaskLines(phase, [story, quiz])?.attempts).toBe('1 submission, not counting the quiz');
  });

  it("is what the dashboard's phase tile draws from the details it holds", async () => {
    const phase = { id: 'p-req', key: 'requirements', order: 1, title: 'Requirements', status: 'passed', attempts: 1, taskCounts: { total: 2, required: 1, passed: 2, passedRequired: 1 } } as unknown as PhaseSummary;
    await render(<PhasePath phases={[phase]} details={{ 'p-req': { tasks: [story, quiz] as never } }} />);
    expect(q('phase-path-attempts-requirements')?.textContent).toBe('1 submission, not counting the quiz');
    await render(<PhasePath phases={[phase]} />);
    expect(q('phase-path-attempts-requirements')?.textContent).toBe('1 submission across 2 tasks');
  });
});

/* ------------------------------------------------------------------------- */
describe('the board table says a completed project is complete', () => {
  it('adds "project complete" to the last phase only once the enrolment is completed', () => {
    expect(currentPhaseWords('Maintenance', true)).toBe('Maintenance, project complete');
    expect(currentPhaseWords('Maintenance', false)).toBe('Maintenance');
    expect(currentPhaseWords('Design', undefined)).toBe('Design');
    expect(closureText('TeacherPortal')).toContain(
      'currentPhaseWords(PHASE_META[currentKey(learner)!].title, enrollment?.completed)',
    );
  });
});

describe('the completion page names the review that accepted the work', () => {
  const pass = (id: string) => ({ submission: { id } });
  it('takes the newest pass that is not a quiz paper', () => {
    const quizIds = quizRevisionIds([
      { artefactType: 'user-story', lastSubmissionId: 'story-1' },
      { artefactType: 'quiz', lastSubmissionId: 'quiz-1' },
    ]);
    expect([...quizIds]).toEqual(['quiz-1']);
    expect(acceptingReview([pass('story-1'), pass('quiz-1')], quizIds)?.submission.id).toBe('story-1');
  });

  it('takes the newest pass where there is no quiz, or nothing but a quiz paper', () => {
    expect(acceptingReview([pass('a'), pass('b')], quizRevisionIds(undefined))?.submission.id).toBe('b');
    expect(acceptingReview([pass('quiz-1')], new Set(['quiz-1']))?.submission.id).toBe('quiz-1');
    expect(acceptingReview([], new Set())).toBeUndefined();
  });

  it('is what the page draws its "Accepted by review" line and its link from', () => {
    const page = closureText('app/(app)/completion/page.tsx');
    expect(page).toContain('const passed = acceptingReview(');
    expect(page).toContain('quizRevisionIds(details?.[phase.id]?.tasks)');
    expect(page).toContain('href={reviewHref(phase.id, passed?.submission.id)}');
  });
});

/* ------------------------------------------------------------------------- */
const phaseRow = { id: 'phase-test', key: 'testing', order: 4, title: 'Testing', status: 'passed', attempts: 1, bestScore: 100, passedAt: '2026-11-11T00:00:00Z' };
const enrollment = {
  phases: [phaseRow], projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [], startedAt: '2026-11-11T00:00:00Z', completedAt: null,
} as unknown as EnrollmentView;
const details = { 'phase-test': { ...phaseRow, files: [], links: [], rubric: { passThreshold: 70, criteria: [] }, drill: null } } as unknown as Record<string, PhaseDetail>;
const LONG = 'test_US2_AC1_completing_a_task_persists_done_state';
const report = {
  assessmentMode: 'strict_binary', overall: 100, passed: true, passThreshold: 70, criteria: [], checks: [],
  aiReview: { verdict: 'pass', summary: 'Fine.', strengths: [], improvements: [], processNote: '', provider: 'fixture' },
  mutation: { total: 1, killed: 1, survivors: [], matrix: [{ mutant: 'm1', description: 'Bug one', covers: 'US-2/AC-1', killed: true, cases: [{ name: LONG, status: 'failed' }, { name: 'test_short', status: 'failed' }] }] },
};
const rev = (id: string, passed = true) => ({ id, status: 'completed', passed, verifiedPass: passed, score: 100, report, createdAt: `2026-11-11T00:0${id.length}:00Z` }) as unknown as SubmissionView;
const dossierOf = (revisions: SubmissionView[], releases: unknown[] = []): LearnerDossier => {
  const records: Record<string, PhaseRecords> = { 'phase-test': { submissions: revisions, runs: [], chat: [] } };
  const built = buildDossier({ ...enrollment, releases } as unknown as EnrollmentView, details, records, {}, null);
  return { ...built, totalPhases: 1 };
};
const cells = (id: string) => [...(q(id)?.closest('[role="row"]')?.querySelectorAll('[role="cell"]') ?? [])].map((cell) => cell.textContent);

describe('the dossier: the reviews column adds up to the cover', () => {
  it('prints the revisions a phase holds, as "Submitted reviews" counts them', async () => {
    const d = dossierOf([rev('r1', false), rev('r22')]);
    expect(d.phases[0].attempts).toBe(1);
    await render(<Dossier dossier={d} />);
    expect(host.textContent).toContain('Reviews');
    expect(cells('dossier-score-1')[2]).toBe('2');
  });
});

describe('the dossier: a phase merged with no message is merged', () => {
  it('says "Not merged yet." until the phase has a release', async () => {
    await render(<Dossier dossier={dossierOf([rev('r1')])} />);
    expect(q('dossier-merge-message-4')?.textContent).toBe('Not merged yet.');
  });

  it('says no message was recorded once it has one with an empty note, and prints a note it has', async () => {
    const release = { phaseKey: 'testing', version: 'v4', notes: null, score: 100, createdAt: '2026-11-11T01:00:00Z' };
    await render(<Dossier dossier={dossierOf([rev('r1')], [release])} />);
    expect(q('dossier-merge-message-4')?.textContent).toBe('No merge message was recorded for this phase.');
    await render(<Dossier dossier={dossierOf([rev('r1')], [{ ...release, notes: 'Shipped the suite.' }])} />);
    expect(q('dossier-merge-message-4')?.textContent).toBe('Shipped the suite.');
  });
});

describe("the dossier's kill matrix breaks a test's name between its words", () => {
  it('offers a break after each underscore, and the words read in full', async () => {
    await render(<Dossier dossier={dossierOf([rev('r1')])} />);
    const matrix = q('dossier-matrix')!;
    expect(matrix.textContent).toContain(`${LONG}, test_short`);
    const caught = [...matrix.querySelectorAll('[role="cell"]')].find((cell) => cell.textContent?.startsWith(LONG))!;
    expect(caught.querySelectorAll('wbr').length).toBe(LONG.split('_').length - 1 + 1);
    const cases = q('dossier-cases')!;
    expect(cases.textContent).toContain(LONG);
    expect(cases.querySelectorAll('wbr').length).toBeGreaterThan(0);
  });
});
