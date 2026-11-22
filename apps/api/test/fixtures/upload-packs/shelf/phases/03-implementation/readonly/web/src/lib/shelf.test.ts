/**
 * The front-end cases you can see (SH-1, SH-4).
 *
 * `test` and `assert` are globals the runner provides; `assert` is node's own.
 * The hidden suite adds the edge cases and renders the page itself.
 */

import { Book, shelfLabel, sortForShelf } from './shelf';

declare function test(name: string, fn: () => void | Promise<void>): void;
declare const assert: typeof import('node:assert');

function book(fields: Partial<Book>): Book {
  return { id: 1, title: 'Kindred', author: 'Octavia E. Butler', year: 1979, on_loan_to: null, ...fields };
}

test('a book on the shelf reads title, author and year', () => {
  assert.strictEqual(shelfLabel(book({})), 'Kindred — Octavia E. Butler (1979)');
});

test('the shelf is in title order', () => {
  const sorted = sortForShelf([book({ id: 1, title: 'Station Eleven' }), book({ id: 2, title: 'Kindred' })]);
  assert.deepStrictEqual(
    sorted.map((one) => one.title),
    ['Kindred', 'Station Eleven'],
  );
});
