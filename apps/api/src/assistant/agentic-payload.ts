import * as path from 'path';
import type { PhaseContent } from '../content/content.types';
import type { AgenticPayloadMode } from '../config';
import { baseName, escapeRegExp } from './path-tokens';

/**
 * What the Agentic generation call (`agentic.generate`) is sent, in the mode
 * `AI_AGENTIC_PAYLOAD` names.
 *
 * `full` builds the data object with the whole workspace, key for key and
 * byte for byte. `trim`
 * makes two cuts:
 *
 * - **No file twice.** At the chat site, `savedWorkspace` keeps only the
 *   files whose saved bytes differ from `proposedWorkspace`, so it is empty
 *   when no proposal is selected.
 * - **The request's named files.** When the request names editable files
 *   (by path, or by a file name no other phase file shares, as
 *   `readOnlyTargets` matches them), the workspace carries those files, the
 *   selected proposal's files, and the phase files they import, followed
 *   transitively. The other editable paths are listed in
 *   `otherEditablePaths` with no contents. A read-only file reaches the model
 *   only under `readOnlyContext`, and only when a sent file imports it. A
 *   request that names no editable file sends the whole editable set.
 *
 * Nothing here decides what a proposal may hold: `validateFiles` still
 * checks the answer against every editable path, and an edit list still
 * expands against the full workspace.
 */

export type PhaseFiles = Pick<PhaseContent, 'files'>;

/** Said at the chat site in trim mode: the saved workspace holds only what differs. */
export const TRIM_SAVED_SENTENCE = 'savedWorkspace holds only the saved files whose bytes differ from proposedWorkspace; every other saved file is identical to its proposedWorkspace entry.';

/** Said when the request named its files and the workspace key shows only those and their imports. */
export const TRIM_NAMED_SENTENCE = (key: 'workspace' | 'proposedWorkspace'): string =>
  `${key} shows the full contents only of the files the request names, the files they import and any files already in the proposal; otherEditablePaths lists the other editable paths, whose contents are not shown: never return one of them.`;

/** Said when read-only imports ride along. */
export const TRIM_READ_ONLY_SENTENCE = 'readOnlyContext holds read-only files that the shown files import, as context only: never return, change or create any of them.';

/**
 * The phase files a request names, in the phase's order: by path, or by a
 * file name (with an extension) that no other file of the phase shares. The
 * same test `readOnlyTargets` uses to decide whether a message names a file.
 */
export function namedFiles(phase: PhaseFiles, message: string): string[] {
  const files = phase?.files ?? [];
  const counts = new Map<string, number>();
  for (const file of files) counts.set(baseName(file.path), (counts.get(baseName(file.path)) ?? 0) + 1);
  const byName = (file: string) => baseName(file).includes('.') && counts.get(baseName(file)) === 1;
  const named = (file: string) => message.includes(file) || (byName(file) &&
    new RegExp(`(^|[^\\w./-])${escapeRegExp(baseName(file))}(?![\\w/-])`).test(message));
  return files.filter(file => named(file.path)).map(file => file.path);
}

const PY_FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([^\n#]+)/gm;
const JS_SPECIFIERS = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom[ \t]*['"]([^'"]+)['"]/g,
  /\bimport[ \t]*['"]([^'"]+)['"]/g,
  /\b(?:require|import)[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/g,
];
const JS_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

const join = (...parts: string[]) => path.posix.normalize(path.posix.join(...parts)).replace(/^\.\//, '');

/** The phase paths one Python file's imports can name. */
function pythonImports(file: string, text: string, known: Set<string>): string[] {
  const dir = path.posix.dirname(file);
  const out: string[] = [];
  const module = (base: string, dotted: string, names: string[]) => {
    const parts = dotted ? dotted.split('.').filter(Boolean) : [];
    const stem = join(base, ...parts);
    const candidates = [`${stem}.py`, `${stem}/__init__.py`, ...names.map(name => join(stem, `${name}.py`))];
    for (const candidate of candidates) if (known.has(candidate)) out.push(candidate);
  };
  const resolve = (spec: string, names: string[]) => {
    const dots = spec.length - spec.replace(/^\.+/, '').length;
    const dotted = spec.slice(dots);
    if (dots) {
      module(join(dir, ...Array(dots - 1).fill('..')), dotted, names);
      return;
    }
    // An absolute module: from the project root, or beside the importing file.
    module('.', dotted, names);
    if (dir !== '.') module(dir, dotted, names);
  };
  for (const match of text.matchAll(PY_FROM)) {
    const names = match[2].replace(/[()]/g, ' ').split(',').map(name => name.trim().split(/\s+/)[0]).filter(name => /^\w+$/.test(name));
    resolve(match[1], names);
  }
  for (const match of text.matchAll(PY_IMPORT)) {
    for (const item of match[1].split(',')) {
      const spec = item.trim().split(/\s+/)[0];
      if (/^[\w.]+$/.test(spec)) resolve(spec, []);
    }
  }
  return out;
}

/** The phase paths one JavaScript or TypeScript file's relative imports name. */
function scriptImports(file: string, text: string, known: Set<string>): string[] {
  const dir = path.posix.dirname(file);
  const out: string[] = [];
  for (const pattern of JS_SPECIFIERS) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1];
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const target = join(dir, spec);
      const stems = [target, ...(/\.(m|c)?js$/.test(target) ? [target.replace(/\.(m|c)?js$/, '')] : [])];
      const hit = stems.flatMap(stem => JS_EXTENSIONS.map(ext => `${stem}${ext}`)).find(candidate => known.has(candidate));
      if (hit) out.push(hit);
    }
  }
  return out;
}

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;

/** The phase paths a file imports directly, by its language. Files of other kinds import nothing. */
function importsOf(file: string, text: string, known: Set<string>): string[] {
  if (file.endsWith('.py')) return pythonImports(file, text, known);
  if (SCRIPT.test(file)) return scriptImports(file, text, known);
  return [];
}

/**
 * The roots and every phase file they import, followed transitively, in the
 * phase's file order. An editable file is scanned in the bytes `workspace`
 * holds for it, which are the bytes being sent; a read-only file in the
 * pack's bytes.
 */
export function importClosure(phase: PhaseFiles, roots: string[], workspace: Record<string, string>): string[] {
  const files = phase?.files ?? [];
  const known = new Set(files.map(file => file.path));
  const textOf = (file: string) => {
    const spec = files.find(row => row.path === file);
    return spec?.editable ? (workspace[file] ?? spec.content) : (spec?.content ?? '');
  };
  const seen = new Set<string>();
  const queue = roots.filter(root => known.has(root));
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const target of importsOf(next, textOf(next), known)) if (!seen.has(target)) queue.push(target);
  }
  return files.map(file => file.path).filter(file => seen.has(file));
}

interface Focus {
  /** The editable paths whose contents are shown, or null for all of them. */
  shown: Set<string> | null;
  otherEditablePaths: string[];
  readOnlyContext: Record<string, string>;
}

/** What a trimmed payload shows, from the request text and the files any selected proposal already holds. */
function focusOf(phase: PhaseFiles, request: string, workspace: Record<string, string>, keep: string[]): Focus {
  const files = phase?.files ?? [];
  const editable = files.filter(file => file.editable).map(file => file.path);
  const editableSet = new Set(editable);
  const named = namedFiles(phase, request).filter(file => editableSet.has(file));
  if (!named.length) return { shown: null, otherEditablePaths: [], readOnlyContext: {} };
  const closure = importClosure(phase, [...named, ...keep.filter(file => editableSet.has(file))], workspace);
  const shown = new Set(closure.filter(file => editableSet.has(file)));
  const readOnlyContext = Object.fromEntries(files.filter(file => !file.editable && closure.includes(file.path)).map(file => [file.path, file.content]));
  return { shown, otherEditablePaths: editable.filter(file => !shown.has(file)), readOnlyContext };
}

const pick = (workspace: Record<string, string>, shown: Set<string> | null) =>
  shown ? Object.fromEntries(Object.entries(workspace).filter(([file]) => shown.has(file))) : workspace;

/** The keys a focused payload adds after its workspace, only when they hold something. */
function focusKeys(focus: Focus): Record<string, unknown> {
  return {
    ...(focus.otherEditablePaths.length ? { otherEditablePaths: focus.otherEditablePaths } : {}),
    ...(Object.keys(focus.readOnlyContext).length ? { readOnlyContext: focus.readOnlyContext } : {}),
  };
}

export interface ChatGenerationInput {
  /** The request as the chat route records it (`conversationContext().intent`). */
  request: string;
  transcript: unknown;
  saved: Record<string, string>;
  proposed: Record<string, string>;
  /** The selected proposal's paths: always shown when the payload is focused. */
  selectedPaths: string[];
  /** The design stories and change ticket the phase's kind adds, in both modes. */
  extra: Record<string, unknown>;
}

/**
 * The chat request is the intent JSON, where a newline or tab is a backslash
 * escape (twice escaped inside the selected proposal's own request), so a file
 * name at the start of a line would follow the letter `n`. The matcher reads a
 * copy with each escape turned into a space; a file path never holds a
 * backslash. The request itself is sent unchanged.
 */
const decodedRequest = (request: string) => request.replace(/\\+(?:[nrtbf]|u[0-9a-fA-F]{4})/g, ' ');

/** The chat site's generation data. */
export function chatGenerationData(mode: AgenticPayloadMode, phase: PhaseFiles, input: ChatGenerationInput): Record<string, unknown> {
  const { request, transcript, saved, proposed, selectedPaths, extra } = input;
  if (mode !== 'trim') return { originalAndContinuedRequest: request, precedingConversation: transcript, savedWorkspace: saved, proposedWorkspace: proposed, ...extra };
  const focus = focusOf(phase, decodedRequest(request), proposed, selectedPaths);
  const shown = pick(proposed, focus.shown);
  const differing = Object.fromEntries(Object.entries(saved).filter(([file, bytes]) => file in shown && shown[file] !== bytes));
  return { originalAndContinuedRequest: request, precedingConversation: transcript, savedWorkspace: differing, proposedWorkspace: shown, ...focusKeys(focus), ...extra };
}

export interface ProposeGenerationInput {
  prompt: string;
  workspace: Record<string, string>;
  extra: Record<string, unknown>;
}

/** The propose site's generation data. Trim with no named file is the full object. */
export function proposeGenerationData(mode: AgenticPayloadMode, phase: PhaseFiles, input: ProposeGenerationInput): Record<string, unknown> {
  const { prompt, workspace, extra } = input;
  if (mode !== 'trim') return { prompt, workspace, ...extra };
  const focus = focusOf(phase, prompt, workspace, []);
  return { prompt, workspace: pick(workspace, focus.shown), ...focusKeys(focus), ...extra };
}

/**
 * The system text trim mode appends to the generation prompt, naming only
 * the keys the payload carries; empty in full mode and for a payload that is
 * the full object.
 */
export function trimSentence(mode: AgenticPayloadMode, data: Record<string, unknown>): string {
  if (mode !== 'trim') return '';
  const parts: string[] = [];
  if ('savedWorkspace' in data && 'proposedWorkspace' in data) parts.push(TRIM_SAVED_SENTENCE);
  if ('otherEditablePaths' in data) parts.push(TRIM_NAMED_SENTENCE('proposedWorkspace' in data ? 'proposedWorkspace' : 'workspace'));
  if ('readOnlyContext' in data) parts.push(TRIM_READ_ONLY_SENTENCE);
  return parts.map(part => ` ${part}`).join('');
}
