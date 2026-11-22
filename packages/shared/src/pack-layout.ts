import type { ArtifactKind } from './contract/phase-detail';
import type { PhaseKey } from './phases';

/**
 * The archive's layout is its manifest: a phase folder holds
 * `phase.json`, the fixed files, and only the folders its kind uses. These
 * names are the one list the loader, the door, the export and the web read.
 */
export type PhaseFolder = 'files' | 'readonly' | 'quizzes' | 'hidden_tests' | 'solution' | 'reference' | 'impl' | 'mutants' | 'smoke' | 'drill';

export const PHASE_JSON = 'phase.json';
export const INTERVIEW_JSON = 'interview.json';
export const COMMON_FOLDERS: readonly PhaseFolder[] = Object.freeze(['files', 'readonly', 'quizzes'] as PhaseFolder[]);
export const KIND_FOLDERS: Readonly<Record<'code' | 'tests' | 'config', readonly PhaseFolder[]>> = Object.freeze({
  code: Object.freeze(['hidden_tests', 'solution'] as PhaseFolder[]),
  tests: Object.freeze(['reference', 'impl', 'mutants'] as PhaseFolder[]),
  config: Object.freeze(['smoke', 'drill'] as PhaseFolder[]),
});

export function foldersFor(kind: ArtifactKind): readonly PhaseFolder[] {
  return kind === 'code' || kind === 'tests' || kind === 'config' ? [...COMMON_FOLDERS, ...KIND_FOLDERS[kind]] : COMMON_FOLDERS;
}

export function kindOfFolder(folder: PhaseFolder): 'code' | 'tests' | 'config' | null {
  for (const kind of ['code', 'tests', 'config'] as const) if (KIND_FOLDERS[kind].includes(folder)) return kind;
  return null;
}


/** What a local run leaves behind: refused by name in an upload, skipped by the platform's disk walk. */
export const MACHINE_OUTPUT_FOLDERS: ReadonlySet<string> = new Set(['__pycache__', 'node_modules', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv']);
/** An editor's settings: refused by name in an upload with a sentence of their own, skipped on disk. */
export const EDITOR_FOLDERS: ReadonlySet<string> = new Set(['.idea', '.vscode']);
export function isMachineOutputFile(name: string): boolean {
  return /\.(pyc|map)$/.test(name);
}

/** What the desktop writes into every archive it makes: left out with a warning, never a refusal. */
export const DESKTOP_FOLDER = '__MACOSX';
const DESKTOP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
export function isDesktopFile(name: string): boolean {
  return DESKTOP_FILES.has(name) || name.startsWith('._');
}

/** Mount order is a rule, not an authored fact: workspace path, code-unit order. */
export function compareMountPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function sortedMounts<T extends { path: string }>(mounts: readonly T[]): T[] {
  return [...mounts].sort((a, b) => compareMountPaths(a.path, b.path));
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  py: 'python', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', sql: 'sql', html: 'html',
  yml: 'yaml', yaml: 'yaml', css: 'css', scss: 'scss', sh: 'shell', toml: 'toml', xml: 'xml', md: 'markdown', txt: 'plaintext',
});

/** A mount's language, from its path alone: the extension, the file name `Dockerfile`, else plain text. */
export function languageOfPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'Dockerfile') return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'plaintext';
  const ext = name.slice(dot + 1);
  return Object.prototype.hasOwnProperty.call(LANGUAGE_BY_EXTENSION, ext) ? LANGUAGE_BY_EXTENSION[ext] : 'plaintext';
}

/** A phase folder's name in an export: its place, two digits, then its key. The number is for people. */
export function phaseFolderName(place: number, key: PhaseKey): string {
  return `${String(place).padStart(2, '0')}-${key}`;
}
/** The key a phase folder names, as written: `<NN>-<key>` or `<key>`. The caller decides whether it is a key. */
export function phaseKeyOfFolder(name: string): string {
  return name.replace(/^\d+-/, '');
}
