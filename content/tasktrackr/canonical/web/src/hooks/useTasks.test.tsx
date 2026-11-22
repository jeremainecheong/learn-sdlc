/**
 * The hook that asks the API for a filtered list (US-3).
 *
 * The two things worth proving are that the filters reach the URL and that a
 * failed request reaches the screen. A hook that swallows a 500 and hands back
 * an empty array renders "nothing here matches those filters", which is a lie.
 */

import { cleanup, renderHook, waitFor } from '@testing-library/react';

import { queryFor, useTasks } from './useTasks';
import { NO_FILTERS } from '../api/types';

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

test('only the filters that are set become query parameters', () => {
  assert.deepStrictEqual(queryFor(NO_FILTERS), {});
  assert.deepStrictEqual(queryFor({ status: 'open', q: '  rent ', tag: 'home' }), {
    status: 'open',
    q: 'rent',
    tag: 'home',
  });
});

test('the search box reaches the request', async () => {
  cleanup();
  const urls = stubFetch({ status: 200, body: [] });
  const { result } = renderHook(() => useTasks(2, { status: 'open', q: 'rent', tag: '' }));
  await waitFor(() => assert.strictEqual(result.current.loading, false));
  assert.strictEqual(urls.length, 1);
  assert.ok(urls[0].includes('q=rent'), `q was not sent: ${urls[0]}`);
  assert.ok(urls[0].includes('status=open'), `status was not sent: ${urls[0]}`);
  assert.ok(!urls[0].includes('tag='), `an empty tag was sent: ${urls[0]}`);
});

test('a failed request becomes an error, not an empty list', async () => {
  cleanup();
  stubFetch({ status: 500, body: { error: { code: 'unexpected_error', message: 'The database is gone.' } } });
  const { result } = renderHook(() => useTasks(2, NO_FILTERS));
  await waitFor(() => assert.strictEqual(result.current.loading, false));
  assert.strictEqual(result.current.error, 'The database is gone.');
  assert.deepStrictEqual(result.current.tasks, []);
});

test('with no list chosen the hook asks for nothing', async () => {
  cleanup();
  const urls = stubFetch({ status: 200, body: [] });
  const { result } = renderHook(() => useTasks(null, NO_FILTERS));
  await waitFor(() => assert.strictEqual(result.current.loading, false));
  assert.deepStrictEqual(urls, []);
  assert.deepStrictEqual(result.current.tasks, []);
});
