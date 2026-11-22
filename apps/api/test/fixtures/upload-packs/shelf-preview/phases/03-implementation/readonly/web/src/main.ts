/**
 * Mount the shelf page: ask the API for the books, then render them.
 *
 * The fetch is relative (`api/books`), so the page works wherever the API is
 * served beside it. Nothing is kept in the browser.
 */

import * as React from 'react';

import { Book } from './lib/shelf';
import { ShelfPage } from './ShelfPage';

// react-dom ships its own runtime and no types here; the page needs one call.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createRoot } = require('react-dom/client');

const page = (globalThis as { document?: { getElementById(id: string): unknown } }).document;

async function start(): Promise<void> {
  const response = await fetch('api/books');
  const books = (await response.json()) as Book[];
  createRoot(page?.getElementById('root')).render(React.createElement(ShelfPage, { books }));
}

if (page) void start();
