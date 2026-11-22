import { UPLOAD_REFUSAL_DETAIL_MAX } from '@learnsdlc/shared';
import { isFolderLayout } from '../content/folder-layout';
import { MemoryPackSource } from '../content/memory-pack-source';
import { LayoutWalkRefusal, editorFolderSentence, machineOutputSentence } from '../content/pack-source';
import type { PackSource } from '../content/pack-source';
import { plainPath } from '../content/secret-paths';
import { printable } from './upload-limits';

/**
 * How the upload door says a loader failure: the wire's detail (printable,
 * clipped, one full stop), the loader's own words with the archive's internal
 * label taken out, and, for JSON that does not parse, the file a teacher must
 * fix without quoting a byte of it. Pure: the export door says its read-back's
 * failures the same way.
 */

/**
 * A detail as the wire carries it: printable (`printable` drops control and
 * other non-printable characters and any trailing full stop), trimmed, ended
 * with one full stop, at most UPLOAD_REFUSAL_DETAIL_MAX characters.
 */
export function refusalDetail(text: string): string | undefined {
  const said = printable(text).trim();
  return said ? `${said.slice(0, UPLOAD_REFUSAL_DETAIL_MAX - 1).trimEnd()}.` : undefined;
}

/**
 * What V8's `JSON.parse` says when a body is not JSON. Every form either
 * quotes an excerpt of the body (`Unexpected token 'x', "…" is not valid
 * JSON`) or names a position in it; none of it may leave the server.
 */
export const JSON_PARSE_FAILURE =
  /Unexpected token|Unexpected end of JSON|Unexpected non-whitespace character|is not valid JSON|in JSON at position|Bad (control|escaped) character|Unterminated string|Expected (property name|double-quoted property name|',' or|':' after|unexpected character)|No number after minus sign|Exponent part is missing|Unterminated fractional number/i;

/**
 * The loader's own words as `detail` (the field and the file a teacher
 * has to fix) minus anything that could carry a byte of a file body.
 *
 * A JSON.parse failure is never passed on in any part (V8 quotes the body and
 * names the token it stopped at). Instead the door names the file itself
 * (`jsonFailureDetail`), found from where the loader says it failed, never by
 * searching the pack, so a JSON-with-comments file the loader never reads
 * (a `tsconfig.app.json`, `.vscode/settings.json`) is never named in its place.
 * Any other loader sentence (it names fields, paths and the values the pack
 * chose) loses the source's internal labels (`unlabelled`), control and
 * non-printable characters, and everything past UPLOAD_REFUSAL_DETAIL_MAX.
 */
export function loaderDetail(error: unknown, source: MemoryPackSource): string {
  // Machine output or an editor's folder, its path printed as the refusals print one.
  if (error instanceof LayoutWalkRefusal) {
    const at = plainPath(error.path);
    return refusalDetail(error.editor ? editorFolderSentence(at) : machineOutputSentence(at)) ?? machineOutputSentence(at);
  }
  const raw = error instanceof Error ? error.message : String(error);
  if (error instanceof SyntaxError || JSON_PARSE_FAILURE.test(raw)) return jsonFailureDetail(raw, source);
  return refusalDetail(unlabelled(raw, source.name)) ?? 'Its files do not match the authoring format.';
}

/**
 * The loader's refusal as the upload door says it: the
 * text `detail` carries under NOT_A_PACK (`loaderDetail`), for another door
 * that reads an archive through the same loader (the export's read-back). Printable,
 * at most UPLOAD_REFUSAL_DETAIL_MAX characters, never a JSON.parse excerpt and
 * never a byte of a file body; `source` is the archive's `MemoryPackSource`.
 */
export function loaderSentence(error: unknown, source: MemoryPackSource): string {
  return loaderDetail(error, source);
}

/** An error's class name for a log line: a short identifier, never its message. */
export function errorClassOf(error: unknown): string {
  const name = error instanceof Error ? error.constructor?.name || error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(name)) ? String(name) : 'error';
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A loader sentence without the source's internal labels: the loader's own
 * `<name>/` prefix, and `MemoryPackSource`'s `upload:<name>/` location and
 * resolved-path form. The pack root alone reads as the
 * project folder.
 */
export function unlabelled(text: string, name: string): string {
  const label = escapeRegExp(name);
  return text
    .replace(new RegExp(`(^|[\\s(])upload:${label}/`, 'g'), '$1')
    .replace(new RegExp(`(^|[\\s(])upload:${label}(?=$|[\\s).,;:])`, 'g'), '$1the project folder')
    .replace(new RegExp(`(^|[\\s(])${label}/`, 'g'), '$1');
}

const FIX_JSON = 'Open it in an editor that checks JSON, fix it and upload again.';
/** The remedy when the failing file is one of several a phase reads. */
const FIX_EACH_JSON = FIX_JSON.replace('Open it', 'Open each one');
/** The sentence when no file can be named: every JSON file in the pack is suspect. */
const NO_VALID_JSON = `A JSON file in this pack is not valid JSON. ${FIX_EACH_JSON}`;

/** The parsed JSON object at `rel`, or null when it is missing, unreadable or not JSON. */
export function parsedAt(source: PackSource, rel: string): Record<string, unknown> | null {
  try {
    if (!source.exists(rel)) return null;
    const parsed: unknown = JSON.parse(source.read(rel));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether the file at `rel` exists and does not parse as JSON. */
function failsToParse(source: PackSource, rel: string): boolean {
  try {
    if (!source.exists(rel)) return false;
    JSON.parse(source.read(rel));
    return false;
  } catch {
    return true;
  }
}

/**
 * The detail for a loader that stopped on a JSON.parse,
 * built from where the loader says it was and from the files it reads there,
 * never the parser's message and never a search of the pack.
 *
 * - `<name>/<phase>: interview is not valid JSON: …` → the interview's file as
 *   `phase.json` names it (`{ source }`, or a bare path that exists, as
 *   `readFileValue` reads it), or `phase.json` itself for inline content.
 * - `<name>/<phase>: …` → that phase's `phase.json`, then each mutant's
 *   `meta.json` under the phase's `checks.mutantsDir`: the first that does not
 *   parse.
 * - no phase prefix → `project.json` when it does not parse.
 *
 * Paths are printed as the pack names them (the pack's own choices may be
 * echoed), never as a host path; failing all of that, a fixed sentence.
 */
export function jsonFailureDetail(raw: string, source: MemoryPackSource): string {
  const said = (path: string): string => `${path} is not valid JSON. ${FIX_JSON}`;
  const inPack = (dir: PackSource, rel: string): string =>
    printable(unlabelled(dir.resolve(rel), source.name)).trim();
  const project = parsedAt(source, 'project.json');
  if (project && isFolderLayout(project)) return folderJsonFailureDetail(raw, source);
  const declared = project?.phases;
  const phase = (Array.isArray(declared) ? declared : [])
    .filter((rel): rel is string => typeof rel === 'string' && raw.startsWith(`${source.name}/${rel}: `))
    .sort((a, b) => b.length - a.length)[0];
  try {
    if (phase === undefined) {
      if (failsToParse(source, 'project.json')) return said('project.json');
    } else {
      const dir = source.child(phase);
      const inner = raw.slice(`${source.name}/${phase}: `.length);
      const spec = parsedAt(dir, 'phase.json');
      if (/^interview is not valid JSON/.test(inner)) {
        const value = spec?.interview;
        const named =
          value && typeof value === 'object' && typeof (value as { source?: unknown }).source === 'string'
            ? (value as { source: string }).source
            : typeof value === 'string' && looksLikeFileName(value) && dir.exists(value)
              ? value
              : null;
        if (named !== null && dir.exists(named)) return said(inPack(dir, named));
        return `The interview written inside ${inPack(dir, 'phase.json')} is not valid JSON. Fix the interview's content and upload again.`;
      }
      if (failsToParse(dir, 'phase.json')) return said(inPack(dir, 'phase.json'));
      const checks = spec?.checks as { mutantsDir?: unknown } | undefined;
      const mutantsDir = typeof checks?.mutantsDir === 'string' ? checks.mutantsDir : 'mutants';
      if (dir.exists(mutantsDir)) {
        const mutants = dir.child(mutantsDir);
        for (const one of mutants.entries().filter((entry) => entry.isDirectory)) {
          const meta = `${one.name}/meta.json`;
          if (failsToParse(mutants, meta)) return said(inPack(mutants, meta));
        }
      }
      return `A JSON file the phase ${inPack(source, phase)} reads is not valid JSON. ${FIX_EACH_JSON}`;
    }
  } catch {
    // a path the pack names that leaves it, or a folder that is a file: fall through
  }
  return NO_VALID_JSON;
}

/**
 * `jsonFailureDetail` for the folder layout: the phase folder the
 * failure names (`<pack>/phases/03-implementation...: `, or the derivation's
 * own `phases/03-implementation...: `), then its files by their fixed names:
 * the interview when the loader says so, `phase.json`, each mutant's
 * `meta.json`, `interview.json`; with no phase folder, `project.json`.
 */
function folderJsonFailureDetail(raw: string, source: MemoryPackSource): string {
  const said = (path: string): string => `${printable(path).trim()} is not valid JSON. ${FIX_JSON}`;
  const inner = raw.startsWith(`${source.name}/`) ? raw.slice(source.name.length + 1) : raw;
  const named = /^(phases\/[^/:\s]+)(\/phase\.json)?: /.exec(inner);
  try {
    if (!named) {
      if (failsToParse(source, 'project.json')) return said('project.json');
    } else {
      const folder = named[1];
      const rest = inner.slice(named[0].length);
      if (/^interview is not valid JSON/.test(rest) && failsToParse(source, `${folder}/interview.json`)) return said(`${folder}/interview.json`);
      if (failsToParse(source, `${folder}/phase.json`)) return said(`${folder}/phase.json`);
      if (source.exists(`${folder}/mutants`)) {
        for (const one of source.entries(`${folder}/mutants`).filter((entry) => entry.isDirectory)) {
          if (failsToParse(source, `${folder}/mutants/${one.name}/meta.json`)) return said(`${folder}/mutants/${one.name}/meta.json`);
        }
      }
      if (failsToParse(source, `${folder}/interview.json`)) return said(`${folder}/interview.json`);
      return `A JSON file the phase ${printable(folder).trim()} reads is not valid JSON. ${FIX_EACH_JSON}`;
    }
  } catch {
    // a folder that is a file: fall through
  }
  return NO_VALID_JSON;
}

/** `readFileValue`'s test for a bare string that may name a file beside the phase. */
export function looksLikeFileName(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\n\r\0]/.test(value) && value.trim() === value;
}
