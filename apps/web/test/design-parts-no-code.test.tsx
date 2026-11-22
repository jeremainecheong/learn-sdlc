// @vitest-environment jsdom
/**
 * "Component diagram: Waiting on the modules the
 * Implementation phase writes" for ever.
 *
 * The component diagram is drawn from the modules in the Design phase's own
 * files, and the class diagram's drift from a file there that defines the
 * operations. A Design workspace that holds neither never gets them: the
 * Implementation phase writes its code in its own workspace. So the parts list
 * and the Review tab promised a drawing that never came, before Implementation
 * and long after it passed. They now say what is true in every state; a Design
 * workspace that does hold modules draws them.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_DESIGN } from '@learnsdlc/shared';
import {
  COMPONENTS_NONE_HERE,
  COMPONENTS_NOTHING_TO_DRAW,
  COMPONENTS_NOT_PYTHON,
  COMPONENTS_PYTHON_ONLY,
  DRIFT_NONE_HERE,
  DRIFT_NO_MANAGER,
  DesignParts,
  DrawnSection,
} from '@/components/workspace/panels/design/DesignBoard';
import type { DesignState } from '@/components/workspace/panels/design/useDesign';

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

const design = {
  doc: { ...EMPTY_DESIGN, entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: [], satisfies: [] }] },
  contracts: { api: false, screens: false },
  apiText: undefined,
  screensText: undefined,
} as unknown as DesignState;

/** What a TaskTrackr Design workspace holds: the design record and the contracts, no code. */
const DESIGN_FILES = { 'design/design.json': '{}', 'shared/contract/api.json': '{}' };
/** A pack whose Design phase mounts code, with a manager file that defines the operations. */
const CODE_FILES = { 'app/task_manager.py': 'from app import store\n\ndef add_task(title):\n    return title\n', 'app/store.py': 'import json\n' };

describe('the component diagram and the drift, where the phase holds no code', () => {
  it('the parts list says there is nothing here to draw it from, and promises no modules', async () => {
    await act(async () => root.render(<DesignParts design={design} files={DESIGN_FILES} />));
    const row = q('phase-design-part-component-diagram')!;
    expect(row.textContent).toContain(COMPONENTS_NOTHING_TO_DRAW);
    expect(COMPONENTS_NOTHING_TO_DRAW).toBe('Nothing in this phase to draw it from');
    expect(row.textContent).not.toContain('Waiting on the modules');
  });

  it('the Review tab says the same in a sentence, for the components and for the drift', async () => {
    await act(async () => root.render(<DrawnSection design={design} files={DESIGN_FILES} />));
    const components = q('phase-design-components')!;
    expect(components.textContent).toContain(COMPONENTS_NONE_HERE);
    expect(components.textContent).not.toContain('as soon as they exist');
    expect(host.textContent).toContain(DRIFT_NONE_HERE);
    expect(host.textContent).not.toContain('listed here from then on');
  });

  it('a Design workspace that holds modules draws them and their drift', async () => {
    await act(async () => root.render(<DesignParts design={design} files={CODE_FILES} />));
    expect(q('phase-design-part-component-diagram')!.textContent).toContain('Drawn from the imports');
    await act(async () => root.render(<DrawnSection design={design} files={CODE_FILES} />));
    expect(q('phase-design-components')!.textContent).toContain('app/task_manager.py');
    expect(q('phase-design-components')!.textContent).not.toContain(COMPONENTS_NONE_HERE);
    expect(host.textContent).not.toContain(DRIFT_NONE_HERE);
    expect(q('phase-design-drift-add_task')).not.toBeNull();
  });
});

/*
 * The component diagram reads Python modules only, and the drift reads a manager file only. A
 * Design phase that carries other code (no shipped project does) is not told "this phase holds none" or "no file
 * defines the operations": it is told what the drawing reads. A phase with no code at all keeps the words above.
 */
describe('a Design phase that holds code the drawings do not read', () => {
  /** TypeScript modules, one defining an operation, and a test (left out, as the diagram leaves tests out). */
  const TS_FILES = { ...DESIGN_FILES, 'web/src/lib/overdue.ts': 'export function isOverdue() { return false; }\n', 'web/src/lib/overdue.test.ts': "test('x', () => {});\n" };
  /** A Python module that is not a manager file. */
  const PY_FILES = { ...DESIGN_FILES, 'app/store.py': 'import json\n\ndef save(task):\n    return task\n' };

  it('the words', () => {
    expect(COMPONENTS_PYTHON_ONLY).toBe('Drawn from Python modules only');
    expect(COMPONENTS_NOT_PYTHON).toBe('Drawn from the imports of Python modules. The code in this phase is in another language, so there is nothing to draw.');
    expect(DRIFT_NO_MANAGER).toBe('The diagram is compared with a manager file, such as task_manager.py, and this phase holds none.');
  });

  it('TypeScript code: the parts row and the Review tab say the diagram reads Python, not that the phase holds none', async () => {
    await act(async () => root.render(<DesignParts design={design} files={TS_FILES} />));
    expect(q('phase-design-part-component-diagram')!.textContent).toContain(COMPONENTS_PYTHON_ONLY);
    expect(q('phase-design-part-component-diagram')!.textContent).not.toContain(COMPONENTS_NOTHING_TO_DRAW);
    await act(async () => root.render(<DrawnSection design={design} files={TS_FILES} />));
    expect(q('phase-design-components')!.textContent).toContain(COMPONENTS_NOT_PYTHON);
    expect(host.textContent).not.toContain(COMPONENTS_NONE_HERE);
    expect(host.textContent).toContain(DRIFT_NO_MANAGER);
    expect(host.textContent).not.toContain(DRIFT_NONE_HERE);
  });

  it('a Python module that is not a manager file: drawn, and the drift line names what it compares with', async () => {
    await act(async () => root.render(<DrawnSection design={design} files={PY_FILES} />));
    expect(q('phase-design-components')!.textContent).toContain('app/store.py');
    expect(host.textContent).toContain(DRIFT_NO_MANAGER);
    expect(host.textContent).not.toContain(DRIFT_NONE_HERE);
  });

  it('only a test file of another language is not code here, and the words are those of a phase with none', async () => {
    const files = { ...DESIGN_FILES, 'web/src/lib/overdue.test.ts': "test('x', () => {});\n" };
    await act(async () => root.render(<DesignParts design={design} files={files} />));
    expect(q('phase-design-part-component-diagram')!.textContent).toContain(COMPONENTS_NOTHING_TO_DRAW);
    await act(async () => root.render(<DrawnSection design={design} files={files} />));
    expect(host.textContent).toContain(COMPONENTS_NONE_HERE);
    expect(host.textContent).toContain(DRIFT_NONE_HERE);
  });
});
