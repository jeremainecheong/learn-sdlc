// @vitest-environment jsdom
/**
 * The seal path the upload control offers. The seal door refuses a hidden
 * test at a one-segment path, because the export files such a test under
 * `tests/` and could never write it back where the loader reads it. So the
 * upload control must not fill the path with the chosen file's bare name, or
 * the default way to seal a hidden test is refused. It offers the path the
 * door accepts: the learner's own test file when the name is one of them (a
 * tests task's reference suite replaces it), and `tests/<name>` otherwise. A
 * path the teacher typed, and every other role, are left untouched.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutableTaskView, SealedRoleKind } from '@learnsdlc/shared';

import { SealedUpload } from '@/components/staff/projects/SealedUpload';
import { ExecutableEditor } from '@/components/staff/projects/ExecutableEditor';
import { typeInto } from './support/dom';

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

async function choose(id: string, name: string) {
  const input = byId(id) as HTMLInputElement;
  expect(input, `no file control ${id}`).not.toBeNull();
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], name)] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function type(id: string, value: string) {
  const node = byId(id) as HTMLInputElement;
  await act(async () => {
    typeInto(node, value);
  });
}

const pathOf = (group: string) => (byId(`sealed-${group}-path`) as HTMLInputElement).value;

function upload(role: SealedRoleKind, learnerFiles?: string[]) {
  return (
    <SealedUpload
      group="g"
      role={role}
      runId={role === 'hidden' ? 'r' : null}
      label="Add a file"
      hint="A file."
      learnerFiles={learnerFiles}
      onWrite={vi.fn()}
      onWritten={vi.fn()}
    />
  );
}

describe('the seal control offers a hidden test the path the door accepts', () => {
  it('a hidden test chosen by its bare name is offered under tests/', async () => {
    await render(upload('hidden'));
    await choose('sealed-g-file', 'test_extra.py');
    expect(pathOf('g')).toBe('tests/test_extra.py');
  });

  it('a reference suite named like a learner test file is offered that file', async () => {
    await render(upload('hidden', ['test_shelf.py', 'tests/test_loans.py']));
    await choose('sealed-g-file', 'test_shelf.py');
    expect(pathOf('g')).toBe('test_shelf.py');
  });

  it('a reference suite whose name matches a learner test file in a folder is offered that path', async () => {
    await render(upload('hidden', ['tests/test_loans.py']));
    await choose('sealed-g-file', 'test_loans.py');
    expect(pathOf('g')).toBe('tests/test_loans.py');
  });

  it('the path field says a hidden test sits under a folder', async () => {
    await render(upload('hidden'));
    expect(host?.textContent).toContain('A hidden test sits under a folder, such as tests/.');
  });

  it('in the editor, a code task\'s hidden test is offered tests/<name> and a tests task\'s learner file stays its own path', async () => {
    const code: ExecutableTaskView = {
      taskKey: 'main',
      checkKind: 'code',
      artefactType: 'code',
      owns: ['api/app.py'],
      profile: 'baked',
      runs: [{ id: 'api', shape: 'run-python-hidden', label: 'API tests', testPaths: ['tests/'], visibleTests: [], learnerTestFiles: [], hidden: [] }],
      minTests: null,
      coverageKeywords: [],
      solution: [],
      mutants: [],
      sandboxBudget: 2,
    };
    await render(
      <ExecutableEditor
        phaseKey="implementation"
        phaseTitle="Implementation"
        task={{ taskKey: 'main', title: 'Build it' }}
        executable={code}
        onSave={vi.fn()}
        onWriteSealed={vi.fn()}
      />,
    );
    await choose('sealed-hidden-api-file', 'test_more.py');
    expect(pathOf('hidden-api')).toBe('tests/test_more.py');

    const tests: ExecutableTaskView = {
      ...code,
      checkKind: 'tests',
      artefactType: 'tests',
      owns: ['test_shelf.py'],
      runs: [{ id: 'shelf', shape: 'run-python', label: 'Shelf tests', testPaths: ['tests/'], visibleTests: [], learnerTestFiles: ['test_shelf.py'], hidden: [] }],
      minTests: 4,
    };
    await act(async () => root?.unmount());
    root = createRoot(host as HTMLDivElement);
    await render(
      <ExecutableEditor
        phaseKey="testing"
        phaseTitle="Testing"
        task={{ taskKey: 'main', title: 'Test it' }}
        executable={tests}
        onSave={vi.fn()}
        onWriteSealed={vi.fn()}
      />,
    );
    await choose('sealed-hidden-shelf-file', 'test_shelf.py');
    expect(pathOf('hidden-shelf')).toBe('test_shelf.py');
    expect(host?.textContent).toContain(
      "A reference test sits under a folder, such as tests/, unless it is one of the learner's test files.",
    );
  });

  it('a path the teacher typed first is kept', async () => {
    await render(upload('hidden'));
    await type('sealed-g-path', 'checks/test_mine.py');
    await choose('sealed-g-file', 'test_extra.py');
    expect(pathOf('g')).toBe('checks/test_mine.py');
  });

  it('a solution and a mutant are offered the bare name', async () => {
    await render(upload('solution'));
    await choose('sealed-g-file', 'app.py');
    expect(pathOf('g')).toBe('app.py');
    await act(async () => root?.unmount());
    root = createRoot(host as HTMLDivElement);
    await render(upload('mutant'));
    await choose('sealed-g-file', 'shelf.py');
    expect(pathOf('g')).toBe('shelf.py');
  });

  it('the hint on any other role is unchanged', async () => {
    await render(upload('solution'));
    expect(host?.textContent).toContain("Relative to the task's folder for this role, with forward slashes.");
    expect(host?.textContent).not.toContain('A hidden test sits under a folder');
  });
});
