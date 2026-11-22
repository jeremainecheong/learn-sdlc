import { CHANGE_CAPS, type ChangeRequest } from '@learnsdlc/shared';
import { MARKER, collapse, markdownLines } from '../record-markdown/markdown-lines';

/**
 * `CHANGELOG.md` read into the change request's release, pure.
 * The newest entry is the first level-two heading carrying a
 * MAJOR.MINOR.PATCH token: the token is the version, the heading's other
 * words the summary, and each bullet or non-blank line under it a change
 * line (prefixed "<subheading>: " under a level-three subheading) covering
 * nothing yet. The template rule drops a line the template holds verbatim
 * in the same entry (matched by its version, else its heading), wherever it
 * is. Nothing the learner typed vanishes without a word: a comment, a
 * level-one title line, a heading with nothing under it, a level-three
 * heading the template's entry does not hold whose lines were all the
 * template's, and an older heading whose words differ from the template's
 * (the newest entry's heading is the release's version and summary) are kept
 * in notes, as is everything outside the newest entry and whatever does not
 * fit the release, under "Kept from CHANGELOG.md:"; nothing is cut.
 */
export const SEMVER_TOKEN = /\b\d+\.\d+\.\d+\b/;
/** Which of the template's entries an entry is matched against: its version when its heading carries one (the learner may add a summary to it), else its heading. */
const entryKey = (heading: string) => SEMVER_TOKEN.exec(heading)?.[0] ?? heading.toLowerCase();

/**
 * One line of an entry. `note` keeps it in notes (a comment, a title line, an
 * empty heading); `heading` marks a line that is the entry's own heading,
 * either an empty heading or an older heading the learner reworded over the
 * template's body. The newest entry keeps no such line: its heading is the
 * release's version.
 */
interface EntryLine { sub: string; text: string; note: boolean; heading?: true }
/** `subs`: the level-three headings with a line or comment under them, whose words ride on those lines. */
interface Entry { heading: string; lines: EntryLine[]; subs: string[] }

/** The file's level-two entries: the text above the first heading is an entry with no heading. */
function entries(markdown: string, dropTodo: boolean): Entry[] {
  const out: Entry[] = [{ heading: '', lines: [], subs: [] }];
  let sub = '';
  let subLines = 0;
  // a level-three heading with nothing under it is kept with its entry; one with lines is listed for the template rule
  const closeSub = () => {
    if (!sub) return;
    if (subLines) out[out.length - 1].subs.push(sub);
    else out[out.length - 1].lines.push({ sub: '', text: `### ${sub}`, note: true });
  };
  const closeEntry = () => {
    closeSub();
    const entry = out[out.length - 1];
    if (entry.heading && !entry.lines.length) entry.lines.push({ sub: '', text: `## ${entry.heading}`, note: true, heading: true });
  };
  for (const line of markdownLines(markdown, dropTodo)) {
    if (line.kind === 'comment') { out[out.length - 1].lines.push({ sub, text: line.text, note: true }); subLines += 1; continue; }
    const raw = line.raw;
    const h2 = /^##(?!#)\s*(.*)$/.exec(raw);
    if (h2) { closeEntry(); out.push({ heading: h2[1].trim(), lines: [], subs: [] }); sub = ''; subLines = 0; continue; }
    const h3 = /^###\s*(.*)$/.exec(raw);
    if (h3) { closeSub(); sub = h3[1].trim(); subLines = 0; continue; }
    if (!raw.trim()) continue;
    // a level-one title line is the learner's words too, kept as written
    if (/^#\s/.test(raw)) { out[out.length - 1].lines.push({ sub: '', text: raw.trim(), note: true }); continue; }
    out[out.length - 1].lines.push({ sub, text: raw.replace(MARKER, '').trim(), note: false });
    subLines += 1;
  }
  closeEntry();
  return out;
}

export interface ChangelogParse { change: ChangeRequest; notes: string[]; learnerLines: number }

/**
 * The change request `markdown` reads as: only its release is filled.
 * `template` drops the template's own lines (the migration's reading; a
 * draft or upload conversion passes none), and `dropTodo` drops a line or a
 * comment that is only the template's `TODO(learner)` instruction.
 * `learnerLines` 0 means nothing the learner wrote (a newest heading whose
 * words are not the template's counts as one line); the version and summary
 * are then left empty.
 */
export function changeFromChangelog(markdown: string, options: { file?: string; template?: string; dropTodo?: boolean }): ChangelogParse {
  const file = options.file ?? 'CHANGELOG.md';
  const theirs = new Map<string, { heading: string; lines: Set<string>; subs: Set<string> }>();
  for (const one of options.template ? entries(options.template, false) : []) {
    theirs.set(entryKey(one.heading), { heading: collapse(one.heading), lines: new Set(one.lines.map((l) => collapse(l.text))), subs: new Set(one.subs.map(collapse)) });
  }
  // an entry's heading is the learner's words when no template entry matches it or its words differ from the match's
  const ownHeading = (entry: Entry) => theirs.get(entryKey(entry.heading))?.heading !== collapse(entry.heading);
  const all = entries(markdown, !!options.dropTodo);
  const newest = all.find((one) => SEMVER_TOKEN.test(one.heading));
  const change: ChangeRequest = { impact: { operations: [], screens: [], files: [] }, contract: [], tests: [], release: { version: '', summary: '', changes: [], rollback: '' } };
  const notes: string[] = [];
  let learnerLines = 0;
  for (const entry of all) {
    // an older heading the learner reworded over the template's body is kept, though every line under it is dropped
    const lines = entry !== newest && entry.heading && theirs.has(entryKey(entry.heading)) && ownHeading(entry) && !entry.lines.some((l) => l.heading)
      ? [{ sub: '', text: `## ${entry.heading}`, note: true, heading: true as const }, ...entry.lines]
      : entry.lines;
    const match = theirs.get(entryKey(entry.heading));
    const spoken = new Set<string>();
    const kept = (line: EntryLine) => {
      learnerLines += 1;
      const text = line.sub ? `${line.sub}: ${line.text}` : line.text;
      if (line.sub) spoken.add(line.sub);
      if (entry === newest && !line.note && change.release.changes.length < CHANGE_CAPS.listItems && text.length <= CHANGE_CAPS.fieldChars) {
        change.release.changes.push({ id: `L${change.release.changes.length + 1}`, line: text, covers: [] });
      } else notes.push(entry.heading && entry !== newest && !line.heading ? `${entry.heading}: ${text}` : text);
    };
    for (const line of lines) {
      if (entry === newest && line.heading) continue;
      if (match?.lines.has(collapse(line.text))) continue;
      kept(line);
    }
    // a level-three heading the template's entry does not hold, every line under it dropped as the template's
    // (its TODO comment, say), keeps its own words
    for (const sub of new Set(entry.subs)) if (!spoken.has(sub) && !match?.subs.has(collapse(sub))) kept({ sub: '', text: `### ${sub}`, note: true });
  }
  // the newest heading's words, when they are the learner's, are the release's version and summary
  if (newest && ownHeading(newest)) learnerLines += 1;
  if (newest && learnerLines > 0) {
    const token = SEMVER_TOKEN.exec(newest.heading)![0];
    change.release.version = token;
    change.release.summary = newest.heading.replace(token, '').replace(/^[\s:–—-]+|[\s:–—-]+$/g, '').trim();
  }
  return { change, notes: notes.length ? [`Kept from ${file}:\n${notes.join('\n')}`] : [], learnerLines };
}
