/**
 * Your front-end acceptance suite (SH-1, SH-4).
 *
 * Prove what a person reads on the shelf page: the line for each book, and
 * the order the lines come in. `test` and `assert` are globals the runner
 * provides; `assert` is node's own.
 *
 * The graders run this suite against secretly broken copies of shelf.ts, so
 * assert the whole line a person reads, not just that something came back.
 */

import { Book, shelfLabel, sortForShelf } from './shelf';

declare function test(name: string, fn: () => void | Promise<void>): void;
declare const assert: typeof import('node:assert');

/** A book to start from; override only the fields a case is about. */
function aBook(fields: Partial<Book>): Book {
  return { id: 1, title: 'Kindred', author: 'Octavia E. Butler', year: 1979, on_loan_to: null, ...fields };
}

// Write your cases below, one test(...) per acceptance criterion.
