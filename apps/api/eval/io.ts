import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { privacyFindings, redactForStdout } from './privacy';

/**
 * Where things live, and the only way the harness writes. Directories are
 * 0700 and files 0600; every write is a tmp file renamed into place, so a
 * crash never leaves half a record that a resume would trust.
 */

/** The root of the checkout this file is in (the folder that holds `content/`). */
export function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, 'content', 'tasktrackr', 'project.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('repository root not found');
    dir = up;
  }
  return dir;
}

/** The evaluation folder (corpus, models.json, runs/). Overridable for specs and the dry run. */
export function evalRoot(): string {
  const root = process.env.EVAL_ROOT;
  if (!root) throw new Error('EVAL_ROOT is not set: name the evaluation folder (corpus/, models.json, runs/); see apps/api/eval/README.md');
  return root;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

/**
 * The harness's scratch folder, `.eval-scratch/` at the checkout root (ignored
 * by git): the workspace copies the sandbox runs and the plan's composition
 * runs. Nothing in it is a result; results go under EVAL_ROOT.
 */
export const scratchRoot = (): string => ensureDir(path.join(repoRoot(), '.eval-scratch'));

/** Where a write's privacy findings go (kinds only, never the text), in the run folder the file belongs to. */
export const PRIVACY_LOG = 'privacy-findings.jsonl';
const warnedFiles = new Set<string>();

/**
 * Every file the harness writes is privacy-scanned. Model output is kept as
 * the model wrote it (the record is the audit trail, in a 0700/0600 folder
 * only its user can read), so a finding does not stop the run: its kinds
 * are appended to the run's privacy-findings.jsonl and one redacted warning is
 * printed. The report files keep their hard refusal (report/report.ts).
 */
function scanWritten(file: string, text: string): string[] {
  if (path.basename(file) === PRIVACY_LOG) return [];
  const kinds = [...new Set(privacyFindings(text).map((f) => f.kind))];
  if (!kinds.length) return kinds;
  const m = /^(.*[\\/]runs[\\/][^\\/]+)[\\/]/.exec(file);
  const logDir = m ? m[1] : path.dirname(file);
  const fd = fs.openSync(path.join(logDir, PRIVACY_LOG), 'a', 0o600);
  try { fs.writeSync(fd, `${JSON.stringify({ file: path.relative(logDir, file), kinds, at: new Date().toISOString() })}\n`); } finally { fs.closeSync(fd); }
  if (!warnedFiles.has(file)) { warnedFiles.add(file); say(`privacy: ${kinds.join(', ')} in ${path.relative(logDir, file)} (kinds logged to ${PRIVACY_LOG}; the text is not printed)`); }
  return kinds;
}

export function writeAtomic(file: string, data: string | Buffer): void {
  ensureDir(path.dirname(file));
  scanWritten(file, typeof data === 'string' ? data : data.toString('utf8'));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    if (typeof data === 'string') fs.writeSync(fd, data); else fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export const writeJson = (file: string, value: unknown): void => writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function appendLine(file: string, line: string): void {
  ensureDir(path.dirname(file));
  scanWritten(file, line);
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${line}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Every stdout line goes through the privacy redaction first. Aliases, counts and dollars only. */
export function say(line: string): void {
  process.stdout.write(`${redactForStdout(line)}\n`);
}

/** Safe file-name segment for a case id or model key. */
export const seg = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_');
