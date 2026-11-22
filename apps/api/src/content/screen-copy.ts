import type { AcceptedScreenCopy } from '@learnsdlc/shared';
import type { PhaseContent } from './content.types';

export const SCREEN_COPY_PATH = 'shared/contract/accepted-screen-copy.json';
export const SCREEN_CONTRACT_PATH = 'shared/contract/screens.json';

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\u0000');

/** Copy remains ordinary React text, including characters that resemble markup. */
export function validScreenCopy(value: unknown): value is AcceptedScreenCopy {
  if (!value || typeof value !== 'object') return false;
  const row = value as AcceptedScreenCopy;
  return row.version === 1 && text(row.sourceSubmissionId, 100) && text(row.sourcePhaseStateId, 100)
    && text(row.title, 240) && text(row.empty, 2000);
}

export function screenCopyFromSnapshot(
  snapshot: Record<string, string>, sourceSubmissionId: string, sourcePhaseStateId: string,
): AcceptedScreenCopy | null {
  try {
    const record: unknown = JSON.parse(snapshot[SCREEN_CONTRACT_PATH]);
    if (!record || typeof record !== 'object' || !Array.isArray((record as { screens?: unknown }).screens)) return null;
    const rows = (record as { screens: unknown[] }).screens.filter(row =>
      !!row && typeof row === 'object' && (row as { route?: unknown }).route === '#/overdue');
    if (rows.length !== 1) return null;
    const row = rows[0] as { title?: unknown; empty?: unknown };
    const result = { version: 1, sourceSubmissionId, sourcePhaseStateId, title: row.title, empty: row.empty };
    return validScreenCopy(result) ? result : null;
  } catch { return null; }
}

export function screenCopyFile(copy: AcceptedScreenCopy): string {
  if (!validScreenCopy(copy)) throw new Error('The retained Design screen copy is invalid.');
  return JSON.stringify({ ...copy, source: 'accepted-design' }, null, 2) + '\n';
}

/** One immutable file overlay for explorer, app preview, execution and grading. */
export function withScreenCopy(phase: PhaseContent, copy: AcceptedScreenCopy | null | undefined): PhaseContent {
  if (!copy) return phase;
  const declared = phase.files.find(file => file.path === SCREEN_COPY_PATH);
  if (!declared) return phase;
  if (declared.editable) throw new Error('Accepted Design screen copy must be a read-only content file.');
  const content = screenCopyFile(copy);
  const screenContract = phase.files.find(file => file.path === SCREEN_CONTRACT_PATH && !file.editable);
  const overrides: Record<string, string> = { [SCREEN_COPY_PATH]: content };
  if (screenContract) {
    const contract = JSON.parse(screenContract.content);
    overrides[SCREEN_CONTRACT_PATH] = JSON.stringify({ ...contract, screens: contract.screens.map((screen: { route: string }) =>
      screen.route === '#/overdue' ? { ...screen, title: copy.title, empty: copy.empty } : screen) }, null, 2) + '\n';
  }
  const overlay = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([path, text]) => [path, overrides[path] ?? text]));
  const checks = phase.checks;
  return {
    ...phase,
    files: phase.files.map(file => overrides[file.path] !== undefined && !file.editable ? { ...file, content: overrides[file.path] } : file),
    checks: checks.kind === 'code' || checks.kind === 'tests' ? {
      ...checks,
      ...(checks.kind === 'tests' ? { supportFiles: overlay(checks.supportFiles), implFiles: overlay(checks.implFiles) } : {}),
      runs: checks.runs.map(run => ({ ...run, supportFiles: overlay(run.supportFiles), implFiles: overlay(run.implFiles) })),
    } : checks.kind === 'config' ? { ...checks, smokeImplFiles: overlay(checks.smokeImplFiles) } : checks,
  };
}
