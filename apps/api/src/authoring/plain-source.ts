import {
  CRITERION_DESCRIPTION_MAX,
  CRITERION_TITLE_MAX,
  DESKTOP_FOLDER,
  PHASE_INTRO_MAX,
  TASK_BRIEF_MAX,
  TASK_OBJECTIVE_MAX,
  TASK_TITLE_MAX,
  PHASE_ORDER,
  PHASE_TITLES,
  holdsHtmlComment,
  htmlCommentWarning,
  isDesktopFile,
  markdownKeptWarning,
  phaseKeyOfFolder,
  plainTextOf,
  type PhaseKey,
  type PlainTextMember,
  isObject as isPlainObject,
} from '@learnsdlc/shared';
import { MemoryPackSource } from '../content/memory-pack-source';
import { emptyRefusal, overCapRefusal } from './draft';
import { plainChecks } from './plain-checks';
import { CONCEPT_BLANK, QUIZ_OPTION_BLANK } from './quiz-rows';

/**
 * Every text a teacher wrote in an uploaded archive, stored plain as the
 * editor's doors store it: each `phases/<folder>/phase.json`'s brief (`taskPanel`),
 * intro, objectives, rubric titles and descriptions, its task block's title
 * and objectives, and the story, Design story and ticket lines in its checks
 * (`story lines`, `ticket lines`); each `quizzes/*.json`'s title, brief, objectives,
 * stems, option texts, explanations and concept labels. Each is stored as
 * `plainTextOf` of it, so a later save, read or export meets the same text.
 *
 * Per phase, in LearnSDLC's order: one `markdownKeptWarning` naming every
 * member the conversion changed, and one `htmlCommentWarning` naming every
 * member whose stored text holds a comment (asked of the plain text it
 * stores, as the draft conversion asks it). A phase is named by its key's
 * title, never by a title the archive chose.
 *
 * Each text is trimmed and held to its editor cap first, as the editor's
 * `requireText` trims and measures it (so `plainTextOf` meets no text past
 * the bound its timing is pinned to), the trimmed text is what is
 * converted and stored, and a text that held words and converts to nothing (only `---` or `#`)
 * is refused; each in its own check's sentence, as the editor's doors refuse
 * it, at the file that holds it: `PlainTextRefusal` (a quiz file's in the
 * quiz door's "is not a quiz" shape). A quiz stem or explanation that
 * converts to nothing is stored as '' and left to the quiz check's own
 * sentence, as the editor leaves it.
 *
 * The source is a pack in the folder layout (an older archive is converted
 * first). A file that does not parse is left as it is, for the loader or the
 * quiz door to refuse in their own words. The new source holds every file
 * of the old one, byte for byte but for the files whose texts moved, and
 * starts with an empty read log and no desktop notes of its own beyond what
 * its construction finds outside `phases/`.
 */

/** A text whose conversion leaves nothing: its file and its check's own sentence. */
export class PlainTextRefusal extends Error {
  /**
   * `shape` says how the door files it: `file` as "<at>: <sentence>", `quiz`
   * in the quiz door's "<at> is not a quiz: " shape, `block` in the task
   * block's own "<folder>'s phase.json task block: " shape (`at` the folder),
   * as `checkedTaskBlock` says it.
   */
  constructor(readonly at: string, readonly sentence: string, readonly shape: 'file' | 'quiz' | 'block') {
    super(`${at}: ${sentence}`);
    this.name = 'PlainTextRefusal';
  }
}

/** A member's editor cap and the sentence for a text past it (the editor's own words). */
interface Cap {
  max: number;
  over: (length: number) => string;
}

/** `requireText`'s cap sentence (`draft.ts`), for `what`. */
const capOf = (what: string, max: number): Cap => ({ max, over: (length) => overCapRefusal(what, max, length) });
const OBJECTIVE_CAP: Cap = capOf('objective', TASK_OBJECTIVE_MAX);

type Json = any;

/** The shared plain-object test, narrowing to this module's JSON record. */
const isObject = isPlainObject as (value: unknown) => value is Record<string, Json>;

/** One phase's or quiz file's conversion: what changed, what holds a comment, and whether the file must be rewritten. */
class Pass {
  readonly changed = new Set<PlainTextMember>();
  readonly comments = new Set<PlainTextMember>();
  moved = false;

  constructor(readonly at: string, readonly shape: 'file' | 'quiz' | 'block' = 'file') {}

  /**
   * `text` trimmed and stored plain, as the editor's `requireText` and
   * `requirePlainText` store it: the trimmed text is held to its cap (a text
   * past it refused by `cap.over`), then converted and trimmed again, and
   * that is what is stored, so no whitespace rides past the cap and none is
   * left at an edge the conversion emptied. One that
   * held words and converts to nothing is refused by `blank()`, the check's
   * own sentence. A `blank` of `null` refuses nothing here: the text is
   * stored as '' (never a lone line break the conversion left), so the check
   * that reads it next refuses an empty text in its own words. Trimming
   * alone rewrites the file but is no markdown note.
   */
  text(value: unknown, member: PlainTextMember, blank: (() => string) | null, cap: Cap): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    // the cap asked of the trimmed text, as `requireText` asks it, before `plainTextOf` runs
    if (trimmed.length > cap.max) throw new PlainTextRefusal(this.at, cap.over(trimmed.length), this.shape);
    // trimmed again after converting: markup can leave a blank edge ("Intro\n\n---" reads "Intro\n\n"),
    // and the door stores what a second upload of the stored text would store
    let plain = plainTextOf(trimmed).trim();
    if (plain !== trimmed) {
      if (trimmed.length > 0 && plain.length === 0) {
        if (blank) throw new PlainTextRefusal(this.at, blank(), this.shape);
        plain = '';
      }
      this.changed.add(member);
    }
    if (plain !== value) this.moved = true;
    if (holdsHtmlComment(plain)) this.comments.add(member);
    return plain;
  }

  list(value: unknown, member: PlainTextMember, blank: (() => string) | null, cap: Cap): unknown {
    return Array.isArray(value) ? value.map((one) => this.text(one, member, blank, cap)) : value;
  }
}

/** `requirePlainText`'s own sentence for an empty `what` (the editor's doors): "An objective cannot be empty.". */
function editorEmpty(what: string): () => string {
  return () => emptyRefusal(what);
}

function parsed(source: MemoryPackSource, at: string): Json | null {
  try {
    const value = JSON.parse(source.read(at));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** The phase folders under `phases/`, by key, in LearnSDLC's order; desktop entries and unknown keys left to the layout's own rules. */
function phaseFolders(source: MemoryPackSource): { key: PhaseKey; folder: string }[] {
  if (!source.entries('').some((one) => one.name === 'phases' && one.isDirectory)) return [];
  return source
    .entries('phases')
    .filter((one) => one.isDirectory && one.name !== DESKTOP_FOLDER)
    .map((one) => ({ key: phaseKeyOfFolder(one.name) as PhaseKey, folder: `phases/${one.name}` }))
    .filter((one) => (PHASE_ORDER as readonly string[]).includes(one.key))
    .sort((a, b) => PHASE_ORDER.indexOf(a.key) - PHASE_ORDER.indexOf(b.key));
}

/**
 * A line in a phase's checks with no editor cap of its own here: one longer
 * than a brief's cap is left as sent, for the loader's check to refuse in its
 * own words (every such check caps far below it), so `plainTextOf` never
 * meets a text past the bound its timing is pinned to.
 */
const CHECKS_LINE: Cap = { max: Number.MAX_SAFE_INTEGER, over: () => '' };

/**
 * A phase.json's texts: the brief, the intro, the objectives, the
 * rubric's sentences, the task block's title and objectives, and the lines in
 * its checks (a story's provided stories and the learner story's hints, a
 * Design's stories, a Maintenance ticket's title, summary and acceptance
 * lines) through the draft conversion's walker (`plainChecks`), as `story
 * lines` and `ticket lines`. A line that converts to nothing is stored as ''
 * and left to the loader's check, which refuses an empty line in its own
 * sentence, as the editor's doors check the converted block again.
 */
function plainPhase(spec: Json, pass: Pass, block: Pass, title: string): void {
  spec.taskPanel = pass.text(spec.taskPanel, 'brief', editorEmpty('brief'), capOf('brief', TASK_BRIEF_MAX));
  // `updatePhase`'s own words (`writtenText`)
  const intro: Cap = { max: PHASE_INTRO_MAX, over: (length) => `The intro of ${title} is at most ${PHASE_INTRO_MAX} characters, and this one is ${length}.` };
  spec.intro = pass.text(spec.intro, 'intro', () => `The intro of ${title} cannot be empty.`, intro);
  spec.objectives = pass.list(spec.objectives, 'objectives', editorEmpty('objective'), OBJECTIVE_CAP);
  if (isObject(spec.rubric) && Array.isArray(spec.rubric.criteria)) {
    for (const criterion of spec.rubric.criteria) {
      if (!isObject(criterion)) continue;
      criterion.title = pass.text(criterion.title, 'rubric sentences', editorEmpty('criterion title'), capOf('criterion title', CRITERION_TITLE_MAX));
      criterion.description = pass.text(criterion.description, 'rubric sentences', editorEmpty('criterion description'), capOf('criterion description', CRITERION_DESCRIPTION_MAX));
    }
  }
  if (isObject(spec.checks) && spec.checks.kind !== 'quiz') {
    spec.checks = plainChecks(spec.checks, (member) => <T,>(text: T): T =>
      (typeof text === 'string' && text.trim().length > TASK_BRIEF_MAX ? text : pass.text(text, member, null, CHECKS_LINE)) as T,
    );
  }
  if (isObject(spec.task)) {
    // the task block's members, refused in its own shape (`checkedTaskBlock`'s words)
    spec.task.title = block.text(spec.task.title, 'task title', editorEmpty('title'), capOf('title', TASK_TITLE_MAX));
    spec.task.objectives = block.list(spec.task.objectives, 'objectives', editorEmpty('objective'), OBJECTIVE_CAP);
  }
}

/** A quiz file's texts: its title, brief and objectives, and each question's stem, option texts, explanation and concept. */
function plainQuiz(quiz: Json, pass: Pass): void {
  quiz.title = pass.text(quiz.title, 'quiz text', editorEmpty('title'), capOf('title', TASK_TITLE_MAX));
  quiz.brief = pass.text(quiz.brief, 'quiz text', editorEmpty('brief'), capOf('brief', TASK_BRIEF_MAX));
  quiz.objectives = pass.list(quiz.objectives, 'quiz text', editorEmpty('objective'), OBJECTIVE_CAP);
  const questions = isObject(quiz.checks) && Array.isArray(quiz.checks.questions) ? quiz.checks.questions : [];
  questions.forEach((question: Json, i: number) => {
    if (!isObject(question)) return;
    // the quiz DTO's caps (`QuizQuestionDto`, `QuizOptionDto`)
    const cap = (what: string, max: number): Cap => ({ max, over: (length) => `Question ${i + 1}'s ${what} is at most ${max} characters, and this one is ${length}.` });
    // A stem or an explanation that converts to nothing is the quiz check's to refuse (`authoredQuizOf`'s
    // "must be text of 1 to 4000 characters"), as the editor leaves those two to its own check; an option
    // text and a concept are refused in the editor's draft doors' sentences (`plainQuestion`).
    question.stem = pass.text(question.stem, 'quiz text', null, cap('stem', 4000));
    if (Array.isArray(question.options)) {
      question.options.forEach((option: Json, n: number) => {
        if (isObject(option)) option.text = pass.text(option.text, 'quiz text', () => QUIZ_OPTION_BLANK, cap(`option ${n + 1}`, 2000));
      });
    }
    question.explanation = pass.text(question.explanation, 'quiz text', null, cap('explanation', 4000));
    question.concept = pass.text(question.concept, 'quiz text', () => CONCEPT_BLANK, cap('concept', 200));
  });
}

/** Whether `name` is left out of a listing as a desktop entry, as the layout walk leaves it out. */
function isDesktopEntry(name: string, isDirectory: boolean): boolean {
  return isDirectory ? name === DESKTOP_FOLDER : isDesktopFile(name);
}

export function plainSource(source: MemoryPackSource): { source: MemoryPackSource; warnings: string[] } {
  const rewritten = new Map<string, string>();
  const warnings: string[] = [];
  for (const { key, folder } of phaseFolders(source)) {
    const title = PHASE_TITLES[key];
    const changed = new Set<PlainTextMember>();
    const comments = new Set<PlainTextMember>();
    const take = (pass: Pass, value: Json): void => {
      for (const one of pass.changed) changed.add(one);
      for (const one of pass.comments) comments.add(one);
      if (pass.moved) rewritten.set(pass.at, `${JSON.stringify(value, null, 2)}\n`);
    };
    const at = `${folder}/phase.json`;
    const spec = source.exists(at) ? parsed(source, at) : null;
    if (spec) {
      const pass = new Pass(at);
      const block = new Pass(folder, 'block');
      plainPhase(spec, pass, block, title);
      take(pass, spec);
      for (const one of block.changed) changed.add(one);
      for (const one of block.comments) comments.add(one);
      if (block.moved) rewritten.set(at, `${JSON.stringify(spec, null, 2)}\n`);
    }
    const quizzes = `${folder}/quizzes`;
    const listed = source.exists(quizzes) ? (() => {
      try {
        return source.entries(quizzes);
      } catch {
        return [];
      }
    })() : [];
    for (const entry of listed) {
      if (entry.isDirectory || isDesktopEntry(entry.name, entry.isDirectory) || !entry.name.endsWith('.json')) continue;
      const file = `${quizzes}/${entry.name}`;
      const quiz = parsed(source, file);
      if (!quiz) continue;
      const pass = new Pass(file, 'quiz');
      plainQuiz(quiz, pass);
      take(pass, quiz);
    }
    if (changed.size) warnings.push(markdownKeptWarning(title, [...changed]));
    if (comments.size) warnings.push(htmlCommentWarning(title, [...comments]));
  }
  const entries = source.walkForDigest('').map((at) => ({
    name: at,
    bytes: rewritten.has(at) ? Buffer.from(rewritten.get(at)!, 'utf-8') : source.bytesOf(at)!,
  }));
  return { source: new MemoryPackSource(entries, source.name, ''), warnings };
}
