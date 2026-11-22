/**
 * The phase's editable files the learner's request names and the proposal
 * does not change, and the one line that says so.
 *
 * Built only from the request text and two file lists, and literal on purpose:
 * a file is named when the request holds its full path, or its base name when
 * exactly one editable file has that base name, as a whole token (so
 * "overdue.ts" is not found inside "overdue.test.ts" or "lib/overdue.ts"),
 * case-sensitive, never fuzzy. It does not read intent: "leave overdue.ts
 * alone" names overdue.ts too, and the line stays true because it only states
 * that the request names the file, that the proposal does not change it, and
 * what to do if the learner wanted it changed.
 */
import { PROPOSAL_FILES_LEAD } from './proposalFilesSentence';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The first place `name` stands as a whole token in `text`, or -1. */
function tokenAt(text: string, name: string): number {
  const match = new RegExp(`(?<![\\w./-])${escape(name)}(?![\\w/-]|\\.\\w)`).exec(text);
  return match ? match.index : -1;
}

/**
 * The opening words of the API's own sentence about the files the mentor's answer named
 * and the proposal does not change (`PROPOSAL_NAMED_NOT_HELD_LEAD` and
 * `namedNotHeldSentence` in apps/api/src/assistant/proposal-edits.ts, kept to the byte
 * here; named-not-held.test.ts reads the API's source to hold the two together).
 */
export const SUMMARY_NAMED_NOT_HELD_LEAD = "The mentor's answer also named ";

/**
 * The paths the API's sentence in `summary` names, or none. The API stores it only right
 * after its file sentence over `held`, so only that exact opening is read: a summary in
 * the model's own words is never mistaken for it.
 */
export function summaryNamedNotHeld(summary: string | null | undefined, held: readonly string[]): string[] {
  const opening = `${PROPOSAL_FILES_LEAD}${held.join(', ')}. ${SUMMARY_NAMED_NOT_HELD_LEAD}`;
  if (!summary || !held.length || !summary.startsWith(opening)) return [];
  const end = summary.indexOf('; this proposal does not change ', opening.length);
  return end < 0 ? [] : summary.slice(opening.length, end).split(', ');
}

/**
 * The editable paths the request names and `held` (the proposal's files) does not hold, in the order the request
 * names them. A path the API's sentence in the proposal's `summary` already names is left out, so the card
 * never says the same missing file twice.
 */
export function namedNotHeld(request: string | null | undefined, editable: readonly string[] | null | undefined, held: readonly string[], summary?: string | null): string[] {
  if (!request || !editable?.length) return [];
  const said = summaryNamedNotHeld(summary, held);
  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const named = editable.flatMap((path) => {
    const unique = editable.filter((other) => base(other) === base(path)).length === 1;
    const at = [tokenAt(request, path), unique && base(path) !== path ? tokenAt(request, base(path)) : -1].filter((i) => i >= 0);
    return at.length ? [{ path, at: Math.min(...at) }] : [];
  });
  return named.filter((one) => !held.includes(one.path) && !said.includes(one.path)).sort((a, b) => a.at - b.at).map((one) => one.path);
}

/**
 * The line under the files list. `discard` is whether the card has a Discard
 * button; a card without one says "ask again for it" instead.
 */
export function namedNotHeldLine(paths: readonly string[], discard: boolean): string | null {
  if (!paths.length) return null;
  const one = paths.length === 1;
  const them = one ? 'it' : 'them';
  return `Your request names ${paths.join(', ')}. This proposal does not change ${them}. If you wanted ${them} changed, ${discard ? 'discard this proposal and ask again' : `ask again for ${them}`}.`;
}
