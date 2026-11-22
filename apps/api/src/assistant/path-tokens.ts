/** `text` with every character a regular expression reads specially escaped, so it matches itself. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The last segment of a slash-separated path: its file name. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
