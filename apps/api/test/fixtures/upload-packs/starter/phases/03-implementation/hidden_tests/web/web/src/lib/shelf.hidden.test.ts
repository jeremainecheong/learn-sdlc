/**
 * The sealed front-end suite for the implementation phase (SH-1, SH-4).
 *
 * seal marker: SHELF-SEALED-HIDDEN-5F3K
 *
 * Why `src(...)` instead of a relative import: a graded suite is written
 * outside the workspace and imported before the seal deletes it, so a relative
 * import would resolve beside the sealed copy. Requiring by workspace path
 * loads exactly the file the learner wrote.
 */

declare function test(name: string, fn: () => void | Promise<void>): void;
declare const assert: typeof import('node:assert');

const src = (rel: string) => require(`${process.cwd()}/web/src/${rel}`);
const { shelfLabel, sortForShelf } = src('lib/shelf');
const { ShelfPage } = src('ShelfPage');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

interface AnyBook {
  id: number;
  title: string;
  author: string;
  year: number | null;
  on_loan_to: string | null;
}

function book(fields: Partial<AnyBook>): AnyBook {
  return { id: 1, title: 'Kindred', author: 'Octavia E. Butler', year: 1979, on_loan_to: null, ...fields };
}

test('a book with no year has no brackets', () => {
  assert.strictEqual(shelfLabel(book({ year: null })), 'Kindred — Octavia E. Butler');
});

test('a lent book says so at the end of its line', () => {
  assert.strictEqual(shelfLabel(book({ on_loan_to: 'Ade' })), 'Kindred — Octavia E. Butler (1979) · on loan');
});

test('title order ignores case', () => {
  const sorted = sortForShelf([book({ id: 1, title: 'persuasion' }), book({ id: 2, title: 'Emma' })]);
  assert.deepStrictEqual(
    sorted.map((one: AnyBook) => one.title),
    ['Emma', 'persuasion'],
  );
});

test('two copies of one title keep the order of their ids', () => {
  const sorted = sortForShelf([book({ id: 7, title: 'Beloved' }), book({ id: 3, title: 'Beloved' })]);
  assert.deepStrictEqual(
    sorted.map((one: AnyBook) => one.id),
    [3, 7],
  );
});

test('sorting never reorders the array it was given', () => {
  const given = [book({ id: 1, title: 'Station Eleven' }), book({ id: 2, title: 'Kindred' })];
  sortForShelf(given);
  assert.deepStrictEqual(
    given.map((one) => one.id),
    [1, 2],
  );
});

test('the page lists the books in shelf order, one line each', () => {
  const html: string = renderToStaticMarkup(
    React.createElement(ShelfPage, {
      books: [book({ id: 1, title: 'Station Eleven', author: 'Emily St. John Mandel', year: 2014 }), book({ id: 2 })],
    }),
  );
  assert.ok(html.indexOf('Kindred — Octavia E. Butler (1979)') < html.indexOf('Station Eleven'));
  assert.strictEqual((html.match(/<li/g) || []).length, 2);
});

export {};
