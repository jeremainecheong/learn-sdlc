// @vitest-environment jsdom
/**
 * Dates for this class, before and after it knows them.
 *
 * Drawing "No dates set for this class", an empty table and a live Save
 * button while the classes are still being listed would make the first paint
 * read as an answer. A reader who acted on it (an instructor, or a test
 * looking for the class picker) would be reading a page that had not loaded yet.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CohortScheduleView } from '@learnsdlc/shared';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const classes = deferred<{ id: string; name: string }[]>();
const dates = deferred<CohortScheduleView>();

vi.mock('@/lib/api-cohorts', () => ({
  cohortsApi: { mine: () => classes.promise },
}));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: { schedule: () => dates.promise, saveSchedule: vi.fn() },
}));

import { SchedulePanel } from '@/components/staff/SchedulePanel';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('SchedulePanel', () => {
  it('says it is loading until the dates are in, and only then draws the table and the picker', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <SchedulePanel projectSlug="tasktrackr" phases={[{ key: 'deployment', title: 'Deployment' }]} />,
      );
    });

    // Nothing has answered: no verdict, no picker, no way to save.
    expect(byId('schedule-loading')?.textContent).toContain('Loading the dates');
    expect(byId('schedule-cleared')).toBeNull();
    expect(byId('schedule-cohort')).toBeNull();
    expect((byId('schedule-table') as HTMLTableElement).hidden).toBe(true);
    expect((byId('schedule-save') as HTMLButtonElement).disabled).toBe(true);

    // The classes are listed, but this class's dates are still on their way.
    await act(async () => {
      classes.resolve([
        { id: 'c1', name: 'First class' },
        { id: 'c2', name: 'Second class' },
      ]);
    });
    expect(byId('schedule-cohort')).not.toBeNull();
    expect(byId('schedule-loading')).not.toBeNull();
    expect(byId('schedule-cleared')).toBeNull();
    expect((byId('schedule-table') as HTMLTableElement).hidden).toBe(true);

    await act(async () => {
      dates.resolve({ cohortId: 'c2', projectSlug: 'tasktrackr', phases: [], timezone: null });
    });
    expect(byId('schedule-loading')).toBeNull();
    expect(byId('schedule-cleared')?.textContent).toContain('No dates set for Second class');
    expect((byId('schedule-table') as HTMLTableElement).hidden).toBe(false);
    expect(byId('schedule-opens-deployment')).not.toBeNull();
    expect((byId('schedule-save') as HTMLButtonElement).disabled).toBe(false);

    // The class select and its label may shrink inside the section's right slot on a phone (WCAG 1.4.10).
    const select = byId('schedule-cohort')!;
    for (const box of [select, select.closest('label')!]) {
      expect(box.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
    }
  });
});
