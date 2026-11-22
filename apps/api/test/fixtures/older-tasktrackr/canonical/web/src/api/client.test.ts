/**
 * The client: where the request goes, and what a refusal turns into.
 */

import { ApiError, apiBase, getJson, postJson } from './client';

interface Sent {
  url: string;
  method: string;
  body?: string;
}

function stubFetch(answer: { status: number; body?: unknown }): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    sent.push({ url: String(url), method: init.method || 'GET', body: init.body as string });
    return Promise.resolve({
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: () => Promise.resolve(answer.body === undefined ? '' : JSON.stringify(answer.body)),
    });
  }) as unknown as typeof fetch;
  return sent;
}

test('the base path is relative, so a <base href> can move the whole app', () => {
  assert.strictEqual(apiBase(), 'api');
});

test('a query drops the parameters that were not set', async () => {
  const sent = stubFetch({ status: 200, body: [] });
  await getJson('lists/2/tasks', { status: 'open', q: undefined, tag: '' });
  assert.strictEqual(sent[0].url, 'api/lists/2/tasks?status=open');
});

test('a post sends JSON and keeps the body it was given', async () => {
  const sent = stubFetch({ status: 201, body: { id: 7 } });
  const made = await postJson<{ id: number }>('lists', { name: 'Errands' });
  assert.strictEqual(sent[0].method, 'POST');
  assert.strictEqual(sent[0].body, '{"name":"Errands"}');
  assert.strictEqual(made.id, 7);
});

test('a refusal becomes an ApiError carrying the contract code', async () => {
  stubFetch({ status: 404, body: { error: { code: 'task_not_found', message: 'No task has id 99.' } } });
  try {
    await getJson('tasks/99');
    assert.fail('the client should have thrown');
  } catch (failure) {
    assert.ok(failure instanceof ApiError);
    assert.strictEqual((failure as ApiError).code, 'task_not_found');
    assert.strictEqual((failure as ApiError).status, 404);
    assert.strictEqual((failure as ApiError).message, 'No task has id 99.');
  }
});

test('a 204 answers with nothing rather than failing to parse nothing', async () => {
  stubFetch({ status: 204 });
  assert.strictEqual(await getJson('tasks/1'), undefined);
});
