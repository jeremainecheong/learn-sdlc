/**
 * The sealed front-end suite for change request CHG-1.
 *
 * seal marker: SHELF-SEALED-HIDDEN-5F3K
 *
 * Requires by workspace path, never relatively: the sealed copy is imported
 * from outside the workspace.
 */

declare function test(name: string, fn: () => void | Promise<void>): void;
declare const assert: typeof import('node:assert');

const src = (rel: string) => require(`${process.cwd()}/web/src/${rel}`);
const { shelfLabel, sortForShelf } = src('lib/shelf');
const { ShelfPage } = src('ShelfPage');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const book = (fields: Record<string, unknown>) => ({
  id: 1,
  title: 'Kindred',
  author: 'Octavia E. Butler',
  year: 1979,
  on_loan_to: null,
  ...fields,
});

test('surname decides before title', () => {
  const titles = sortForShelf([
    book({ id: 1, title: 'Beloved', author: 'Toni Morrison' }),
    book({ id: 2, title: 'Kindred', author: 'Octavia E. Butler' }),
    book({ id: 3, title: 'Emma', author: 'Jane Austen' }),
  ]).map((one: { title: string }) => one.title);
  assert.deepStrictEqual(titles, ['Emma', 'Kindred', 'Beloved']);
});

test('surname order ignores case', () => {
  const titles = sortForShelf([
    book({ id: 1, title: 'Ariel', author: 'Sylvia Plath' }),
    book({ id: 2, title: 'Zami', author: 'audre lorde' }),
  ]).map((one: { title: string }) => one.title);
  assert.deepStrictEqual(titles, ['Zami', 'Ariel']);
});

test('one author is shelved by title, then by id', () => {
  const ids = sortForShelf([
    book({ id: 9, title: 'Persuasion', author: 'Jane Austen' }),
    book({ id: 4, title: 'emma', author: 'Jane Austen' }),
    book({ id: 2, title: 'Emma', author: 'Jane Austen' }),
  ]).map((one: { id: number }) => one.id);
  assert.deepStrictEqual(ids, [2, 4, 9]);
});

test('the label a lent book shows is unchanged', () => {
  assert.strictEqual(shelfLabel(book({ year: null, on_loan_to: 'Ade' })), 'Kindred — Octavia E. Butler · on loan');
});

test('the page shows the new order', () => {
  const html: string = renderToStaticMarkup(
    React.createElement(ShelfPage, {
      books: [book({ id: 1, title: 'Beloved', author: 'Toni Morrison' }), book({ id: 2 })],
    }),
  );
  assert.ok(html.indexOf('Kindred') < html.indexOf('Beloved'));
});

export {};
