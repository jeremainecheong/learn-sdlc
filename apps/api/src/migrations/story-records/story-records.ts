import {
  EMPTY_STORY,
  LEARNER_PICKS,
  STORY_CAPS,
  STORY_JSON,
  parseStoryJson,
  renumber,
  serialiseStory,
  validateStoryRecord,
  type AcceptanceCriterion,
  type Story,
} from '@learnsdlc/shared';

/**
 * The one-time conversion of a learner's Requirements workspace from the 2.x
 * markdown story to the story record, `requirements/story.json`.
 *
 * It is the migration's own helper (`1790100000000-S1-StoryRecordsFromMarkdown.ts`)
 * and lives in a folder of its own on purpose: TypeORM loads every file
 * directly inside `src/migrations` as a migration and takes every exported
 * value of it as a migration class, so a helper beside the migrations would be
 * loaded as one. Everything here is pure, so the spec drives it without a
 * database.
 *
 * Nothing is dropped in silence. A story that converts keeps its prose: what
 * the parser cannot place goes to `notes`. A workspace it cannot convert is
 * returned exactly as it came, with the reason, and the migration lists it.
 *
 * Applied migrations import this module, and so do runtime services (the
 * boot's re-pin and the draft conversion). A change made here for the runtime
 * would also change what an applied migration does on a fresh database, so a
 * conversion that must behave differently belongs in a new migration and a
 * new helper, never in an edit to this one.
 */

/** Where the migration writes what it did: `settings.key`, the value a JSON receipt. */
export const STORY_MIGRATION_RECEIPT_KEY = 'story-migration.receipt';

/**
 * The 2.x learner story file. This module and the legacy adapter are the only readers left.
 *
 * Frozen on purpose: this constant and `CRITERION_LABEL` below near-duplicate
 * `LEGACY_OWN_STORY` and `AC_LABEL` in `content/story-legacy.ts`, but a
 * migration must keep converting exactly as it did when it ran, so it does
 * not follow later edits to the adapter.
 */
export const LEGACY_STORY_MARKDOWN = 'requirements/my-story.md';

/** The line that opens edited markdown kept in a record's notes, saying where the text came from. */
export const EDITED_MARKDOWN_HEADER = 'Kept from requirements/my-story.md, which was edited beside this record:';

export type StoryConversionOutcome =
  | 'kept-record'
  | 'parsed-markdown'
  | 'empty-template'
  | 'fallback'
  | 'untouched'
  | 'refused';

/** What the caller knows about the phase the record is for. */
export interface ConvertOptions {
  /**
   * The phase's learner story id (`checks.learnerStory.id`): a fixed id such
   * as `US-4`, or `LEARNER_PICKS`. A fixed-id phase refuses a record carrying
   * any other id, so a markdown heading's id (`# US-5 ...`) is read only under
   * learner-picks. Absent, the seed record's id is kept (else `US-4`).
   */
  storyId?: string;
}

export interface StoryConversion {
  workspace: Record<string, string>;
  outcome: StoryConversionOutcome;
  /** Why a workspace was refused, in a sentence; set only on `refused`. */
  reason?: string;
  /**
   * A kept record whose markdown beside it was edited after the 2.x room last
   * rendered it (its `renderHash` no longer matches, or with no `renderHash`
   * the markdown is neither the pack's seed nor the room's render of the
   * record). The record wins, as the room's own
   * copy, and the edited text is kept in its notes; the migration counts
   * these so the receipt says how many.
   */
  editedMarkdown?: boolean;
}

/**
 * FNV-1a over a text, the hash the 2.x room stored as `renderHash` over the
 * markdown it rendered from the record. It answers only "is the file still
 * exactly what the room wrote".
 */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Why a kept record's edited markdown was not moved into its notes. */
export const EDITED_MARKDOWN_REFUSAL = 'Edited markdown beside the record would not fit in notes';

const flatten = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Trim trailing full stops and semicolons, so joined fragments do not read ".;". */
const unpunctuated = (s: string): string => flatten(s).replace(/[.;]+$/, '').trim();
const stripComments = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
/** A title without the italic status note the backlog hangs off it, e.g. `*(draft, complete this)*`. */
const cleanTitle = (s: string): string =>
  flatten(s.replace(/\*\([^)]*\)\*/g, '').replace(/\*\*/g, '').replace(/^\*|\*$/g, ''));

type Section = 'body' | 'criteria' | 'scope' | 'notes';

/** The section a heading or a bold marker line opens, or null when it opens none. */
function sectionOf(label: string): Section | null {
  const word = flatten(label.replace(/\*/g, '')).replace(/:$/, '').toLowerCase();
  if (/^(acceptance criteria|criteria)$/.test(word)) return 'criteria';
  if (/^(out of scope|scope|scope note|scope notes|scope and exclusions|not in scope)$/.test(word)) return 'scope';
  if (/^(open questions|questions|notes)$/.test(word)) return 'notes';
  return null;
}

const HEADING = /^#{1,6}\s+(.*)$/;
const BOLD_LINE = /^\*\*([^*]+?)\*\*\s*:?\s*$/;
const LABEL = /^\*\*(As an?|I want|So that)\*\*\s*:?\s*(.*)$/i;
const SCOPE_PROSE = /^out of scope(?: for this release)?\s*:\s*(.+)$/i;
const SENTENCE = /\bAs an? (.+?),? I want (.+?),?\s+so that (.+?)\.?\s*$/i;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
/** `**US-4/AC-1** —`, `AC-1:`, `**AC-2:**`, `AC-3` before a criterion. */
const CRITERION_LABEL = /^(?:\*\*)?(?:[A-Z][A-Z0-9]*-\d+\/)?AC-\d+\s*[:.)]?\s*(?:\*\*)?\s*[:.)—–-]?\s*/i;
const GWT = /^(?:\*\*)?given(?:\*\*)?\s+(.+?),?\s+when\s+(.+?),?\s+then\s+(.+?)\.?\s*$/i;
const TABLE_SEPARATOR = /^\|?[\s:|-]+\|?$/;

/**
 * Best-effort read of a 2.x markdown story into the record. It reads the shape
 * the 2.x room rendered (`# US-4`, its separator and the title, the sentence, `- **US-4/AC-1** —
 * Given …`, `Out of scope for this release: …`, `**Open questions**`), the
 * scaffold's bold labels, list and table criteria, and section lists. It never
 * invents: a criterion gets the fallback's tag at its position, else `happy`.
 *
 * `recovered` says whether anything at all was read into a field; `leftover`
 * is every line of prose it could not place, so the caller can keep it.
 */
export function parseStoryMarkdown(
  markdown: string,
  fallback: Story = EMPTY_STORY,
): { story: Story; recovered: boolean; leftover: string[] } {
  const lines = stripComments(markdown).split('\n');
  const story: Story = { ...fallback, criteria: [], scopeExclusions: [], notes: '' };
  const criteria: AcceptanceCriterion[] = [];
  const exclusions: string[] = [];
  const notes: string[] = [];
  const leftover: string[] = [];
  let section: Section = 'body';
  let titled = false;
  let recovered = false;

  for (let at = 0; at < lines.length; at += 1) {
    let line = lines[at].trim();
    if (!line) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      const opens = sectionOf(heading[1]);
      if (opens) {
        section = opens;
        continue;
      }
      if (!titled) {
        titled = true;
        section = 'body';
        const named = /^(?:([A-Z][A-Z0-9]*-\d+)\b\s*[\u00b7:—–-]?\s*)?(.*)$/.exec(cleanTitle(heading[1]));
        if (named?.[1]) story.id = named[1];
        const title = cleanTitle(named?.[2] ?? '');
        if (title) {
          story.title = title;
          recovered = true;
        }
        continue;
      }
      leftover.push(flatten(heading[1]));
      continue;
    }

    const marker = BOLD_LINE.exec(line);
    if (marker && sectionOf(marker[1])) {
      section = sectionOf(marker[1]) as Section;
      continue;
    }

    const label = LABEL.exec(line);
    if (label) {
      const value = unpunctuated(label[2]);
      if (value) {
        const which = label[1].toLowerCase();
        if (which.startsWith('as a')) story.persona = value;
        else if (which === 'i want') story.capability = value;
        else story.benefit = value;
        recovered = true;
      }
      continue;
    }

    const scope = SCOPE_PROSE.exec(line);
    if (scope) {
      exclusions.push(...scope[1].split(';').map(unpunctuated).filter(Boolean));
      section = 'scope';
      continue;
    }

    // A table row: its cells read as one line; a separator, and the header a separator follows, are scaffolding.
    if (line.startsWith('|')) {
      if (TABLE_SEPARATOR.test(line)) continue;
      if (TABLE_SEPARATOR.test((lines[at + 1] ?? '').trim()) && (lines[at + 1] ?? '').includes('-')) continue;
      line = line.split('|').map((cell) => cell.trim()).filter(Boolean).join(' ');
    }

    const bare = line.replace(LIST_MARKER, '');
    const gwt = GWT.exec(bare.replace(CRITERION_LABEL, ''));
    if (gwt) {
      const given = flatten(gwt[1]);
      // the scaffold's placeholder row, `- Given ..., when ..., then ...`
      if (/^(\.\.\.|…)/.test(given)) continue;
      criteria.push({
        id: `AC-${criteria.length + 1}`,
        given: unpunctuated(given),
        when: unpunctuated(gwt[2]),
        then: unpunctuated(gwt[3]),
        tag: fallback.criteria[criteria.length]?.tag ?? 'happy',
      });
      recovered = true;
      continue;
    }

    if (!story.persona && /\bas an?\b/i.test(line)) {
      // the sentence may wrap: read the paragraph it opens
      let end = at;
      while (end + 1 < lines.length && lines[end + 1].trim() && !HEADING.test(lines[end + 1].trim())) end += 1;
      const paragraph = flatten(lines.slice(at, end + 1).join(' ').replace(LIST_MARKER, ''));
      const sentence = SENTENCE.exec(paragraph);
      if (sentence) {
        story.persona = unpunctuated(sentence[1]);
        story.capability = unpunctuated(sentence[2]);
        story.benefit = unpunctuated(sentence[3]);
        recovered = true;
        at = end;
        continue;
      }
    }

    if (section === 'scope') {
      const item = unpunctuated(bare);
      if (item) exclusions.push(item);
      continue;
    }
    if (section === 'notes') {
      notes.push(flatten(bare));
      continue;
    }
    leftover.push(flatten(line));
  }

  // Past the record's caps, a line is kept as prose rather than cut.
  const cap = STORY_CAPS.listItems;
  for (const extra of criteria.slice(cap)) leftover.push(`Given ${extra.given}, when ${extra.when}, then ${extra.then}`);
  leftover.push(...exclusions.slice(cap));
  story.criteria = renumber(criteria.slice(0, cap));
  story.scopeExclusions = exclusions.slice(0, cap);
  story.notes = notes.join(' ');
  if (story.criteria.length || story.scopeExclusions.length || story.notes) recovered = true;
  return { story, recovered, leftover };
}

/**
 * The markdown the 2.x room wrote from a record (`renderStory` in
 * `packages/shared/src/requirements-story.ts` before fea08601), frozen here so
 * the migration can tell a file that is still exactly the room's render from
 * one a learner edited, when the record carries no `renderHash` to compare.
 */
export function render2x(story: Story): string {
  const article = (persona: string) => (/^[aeiou]/i.test(persona.trim()) ? 'an' : 'a');
  const bare = (text: string) => text.trim().replace(/[.;]+$/, '').trim();
  const sentence = (text: string) => {
    const t = text.trim();
    return t.endsWith('.') || t.endsWith('?') || t.endsWith('!') ? t : `${t}.`;
  };
  const lines: string[] = [];
  const title = story.title.trim();
  lines.push(title ? `# ${story.id} \u00b7 ${title}` : `# ${story.id}`, '');
  const epic = story.epics?.find((item) => item.id === story.parentEpicId);
  if (epic) lines.push(`**Parent epic:** ${epic.id} \u00b7 ${epic.title}`, '', `**Epic outcome:** ${epic.outcome}`, '');
  const persona = story.persona.trim();
  const capability = story.capability.trim();
  const benefit = story.benefit.trim();
  if (persona && capability && benefit) {
    lines.push(`As ${article(persona)} ${bare(persona)}, I want ${bare(capability)}, so that ${bare(benefit)}.`, '');
  }
  const criteria = story.criteria.filter((c) => c.given.trim() && c.when.trim() && c.then.trim());
  if (criteria.length) {
    lines.push('**Acceptance criteria**', '');
    for (const c of criteria) {
      lines.push(`- **${story.id}/${c.id.replace(/^US-\d+\//, '')}** \u2014 Given ${bare(c.given)}, when ${bare(c.when)}, then ${bare(c.then)}.`);
    }
    lines.push('');
  }
  const exclusions = story.scopeExclusions.map(bare).filter(Boolean);
  if (exclusions.length) lines.push('**Scope note**', '', `Out of scope for this release: ${exclusions.join('; ')}.`, '');
  const notes = story.notes.trim();
  if (notes) lines.push('**Open questions**', '', sentence(notes), '');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Whether markdown is the pack's 2.x seed and nothing else: the scaffold, its comments and its placeholder row. */
function isScaffold(markdown: string): boolean {
  const parsed = parseStoryMarkdown(markdown);
  return !parsed.recovered && parsed.leftover.length === 0;
}

/** Whether a record holds nothing a learner wrote: the pack's seed. */
function isBlank(story: Story): boolean {
  const text = [story.title, story.persona, story.capability, story.benefit, story.notes];
  return (
    text.every((s) => !s.trim()) &&
    story.criteria.length === 0 &&
    story.scopeExclusions.every((s) => !s.trim()) &&
    !(story.epics?.length) &&
    !story.parentEpicId
  );
}

type RecordRead =
  | { kind: 'unreadable'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; story: Story; canonical: boolean; renderHash: string | null };

/** The stored record, validated; a record that only needs normalising (a missing field, AC ids) is normalised. */
function readRecord(text: string): RecordRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', reason: 'the story record is not valid JSON, so neither file was changed' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'unreadable', reason: 'the story record is not a JSON object, so neither file was changed' };
  }
  const renderHash = typeof (raw as { renderHash?: unknown }).renderHash === 'string' ? (raw as { renderHash: string }).renderHash : null;
  const direct = validateStoryRecord(text);
  if (direct.story) return { kind: 'valid', story: direct.story, canonical: true, renderHash };
  const normalised = validateStoryRecord(serialiseStory(parseStoryJson(text)));
  if (normalised.story) return { kind: 'valid', story: normalised.story, canonical: false, renderHash };
  return { kind: 'invalid', reason: `the story record could not be kept: ${normalised.error}` };
}

/** The workspace with the record written and the markdown gone. */
function written(workspace: Record<string, string>, story: Story): Record<string, string> {
  const next: Record<string, string> = { ...workspace, [STORY_JSON]: serialiseStory(story) };
  delete next[LEGACY_STORY_MARKDOWN];
  return next;
}

/**
 * One learner's Requirements workspace, converted.
 *
 * - A valid record that holds the learner's work is kept (normalised, its
 *   2.x `renderHash` dropped) and the markdown beside it removed: `kept-record`.
 *   Markdown edited beside it (its `renderHash` no longer matches, or, with
 *   no `renderHash`, it is neither the pack's seed nor `render2x` of the
 *   record) is not deleted in
 *   silence: its comment-stripped text is appended to the record's `notes`
 *   under `EDITED_MARKDOWN_HEADER`, and a row where that would pass the notes
 *   cap is `refused` instead.
 *   A record that is only the pack's seed is not "the learner's record": when
 *   markdown sits beside it, the markdown is the work and is read instead.
 * - The story's id is the phase's own for a fixed-id phase (`options.storyId`,
 *   else the seed record's); a markdown heading's id is read only under
 *   learner-picks.
 * - With no markdown and nothing to normalise, the workspace is `untouched`.
 * - Markdown that is the 2.x scaffold and nothing else becomes the empty
 *   record: `empty-template`.
 * - Markdown the parser reads anything out of becomes that record, with any
 *   prose it could not place kept in `notes`: `parsed-markdown`.
 * - Anything else becomes the empty record with the text in `notes`: `fallback`.
 * - A record that is not JSON beside the markdown, or a result the record's
 *   own validator refuses (a field past its cap), is `refused`: the workspace
 *   comes back as it came and the reason is the sentence the receipt lists.
 */
export function convertWorkspace(workspace: Record<string, string>, options: ConvertOptions = {}): StoryConversion {
  const markdown = workspace[LEGACY_STORY_MARKDOWN];
  const recordText = workspace[STORY_JSON];
  let seed: Story = EMPTY_STORY;

  if (recordText !== undefined) {
    const read = readRecord(recordText);
    if (read.kind !== 'valid') {
      if (markdown === undefined) return { workspace, outcome: 'untouched' };
      return { workspace, outcome: 'refused', reason: read.reason };
    }
    if (!isBlank(read.story) || markdown === undefined) {
      if (markdown === undefined && read.canonical && read.renderHash === null) return { workspace, outcome: 'untouched' };
      if (markdown === undefined) return { workspace: written(workspace, read.story), outcome: 'kept-record', editedMarkdown: false };
      // Edited after the room last rendered it, or, with no `renderHash` to
      // compare, neither the pack's seed nor the room's render of this record:
      // the record wins, and the edit is kept in its notes rather than deleted
      // with the file.
      const editedMarkdown =
        read.renderHash !== null
          ? hashText(markdown) !== read.renderHash
          : !isScaffold(markdown) && markdown.replace(/\r\n?/g, '\n').trim() !== render2x(read.story).trim();
      if (!editedMarkdown) return { workspace: written(workspace, read.story), outcome: 'kept-record', editedMarkdown };
      const text = stripComments(markdown).trim();
      const kept = `${EDITED_MARKDOWN_HEADER}\n${text}`;
      const notes = read.story.notes.trim() ? `${read.story.notes}\n\n${kept}` : kept;
      if (notes.length > STORY_CAPS.fieldChars) return { workspace, outcome: 'refused', reason: EDITED_MARKDOWN_REFUSAL };
      const checked = validateStoryRecord(serialiseStory({ ...read.story, notes }));
      if (!checked.story) return { workspace, outcome: 'refused', reason: checked.error };
      return { workspace: written(workspace, checked.story), outcome: 'kept-record', editedMarkdown };
    }
    seed = read.story;
  } else if (markdown === undefined) {
    return { workspace, outcome: 'untouched' };
  }

  // A fixed-id phase keeps its own id; only under learner-picks is the
  // heading's id (`# US-5 ...`) the learner's choice and kept.
  const picks = options.storyId === LEARNER_PICKS;
  const fixed = options.storyId && !picks ? options.storyId : null;
  // The pack seeds a learner-picks record with an empty id (`content.service.ts`).
  const base: Story = { ...EMPTY_STORY, id: fixed ?? (picks ? (recordText !== undefined ? seed.id : '') : seed.id || EMPTY_STORY.id) };
  const parsed = parseStoryMarkdown(markdown, base);
  const id = picks ? parsed.story.id : base.id;
  let story: Story;
  let outcome: StoryConversionOutcome;
  if (parsed.recovered) {
    story = { ...parsed.story, id, notes: [parsed.story.notes, ...parsed.leftover].filter(Boolean).join(' ') };
    outcome = 'parsed-markdown';
  } else if (parsed.leftover.length === 0) {
    story = { ...base, id };
    outcome = 'empty-template';
  } else {
    story = { ...base, id, notes: stripComments(markdown).trim() };
    outcome = 'fallback';
  }
  const checked = validateStoryRecord(serialiseStory(story));
  if (!checked.story) return { workspace, outcome: 'refused', reason: checked.error };
  return { workspace: written(workspace, checked.story), outcome };
}
