import { BadRequestException } from '@nestjs/common';
import {
  ADDABLE_PHASES,
  CRITERION_DESCRIPTION_MAX,
  CRITERION_TITLE_MAX,
  PHASE_ORDER,
  TASK_TITLE_MAX,
  addByUploadRefusal,
  holdsHtmlComment,
  htmlCommentWarning,
  isPlainText,
  markupOnlyWarning,
  plainTextOf,
} from '@learnsdlc/shared';
import type {
  DesignChecksBody,
  DraftPhaseSetView,
  PhaseKey,
  PhaseRubric,
  PlainTextMember,
  RemoveSource,
  RubricBody,
  StoryChecksBody,
  UpdateTaskBody,
} from '@learnsdlc/shared';
import { canonicalJson } from '../content/blob.store';
import { validateDesignChecks, validateInterviewBrief, validateStoryChecks } from '../content/content.service';
import type { DesignChecks, InterviewBrief, PhaseContent, StoryChecks } from '../content/content.types';
import type { CompiledSnapshot } from '../content/pack-compiler';
import { ProjectPhaseEntity, ProjectTaskEntity } from '../content/project.entities';
import { plainChecks } from './plain-checks';
import { emptyRefusal, plainOrRefuse, requirePlainText, taskWordsPatch } from './draft';
import { interviewDoorRefusal } from './interview-caps';

/**
 * The authoring service's pure helpers, beside the service that calls them:
 * how a door reads a teacher's body (a text kept as sent, a story, design or
 * rubric body, an interview, reworded criteria, an added task's words), the
 * draft's plain-text notes and the patches that convert a phase's texts, and
 * the small conversions its views use (a phase set, a base phase, a stamp).
 * Nothing here holds state or touches the database.
 */

/** An added task's objective the conversion turns blank: `taskWordsPatch`'s own empty sentence for an objective. */
export const OBJECTIVE_BLANK = emptyRefusal('objective');

/**
 * A teacher's text stored **as sent**: refused when it is not
 * a string, is blank, or is over the cap, and never trimmed: the loader keeps
 * a pack's strings as they are, and a digest of the reference's own words must
 * match when a teacher writes them back.
 */
export function writtenText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${what} cannot be empty.`);
  }
  if (value.length > max) {
    throw new BadRequestException(`${what} is at most ${max} characters, and this one is ${value.length}.`);
  }
  return value;
}

/**
 * A teacher's story block, held to the pack loader's own rules
 * (`validateStoryChecks`) so the editor and a pack refuse the same checks in
 * the same words. The record path is the task's own, never the body's.
 */
export function storyChecksFromBody(body: StoryChecksBody, record: string, phaseKey: PhaseKey): StoryChecks {
  let checks: StoryChecks;
  try {
    checks = validateStoryChecks({ ...body, record }, phaseKey);
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
  // Stored plain: each provided story's title, its sentence's three
  // parts and its criteria's clauses, and the learner story's hints, after
  // the check, so a refusal names what was sent.
  // The converted block is held to the same check again, so a field or clause only markdown is refused in its sentence.
  const hints = Object.fromEntries(
    Object.entries(checks.learnerStory.hints).map(([key, hint]) => [key, typeof hint === 'string' ? plainTextOf(hint) : hint]),
  );
  const plain: StoryChecks = {
    ...checks,
    learnerStory: { ...checks.learnerStory, hints },
    providedStories: checks.providedStories.map((story) => ({
      ...story,
      title: plainTextOf(story.title),
      persona: plainTextOf(story.persona),
      capability: plainTextOf(story.capability),
      benefit: plainTextOf(story.benefit),
      ...(story.criteria
        ? { criteria: story.criteria.map((one) => ({ ...one, given: plainTextOf(one.given), when: plainTextOf(one.when), then: plainTextOf(one.then) })) }
        : {}),
    })),
  };
  try {
    validateStoryChecks({ ...plain, record }, phaseKey);
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
  return plain;
}

/** The tails of `htmlCommentWarning`'s two sentences, after the phase and its members. */
const HTML_COMMENT_TAILS = (['brief', 'objectives'] as const).map((member) => htmlCommentWarning('', [member]).slice(`'s ${member}`.length));

/** Whether a draft's note is a phase's `htmlCommentWarning` sentence, whichever members it names. */
export function isHtmlCommentNote(note: string): boolean {
  return HTML_COMMENT_TAILS.some((tail) => note.endsWith(tail));
}

/** Every member a draft's plain-text note can name (`PlainTextMember`), in the order the notes list them. */
const NOTE_MEMBERS: readonly PlainTextMember[] = ['brief', 'task title', 'intro', 'objectives', 'rubric sentences', 'quiz text', 'ticket lines', 'story lines'];

/**
 * The members a phase's `markupOnlyWarning` note names, or null when the note
 * is not one: the sentence is matched whole against each set of members, so a
 * note is read by the same function that wrote it, never parsed apart.
 */
export function markupOnlyMembers(note: string, phaseTitle: string): PlainTextMember[] | null {
  for (let mask = 1; mask < 1 << NOTE_MEMBERS.length; mask++) {
    const members = NOTE_MEMBERS.filter((_, at) => mask & (1 << at));
    if (markupOnlyWarning(phaseTitle, members) === note) return members;
  }
  return null;
}

/**
 * What a draft's plain-text conversion writes (`convertDraftTexts`), worked out
 * from its rows and written nowhere here: each phase intro to change by phase
 * id, each task's changed columns by task id, the members that changed, the
 * members that held only markup and are now empty, the members holding an
 * empty text once stored (`dropSpentNotes` reads it), and the members whose
 * stored text holds an HTML comment, all by phase id, and how many texts
 * changed. A text already plain is left, byte for byte; a
 * member that is not a string is left as it is.
 *
 * The members (the upload door's, then a draft's two more): a work task's title, brief
 * and objectives are its `task title`, `brief` and `objectives`; everything a
 * quiz holds (title, brief, objectives, stems, options, explanations, concept
 * labels) is its `quiz text`; every task's rubric criteria are `rubric
 * sentences`; a code task's ticket is `ticket lines`; a story task's provided
 * stories and the learner story's hints, and a Design task's stories, are
 * `story lines`.
 */
export function plainTextPatches(
  phases: readonly ProjectPhaseEntity[],
  tasks: readonly ProjectTaskEntity[],
): {
  intros: Map<string, string>;
  tasks: Map<string, Partial<Pick<ProjectTaskEntity, 'title' | 'brief' | 'objectives' | 'rubric' | 'checks'>>>;
  changed: Map<string, Set<PlainTextMember>>;
  emptied: Map<string, Set<PlainTextMember>>;
  blank: Map<string, Set<PlainTextMember>>;
  commented: Map<string, Set<PlainTextMember>>;
  texts: number;
} {
  const out = {
    intros: new Map<string, string>(),
    tasks: new Map<string, Partial<Pick<ProjectTaskEntity, 'title' | 'brief' | 'objectives' | 'rubric' | 'checks'>>>(),
    changed: new Map<string, Set<PlainTextMember>>(),
    emptied: new Map<string, Set<PlainTextMember>>(),
    blank: new Map<string, Set<PlainTextMember>>(),
    commented: new Map<string, Set<PlainTextMember>>(),
    texts: 0,
  };
  const mark = (map: Map<string, Set<PlainTextMember>>, phaseId: string, member: PlainTextMember) => {
    const held = map.get(phaseId) ?? new Set<PlainTextMember>();
    held.add(member);
    map.set(phaseId, held);
  };
  /**
   * One text, stored plain: counted and named when it changes, named again
   * when it held only markup and is now empty, named when the stored text is
   * empty at all (whatever emptied it), and named when the stored text holds
   * a comment.
   */
  const plainIn = (phaseId: string, member: PlainTextMember) => <T,>(text: T): T => {
    if (typeof text !== 'string') return text;
    const stored = isPlainText(text) ? text : plainTextOf(text);
    if (stored !== text) {
      out.texts += 1;
      mark(out.changed, phaseId, member);
    }
    if (text.trim() !== '' && stored.trim() === '') mark(out.emptied, phaseId, member);
    if (stored.trim() === '') mark(out.blank, phaseId, member);
    if (holdsHtmlComment(stored)) mark(out.commented, phaseId, member);
    return stored as T;
  };
  const moved = (was: unknown, now: unknown) => JSON.stringify(was) !== JSON.stringify(now);

  for (const phase of phases) {
    const intro = plainIn(phase.id, 'intro')(phase.intro);
    if (intro !== phase.intro) out.intros.set(phase.id, intro);
  }
  const phaseIds = new Set(phases.map((one) => one.id));
  for (const task of tasks) {
    if (!phaseIds.has(task.projectPhaseId)) continue;
    const quiz = task.checks?.kind === 'quiz';
    const words = (member: PlainTextMember) => plainIn(task.projectPhaseId, quiz ? 'quiz text' : member);
    const patch: Partial<Pick<ProjectTaskEntity, 'title' | 'brief' | 'objectives' | 'rubric' | 'checks'>> = {};
    const title = words('task title')(task.title);
    if (title !== task.title) patch.title = title;
    const brief = words('brief')(task.brief);
    if (brief !== task.brief) patch.brief = brief;
    const objectives = Array.isArray(task.objectives) ? task.objectives.map(words('objectives')) : task.objectives;
    if (moved(objectives, task.objectives)) patch.objectives = objectives;

    const sentence = plainIn(task.projectPhaseId, 'rubric sentences');
    const rubric = task.rubric && Array.isArray(task.rubric.criteria)
      ? { ...task.rubric, criteria: task.rubric.criteria.map((one) => ({ ...one, title: sentence(one.title), description: sentence(one.description) })) }
      : task.rubric;
    if (moved(rubric, task.rubric)) patch.rubric = rubric;

    const checks = plainChecks(task.checks, (member) => plainIn(task.projectPhaseId, member));
    if (moved(checks, task.checks)) patch.checks = checks;
    if (Object.keys(patch).length) out.tasks.set(task.id, patch);
  }
  return out;
}


/**
 * A teacher's design block, held to the pack loader's own rules
 * (`validateDesignChecks`) so the builder and a pack refuse the same checks in
 * the same words. The loader defaults a missing sequence switch; a builder save
 * must say it, as the DTO requires, so a body without one is refused here too.
 */
export function designChecksFromBody(body: DesignChecksBody): DesignChecks {
  if (typeof body?.sequence !== 'boolean') throw new BadRequestException('sequence must be true or false.');
  let checks: DesignChecks;
  try {
    checks = validateDesignChecks({ ...body, kind: 'design' }, 'design');
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
  // Stored plain: each story's title and line, after the check, so a refusal names what was sent;
  // the converted block is held to the same check again, so a title or line only markdown is refused in its sentence.
  const plain: DesignChecks = { ...checks, stories: checks.stories.map((story) => ({ ...story, title: plainTextOf(story.title), line: plainTextOf(story.line) })) };
  try {
    validateDesignChecks(plain, 'design');
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
  return plain;
}

/**
 * A task's rubric, replaced whole: one criterion at least, unique keys,
 * weights summing to 1. Each criterion's title and description are stored
 * plain, and one the conversion turns blank is refused in the
 * criterion arm's own empty sentence (`plainOrRefuse`).
 */
export function rubricFromBody(b: RubricBody): PhaseRubric {
  if (!b.criteria.length) throw new BadRequestException('A rubric needs at least one criterion.');
  const sum = b.criteria.reduce((n, c) => n + c.weight, 0);
  if (Math.abs(sum - 1) > 0.001) throw new BadRequestException('Weights must sum to 1.');
  if (new Set(b.criteria.map((c) => c.key)).size !== b.criteria.length) {
    throw new BadRequestException('Criterion keys must be unique.');
  }
  return {
    passThreshold: b.passThreshold,
    criteria: b.criteria.map((c) => ({
      key: c.key,
      title: plainOrRefuse(c.title, 'A criterion title cannot be empty.'),
      description: plainOrRefuse(c.description, 'A criterion description cannot be empty.'),
      weight: c.weight,
    })),
  };
}

/**
 * The tail of a story or design task's edit, the same for both and in this
 * order: the rubric replaced whole (`rubric`, already held to
 * `rubricFromBody`), the task's words, `afterWords` in the audit detail (the
 * story's type), a criterion's wording over the rubric just replaced or else
 * the row's (`reworded`), and the sign-off mark. Writes into `patch` and
 * `moved`.
 */
export function structuredTaskTail(
  body: UpdateTaskBody,
  row: Pick<ProjectTaskEntity, 'rubric' | 'title'>,
  rubric: PhaseRubric | null,
  patch: Partial<ProjectTaskEntity>,
  moved: Record<string, unknown>,
  afterWords?: Record<string, unknown>,
): void {
  if (rubric) {
    patch.rubric = rubric;
    moved.rubric = rubric.criteria.length;
  }
  const words = taskWordsPatch(body);
  Object.assign(patch, words.patch);
  Object.assign(moved, words.moved);
  if (afterWords) Object.assign(moved, afterWords);
  if (body.criteria !== undefined) {
    patch.rubric = reworded(patch.rubric ?? row.rubric, body.criteria, row.title);
    moved.criteria = body.criteria.length;
  }
  if (body.signOff !== undefined) {
    patch.signOff = body.signOff;
    moved.signOff = body.signOff;
  }
}

/**
 * A teacher's interview, checked by the content loader's own rules and then by
 * the door's caps (`interviewDoorRefusal`), which are the ones the loader has
 * none of. The loader's refusal is carried in the loader's words, and the
 * first cap the brief is over in the caps' own sentence.
 */
export function checkedInterview(body: unknown): InterviewBrief {
  let brief: InterviewBrief;
  try {
    brief = validateInterviewBrief(body);
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
  const said = interviewDoorRefusal(brief);
  if (said) throw new BadRequestException(said);
  return brief;
}

/**
 * A rubric with some of its criteria reworded: by existing key only,
 * each key once, title and description through `requireText` at their caps.
 * Weights, order and the pass threshold are the rubric's own.
 */
export function reworded(
  rubric: PhaseRubric,
  wording: NonNullable<UpdateTaskBody['criteria']>,
  taskTitle: string,
): PhaseRubric {
  const criteria = rubric.criteria.map((one) => ({ ...one }));
  const seen = new Set<string>();
  for (const one of wording) {
    const key = String(one?.key ?? '').trim();
    const at = criteria.find((criterion) => criterion.key === key);
    if (!at) {
      throw new BadRequestException(
        `"${key}" is not a criterion of "${taskTitle}". A criterion's wording can change, and its key cannot: ` +
          `name one of ${criteria.map((criterion) => `"${criterion.key}"`).join(', ')}.`,
      );
    }
    if (seen.has(key)) {
      throw new BadRequestException(`"${key}" is reworded twice in one save. Send each criterion once.`);
    }
    seen.add(key);
    // stored plain, the caps asked of what was sent
    at.title = requirePlainText(one.title, 'criterion title', CRITERION_TITLE_MAX);
    at.description = requirePlainText(one.description, 'criterion description', CRITERION_DESCRIPTION_MAX);
  }
  return { ...rubric, criteria };
}

/**
 * A quiz's title as a refusal names it, asked before
 * `requireText` runs so no refusal moves ahead of the ones it followed.
 */
export function quizTitleOf(value: unknown): string {
  const title = typeof value === 'string' ? value.trim().slice(0, TASK_TITLE_MAX) : '';
  return title || 'This quiz';
}

/**
 * Whether the `compiled` column's stored text is the snapshot
 * a context loaded (the same text, or the same canonical JSON).
 */
export function sameStoredCompiled(stored: unknown, loaded: unknown): boolean {
  if (stored === null || stored === undefined) return loaded === null || loaded === undefined;
  if (loaded === null || loaded === undefined) return false;
  if (typeof stored !== 'string') return canonicalJson(stored) === canonicalJson(loaded);
  if (stored === JSON.stringify(loaded)) return true;
  try {
    return canonicalJson(JSON.parse(stored)) === canonicalJson(loaded);
  } catch {
    return false;
  }
}

/** How much of a raw `:phaseKey` route parameter an unknown-phase refusal echoes, in code units. */
export const ROUTE_KEY_ECHO_MAX = 64;

/** Where a put-back or added phase row sits until the renumbering, clear of every order the renumbering writes. */
export const PLACED_ORDER_BASE = 2000;

/** The words of the one task `writeStoryTask` and `writeDesignTask` write. */
export interface AddedTaskWords {
  taskKey: string;
  order: number;
  required: boolean;
  title: string;
  brief: string;
  objectives: string[];
}

/**
 * The draft's base snapshot with one phase taken out (`put` null) or put in
 * (its compiled `PhaseContent` and its compiled tasks), in LearnSDLC's order
 * and numbered 1 to n. A copy: the snapshot handed in is not changed.
 */
export function withBasePhase(
  snapshot: CompiledSnapshot,
  key: PhaseKey,
  put: { phase: PhaseContent; tasks: CompiledSnapshot['phases'][number]['tasks'] } | null,
): CompiledSnapshot {
  const next = clone(snapshot);
  const rank = (one: { key: PhaseKey }) => PHASE_ORDER.indexOf(one.key);
  next.content.phases = next.content.phases.filter((one) => one.key !== key);
  next.phases = next.phases.filter((one) => one.key !== key);
  if (put) {
    next.content.phases.push(put.phase);
    next.phases.push({ key, tasks: put.tasks });
  }
  next.content.phases.sort((a, b) => rank(a) - rank(b));
  next.content.phases.forEach((one, at) => {
    one.order = at + 1;
  });
  next.phases.sort((a, b) => rank(a) - rank(b));
  return next;
}

/**
 * The Phases card's rows: the six phases in LearnSDLC's order, each
 * held by the draft, removed (held by its source and not by it) or absent
 * (held by neither), with the doors it offers. `source` is the source
 * version's phase keys, or null for a draft opened from no version.
 * `editable` is the view's own flag (the owner, on a draft): a published
 * version, or an admin reading another teacher's draft, is offered no door,
 * since every door would refuse them.
 */
export function phaseSetOf(held: readonly PhaseKey[], source: readonly PhaseKey[] | null, editable: boolean): DraftPhaseSetView[] {
  return PHASE_ORDER.map((key): DraftPhaseSetView => {
    if (held.includes(key)) {
      const removeSource: RemoveSource = source === null ? 'no-source' : source.includes(key) ? 'held' : 'not-held';
      return { key, state: 'held', removeSource, canRemove: editable && held.length > 1, canPutBack: false, canAdd: false, why: null };
    }
    if (source?.includes(key)) return { key, state: 'removed', canRemove: false, canPutBack: editable, canAdd: false, why: null };
    const addable = ADDABLE_PHASES.includes(key);
    return { key, state: 'absent', canRemove: false, canPutBack: false, canAdd: editable && addable, why: addable ? null : addByUploadRefusal(key) };
  });
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isoOf(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return new Date(value).toISOString();
  return new Date(0).toISOString();
}
