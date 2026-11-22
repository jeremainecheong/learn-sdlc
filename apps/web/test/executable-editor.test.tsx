// @vitest-environment jsdom
/**
 * The executable editor for a phase's sole work task.
 *
 * Its one promise above all the others: **a sealed file is written, never
 * shown.** A hidden test, the reference solution and a mutant leave the
 * browser as base64 in one `sealed.write` body, and what comes back (and what
 * is drawn, ever after) is a path, a sha256 and a size. Even a server that
 * answered with the bytes could not get them onto the page: the row is drawn
 * from those three fields alone.
 *
 * Beside it: the smoke check and the drill are read-only, the budget ceiling
 * names the phase and the count, the Files tab says in one sentence that a
 * reference solution may be mounted read-only, and the accessibility
 * criteria (fieldset, labels, aria-describedby).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoringFileView, ExecutableTaskView, SealedFileView } from '@learnsdlc/shared';
import { BUDGET_CEILING, budgetCeilingRefusal } from '@learnsdlc/shared';

// The executable editor.
import { ExecutableEditor } from '@/components/staff/projects/ExecutableEditor';
import {
  ExecutableSummary,
  SMOKE_DRILL_READ_ONLY,
  SmokeDrillReadOnly,
} from '@/components/staff/projects/ExecutableTask';
import { BudgetCeiling } from '@/components/staff/projects/BudgetCeiling';
import { ProjectFiles, SOLUTION_MOUNT_SENTENCE } from '@/components/staff/projects/ProjectFiles';
import { settle } from './support/dom';

const MARKER = 'HIDDEN-BYTES-MARKER-91c2';

const CODE: ExecutableTaskView = {
  taskKey: 'main',
  checkKind: 'code',
  artefactType: 'code',
  owns: ['api/app.py', 'api/db.py'],
  profile: 'baked',
  runs: [
    {
      id: 'api',
      shape: 'run-python-hidden',
      label: 'API tests',
      testPaths: ['tests/'],
      visibleTests: ['tests/test_api.py'],
      learnerTestFiles: [],
      hidden: [{ path: 'test_hidden_api.py', sha256: 'b'.repeat(64), bytes: 120 }],
    },
  ],
  minTests: null,
  coverageKeywords: [],
  solution: [{ path: 'api/app.py', sha256: 'c'.repeat(64), bytes: 300 }],
  mutants: [],
  sandboxBudget: 2,
};

const TESTS: ExecutableTaskView = {
  taskKey: 'main',
  checkKind: 'tests',
  artefactType: 'tests',
  owns: ['tests/test_shelf.py'],
  profile: 'baked',
  runs: [
    {
      id: 'shelf',
      shape: 'run-python',
      label: 'Shelf tests',
      testPaths: ['tests/'],
      visibleTests: [],
      learnerTestFiles: ['tests/test_shelf.py'],
      hidden: [],
    },
  ],
  minTests: 4,
  coverageKeywords: ['borrow', 'return'],
  solution: [],
  mutants: [{ path: 'off-by-one/shelf.py', sha256: 'e'.repeat(64), bytes: 410 }],
  sandboxBudget: 7,
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function render(node: React.ReactNode) {
  await act(async () => {
    root?.render(node);
  });
}

async function click(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    (el as HTMLButtonElement).click();
  });
}

function type(el: HTMLElement | null, value: string) {
  const node = el as HTMLInputElement | HTMLTextAreaElement;
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}

async function choose(id: string, file: File) {
  const input = byId(id) as HTMLInputElement;
  expect(input, `no file control ${id}`).not.toBeNull();
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}


describe('the sealed display, read-only (never cut)', () => {
  it('the read-only summary shows digests and no control at all', async () => {
    await render(<ExecutableSummary phaseTitle="Implementation" executable={CODE} />);
    expect(host?.textContent).toContain('b'.repeat(64));
    expect(host?.querySelectorAll('input, textarea, select').length).toBe(0);
  });

  it('smoke/drill are read-only', async () => {
    await render(<SmokeDrillReadOnly phaseTitle="Deployment" />);
    // They change only by a new upload, and the sentence says so.
    expect(SMOKE_DRILL_READ_ONLY).toMatch(/upload/i);
    expect(byId('smoke-drill-read-only')?.textContent).toContain(SMOKE_DRILL_READ_ONLY);
    expect(host?.querySelectorAll('input, textarea, select, button').length).toBe(0);
  });
});

describe('the budget ceiling', () => {
  it('names the phase and the count when a phase is over', async () => {
    await render(<BudgetCeiling phases={[{ title: 'Testing', microVMs: 11 }]} />);
    expect(byId('budget-ceiling-refusal-0')?.textContent).toBe(budgetCeilingRefusal(11, 'Testing'));
  });

  it('names the version and its count when the version is over', async () => {
    await render(
      <BudgetCeiling
        phases={[
          { title: 'Implementation', microVMs: 10 },
          { title: 'Testing', microVMs: 10 },
          { title: 'Maintenance', microVMs: 5 },
        ]}
      />,
    );
    expect(host?.textContent).toContain(budgetCeilingRefusal(25, null));
    expect(host?.querySelectorAll('[data-testid^="budget-ceiling-refusal-"]').length).toBe(1);
  });

  it('says what fits, against the ceiling, when nothing is over', async () => {
    await render(<BudgetCeiling phases={[{ title: 'Implementation', microVMs: 4 }]} />);
    expect(host?.querySelectorAll('[data-testid^="budget-ceiling-refusal-"]').length).toBe(0);
    expect(byId('budget-ceiling-line')?.textContent).toContain(`${BUDGET_CEILING.perVersion}`);
  });
});

describe('the Files tab', () => {
  it('says once that a reference solution may be mounted read-only', async () => {
    const rows: AuthoringFileView[] = [
      { id: 'f-1', path: 'api/app.py', role: 'workspace', size: 10, content: 'x = 1', phaseKey: null } as unknown as AuthoringFileView,
    ];
    await render(<ProjectFiles rows={rows} />);
    expect(SOLUTION_MOUNT_SENTENCE).toBe(
      'Your reference solution may also appear as a locked file a learner reads, such as the finished code a later phase builds on; it is never a file a learner is asked to edit.',
    );
    expect(byId('project-files-solution-mount')?.textContent).toBe(SOLUTION_MOUNT_SENTENCE);
  });
});

/* ================ the executable editor ================ */

function editor(view: ExecutableTaskView, over: Partial<Parameters<typeof ExecutableEditor>[0]> = {}) {
  return (
    <ExecutableEditor
      phaseKey={view.checkKind === 'code' ? 'implementation' : 'testing'}
      phaseTitle={view.checkKind === 'code' ? 'Implementation' : 'Testing'}
      task={{ taskKey: 'main', title: 'Build the shelf API' }}
      executable={view}
      onSave={vi.fn()}
      onWriteSealed={vi.fn()}
      {...over}
    />
  );
}

describe('the executable editor: the seal', () => {
  it('draws each sealed file as its path, digest and size', async () => {
    await render(editor(CODE));
    const row = byId('sealed-hidden-api-row-0');
    expect(row?.textContent).toContain('test_hidden_api.py');
    expect(row?.textContent).toContain('b'.repeat(64));
    expect(row?.textContent).toContain('120 bytes');
    expect(byId('sealed-solution-row-0')?.textContent).toContain('c'.repeat(64));
  });

  it('hidden bytes are never rendered after upload; only the digest', async () => {
    const view: SealedFileView = { path: 'test_more.py', sha256: 'd'.repeat(64), bytes: 26 };
    // A server that misbehaves and answers with the bytes as well.
    const onWriteSealed = vi.fn().mockResolvedValue({ ...view, content: MARKER, contentBase64: btoa(MARKER) });
    await render(editor(CODE, { onWriteSealed }));
    await choose('sealed-hidden-api-file', new File([MARKER], 'test_more.py', { type: 'text/x-python' }));
    type(byId('sealed-hidden-api-path'), 'test_more.py');
    await click('sealed-hidden-api-upload');
    await settle(6);
    expect(onWriteSealed).toHaveBeenCalledTimes(1);
    expect(onWriteSealed.mock.calls[0][0]).toEqual({
      role: 'hidden',
      runId: 'api',
      path: 'test_more.py',
      contentBase64: btoa(MARKER),
    });
    const rows = host?.querySelectorAll('[data-testid^="sealed-hidden-api-row-"]') ?? [];
    expect([...rows].map((r) => r.textContent).join(' ')).toContain('d'.repeat(64));
    expect(host?.innerHTML).not.toContain(MARKER);
    expect(host?.innerHTML).not.toContain(btoa(MARKER));
    // No control keeps the bytes either.
    for (const input of [...(host?.querySelectorAll('input, textarea') ?? [])] as HTMLInputElement[]) {
      expect(input.value ?? '').not.toContain(MARKER);
    }
  });

  it('writes a code task solution with no run, and says the refusal it gets back', async () => {
    const onWriteSealed = vi.fn().mockRejectedValue(new Error('This draft is not yours to change.'));
    await render(editor(CODE, { onWriteSealed }));
    await choose('sealed-solution-file', new File(['print(1)'], 'app.py'));
    type(byId('sealed-solution-path'), 'api/app.py');
    await click('sealed-solution-upload');
    await settle(6);
    expect(onWriteSealed.mock.calls[0][0]).toMatchObject({ role: 'solution', runId: null, path: 'api/app.py' });
    expect(byId('sealed-solution-error')?.textContent).toBe('This draft is not yours to change.');
  });
});

describe('the executable editor: what it edits', () => {
  // The starter files are the upload's (`editedExecutableSlice` refuses a
  // changed `owns`), so they are not typed or sent; the runs are. The brief is
  // the builder's Brief step's (spec 5.3), so the editor has no field for it.
  it('saves the runs of a code task, and has no brief field', async () => {
    const onSave = vi.fn();
    await render(editor(CODE, { onSave }));
    expect(byId('exec-brief')).toBeNull();
    type(byId('exec-run-api-visible'), 'tests/test_api.py\ntests/test_more.py');
    await click('exec-save');
    expect(onSave).toHaveBeenCalledWith({
      runs: [
        {
          id: 'api',
          shape: 'run-python-hidden',
          label: 'API tests',
          testPaths: ['tests/'],
          visibleTests: ['tests/test_api.py', 'tests/test_more.py'],
          learnerTestFiles: [],
        },
      ],
    });
  });

  // The API keeps the coverage keywords
  // grouped by criterion and refuses any change to them, so only minTests is edited.
  it('edits minTests of a tests task', async () => {
    const onSave = vi.fn();
    await render(editor(TESTS, { onSave }));
    type(byId('exec-min-tests'), '6');
    await click('exec-save');
    expect(onSave.mock.calls[0][0]).toMatchObject({ minTests: 6 });
  });

  /* ----- editability as the API answers it (draft.ts editedExecutableSlice) ----- */

  const controlsIn = (id: string) => byId(id)?.querySelectorAll('input, textarea, select').length ?? -1;

  it('owns, a run’s shape and learnerTestFiles are shown read-only', async () => {
    await render(editor(TESTS));
    // owns: listed, no control.
    expect(controlsIn('exec-owns')).toBe(0);
    expect(byId('exec-owns')?.tagName).not.toMatch(/^(TEXTAREA|INPUT|SELECT)$/);
    expect(byId('exec-owns')?.textContent).toContain('tests/test_shelf.py');
    // the run's shape: named, no picker.
    expect(byId('exec-run-shelf-shape')?.tagName).not.toMatch(/^(TEXTAREA|INPUT|SELECT)$/);
    expect(controlsIn('exec-run-shelf-shape')).toBe(0);
    expect(byId('exec-run-shelf-shape')?.textContent).toContain('run-python');
    // the learner's own test files: listed, no control.
    expect(byId('exec-run-shelf-learner')?.tagName).not.toMatch(/^(TEXTAREA|INPUT|SELECT)$/);
    expect(controlsIn('exec-run-shelf-learner')).toBe(0);
    expect(byId('exec-run-shelf-learner')?.textContent).toContain('tests/test_shelf.py');
    // the coverage keywords: listed, no control.
    expect(byId('exec-coverage')?.tagName).not.toMatch(/^(TEXTAREA|INPUT|SELECT)$/);
    expect(byId('exec-coverage')?.textContent).toContain('borrow');
    // and each says why: they change by uploading the project again.
    expect(byId('exec-editor')?.textContent).toMatch(/upload/i);
    // what stays editable is still a control
    expect((byId('exec-run-shelf-label') as HTMLInputElement | null)?.tagName).toBe('INPUT');
    expect((byId('exec-run-shelf-paths') as HTMLTextAreaElement | null)?.tagName).toBe('TEXTAREA');
    expect((byId('exec-min-tests') as HTMLInputElement | null)?.tagName).toBe('INPUT');
  });

  it('the save body carries only members the API accepts', async () => {
    const onCode = vi.fn();
    await render(editor(CODE, { onSave: onCode }));
    await click('exec-save');
    const code = onCode.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(code).sort()).toEqual(['runs']);
    // A run is sent whole, as the contract types it, with its shape and its
    // learner files exactly as the API answered them.
    expect(code.runs).toEqual([
      {
        id: 'api',
        shape: CODE.runs[0].shape,
        label: 'API tests',
        testPaths: ['tests/'],
        visibleTests: ['tests/test_api.py'],
        learnerTestFiles: CODE.runs[0].learnerTestFiles,
      },
    ]);

    act(() => root?.unmount());
    root = createRoot(host as HTMLDivElement);
    const onTests = vi.fn();
    await render(editor(TESTS, { onSave: onTests }));
    await click('exec-save');
    const tests = onTests.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(tests).sort()).toEqual(['minTests', 'runs']);
    expect(tests.runs).toEqual([
      {
        id: 'shelf',
        shape: TESTS.runs[0].shape,
        label: 'Shelf tests',
        testPaths: ['tests/'],
        visibleTests: [],
        learnerTestFiles: TESTS.runs[0].learnerTestFiles,
      },
    ]);
  });

  // A word two criteria share is listed twice,
  // a cut-off path keeps its full text, and the run shape has a name.
  it('read-only lists keep repeats and full paths, and the run shape is labelled', async () => {
    const long = `tests/${'deeply/'.repeat(12)}test_shelf.py`;
    const repeated: ExecutableTaskView = {
      ...TESTS,
      coverageKeywords: ['borrow', 'return', 'borrow'],
      runs: [{ ...TESTS.runs[0], learnerTestFiles: [long] }],
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await render(editor(repeated));
    const words = [...(byId('exec-coverage')?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(words).toEqual(['borrow', 'return', 'borrow']);
    expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
    expect(byId('exec-run-shelf-learner')?.querySelector('li')?.getAttribute('title')).toBe(long);
    const shape = byId('exec-run-shelf-shape');
    const label = document.getElementById(shape?.getAttribute('aria-labelledby') ?? '');
    expect(label?.textContent).toBe('Run shape');
  });

  it('refuses a minTests that is not a whole number above zero, before saving', async () => {
    const onSave = vi.fn();
    await render(editor(TESTS, { onSave }));
    type(byId('exec-min-tests'), '0');
    await click('exec-save');
    expect(onSave).not.toHaveBeenCalled();
    expect(byId('exec-own-error')?.textContent).toMatch(/^[A-Z]/);
  });

  // The API accepts 1 to 500 (draft.ts, authoring.dto.ts @Max(500)).
  it('refuses a minTests above 500 before saving, and the hint names the bound', async () => {
    const onSave = vi.fn();
    await render(editor(TESTS, { onSave }));
    const field = byId('exec-min-tests');
    const hint = document.getElementById(field?.getAttribute('aria-describedby')?.split(/\s+/)[0] ?? '');
    expect(hint?.textContent).toContain('from 1 to 500');
    type(field, '600');
    await click('exec-save');
    expect(onSave).not.toHaveBeenCalled();
    expect(byId('exec-own-error')?.textContent).toContain('from 1 to 500');
  });

  it('accepts 500 exactly', async () => {
    const onSave = vi.fn();
    await render(editor(TESTS, { onSave }));
    type(byId('exec-min-tests'), '500');
    await click('exec-save');
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ minTests: 500 }));
  });

  // A long path wraps in full (no CSS truncate), and the run-shape group
  // is described by the hint that says why it is read-only.
  it('a long read-only path wraps instead of truncating, and the run shape group is described by its hint', async () => {
    const long = `tests/${'deeply/'.repeat(12)}test_shelf.py`;
    await render(editor({ ...TESTS, runs: [{ ...TESTS.runs[0], learnerTestFiles: [long] }] }));
    const item = byId('exec-run-shelf-learner')?.querySelector('li');
    expect(item?.textContent).toBe(long);
    expect(item?.className).not.toMatch(/\btruncate\b/);
    expect(item?.className).toMatch(/\bbreak-all\b/);
    const shape = byId('exec-run-shelf-shape');
    const described = document.getElementById(shape?.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toContain('Set when the project is uploaded.');
  });

  // The same wrap for a sealed file's row and the summary's lists.
  it('a long sealed path and a long summary path wrap in full instead of truncating', async () => {
    const long = `api/${'deeply/'.repeat(12)}test_hidden_api.py`;
    const shaped: ExecutableTaskView = {
      ...CODE,
      owns: [long],
      runs: [{ ...CODE.runs[0], hidden: [{ path: long, sha256: 'b'.repeat(64), bytes: 120 }] }],
    };
    await render(editor(shaped));
    const sealed = [...(byId(`sealed-hidden-${CODE.runs[0].id}-row-0`)?.querySelectorAll('span') ?? [])].find(
      (one) => one.textContent === long,
    );
    expect(sealed).toBeDefined();
    expect(sealed?.className).not.toMatch(/\btruncate\b/);
    expect(sealed?.className).toMatch(/\bbreak-all\b/);
    await render(<ExecutableSummary phaseTitle="Implementation" executable={shaped} />);
    const owned = [...(byId('exec-summary')?.querySelectorAll('li') ?? [])].find((one) => one.textContent === long);
    expect(owned).toBeDefined();
    expect(owned?.className).not.toMatch(/\btruncate\b/);
    expect(owned?.className).toMatch(/\bbreak-all\b/);
  });

  it('offers no smoke or drill control in the executable editor', async () => {
    await render(editor(CODE));
    const labels = [...(host?.querySelectorAll('label, legend') ?? [])].map((l) => l.textContent ?? '');
    expect(labels.filter((l) => /smoke|drill/i.test(l))).toEqual([]);
  });
});

describe('the executable editor: labelled form groups', () => {
  it('groups its controls in fieldsets with legends, labels every control, and describes each file control', async () => {
    await render(editor(TESTS));
    const root = byId('exec-editor');
    expect(root?.querySelectorAll('fieldset').length).toBeGreaterThan(2);
    for (const fs of [...(root?.querySelectorAll('fieldset') ?? [])]) {
      expect(fs.querySelector(':scope > legend')?.textContent?.trim()).toBeTruthy();
    }
    for (const control of [...(root?.querySelectorAll('input, select, textarea') ?? [])]) {
      const id = control.getAttribute('id');
      expect(id).toBeTruthy();
      expect(root?.querySelector(`label[for="${id}"]`), `no label for ${id}`).not.toBeNull();
    }
    for (const file of [...(root?.querySelectorAll('input[type="file"]') ?? [])]) {
      const ids = (file.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
    }
  });
});

/* ============ mutants in the editor ============ */

describe('the executable editor: mutants', () => {
  it('draws mutants as digests and writes a new one through the seal', async () => {
    const onWriteSealed = vi.fn().mockResolvedValue({ path: 'swap/shelf.py', sha256: 'f'.repeat(64), bytes: 33 });
    await render(editor(TESTS, { onWriteSealed }));
    expect(byId('sealed-mutant-row-0')?.textContent).toContain('e'.repeat(64));
    await choose('sealed-mutant-file', new File([MARKER], 'shelf.py'));
    type(byId('sealed-mutant-path'), 'swap/shelf.py');
    await click('sealed-mutant-upload');
    await settle(6);
    expect(onWriteSealed.mock.calls[0][0]).toMatchObject({ role: 'mutant', runId: null, path: 'swap/shelf.py' });
    expect(host?.innerHTML).not.toContain(MARKER);
    expect(host?.textContent).toContain('f'.repeat(64));
  });

  it('offers no mutant section on a code task', async () => {
    await render(editor(CODE));
    expect(byId('sealed-mutant-file')).toBeNull();
  });
});
