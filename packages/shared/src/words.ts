/**
 * Counts in a sentence: small numbers as words, large ones grouped in
 * thousands, and the singular or plural noun. Pure and dependency-free.
 */

/**
 * The locale every date, time and number the product writes for people is
 * written in, by the API and the web app alike: "9 September", "09:00".
 */
export const DISPLAY_LOCALE = 'en-GB';

/** Zero to twelve as a person writes them in a sentence; zero is "no". */
const NUMBER_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
] as const;

/**
 * `n` as a word when it is a whole number from 0 to `upTo` (at most twelve),
 * and as digits otherwise: "no", "one" ... "twelve", then "13". A caller passes
 * its own `upTo` where its sentences write larger numbers as digits.
 */
export function numberWord(n: number, upTo: number = NUMBER_WORDS.length - 1): string {
  return Number.isInteger(n) && n >= 0 && n <= upTo && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

/** `2000` as `2,000`, with no locale to vary by. */
export function withThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `one` for a count of 1, `many` for any other count; `many` defaults to `one` with an "s". */
export const pluralWord = (n: number, one: string, many: string = `${one}s`): string => (n === 1 ? one : many);
