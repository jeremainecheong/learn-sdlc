// @vitest-environment jsdom
/**
 * Usability and copy rules, each held where it is decided. The sentence each
 * case pins is the one a teacher or a learner reads.
 */
import { repoPath } from './support/paths';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DraftTaskView, FeedbackReport, InstructorTaskView, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';
import { briefSummary, scoringLine } from '@/components/staff/projects/PhaseTasks';
import { libraryRowLine } from '@/components/staff/projects/ProjectsLibrary';
import { TaskEditor } from '@/components/staff/projects/TaskEditor';
import { PublishPanel } from '@/components/staff/projects/PublishPanel';
import { phaseStatusWord, taskStatusWord } from '@/components/staff/LearnerTasks';
import { reviewSummary } from '@/components/experience/review-summary';
import { ProjectNameLine } from '@/components/experience/shared';
import { checksPurpose, passedLine } from '@/components/workspace/FeedbackPanel';
import { storyStatusLabel } from '@/components/workspace/requirements/RequirementsWorkspace';
import { IssueDesk } from '@/components/workspace/panels/requirements/IssueDesk';
import { EMPTY_STORY } from '@/components/workspace/panels/requirements/story';
import { storyStarted, storyView } from '@/components/workspace/panels/requirements/useStory';
import { DEFAULT_STORY_FLOOR, QUIZ_ONLY_ADD_REFUSAL } from '@learnsdlc/shared';
/** The phase's story spec, as the API sends it on a story-kind Requirements phase. */
const SPEC = { id: 'US-4', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [] };



let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const draftTask = (over: Partial<DraftTaskView> = {}): DraftTaskView => ({
  taskKey: 'main',
  order: 1,
  required: true,
  title: 'The backlog',
  brief: '## Your task\n\nWrite US-4, the overdue report story.',
  artefactType: 'user-story',
  artefactPath: null,
  checkKind: 'story',
  rubric: { passThreshold: 70, criteria: [{ key: 'c', title: 'C', weight: 1, description: '' }] },
  objectives: [],
  owns: [],
  authorable: true,
  notice: null,
  ...over,
});

describe('F-b: a task row says what the task is, in the teacher’s terms', () => {
  it('summarises a plain brief by its first line that is not blank (a brief holds no heading)', () => {
    expect(briefSummary('Your task\n\nWrite US-4, the overdue report story.')).toBe('Your task');
    expect(briefSummary('\n\nWrite US-4, the overdue report story.\nThen hand it in.')).toBe('Write US-4, the overdue report story.');
    expect(briefSummary('- Name the actor\n- Then the goal')).toBe('- Name the actor');
    expect(briefSummary('Plain first line.\nSecond.')).toBe('Plain first line.');
    expect(briefSummary('  \n')).toBe('');
  });

  it("summarises TaskTrackr 6.0.0's Requirements, Implementation and Testing rows by the brief's own first line, with no bare label before it", () => {
    // The 6.0.0 briefs open on the line that says what the task is (the room already says "Your task")
    const pack = repoPath('content/tasktrackr/phases');
    const brief = (folder: string) => (JSON.parse(readFileSync(path.join(pack, folder, 'phase.json'), 'utf8')) as { taskPanel: string }).taskPanel;
    expect(briefSummary(brief('01-requirements'))).toBe(
      'The TaskTrackr backlog is almost complete. Product has signed off on US-1, US-2, US-3 and US-5 (shown read-only beside your story), but the overdue report story was never written, and the team cannot build what nobody has specified.',
    );
    expect(briefSummary(brief('03-implementation'))).toBe(
      'TaskTrackr is built and it runs. The lists, the comments, the schema, the error envelope, the router, the pages and every route and component around yours are written and locked. What is missing is the code behind the five sentences your design phase wrote — three in the Python API and two in the TypeScript front end — and each one is marked TODO(learner).',
    );
    expect(briefSummary(brief('04-testing'))).toBe(
      'Your implementation passed, but "the code runs" is not the same as "the behaviour is proven". In this phase you write the acceptance suites for TaskTrackr — the suites a team would run before every release.',
    );
  });

  it('names a quiz’s questions rather than its rules', () => {
    const quiz = draftTask({
      taskKey: 'concepts',
      artefactType: 'quiz',
      checkKind: 'quiz',
      quiz: {
        questions: [1, 2, 3].map((n) => ({ id: `q${n}`, stem: 's', options: [], answerCount: 1 })),
        drawn: 2,
        shuffleOptions: true,
        passMark: 50,
        attempts: { max: 2, cooldownSeconds: null },
        criterion: 'concepts',
      },
    });
    expect(scoringLine(quiz)).toBe('3 questions, 2 on each paper, pass mark 50%.');
    expect(scoringLine(quiz)).not.toContain('rules');
  });
});

describe('F-c: the library row reads as sentences', () => {
  it('says none rather than “0 classes are”, and not validated rather than a dash', () => {
    expect(libraryRowLine({ cohortsUsing: 0, lastValidatedAt: null })).toBe('No class is on it yet. Not validated yet.');
    expect(libraryRowLine({ cohortsUsing: 1, lastValidatedAt: null })).toBe('1 class is on it. Not validated yet.');
    expect(libraryRowLine({ cohortsUsing: 3, lastValidatedAt: '2026-09-20T01:00:00.000Z' })).toMatch(
      /^3 classes are on it\. Last validated .+\.$/,
    );
    expect(libraryRowLine({ cohortsUsing: 0, lastValidatedAt: null })).not.toContain('—');
  });
});

describe('F-d: Add a task offers only what can be added to the phase', () => {
  const editor = () =>
    renderToStaticMarkup(
      <TaskEditor
        task={null}
        busy={false}
        error=""
        onAdd={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
        quizOnly
        quizOnlyReason={QUIZ_ONLY_ADD_REFUSAL}
      />,
    );

  it('offers a concept quiz alone, with no type to pick, and says why', () => {
    const markup = editor();
    expect(markup).not.toContain('id="task-form-type"');
    expect(markup).toContain('Add a concept quiz');
    expect(markup).toContain(QUIZ_ONLY_ADD_REFUSAL.split('.')[0]);
  });
});

describe('F-i: the publish question goes once it has been answered', () => {
  it('does not keep the confirm box up beside the receipt', async () => {
    const report = { publishable: true, failed: 0, blocking: [] } as never;
    const draw = (published: { version: string; publishedAt: string; sandboxBudget: number } | null, editable: boolean) =>
      root.render(
        <PublishPanel
          draftVersion="1.0.0"
          report={report}
          editable={editable}
          readOnlyReason={editable ? null : 'Version 1.0.0 is published.'}
          publishing={false}
          error=""
          published={published}
          onPublish={() => {}}
        />,
      );
    act(() => draw(null, true));
    act(() => (host.querySelector('[data-testid="project-publish"]') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="project-publish-confirm"]')).not.toBeNull();

    act(() => draw({ version: '1.0.0', publishedAt: '2026-09-20T01:00:00.000Z', sandboxBudget: 12 }, false));
    expect(host.querySelector('[data-testid="project-publish-confirm"]')).toBeNull();
    expect(host.textContent).not.toContain('Publishing freezes draft');
    expect(host.querySelector('[data-testid="project-published"]')?.textContent).toContain('Version 1.0.0 is published.');
  });
});

describe('F-l: a quiz that was marked and failed is not “In review”', () => {
  const row = (over: Partial<InstructorTaskView>): InstructorTaskView =>
    ({
      key: 'concepts',
      order: 2,
      required: true,
      title: 'Concepts',
      status: 'submitted',
      bestScore: 0,
      attempts: 2,
      passedAt: null,
      awaitingSignOff: false,
      signedOffAt: null,
      lastSubmission: { id: 's2', status: 'completed', passed: false } as SubmissionView,
      quizAttemptsSpent: true,
      ...over,
    }) as InstructorTaskView;

  it('says Not passed on a spent quiz whose last paper was marked', () => {
    expect(taskStatusWord(row({}))).toBe('Not passed');
    expect(taskStatusWord(row({ quizAttemptsSpent: false }))).toBe('Not passed');
  });

  it('keeps In review while a paper is still being marked, and for written work', () => {
    expect(taskStatusWord(row({ lastSubmission: { id: 's3', status: 'running' } as SubmissionView }))).toBe('In review');
    // A last revision `completed` with no pass has been marked, not left in
    // review. Written work is in review while its revision is queued or
    // running, which is what the row pins.
    expect(
      taskStatusWord(row({ quizAttemptsSpent: undefined, lastSubmission: { id: 's4', status: 'queued' } as SubmissionView })),
    ).toBe('In review');
  });

  it('says Needs revision on written work, and Not passed on a quiz with no limit, once marked without a pass', () => {
    // `nextPhaseStatus` leaves a task `submitted` after a failed verdict, so
    // the status alone would read "In review" on a row nobody was reviewing.
    const written = row({ key: 'reminder-story', quizAttemptsSpent: undefined, lastSubmission: { id: 's5', status: 'completed', passed: false, report: { criteria: [] } } as unknown as SubmissionView });
    expect(taskStatusWord(written)).toBe('Needs revision');
    const unlimited = row({
      quizAttemptsSpent: undefined,
      required: false,
      lastSubmission: { id: 's6', status: 'completed', passed: false, report: { quiz: { questions: [] } } } as unknown as SubmissionView,
    });
    expect(taskStatusWord(unlimited)).toBe('Not passed');
    // A revision that did pass is not overwritten by either word.
    expect(taskStatusWord(row({ status: 'passed', lastSubmission: { id: 's7', status: 'completed', passed: true } as SubmissionView }))).toBe('Passed');
  });
});

/*
 * The teacher's twins of the learner's "In review". A
 * `submitted` row or phase has had a verdict; "In review" is true only while a
 * revision is queued or running, and the rest is said in the learner's words.
 */
describe('the teacher reads In review only while a revision is being marked', () => {
  const written = (over: Partial<InstructorTaskView>): InstructorTaskView =>
    ({
      key: 'reminder-story', order: 2, required: true, title: 'The reminder story', status: 'submitted',
      bestScore: 40, attempts: 2, passedAt: null, awaitingSignOff: false, signedOffAt: null, lastSubmission: null, ...over,
    }) as InstructorTaskView;

  it('says Needs revision on a submitted row whose newest revision failed to grade, or is not held', () => {
    expect(taskStatusWord(written({ lastSubmission: { id: 's1', status: 'failed' } as SubmissionView }))).toBe('Needs revision');
    expect(taskStatusWord(written({ lastSubmission: null }))).toBe('Needs revision');
    expect(taskStatusWord(written({ lastSubmission: { id: 's2', status: 'running' } as SubmissionView }))).toBe('In review');
  });

  it('announces a submitted phase in the words its learner reads', () => {
    const phase = (status: string, last: Partial<SubmissionView> | null) =>
      ({ status, lastSubmission: last } as unknown as Parameters<typeof phaseStatusWord>[0]);
    expect(phaseStatusWord(phase('submitted', { status: 'completed', passed: false }))).toBe('in progress');
    expect(phaseStatusWord(phase('submitted', null))).toBe('in progress');
    expect(phaseStatusWord(phase('submitted', { status: 'queued' }))).toBe('in review');
    expect(phaseStatusWord(phase('in_progress', { status: 'running' }))).toBe('in review');
    expect(phaseStatusWord(phase('passed', null))).toBe('passed');
  });
});

describe('F-m: the teacher’s view of a quiz is not addressed to the learner', () => {
  const quizReport = { quiz: { questions: [] }, aiReview: { summary: 'Scored against the key your teacher sealed with this quiz.' } };

  it('speaks to the teacher about the key, never as “your teacher”', () => {
    expect(reviewSummary(quizReport, true, false)).not.toContain('your teacher');
    expect(reviewSummary(quizReport, true, false)).toContain('below the pass mark');
    expect(reviewSummary(quizReport, true, true)).not.toContain('below the pass mark');
  });

  it('leaves the learner’s sentence and every non-quiz summary as stored', () => {
    expect(reviewSummary(quizReport, false, false)).toBe(quizReport.aiReview.summary);
    expect(reviewSummary({ aiReview: { summary: 'Stored.' } }, true, true)).toBe('Stored.');
  });
});

describe('F-f: the dashboard names the project', () => {
  it('draws the project’s short title from the enrolment', () => {
    act(() => root.render(<ProjectNameLine title="Library Desk — a teacher’s project" />));
    expect(host.querySelector('[data-testid="dashboard-project"]')?.textContent).toBe('Your project: Library Desk');
    act(() => root.render(<ProjectNameLine title="" />));
    expect(host.querySelector('[data-testid="dashboard-project"]')).toBeNull();
  });
});

describe('F-o: the story chip reads where the story stands', () => {
  it('says Needs revision once a review has landed without a Pass, not In review', () => {
    expect(storyStatusLabel('submitted', { status: 'completed', passed: false })).toBe('Needs revision');
    expect(storyStatusLabel('submitted', { status: 'running', passed: null })).toBe('In review');
    expect(storyStatusLabel('in_progress', null)).toBe('In progress');
    // Not "In review". The story's `submitted` is where a verdict leaves a
    // task it did not pass (`taskRollup` → `nextPhaseStatus(held, false)`),
    // and handing a revision in moves no task row, so with no revision in the
    // room to say one is being marked, "In review" is the one word known to be
    // false. It reads what the task panel reads for the same row.
    expect(storyStatusLabel('submitted', null)).toBe('Needs revision');
    expect(storyStatusLabel('submitted', null)).not.toBe('In review');
    // A passed story on a passed phase reads in the state words,
    // "Review passed" (was "Approved"); on a phase not passed, "Passed".
    expect(storyStatusLabel('passed', { status: 'completed', passed: false }, false, false, true)).toBe('Review passed');
    expect(storyStatusLabel('passed', { status: 'completed', passed: false })).toBe('Passed');
  });
});

describe('F-o: the story button says Edit once a story exists', () => {
  const desk = (story: typeof EMPTY_STORY) =>
    renderToStaticMarkup(
      <IssueDesk
        view={storyView(JSON.stringify(story), SPEC)}
        projectTitle="TaskTrackr"
        statusLabel="In progress"
        statusTone="accent"
        storyState="now"
        assignedTo="Learner"
        canRecord
        setStory={() => {}}
      />,
    );

  it('reads Edit for a story with any field written, title or not', () => {
    const untitled = { ...EMPTY_STORY, persona: 'manager who runs the morning check' };
    expect(storyStarted(untitled)).toBe(true);
    expect(desk(untitled)).toContain('Edit your story');
    expect(desk(untitled)).not.toContain('Create US-4 story');
  });

  it('still offers to create one where nothing is written', () => {
    expect(storyStarted(EMPTY_STORY)).toBe(false);
    expect(desk(EMPTY_STORY)).toContain('Create US-4 story');
  });
});

describe('F-p: a written phase’s checks are not said to run in a sandbox', () => {
  const base = { checks: [], criteria: [] } as unknown as FeedbackReport;
  it('names the sandbox only where something ran in one', () => {
    expect(checksPurpose(base)).toBe('What was checked on this submission.');
    expect(checksPurpose({ ...base, tests: { passed: 1, failed: 0, errored: 0, total: 1, cases: [] } } as FeedbackReport)).toBe(
      'What ran on this submission, in the sandbox.',
    );
  });
});

describe('F-s: a passed task in a split phase says what is left', () => {
  const task = (key: string, order: number, over: Partial<PhaseTaskView> = {}): PhaseTaskView =>
    ({ key, order, title: key === 'main' ? 'The user story' : key === 'reminder-story' ? 'The reminder story' : 'Story concepts', required: true, status: 'in_progress', ...over }) as PhaseTaskView;

  it('names the required tasks still open instead of offering a Continue that is not there', () => {
    const tasks = [task('main', 1, { status: 'passed' }), task('reminder-story', 2), task('story-concepts', 3)];
    const line = passedLine(tasks, 'reminder-story');
    expect(line).not.toContain('Continue to the next phase');
    expect(line).toContain('One required task in this phase is still open: Story concepts.');
  });

  it('counts the task that just passed as passed, even from a list a moment behind', () => {
    const tasks = [task('main', 1), task('reminder-story', 2, { required: false }), task('story-concepts', 3)];
    expect(passedLine(tasks, 'main')).toContain('One required task in this phase is still open: Story concepts.');
    expect(passedLine([task('main', 1), task('story-concepts', 3, { status: 'passed' })], 'main')).toBe(
      'All required evidence accepted.',
    );
  });

  // The plain Pass says only that the evidence is accepted; the gate band says how to continue.
  it('is one sentence on a phase with one task, with no Continue (the band carries it)', () => {
    expect(passedLine(undefined, undefined)).toBe('All required evidence accepted.');
    expect(passedLine([task('main', 1)], '')).toBe('All required evidence accepted.');
  });
});
