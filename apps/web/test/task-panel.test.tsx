// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PhaseSummary, PhaseTaskView, WorkspaceFile } from '@learnsdlc/shared';
import { PHASE_ROOM_ARTEFACT_PATHS } from '@learnsdlc/shared';

/** The Requirements room's artefact on the shared list the task rows route by. */
const ROOM_RECORD = PHASE_ROOM_ARTEFACT_PATHS.requirements!;

/** One router for the file: the rows that are doors push through it. */
const rig = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => rig.router }));

import {
  TaskPanel,
  chooseTask,
  isSplit,
  isWorkSplit,
  phaseRoomTaskKey,
  soleWorkTaskKey,
  taskActivePath,
  taskCountLine,
  taskKeyToSend,
  taskPaths,
  taskRoomHref,
  viewKeyFor,
  workTasks,
} from '@/components/workspace/TaskPanel';
import { taskView } from './fixtures';

/**
 * The switcher a written phase gets once a teacher splits it.
 *
 * The rule the whole component turns on is the one in the second test: a phase
 * with one task draws **no chrome at all**. Every project until a teacher
 * splits a phase is a project of one-task phases, and every executable phase
 * stays one while the wall stands, so a chooser with one answer would be a
 * question asked of every learner in the product to serve nobody.
 */

const task = taskView;

const three: PhaseTaskView[] = [
  task({ key: 'story', order: 1, title: 'The user story', status: 'passed', attempts: 2, bestScore: 88 }),
  task({ key: 'criteria', order: 2, title: 'Acceptance criteria', attempts: 1, bestScore: 40 }),
  task({ key: 'scope', order: 3, title: 'Out of scope', required: false }),
];

describe('the task panel', () => {
  it('a one-task phase renders no switcher', () => {
    const only = [task({ key: 'main', order: 1, title: 'The phase' })];
    expect(renderToStaticMarkup(<TaskPanel tasks={only} selected="main" onSelect={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<TaskPanel tasks={undefined} selected={null} onSelect={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<TaskPanel tasks={[]} selected={null} onSelect={() => {}} />)).toBe('');
  });

  it('a three-task phase renders order, title, required or optional, status, attempts and best score', () => {
    const html = renderToStaticMarkup(<TaskPanel tasks={three} selected="criteria" onSelect={() => {}} />);

    expect(html).toContain('The user story');
    expect(html).toContain('Acceptance criteria');
    expect(html).toContain('Out of scope');
    // Order, as the teacher wrote it, not as the array happens to sit.
    expect(html.indexOf('The user story')).toBeLessThan(html.indexOf('Acceptance criteria'));
    expect(html).toContain('Required');
    expect(html).toContain('Optional');
    // No phase is named, so no gate's answer is held: a passed row says
    // "Passed", and "Review passed" only where the phase itself has passed.
    expect(html).toContain('Passed');
    expect(html).not.toContain('Review passed');
    expect(html).toContain('2 attempts');
    expect(html).toContain('1 attempt');
    expect(html).toContain('88');
    // The selected task says so, so the room and the panel cannot disagree.
    expect(html).toContain('aria-current="true"');
  });

  it('says the hint budget is the phase’s, because on a split phase it still is', () => {
    const html = renderToStaticMarkup(<TaskPanel tasks={three} selected="story" onSelect={() => {}} />);
    expect(html).toContain('Questions are counted for the whole phase');
  });

  it('is a statement, not a row of dead controls, where the room cannot switch task', () => {
    // A room built around one artefact (the design board, the change request)
    // cannot move a learner to a sibling task's room, so it offers no control
    // that would not respond.
    const html = renderToStaticMarkup(<TaskPanel tasks={three} selected="story" />);
    expect(html).not.toContain('<button');
    expect(html).toContain('The user story');
    expect(html).toContain('aria-current="true"');
  });

  /**
   * The one state word a learner reads per task, in the product's own
   * vocabulary.
   *
   * The panel is a learner's primary read of how each sibling stands, so it
   * must not read "In progress" for everything not passed, submitted or
   * locked: a task nobody has opened and a task whose last revision was
   * refused would say the same thing, and neither would say what the phase
   * list says about exactly those two states.
   */
  it('says where each task stands in the words the phase list uses', () => {
    const states = [
      task({ key: 'fresh', order: 1, title: 'Nobody has opened this', attempts: 0 }),
      task({ key: 'refused', order: 2, title: 'The last revision was refused', attempts: 2, bestScore: 41 }),
      task({ key: 'reviewing', order: 3, title: 'Marked without a pass', status: 'submitted', attempts: 1 }),
      task({ key: 'done', order: 4, title: 'Passed', status: 'passed', attempts: 1, bestScore: 88 }),
    ];
    const html = renderToStaticMarkup(<TaskPanel tasks={states} selected="fresh" />);

    expect(html).toContain('Ready to start');
    expect(html).toContain('Needs revision');
    // A whole-markup `toContain('In review')` could match a row's TITLE and
    // stay green with every status word gone. No row may say In review while
    // nothing is being marked; the rows' own words are read one by one below.
    expect(html).not.toContain('In review');
    expect(html).toContain('Passed');
    expect(html).not.toContain('Review passed');
    // "In progress" would say nothing that "0 attempts" or "2 attempts" does
    // not already carry, and say it about two different states.
    expect(html).not.toContain('In progress');
    // A `submitted` row has been marked without a pass, and with no revision
    // being marked it reads Needs revision, so each row's own word is read
    // off its own row here, with its title cut out.
    const rowWord = (key: string): string => {
      const doc = new DOMParser().parseFromString(`<ul>${html}</ul>`, 'text/html');
      const row = [...doc.querySelectorAll('li')].find((li) => li.querySelector(`[data-testid$="-${key}"]`));
      return (row?.textContent ?? '').replace(row?.querySelector('.truncate')?.textContent ?? '', '');
    };
    expect(rowWord('fresh')).toContain('Ready to start');
    expect(rowWord('refused')).toContain('Needs revision');
    expect(rowWord('reviewing')).toContain('Needs revision');
    expect(rowWord('reviewing')).not.toContain('In review');
    expect(rowWord('done')).toContain('Passed');
    expect(rowWord('done')).not.toContain('Review passed');
    // "No row says In review" is zero of them, counted by status word, never
    // by title.
    expect(html.split('In review')).toHaveLength(1);
  });

  it('keeps a countersignature ahead of the attempt count', () => {
    const waiting = [
      task({ key: 'signed', order: 1, awaitingSignOff: true, attempts: 1 }),
      task({ key: 'other', order: 2 }),
    ];
    expect(renderToStaticMarkup(<TaskPanel tasks={waiting} selected="signed" />)).toContain(
      "Awaiting your teacher&#x27;s sign-off",
    );
  });

  it('counts the required set apart from the rest', () => {
    expect(taskCountLine({ total: 4, required: 2, passed: 3, passedRequired: 1 })).toBe(
      '1 of 2 required done. Optional: 2 of 2 done',
    );
    // A phase whose tasks are all required says it once rather than twice.
    expect(taskCountLine({ total: 2, required: 2, passed: 1, passedRequired: 1 })).toBe('1 of 2 required done');
    expect(taskCountLine(undefined)).toBe('');
  });
});

/**
 * A quiz is a row, not a second piece of work.
 *
 * If `isSplit` were the only question the rooms asked, three IDE behaviours
 * would key on it: the room's memory key, the file it opens on and the tab
 * strip it seeds. A quiz added beside a code task flips that boolean on a
 * phase a cohort is already working in, and `viewKeyFor`'s own docstring says
 * what a key that changed shape does: it silently resets every learner's open
 * file, caret, scroll, panel and folded folders, the last of which live in
 * `localStorage`.
 *
 * So there are two predicates. The whole of this block is the statement that
 * `isWorkSplit` was **not** applied as a blanket: four behaviours keep
 * `isSplit`, because the row and the key are things a quiz really does add.
 */

const quiz = (over: Partial<PhaseTaskView> & { key: string; order: number }) =>
  task({ artefactType: 'quiz', evidence: 'automated', required: false, ...over });

/** One executable task and one quiz: the shape the all-six-phases rule admits. */
const codeAndQuiz: PhaseTaskView[] = [
  task({
    key: 'main',
    order: 1,
    title: 'Make the routes true to the contract',
    artefactType: 'code',
    files: ['api/routes/tasks.py'],
    primaryPath: 'api/routes/tasks.py',
  }),
  quiz({ key: 'concepts', order: 2, title: 'Concept check' }),
];

/** The phase those two tasks belong to, as every room hands it over. */
const BUILD: Pick<PhaseSummary, 'id' | 'key' | 'status'> = {
  id: 'p3',
  key: 'implementation',
  status: 'in_progress',
};

const FILES: WorkspaceFile[] = [
  { path: 'api/routes/tasks.py', content: '', editable: true, language: 'python' },
  { path: 'api/models.py', content: '', editable: true, language: 'python' },
];

describe('a quiz beside a piece of work', () => {
  it('is a row and not work: isSplit says yes, isWorkSplit says no', () => {
    expect(isSplit(codeAndQuiz)).toBe(true);
    expect(isWorkSplit(codeAndQuiz)).toBe(false);
    expect(workTasks(codeAndQuiz).map((t) => t.key)).toEqual(['main']);
    // Three quizzes beside one task is still one piece of work.
    expect(isWorkSplit([...codeAndQuiz, quiz({ key: 'more', order: 3 })])).toBe(false);
  });

  it('leaves the room’s memory key exactly where it was', () => {
    expect(viewKeyFor('p3', codeAndQuiz, null)).toBe('p3');
    expect(viewKeyFor('p3', codeAndQuiz, 'concepts')).toBe('p3');
    // A phase a teacher really has split still gets a key per task.
    expect(viewKeyFor('p1', three, 'criteria')).toBe('p1:criteria');
  });

  it('leaves the opening file and the tab strip to the room’s own defaults', () => {
    // The two expressions the IDE room evaluates, written the way it writes
    // them. With no work split there is no task-owned file to open and no
    // task-owned strip to seed, so the room falls through to its defaults.
    const chosen = chooseTask(codeAndQuiz, null);
    expect(taskActivePath(isWorkSplit(codeAndQuiz) ? chosen : undefined, FILES)).toBe('');
    // The strip seeder itself, asked directly: a code task that owns one of
    // the phase's files still answers with it, and it is the room's
    // `isWorkSplit` guard above (not this function) that leaves the strip
    // alone. Asserting the ternary instead asserted `isWorkSplit` twice.
    expect(taskPaths(chosen, FILES)).toEqual(['api/routes/tasks.py']);
    expect(taskPaths(undefined, FILES)).toEqual([]);
    // And on a genuinely split phase both still answer for the task.
    const split = [
      task({ key: 'a', order: 1, files: ['api/routes/tasks.py'], primaryPath: 'api/routes/tasks.py' }),
      task({ key: 'b', order: 2, files: ['api/models.py'], primaryPath: 'api/models.py' }),
    ];
    expect(taskActivePath(isWorkSplit(split) ? chooseTask(split, 'b') : undefined, FILES)).toBe('api/models.py');
  });

  it('opens on the executable task, required-and-first or optional-and-passed', () => {
    // This is the expression the IDE room's opening effect evaluates.
    const opening = (tasks: PhaseTaskView[]) => chooseTask(workTasks(tasks), null)?.key;

    const requiredFirst = [
      quiz({ key: 'concepts', order: 1, required: true }),
      task({ key: 'main', order: 2, title: 'The work' }),
    ];
    expect(opening(requiredFirst)).toBe('main');

    const optionalPassed = [
      task({ key: 'main', order: 1, title: 'The work' }),
      quiz({ key: 'concepts', order: 2, status: 'passed' }),
    ];
    expect(opening(optionalPassed)).toBe('main');

    // `chooseTask` itself is unaffected: asked about the whole list it still
    // answers where the work is, which is what the panel and the quiz room
    // both need.
    expect(chooseTask(requiredFirst, null)?.key).toBe('concepts');
  });

  it('keeps the row, the key and the count line on isSplit, which is the point', () => {
    // The panel draws the quiz as a second row.
    const html = renderToStaticMarkup(
      <TaskPanel
        tasks={codeAndQuiz}
        phase={BUILD}
        selected="main"
        onSelect={() => {}}
        counts={{ total: 2, required: 1, passed: 0, passedRequired: 0 }}
      />,
    );
    expect(html).toContain('Concept check');
    expect(html).toContain('Make the routes true to the contract');
    // Submit still names a task, and it names the one it can grade.
    expect(taskKeyToSend(codeAndQuiz, 'main')).toBe('main');
    // The count line is drawn for the same reason, on the same question, and
    // it counts the quiz, which is the whole of why the question is `isSplit`.
    expect(html).toContain('data-testid="task-counts"');
    expect(html).toContain('0 of 1 required done. Optional: 0 of 1 done');
  });

  it('routes the quiz row to the quiz room rather than re-keying this one', () => {
    const html = renderToStaticMarkup(
      <TaskPanel tasks={codeAndQuiz} phase={BUILD} selected="main" onSelect={() => {}} />,
    );
    expect(html).toContain('href="/workspace/p3/quiz?task=concepts"');
    expect(html).toContain('data-testid="task-open-concepts"');
    // The work row is still a control.
    expect(html).toContain('data-testid="task-choose-main"');
    expect(html).not.toContain('data-testid="task-choose-concepts"');
  });

  it('draws the quiz row as a statement in a room that was given no phase', () => {
    // A room that has not been handed a phase draws every row as a statement,
    // rather than offering a link to nowhere.
    const html = renderToStaticMarkup(<TaskPanel tasks={codeAndQuiz} selected="main" onSelect={() => {}} />);
    expect(html).not.toContain('/quiz');
    expect(html).toContain('data-testid="task-choose-concepts"');
  });
});

/**
 * Every task row is a door.
 *
 * A quiz opens its own room, a phase with no record room opens the workspace
 * on the task, and every other task of a phase with a record room opens that
 * room. No row opens a written task's own editor: a second written task (the
 * shape a version from before the markdown kind was retired may still hold)
 * opens the phase's record room.
 */

const PHASE: Pick<PhaseSummary, 'id' | 'key' | 'status'> = {
  id: 'p1',
  key: 'requirements',
  status: 'in_progress',
};

/** A split Requirements phase from an older version: the room's own story, a second story, a quiz. */
const written: PhaseTaskView[] = [
  task({
    key: 'main',
    order: 1,
    title: 'The user story',
    artefactType: 'user-story',
    artefactPath: ROOM_RECORD,
    files: [ROOM_RECORD],
  }),
  task({
    key: 'reminder-story',
    order: 2,
    title: 'The reminder story',
    artefactType: 'user-story',
    artefactPath: 'requirements/my-story-reminder-story.md',
    files: ['requirements/my-story-reminder-story.md'],
  }),
  quiz({ key: 'story-concepts', order: 3, title: 'Story concepts', required: true }),
];

describe('the room a task opens in', () => {
  it('sends every work task of a phase with a record room to that room, and a quiz to its own', () => {
    // The backlog writes `requirements/story.json`, so the task that declares
    // it is the room's own and keeps the backlog room. A second written task
    // opens the same room, never an editor of its own.
    expect(phaseRoomTaskKey('requirements', written)).toBe('main');
    expect(taskRoomHref(PHASE, written, written[0])).toBe('/workspace/p1/issue');
    expect(taskRoomHref(PHASE, written, written[1])).toBe('/workspace/p1/issue');
    expect(taskRoomHref(PHASE, written, written[2])).toBe('/workspace/p1/quiz?task=story-concepts');
  });

  it('gives a phase with no room of its own the workspace for every written task', () => {
    const build = BUILD;
    expect(phaseRoomTaskKey('implementation', codeAndQuiz)).toBeUndefined();
    expect(taskRoomHref(build, codeAndQuiz, codeAndQuiz[0])).toBe('/workspace/p3?task=main');
    expect(taskRoomHref(build, codeAndQuiz, codeAndQuiz[1])).toBe('/workspace/p3/quiz?task=concepts');
  });

  it('prefers the task that declares the artefact over one that merely owns it', () => {
    // `taskForPath`'s rule, asked from outside the room: the declarer is the
    // room's own. The owner opens the same room, never an editor of its own.
    const both: PhaseTaskView[] = [
      task({ key: 'owner', order: 1, files: [ROOM_RECORD] }),
      task({ key: 'declarer', order: 2, artefactPath: ROOM_RECORD, files: [ROOM_RECORD] }),
    ];
    expect(phaseRoomTaskKey('requirements', both)).toBe('declarer');
    expect(taskRoomHref(PHASE, both, both[0])).toBe('/workspace/p1/issue');
    expect(taskRoomHref(PHASE, both, both[1])).toBe('/workspace/p1/issue');
  });

  it('names the sole work task of a split phase, and nothing on a phase with one', () => {
    // What the rooms that read one phase-wide list send instead of nothing.
    expect(soleWorkTaskKey(codeAndQuiz)).toBe('main');
    expect(soleWorkTaskKey([task({ key: 'only', order: 1 })])).toBeUndefined();
    expect(soleWorkTaskKey(written)).toBeUndefined();
  });

  it('sends every task of a locked phase to the phase list, as every other door does', () => {
    // A locked phase has no room, so it has no task rooms either: the answer is
    // the phase list, where the reason it is locked is written down. The panel
    // cannot reach this (the workspace layout refuses a locked phase before
    // any room mounts) but the function is a door like `roomHref` and
    // `phaseDoorHref`, and a door that answered a room for a locked phase would
    // be the one door in the product that let a learner past the lock.
    const locked: Pick<PhaseSummary, 'id' | 'key' | 'status'> = { ...PHASE, status: 'locked' };
    expect(taskRoomHref(locked, written, written[0])).toBe('/phases');
    expect(taskRoomHref(locked, written, written[1])).toBe('/phases');
    // The quiz arm is the one that would otherwise answer before the lock is
    // read, because a quiz's room is named without asking the phase's own.
    expect(taskRoomHref(locked, written, written[2])).toBe('/phases');
  });
});

describe('a row that leads somewhere else', () => {
  it('is a link, and the row the room is on is not', () => {
    const html = renderToStaticMarkup(
      <TaskPanel phase={PHASE} tasks={written} selected="main" counts={undefined} />,
    );
    // The second written task opens the phase's record room.
    expect(html).toContain('href="/workspace/p1/issue"');
    expect(html).toContain('data-testid="task-open-reminder-story"');
    expect(html).toContain('href="/workspace/p1/quiz?task=story-concepts"');
    // The row the learner is already on is a statement.
    expect(html).toContain('data-testid="task-row-main"');
    expect(html).not.toContain('data-testid="task-open-main"');
    expect(html).toContain('aria-current="true"');
  });

  it('is a link out of the workspace too, back to the room that owns it', () => {
    // The IDE opened on the authored story: the phase's own story lives
    // behind the backlog's door, and the row says so.
    const html = renderToStaticMarkup(
      <TaskPanel
        phase={PHASE}
        tasks={written}
        roomPath="/workspace/p1"
        selected="reminder-story"
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('href="/workspace/p1/issue"');
    expect(html).toContain('data-testid="task-open-main"');
    expect(html).not.toContain('data-testid="task-choose-main"');
    // The row the IDE is on stays a control.
    expect(html).toContain('data-testid="task-choose-reminder-story"');
  });

  it('stays a control where the room takes every task in place', () => {
    // The answer door and the pull request read any task without moving the
    // learner, so they pass no room path and keep the controls they had.
    const html = renderToStaticMarkup(
      <TaskPanel phase={PHASE} tasks={written} selected="main" onSelect={() => {}} />,
    );
    expect(html).toContain('data-testid="task-choose-reminder-story"');
    expect(html).not.toContain('href="/workspace/p1?task=reminder-story"');
  });

  it('a phase with one task still draws nothing, and a room with no phase still states', () => {
    expect(
      renderToStaticMarkup(<TaskPanel phase={PHASE} tasks={[written[0]]} selected="main" />),
    ).toBe('');
    const html = renderToStaticMarkup(<TaskPanel tasks={written} selected="main" />);
    expect(html).toContain('The reminder story');
    expect(html).not.toContain('<a');
    expect(html).toContain('Questions are counted for the whole phase');
  });
});

describe('leaving a room through a door', () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = (node: ReactNode) => act(async () => root.render(node as never));

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

  it('waits for the room to flush before it pushes', async () => {
    let release: (() => void) | undefined;
    const flushed = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await render(
      <TaskPanel phase={PHASE} tasks={written} selected="main" onLeave={flushed} />,
    );
    const door = host.querySelector<HTMLAnchorElement>('[data-testid="task-open-reminder-story"]');
    expect(door?.getAttribute('href')).toBe('/workspace/p1/issue');

    await act(async () => {
      door?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    // The buffer is still in flight, so the learner has not been moved.
    expect(flushed).toHaveBeenCalledTimes(1);
    expect(rig.router.push).not.toHaveBeenCalled();
    // And the row says so. Otherwise a held click on a slow connection looks
    // exactly like a dead link: the URL does not move, the row does not
    // change, and a second click is swallowed without a word.
    expect(door?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('[data-testid="task-leave-error"]')?.textContent).toContain(
      'Saving your work',
    );

    await act(async () => {
      release?.();
    });
    expect(rig.router.push).toHaveBeenCalledWith('/workspace/p1/issue');
    expect(door?.getAttribute('aria-busy')).toBeNull();
  });

  it('keeps the learner where they are when the flush is refused, and says why', async () => {
    const refused = vi.fn(async () => {
      throw new Error('Finish the mentor operation before continuing.');
    });
    await render(
      <TaskPanel phase={PHASE} tasks={written} selected="main" onLeave={refused} />,
    );
    await act(async () => {
      host
        .querySelector('[data-testid="task-open-reminder-story"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(rig.router.push).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="task-leave-error"]')?.textContent).toContain(
      'Finish the mentor operation',
    );
  });
});

/**
 * The learner-side "In review", kept true.
 *
 * A task row reads `submitted` only after a verdict has landed on it without a
 * pass (`taskRollup` writes `nextPhaseStatus(held, false)`) and submitting
 * moves no task row at all. So "In review" on a `submitted` row would say a
 * revision was being marked when it had been marked, and had not passed, which is the
 * one thing a learner deciding what to do next most needs to read. Whether a
 * revision IS being marked is on the payload too: the phase's newest revision
 * (`PhaseDetail.lastSubmission`) names its task and its status. Every assertion
 * below is read off the row it is about.
 */
describe('where a task stands after a verdict, in the panel a learner reads', () => {
  const rowText = (html: string, key: string): string => {
    const doc = new DOMParser().parseFromString(`<ul>${html}</ul>`, 'text/html');
    const row = [...doc.querySelectorAll('li')].find((li) =>
      li.querySelector(`[data-testid$="-${key}"]`),
    );
    return row?.textContent ?? '';
  };
  const written = (over: Partial<PhaseTaskView> & { key: string; order: number }) =>
    task({ title: `Task ${over.key}`, ...over });

  it('says Needs revision, not In review, on written work marked without a pass', () => {
    const tasks = [
      written({ key: 'revise', order: 1, status: 'submitted', attempts: 1, bestScore: 40 }),
      written({ key: 'other', order: 2 }),
    ];
    const html = renderToStaticMarkup(<TaskPanel tasks={tasks} selected="other" />);

    expect(rowText(html, 'revise')).toContain('Needs revision');
    expect(rowText(html, 'revise')).not.toContain('In review');
  });

  it('says Not passed on a quiz whose marked paper did not pass', () => {
    const tasks = [
      written({ key: 'story', order: 1 }),
      quiz({ key: 'concepts', order: 2, status: 'submitted', attempts: 1, bestScore: 50 }),
    ];
    const html = renderToStaticMarkup(<TaskPanel tasks={tasks} selected="story" />);

    expect(rowText(html, 'concepts')).toContain('Not passed');
    expect(rowText(html, 'concepts')).not.toContain('In review');
  });

  it.each(['queued', 'running'] as const)(
    'says In review while the phase’s newest revision is that task’s and is %s',
    (status) => {
      // A resubmission of work that needed revision, and a first submission
      // still being marked: the row is `submitted` in one and untouched in the
      // other, and in both the revision on the payload is what is true.
      const tasks = [
        written({ key: 'again', order: 1, status: 'submitted', attempts: 2, bestScore: 40 }),
        written({ key: 'first', order: 2, attempts: 1 }),
      ];
      const again = renderToStaticMarkup(
        <TaskPanel
          tasks={tasks}
          phase={{ ...PHASE, lastSubmission: { taskKey: 'again', status } }}
          selected="first"
        />,
      );
      expect(rowText(again, 'again')).toContain('In review');
      expect(rowText(again, 'first')).toContain('Needs revision');

      const first = renderToStaticMarkup(
        <TaskPanel
          tasks={tasks}
          phase={{ ...PHASE, lastSubmission: { taskKey: 'first', status } }}
          selected="again"
        />,
      );
      expect(rowText(first, 'first')).toContain('In review');
      expect(rowText(first, 'again')).toContain('Needs revision');
    },
  );

  it('does not call a task in review once its newest revision has been marked', () => {
    const tasks = [
      written({ key: 'revise', order: 1, status: 'submitted', attempts: 1, bestScore: 40 }),
      written({ key: 'other', order: 2 }),
    ];
    for (const status of ['completed', 'failed'] as const) {
      const html = renderToStaticMarkup(
        <TaskPanel tasks={tasks} phase={{ ...PHASE, lastSubmission: { taskKey: 'revise', status } }} selected="other" />,
      );
      expect(rowText(html, 'revise')).toContain('Needs revision');
      expect(rowText(html, 'revise')).not.toContain('In review');
    }
  });

  it('leaves a passed task and a countersignature where they were', () => {
    // A passed task stays Passed while a later revision of it is marked: the
    // pass is sticky and the chip's tone is the pass tone. And the sign-off arm
    // still leads, because the verdict is in and a teacher is what it waits on.
    const tasks = [
      written({ key: 'done', order: 1, status: 'passed', attempts: 1, bestScore: 90 }),
      written({ key: 'signed', order: 2, status: 'submitted', awaitingSignOff: true, attempts: 1 }),
    ];
    const html = renderToStaticMarkup(
      <TaskPanel tasks={tasks} phase={{ ...PHASE, lastSubmission: { taskKey: 'done', status: 'running' } }} selected="signed" />,
    );
    // The phase is still in progress, so the row keeps the neutral word: a
    // task passed there may be the teacher's sign-off with no review behind it.
    expect(rowText(html, 'done')).toContain('Passed');
    expect(rowText(html, 'done')).not.toContain('Review passed');
    expect(rowText(html, 'done')).not.toContain('In review');
    expect(rowText(html, 'signed')).toContain("Awaiting your teacher");
  });
});
