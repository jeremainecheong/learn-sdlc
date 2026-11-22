import { RUNBOOK_CAPS, RUNBOOK_ID_LETTER, type Runbook, type RunbookList } from '@learnsdlc/shared';
import { MARKER, collapse, markdownLines } from '../record-markdown/markdown-lines';

/**
 * `RUNBOOK.md` read into the runbook record, pure. The file is
 * split at its level-two headings and each heading's words pick a list; each
 * remaining bullet or non-blank line is one item, a fenced block one item
 * with the block's text. A line the template holds, verbatim with its
 * whitespace collapsed, in the same section is not the learner's and is
 * dropped. Nothing the learner typed vanishes without a word: a comment, a
 * level-one title line, a heading that picks no list with nothing under it
 * and, when a template is given, a list or incident heading the template
 * does not hold (its words as a header with no line) are kept in `notes`, as
 * is whatever does not fit a list, in whole groups under a header naming the
 * file and the section; the caller refuses a parse whose notes would not fit.
 */
export type RunbookSection = RunbookList | 'incident' | 'notes';

const HEADING = /^##(?!#)\s*(.*)$/;
const unwrap = (text: string) => text.replace(MARKER, '').replace(/^(\*\*|__)(.*?)\1/, '$2').replace(/^(\*\*|__)([^*_]+?)(\*\*|__)\s*/, '$2 ').trim();

/** The list a level-two heading's words pick; any other heading is kept as notes. */
export function runbookSectionOf(heading: string): RunbookSection {
  const words = heading.toLowerCase();
  if (/\b(environment|env|runtime|variables?)\b/.test(words)) return 'environment';
  if (/\bhealth\b/.test(words)) return 'health';
  if (/\b(rollback|roll back)\b/.test(words)) return 'rollback';
  if (/\b(data|backups?|volumes?|storage)\b/.test(words)) return 'data';
  if (/\b(incident|postmortem|post-mortem|outage)\b/.test(words)) return 'incident';
  return 'notes';
}

/** One item of a section: `note` keeps it in notes whatever the section (a comment, a title line, an empty heading). */
interface Item { text: string; note: boolean }
interface Section { heading: string; key: RunbookSection; items: Item[] }

/**
 * The file's sections: the text above the first heading is a notes section
 * with no heading. A heading that picks no list and has nothing under it is
 * one empty-text item of its own, so it is kept (or matched against the
 * template's) like a line.
 */
function sections(markdown: string, dropTodo: boolean): Section[] {
  const out: Section[] = [{ heading: '', key: 'notes', items: [] }];
  let fence: string[] | null = null;
  for (const line of markdownLines(markdown, dropTodo)) {
    const section = out[out.length - 1];
    if (line.kind === 'comment') {
      if (fence) fence.push(`<!-- ${line.text} -->`);
      else section.items.push({ text: line.text, note: true });
      continue;
    }
    const raw = line.raw;
    if (fence) {
      if (/^\s*```/.test(raw)) { section.items.push({ text: fence.join('\n').trim(), note: false }); fence = null; } else fence.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) { fence = []; continue; }
    const heading = HEADING.exec(raw);
    if (heading) { out.push({ heading: heading[1].trim(), key: runbookSectionOf(heading[1]), items: [] }); continue; }
    if (!raw.trim()) continue;
    // a level-one title line is the learner's words too, kept as written
    if (/^#\s/.test(raw)) { section.items.push({ text: raw.trim(), note: true }); continue; }
    section.items.push({ text: unwrap(raw), note: false });
  }
  if (fence) out[out.length - 1].items.push({ text: fence.join('\n').trim(), note: false });
  for (const one of out) if (one.heading && one.key === 'notes' && !one.items.length) one.items.push({ text: '', note: true });
  return out.filter((one) => one.heading || one.items.length);
}

export interface RunbookParse { runbook: Runbook; notes: string[]; learnerLines: number }

/**
 * The record `markdown` reads as. `template` drops the template's own lines
 * (the migration's reading, where an empty template is a file the version
 * gave none, every line and heading the learner's; a draft or upload
 * conversion passes none, so the teacher's file becomes the starting record
 * whole), `dropTodo` drops a line or a comment that is only the template's
 * `TODO(learner)` instruction, `drillIncident` is the drill's incident, which
 * wins over the file's (every incident line is then kept in notes), and
 * `incidentToNotes` keeps the file's incident lines in notes (a starting
 * runbook in a drill phase has an empty incident). `learnerLines` counts the
 * lines and headings that were not the template's: 0 means nothing the
 * learner wrote.
 */
export function runbookFromMarkdown(
  markdown: string,
  options: { file?: string; template?: string; dropTodo?: boolean; drillIncident?: { rootCause: string; fix: string; actionItem: string } | null; incidentToNotes?: boolean },
): RunbookParse {
  const file = options.file ?? 'RUNBOOK.md';
  const theirs = new Map<string, Set<string>>();
  for (const one of options.template ? sections(options.template, false) : []) {
    const key = one.key === 'notes' ? `notes:${one.heading.toLowerCase()}` : one.key;
    const set = theirs.get(key) ?? new Set<string>();
    for (const item of one.items) set.add(collapse(item.text));
    theirs.set(key, set);
  }
  // A list or incident heading the template does not hold, whitespace collapsed, is the learner's words: its words are
  // kept as a notes header, though its items go to the list. Only the migration's reading (a given template) keeps it.
  const theirHeadings = options.template === undefined ? null : new Set(options.template ? sections(options.template, false).map((one) => collapse(one.heading)) : []);
  const runbook: Runbook = { environment: [], health: [], rollback: [], data: [], incident: { rootCause: '', fix: '', actionItem: '' } };
  const groups = new Map<string, string[]>();
  // an empty text is a heading kept alone: its group carries the header and no line
  const keep = (header: string, line: string) => groups.set(header, [...(groups.get(header) ?? []), ...(line ? [line] : [])]);
  let learnerLines = 0;
  for (const section of sections(markdown, !!options.dropTodo)) {
    const key = section.key === 'notes' ? `notes:${section.heading.toLowerCase()}` : section.key;
    const header = section.heading ? `Kept from ${file}, ${section.heading}:` : `Kept from ${file}:`;
    if (theirHeadings && section.key !== 'notes' && !theirHeadings.has(collapse(section.heading))) { keep(header, ''); learnerLines += 1; }
    for (const { text: item, note } of section.items) {
      if (theirs.get(key)?.has(collapse(item))) continue;
      learnerLines += 1;
      if (note || item.length > RUNBOOK_CAPS.fieldChars || section.key === 'notes') { keep(header, item); continue; }
      if (section.key === 'incident') {
        const field = /^root cause:\s*(.*)$/i.exec(item) ? 'rootCause' : /^fix:\s*(.*)$/i.exec(item) ? 'fix' : /^action item:\s*(.*)$/i.exec(item) ? 'actionItem' : null;
        const value = field ? item.replace(/^(root cause|fix|action item):\s*/i, '') : '';
        if (field && value && !options.drillIncident && !options.incidentToNotes && !runbook.incident[field]) runbook.incident[field] = value;
        else keep(header, item);
        continue;
      }
      const list = runbook[section.key];
      if (list.length >= RUNBOOK_CAPS.listItems) { keep(header, item); continue; }
      const id = `${RUNBOOK_ID_LETTER[section.key]}${list.length + 1}`;
      if (section.key === 'environment') {
        const split = /^(.*?)(?::\s+|:$|\s+[-–—]\s+)(.*)$/.exec(item);
        runbook.environment.push({ id, name: (split ? split[1] : item).trim(), purpose: (split ? split[2] : '').trim(), kind: 'config' });
      } else if (section.key === 'health') runbook.health.push({ id, name: '', how: item, expected: '' });
      else if (section.key === 'rollback') runbook.rollback.push({ id, step: item, verify: '' });
      else runbook.data.push({ id, what: item, how: '', where: '' });
    }
  }
  if (options.drillIncident) runbook.incident = { ...options.drillIncident };
  return { runbook, notes: [...groups].map(([header, lines]) => [header, ...lines].join('\n')), learnerLines };
}
