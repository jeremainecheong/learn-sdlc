/**
 * The bounded edit-list contract for the Agentic
 * generation call, behind `AI_AGENTIC_EDIT_LIST` (default `off`).
 *
 * With the flag on, the generation call returns `{files, edits, summary}`
 * instead of retyping every changed file: `files` for a deliberate whole-file
 * rewrite, `edits` for `{path, oldString, newString}` spans, and `summary`
 * for the learner's short note of what changed (read, never enforced). `expandEditList` turns
 * that into the same `Record<path, contents>` patch the whole-file mode
 * produces, so everything after it, `validateFiles`, the merge with a
 * selected proposal, the no-op filter, `workspaceHash`, the transaction,
 * runs the same way, and for the same intended result the bytes and the hash are
 * identical to whole-file mode.
 *
 * `expandEditList` is pure: no repository, content, clock or logger.
 *
 * Every edit is matched against the UNMODIFIED base, exactly once, and spans
 * may not overlap; spans are spliced in ascending order. So the result never
 * depends on the order the model listed its edits, and an edit that would
 * only match another edit's output is an explicit failure (`no_match`), not a
 * silent success. Do not "simplify" this into sequential matching.
 *
 * Known, permanent, fail-closed limit: the
 * model reads the workspace through the provider's `scrubBody`, which rewrites
 * a literal `<<<LEARNER_DATA` / `LEARNER_DATA>>>` to `[marker]` and replaces
 * control characters, including a raw U+007F (DEL) that `JSON.stringify` does
 * not escape, with a space. An anchor copied from such a region cannot match
 * the true bytes, so it fails as `no_match` rather than mis-applying. Do not
 * weaken `scrubBody` to "fix" it.
 *
 * The saving is output tokens only: the request payload (including
 * `precedingConversation`) is unchanged in both modes, so input tokens do not
 * fall. What it saves is measured, never asserted.
 */
import { baseName, escapeRegExp } from './path-tokens';

/** Constants in code, not environment variables. */
export const EDIT_LIST_LIMITS = Object.freeze({
  /** Well above the largest observed bounded change (three files, 35/32/1 lines). */
  maxEdits: 24,
  /** Per edit, oldString + newString. More anchor than this is a rewrite: use `files`. */
  maxEditChars: 8_000,
  /** A fail-closed bound only; 9,000 completion tokens is roughly 36 KB of output. */
  maxPayloadChars: 120_000,
});

export const AGENT_EDIT_LIST_SCHEMA_NAME = 'agent_proposal_edits_v1';

/** The closed set of refusals. A code is a fixed token: never learner or model text. */
export const EDIT_EXPANSION_CODES = [
  'not_object',
  'unexpected_field',
  'bad_files_entry',
  'bad_edits_entry',
  'too_many_edits',
  'edit_too_large',
  'payload_too_large',
  'unknown_path',
  'path_in_both',
  'duplicate_path',
  'empty_old_string',
  'no_match',
  'multiple_matches',
  'overlapping_edits',
] as const;
type EditExpansionCode = typeof EDIT_EXPANSION_CODES[number];

const MATCH_FAILURES: readonly EditExpansionCode[] = ['no_match', 'multiple_matches', 'overlapping_edits'];

/** The codes that mean "the text did not match", the only ones the match sentence is true of. */
export const isEditMatchFailure = (code: EditExpansionCode): boolean => MATCH_FAILURES.includes(code);

/**
 * `path` is set only when the refused entry names a file of the base: an
 * editable path the learner can see, never a path the model invented.
 */
export class EditExpansionError extends Error {
  constructor(readonly code: EditExpansionCode, readonly path?: string) {
    super(`edit list refused: ${code}`);
    this.name = 'EditExpansionError';
  }
}

/**
 * Why an edit list was refused, as the learner reads it after the refusal's
 * fixed sentence: the rule in platform words and at most the file the refused
 * entry names, never a word the model wrote. Without it a refused list would
 * fail the turn as `assessment_unavailable`, and the learner would read "the AI
 * did not answer" for a request the model had answered, for example with edits
 * quoting `"purpose": ""`, which the runbook record holds four times.
 */
export function editListRefusalReason(error: EditExpansionError): string {
  const file = error.path;
  switch (error.code) {
    case 'no_match': return file ? `An edit to ${file} quotes text that is not in that file.` : 'An edit quotes text that is not in its file.';
    case 'multiple_matches': return file ? `An edit to ${file} quotes text that appears more than once in that file.` : 'An edit quotes text that appears more than once in its file.';
    case 'overlapping_edits': return file ? `Two edits to ${file} overlap.` : 'Two edits to one file overlap.';
    case 'empty_old_string': return file ? `An edit to ${file} quotes no text.` : 'An edit quotes no text.';
    case 'path_in_both': return file ? `The proposal gives ${file} both whole and as edits.` : 'The proposal gives one file both whole and as edits.';
    case 'duplicate_path': return file ? `The proposal gives ${file} whole twice.` : 'The proposal gives one file whole twice.';
    case 'edit_too_large': return file ? `An edit to ${file} is longer than ${EDIT_LIST_LIMITS.maxEditChars} characters.` : `An edit is longer than ${EDIT_LIST_LIMITS.maxEditChars} characters.`;
    case 'unknown_path': return 'An edit names a file this phase does not have.';
    case 'too_many_edits': return `The proposal has more than ${EDIT_LIST_LIMITS.maxEdits} edits.`;
    case 'payload_too_large': return 'The proposal is larger than an edit list may be.';
    default: return 'The proposal is not in the edit-list shape.';
  }
}

/**
 * The strict response schema, from constructs already accepted live by the
 * explanation gate's strict schema (`type`, `additionalProperties`,
 * `required`, `properties`, `enum`, `items`, `maxItems`). No `anyOf`,
 * `maxLength` or `description`: both arrays are always required, and "I need
 * neither" is `[]`. Paths are sorted so the schema is deterministic.
 */
export function agentEditListSchema(editablePaths: readonly string[]): { name: string; schema: Record<string, unknown> } {
  const paths = [...new Set(editablePaths)].sort();
  // Every phase in the pack ships at least one editable file; an empty enum
  // would be a schema no answer can satisfy.
  if (!paths.length) throw new Error('An edit list needs at least one editable path');
  const path = { type: 'string', enum: paths };
  return {
    name: AGENT_EDIT_LIST_SCHEMA_NAME,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['files', 'edits', 'summary'],
      properties: {
        files: {
          type: 'array',
          maxItems: paths.length,
          items: { type: 'object', additionalProperties: false, required: ['path', 'contents'], properties: { path, contents: { type: 'string' } } },
        },
        edits: {
          type: 'array',
          maxItems: EDIT_LIST_LIMITS.maxEdits,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'oldString', 'newString'],
            properties: { path, oldString: { type: 'string' }, newString: { type: 'string' } },
          },
        },
        summary: { type: 'string' },
      },
    },
  };
}

/**
 * The learner's proposal summary, asked for inside the one generation call in
 * both modes: what the proposal changes, what to read before explaining it
 * and, only where the phase has something to run, what to run after Apply,
 * never why it is right. It must not stand
 * in for the learner's own explanation, which the explanation gate assesses
 * without it. It names every changed file by its path, each one when there
 * are several (a file named in words only leaves the learner unable to tell
 * which file to open). It is asked for in the present tense, and runs are put
 * after Apply: the summary is read before anything is applied, so "Changed
 * ..." or "run the tests before accepting" would describe what only saved
 * files allow. It asks for statements, with "Changes ..." and "Adds ..." as
 * the form: imperatives ("Change deploy/services.json ...") read as work for
 * the learner, and invite vague run steps in Requirements and Design, where
 * nothing is run.
 */
export const PROPOSAL_SUMMARY_SENTENCE = 'Also return "summary": at most three short present-tense statements for the learner ("Changes ...", "Adds ..."), naming by its path every file this proposal changes (each one when it changes several) and which record sections change, what to read before explaining it and, only if this phase has something to run, what to run after Apply; never why it is right or what it means for the system.';

/** The longest summary kept; a longer one is cut at its last sentence end before this. */
const PROPOSAL_SUMMARY_MAX_CHARS = 600;

/**
 * The summary as stored: a non-empty string with its whitespace collapsed to
 * single spaces, cut to at most 600 characters at the last sentence end
 * (`.`, `!` or `?` before a space or the end) within the cap, else at the
 * cap. Anything else is null. It never throws and never refuses a proposal:
 * a missing summary only means the review card shows none.
 */
export function readProposalSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= PROPOSAL_SUMMARY_MAX_CHARS) return text;
  for (let at = PROPOSAL_SUMMARY_MAX_CHARS - 1; at > 0; at -= 1) {
    if ('.!?'.includes(text[at]) && text[at + 1] === ' ') return text.slice(0, at + 1);
  }
  return text.slice(0, PROPOSAL_SUMMARY_MAX_CHARS);
}

/**
 * The words that describe the contract, beside the schema and the limits they
 * describe. Each rule maps onto a server refusal. Only `oldString` must be
 * non-empty: an empty `newString` is a deletion, which stays expressible.
 */
export function editListContract(baseKey: 'proposedWorkspace' | 'workspace'): string {
  return `Return {"files":[{"path":"editable/path","contents":"complete revised file contents"}],"edits":[{"path":"editable/path","oldString":"exact existing text","newString":"replacement text"}]}. Both arrays are required; use [] for the one you do not need. Prefer edits. Every oldString must be copied byte for byte out of ${baseKey}, including indentation, quoting and line breaks, and must appear there EXACTLY ONCE — if it is not unique, extend it with the surrounding lines until it is. Never abbreviate, reflow, renumber or elide anything, and never write a placeholder such as "... unchanged ...". Every oldString must be non-empty; an empty newString deletes the oldString. Edits must not overlap each other, and a path may appear in files or in edits but never in both. Use files only for a deliberate full rewrite of one file. ${PROPOSAL_SUMMARY_SENTENCE} At most ${EDIT_LIST_LIMITS.maxEdits} edits in total. The server applies these edits to ${baseKey} and the learner reviews the resulting files; an oldString that does not appear there exactly once is rejected, and then nothing is proposed at all.`;
}

/**
 * What the edit-list contract adds to the briefings that name whole
 * documents. The Design briefing says "Return each document you change complete" and
 * the runbook and change-request briefing calls the code or configuration
 * files "each returned whole", so without these sentences the model retypes
 * every file it touches under the edit list: 0 edits in 25 of 25 Design
 * trials (about 3,200 tokens out, 17 to 33 s), and about 3,900 tokens out for
 * a Maintenance code request whose files change by a few lines. A record goes
 * back whole, one files entry and never edits (its empty fields repeat, so an
 * edit's quoted text would not be unique; `recordBriefing` says so), but as
 * compact JSON: the server reads it and lays it out (`serialiseDesign`,
 * `serialiseRunbook`, `serialiseChangeRequest`), so the stored proposal is
 * byte for byte the one a laid-out answer gives, and the model does not spend
 * tokens on escaped indentation and line breaks, about 40% of a laid-out
 * record's tokens. A code or configuration file goes through edits; the
 * learner still reviews it whole.
 * None of this is said under the whole-file contract.
 */
export const recordCompactSentence = (name: string, path: string): string => ` Write the contents of the ${name} \`${path}\` as compact JSON on one line, with no indentation and no line breaks between its fields (a line break inside a text stays written as \\n): the server reads the record and lays it out itself.`;

export const filesThroughEditsSentence = (kind: 'code' | 'configuration'): string => ` Change each ${kind} file through edits; return one whole in files only when it is empty or the request replaces most of it. A request for whole files is met by edits too: the server builds each file whole from the edits, and the learner reviews it whole.`;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

interface ExpandedEditList {
  /** The same patch shape whole-file mode produces. */
  files: Record<string, string>;
  editCount: number;
  wholeFileCount: number;
  /** The learner's proposal summary as `readProposalSummary` reads it; null when absent or unusable. */
  summary: string | null;
}

/**
 * Expand `value` against `base`: the bytes the model was shown
 * (`proposedWorkspace` in chat, the saved workspace in propose). Throws
 * `EditExpansionError` with a code from the closed set, and never returns a
 * partial patch.
 */
export function expandEditList(base: Readonly<Record<string, string>>, value: unknown): ExpandedEditList {
  if (!isRecord(value)) throw new EditExpansionError('not_object');
  // `summary` is optional beside the two arrays: a missing or unusable one is null, never a refusal.
  if (!exactKeys(value, 'summary' in value ? ['files', 'edits', 'summary'] : ['files', 'edits'])) throw new EditExpansionError('unexpected_field');
  const { files, edits } = value;
  if (!Array.isArray(files) || files.some((entry) => !isRecord(entry) || !exactKeys(entry, ['path', 'contents']) || typeof entry.path !== 'string' || typeof entry.contents !== 'string')) {
    throw new EditExpansionError('bad_files_entry');
  }
  if (!Array.isArray(edits) || edits.some((entry) => !isRecord(entry) || !exactKeys(entry, ['path', 'oldString', 'newString']) || typeof entry.path !== 'string' || typeof entry.oldString !== 'string' || typeof entry.newString !== 'string')) {
    throw new EditExpansionError('bad_edits_entry');
  }
  const wholes = files as Array<{ path: string; contents: string }>;
  const spans = edits as Array<{ path: string; oldString: string; newString: string }>;

  const known = (path: string) => Object.prototype.hasOwnProperty.call(base, path);
  // Caps before any work.
  if (spans.length > EDIT_LIST_LIMITS.maxEdits) throw new EditExpansionError('too_many_edits');
  const large = spans.find((edit) => edit.oldString.length + edit.newString.length > EDIT_LIST_LIMITS.maxEditChars);
  if (large) throw new EditExpansionError('edit_too_large', known(large.path) ? large.path : undefined);
  if (JSON.stringify(value).length > EDIT_LIST_LIMITS.maxPayloadChars) throw new EditExpansionError('payload_too_large');

  const patch: Record<string, string> = {};
  const whole = new Set<string>();
  for (const entry of wholes) {
    if (!known(entry.path)) throw new EditExpansionError('unknown_path');
    if (whole.has(entry.path)) throw new EditExpansionError('duplicate_path', entry.path);
    whole.add(entry.path);
    patch[entry.path] = entry.contents;
  }

  const byPath = new Map<string, Array<{ start: number; end: number; newString: string }>>();
  for (const edit of spans) {
    if (!known(edit.path)) throw new EditExpansionError('unknown_path');
    if (whole.has(edit.path)) throw new EditExpansionError('path_in_both', edit.path);
    if (!edit.oldString.length) throw new EditExpansionError('empty_old_string', edit.path);
    const text = base[edit.path];
    const start = text.indexOf(edit.oldString);
    if (start < 0) throw new EditExpansionError('no_match', edit.path);
    if (text.indexOf(edit.oldString, start + 1) !== -1) throw new EditExpansionError('multiple_matches', edit.path);
    const list = byPath.get(edit.path) ?? [];
    list.push({ start, end: start + edit.oldString.length, newString: edit.newString });
    byPath.set(edit.path, list);
  }
  for (const [path, list] of byPath) {
    list.sort((a, b) => a.start - b.start);
    const text = base[path];
    let out = '';
    let at = 0;
    for (const span of list) {
      if (span.start < at) throw new EditExpansionError('overlapping_edits', path);
      out += text.slice(at, span.start) + span.newString;
      at = span.end;
    }
    patch[path] = out + text.slice(at);
  }
  return { files: patch, editCount: spans.length, wholeFileCount: wholes.length, summary: readProposalSummary(value.summary) };
}

/*
 * The summary's paths against the proposal's files. The model is asked to name only the
 * files its proposal changes, yet it may still name one the proposal does not hold (a
 * Design summary naming shared/contract/api.json, say). The API never edits the model's
 * words; it either shows them whole or does not show them. With the phase's editable list
 * (the route always gives it), only an unheld path the learner may edit changes the stored
 * summary, which becomes the file sentence and the server's sentence naming that path; a
 * read-only unheld path keeps the words when the summary also names a held file, and
 * replaces them when it names none. Without the list (tests only), any unheld workspace path
 * named is a false claim about the proposal, so its words are not shown: the stored summary
 * is one sentence listing the files the proposal does hold, in the proposal's order, and
 * nothing else (appending the sentence after a false claim, such as edits to
 * deployment/runbook.json under "What this proposal changes", would still show the false
 * claim). No model call.
 * The under-claim: a summary that names one held file and leaves another out (a merged
 * Design proposal holding design/design.json and shared/contract/api.json whose summary says
 * "Changes only shared/contract/api.json") says nothing false about a file, so it keeps its
 * words and the same sentence follows them; a summary that names no path, or every held
 * file and no other, is kept as it is.
 */

/** The opening words of the one sentence the check appends, or stores alone. */
export const PROPOSAL_FILES_LEAD = 'Files in this proposal: ';

/** The check's sentence: the held paths, comma-separated, in the order given. */
export function proposalFilesSentence(held: readonly string[]): string {
  return `${PROPOSAL_FILES_LEAD}${held.join(', ')}.`;
}

/** A character that may stand inside a path, so a path touching one is part of a longer token. */
const PATH_CHAR = /[A-Za-z0-9_./-]/;

/**
 * Whether `summary` names `path` as a whole token: the path's exact spelling, not
 * touching a path character before it, and followed by nothing that continues a path
 * (a letter, digit, `_`, `-` or `/`, or a `.` that one of those follows). So a
 * backtick, a quote, a bracket, a comma or a sentence's full stop may stand beside it,
 * while `web/shared/contract/api.json`, `shared/contract/api.json.bak` and a file
 * name alone are not the workspace path `shared/contract/api.json`.
 */
function namesPath(summary: string, path: string): boolean {
  for (let at = summary.indexOf(path); at !== -1; at = summary.indexOf(path, at + 1)) {
    const end = at + path.length;
    if (at > 0 && PATH_CHAR.test(summary[at - 1])) continue;
    if (end < summary.length && /[A-Za-z0-9_/-]/.test(summary[end])) continue;
    if (summary[end] === '.' && end + 1 < summary.length && PATH_CHAR.test(summary[end + 1])) continue;
    return true;
  }
  return false;
}

/** The workspace paths a summary names, each once, in the order `paths` lists them. */
export function summaryNamedPaths(summary: string, paths: readonly string[]): string[] {
  return [...new Set(paths)].filter(path => path.length > 0 && namesPath(summary, path));
}

/*
 * The omission named: a model's summary may describe a file (a Maintenance test file, say)
 * that the proposal does not hold, and the file sentence alone would then say nothing about
 * a file the learner asked for being missing. When the answer named a file the learner may edit in
 * this phase and the proposal does not change it (its summary names it, or the route left
 * its entry out as unchanged), the stored summary is the file sentence and then this one
 * sentence of the server's. It says "named", never "changed": a summary may name a file
 * only to say it stays as it is, and an entry that changed nothing names its file too. It
 * says "ask again", which every card can do, because a plain code card has no Discard. The
 * web's own line for a file the learner's request names (namedNotHeld.ts) stands down for
 * the files this sentence names; that module keeps the lead to the byte.
 */

/** The opening words of the server's sentence about the files the answer named and the proposal does not change. */
export const PROPOSAL_NAMED_NOT_HELD_LEAD = "The mentor's answer also named ";

/** The server's sentence: every path, comma-separated in the order given, as the file sentence lists the held ones. */
export function namedNotHeldSentence(paths: readonly string[]): string {
  const them = paths.length === 1 ? 'it' : 'them';
  return `${PROPOSAL_NAMED_NOT_HELD_LEAD}${paths.join(', ')}; this proposal does not change ${them}. If you wanted ${them} changed, ask again for ${them}.`;
}

/**
 * The files an answer named that its proposal does not hold and the learner may edit, each
 * once: the `editable` paths its summary names (in the order `editable` lists them), then
 * the `dropped` paths (entries the route left out as unchanged) not already listed. A path
 * the proposal holds is never one; a summary that is null names none.
 */
export function namedNotHeldPaths(summary: string | null, held: readonly string[], editable: readonly string[], dropped: readonly string[] = []): string[] {
  const holds = new Set(held);
  const named = summary === null ? [] : summaryNamedPaths(summary, editable);
  return [...new Set([...named, ...dropped])].filter(path => !holds.has(path));
}

/** Whether `name` stands in `request` as a whole token (the web card's `tokenAt`, the same pattern). */
function requestNamesToken(request: string, name: string): boolean {
  return new RegExp(`(?<![\\w./-])${escapeRegExp(name)}(?![\\w/-]|\\.\\w)`).test(request);
}

/**
 * The `editable` paths the learner's `request` names, each once, in the order
 * `editable` lists them: a path is named when the request holds its full path, or its base name
 * when exactly one editable file has that base name, each as a whole token (so "overdue.ts" is
 * not found inside "overdue.test.ts" or "lib/overdue.ts"), case-sensitive, never fuzzy. So a
 * request that writes "overdue.ts" and "overdue.test.ts" names
 * web/src/lib/overdue.ts and web/src/lib/overdue.test.ts. This is the web card's rule for
 * "Your request names ..." (`namedNotHeld` and `tokenAt` in
 * apps/web/components/workspace/mentor/namedNotHeld.ts), ported as it is: the two must agree,
 * so a change to one is a change to the other.
 */
export function requestNamedPaths(request: string, editable: readonly string[]): string[] {
  return [...new Set(editable)].filter(path => path.length > 0 && (requestNamesToken(request, path)
    || (baseName(path) !== path && editable.filter(other => baseName(other) === baseName(path)).length === 1 && requestNamesToken(request, baseName(path)))));
}

/**
 * The files that make a first proposal be asked for once more, read only from
 * what is certain, never from prose about a file: an editable path the learner's `request`
 * names (`requestNamedPaths`) that the answer's summary names too and the proposal does not hold, and the
 * `dropped` entries (the caller passes only code and configuration files the route left out
 * as unchanged). A summary naming a file the request did not name, to say it stays as it is
 * or that it is the one to run after Apply, asks for nothing; the stored summary still names
 * it (`namedNotHeldPaths` over every editable path), so a re-ask not made hides nothing.
 */
export function reaskPaths(summary: string | null, request: string, held: readonly string[], editable: readonly string[], dropped: readonly string[] = []): string[] {
  return namedNotHeldPaths(summary, held, requestNamedPaths(request, editable), dropped);
}

/**
 * Whether a completeness re-ask's second answer replaces the first. The
 * second is kept only when it holds EVERY file the first held and at least as many of `wanted` (the
 * files the first answer holds and the editable paths the request or the first answer's summary
 * named); otherwise the first stands. So a second answer that adds the asked-for test but drops the
 * code fix the first held never replaces it, however many named files it holds.
 */
export function secondAnswerKept(firstHeld: readonly string[], secondHeld: readonly string[], wanted: readonly string[]): boolean {
  const want = new Set(wanted);
  const count = (held: readonly string[]) => new Set(held.filter(path => want.has(path))).size;
  return firstHeld.every(path => secondHeld.includes(path)) && count(secondHeld) >= count(firstHeld);
}

/**
 * The summary as stored, and the counts its log line reports: `names` the workspace
 * paths it names (the held paths count as workspace paths), `held` the proposal's files,
 * `extra` the named paths the proposal does not hold and `unnamed` the held files the
 * summary does not name. When at least one file is held: when `namedNotHeldPaths` over
 * `options` finds a file, the summary is replaced by `proposalFilesSentence(held)`,
 * one space and `namedNotHeldSentence` of those files; else a summary that names a path the
 * proposal does not hold (`extra > 0`) is replaced by `proposalFilesSentence(held)`
 * alone when no `options.editable` is given (tests only) or when it names no held file;
 * with `options.editable` given, one that names a held file and only read-only
 * unheld paths, such as the script to run after Apply, keeps its words; one
 * that names a held file while another held file is not named keeps its text, and
 * one space and that sentence follow it, once; otherwise, or when no file is held, it is
 * returned unchanged. The counts never depend on `options`.
 */
export function checkSummaryPaths(
  summary: string, held: readonly string[], workspace: readonly string[],
  options: { editable?: readonly string[]; dropped?: readonly string[] } = {},
): { summary: string; names: number; held: number; extra: number; unnamed: number } {
  const named = summaryNamedPaths(summary, [...held, ...workspace]);
  const holds = new Set(held);
  const extra = named.filter(path => !holds.has(path)).length;
  const namedHeld = named.length - extra;
  const unnamed = [...holds].filter(path => !named.includes(path)).length;
  const counts = { names: named.length, held: held.length, extra, unnamed };
  if (held.length === 0) return { summary, ...counts };
  const missing = namedNotHeldPaths(summary, held, options.editable ?? [], options.dropped ?? []);
  if (missing.length) return { summary: `${proposalFilesSentence(held)} ${namedNotHeldSentence(missing)}`, ...counts };
  // Every unheld path left here is read-only in this phase (an editable one is `missing` above). In Deployment the
  // summary names the read-only selfcheck as the thing to run after Apply, so with `options.editable` given
  // the summary keeps its words when it also names at least one held file; one that names no held file names nothing
  // true about the proposal and is replaced. Without `options.editable` any unheld path replaces it.
  if (extra > 0 && (!options.editable || namedHeld === 0)) return { summary: proposalFilesSentence(held), ...counts };
  if (namedHeld > 0 && unnamed > 0) return { summary: `${summary} ${proposalFilesSentence(held)}`, ...counts };
  return { summary, ...counts };
}
