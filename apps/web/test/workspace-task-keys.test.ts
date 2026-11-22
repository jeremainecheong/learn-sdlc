import { describe, expect, it } from 'vitest';
import type { PhaseTaskView, WorkspaceFile } from '@learnsdlc/shared';
import {
  chooseTask,
  taskActivePath,
  taskForPath,
  taskKeyToSend,
  taskPaths,
  viewKeyFor,
} from '@/components/workspace/TaskPanel';
import { taskView } from './fixtures';

/**
 * The workspace behaviours that were keyed by phase and have to be keyed by
 * task.
 *
 * Tabs, the active file, the caret and the folded folders are all remembered
 * per phase. On a split phase that memory is a lie: switching task would open
 * the previous task's file, restore the previous task's caret into it, and
 * seed the tab strip with files this task does not own. One key per task is the
 * whole fix, and a phase with one task keeps the phase id as its key: its
 * folded folders live in `localStorage`, so a key that changed shape would
 * reset every learner's tree in the product.
 */

const task = taskView;

const file = (path: string, editable = true): WorkspaceFile =>
  ({ path, content: '', editable, language: 'markdown' }) as unknown as WorkspaceFile;

const files = [
  file('requirements/draft.md'),
  file('requirements/scope.md'),
  file('requirements/backlog.md', false),
];

const split: PhaseTaskView[] = [
  task({
    key: 'story',
    order: 1,
    artefactPath: 'requirements/draft.md',
    primaryPath: 'requirements/draft.md',
    files: ['requirements/draft.md'],
  }),
  task({
    key: 'scope',
    order: 2,
    required: false,
    artefactPath: 'requirements/scope.md',
    files: ['requirements/scope.md'],
  }),
];

const sole = [task({ key: 'main', order: 1, files: ['requirements/draft.md', 'requirements/scope.md'] })];

/** The record the Requirements room writes (`PHASE_ROOM_ARTEFACT.requirements`). */
const STORY_RECORD = 'requirements/story.json';

describe('tab seeding, the active-file fallback and the view memory are keyed by task', () => {
  it('seeds the tab strip with the files the selected task owns, in the phase’s order', () => {
    expect(taskPaths(split[1], files)).toEqual(['requirements/scope.md']);
    // A path the task claims that the phase does not mount is not a tab.
    expect(taskPaths(task({ key: 'ghost', order: 9, files: ['nowhere.md'] }), files)).toEqual([]);
  });

  it('opens on the task’s primary path, then on the first file it owns', () => {
    expect(taskActivePath(split[0], files)).toBe('requirements/draft.md');
    expect(taskActivePath(split[1], files)).toBe('requirements/scope.md');
    // Nothing owned and nothing primary: the phase's own fallback still decides.
    expect(taskActivePath(task({ key: 'bare', order: 3 }), files)).toBe('');
    expect(taskActivePath(undefined, files)).toBe('');
  });

  it('remembers a split phase per task and a one-task phase exactly where it always did', () => {
    expect(viewKeyFor('p1', split, 'story')).toBe('p1:story');
    expect(viewKeyFor('p1', split, 'scope')).toBe('p1:scope');
    // Switching task therefore cannot restore the previous task's caret.
    expect(viewKeyFor('p1', split, 'story')).not.toBe(viewKeyFor('p1', split, 'scope'));
    // One task is the phase. The key is the phase id, character for character.
    expect(viewKeyFor('p1', sole, 'main')).toBe('p1');
    expect(viewKeyFor('p1', undefined, null)).toBe('p1');
    expect(viewKeyFor('p1', [], null)).toBe('p1');
  });

  it('resolves the selected task, and falls back to the first unpassed required one', () => {
    expect(chooseTask(split, 'scope')?.key).toBe('scope');
    // A stale key is not a silent pick of whatever is first in the array: it is
    // the same task the panel itself opens on.
    expect(chooseTask(split, 'gone')?.key).toBe('story');
    expect(chooseTask(split, null)?.key).toBe('story');
    const done = [
      task({ key: 'story', order: 1, status: 'passed' }),
      task({ key: 'criteria', order: 2, status: 'in_progress' }),
    ];
    expect(chooseTask(done, null)?.key).toBe('criteria');
    expect(chooseTask(undefined, null)).toBeUndefined();
  });

  it('gives a record room its task by the record that room writes, and no other file a task', () => {
    const story = [
      task({ key: 'story', order: 1, files: [STORY_RECORD] }),
      task({ key: 'concepts', order: 2, artefactType: 'quiz', files: [] }),
    ];
    // A story task declares no artefact path; the task that owns the record answers.
    expect(taskForPath(story, STORY_RECORD)?.key).toBe('story');
    // A file that is no record room's answers nothing, so no written task is a room.
    expect(taskForPath(split, 'requirements/scope.md')).toBeUndefined();
    expect(taskForPath(split, 'requirements/draft.md')).toBeUndefined();
    expect(taskForPath(split, 'requirements/backlog.md')).toBeUndefined();
  });

  it('gives the room the task that declares the record, not the first that owns it', () => {
    // `owner` is order 1 and owns the record; `declarer` is order 2 and is the
    // task the record *is*. The room writes the declarer's record, so every
    // revision it posts is the declarer's.
    const both = [
      task({ key: 'owner', order: 1, files: [STORY_RECORD] }),
      task({ key: 'declarer', order: 2, artefactPath: STORY_RECORD, files: [STORY_RECORD] }),
    ];
    expect(taskForPath(both, STORY_RECORD)?.key).toBe('declarer');
    // The declarer wins from either side of the order.
    const reversed = [both[1], both[0]].map((t, at) => ({ ...t, order: at + 1 }));
    expect(taskForPath(reversed, STORY_RECORD)?.key).toBe('declarer');
    // Ownership is still the fallback where no task declares the record at all.
    const undeclared = both.map((t) => ({ ...t, artefactPath: undefined }));
    expect(taskForPath(undeclared, STORY_RECORD)?.key).toBe('owner');
  });

  it('sends a task key only where the phase has more than one task', () => {
    expect(taskKeyToSend(sole, 'main')).toBeUndefined();
    expect(taskKeyToSend(undefined, null)).toBeUndefined();
    expect(taskKeyToSend([], null)).toBeUndefined();
    expect(taskKeyToSend(split, 'scope')).toBe('scope');
    expect(taskKeyToSend(split, null)).toBe('story');
  });
});
