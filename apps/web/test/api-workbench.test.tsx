// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiWorkbench } from '@/components/workspace/panels/design/ApiWorkbench';
let root: Root; let host: HTMLDivElement;
const setFile = vi.fn();
const pendingDraft = vi.fn();
const contract = { version: '2.0.0', entities: { tasks: { fields: [{ name: 'id', type: 'integer' }] } }, operations: [{ id: 'completeTask', method: 'POST', path: '/api/tasks/{id}/complete', success: {}, errors: [] }, { id: 'listTasks', method: 'GET', path: '/api/lists/{id}/tasks', success: { status: 200 }, errors: [] }], errors: {} };
function SavedWorkbench() {
 const [files, setFiles] = useState({ 'shared/contract/api.json': JSON.stringify(contract) });
 return <ApiWorkbench files={files} onPendingDraftChange={pendingDraft} setFile={(path, source) => { setFile(path, source); setFiles(previous => ({ ...previous, [path]: source })); }} />;
}
const button = (text: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === text)!;
const change = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => { fireEvent.change(element, { target: { value: value } }); });
beforeEach(() => { setFile.mockClear(); pendingDraft.mockClear(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root.render(<SavedWorkbench />)); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe('API contract authoring', () => {
 it('keeps focus and the scrolled section navigation when opening a contract section', () => {
  const sections = host.querySelector<HTMLDivElement>('[aria-label="Contract sections"]')!;
  const example = button('Example');
  sections.scrollLeft = 120;
  act(() => { example.focus(); example.click(); });
  expect(document.activeElement).toBe(example);
  expect(button('Example').getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('[aria-label="Contract sections"]')?.scrollLeft).toBe(120);
  expect(host.querySelector('textarea[aria-label="Authored response example (JSON)"]')).not.toBeNull();
  act(() => host.querySelectorAll<HTMLButtonElement>('.design-collection button')[1].click());
  expect(host.querySelector('[aria-label="Contract sections"]')?.scrollLeft).toBe(120);
  expect(setFile).not.toHaveBeenCalled();
 });
 it('accepts a status typed one digit at a time and preserves the rest of the contract', () => {
  const status = host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
  change(status, '2'); expect(status.value).toBe('2'); expect(setFile).not.toHaveBeenCalled();
  change(status, '20'); change(status, '200'); act(() => fireEvent.focusOut(status));
  const [path, source] = setFile.mock.calls[0];
  expect(path).toBe('shared/contract/api.json');
  const saved = JSON.parse(source);
  expect(saved.operations[0].success.status).toBe(200);
  expect(saved.entities).toEqual(contract.entities);
  expect(saved.operations[1]).toEqual(contract.operations[1]);
 });
 it('retains invalid JSON in the field without overwriting the persisted contract', () => {
  act(() => button('Body').click());
  const field = host.querySelector<HTMLTextAreaElement>('textarea')!;
  change(field, '{ incomplete'); act(() => fireEvent.focusOut(field));
  expect(setFile).not.toHaveBeenCalled();
  expect(field.value).toBe('{ incomplete');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('has not been saved');
  change(field, '{"title":"string"}'); act(() => fireEvent.focusOut(field));
  expect(JSON.parse(setFile.mock.calls[0][1]).operations[0].body).toEqual({ title: 'string' });
 });
 it('rejects an out-of-range HTTP status instead of converting it to a successful response', () => {
  const status = host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
  change(status, '999'); act(() => fireEvent.focusOut(status));
  expect(setFile).not.toHaveBeenCalled();
  expect(status.value).toBe('999');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('100 to 599');
 });
 it('preserves an invalid body and its error across sections and operation changes, then commits the corrected draft only to its operation', () => {
  act(() => button('Body').click());
  const body = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Request body contract (JSON)"]')!;
  change(body(), '{ incomplete'); act(() => fireEvent.focusOut(body()));
  expect(pendingDraft).toHaveBeenLastCalledWith(true);
  act(() => button('Contract').click());
  act(() => host.querySelectorAll<HTMLButtonElement>('.design-collection button')[1].click());
  act(() => button('Body').click());
  expect(body().value).toBe('{}');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  change(body(), '{"listOnly":true}'); act(() => fireEvent.focusOut(body()));
  expect(pendingDraft).toHaveBeenLastCalledWith(true);
  act(() => host.querySelectorAll<HTMLButtonElement>('.design-collection button')[0].click());
  expect(body().value).toBe('{ incomplete');
  expect(body().getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(body().getAttribute('aria-describedby')!)?.textContent).toContain('has not been saved');
  change(body(), '{"completeOnly":true}'); act(() => fireEvent.focusOut(body()));
  const saved = JSON.parse(setFile.mock.calls.at(-1)![1]);
  expect(saved.operations[0].body).toEqual({ completeOnly: true });
  expect(saved.operations[1].body).toEqual({ listOnly: true });
  expect(saved.entities).toEqual(contract.entities);
  expect(body().getAttribute('aria-invalid')).toBe('false');
  expect(pendingDraft).toHaveBeenLastCalledWith(false);
  expect(setFile).toHaveBeenCalledTimes(2);
 });
 it('keeps an invalid status separate from another operation and recovers after a correction', () => {
  const status = () => host.querySelector<HTMLInputElement>('input[aria-label="Success status"]')!;
  change(status(), '20'); act(() => fireEvent.focusOut(status()));
  act(() => button('Params').click()); act(() => button('Contract').click());
  expect(status().value).toBe('20');
  act(() => host.querySelectorAll<HTMLButtonElement>('.design-collection button')[1].click());
  expect(status().value).toBe('200'); expect(status().getAttribute('aria-invalid')).toBe('false');
  act(() => host.querySelectorAll<HTMLButtonElement>('.design-collection button')[0].click());
  expect(status().value).toBe('20'); expect(status().getAttribute('aria-invalid')).toBe('true');
  expect(setFile).not.toHaveBeenCalled();
  change(status(), '204'); act(() => fireEvent.focusOut(status()));
  expect(JSON.parse(setFile.mock.calls[0][1]).operations[0].success.status).toBe(204);
  expect(host.querySelector('[role="alert"]')).toBeNull();
 });
 it('preserves a shared catalogue draft across operations without giving other fields the same draft', () => {
  act(() => button('Errors').click());
  const shared = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Shared error"]')!;
  change(shared(), '{ invalid catalogue'); act(() => fireEvent.focusOut(shared()));
  act(() => host.querySelectorAll<HTMLButtonElement>('.design-collection button')[1].click());
  expect(shared().value).toBe('{ invalid catalogue');
  expect(shared().getAttribute('aria-invalid')).toBe('true');
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Error codes"]')?.value).toBe('[]');
  expect(setFile).not.toHaveBeenCalled();
 });
 it('does not write a contract merely because a learner focused and left an unchanged field', () => {
  act(() => fireEvent.focusOut(host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!));
  act(() => button('Body').click());
  act(() => fireEvent.focusOut(host.querySelector<HTMLTextAreaElement>('textarea')!));
  expect(setFile).not.toHaveBeenCalled();
 });

});
