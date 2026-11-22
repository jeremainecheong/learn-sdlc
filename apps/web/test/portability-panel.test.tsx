// @vitest-environment jsdom
/**
 * What the dry run tells a teacher it would write (teacher-authored projects).
 *
 * An import cannot be undone, so the strip of counts under the learner list is
 * the teacher's last look at the file before it becomes rows. The import
 * writes an eighth collection (the `task_states` rows a v3 file carries) and
 * a strip that names five of the six things an import writes is a strip that
 * reads as a complete answer while being an incomplete one.
 *
 * `@/lib/api-portability` is mocked rather than `@/lib/api`: the file never
 * reaches a disk here, so the panel is driven with the document a reader would
 * have parsed and the result the API would have answered.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CohortExportDocument, CohortImportResult } from '@learnsdlc/shared';

const calls = vi.hoisted(() => ({ importCohort: vi.fn() }));

vi.mock('@/lib/api-cohorts', () => ({
  cohortsApi: { mine: () => Promise.resolve([{ id: 'class-one', name: 'First class' }]) },
  formatJoinCode: (code: string) => code,
}));
vi.mock('@/lib/api-instructor', () => ({ saveBlob: vi.fn() }));
vi.mock('@/lib/api-portability', () => ({
  describeBytes: (bytes: number) => `${bytes} bytes`,
  portabilityApi: { exportCohort: vi.fn(), importCohort: calls.importCohort },
  readExportFile: () => Promise.resolve({ document: exported }),
}));

import { PortabilityPanel } from '@/components/staff/PortabilityPanel';
import { writePresentationView } from '@/components/experience/presentation-view';

const exported = { format: 'learnsdlc.cohort', formatVersion: 3 } as CohortExportDocument;

const result = (over: Partial<CohortImportResult> = {}): CohortImportResult => ({
  applied: false,
  cohort: null,
  source: { host: 'the other laptop', exportedAt: '2026-09-18T09:00:00Z', name: 'First class' },
  includes: [],
  learners: [
    {
      email: 'ada@example.edu',
      displayName: 'Ada',
      outcome: 'matched',
      note: null,
      skippedProjects: [],
    },
  ],
  written: {
    learners: 1,
    enrollments: 2,
    phaseStates: 12,
    submissions: 31,
    messages: 4,
    releases: 5,
    auditEvents: 60,
    taskStates: 17,
  },
  createdAccounts: [],
  alreadyImportedAt: null,
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

/** The strip of counts, read back as the label/value pairs a teacher sees. */
function written(): Record<string, string> {
  const strip = byId('import-written');
  const pairs: Record<string, string> = {};
  for (const label of strip?.querySelectorAll('span.label-sm') ?? []) {
    pairs[label.textContent ?? ''] = label.nextElementSibling?.textContent ?? '';
  }
  return pairs;
}

async function preview(answer: CohortImportResult) {
  calls.importCohort.mockResolvedValue(answer);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<PortabilityPanel />);
  });
  await act(async () => {
    fireEvent.change(byId('import-file') as HTMLInputElement, {
      target: { files: [new File(['{}'], 'first-class.json', { type: 'application/json' })] },
    });
  });
  await act(async () => {
    (byId('import-preview') as HTMLButtonElement).click();
  });
}

describe('PortabilityPanel, the dry run', () => {
  it('names the task rows it would write beside the other collections', async () => {
    await preview(result());

    expect(byId('import-preview-list')).not.toBeNull();
    expect(written()).toEqual({
      Enrolments: '2',
      Phases: '12',
      Tasks: '17',
      Revisions: '31',
      'Mentor messages': '4',
      Releases: '5',
    });
  });

  it('says none rather than nothing when the file carries no task rows', async () => {
    // A version-2 file: `CohortExportCounts.taskStates` is optional and a file
    // written before task rows existed has none. A blank cell would read as a question.
    const older = result();
    delete (older.written as { taskStates?: number }).taskStates;
    await preview(older);

    expect(written().Tasks).toBe('0');
  });
});

describe('PortabilityPanel, Presentation view', () => {
  afterEach(() => {
    act(() => writePresentationView(false));
  });

  const imported = (over: Partial<CohortImportResult> = {}) =>
    result({
      applied: true,
      cohort: { id: 'class-new', name: 'First class', joinCode: 'JOIN9999', memberCount: 2 } as CohortImportResult['cohort'],
      createdAccounts: ['grace@example.edu'],
      ...over,
    });

  async function importNow(answer: CohortImportResult) {
    calls.importCohort.mockResolvedValue(answer);
    await act(async () => {
      (byId('import-run') as HTMLButtonElement).click();
    });
  }

  it('shows every address and the join code while it is off', async () => {
    await preview(result());
    expect(byId('import-preview-list')?.textContent).toContain('ada@example.edu');
    await importNow(imported());
    expect(byId('import-result')?.textContent).toContain('JOIN9999');
    expect(byId('import-created-accounts')?.textContent).toContain('grace@example.edu');
  });

  it("hides the preview's addresses, the created accounts and the join code, and keeps the names", async () => {
    await preview(result());
    await act(async () => writePresentationView(true));
    const list = byId('import-preview-list')!;
    expect(list.textContent).not.toContain('ada@example.edu');
    expect(list.textContent).toContain('Ada');
    await importNow(imported());
    const done = byId('import-result')!;
    expect(done.textContent).not.toContain('JOIN9999');
    expect(done.textContent).toContain('The join code is on the class page.');
    expect(done.textContent).toMatch(/\b1 account\b/);
    expect(byId('import-created-accounts')).toBeNull();
    expect(host?.textContent).not.toContain('grace@example.edu');
    // Turning it off brings them back: a drawing choice, nothing was changed.
    await act(async () => writePresentationView(false));
    expect(byId('import-result')?.textContent).toContain('JOIN9999');
    expect(byId('import-created-accounts')?.textContent).toContain('grace@example.edu');
  });
});

describe('PortabilityPanel, the import notice', () => {
  const imported = (createdAccounts: string[]) =>
    result({
      applied: true,
      cohort: { id: 'class-new', name: 'First class', joinCode: 'JOIN9999', memberCount: 2 } as CohortImportResult['cohort'],
      createdAccounts,
    });

  async function importNow(answer: CohortImportResult) {
    await preview(result());
    calls.importCohort.mockResolvedValue(answer);
    await act(async () => {
      (byId('import-run') as HTMLButtonElement).click();
    });
  }

  it('says one account was created and needs a password, in the singular', async () => {
    await importNow(imported(['grace@example.edu']));
    const done = byId('import-result')?.textContent ?? '';
    expect(done).toContain('1 account was created and needs a password.');
    expect(done).not.toContain('were created');
  });

  it('says the accounts were created and need a password when there are several', async () => {
    await importNow(imported(['grace@example.edu', 'alan@example.edu']));
    expect(byId('import-result')?.textContent).toContain('2 accounts were created and need a password.');
  });

  it('says no new account was needed when every learner already had one, and keeps the join code', async () => {
    await importNow(imported([]));
    const done = byId('import-result')?.textContent ?? '';
    expect(done).toContain('2 learners are in it; no new account was needed. The join code is JOIN9999.');
    expect(done).not.toMatch(/\b0 accounts?\b/);
    expect(done).not.toContain('password');
    expect(byId('import-created-accounts')).toBeNull();
  });
});

describe('PortabilityPanel on a phone', () => {
  it('lets the export button wrap the class name inside its label rather than past the panel\'s edge', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<PortabilityPanel />);
    });
    const button = byId('export-cohort')!;
    expect(button.textContent).toContain('Export First class');
    expect(button.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-w-full', '!whitespace-normal']));
  });
});
