import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';

import { router } from './router';

test('hash navigation keeps the list parameter, report URL and unknown-page recovery', async () => {
  cleanup();
  const originalFetch = globalThis.fetch;
  const originalHash = window.location.hash;
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    assert.strictEqual(init?.method, 'GET');
    requests.push(url);
    const body = url === 'api/lists'
      ? [{ id: 7, name: 'Home', task_count: 0, open_count: 0 }]
      : [];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
  }) as typeof fetch;
  try {
    await router.navigate('/');
    render(<RouterProvider router={router} />);
    const listLink = await screen.findByRole('link', { name: 'Home' });
    assert.strictEqual(listLink.getAttribute('href'), '#/lists/7');
    fireEvent.click(listLink);
    await screen.findByTestId('tasks-empty');
    assert.strictEqual(window.location.hash, '#/lists/7');
    assert.ok(requests.some((url) => /^api\/lists\/7\/tasks(?:\?|$)/.test(url)));

    fireEvent.click(screen.getByTestId('nav-overdue'));
    await screen.findByTestId('overdue-empty');
    assert.strictEqual(window.location.hash, '#/overdue');
    assert.ok(requests.some((url) => /^api\/tasks\/overdue\?today=\d{4}-\d{2}-\d{2}$/.test(url)));

    window.location.hash = '#/missing/deep-link';
    await screen.findByTestId('not-found');
    fireEvent.click(screen.getByRole('link', { name: 'Back to your lists' }));
    await screen.findByRole('link', { name: 'Home' });
    await waitFor(() => assert.strictEqual(window.location.hash, '#/'));
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    window.history.replaceState(null, '', window.location.pathname + window.location.search + originalHash);
  }
});
