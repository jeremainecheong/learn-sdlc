/**
 * The Requirements builder's pure half: what a step holds, what stops a
 * save, how a key or an id is made, and the one queue every story save
 * goes through. Nothing here touches React, the network or the DOM.
 */
import type {
  DraftPhaseView,
  DraftTaskView,
  ProvidedStory,
  StoryChecksBody,
  StoryFloor,
} from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR, LEARNER_PICKS, floorSentence } from '@learnsdlc/shared';

/* ------------------------------------------------------------ the story body */

/** The line the builder shows on a task still in the older format, editable and read-only; the teacher guide quotes the first. */
export const OLDER_FORMAT_NOTICE = 'This task is in the older format. Saving any story step converts it.';
export const OLDER_FORMAT_NOTICE_READONLY = 'This task is in the older format.';

/** The story body a task in the older format opens on, and is converted to. */
export function defaultStoryBody(): StoryChecksBody {
  return {
    providedStories: [],
    learnerStory: { id: LEARNER_PICKS, hints: {} },
    floor: { ...DEFAULT_STORY_FLOOR, requiredTags: [...DEFAULT_STORY_FLOOR.requiredTags] },
  };
}

/** The story body the server holds on this task, or null on a task in the older format. */
export function storyBodyOf(task: DraftTaskView | undefined): StoryChecksBody | null {
  if (!task?.story) return null;
  return {
    providedStories: task.story.providedStories,
    learnerStory: task.story.learnerStory,
    floor: task.story.floor,
  };
}

/** The story body as the server holds it on this task, or the defaults. */
export function savedStoryBody(task: DraftTaskView): StoryChecksBody {
  return storyBodyOf(task) ?? defaultStoryBody();
}

/**
 * One queue for every save that writes the task.
 *
 * The door replaces the story body whole, and steps 3, 4 and 5 each send the
 * part they hold with the other parts filled in from what the server holds.
 * Two saves in flight at once would each fill those parts from the same
 * answer, and the later reply would put back what the earlier one wrote. So
 * each save waits for the one before it, and builds its body only when its
 * turn comes, from the answer the save before it got. A refused save does
 * not stop the queue.
 */
export function createSaveChain() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(() => work());
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

type SaveChain = ReturnType<typeof createSaveChain>;

/**
 * One task's saves, outliving the builder that started them.
 *
 * The builder is unmounted whenever the teacher opens another phase's tab, and
 * a save it started may still be queued or in flight. So the queue, the story
 * body the server holds and the count of saves not yet answered live here, by
 * project, version and task. A builder mounted again picks them up: where a
 * save is still out, what the queue holds wins over the editor's view, which
 * that save has not reached yet; otherwise the editor's view, which every
 * answer reaches, seeds it.
 */
interface TaskSaves<Body = StoryChecksBody> {
  chain: SaveChain;
  /** The checks body the server holds (a story's, or a design's), or null on a task in the older format. */
  server: Body | null;
  pending: number;
}

const taskSaves = new Map<string, TaskSaves<unknown>>();

/** One task's saves; the key names the task (the Design builder prefixes its own, so two phases' `main` never share one). */
export function taskSavesFor<Body = StoryChecksBody>(key: string, seed: Body | null): TaskSaves<Body> {
  const held = taskSaves.get(key) as TaskSaves<Body> | undefined;
  if (!held) {
    const fresh: TaskSaves<Body> = { chain: createSaveChain(), server: seed, pending: 0 };
    taskSaves.set(key, fresh as TaskSaves<unknown>);
    return fresh;
  }
  if (held.pending === 0) held.server = seed;
  return held;
}

/** Forget every task's saves; for a test that starts from nothing. */
export function forgetTaskSaves(): void {
  taskSaves.clear();
}

/* ---------------------------------------------------------------- the steps */

/** How far a weight sum may be from 1 and still be 1, as the door allows. */
export const WEIGHT_TOLERANCE = 0.001;

/**
 * The task the builder edits on this phase, or null where the editor keeps
 * its generic panels.
 *
 * Only Requirements, and only a phase whose written work is one task (a
 * concept quiz beside it keeps its own row). A story task always opens here,
 * editable or not. A task still in the older markdown format opens here only
 * where it can be converted: an editable draft and a task a teacher may
 * write. A version that cannot change keeps its older panels, because the
 * builder's defaults would describe a floor the task does not have.
 */
export function requirementsBuilderTask(phase: DraftPhaseView, editable: boolean): DraftTaskView | null {
  if (phase.key !== 'requirements') return null;
  const work = phase.tasks.filter((one) => one.checkKind !== 'quiz' && !one.quiz);
  if (work.length !== 1) return null;
  const [task] = work;
  if (task.story) return task;
  // Reader for the earlier format: a Requirements task stored before the
  // story kind reaches the editor with its stored `markdown` kind and no
  // `story`, because the API converts an older Requirements draft where it is
  // written and never on read (`legacy-requirements.ts`); only an older Design
  // has a read-time view (`olderDesignView`). So this arm is the builder's one
  // way in, and its first save sends a story body, which converts the row
  // (`updateTask`'s story arm). It goes with `isAuthorableTask`'s two legacy
  // pairs once a read-time story view exists.
  const olderFormat = (task.checkKind as string) === 'markdown';
  return editable && task.authorable && task.taskKey !== '' && olderFormat ? task : null;
}

/** Which of the five steps the server holds as done. */
export function stepsDone(phase: DraftPhaseView, task: DraftTaskView): boolean[] {
  const criteria = task.story ? (task.rubric?.criteria ?? []) : [];
  const sum = criteria.reduce((total, one) => total + one.weight, 0);
  return [
    phase.intro.trim().length > 0,
    Boolean(phase.interview && phase.interview.facts.length > 0),
    (task.story?.providedStories.length ?? 0) > 0,
    Boolean(task.title.trim() && task.brief.trim() && task.story?.floor),
    criteria.length > 0 && Math.abs(sum - 1) <= WEIGHT_TOLERANCE,
  ];
}

/* ------------------------------------------------------- the provided stories */

/** What stops a save when the learner's id is also a provided story's. */
export function learnerIdClash(id: string): string {
  return `${id} is already a provided story. Give the learner's story its own id.`;
}

/**
 * The next free id in the backlog's own style: the prefix the stories already
 * use, and the smallest number no provided story and no learner story holds.
 */
export function nextStoryId(stories: readonly ProvidedStory[], learnerId: string): string {
  const ids = [...stories.map((one) => one.id), learnerId === LEARNER_PICKS ? '' : learnerId].filter(Boolean);
  const prefix = ids.map((id) => /^(.*?)\d+$/.exec(id)?.[1]).find((one) => one !== undefined) ?? 'US-';
  const taken = new Set(ids);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

const nameOf = (story: ProvidedStory, at: number) => story.id.trim() || `Provided story ${at + 1}`;

/**
 * A provided story's acceptance criterion with a blank Given, When or Then,
 * in one sentence, or ''. A learner reads these as worked examples, so a
 * half-written one is never saved.
 */
export function blankCriterionProblem(stories: readonly ProvidedStory[]): string {
  for (const [at, story] of stories.entries()) {
    for (const criterion of story.criteria ?? []) {
      if (![criterion.given, criterion.when, criterion.then].every((one) => one.trim())) {
        return `${nameOf(story, at)} ${criterion.id} needs a Given, a When and a Then. Fill in all three, or remove it.`;
      }
    }
  }
  return '';
}

/** What stops the provided stories saving, in one sentence, or ''. */
export function providedStoriesProblem(stories: readonly ProvidedStory[], learnerId: string): string {
  for (const [at, story] of stories.entries()) {
    if (![story.id, story.title, story.persona, story.capability, story.benefit].every((one) => one.trim())) {
      return `Give ${nameOf(story, at)} an id, a title, and all three parts of its sentence.`;
    }
  }
  const blank = blankCriterionProblem(stories);
  if (blank) return blank;
  const seen = new Set<string>();
  for (const story of stories) {
    if (seen.has(story.id)) return `Two provided stories use the id ${story.id}. Give each its own.`;
    seen.add(story.id);
  }
  if (stories.some((one) => one.id === learnerId)) return learnerIdClash(learnerId);
  return '';
}

/** A provided story as the body sends it: no empty criteria list. */
export function bodyStory(story: ProvidedStory): ProvidedStory {
  const { criteria, ...rest } = story;
  return criteria && criteria.length > 0 ? { ...rest, criteria } : rest;
}

/* ----------------------------------------------------------------- the floor */

/** The learner-facing sentence the floor is summed up in. */
export function floorLine(floor: StoryFloor): string {
  return `Learners must write ${floorSentence(floor)} before the review reads it.`;
}

/* -------------------------------------------------------------- the criteria */

const KEY_MAX = 48;

/** The door's own words. */
export const WEIGHTS_REFUSAL = 'Weights must sum to 1.';
export const NO_CRITERION_REFUSAL = 'A rubric needs at least one criterion.';
export const KEYS_REFUSAL = 'Criterion keys must be unique.';

/**
 * A criterion's key from its title: lower case, words joined by hyphens, at
 * most 48 characters, and unique among `taken` by a numbered suffix.
 */
export function criterionKey(title: string, taken: readonly string[]): string {
  const base =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, KEY_MAX - 3)
      .replace(/-+$/, '') || 'criterion';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** A weight as typed: "0.3", "30%" or "30". NaN when it is not a weight. */
export function parseWeight(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return Number.NaN;
  const percent = trimmed.endsWith('%');
  const value = Number(percent ? trimmed.slice(0, -1).trim() : trimmed);
  if (!Number.isFinite(value) || value < 0) return Number.NaN;
  const decimal = percent || value > 1 ? value / 100 : value;
  return decimal > 1 ? Number.NaN : Math.round(decimal * 1000) / 1000;
}

/** Every row's key: a saved one as it is, a new one from its title. */
export function keysOf(rows: readonly { key: string; title: string }[]): string[] {
  const keys: string[] = [];
  const saved = rows.filter((one) => one.key).map((one) => one.key);
  for (const row of rows) keys.push(row.key || criterionKey(row.title, [...saved, ...keys]));
  return keys;
}

/** A stepped value held between its bounds; whole when the step is whole. */
export function stepValue(value: number, min: number, max: number, step: number): number {
  const rounded = Number.isInteger(step) ? Math.round(value) : Math.round(value * 1000) / 1000;
  return Math.min(max, Math.max(min, rounded));
}
