// @vitest-environment jsdom
/**
 * The class dates panel reads a class's dates once, and a 404 settles it.
 *
 * The page around the panel draws its projects' phase lists afresh on every
 * render, so a panel that read the dates again whenever the list was a new
 * array would ask `GET /instructor/cohorts/:id/schedule` hundreds of times in
 * a couple of seconds on a page that re-renders often (here: every 10 ms,
 * over a fake-timer window).
 *
 * - A 404 is fetched at most once and settles to the empty table.
 * - A 200 is not read again when the same phases arrive as a new array.
 * - Another class is read when the teacher picks it (guard: the read is keyed
 *   on what it is about, not on nothing).
 */
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CohortScheduleView, PhaseKey } from '@learnsdlc/shared';

const mine = vi.fn();
const schedule = vi.fn();
const saveSchedule = vi.fn();

vi.mock('@/lib/api-cohorts', () => ({
  cohortsApi: { mine: (...a: unknown[]) => mine(...a) },
}));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: {
    schedule: (...a: unknown[]) => schedule(...a),
    saveSchedule: (...a: unknown[]) => saveSchedule(...a),
  },
}));

import { ApiError } from '@/lib/api';
import { SchedulePanel } from '@/components/staff/SchedulePanel';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  mine.mockReset();
  schedule.mockReset();
  saveSchedule.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

/** The page around the panel: it re-renders every 10 ms and draws the phase list afresh each time. */
function BusyPage() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 10);
    return () => clearInterval(timer);
  }, []);
  const phases: { key: PhaseKey; title: string }[] = [
    { key: 'implementation', title: 'Implementation' },
    { key: 'deployment', title: 'Deployment' },
  ];
  return (
    <div data-tick={tick}>
      <SchedulePanel projectSlug="books-on-a-shelf" phases={phases} preferCohortId="c1" />
    </div>
  );
}

/** Two seconds of the page, with every promise the panel started given its turn. */
async function window2s() {
  for (let i = 0; i < 200; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(10);
      await Promise.resolve();
    });
  }
}

describe('the class dates panel and its reads', () => {
  it('a 404 is fetched at most once over the window, and settles to the empty table', async () => {
    mine.mockResolvedValue([{ id: 'c1', name: 'First class' }]);
    schedule.mockRejectedValue(new ApiError(404, 'Not Found'));
    await act(async () => root?.render(<BusyPage />));
    await window2s();
    expect(schedule.mock.calls.length).toBeLessThanOrEqual(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(byId('schedule-loading')).toBeNull();
    expect((byId('schedule-table') as HTMLTableElement).hidden).toBe(false);
    expect(byId('schedule-cleared')?.textContent).toContain('No dates set for First class');
    expect(byId('schedule-opens-implementation')).not.toBeNull();
  });

  it('a 200 is not read again when the same phases arrive as a new array', async () => {
    mine.mockResolvedValue([{ id: 'c1', name: 'First class' }]);
    const view: CohortScheduleView = { cohortId: 'c1', projectSlug: 'books-on-a-shelf', phases: [], timezone: null };
    schedule.mockResolvedValue(view);
    await act(async () => root?.render(<BusyPage />));
    await window2s();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(byId('schedule-cleared')).not.toBeNull();
  });

  it('picking another class reads that class once', async () => {
    mine.mockResolvedValue([
      { id: 'c1', name: 'First class' },
      { id: 'c2', name: 'Second class' },
    ]);
    schedule.mockRejectedValue(new ApiError(404, 'Not Found'));
    await act(async () => root?.render(<BusyPage />));
    await window2s();
    expect(schedule).toHaveBeenCalledTimes(1);
    const picker = byId('schedule-cohort') as HTMLSelectElement;
    await act(async () => {
      picker.value = 'c2';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await window2s();
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule.mock.calls[1][0]).toBe('c2');
  });

  // A save that lands is the class answering, so its old 404 is not kept.
  it('a saved class is read again after a 404, not drawn from the settled 404', async () => {
    mine.mockResolvedValue([
      { id: 'c1', name: 'First class' },
      { id: 'c2', name: 'Second class' },
    ]);
    schedule.mockRejectedValue(new ApiError(404, 'Not Found'));
    const view: CohortScheduleView = { cohortId: 'c1', projectSlug: 'books-on-a-shelf', phases: [], timezone: null };
    saveSchedule.mockResolvedValue(view);
    await act(async () => root?.render(<BusyPage />));
    await window2s();
    expect(byId('schedule-error')).not.toBeNull();
    await act(async () => (byId('schedule-save') as HTMLButtonElement).click());
    await window2s();
    expect(saveSchedule).toHaveBeenCalledTimes(1);
    expect(byId('schedule-error')).toBeNull();
    schedule.mockResolvedValue(view);
    const picker = byId('schedule-cohort') as HTMLSelectElement;
    const pick = async (id: string) => {
      await act(async () => {
        picker.value = id;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await window2s();
    };
    await pick('c2');
    await pick('c1');
    expect(schedule.mock.calls.map((call) => call[0])).toEqual(['c1', 'c2', 'c1']);
    expect(byId('schedule-error')).toBeNull();
  });
});
