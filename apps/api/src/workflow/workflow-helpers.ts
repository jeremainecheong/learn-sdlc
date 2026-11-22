import { PHASE_SUMMARY_INTRO_MAX, type WorkspaceFile } from '@learnsdlc/shared';

/*
 * The workflow service's pure helpers: the summary's intro and file index,
 * timestamps as the client reads them, the one line of a failure an HTTP
 * message quotes, and the design operations carried into Maintenance. No
 * repository and no service.
 */

/**
 * The opening of a phase's intro for `PhaseSummary.intro`,
 * at most `PHASE_SUMMARY_INTRO_MAX` characters, cut at a word where one is near.
 */
export function summaryIntro(intro: string | null | undefined): string {
  const text = String(intro ?? '');
  if (text.length <= PHASE_SUMMARY_INTRO_MAX) return text;
  const cut = text.slice(0, PHASE_SUMMARY_INTRO_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > PHASE_SUMMARY_INTRO_MAX / 2 ? cut.slice(0, space) : cut}\u2026`;
}

/**
 * The file index a summary phase detail carries instead of the workspace.
 *
 * Every path is still there, with its language and whether it is editable, so a
 * tree, a tab strip or a shelf draws the same; what is gone is the bodies. Two
 * facts the shell would otherwise compute from a body come with it: `lines`,
 * and `touched`, the same rule the phase card applies
 * (something in the file, and the stub's `TODO(learner)` marker gone), so the
 * card reads the same word from a number instead of from 30 KB of source.
 *
 * `content` stays present and empty rather than being dropped: the field is not
 * optional on WorkspaceFile, and `PhaseDetail.view` is what a reader checks.
 */
export function summaryFiles(files: WorkspaceFile[]): WorkspaceFile[] {
  return files.map((file) => ({
    path: file.path,
    content: '',
    editable: file.editable,
    language: file.language,
    lines: file.content ? file.content.split('\n').length : 0,
    ...(file.editable
      ? { touched: file.content.trim().length > 0 && !/TODO\(learner\)/.test(file.content) }
      : {}),
  }));
}

/** A timestamp is evidence, so a client-supplied one has to parse or be replaced. */
export function stampedAt(value: string | undefined): string {
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/** Characters of a runtime's last line an HTTP message quotes. */
const FAILURE_LINE_MAX = 240;

/** Fields a design operation carried into Maintenance keeps. */
const CARRIED_OPERATION_MAX_KEYS = 20;

/** Characters a carried text field, or a carried list's entry, keeps. */
const CARRIED_TEXT_MAX = 2000;

/** Entries a carried list field keeps. */
const CARRIED_LIST_MAX = 20;

/** Operations carried from a design into Maintenance. */
const CARRIED_OPERATIONS_MAX = 50;

/**
 * The one line of a failure worth putting in an HTTP message: the last line a
 * runtime wrote, which is where a traceback keeps the thing that went wrong.
 */
export function failureLine(text: string | null | undefined): string {
  if (!text) return '';
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return (line || '').slice(0, FAILURE_LINE_MAX);
}

/** The learner's design record is copied forward, not trusted: strings and string lists only. */
function tidyOperation(entry: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, value] of Object.entries(entry)) {
    if (keys >= CARRIED_OPERATION_MAX_KEYS) break;
    if (typeof value === 'string') {
      out[key] = value.slice(0, CARRIED_TEXT_MAX);
      keys += 1;
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[key] = (value as string[]).slice(0, CARRIED_LIST_MAX).map((v) => v.slice(0, CARRIED_TEXT_MAX));
      keys += 1;
    }
  }
  const named = out.name ?? out.signature ?? out.operation;
  return typeof named === 'string' && named.trim() ? out : null;
}

/**
 * The operations a learner declared in `design/design.json`, ready to be
 * carried into the maintenance phase's `design/contracts.json`. Anything that
 * is not an operations list: a truncated file, a half-typed edit, an array of
 * numbers: yields nothing, and the scaffold stands.
 */
export function operationsFromDesign(source: string | undefined | null): Record<string, unknown>[] {
  if (typeof source !== 'string' || !source.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).operations
      : null;
  if (!Array.isArray(list)) return [];
  const operations: Record<string, unknown>[] = [];
  for (const entry of list) {
    if (operations.length >= CARRIED_OPERATIONS_MAX) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const tidy = tidyOperation(entry as Record<string, unknown>);
    if (tidy) operations.push(tidy);
  }
  return operations;
}
