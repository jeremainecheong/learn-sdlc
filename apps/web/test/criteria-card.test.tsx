// @vitest-environment jsdom
/**
 * The Criteria step over a stored rubric that breaks the loader's caps
 * (spec 13 C3). A version stored before the caps bound the export read-back
 * can hold a criterion title over 120 characters, a description over 400 or a
 * fractional pass mark; a draft opened from it names each breach on its
 * Criteria step, above the rows, so the teacher fixes it in the editor and
 * exports.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { screen } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DraftTaskView } from '@learnsdlc/shared';
import { RUBRIC_CRITERION_TITLE_MAX, rubricCapBreaches } from '@learnsdlc/shared';
import { CriteriaCard } from '@/components/staff/projects/requirements/CriteriaCard';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const taskWith = (rubric: DraftTaskView['rubric']) =>
  ({
    taskKey: 'main',
    order: 1,
    title: 'Write SH-4',
    brief: '',
    objectives: [],
    artefactType: 'user-story',
    artefactPath: null,
    checkKind: 'story',
    required: true,
    owns: [],
    authorable: true,
    notice: null,
    rubric,
  }) as unknown as DraftTaskView;

function mount(task: DraftTaskView, editable = true) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <CriteriaCard task={task} writeTask={vi.fn()} editable={editable} state="current" onFocusCard={vi.fn()} onSaved={vi.fn()} />,
    ),
  );
}

describe('the Criteria step over a stored rubric', () => {
  it('the Criteria step names each cap a stored rubric breaks', () => {
    const long = 'T'.repeat(RUBRIC_CRITERION_TITLE_MAX + 20);
    const rubric = {
      passThreshold: 62.5,
      criteria: [
        { key: 'scope', title: long, description: 'd', weight: 0.5 },
        { key: 'clarity', title: 'Clear', description: 'd', weight: 0.5 },
      ],
    };
    const breaches = rubricCapBreaches(rubric);
    expect(breaches).toHaveLength(2);
    mount(taskWith(rubric));
    const lines = screen.getAllByRole('alert').map((one) => one.textContent);
    expect(lines).toEqual(breaches);
    expect([...host!.querySelectorAll('[data-testid="tre-criteria-cap"]')].map((one) => one.textContent)).toEqual(breaches);
    expect(lines[1]).toBe(`the rubric title of "scope" is 140 characters; the editor saves at most ${RUBRIC_CRITERION_TITLE_MAX}`);
    // the lines sit above the rows
    const list = screen.getByRole('list', { name: 'Criteria' });
    for (const line of screen.getAllByRole('alert')) {
      expect(line.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('names the breach on a read-only card too, and draws nothing for a rubric inside the caps', () => {
    mount(taskWith({ passThreshold: 70, criteria: [{ key: 'scope', title: 'T'.repeat(RUBRIC_CRITERION_TITLE_MAX + 1), description: 'd', weight: 1 }] }), false);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    act(() => root!.unmount());
    root = null;
    host?.remove();
    mount(taskWith({ passThreshold: 70, criteria: [{ key: 'scope', title: 'Scope', description: 'd', weight: 1 }] }));
    expect(screen.queryAllByRole('alert')).toEqual([]);
  });
});
