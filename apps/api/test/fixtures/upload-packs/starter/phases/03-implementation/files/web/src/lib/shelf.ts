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

export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One line for a book: "Title — Author (1969)", or "Title — Author" when the
 * year is unknown, with " · on loan" at the end while somebody has it.
 */
export function shelfLabel(book: Book): string {
  // TODO(learner): "Title — Author (year)", no year when it is null, " · on loan" while lent.
  throw new Error('shelfLabel is not implemented yet');
}

/**
 * The books in shelf order: by title ignoring case, then by id. Returns a new
 * array and never reorders the one it was given.
 */
export function sortForShelf(books: readonly Book[]): Book[] {
  // TODO(learner): a new array, by title ignoring case, then by id.
  throw new Error('sortForShelf is not implemented yet');
}
