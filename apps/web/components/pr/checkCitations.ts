/**
 * The reviewer's citations of checks, read as the checks' own names.
 *
 * The AI reviewer is asked to cite a recorded check as `[check:<id>]`
 * (apps/api/src/assistant/openai.provider.ts). Printed raw, a learner read
 * "[check:visible-tests] passed with 1/1 tests". Each mark whose id the SAME
 * report's checks list holds is drawn as that check's label, verbatim ("Visible
 * test suite"); the labels are names that start with a capital, so a mark at
 * the start of a sentence reads as a capitalised sentence and a mark inside one
 * reads as a name, and no casing is changed either way. A mark whose id the
 * report does not hold stays exactly as written: no title is invented and no
 * mark is dropped. Other bracketed text, and text with no mark, is returned
 * unchanged (the same string).
 */
const MARK = /\[check:([^\]\s]+)\]/g;

export type CitedCheck = { id: string; label?: string };

export function citeChecks(text: string, checks: ReadonlyArray<CitedCheck> | null | undefined): string {
  if (!text || !checks?.length || !text.includes('[check:')) return text;
  return text.replace(MARK, (mark, id: string) => checks.find((check) => check.id === id)?.label || mark);
}
