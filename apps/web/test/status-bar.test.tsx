// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getByRole } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { StatusBar } from '@/components/shell/ide';

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('keeps complete long metadata keyboard-accessible separately from the save result', () => {
  act(() => root.render(<StatusBar branch="feature/a-long-branch-name" live={false} language="TypeScript" line={123456} col={987654} problems={123} hidden="Hidden 37 of 100" clock="clock 2026-09-15" saveState="Not saved" savedAt="23:59" />));
  const metadata = getByRole(host, 'region', { name: 'Workspace status details' });
  expect(metadata.tabIndex).toBe(0); metadata.focus(); expect(document.activeElement).toBe(metadata);
  for (const fact of ['feature/a-long-branch-name', 'Live updates paused', 'TypeScript', 'Ln 123456, Col 987654', '123 problems', 'Hidden 37 of 100', 'clock 2026-09-15']) expect(metadata.textContent).toContain(fact);
  const fixed = host.querySelector('[data-testid="status-save-group"]')!;
  expect(metadata.contains(fixed)).toBe(false);
  expect(fixed.querySelector('[data-testid="save-state"]')?.textContent).toBe('Not saved');
  expect(fixed.querySelector('[data-testid="save-time"]')?.textContent).toBe('23:59');
  expect(metadata.textContent).not.toContain('Not saved');
});

it('retains metadata focus and DOM while the acknowledged save status changes', () => {
  act(() => root.render(<StatusBar language="Python 3.11" line={9} col={200} saveState="Saving…" savedAt="14:52" />));
  const metadata = getByRole(host, 'region', { name: 'Workspace status details' });
  metadata.focus(); metadata.scrollLeft = 110;
  const state = host.querySelector('[data-testid="save-state"]');
  act(() => root.render(<StatusBar language="Python 3.11" line={9} col={201} saveState="Saved" savedAt="14:54" />));
  expect(getByRole(host, 'region', { name: 'Workspace status details' })).toBe(metadata);
  expect(metadata.scrollLeft).toBe(110); expect(document.activeElement).toBe(metadata);
  expect(host.querySelector('[data-testid="save-state"]')).toBe(state);
  expect(state?.textContent).toBe('Saved'); expect(host.querySelector('[data-testid="save-time"]')?.textContent).toBe('14:54');
});

it('does not reserve a phantom save group for read-only callers with no save facts', () => {
  act(() => root.render(<StatusBar branch="review" language="SQL" saveState="" />));
  expect(host.querySelector('[data-testid="status-save-group"]')).toBeNull();
  expect(getByRole(host, 'region', { name: 'Workspace status details' }).textContent).toContain('reviewSQL');
});
