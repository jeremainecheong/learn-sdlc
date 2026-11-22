// @vitest-environment jsdom
/**
 * The file tree, which is the one place in the authoring surface where a
 * mistake leaks the material that grades learners.
 *
 * Two rules, and the second is the one worth a test rather than a comment.
 *
 * **A role is not a control.** A row's role is set when the row is created and
 * never updated, so the tree shows no role picker at all rather than a
 * disabled one. There is nothing to disable.
 *
 * **The seal is the page's, not only the API's.** The authoring API is written
 * to send `content: null` for every row `isAuthoringReadableRole` refuses. This
 * page does not take that on trust: it decides what to draw from the row's
 * **role**, so a server that one day sends the bytes of a hidden suite still
 * cannot get them onto a teacher's screen.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthoringFileView } from '@learnsdlc/shared';
import { CANONICAL_FILE_NOTICE, SEALED_FILE_NOTICE } from '@learnsdlc/shared';

import { ProjectFiles } from '@/components/staff/projects/ProjectFiles';

function file(over: Partial<AuthoringFileView> = {}): AuthoringFileView {
  return {
    id: 'f-1',
    ownerKind: 'phase',
    phaseKey: 'implementation',
    path: 'api/routes/tasks.py',
    role: 'workspace',
    editable: true,
    language: 'python',
    size: 1240,
    sealed: false,
    content: 'def complete_task():\n    pass\n',
    notice: null,
    ...over,
  };
}

const HIDDEN = file({
  id: 'f-2',
  path: 'tests/hidden/test_tasks.py',
  role: 'hidden',
  editable: false,
  size: 4096,
  sealed: true,
  content: null,
  notice: SEALED_FILE_NOTICE,
});

const CANONICAL = file({
  id: 'f-3',
  path: 'canonical/app.py',
  role: 'canonical',
  editable: false,
  size: 495616,
  sealed: true,
  content: null,
  notice: CANONICAL_FILE_NOTICE,
});

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
const text = () => host?.textContent ?? '';

async function mount(rows: AuthoringFileView[]) {
  await act(async () => {
    root?.render(<ProjectFiles rows={rows} />);
  });
}

describe('the authoring file tree', () => {
  it('shows every row its path, its role and its size', async () => {
    await mount([file(), HIDDEN, CANONICAL]);
    expect(byId('project-file-f-2')?.textContent).toContain('tests/hidden/test_tasks.py');
    expect(byId('project-file-f-2')?.textContent).toContain('hidden');
    expect(byId('project-file-f-2')?.textContent).toContain('4');
  });

  it('draws no role control at all, because a role is set when a row is created', async () => {
    await mount([file(), HIDDEN, CANONICAL]);
    expect(host?.querySelector('select')).toBeNull();
    expect(host?.querySelector('[name="role"]')).toBeNull();
    expect(host?.querySelectorAll('button[disabled]').length).toBe(0);
  });

  it('says why a sealed row is withheld, and a canonical one, in their own sentences', async () => {
    await mount([file(), HIDDEN, CANONICAL]);
    expect(byId('project-file-notice-f-2')?.textContent).toBe(SEALED_FILE_NOTICE);
    expect(byId('project-file-notice-f-3')?.textContent).toBe(CANONICAL_FILE_NOTICE);
    expect(byId('project-file-notice-f-1')).toBeNull();
  });

  it('shows the bytes of a workspace row and of nothing else', async () => {
    await mount([file(), HIDDEN, CANONICAL]);
    await act(async () => {
      (byId('project-file-open-f-1') as HTMLButtonElement).click();
    });
    expect(byId('project-file-content-f-1')?.textContent).toContain('complete_task');
    expect(byId('project-file-open-f-2')).toBeNull();
    expect(byId('project-file-open-f-3')).toBeNull();
  });

  it('refuses the bytes of a sealed row even when the server sends them', async () => {
    const leaked = { ...HIDDEN, sealed: false, content: 'assert overdue_report() == 3\n' };
    await mount([leaked]);
    expect(text()).not.toContain('overdue_report');
    expect(byId('project-file-open-f-2')).toBeNull();
    expect(byId('project-file-content-f-2')).toBeNull();
    // And it is still marked for what it is, rather than quietly dropped.
    expect(byId('project-file-notice-f-2')?.textContent).toBe(SEALED_FILE_NOTICE);
  });
});
