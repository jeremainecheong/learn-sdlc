/**
 * The front-end acceptance suite this pack would hand in (SH-1, SH-4).
 *
 * seal marker: SHELF-SEALED-REFERENCE-4T7W
 *
 * It lands in the workspace at web/src/lib/acceptance.test.ts, beside the
 * shelf.ts it tests, which is why the import below resolves there.
 */

// @ts-ignore -- resolved in the learner's workspace, beside web/src/lib/shelf.ts
import { shelfLabel, sortForShelf } from './shelf';

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const assert: typeof import('node:assert');

const book = (fields: Record<string, unknown>) => ({
  id: 1,
  title: 'Kindred',
  author: 'Octavia E. Butler',
  year: 1979,
  on_loan_to: null,
  ...fields,
});

test('a lent book is marked on loan', () => {
  assert.strictEqual(shelfLabel(book({ on_loan_to: 'Ade' })), 'Kindred — Octavia E. Butler (1979) · on loan');
});

test('a book on the shelf is not marked on loan', () => {
  assert.strictEqual(shelfLabel(book({})), 'Kindred — Octavia E. Butler (1979)');
});

test('the shelf sorts by title, ignoring case', () => {
  const titles = sortForShelf([book({ id: 1, title: 'persuasion' }), book({ id: 2, title: 'Emma' })]).map(
    (one: { title: string }) => one.title,
  );
  assert.deepStrictEqual(titles, ['Emma', 'persuasion']);
});
