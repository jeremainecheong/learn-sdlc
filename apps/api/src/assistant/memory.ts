import { DESIGN_JSON, STORY_JSON } from '@learnsdlc/shared';
import type {
  FeedbackReport,
  MentorMemoryItem,
  MentorMemoryView,
  PhaseKey,
} from '@learnsdlc/shared';
import { CONTROL_CHARS } from './fence-markers';
import { DELIMITER_PATTERN } from './learner-scrub';

/**
 * What the mentor carries out of the phases a learner has already finished.
 *
 * Without it the mentor would start every phase with no idea who it was
 * talking to: a learner who spent Requirements deciding that a task due today
 * is not overdue would be asked the same question again in Testing, by the
 * same mentor, as if the decision had never been made. Memory is what makes the six phases one
 * project rather than six unrelated rooms.
 *
 * Three rules hold the shape:
 *
 * 1. **It is derived, never authored.** Every item is read out of the learner's
 *    own artefacts and reports, so there is nothing to correct that correcting
 *    the artefact would not fix, and no editor to build. That is also why it is
 *    rebuilt rather than appended to, a memory that only ever grows drifts,
 *    and drift in a prompt is a mentor confidently remembering something the
 *    learner changed two phases ago.
 * 2. **It is capped, hard.** Eight items, 120 characters each, 1600 characters
 *    serialised, and 600 characters of that reaches a prompt. The cost of the
 *    feature is therefore a constant, not a function of how far the learner
 *    has come.
 * 3. **It is learner-derived text**, so it goes inside the `LEARNER_DATA`
 *    fence in the user turn and never in a system message, and every
 *    string is scrubbed of control characters and of the fence markers before
 *    it is stored.
 */

/** The most items any memory carries, newest phase first. */
export const MEMORY_MAX_ITEMS = 8;
/** The most one item may say. Longer than a sentence is a document, not a memory. */
const MEMORY_MAX_ITEM_CHARS = 120;
/** The most the whole memory may occupy when serialised onto the enrolment row. */
export const MEMORY_MAX_CHARS = 1600;
/** The most that reaches a prompt, about 150 tokens on the shared estimate. */
export const MEMORY_BLOCK_CHARS = 600;
/** The most declined questions kept, newest first. */
const MEMORY_MAX_OPEN_QUESTIONS = 3;
/** The most one declined question may say. */
const MEMORY_QUESTION_CHARS = 160;

/**
 * One line of memory: no control characters, no fence markers, no line breaks,
 * capped. The same cleaner `openai.provider.ts` applies to every other piece of
 * learner-derived text that reaches a prompt, kept here rather than imported so
 * that memory.ts stays a pure module a spec can drive without a provider.
 */
export function scrubMemoryLine(value: string, maxChars: number): string {
  const clean = String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(DELIMITER_PATTERN, '[marker]')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxChars) return clean;
  // A cut mid-word with nothing to mark it reads as the product losing the
  // rest of the sentence ("…so that I can see what I have mis"). Break at the
  // last whole word and say
  // that there was more. The ellipsis is inside the cap, so the line is never
  // longer than the caller asked for.
  const room = clean.slice(0, maxChars - 1);
  const space = room.lastIndexOf(' ');
  // A single word longer than the cap has no boundary to break at, and half of
  // it is still better than none.
  return `${(space > maxChars * 0.6 ? room.slice(0, space) : room).trimEnd()}…`;
}

/** What `buildMemory` reads: one finished phase, its files and its last report. */
export interface PassedPhaseInput {
  phaseKey: PhaseKey;
  phaseOrder: number;
  workspace: Record<string, string> | null;
  report: FeedbackReport | null;
  /** Maintenance with a change request: its ticket's id, from the learner's pinned phase. */
  ticketId?: string | null;
}

/** One line of Requirements memory and the file it was read from. */
interface SourcedLine {
  text: string;
  source: string;
}

/**
 * The story's own first sentence, `As a … I want …`, else its title, read from
 * the record. The record is the only Requirements file memory reads. The
 * workspace migration (`1790100000000-S1-StoryRecordsFromMarkdown.ts`) and the
 * boot's re-pin converted the 2.x markdown stories of learners on a story
 * version, but not every one: a learner pinned to a teacher's version or an
 * archived version that still grades markdown keeps the 2.x markdown story
 * file, and a workspace without a record has no story to remember here.
 */
function storyTitle(workspace: Record<string, string> | null): SourcedLine {
  const record = storyRecordOf(workspace);
  if (record) {
    const persona = typeof record.persona === 'string' ? record.persona.trim() : '';
    const capability = typeof record.capability === 'string' ? record.capability.trim() : '';
    if (persona && capability) return { text: `As a ${persona}, I want ${capability}`, source: STORY_JSON };
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (title) return { text: title, source: STORY_JSON };
  }
  return { text: '', source: STORY_JSON };
}

/**
 * The story record a passed Requirements phase left, or null when it left none
 * or left it mid-edit: a learner leaves invalid JSON behind constantly, and a
 * broken record is not worth an exception when memory can simply say less.
 */
function storyRecordOf(workspace: Record<string, string> | null): Record<string, unknown> | null {
  const json = (workspace ?? {})[STORY_JSON];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The boundary the learner settled: the record's first complete
 * `boundary`-tagged criterion, or nothing when they tagged none.
 */
function boundarySentence(workspace: Record<string, string> | null): SourcedLine {
  const record = storyRecordOf(workspace);
  if (record) {
    const criteria = Array.isArray(record.criteria) ? (record.criteria as Record<string, unknown>[]) : [];
    const clause = (c: Record<string, unknown>, key: string) => (typeof c[key] === 'string' ? (c[key] as string).trim() : '');
    const boundary = criteria.find((c) => c?.tag === 'boundary' && clause(c, 'given') && clause(c, 'when') && clause(c, 'then'));
    if (boundary) {
      return {
        text: `Given ${clause(boundary, 'given')}, when ${clause(boundary, 'when')}, then ${clause(boundary, 'then')}`,
        source: STORY_JSON,
      };
    }
  }
  return { text: '', source: STORY_JSON };
}

/** The operations the design record names, bare, in the order it declares them. */
function contractNames(workspace: Record<string, string> | null): string[] {
  const json = (workspace ?? {})[DESIGN_JSON];
  const names: string[] = [];
  if (!json) return names;
  try {
    const parsed = JSON.parse(json) as { operations?: { name?: unknown }[] };
    for (const op of parsed.operations ?? []) {
      const name = typeof op?.name === 'string' ? op.name.split('(')[0].trim() : '';
      if (name && !names.includes(name)) names.push(name);
    }
  } catch {
    // an unreadable record names nothing
  }
  return names;
}

/** One or two items per finished phase, in the words of the artefact that produced them. */
function itemsFor(passed: PassedPhaseInput): MentorMemoryItem[] {
  const out: MentorMemoryItem[] = [];
  const push = (text: string, source: string): void => {
    const cleaned = scrubMemoryLine(text, MEMORY_MAX_ITEM_CHARS);
    if (cleaned) out.push({ phaseKey: passed.phaseKey, text: cleaned, source });
  };

  switch (passed.phaseKey) {
    case 'requirements': {
      for (const line of [storyTitle(passed.workspace), boundarySentence(passed.workspace)]) push(line.text, line.source);
      break;
    }
    case 'design': {
      const names = contractNames(passed.workspace);
      if (names.length) push(names.join(', '), DESIGN_JSON);
      break;
    }
    case 'implementation': {
      const green = (passed.report?.tests?.cases ?? [])
        .filter((c) => c.status === 'passed')
        .map((c) => c.name);
      if (green.length) push(green.slice(0, 6).join(', '), 'hidden tests');
      break;
    }
    case 'testing': {
      const survivors = (passed.report?.mutation?.survivors ?? []).map((s) => s.name);
      push(survivors.length ? survivors.join(', ') : 'every mutant died', 'kill matrix');
      break;
    }
    case 'deployment': {
      const drill = passed.report?.drill;
      if (drill) push(`${drill.fault}, ${drill.passedAfterFix ? 'resolved' : 'still open'}`, 'incident drill');
      break;
    }
    case 'maintenance': {
      const changed = passed.report?.impact?.functions?.length ?? 0;
      if (changed) push(`${changed} function(s) changed under the contract`, `change request ${passed.ticketId ?? 'record'}`);
      break;
    }
  }
  return out;
}

/**
 * What the mentor should carry out of the phases this learner has finished.
 *
 * `passed` is every phase state with `status: 'passed'` and its newest completed
 * report; `declined` is the questions the mentor withheld an answer to, newest
 * first. Both are read at chat time, and the result replaces whatever the
 * enrolment held before.
 */
export function buildMemory(passed: PassedPhaseInput[], declined: string[]): MentorMemoryView {
  const ordered = [...passed].sort((a, b) => b.phaseOrder - a.phaseOrder);
  const items: MentorMemoryItem[] = [];
  for (const phase of ordered) {
    for (const item of itemsFor(phase)) {
      if (items.length >= MEMORY_MAX_ITEMS) break;
      items.push(item);
    }
    if (items.length >= MEMORY_MAX_ITEMS) break;
  }

  const openQuestions = declined
    .map((question) => scrubMemoryLine(question, MEMORY_QUESTION_CHARS))
    .filter(Boolean)
    .slice(0, MEMORY_MAX_OPEN_QUESTIONS);

  const memory: MentorMemoryView = { items, openQuestions, builtThrough: passed.length };
  // The serialised cap is the last word: it is what the column stores, and it
  // is what stops a pathological pack from writing a novel onto the enrolment.
  while (memory.items.length > 1 && JSON.stringify(memory).length > MEMORY_MAX_CHARS) {
    memory.items.pop();
  }
  return memory;
}

/**
 * The block that goes in the prompt, or '' when there is nothing worth sending.
 * Newest phase first, so the truncation at `MEMORY_BLOCK_CHARS` drops the
 * oldest decisions rather than the ones the learner just made.
 */
export function memoryBlock(memory: MentorMemoryView | null): string {
  if (!memory || (memory.items.length === 0 && memory.openQuestions.length === 0)) return '';
  const lines: string[] = [];
  for (const item of memory.items) lines.push(`${item.phaseKey}: ${item.text} (${item.source})`);
  for (const question of memory.openQuestions) lines.push(`still unanswered: ${question}`);

  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    // +1 for the newline that joins it to the one before.
    if (used + line.length + 1 > MEMORY_BLOCK_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join('\n');
}

/** The one sentence `LocalMentorProvider.chat` (the deterministic stand-in the specs use) adds about memory. */
export function memorySentence(memory: MentorMemoryView | null): string {
  const first = memory?.items?.[0];
  return first ? `Earlier you decided: ${first.text}` : '';
}
