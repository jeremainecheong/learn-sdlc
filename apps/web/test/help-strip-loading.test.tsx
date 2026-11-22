// @vitest-environment jsdom
/**
 * On My classes the help strip read its requests after the page drew, showing the
 * whole card ("A learner is asking you", "Requests for help", a sentence, "Loading help requests…"), and then, with no
 * request open, shrank to its one row "No open help requests": everything under it moved up 124 px. The first read
 * now draws that same one row, so the common answer moves nothing; when requests are waiting the strip grows into the
 * card, as it must; a failed read draws the card with its error.
 *
 * jsdom has no layout, so the height is pinned by its two causes: the loading row and the empty row are the same
 * elements in the same order with one line each, and every rule of StuckList.css that shapes the empty row shapes
 * the loading row too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StuckItem } from '@learnsdlc/shared';
import { StuckList } from '@/components/staff/StuckList';

const calls = vi.hoisted(() => ({ stuckList: vi.fn(), answerStuck: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ mentorApi: calls }));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/session')>(),
  useSession: () => ({ id: 'teacher-a', role: 'INSTRUCTOR' }),
  getSession: () => ({ id: 'teacher-a', role: 'INSTRUCTOR' }),
}));

const request: StuckItem = {
  userId: 'one', phaseStateId: 'phase-one', displayName: 'Learner one', email: 'one@example.test', projectSlug: 'deadline',
  phaseKey: 'testing', phaseTitle: 'Testing', question: 'Which date is today in the tests?', tried: '',
  raisedAt: '2026-11-18T00:00:00Z', answeredAt: null, answeredByName: null, answer: null,
};
let root: Root;
let host: HTMLDivElement;
let answer: (rows: StuckItem[]) => void;
let fail: (err: Error) => void;
const strip = () => host.querySelector<HTMLElement>('[data-testid="stuck-list"]')!;
/** The strip's own children, by tag, in order: what decides its height when each holds one line. */
const shape = () => [...strip().children].map((child) => child.tagName);
beforeEach(() => {
  calls.stuckList.mockReset().mockImplementation(() => new Promise<StuckItem[]>((yes, no) => { answer = yes; fail = no; }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = async () => { await act(async () => root.render(<StuckList onInspect={vi.fn()} />)); };

describe('the help strip keeps its one row while its first read is out', () => {
  it('the first read draws the one row of "No open help requests", saying it is loading; the answer with none open keeps that shape', async () => {
    await render();
    const loading = strip();
    expect(loading.classList.contains('teacher-help-loading')).toBe(true);
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.querySelector('[role="status"]')?.textContent).toBe('Loading help requests…');
    expect(loading.querySelector('h2')?.textContent).toBe('Requests for help');
    expect(loading.textContent).not.toContain('A learner is asking you');
    expect(loading.querySelector('.exp-section-heading')).toBeNull();
    expect(host.querySelector('[data-testid="stuck-refresh"]')).not.toBeNull();
    const before = shape();
    expect(before).toEqual(['H2', 'P', 'BUTTON']);
    await act(async () => answer([]));
    expect(strip().classList.contains('teacher-help-empty')).toBe(true);
    expect(host.querySelector('[data-testid="stuck-empty"]')?.textContent).toBe('No open help requests');
    expect(shape()).toEqual(before);
  });

  it('the loading row says nothing a reader takes for an answer (no "stuck-empty", no count, no empty class)', async () => {
    await render();
    expect(host.querySelector('[data-testid="stuck-empty"]')).toBeNull();
    expect(strip().classList.contains('teacher-help-empty')).toBe(false);
    expect(strip().textContent).not.toContain('No open help requests');
    expect(strip().textContent).not.toContain('waiting for your reply');
  });

  it('every rule of StuckList.css that shapes the empty row shapes the loading row the same', () => {
    const css = readFileSync(path.join(__dirname, '..', 'components', 'staff', 'StuckList.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selectors, body]) => ({ selectors: selectors.split(',').map((s) => s.trim()), body }));
    const empty = rules.filter((rule) => rule.selectors.some((s) => s.includes('teacher-help-empty')));
    expect(empty.length).toBe(3);
    for (const rule of empty) {
      for (const selector of rule.selectors.filter((s) => s.includes('teacher-help-empty'))) {
        expect(rule.selectors).toContain(selector.replace('teacher-help-empty', 'teacher-help-loading'));
      }
    }
  });

  it('with a request open the strip grows into the card with its row', async () => {
    await render();
    await act(async () => answer([request]));
    expect(strip().classList.contains('teacher-help-loading')).toBe(false);
    expect(strip().textContent).toContain('A learner is asking you');
    expect(strip().textContent).toContain('1 waiting for your reply');
    expect(host.querySelector('[data-testid="stuck-row-one"]')).not.toBeNull();
  });

  it('a first read that fails draws the card with its error', async () => {
    await render();
    await act(async () => fail(new Error('Offline')));
    expect(strip().classList.contains('teacher-help-loading')).toBe(false);
    expect(host.querySelector('[data-testid="stuck-list-error"]')).not.toBeNull();
    expect(strip().textContent).toContain('Help request status is unavailable.');
  });
});
