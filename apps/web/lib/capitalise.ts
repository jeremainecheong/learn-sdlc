/** The text with its first character in upper case and the rest as written; an empty string stays empty. */
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
