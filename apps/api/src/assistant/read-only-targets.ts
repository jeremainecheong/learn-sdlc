import type { PhaseContent } from '../content/content.types';
import { baseName, escapeRegExp } from './path-tokens';

/** Verbs whose direct object is the file that would change: "fix api/errors.py". */
const DIRECT_EDIT = String.raw`\b(?:edit|change|modify|update|rewrite|fix|refactor)\s+`;
/** A change named as a noun, then the file: "make a change to api/errors.py". */
const CHANGE_TO = String.raw`\b(?:changes?|edits?|modifications?|updates?)\s+to\s+`;
/** Adding to a file, the file after its preposition: "add a docstring to / at the top of api/errors.py". */
const ADD_INTO = String.raw`\b(?:add|append|insert|prepend)\b[^\n?!;]{0,80}?\b(?:to|into|at\s+the\s+(?:top|start|beginning|end|bottom)\s+of)\s+`;
/** What may stand between the verb and the file: "the", "the file", "the read-only file". */
const FILE_DETERMINER = String.raw`(?:the\s+)?(?:(?:read-only|file)\s+)*`;

/**
 * The read-only files an Agentic request asks to change, or none.
 *
 * Only the phase's own files count, the ones its explorer shows, so a refusal
 * names nothing the learner cannot already see. A file is named by its path,
 * or by its file name when no other file of the phase shares it. A request is
 * refused only in the clear case: it names no editable file,
 * and a read-only file is the direct object of an edit verb ("edit / change /
 * modify / update / rewrite / fix / refactor <file>", "make a change to
 * <file>", "add … to / at the top of <file>"). Everything else goes to the
 * model with its usual two calls: a question about a read-only file, a
 * change to an editable file that names one, and a change that names a
 * read-only file only as context ("raise the error defined in api/errors.py",
 * "a test like the one in tests/test_api.py") without naming its target. A
 * proposal can only ever hold editable files (validateFiles), so a refused
 * request could not succeed; refusing it first spares the learner both paid
 * calls.
 */
export function readOnlyTargets(phase: PhaseContent, message: string): string[] {
  const files = phase?.files ?? [];
  const counts = new Map<string, number>();
  for (const file of files) counts.set(baseName(file.path), (counts.get(baseName(file.path)) ?? 0) + 1);
  const byName = (path: string) => baseName(path).includes('.') && counts.get(baseName(path)) === 1;
  const named = (path: string) => message.includes(path) || (byName(path) &&
    new RegExp(`(^|[^\\w./-])${escapeRegExp(baseName(path))}(?![\\w/-])`).test(message));
  if (files.some(file => file.editable && named(file.path))) return [];
  const readOnly = files.filter(file => !file.editable);
  // A file as it may be written: its path, or its unshared file name.
  const token = (path: string) => `(?:${[escapeRegExp(path), ...(byName(path) ? [escapeRegExp(baseName(path))] : [])].join('|')})(?![\\w/-])`;
  // "change api/errors.py and tests/test_api.py": every file of a listed object is a target.
  const listed = readOnly.length ? `(?:(?:${readOnly.map(file => token(file.path)).join('|')})\\s*(?:,\\s*(?:and\\s+)?|and\\s+|&\\s*)${FILE_DETERMINER})*` : '';
  const target = (path: string) => [DIRECT_EDIT, CHANGE_TO, ADD_INTO]
    .some(lead => new RegExp(`${lead}${FILE_DETERMINER}${listed}${token(path)}`, 'i').test(message));
  return readOnly.filter(file => target(file.path)).map(file => file.path);
}

/** The one sentence a refused read-only request shows the learner. */
export function readOnlyRefusal(paths: string[]): string {
  return `${paths.join(', ')} ${paths.length === 1 ? 'is' : 'are'} read-only in this phase, so the mentor cannot propose a change to ${paths.length === 1 ? 'it' : 'them'}; ask for a change to one of your editable files instead.`;
}
