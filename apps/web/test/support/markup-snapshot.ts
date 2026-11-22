/**
 * Readable file snapshots of what a component renders.
 *
 * A test that holds a whole render still (a panel, a room, a tour) compares it with a file under
 * `test/__snapshots__/` through Vitest's `toMatchFileSnapshot`. A change then fails with a diff of what moved,
 * and is accepted with `npx vitest run -u <test file>` once that diff has been read. These helpers only lay the
 * text out for such a diff: they add line breaks and headings, and never drop a rendered character.
 */

/**
 * Markup with a line break between every pair of adjacent tags.
 *
 * A rendered line break that is the whole text between two tags is written as `&#10;` first. Without that, it
 * would read exactly like a break this layout added, and a render that gains or loses such a text node would
 * match the same snapshot.
 */
export function markupLines(html: string): string {
  return html.replace(/>\n</g, '>&#10;<').replace(/></g, '>\n<');
}

/** Several renders of markup in one snapshot file, each under an HTML comment that names it. */
export function namedMarkup(prints: Record<string, string> | readonly (readonly [string, string])[]): string {
  const entries = Array.isArray(prints) ? prints : Object.entries(prints);
  return `${entries.map(([name, html]) => `<!-- ${name} -->\n${markupLines(html)}`).join('\n\n')}\n`;
}

/** A value as indented JSON with a closing newline, for a snapshot file of data rather than markup. */
export function jsonLines(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
