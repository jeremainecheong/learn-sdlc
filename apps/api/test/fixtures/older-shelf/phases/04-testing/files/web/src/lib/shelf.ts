/**
 * What the shelf page shows for a book, and the order it shows them in.
 *
 * Pure functions over the books the API answers with, so the page and the
 * tests read the same rules.
 */

export interface Book {
  id: number;
  title: string;
  author: string;
  year: number | null;
  on_loan_to: string | null;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One line for a book: "Title — Author (1969)", or "Title — Author" when the
 * year is unknown, with " · on loan" at the end while somebody has it.
 */
export function shelfLabel(book: Book): string {
  const year = book.year === null ? '' : ` (${book.year})`;
  const loan = book.on_loan_to ? ' · on loan' : '';
  return `${book.title} — ${book.author}${year}${loan}`;
}

/**
 * The books in shelf order: by title ignoring case, then by id. Returns a new
 * array and never reorders the one it was given.
 */
export function sortForShelf(books: readonly Book[]): Book[] {
  return [...books].sort(
    (a, b) => byText(a.title.toLowerCase(), b.title.toLowerCase()) || a.id - b.id,
  );
}
