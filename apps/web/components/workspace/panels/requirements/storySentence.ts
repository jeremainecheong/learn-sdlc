/**
 * The story sentence, "As a …, I want …, so that ….", composed in one place.
 * Every reader that writes the sentence or one of its phrases takes it
 * from here: the story card, the design room's story facts and the teacher's
 * design builder.
 *
 * A record's three parts should hold only their own words, but a model or a
 * learner may write the sentence's lead words into them: "a team member",
 * "I want tasks …", "so that I can …". Each phrase adds its lead words only when
 * the part does not already start with them, so no reader shows "As an a team
 * member, I want I want …". A persona that already has its article keeps it
 * ("the team lead" reads "As the team lead"). A capability that starts with a
 * bare verb reads "I want to …" (the lists below). A clean part reads
 * exactly as written. Nothing here rewrites the record.
 */

export interface StoryParts {
  persona: string;
  capability: string;
  benefit: string;
}

export type StoryPart = keyof StoryParts;

/** A part as the sentence reads it: trimmed, without a trailing full stop or semicolon. */
const bare = (text: string) => text.trim().replace(/[.;]+$/, '').trim();
/** "an" before a vowel letter, except the u-, eu- and one- words said with a consonant ("a user", "a unit lead", "a one-person team"). */
const CONSONANT_SOUND = /^(?:uni|use|usu|ute|ub|eu|one)/i;
const article = (persona: string) => (/^[aeiou]/i.test(persona) && !CONSONANT_SOUND.test(persona) ? 'an' : 'a');

/** "As a" / "As an" / "As the" and the article, or the article alone, with or without a comma, before more words. */
const PERSONA_LEAD = /^(?:as\s+)?(a|an|the)\b[\s,]+(?=\S)/i;
const CAPABILITY_LEAD = /^(?:i\s+want\b[\s,]*)+/i;
const BENEFIT_LEAD = /^(?:so\s+that\b[\s,]*)+/i;

/** "As a team member": the persona with one article, its own when it has one. */
export function personaPhrase(persona: string): string {
  let who = bare(persona);
  if (!who) return '';
  let own: string | null = null;
  for (let lead = who.match(PERSONA_LEAD); lead; lead = who.match(PERSONA_LEAD)) {
    own = lead[1].toLowerCase();
    who = who.slice(lead[0].length);
  }
  return `As ${own ?? article(who)} ${who}`;
}

/** A part without its lead words, or as written when they are all it holds. */
const rest = (text: string, lead: RegExp) => text.replace(lead, '').trim() || text;

/**
 * "I want to" before a capability that starts with a bare verb: a model
 * may write the capability as "see an overdue badge …", which reads "I want see …"
 * after "I want". The lists are closed on purpose; a word not in them reads as
 * written, so a capability that starts "to …" or with a noun phrase ("tasks due
 * before today to show …", "a report of …") reads exactly as written.
 *
 * WANT_TO_VERBS are base-form verbs that do not head a noun phrase in a story:
 * the capability gains "to" whatever follows. WANT_TO_IF_OBJECT are story verbs
 * that are also nouns or adjectives ("view counts", "filter options", "open
 * tasks", "list of tasks"): they gain "to" only when the next word opens an
 * object ("the", "my", "which", …), so "view my tasks" reads "to view my tasks"
 * and "filter options to appear" reads as written. The record and the part shown
 * beside its label never change; only the composed sentence reads the word.
 * The same lists are in packages/shared/src/map.ts (the project map's story detail).
 */
export const WANT_TO_VERBS = [
  'see', 'add', 'create', 'delete', 'remove', 'know', 'be', 'have', 'get', 'receive', 'manage', 'assign',
  'choose', 'select', 'find', 'write', 'submit', 'show', 'hide', 'spot', 'identify', 'rename', 'keep',
  'tell', 'catch',
] as const;
export const WANT_TO_IF_OBJECT = [
  'view', 'filter', 'sort', 'search', 'list', 'mark', 'edit', 'update', 'change', 'check', 'review', 'track',
  'set', 'share', 'export', 'import', 'upload', 'download', 'open', 'close', 'complete', 'save', 'read', 'log',
  'sign', 'reset', 'report', 'undo',
] as const;
export const OBJECT_OPENERS = [
  'the', 'a', 'an', 'my', 'our', 'your', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those',
  'every', 'each', 'all', 'any', 'some', 'both', 'which', 'what', 'whether', 'how', 'when', 'where', 'who',
  'it', 'them', 'me', 'us', 'only',
] as const;
const words = (list: readonly string[]) => new Set(list);
const VERBS = words(WANT_TO_VERBS);
const VERBS_IF_OBJECT = words(WANT_TO_IF_OBJECT);
const OPENERS = words(OBJECT_OPENERS);

/** The capability after "I want": "to " added before a bare verb from the lists above, otherwise as written. */
const wanted = (what: string) => {
  const [first = '', second = ''] = what.toLowerCase().split(/\s+/, 2).map((word) => word.replace(/[^a-z'-]+$/, ''));
  return VERBS.has(first) || (VERBS_IF_OBJECT.has(first) && OPENERS.has(second)) ? `to ${what}` : what;
};

/** "I want tasks due before today to show an overdue badge"; "I want to see an overdue badge …". */
export function capabilityPhrase(capability: string): string {
  const what = bare(capability);
  return what ? `I want ${wanted(rest(what, CAPABILITY_LEAD))}` : '';
}

/** "so that I can quickly identify overdue tasks". */
export function benefitPhrase(benefit: string): string {
  const why = bare(benefit);
  return why ? `so that ${rest(why, BENEFIT_LEAD)}` : '';
}

/** The whole sentence, ending in a full stop, only once all three parts are written; otherwise ''. */
export function storySentence(story: StoryParts): string {
  const phrases = [personaPhrase(story.persona), capabilityPhrase(story.capability), benefitPhrase(story.benefit)];
  return phrases.every(Boolean) ? `${phrases.join(', ')}.` : '';
}

/**
 * A part as shown beside its own label ("As a", "I want", "So that"), without
 * the label's words: the API's rule for a generated proposal
 * (`storyPartValue` in apps/api/src/assistant/story-proposal.ts), so a value
 * read here matches what the Compare shows. A part those words are all of is
 * shown as written.
 */
const PART_LEAD: Record<StoryPart, RegExp> = {
  persona: /^as\b[\s,]+/i,
  capability: /^i\s+want\b[\s,]*/i,
  benefit: /^so\s+that\b[\s,]*/i,
};

export function storyPartText(part: StoryPart, text: string): string {
  const written = text.trim();
  let out = written;
  for (let previous = ''; previous !== out;) {
    previous = out;
    out = out.replace(PART_LEAD[part], '').replace(/[\s,.]+$/, '').trim();
  }
  return out || written;
}
