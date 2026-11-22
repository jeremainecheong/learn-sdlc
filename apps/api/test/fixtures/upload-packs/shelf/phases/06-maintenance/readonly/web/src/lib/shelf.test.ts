/**
 * The front-end regression cases you can see for change request CHG-1.
 *
 * The page shows the shelf in the order the API does, so the front end moves
 * to surname order too. The label is unchanged, and this file says so.
 */

import { Book, shelfLabel, sortForShelf } from './shelf';

declare function test(name: string, fn: () => void | Promise<void>): void;
declare const assert: typeof import('node:assert');

function book(fields: Partial<Book>): Book {
  return { id: 1, title: 'Kindred', author: 'Octavia E. Butler', year: 1979, on_loan_to: null, ...fields };
}

test('the shelf is in surname order', () => {
  const sorted = sortForShelf([
    book({ id: 1, title: 'Beloved', author: 'Toni Morrison' }),
    book({ id: 2, title: 'Kindred', author: 'Octavia E. Butler' }),
  ]);
  assert.deepStrictEqual(
    sorted.map((one) => one.title),
    ['Kindred', 'Beloved'],
  );
});

test('the label is unchanged', () => {
  assert.strictEqual(shelfLabel(book({ on_loan_to: 'Ade' })), 'Kindred — Octavia E. Butler (1979) · on loan');
});
