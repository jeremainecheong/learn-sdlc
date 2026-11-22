/**
 * The overdue report (US-4): its own page, and it sends the day.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { OverduePage } from './OverduePage';
import screenCopy from '../../../shared/contract/accepted-screen-copy.json';
import type { Task } from '../api/types';

function task(fields: Partial<Task>): Task {
  return {
    id: 1,
    list_id: 1,
    title: 'Renew the passport',
    priority: 'medium',
    due_date: null,
    status: 'open',
    created_at: '2026-03-01T09:00:00+00:00',
    completed_at: null,
    tags: [],
    comment_count: 0,
    ...fields,
  };
}

function stubFetch(answer: { status: number; body?: unknown }): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return Promise.resolve({
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: () => Promise.resolve(JSON.stringify(answer.body ?? [])),
    });
  }) as unknown as typeof fetch;
  return urls;
}

test('the report asks the API for a day rather than letting it guess', async () => {
  cleanup();
  const urls = stubFetch({ status: 200, body: [] });
  render(<MemoryRouter><OverduePage /></MemoryRouter>);
  await waitFor(() => assert.ok(screen.queryByTestId('overdue-empty')));
  assert.match(urls[0], /^api\/tasks\/overdue\?today=\d{4}-\d{2}-\d{2}$/);
});

test('late tasks are listed and counted', async () => {
  cleanup();
  const today = new Date().toISOString().slice(0, 10);
  stubFetch({
    status: 200,
    body: [task({ id: 1, due_date: '2020-01-01' }), task({ id: 2, title: 'Pay the rent', due_date: '2020-01-02' })],
  });
  render(<MemoryRouter><OverduePage /></MemoryRouter>);
  await waitFor(() => assert.strictEqual(screen.getAllByTestId('task-row').length, 2));
  assert.match(screen.getByTestId('overdue-summary').textContent || '', /^2 tasks are late/);
  assert.strictEqual(screen.getAllByTestId('overdue-badge').length, 2);
  assert.match(screen.getByTestId('overdue-asof').textContent || '', new RegExp(today));
});

test('a failed request says so instead of claiming nothing is late', async () => {
  cleanup();
  stubFetch({ status: 500, body: { error: { code: 'unexpected_error', message: 'The database is gone.' } } });
  render(<MemoryRouter><OverduePage /></MemoryRouter>);
  await waitFor(() => assert.ok(screen.queryByTestId('overdue-error')));
  assert.strictEqual(screen.getByTestId('overdue-error').textContent, 'The database is gone.');
  assert.strictEqual(screen.queryByTestId('overdue-empty'), null);
});


test('every overdue row shows its actual source list beside its title and lateness', async () => {
  cleanup();
  stubFetch({ status: 200, body: [task({ id: 11, list_id: 7, due_date: '2020-01-01' }), task({ id: 12, list_id: 42, title: 'Pay the rent', due_date: '2020-01-02' })] });
  render(<MemoryRouter><OverduePage /></MemoryRouter>);
  await waitFor(() => assert.strictEqual(screen.getAllByTestId('task-row').length, 2));
  const rows = screen.getAllByTestId('task-row');
  assert.strictEqual(within(rows[0]).getByRole('link', { name: 'List 7' }).getAttribute('href'), '/lists/7');
  assert.strictEqual(within(rows[1]).getByRole('link', { name: 'List 42' }).getAttribute('href'), '/lists/42');
  assert.strictEqual(within(rows[0]).getByTestId('task-title').textContent, 'Renew the passport');
  assert.match(within(rows[0]).getByTestId('overdue-badge').textContent || '', /^\d+ days late$/);
});


test('the report renders the supplied screen-contract copy as ordinary text', async () => {
  cleanup();
  stubFetch({ status: 200, body: [] });
  render(<MemoryRouter><OverduePage /></MemoryRouter>);
  await waitFor(() => assert.ok(screen.queryByTestId('overdue-empty')));
  assert.strictEqual(screen.getByRole('heading', { level: 1 }).textContent, screenCopy.title);
  assert.strictEqual(screen.getByTestId('overdue-empty').textContent, screenCopy.empty);
  assert.strictEqual(screen.getByTestId('overdue-empty').childElementCount, 0);
});
