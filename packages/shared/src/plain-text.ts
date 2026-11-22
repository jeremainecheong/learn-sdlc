/**
 * Plain text is how every teacher-written phase text is kept and shown: it keeps
 * its line breaks, a blank line separates paragraphs, and nothing in it is
 * interpreted. `plainTextOf` turns older markdown into plain text and keeps
 * every word. Code is kept as it is, its delimiters included: a code
 * span keeps its backticks and a fenced block its fence lines, byte for byte,
 * so a later pass meets the same span or fence and keeps it again. Outside
 * code, a heading becomes its own line; a list marker is kept with its item, as
 * plain text writes a list, and so is a block-quote marker; a table row becomes
 * its cells joined by "; "; a link becomes its text and its address in
 * brackets, with its title after the address when it has one; emphasis goes
 * only where CommonMark would read it as emphasis, and never inside a word; a
 * link, autolink or emphasis pair whose removal would join two words is kept as
 * written; a backslash escape and an HTML comment are kept as written, and
 * every display removes a comment outside code (`withoutHtmlComments`). A
 * fenced block opened after a list or block-quote marker is code too. The line
 * pass runs until it changes nothing, so the result is a fixed point:
 * `plainTextOf(plainTextOf(t)) === plainTextOf(t)` for every text, and a text
 * that holds no markdown construct comes back unchanged. Each rule reads a line
 * in about one step a character, a link or autolink inside another is read
 * innermost first in the same pass, and a pass after the first reads only the
 * lines the last one can have changed, so a text at the brief's cap (20,000
 * characters) is read in well under a second.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED = /^(?: {4}|\t)/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** The first list marker of a line: a bullet, or a number of up to nine digits and a dot or bracket. */
const MARKER = /^( {0,3})(?:[-*+]|(\d{1,9})[.)])(?:[ \t]+|$)/;
/** The markers of lists nested on the same line (`- 1. x`), read after the first. */
const MORE_MARKERS = /^(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))*/;
const TABLE_SEPARATOR = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$|^ {0,3}\|[ \t]*:?-+:?[ \t]*\|?[ \t]*$/;
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const ESCAPABLE = /[!-/:-@[-`{-~]/;

const OPEN_TOKEN = '';
const CLOSE_TOKEN = '';
const TOKEN = /(\d+)/g;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;
const WORD = /[\p{L}\p{N}]/u;

/**
 * A line's runs of backticks: for each length, where its runs start, in order, and the first not yet passed.
 * A code span closes at the next run of its own length, so each run is found once, not by reading the rest of
 * the line again for each run that opens (a line of 200 runs of different lengths).
 */
function backtickRuns(line: string): Map<number, { starts: number[]; next: number }> {
  const runs = new Map<number, { starts: number[]; next: number }>();
  for (let at = line.indexOf('`'); at >= 0; ) {
    let length = 1;
    while (line[at + length] === '`') length += 1;
    const same = runs.get(length) ?? { starts: [], next: 0 };
    same.starts.push(at);
    runs.set(length, same);
    at = line.indexOf('`', at + length);
  }
  return runs;
}

/** The length of the code span opening at `at` (its backticks included), or 0 when no later run of the same length closes it. */
function codeSpanAt(line: string, at: number, runs: Map<number, { starts: number[]; next: number }>): number {
  let run = 1;
  while (line[at + run] === '`') run += 1;
  const same = runs.get(run);
  if (!same) return 0;
  while (same.next < same.starts.length && same.starts[same.next] <= at) same.next += 1;
  return same.next < same.starts.length ? same.starts[same.next] + run - at : 0;
}

/**
 * The pieces of a line no rule reads inside, left to right as CommonMark finds them: a backslash escape
 * (a backslash and the punctuation after it), an HTML comment that closes on the line, a code span,
 * each with its delimiters, and a literal U+E000 (the character a mask opens with). `open` is where a
 * comment that does not close on this line starts, or -1.
 */
function heldPieces(line: string): { pieces: { at: number; length: number }[]; open: number } {
  const pieces: { at: number; length: number }[] = [];
  let runs: Map<number, { starts: number[]; next: number }> | undefined;   // read at the line's first backtick
  for (let at = 0; at < line.length; ) {
    const char = line[at];
    if (char === '\\' && at + 1 < line.length && ESCAPABLE.test(line[at + 1])) { pieces.push({ at, length: 2 }); at += 2; continue; }
    // The character `inline` masks a held piece with is held itself, so a text that holds it keeps it (and the restore meets only masks).
    if (char === OPEN_TOKEN) { pieces.push({ at, length: 1 }); at += 1; continue; }
    if (line.startsWith(COMMENT_OPEN, at)) {
      const close = line.indexOf(COMMENT_CLOSE, at + COMMENT_OPEN.length);
      if (close < 0) return { pieces, open: at };
      pieces.push({ at, length: close + COMMENT_CLOSE.length - at });
      at = close + COMMENT_CLOSE.length;
      continue;
    }
    if (char === '`') {
      runs ??= backtickRuns(line);
      const length = codeSpanAt(line, at, runs);
      if (length) { pieces.push({ at, length }); at += length; continue; }
      while (line[at] === '`') at += 1;   // an unmatched run of backticks is a literal run
      continue;
    }
    at += 1;
  }
  return { pieces, open: -1 };
}

/** One line's text outside code: links, autolinks and emphasis, with every held piece kept as written. */
function inline(line: string): string {
  const { pieces } = heldPieces(line);
  if (!pieces.length && !/[*_[<]/.test(line)) return line;
  const kept: string[] = [];
  let masked = '';
  let from = 0;
  for (const piece of pieces) {
    masked += line.slice(from, piece.at) + `${OPEN_TOKEN}${kept.length}${CLOSE_TOKEN}`;
    kept.push(line.slice(piece.at, piece.at + piece.length));
    from = piece.at + piece.length;
  }
  masked += line.slice(from);
  return emphasis(links(masked)).replace(TOKEN, (_all, n: string) => kept[Number(n)]);
}

/** Whether the character at `at` is a letter or digit (false off either end). */
function wordAt(text: string, at: number): boolean {
  return at >= 0 && at < text.length && WORD.test(text[at]);
}

/** A link's destination after its `]`: the address, then a title in double quotes when it has one. */
const DESTINATION = /\(([^()\s]+)((?:[ \t]+"[^"\n]*")?)\)/y;
const SCHEME = /^(?:https?|mailto):/;

/** `text` without the characters at `dropped`. */
function without(text: string, dropped: number[]): string {
  if (!dropped.length) return text;
  dropped.sort((one, other) => one - other);
  let out = '';
  let from = 0;
  for (const at of dropped) { out += text.slice(from, at); from = at + 1; }
  return out + text.slice(from);
}

/**
 * Links and images as plain text: a link's text, then its address in brackets with its title after the address
 * when it has one. A link opens at the nearest `[` before the `]` its destination follows, as CommonMark reads it,
 * so a link inside the text of another is converted first and the outer one then reads it as its text:
 * `[[a](b)](c)` is `a (b) (c)` in one reading, where a reading that opened at the first `[` would take a pass a
 * level. A `]` that no destination follows, a link kept as written and a line's end close every `[` before them.
 * One a letter or digit touches is kept as written, so no two words join.
 */
function linksAndImages(text: string): string {
  if (!text.includes('](')) return text;
  let out = '';
  let last = '';   // the last character written
  const dropped: number[] = [];   // where `out` holds the `[` or `![` of a link that was converted
  const opens: { at: number; length: number; before: boolean }[] = [];
  const write = (piece: string) => { if (piece) { out += piece; last = piece[piece.length - 1]; } };
  const special = /[[\]!\n]/g;
  for (let at = 0; at < text.length; ) {
    special.lastIndex = at;
    const found = special.exec(text);
    const to = found ? found.index : text.length;
    write(text.slice(at, to));
    if (!found) break;
    at = to;
    const char = text[at];
    if (char === '[' || (char === '!' && text[at + 1] === '[')) {
      const length = char === '!' ? 2 : 1;
      opens.push({ at: out.length, length, before: WORD.test(last) });
      write(text.slice(at, at + length));
      at += length;
      continue;
    }
    if (char === ']' && opens.length) {
      DESTINATION.lastIndex = at + 1;
      const destination = DESTINATION.exec(text);
      if (destination) {
        const opener = opens.pop()!;
        const end = DESTINATION.lastIndex;
        const labelled = out.length > opener.at + opener.length;
        if (opener.before || (!labelled && wordAt(text, end))) {
          write(text.slice(at, end));   // kept as written: no `[` before it reads past its `]`
          opens.length = 0;
        } else {
          for (let k = 0; k < opener.length; k += 1) dropped.push(opener.at + k);
          const [, href, title] = destination;
          write(labelled ? ` (${href}${title})` : `${href}${title}`);
        }
        at = end;
        continue;
      }
    }
    if (char !== '!') opens.length = 0;   // a `]` with no destination, or a line's end
    write(char);
    at += 1;
  }
  return without(out, dropped);
}

/**
 * The nearest position at or after `at`, following `leaps`, that is not in `dropped`. Every position crossed on
 * the way is pointed straight at the answer, so a long run of dropped positions is crossed about once.
 */
function skipDropped(at: number, dropped: ReadonlySet<number>, leaps: Map<number, number>): number {
  let to = at;
  while (dropped.has(to)) to = leaps.get(to)!;
  for (let on = at; on !== to; ) { const next = leaps.get(on)!; leaps.set(on, to); on = next; }
  return to;
}

/**
 * Autolinks as their address. An autolink opens at the nearest `<` before its `>`, so one inside another
 * (`<https:<https:x>>`) is converted first and the outer one then reads its address, in one reading. A `>` that
 * closes no autolink, an autolink kept as written and a space close every `<` before them. One a letter or digit
 * touches is kept as written, so no two words join.
 */
function autolinks(text: string): string {
  if (!text.includes('<') || !text.includes('>')) return text;
  let out = '';
  let last = '';
  const dropped = new Set<number>();   // where `out` holds the `<` of an autolink that was converted
  // Where to look on from a dropped `<`, pointed past the run it crossed, so a run of them is crossed about once.
  const leaps = new Map<number, number>();
  const kept = (at: number): number => skipDropped(at, dropped, leaps);
  const write = (piece: string) => { if (piece) { out += piece; last = piece[piece.length - 1]; } };
  const opens: { at: number; before: boolean; drops: number }[] = [];
  const special = /[<>\s]/g;
  for (let at = 0; at < text.length; at += 1) {
    special.lastIndex = at;
    const found = special.exec(text);
    const to = found ? found.index : text.length;
    write(text.slice(at, to));
    if (!found) break;
    at = to;
    const char = text[at];
    if (char === '<') {
      opens.push({ at: out.length, before: WORD.test(last), drops: dropped.size });
      write(char);
      continue;
    }
    if (char === '>' && opens.length) {
      const opener = opens.pop()!;
      // What the `<` holds: what was written after it, but the `<` of the autolinks converted inside it.
      const start = kept(opener.at + 1);
      const scheme = SCHEME.exec(out.slice(start, start + 7))?.[0].length ?? 0;
      const holds = out.length - opener.at - 1 - (dropped.size - opener.drops);
      if (scheme && holds > scheme && !opener.before && !wordAt(text, at + 1)) {
        dropped.add(opener.at);
        leaps.set(opener.at, opener.at + 1);
        continue;
      }
    }
    opens.length = 0;   // a `>` that closes no autolink, or a space
    write(char);
  }
  return without(out, [...dropped]);
}

/**
 * Links and autolinks as plain text: a link's text, then its address in brackets with its title after the
 * address when it has one; an autolink's address. One a letter or digit touches is kept as written, so no
 * two words join.
 */
function links(text: string): string {
  return autolinks(linksAndImages(text));
}

type Run = { char: '*' | '_'; at: number; length: number; open: boolean; close: boolean; left: number; right: number };

/**
 * CommonMark's delimiter-run rules: `*` and `_` are removed only where they would be read as emphasis.
 * One reading departs from CommonMark: an asterisk run with a letter or digit on both sides
 * is never emphasis, so `a*b*c` and `2*x*y` stay as written, as an underscore inside a word does. A pair
 * whose removal would join two words (`**bold**_italic_`) is kept too.
 */
function emphasis(text: string): string {
  const runs: Run[] = [];
  for (let at = 0; at < text.length; ) {
    const char = text[at];
    if (char !== '*' && char !== '_') { at += 1; continue; }
    let length = 1;
    while (text[at + length] === char) length += 1;
    const before = at === 0 ? ' ' : text[at - 1];
    const after = at + length >= text.length ? ' ' : text[at + length];
    const leftFlanking = !WHITESPACE.test(after) && (!PUNCTUATION.test(after) || WHITESPACE.test(before) || PUNCTUATION.test(before));
    const rightFlanking = !WHITESPACE.test(before) && (!PUNCTUATION.test(before) || WHITESPACE.test(after) || PUNCTUATION.test(after));
    const insideWord = WORD.test(before) && WORD.test(after);
    const open = char === '*' ? leftFlanking && !insideWord : leftFlanking && (!rightFlanking || PUNCTUATION.test(before));
    const close = char === '*' ? rightFlanking && !insideWord : rightFlanking && (!leftFlanking || PUNCTUATION.test(after));
    runs.push({ char: char as '*' | '_', at, length, open, close, left: length, right: length });
    at += length;
  }
  const pairs: number[][] = [];
  const openers: Run[] = [];
  // CommonMark's openers bottom: no opener below `floor` of a closer's kind (its character, whether it can open,
  // its length modulo 3) pairs with that kind, so a closer does not read them again and a line is read once.
  const floor = new Map<string, number>();
  for (const run of runs) {
    if (run.close) {
      const kind = `${run.char}${run.open}${run.length % 3}`;
      let closing = run.left;
      for (let index = openers.length - 1; index >= (floor.get(kind) ?? 0) && closing > 0; index -= 1) {
        const opener = openers[index];
        if (opener.char !== run.char || opener.right === 0) continue;
        // the rule of 3: a run that can both open and close does not pair across a multiple of three
        if ((opener.close || run.open) && (opener.length + run.length) % 3 === 0 && !(opener.length % 3 === 0 && run.length % 3 === 0)) continue;
        const use = opener.right >= 2 && closing >= 2 ? 2 : 1;
        const pair: number[] = [];
        for (let k = 0; k < use; k += 1) pair.push(opener.at + opener.right - 1 - k, run.at + (run.length - closing) + k);
        pairs.push(pair);
        opener.right -= use;
        closing -= use;
        openers.splice(index + 1);
        for (const [one, at] of floor) if (at > openers.length) floor.set(one, openers.length);
        if (opener.right > 0) index += 1;
      }
      if (closing > 0) floor.set(kind, openers.length);
      run.left = closing;
    }
    if (run.open && run.left > 0) {
      run.right = run.left;
      openers.push(run);
    }
  }
  // The pairs are taken in the order they closed: each is removed unless its removal, with the pairs already
  // removed, would leave a letter or digit against a letter or digit, and then it is kept, so no two words join.
  // One sweep settles every pair, so a line of many such pairs costs one pass, not one pass per pair.
  const drop = new Set<number>();
  // Where to look next from a removed character, leftward and rightward; each look is pointed past the run it
  // crossed, so a long run of removed characters is crossed about once (a nest of 10,000 asterisks).
  const back = new Map<number, number>();
  const ahead = new Map<number, number>();
  const nearestKept = (at: number, leaps: Map<number, number>): number => skipDropped(at, drop, leaps);
  for (const pair of pairs) {
    const joins = pair.some((at) => {
      let from = nearestKept(at - 1, back);
      while (pair.includes(from)) from = nearestKept(from - 1, back);
      let to = nearestKept(at + 1, ahead);
      while (pair.includes(to)) to = nearestKept(to + 1, ahead);
      return wordAt(text, from) && wordAt(text, to);
    });
    if (!joins) for (const at of pair) { drop.add(at); back.set(at, at - 1); ahead.set(at, at + 1); }
  }
  if (!drop.size) return text;
  let out = '';
  for (let at = 0; at < text.length; at += 1) if (!drop.has(at)) out += text[at];
  return out;
}

function tableRow(line: string): string {
  const lead = /^ {0,3}/.exec(line)![0];
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells = body.split(/(?<!\\)\|/).map((cell) => inline(cell.trim()));
  return lead + cells.filter((cell, at) => cell !== '' || at < cells.length - 1).join('; ');
}

const BLANK = (char: string | undefined) => char === ' ' || char === '\t';

/**
 * An ATX heading's indentation and text, or null (CommonMark): up to three spaces, one to six `#` and then a
 * space, a tab or the line's end; the text runs to a closing `#` run that a space or tab precedes. Up to
 * `levels` levels are read, a text that is a heading itself read on as the next level (`## ## x` is `x`), with
 * each end read once, so many levels cost one read of the line. Read by index, so a long run of spaces is
 * crossed once; a line that holds a carriage return or a line or paragraph separator is not a heading, as a
 * regular expression's `.` reads it.
 */
function atxHeading(line: string, levels: number): { lead: string; text: string } | null {
  if (/[\r\u2028\u2029]/.test(line)) return null;
  let start = 0;
  while (start < 3 && line[start] === ' ') start += 1;
  const lead = line.slice(0, start);
  let end = line.length;
  let closed = false;   // the end has been read and holds no closing run, so no later level finds one
  for (let level = 0; level < levels; level += 1) {
    let at = start;
    while (at < end && line[at] === '#') at += 1;
    if (at === start || at - start > 6 || (at < end && !BLANK(line[at]))) {
      if (level === 0) return null;
      break;
    }
    while (at < end && BLANK(line[at])) at += 1;
    start = at;
    if (start === end) break;
    if (closed) continue;
    let text = end;
    while (BLANK(line[text - 1])) text -= 1;
    let run = text;
    while (run > start && line[run - 1] === '#') run -= 1;
    if (run < text && run > start && BLANK(line[run - 1])) {
      end = run;
      while (BLANK(line[end - 1])) end -= 1;
    } else {
      end = text;
      closed = true;
    }
  }
  return { lead, text: line.slice(start, end) };
}

/** Block-quote and list markers before a fence on the same line (`> ```py`, `- ```sh`, `1. ~~~`). */
const CONTAINER = /^(?: {0,3}(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+))+/;

/** An open fenced block: its fence, and whether it opened after block-quote markers or list markers. */
type OpenFence = { fence: string; quoted: boolean; listed: boolean };

/** The fence a line opens, after any block-quote or list markers, or null (a backtick fence's info has no backtick). */
function fenceOpenedBy(line: string): OpenFence | null {
  const lead = CONTAINER.exec(line)?.[0] ?? '';
  const rest = line.slice(lead.length);
  const opening = FENCE.exec(rest);
  if (!opening || (opening[1][0] === '`' && rest.slice(rest.indexOf(opening[1]) + opening[1].length).includes('`'))) return null;
  return { fence: opening[1], quoted: lead.includes('>'), listed: lead !== '' && !lead.includes('>') };
}

/** Whether a line closes the open fence: the same character, at least as long, alone on the line after the fence's block-quote markers or a list item's indentation. */
function fenceClosedBy(line: string, open: OpenFence): boolean {
  const body = open.quoted ? line.replace(/^(?: {0,3}>[ \t]?)+/, '') : open.listed ? line.replace(/^[ \t]+/, '') : line;
  const closing = FENCE.exec(body);
  return !!closing && closing[1][0] === open.fence[0] && closing[1].length >= open.fence.length && body.trim() === closing[1];
}

/** Where the line pass stands: inside a fence or a comment, after paragraph text, inside a list, inside a table's rows. */
type LineState = { fence: OpenFence | null; inComment: boolean; paragraph: boolean; inList: boolean; table: boolean };

/**
 * A heading, a list item or a line of text outside code, as plain text. A list marker is kept and its
 * item's text converted after it. Whether an ordered marker opens a list item (CommonMark: its
 * number is 1, or the line before is not paragraph text, or a list is open) decides only the line state,
 * so `2024. Since` after paragraph text is read as text; either way the number stays.
 */
function textLine(line: string, next: string | undefined, previousRaw: string | undefined, state: LineState): string | null {
  if (SETEXT_UNDERLINE.test(line) && state.paragraph && !state.inList) { state.paragraph = false; return null; }
  if (THEMATIC.test(line)) { state.paragraph = false; state.inList = false; return ''; }
  // A table's rows run from its separator to the first line that is not a row (`table`), never on from a line that only holds "; ".
  const table = state.table;
  state.table = false;
  if (TABLE_SEPARATOR.test(line) && line.includes('|') && previousRaw?.includes('|')) { state.paragraph = false; state.inList = false; state.table = true; return null; }
  const isTableRow = line.includes('|') && (TABLE_SEPARATOR.test(next ?? '') || table);
  if (isTableRow && /\|/.test(line.trim().slice(1, -1) + (line.trim().startsWith('|') ? '|' : ''))) { state.paragraph = false; state.inList = false; state.table = table; return tableRow(line); }
  const heading = atxHeading(line, 1);
  if (heading) {
    state.paragraph = false;
    state.inList = false;
    // A text that is a heading once converted is read through every level it holds at once and its text converted
    // once, so a line of thousands of levels costs one pass. Passes would convert the text at each level, which can
    // reveal a closing `#` run; the two readings differ only in which `#` and delimiters stay, never in a word.
    const converted = heading.lead + inline(heading.text);
    const inner = atxHeading(converted, Infinity);
    return inner ? inner.lead + inline(inner.text) : converted;
  }
  const marker = MARKER.exec(line);
  if (marker) {
    const ordered = marker[2] !== undefined;
    const empty = marker[0].length === line.length;
    const opens = ordered ? Number(marker[2]) === 1 || !state.paragraph || state.inList : !(empty && state.paragraph);
    if (opens) {
      const rest = line.slice(marker[0].length);
      const more = MORE_MARKERS.exec(rest)![0];
      state.paragraph = true;
      state.inList = true;
      // A list marker is how plain text writes a list, so it is kept, with any marker nested after it.
      return marker[0] + more + inline(rest.slice(more.length));
    }
  }
  state.paragraph = true;
  return inline(line);
}

/** A line as plain text in `state` (which it moves on), or null when the line goes; `previous` and `next` are the raw lines beside it. */
function readLine(raw: string, previous: string | undefined, next: string | undefined, state: LineState): string | null {
  const cr = raw.endsWith('\r') ? '\r' : '';
  const line = cr ? raw.slice(0, -1) : raw;
  // A fenced block, its two fence lines included, is kept byte for byte.
  if (state.fence !== null) {
    if (fenceClosedBy(line, state.fence)) state.fence = null;
    return raw;
  }
  // A comment that spans lines is kept as written to its close.
  if (state.inComment) {
    const close = line.indexOf(COMMENT_CLOSE);
    if (close < 0) return raw;
    // What follows the close is text, up to a comment that opens there and closes on a later line.
    const after = line.slice(close + COMMENT_CLOSE.length);
    const reopen = heldPieces(after).open;
    state.inComment = reopen >= 0;
    return line.slice(0, close + COMMENT_CLOSE.length) + (reopen >= 0 ? inline(after.slice(0, reopen)) + after.slice(reopen) : inline(after)) + cr;
  }
  if (line.trim() === '') { state.paragraph = false; state.inList = false; state.table = false; return raw; }
  const opening = fenceOpenedBy(line);
  if (opening) {
    state.fence = opening;
    state.paragraph = false;
    state.inList = false;
    state.table = false;
    return raw;
  }
  if (INDENTED.test(line)) return raw;
  // A comment that opens on this line and closes on a later one: the text before it reads as any line does.
  const { open } = heldPieces(line);
  if (open >= 0) {
    const before = line.slice(0, open);
    let text = before.length;
    while (BLANK(before[text - 1])) text -= 1;   // the spaces and tabs before the comment, read back from it
    const head = before.trim() === '' ? before : (textLine(before.slice(0, text), undefined, undefined, state) ?? '') + before.slice(text);
    state.inComment = true;
    return head + line.slice(open) + cr;
  }
  const done = textLine(line, next?.replace(/\r$/, ''), previous?.replace(/\r$/, ''), state);
  return done === null ? null : done + cr;
}

function sameState(one: LineState, other: LineState): boolean {
  return one.inComment === other.inComment && one.paragraph === other.paragraph && one.inList === other.inList && one.table === other.table
    && (one.fence === other.fence || (one.fence !== null && other.fence !== null && one.fence.fence === other.fence.fence
      && one.fence.quoted === other.fence.quoted && one.fence.listed === other.fence.listed));
}

/**
 * The plain text of a teacher's text. The line pass runs until it changes nothing: a pass never
 * adds a markdown delimiter, and each pass that changes a text removes at least one (`#`, `*`, `_`, `[`, `<`,
 * `|`, `-` or `=`) or only trims a table row's whitespace, so the delimiter count and then the length fall
 * and the loop ends; its result is a fixed point by construction.
 *
 * A pass after the first reads only the lines the last one can have changed: it starts at the line before the
 * last pass's first change, whose state that pass recorded, and stops at the first line past its last change
 * (with the line before it) that it would read in the state the last pass read it in, as from there it would
 * read every line as that pass did, and that pass changed none of them. So a pass costs the lines it changes and
 * a few beside them, and a line removed (a setext underline) that brings the next one up to the paragraph costs
 * one short pass, not a pass over the whole text: the result is the same as passes over every line.
 */
export function plainTextOf(text: string): string {
  const lines = text.split('\n');
  // The lines in order, linked so that a line that goes drops out where it stood, and the state each was last read in.
  const before = lines.map((_, at) => at - 1);
  const after = lines.map((_, at) => (at + 1 < lines.length ? at + 1 : -1));
  const states: LineState[] = [];
  let head = 0;
  let from = 0;
  let quiet = Infinity;   // the last pass changed no line after this one; the first pass reads every line
  for (let first = 0; first >= 0; ) {
    first = -1;
    let last = -1;
    const state: LineState = from < states.length ? { ...states[from] } : { fence: null, inComment: false, paragraph: false, inList: false, table: false };
    let previous = before[from];
    let previousRaw = previous >= 0 ? lines[previous] : undefined;
    for (let at = from; at >= 0; ) {
      if (previous > quiet && sameState(state, states[at])) break;
      states[at] = { ...state };
      const raw = lines[at];
      const next = after[at];
      const done = readLine(raw, previousRaw, next >= 0 ? lines[next] : undefined, state);
      if (done !== raw) {
        if (first < 0) first = at;
        last = at;
        if (done !== null) lines[at] = done;
        else {
          if (before[at] >= 0) after[before[at]] = next; else head = next;
          if (next >= 0) before[next] = before[at];
        }
      }
      previous = at;
      previousRaw = raw;   // the next line reads this one as it was, even when it went
      at = next;
    }
    quiet = last;
    if (first >= 0) from = before[first] >= 0 ? before[first] : head;
  }
  let out = '';
  for (let at = head; at >= 0; at = after[at]) out += (at === head ? '' : '\n') + lines[at];
  return out;
}

/** A line's text with each comment that closes on it removed, and where a comment opens and does not close on it (-1 when none does). */
function uncommented(line: string): { shown: string; open: number } {
  const { pieces, open } = heldPieces(line);
  let shown = '';
  let from = 0;
  for (const piece of pieces) {
    if (!line.startsWith(COMMENT_OPEN, piece.at)) continue;
    shown += line.slice(from, piece.at);
    from = piece.at + piece.length;
  }
  return { shown: shown + line.slice(from, open >= 0 ? open : line.length), open };
}

/**
 * The text as every display shows it: each HTML comment outside code removed, nothing else
 * changed. A code span, a fenced block and a line indented four spaces or a tab keep a `<!--` they hold, as
 * `plainTextOf` reads them as code; a comment that never closes is shown as stored. A line that held only
 * comments becomes a blank line, or goes where a blank line is already beside it, so a comment on its own
 * paragraph leaves one blank line; every other line keeps its leading whitespace and its line ending.
 */
export function withoutHtmlComments(text: string): string {
  const first = text.indexOf(COMMENT_OPEN);
  if (first < 0 || text.indexOf(COMMENT_CLOSE, first + COMMENT_OPEN.length) < 0) return text;
  const lines = text.split('\n');
  // The lines that hold a close, in order, and the first of them not yet passed, so each is looked for once.
  const closes = lines.flatMap((one, at) => (one.includes(COMMENT_CLOSE) ? [at] : []));
  let nextClose = 0;
  const out: string[] = [];
  let fence: OpenFence | null = null;
  let emptied = false;   // the line before was emptied by a removed comment
  const lastBlank = () => out.length === 0 || out[out.length - 1].replace(/\r$/, '').trim() === '';
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    if (fence !== null) { out.push(raw); emptied = false; if (fenceClosedBy(line, fence)) fence = null; continue; }
    if (line.trim() === '') { if (!(emptied && lastBlank())) out.push(raw); emptied = false; continue; }
    const opening = fenceOpenedBy(line);
    if (opening) { fence = opening; out.push(raw); emptied = false; continue; }
    if (INDENTED.test(line)) { out.push(raw); emptied = false; continue; }
    let shown = '';
    let rest = line;
    let restCr = cr;
    let held = false;   // a comment was removed from this line
    for (;;) {
      const part = uncommented(rest);
      if (part.shown !== (part.open >= 0 ? rest.slice(0, part.open) : rest)) held = true;
      shown += part.shown;
      if (part.open < 0) break;
      while (nextClose < closes.length && closes[nextClose] <= index) nextClose += 1;
      const closeAt = nextClose < closes.length ? closes[nextClose] : -1;
      if (closeAt < 0) { shown += rest.slice(part.open); break; }   // a comment that never closes is shown as stored
      held = true;
      index = closeAt;
      const closeRaw = lines[index];
      restCr = closeRaw.endsWith('\r') ? '\r' : '';
      const closeLine = restCr ? closeRaw.slice(0, -1) : closeRaw;
      rest = closeLine.slice(closeLine.indexOf(COMMENT_CLOSE) + COMMENT_CLOSE.length);
    }
    if (held && shown.trim() === '') {
      if (!lastBlank()) out.push(restCr);
      emptied = true;
      continue;
    }
    out.push(shown + restCr);
    emptied = false;
  }
  return out.join('\n');
}
/** Whether the text holds an HTML comment a display removes (one outside code, closed). */
export function holdsHtmlComment(text: string): boolean {
  return withoutHtmlComments(text) !== text;
}
export function isPlainText(text: string): boolean {
  return plainTextOf(text) === text;
}

/**
 * The members a phase's warning names, in `MEMBER_ORDER`. A draft's conversion also names a ticket's lines
 * and a provided story's text, which only an editor's draft holds, after the others.
 */
export type PlainTextMember = 'brief' | 'task title' | 'intro' | 'objectives' | 'rubric sentences' | 'quiz text' | 'ticket lines' | 'story lines';
const MEMBER_ORDER: readonly PlainTextMember[] = ['brief', 'task title', 'intro', 'objectives', 'rubric sentences', 'quiz text', 'ticket lines', 'story lines'];
/** The members whose name is plural, so a warning naming one alone reads "them". */
const PLURAL_MEMBERS: ReadonlySet<PlainTextMember> = new Set(['objectives', 'rubric sentences', 'ticket lines', 'story lines']);

/** The members named in `MEMBER_ORDER`, joined as "brief, intro and objectives", and whether they read as one thing. */
function memberList(members: readonly PlainTextMember[]): { list: string; one: boolean } {
  const named = MEMBER_ORDER.filter((one) => members.includes(one));
  const one = named.length === 1 && !PLURAL_MEMBERS.has(named[0]);
  const list = named.length <= 1 ? named.join('') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return { list, one };
}

/** "Implementation's brief had markdown in it. It was kept as plain text, every word in place; read it in the editor." */
export function markdownKeptWarning(phaseTitle: string, members: readonly PlainTextMember[]): string {
  const { list, one } = memberList(members);
  return one
    ? `${possessive(phaseTitle)} ${list} had markdown in it. It was kept as plain text, every word in place; read it in the editor.`
    : `${possessive(phaseTitle)} ${list} had markdown in them. They were kept as plain text, every word in place; read them in the editor.`;
}

/**
 * "Implementation's brief holds an HTML comment. Learners do not see it; read it in the editor."
 * Once per phase, naming every member that holds one, in `MEMBER_ORDER`.
 */
export function htmlCommentWarning(phaseTitle: string, members: readonly PlainTextMember[]): string {
  const { list, one } = memberList(members);
  return one
    ? `${possessive(phaseTitle)} ${list} holds an HTML comment. Learners do not see it; read it in the editor.`
    : `${possessive(phaseTitle)} ${list} hold HTML comments. Learners do not see them; read them in the editor.`;
}

/**
 * "Implementation's brief held only markup and is now empty; fill it in." A draft's
 * conversion, at boot or at its first save, stored a member that held only markup (a `#` or `---` alone) as
 * an empty text. Those two are not doors, so they do not refuse it; they say so on its phase, once, naming
 * every member it emptied, in `MEMBER_ORDER`.
 */
export function markupOnlyWarning(phaseTitle: string, members: readonly PlainTextMember[]): string {
  const { list, one } = memberList(members);
  return one
    ? `${possessive(phaseTitle)} ${list} held only markup and is now empty; fill it in.`
    : `${possessive(phaseTitle)} ${list} held only markup and are now empty; fill them in.`;
}

/**
 * The notes of a draft's conversion that name one phase, by the phase's title: every note is a
 * `markdownKeptWarning`, `markupOnlyWarning` or `htmlCommentWarning` sentence, which opens with the title's
 * possessive. The six titles hold none that opens another, so a note is on one phase only.
 */
export function plainTextNotesOn(notes: readonly string[], phaseTitle: string): string[] {
  const opening = `${possessive(phaseTitle)} `;
  return notes.filter((note) => note.startsWith(opening));
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}
