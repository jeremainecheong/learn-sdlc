// @vitest-environment jsdom
/**
 * The Maintenance brief's "<ticket> asks for <operation> in <file>" line is
 * drawn only when the change request names an operation, so it never reads
 * "CR-2 asks for CR-2 in <file>".
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest, type PhaseDetail } from '@learnsdlc/shared';
import MaintenanceBrief from '@/components/workspace/panels/maintenance/Brief';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null; });

const TICKET = { id: 'CR-2', title: 'Comments on tasks', summary: 'Tasks carry comments.', acceptance: [{ id: 'AC-1', line: 'A task lists its comments.' }] };
function render(operations: string[]) {
  const record = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, impact: { operations, screens: [], files: ['api/app.py'] } });
  const props = {
    detail: {
      id: 'p-maintenance', key: 'maintenance', title: 'Maintenance', order: 6, projectSlug: 'tasktrackr', lastSubmission: null,
      change: { ticket: TICKET, contract: false, floor: { minImpact: 0, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false } },
      files: [
        { path: CHANGE_REQUEST_JSON, content: record, editable: true, language: 'json' },
        { path: 'api/app.py', content: '', editable: true, language: 'python' },
      ],
    } as unknown as PhaseDetail,
    files: {},
    submission: null,
    enrollment: null,
    helpers: { openFile: vi.fn(), setTab: vi.fn(), setPane: vi.fn(), fileText: () => '' },
  } as unknown as PhasePanelProps;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root!.render(<MaintenanceBrief {...props} />));
  return host;
}

describe('the Maintenance brief\'s target line', () => {
  it('names the operation and the file when the change request names an operation', () => {
    expect(render(['addComment']).textContent).toContain('CR-2 asks for addComment in api/app.py.');
  });
  it('is not drawn when the change request names a file but no operation', () => {
    const text = render([]).textContent ?? '';
    expect(text).not.toContain('asks for');
    expect(text).toContain('CR-2');
  });
});
