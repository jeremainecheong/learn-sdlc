/**
 * The shelf page: every book, one line each, in shelf order.
 *
 * Written with React.createElement rather than JSX so the page needs no build
 * step beyond the TypeScript transform the runner already does.
 */

import * as React from 'react';

import { Book, shelfLabel, sortForShelf } from './lib/shelf';

export function ShelfPage(props: { books: readonly Book[] }): React.ReactElement {
  const heading = React.createElement('h1', null, 'The shelf');
  if (props.books.length === 0) {
    return React.createElement('main', null, heading, React.createElement('p', null, 'The shelf is empty.'));
  }
  const rows = sortForShelf(props.books).map((book) =>
    React.createElement('li', { key: book.id }, shelfLabel(book)),
  );
  return React.createElement('main', null, heading, React.createElement('ul', null, rows));
}
