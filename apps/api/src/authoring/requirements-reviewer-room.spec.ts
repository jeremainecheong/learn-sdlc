import 'reflect-metadata';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import { ContentService } from '../content/content.service';
import { DirectoryPackSource } from '../content/pack-source';
import { compilePack, type CompiledTask } from '../content/pack-compiler';
import { composeReviewMessages } from '../assistant/openai.provider';
import { taskScopeOf } from '../assistant/project-scope';
import type { ReviewInput } from '../assistant/provider.types';

/*
 * The Requirements reviewer's room line. Every Requirements phase here is a
 * story phase whose one file is requirements/story.json, the room's own
 * record: the starter (like the shelf), a teacher's copy of TaskTrackr, and
 * TaskTrackr itself since 3.0.0. Each reviewer is told the story desk and the
 * one record, never two synchronised files. The reference arm's bytes are
 * pinned here (the ai-request-digests net holds them as well).
 *
 * Pure: no database, no AI, no server.
 */

function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, 'content', 'tasktrackr', 'project.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('repository root not found');
    dir = up;
  }
  return dir;
}
const REPO = repoRoot();
const STARTER = path.join(REPO, 'apps', 'api', 'test', 'fixtures', 'upload-packs', 'starter');
const TASKTRACKR = path.join(REPO, 'content', 'tasktrackr');
const RECORD = 'requirements/story.json';
/** The retired saved-evidence lines, named so no reviewer is told them again. */
const RETIRED = ['The application automatically maintains', 'the two source files', 'my-story.md', 'record-consistency', 'in Markdown', 'shared renderer'];
const ONE_RECORD = 'Do not ask the learner to manually regenerate or synchronize the record.';
/** The authored Requirements room line, as the reviewer of the room's story task is told it. */
const STORY_DESK = 'Current Requirements learner interface: Stakeholder interview, then My backlog, a Jira-style desk.';
const STORY_DESK_ACTION = 'Use My backlog, open the story in Edit story, edit the relevant form fields, then choose Save story.';
/**
 * sha256 of TaskTrackr's Requirements review system message (the story phase). Recorded at 3.0.0 and held to
 * 5.0.0; re-pinned with TaskTrackr 6.0.0, whose plain Requirements brief the message carries.
 */
const REFERENCE_REVIEW_SYSTEM_SHA256 = '3a6d2e0117412e213954c33eab6b8ef78eaa54592b891156e3f2efb0ce366bae';

const content = new ContentService();

function draftOf(root: string, slug: string): ProjectContent {
  const source = new DirectoryPackSource(root);
  const loaded = content.loadProject(source, { convertLegacyRequirements: true });
  return { ...loaded, slug, title: 'Shelf starter', version: '0.1.0' };
}

function reviewSystems(project: ProjectContent, scope: 'reference' | 'authored' = project.slug === 'tasktrackr' ? 'reference' : 'authored'): string[] {
  const snapshot = compilePack(project);
  const phase = project.phases.find((one) => one.key === 'requirements')!;
  const tasks = snapshot.phases.find((one) => one.key === 'requirements')!.tasks as CompiledTask[];
  return tasks.map((task) => {
    const input = {
      workspace: Object.fromEntries(phase.files.filter((file) => file.editable).map((file) => [file.path, file.content])),
      criteria: task.rubric.criteria.map((one) => ({ key: one.key, title: one.title, weight: one.weight, score: 0, evidence: [] })),
      checks: [],
      overall: 0,
      hints: 0,
      ranBeforeSubmit: false,
      task,
      phaseTasks: tasks,
    } as unknown as ReviewInput;
    expect(taskScopeOf(phase, task, tasks).kind).toBe(scope);
    return composeReviewMessages(phase, input)[0].content as string;
  });
}

describe('every Requirements reviewer works on the one story record', () => {
  it('the starter is a story phase: its record is its one file, and its reviewer works on the record with no saved-evidence line', () => {
    const starter = draftOf(STARTER, 'shelf-starter');
    expect(starter.phases.find((one) => one.key === 'requirements')!.files.map((file) => file.path)).toEqual([RECORD]);
    const systems = reviewSystems(starter);
    expect(systems.length).toBeGreaterThan(0);
    for (const system of systems) {
      // The record is the Requirements room's own file, so the story task is
      // the room task and its reviewer is told the story desk.
      expect(system).toContain(STORY_DESK);
      expect(system).toContain(STORY_DESK_ACTION);
      expect(system).toContain(ONE_RECORD);
      expect(system).not.toContain('the workspace editor');
      for (const retired of RETIRED) expect([retired, system.includes(retired)]).toEqual([retired, false]);
    }
  });

  it("a teacher's copy of TaskTrackr is a story phase that mounts the record alone, and its reviewer is told of the one record", () => {
    const copy = draftOf(TASKTRACKR, 'tasktrackr-copy');
    const requirements = copy.phases.find((one) => one.key === 'requirements')!;
    expect(requirements.checks.kind).toBe('story');
    expect(requirements.files.map((file) => file.path)).toEqual([RECORD]);
    // the copy's bytes are TaskTrackr's, so its reviewer keeps the reference room
    const systems = reviewSystems(copy, 'reference');
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain(ONE_RECORD);
    for (const retired of RETIRED) expect([retired, systems[0].includes(retired)]).toEqual([retired, false]);
  });

  it("the reference arm is the story phase's, byte for byte", () => {
    const tasktrackr = content.loadProject(new DirectoryPackSource(TASKTRACKR));
    expect(tasktrackr.phases.find((one) => one.key === 'requirements')!.checks.kind).toBe('story');
    const systems = reviewSystems(tasktrackr);
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain('Current Requirements learner interface: Stakeholder interview with Dana Osei, then My backlog');
    expect(systems[0]).toContain('the rest of the project cites them qualified as US-4/AC-1, US-4/AC-2');
    expect(systems[0]).toContain(ONE_RECORD);
    for (const retired of RETIRED) expect([retired, systems[0].includes(retired)]).toEqual([retired, false]);
    expect(createHash('sha256').update(systems[0]).digest('hex')).toBe(REFERENCE_REVIEW_SYSTEM_SHA256);
  });
});
