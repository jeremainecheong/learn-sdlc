/**
 * The learner's user story as a structured record, `requirements/story.json`.
 *
 * The record is the only copy: the Requirements room reads and writes it, the
 * floor below grades it, and the review reads its fields. Everything here is
 * pure; nothing in this module touches the network or the DOM.
 */

import { isObject } from './record-read';

export type CriterionTag = 'happy' | 'boundary' | 'error';

export const CRITERION_TAGS: { value: CriterionTag; label: string }[] = [
  { value: 'happy', label: 'Happy path' },
  { value: 'boundary', label: 'Boundary' },
  { value: 'error', label: 'Error' },
];

export interface AcceptanceCriterion {
  id: string; // AC-1, AC-2, …
  given: string;
  when: string;
  then: string;
  tag: CriterionTag;
}

export interface Story {
  epics?: Array<{ id: string; title: string; outcome: string }>;
  parentEpicId?: string;
  id: string; // US-4
  title: string;
  persona: string;
  capability: string;
  benefit: string;
  criteria: AcceptanceCriterion[];
  scopeExclusions: string[];
  notes: string;
}

export const STORY_JSON = 'requirements/story.json';

export const EMPTY_STORY: Story = {
  id: 'US-4',
  title: '',
  persona: '',
  capability: '',
  benefit: '',
  criteria: [],
  scopeExclusions: [],
  notes: '',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const tagOf = (v: unknown): CriterionTag =>
  v === 'boundary' || v === 'error' || v === 'happy' ? v : 'happy';

/** Renumber AC ids so they always read 1..n after an add, a delete or a move. */
export function renumber(criteria: AcceptanceCriterion[]): AcceptanceCriterion[] {
  return criteria.map((c, i) => ({ ...c, id: `AC-${i + 1}` }));
}

export function newCriterion(index: number, tag: CriterionTag = 'happy'): AcceptanceCriterion {
  return { id: `AC-${index + 1}`, given: '', when: '', then: '', tag };
}

/**
 * Read `story.json`. A learner can open the file in the editor and break it,
 * so anything unreadable falls back to the empty record rather than throwing
 * the panel away.
 */
export function parseStoryJson(text: string): Story {
  if (!text.trim()) return EMPTY_STORY;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_STORY;
  }
  if (!isObject(raw)) return EMPTY_STORY;
  const o = raw;
  const criteria = Array.isArray(o.criteria)
    ? o.criteria.slice(0, STORY_CAPS.listItems).map((c, i) => {
        const r = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
        return {
          id: str(r.id) || `AC-${i + 1}`,
          given: str(r.given),
          when: str(r.when),
          then: str(r.then),
          tag: tagOf(r.tag),
        };
      })
    : [];
  return {
    ...(Array.isArray(o.epics) ? { epics: o.epics.slice(0, STORY_CAPS.listItems).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object').map(item => ({ id: str(item.id), title: str(item.title), outcome: str(item.outcome) })) } : {}),
    ...(typeof o.parentEpicId === 'string' ? { parentEpicId: o.parentEpicId } : {}),
    id: str(o.id) || EMPTY_STORY.id,
    title: str(o.title),
    persona: str(o.persona),
    capability: str(o.capability),
    benefit: str(o.benefit),
    criteria: renumber(criteria),
    scopeExclusions: Array.isArray(o.scopeExclusions)
      ? o.scopeExclusions.slice(0, STORY_CAPS.listItems).map(str)
      : [],
    notes: str(o.notes),
  };
}

export function serialiseStory(story: Story): string {
  return `${JSON.stringify(story, null, 2)}\n`;
}

export interface StoryFloor { minCriteria: number; requiredTags: CriterionTag[]; minExclusions: number; requireSentence: boolean }
export interface ProvidedStory { id: string; title: string; persona: string; capability: string; benefit: string; criteria?: AcceptanceCriterion[] }
export interface LearnerStorySpec { id: string; hints: { persona?: string; capability?: string; benefit?: string } }
export interface StoryChecksSpec { kind: 'story'; record: string; providedStories: ProvidedStory[]; learnerStory: LearnerStorySpec; floor: StoryFloor }
export const LEARNER_PICKS = 'learner-picks';
/** Publish and the upload door without the conversion flag refuse a teacher's Requirements task still in the older format with this sentence. */
export const REQUIREMENTS_OLDER_FORMAT_REFUSAL = 'Requirements is still in the older format. Open its Requirements step in the editor and save it once to convert it.';
/** The class door refuses, and the assignable list drops, a version whose Requirements still grades markdown. */
export const REQUIREMENTS_OLDER_FORMAT_ASSIGN_REFUSAL = "This version's Requirements is in the older format and cannot be assigned. Publish it again from the editor.";
/** What the room says when a job queued for a Requirements task still in the older format reaches the grader. */
export const REQUIREMENTS_OLDER_FORMAT_ROOM = "This project's Requirements task is in an older format; its owner needs to re-save it.";
export const DEFAULT_STORY_FLOOR: StoryFloor = { minCriteria: 2, requiredTags: ['happy', 'boundary'], minExclusions: 1, requireSentence: true };
/**
 * The story kind's caps, one set for the editor DTO and the upload door
 * (`validateStoryChecks`): a story id and a criterion id 16 characters, a
 * provided story's title 160, each sentence part and each hint 400, each
 * provided criterion's clause 400, at most 12 provided stories and 20 criteria
 * on each. `listItems` and `fieldChars` are the learner record's own caps.
 */
export const STORY_CAPS = {
  minCriteria: [1, 8], minExclusions: [0, 6], providedStories: 12, criterionSentence: 400, listItems: 20, fieldChars: 4000,
  storyId: 16, storyTitle: 160, sentencePart: 400, criterionId: 16,
  /** The id a learner types where the teacher lets them pick it: the desk's own cap. */
  learnerPickedId: 40,
} as const;
/** The desk's sentence for a learner-picked id left empty, and the save's refusal of one. */
export const STORY_ID_NEEDED = 'Give your story an id.';
export type StoryFloorId = 'story.record' | 'story.sentence' | 'story.criteria.min' | 'story.criteria.tags' | 'story.scope.min';
export interface StoryFloorResult { id: StoryFloorId; label: string; passed: boolean; detail: string }

const TAG_WORD: Record<CriterionTag, string> = { happy: 'happy path', boundary: 'boundary', error: 'error' };
const complete = (c: AcceptanceCriterion) => !!(c.given.trim() && c.when.trim() && c.then.trim());

export function evaluateStoryFloor(story: Story, floor: StoryFloor): StoryFloorResult[] {
  const done = story.criteria.filter(complete);
  const sentence = !!(story.persona.trim() && story.capability.trim() && story.benefit.trim());
  const missingTag = floor.requiredTags.find(tag => !done.some(c => c.tag === tag));
  const scope = story.scopeExclusions.filter(s => s.trim()).length;
  return [
    { id: 'story.sentence', label: 'A full story sentence', passed: !floor.requireSentence || sentence,
      detail: !floor.requireSentence || sentence ? 'As a, I want and So that are filled' : 'As a / I want / So that are not all filled' },
    { id: 'story.criteria.min', label: `At least ${floor.minCriteria} acceptance ${floor.minCriteria === 1 ? 'criterion' : 'criteria'}`, passed: done.length >= floor.minCriteria,
      detail: done.length >= floor.minCriteria ? `${done.length} complete criteria` : `Story has fewer than ${floor.minCriteria} acceptance criteria` },
    { id: 'story.criteria.tags', label: 'The required cases', passed: !missingTag,
      detail: missingTag ? `No ${TAG_WORD[missingTag]} case among the criteria` : 'Every required case is covered' },
    // Keeps the plural for 1: the reviewer model's request carries this label verbatim; storyFloorShown fixes it for display.
    { id: 'story.scope.min', label: `At least ${floor.minExclusions} out-of-scope lines`, passed: scope >= floor.minExclusions,
      detail: scope >= floor.minExclusions ? `${scope} out-of-scope lines` : `Fewer than ${floor.minExclusions} out-of-scope lines` },
  ];
}

/**
 * The story floor's out-of-scope sentence as a person reads it where a review
 * shows it: "At least 1 out-of-scope line", "Fewer than 1
 * out-of-scope line", "1 out-of-scope line". `evaluateStoryFloor` keeps
 * "lines" for 1 in the label and the detail it returns, because those reach
 * the reviewer model's request byte for byte; this is applied only where the
 * sentence is shown, never where it is built. Any other text comes back as it was.
 */
export function storyFloorShown(text: string): string {
  return text.replace(/\b1 out-of-scope lines\b/g, '1 out-of-scope line');
}

const isString = (v: unknown): v is string => typeof v === 'string';
export function validateStoryRecord(text: string, expectedId?: string): { story: Story; error: null } | { story: null; error: string } {
  const fail = (error: string) => ({ story: null, error } as const);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return fail('The story record is not valid JSON'); }
  if (!isObject(raw)) return fail('The story record is not an object');
  const r = raw;
  const fields = ['id', 'title', 'persona', 'capability', 'benefit', 'notes'] as const;
  for (const f of fields) {
    if (!isString(r[f])) return fail(`${f} is not text`);
    if ((r[f] as string).length > STORY_CAPS.fieldChars) return fail(`${f} is longer than ${STORY_CAPS.fieldChars} characters`);
  }
  if (expectedId && expectedId !== LEARNER_PICKS && r.id !== expectedId) return fail(`the story id must be ${expectedId}`);
  if (expectedId === LEARNER_PICKS && !(r.id as string).trim()) return fail(STORY_ID_NEEDED);
  if (expectedId === LEARNER_PICKS && (r.id as string).length > STORY_CAPS.learnerPickedId) return fail(`the story id is longer than ${STORY_CAPS.learnerPickedId} characters`);
  if (!Array.isArray(r.criteria)) return fail('criteria is not a list');
  if (r.criteria.length > STORY_CAPS.listItems) return fail(`more than ${STORY_CAPS.listItems} criteria`);
  const criteria: AcceptanceCriterion[] = [];
  for (const [i, c] of (r.criteria as unknown[]).entries()) {
    if (!c || typeof c !== 'object') return fail(`criterion ${i + 1} is not an object`);
    const k = c as Record<string, unknown>;
    if (k.id !== `AC-${i + 1}`) return fail('criteria are not numbered AC-1, AC-2, …');
    for (const f of ['given', 'when', 'then'] as const) {
      if (!isString(k[f]) || k[f].length > STORY_CAPS.fieldChars) return fail(`AC-${i + 1} ${f} is missing or too long`);
    }
    if (!CRITERION_TAGS.some(t => t.value === k.tag)) return fail(`AC-${i + 1} has an unknown tag`);
    criteria.push({ id: k.id, given: k.given as string, when: k.when as string, then: k.then as string, tag: k.tag as CriterionTag });
  }
  if (!Array.isArray(r.scopeExclusions) || r.scopeExclusions.some(s => !isString(s) || s.length > STORY_CAPS.fieldChars)) return fail('scopeExclusions is not a list of text');
  if (r.scopeExclusions.length > STORY_CAPS.listItems) return fail(`more than ${STORY_CAPS.listItems} out-of-scope lines`);
  let epics: NonNullable<Story['epics']> | undefined;
  if (Array.isArray(r.epics)) {
    if (r.epics.length > STORY_CAPS.listItems) return fail(`more than ${STORY_CAPS.listItems} epics`);
    epics = [];
    for (const [i, e] of (r.epics as unknown[]).entries()) {
      if (!isObject(e)) return fail(`epic ${i + 1} is not an object`);
      const k = e;
      for (const f of ['id', 'title', 'outcome'] as const) {
        if (!isString(k[f])) return fail(`epic ${i + 1} ${f} is not text`);
        if (k[f].length > STORY_CAPS.fieldChars) return fail(`epic ${i + 1} ${f} is longer than ${STORY_CAPS.fieldChars} characters`);
      }
      epics.push({ id: k.id as string, title: k.title as string, outcome: k.outcome as string });
    }
  }
  if (isString(r.parentEpicId) && r.parentEpicId.length > STORY_CAPS.fieldChars) return fail(`parentEpicId is longer than ${STORY_CAPS.fieldChars} characters`);
  const story: Story = { id: r.id as string, title: r.title as string, persona: r.persona as string, capability: r.capability as string,
    benefit: r.benefit as string, criteria, scopeExclusions: r.scopeExclusions as string[], notes: r.notes as string,
    ...(epics?.length ? { epics } : {}), ...(isString(r.parentEpicId) ? { parentEpicId: r.parentEpicId } : {}) };
  return { story, error: null };
}

export function storyRecordCheck(text: string, expectedId?: string): StoryFloorResult {
  return recordCheckOf(validateStoryRecord(text, expectedId));
}

/** The record check's row for a validation already run, so a caller need not validate twice. */
export function recordCheckOf(out: { error: string | null }): StoryFloorResult {
  return { id: 'story.record', label: 'The story record', passed: !out.error, detail: out.error ?? 'The record is well formed' };
}

export function storyReviewProjection(story: Story): Record<string, string> {
  const p: Record<string, string> = { 'story/title': story.title, 'story/as-a': story.persona, 'story/i-want': story.capability, 'story/so-that': story.benefit };
  story.criteria.forEach((c, i) => { const n = i + 1; p[`story/ac-${n}/given`] = c.given; p[`story/ac-${n}/when`] = c.when; p[`story/ac-${n}/then`] = c.then; p[`story/ac-${n}/tag`] = c.tag; });
  story.scopeExclusions.forEach((s, i) => { p[`story/scope/${i + 1}`] = s; });
  p['story/notes'] = story.notes;
  return p;
}

/** Items joined as a sentence says them: "a", "a and b", "a, b and c". */
export function andList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function floorSentence(floor: StoryFloor): string {
  const parts: string[] = [];
  if (floor.requireSentence) parts.push('a full story sentence');
  const tags = floor.requiredTags.map(t => (t === 'happy' ? 'a happy path' : t === 'error' ? 'an error case' : `a ${TAG_WORD[t]} case`));
  const tagText = tags.length ? ` including ${andList(tags)}` : '';
  // Each required case is its own criterion, so a minimum below the number of cases is said as that number.
  const least = Math.max(floor.minCriteria, tags.length);
  parts.push(`at least ${least} ${least === 1 ? 'criterion' : 'criteria'}${tagText}`);
  parts.push(`at least ${floor.minExclusions} out-of-scope line${floor.minExclusions === 1 ? '' : 's'}`);
  return parts.length === 3 ? `${parts[0]}, ${parts[1]}, and ${parts[2]}` : parts.join(', and ');
}
