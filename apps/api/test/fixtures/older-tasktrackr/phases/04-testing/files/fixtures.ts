/**
 * The fixtures your front-end tests are handed, and the twin of the ones
 * tests/conftest.py hands the API suite.
 *
 * The API suite gets `client`, `make_list` and `make_task` so that a test can
 * say what it is about in one line. This file is the same idea for the DOM: a
 * task with the contract's defaults, and one way to answer the network.
 *
 * It is locked. Read it, import from it, and spend your time on the
 * assertions instead.
 */

import type { Task } from '../api/types';

/**
 * A task carrying the contract's defaults, with whatever you pass overridden.
 *
 * `aTask({ due_date: daysAgo(3) })` is a task that is three days past its due
 * date and ordinary in every other way, so the test names only the one fact it
 * is about.
 */
export function aTask(fields: Partial<Task> = {}): Task {
  return {
    id: 1,
    list_id: 1,
    title: 'Renew the passport',
    priority: 'medium',
    due_date: null,
    status: 'open',
    created_at: '2026-01-05T09:00:00+00:00',
    completed_at: null,
    tags: [],
    comment_count: 0,
    ...fields,
  };
}

/** What the stubbed API answers with: a status, and a body it sends back. */
export interface Answer {
  /** Defaults to 200. Anything outside 2xx is read as a failure by the client. */
  status?: number;
  /** Defaults to an empty list. */
  body?: unknown;
}

/**
 * Answer every request this test makes with one canned response, and collect
 * the URLs that were asked for.
 *
 * There is no server behind a front-end test. Without a stub the harness
 * refuses the call and says so, which is deliberate: a component test that
 * reaches the network is slow, flaky, and testing somebody else's code.
 *
 *     const urls = answerWith({ body: [aTask({ id: 7 })] });
 *     ... render or run the hook ...
 *     assert.ok(urls[0].includes('q=rent'), urls[0]);
 *
 * The array fills in as the requests are made, so read it after the render has
 * settled, not before.
 */
export function answerWith(answer: Answer = {}): string[] {
  const urls: string[] = [];
  const status = answer.status ?? 200;
  const text = JSON.stringify(answer.body ?? []);
  globalThis.fetch = ((input: unknown) => {
    urls.push(String((input as { url?: string })?.url ?? input));
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
    });
  }) as unknown as typeof fetch;
  return urls;
}
