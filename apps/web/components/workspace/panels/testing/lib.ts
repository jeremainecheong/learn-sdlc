/**
 * Reading the testing phase from what the workspace already knows: the test
 * functions the learner has written, the criteria those tests can point at,
 * the first-red/first-green record of every run, and the kill matrix.
 *
 * Everything here is pure. The panel never fetches; these functions turn
 * props (files, runs, the last verdict) into the rows the panel draws.
 */
import type { ExecutionRunView, MutantRow, PhaseDetail, PhaseLink } from '@learnsdlc/shared';

/** A test function found in the learner's test file. */
export interface TestFn {
  /** The name the runner reports, e.g. test_overdue_lists_yesterday. */
  name: string;
  path: string;
  line: number;
  /** The enclosing unittest class, when there is one. */
  suite?: string;
}

/** A criterion a test can be linked to. */
export interface Criterion {
  /** US-3/AC-2, or US-3 when the story numbers no criteria. */
  id: string;
  /** The outcome the criterion promises, when a story file spells it out. */
  title?: string;
  /** Where the id came from, so a row can say why it is on the list. */
  note?: string;
  // The criterion's own words, before `shortTitle`
  // trims them, so the design phase can quote the sentence a contract
  // contradicts. Optional: every existing reader takes `title`.
  text?: string;
}

/** Tests are capped so a pasted file cannot turn the panel into a wall. */
const MAX_TESTS = 200;

/* ------------------------------- test files ------------------------------ */

/** The editable files that hold tests, in the order the phase declares them. */
export function testFiles(detail: PhaseDetail): { path: string; language: string }[] {
  const editable = detail.files.filter((f) => f.editable);
  const ordered = [
    ...editable.filter((f) => /(^|\/)tests?\//.test(f.path)),
    ...editable.filter((f) => /test/i.test(base(f.path))),
  ];
  return ordered
    .filter((f, i, all) => all.findIndex((o) => o.path === f.path) === i)
    .map((f) => ({ path: f.path, language: f.language }));
}

function base(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

const PY_CLASS = /^class\s+([A-Za-z_]\w*)/;
const PY_DEF = /^\s*def\s+(test\w*)\s*\(/;
const JS_TEST = /(?:^|[^\w.$])(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/;

/**
 * The test functions in one file: `def test_…` for Python (with the enclosing
 * class, because that is how unittest names the case) and `test('…')` /
 * `it('…')` for JavaScript.
 */
export function parseTests(path: string, text: string): TestFn[] {
  const js = /\.[cm]?[jt]sx?$/.test(path);
  const out: TestFn[] = [];
  const lines = text.split('\n');
  let suite: string | undefined;
  for (let i = 0; i < lines.length && out.length < MAX_TESTS; i += 1) {
    const line = lines[i];
    if (js) {
      const m = JS_TEST.exec(line);
      if (m && m[2].trim()) out.push({ name: m[2].trim(), path, line: i + 1 });
      continue;
    }
    const cls = PY_CLASS.exec(line);
    if (cls) {
      suite = cls[1];
      continue;
    }
    const def = PY_DEF.exec(line);
    if (def) out.push({ name: def[1], path, line: i + 1, suite });
  }
  return out.filter((t, i, all) => all.findIndex((o) => o.name === t.name) === i);
}

/**
 * The runner reports a Python case as `Class.method`; the file only knows
 * `method`. Compare on the last segment so both sides meet.
 *
 * A DOM-harness case is the sentence the learner wrote, and a full stop in it
 * is not a class prefix: "a late task wears the badge." must not become "".
 * Strip only what is shaped like a Python identifier pair.
 */
const UNITTEST_CASE = /^[A-Za-z_]\w*\.([A-Za-z_]\w*)$/;
export function caseKey(name: string): string {
  const m = UNITTEST_CASE.exec(name);
  return m ? m[1] : name;
}

/* -------------------------------- criteria ------------------------------- */

const STORY_HEAD = /^#{2,3}\s+(US-\d+)\b(.*)$/;
const AC_BULLET = /^\s*[-*]\s+\*\*(AC-\d+)\*\*\s*[—–-]*\s*(.*)$/;
/** A version's story prefixes as one alternation; a prefix is capitals (and digits after the first) only, so nothing needs escaping. */
const prefixAlternation = (prefixes: readonly string[]): string => {
  const plain = prefixes.filter((one) => /^[A-Z][A-Z0-9]{0,4}$/.test(one) && one !== 'AC');
  return (plain.length ? plain : ['US']).join('|');
};
/** A story or criterion id anywhere in the brief, in the version's own story prefixes (`US` by default). */
const idAnywhere = (prefixes: readonly string[]): RegExp => new RegExp(`\\b(?:${prefixAlternation(prefixes)})-\\d+(?:\\/AC-\\d+)?`, 'g');
/**
 * A story heading in a story file of a teacher's own application, which
 * numbers its stories its own way (the shelf example's `## SH-1 …`): a
 * markdown heading, so only a line the author marked as a story. Where the
 * pack heads its stories in such a file, or a graded matrix names them,
 * those id families are the stories. Acceptance criteria, encodings,
 * standards, hashes, protocols, advisories and pull requests are not stories.
 */
const OWN_STORY_HEAD = /^#{2,3}\s+((?!(?:AC|UTF|ISO|RFC|PEP|PR|SHA|HTTPS?|IPV|TLS|SSL|CVE)-)[A-Z]{1,5}-\d{1,3})\b(.*)$/;
/**
 * The brief is plain text: a heading is its own line with its `#`
 * gone and a criterion's id has lost its stars, so the brief's story line is a
 * line that opens with the id (within three spaces), its `##` read as well,
 * and a criterion is a list item that opens with `AC-n`, starred or not. Only
 * the brief is read this way; a story file is the learner's markdown.
 *
 * A plain brief has no heading left to tell a story line from any other line
 * that opens with an id-shaped token ("API-1 returns the shelf", "ID-7 is the
 * ticket"), so every brief, a teacher's own application's included, offers
 * only `<prefix>-n` stories and their `AC-n` criteria, where a prefix is one
 * the version's own stories use (`PhaseDetail.storyPrefixes`, read from its
 * Requirements phase's provided stories: `SH` on a Shelf, `US` on TaskTrackr
 * and on a version with no Requirements stories). Grading never reads this
 * harvest: a link is checked by its shape and snapshotted, and the Testing
 * grade reads the server's mutation matrix.
 */
const plainStoryHead = (prefixes: readonly string[]): RegExp => new RegExp(`^ {0,3}(?:#{2,3}\\s+)?((?:${prefixAlternation(prefixes)})-\\d+)\\b(.*)$`);
const PLAIN_AC_BULLET = /^\s*[-*]\s+(?:\*\*)?(AC-\d+)(?:\*\*)?\s*[—–-]*\s*(.*)$/;
const storyFamily = (id: string) => id.slice(0, id.indexOf('-'));

/** The story ids a story file heads (`## SH-1 …`) on a teacher's own application. */
function ownStoryHeads(md: string): string[] {
  return md.split(/\r?\n/).flatMap((line) => OWN_STORY_HEAD.exec(line)?.[1] ?? []);
}

/** Criteria written out in a story markdown file: `## US-2 …` then `**AC-1** …` (or in a plain brief, `plain`: `SH-2 …` then `- AC-1 …`, in the version's own prefixes only). */
export function parseStories(
  md: string,
  /**
   * `reference: false` reads an own application's story file headings; `plain` reads a plain brief's lines,
   * whose stories are in `prefixes` (the version's own, `['US']` when absent).
   */
  opts: { reference?: boolean; plain?: boolean; prefixes?: readonly string[] } = {},
): Criterion[] {
  const storyHead = opts.plain ? plainStoryHead(opts.prefixes ?? ['US']) : opts.reference === false ? OWN_STORY_HEAD : STORY_HEAD;
  const acBullet = opts.plain ? PLAIN_AC_BULLET : AC_BULLET;
  const out: Criterion[] = [];
  const lines = md.split(/\r?\n/);
  let story: string | null = null;
  let open: { id: string; parts: string[] } | null = null;
  const close = () => {
    if (open) {
      const said = open.parts.join(' ');
      out.push({ id: open.id, title: shortTitle(said), text: said });
    }
    open = null;
  };
  for (const line of lines) {
    const head = storyHead.exec(line);
    if (head) {
      close();
      story = head[1];
      continue;
    }
    const ac = acBullet.exec(line);
    if (ac && story) {
      close();
      open = { id: `${story}/${ac[1]}`, parts: [ac[2]] };
      continue;
    }
    if (open) {
      // A criterion bullet wraps; its continuation lines are indented and are
      // neither a new bullet nor a heading.
      if (/^\s+\S/.test(line) && !/^\s*[-*]\s/.test(line) && !line.trimStart().startsWith('#')) {
        open.parts.push(line.trim());
      } else if (line.trim() === '' || /^\s*[-*]\s/.test(line) || line.trimStart().startsWith('#')) {
        close();
      }
    }
  }
  close();
  return out;
}

/** The outcome half of a Given/When/Then, trimmed to a row title. */
export function shortTitle(text: string): string {
  const flat = text
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const then = / then /i.exec(flat);
  let s = then ? flat.slice(then.index + then[0].length) : flat;
  s = s.replace(/[.;,]+$/, '').trim();
  if (s.length > 90) s = `${s.slice(0, 89).trimEnd()}…`;
  return s ? s[0].toUpperCase() + s.slice(1) : flat;
}

function idOrder(id: string): [number, number] {
  const m = /US-(\d+)(?:\/AC-(\d+))?/.exec(id);
  return m ? [Number(m[1]), m[2] ? Number(m[2]) : 0] : [999, 0];
}

/**
 * Every criterion this phase can point a test at. A story file is the best
 * source because it carries the wording; failing that, the planted bugs name
 * the criteria they break, the saved links name the ones already used, and the
 * brief names the stories in scope.
 */
export function collectCriteria(
  storyFiles: { path: string; text: string }[],
  matrix: MutantRow[],
  links: PhaseLink[],
  briefText: string,
  /**
   * `reference: false` on a teacher's own application. Absent reads as the reference. `prefixes`: the version's
   * own story prefixes (`PhaseDetail.storyPrefixes`), `['US']` when absent.
   */
  opts: { reference?: boolean; prefixes?: readonly string[] } = {},
): Criterion[] {
  const prefixes = opts.prefixes ?? ['US'];
  const byId = new Map<string, Criterion>();
  const add = (c: Criterion) => {
    const prev = byId.get(c.id);
    if (!prev) byId.set(c.id, c);
    else if (!prev.title && c.title) byId.set(c.id, { ...prev, title: c.title });
  };
  const own = opts.reference === false;
  for (const f of storyFiles) for (const c of parseStories(f.text, { reference: opts.reference })) add({ ...c, note: base(f.path) });
  matrix.forEach((row, i) => {
    if (row.covers) add({ id: row.covers, note: `Named by planted bug B${i + 1}` });
  });
  for (const l of links) if (l.to) add({ id: l.to, note: 'From a link you saved' });
  // On an own application, the stories the pack heads in a story file (or a
  // graded matrix names) decide which id families the brief may add; the
  // brief itself offers stories in the version's own prefixes and `AC-n`
  // criteria only.
  const families = new Set<string>();
  if (own) {
    for (const f of storyFiles) for (const id of ownStoryHeads(f.text)) { add({ id, note: base(f.path) }); families.add(storyFamily(id)); }
    for (const c of parseStories(briefText, { plain: true, prefixes })) { add({ ...c, note: 'Named in the brief' }); families.add(storyFamily(c.id)); }
    for (const row of matrix) if (row.covers) families.add(storyFamily(row.covers));
  }
  for (const m of briefText.match(idAnywhere(prefixes)) ?? []) {
    if (own && families.size > 0 && !families.has(storyFamily(m))) continue;
    add({ id: m, note: 'Named in the brief' });
  }
  // A story id is only worth offering when nothing more precise came from it.
  const ids = [...byId.keys()];
  for (const id of ids) {
    if (!id.includes('/') && ids.some((o) => o.startsWith(`${id}/`))) byId.delete(id);
  }
  return [...byId.values()].sort((a, b) => {
    const [as, aa] = idOrder(a.id);
    const [bs, ba] = idOrder(b.id);
    return as - bs || aa - ba || a.id.localeCompare(b.id);
  });
}

/* ------------------------------ failing first ---------------------------- */

export type FirstState = 'red-first' | 'still-red' | 'never-red' | 'green-first' | 'unseen';

export interface FirstRecord {
  name: string;
  /** 1-based run number, counting every run for this phase oldest first. */
  firstRed: number | null;
  firstGreen: number | null;
  state: FirstState;
  /** The message the first red run reported, when it kept one. */
  redMessage?: string;
}

/** The first-red / first-green record for every test seen in the file or a run. */
export function failingFirst(runs: ExecutionRunView[], tests: TestFn[]): FirstRecord[] {
  const red = new Map<string, { run: number; message?: string }>();
  const green = new Map<string, number>();
  const seen: string[] = [];
  runs.forEach((run, i) => {
    for (const c of run.result?.tests?.cases ?? []) {
      const key = caseKey(c.name);
      if (!seen.includes(key)) seen.push(key);
      if (c.status === 'passed') {
        if (!green.has(key)) green.set(key, i + 1);
      } else if (!red.has(key)) {
        red.set(key, { run: i + 1, message: c.message });
      }
    }
  });
  const names = [...tests.map((t) => t.name), ...seen.filter((s) => !tests.some((t) => t.name === s))];
  return names.map((name) => {
    const r = red.get(name) ?? null;
    const g = green.get(name) ?? null;
    const state: FirstState =
      r && g ? (g > r.run ? 'red-first' : 'green-first') : r ? 'still-red' : g ? 'never-red' : 'unseen';
    return {
      name,
      firstRed: r ? r.run : null,
      firstGreen: g,
      state,
      ...(r?.message ? { redMessage: r.message } : {}),
    };
  });
}

/* ------------------------------- kill matrix ----------------------------- */

export type TestVerdict = 'kills-nothing' | 'load-bearing' | 'twin' | 'kills';

export interface MatrixView {
  /** The learner's tests as the matrix columns, in file order. */
  columns: { key: string; label: string; name: string; kills: string[]; verdict: TestVerdict; twinOf?: string }[];
  rows: { row: MutantRow; id: string; killers: string[]; ran: string[] }[];
  killed: number;
  total: number;
  /** True when no mutant ran a case: the suite did not pass on the reference copy. */
  unrun: boolean;
}

/** Turns the report's kill matrix into columns (tests) and rows (planted bugs). */
export function matrixView(matrix: MutantRow[], tests: TestFn[]): MatrixView {
  const fromCases: string[] = [];
  for (const row of matrix) {
    for (const c of row.cases) {
      const key = caseKey(c.name);
      if (!fromCases.includes(key)) fromCases.push(key);
    }
  }
  const keys = [
    ...tests.map((t) => t.name).filter((n) => fromCases.includes(n)),
    ...fromCases.filter((n) => !tests.some((t) => t.name === n)),
  ];
  const rows = matrix.map((row, i) => ({
    row,
    id: `B${i + 1}`,
    killers: keys.filter((k) => {
      const c = row.cases.find((x) => caseKey(x.name) === k);
      return Boolean(c && c.status !== 'passed');
    }),
    // A mutant is run against the suite of the run it belongs to and no other,
    // so a column this row never mentions is a test from the other layer: not
    // a test that let the bug through.
    ran: keys.filter((k) => row.cases.some((x) => caseKey(x.name) === k)),
  }));
  const kills = new Map<string, string[]>(keys.map((k) => [k, rows.filter((r) => r.killers.includes(k)).map((r) => r.id)]));
  const columns = keys.map((key, i) => {
    const mine = kills.get(key) ?? [];
    const sole = rows.some((r) => r.killers.length === 1 && r.killers[0] === key);
    const twin = keys.find(
      (o) => o !== key && mine.length > 0 && sameSet(kills.get(o) ?? [], mine),
    );
    const verdict: TestVerdict =
      mine.length === 0 ? 'kills-nothing' : sole ? 'load-bearing' : twin ? 'twin' : 'kills';
    return {
      key,
      label: `T${i + 1}`,
      name: key,
      kills: mine,
      verdict,
      ...(verdict === 'twin' && twin ? { twinOf: `T${keys.indexOf(twin) + 1}` } : {}),
    };
  });
  return {
    columns,
    rows,
    killed: matrix.filter((m) => m.killed).length,
    total: matrix.length,
    unrun: matrix.length > 0 && matrix.every((m) => m.cases.length === 0),
  };
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/* --------------------------------- links --------------------------------- */

/** The criterion each test is linked to, from the phase's saved links. */
export function linkMap(links: PhaseLink[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of links) {
    if (l.kind === 'verifies' && l.from && l.to && !out[l.from]) out[l.from] = l.to;
  }
  return out;
}

/**
 * The link set to save: everything this panel does not own, plus one
 * `verifies` link per test that has a criterion chosen. An unchanged link
 * keeps its timestamp, so the list stays an honest record of when it was made.
 */
export function nextLinks(links: PhaseLink[], draft: Record<string, string>, tests: TestFn[], at: string): PhaseLink[] {
  const owned = new Set(tests.map((t) => t.name));
  const kept = links.filter((l) => !(l.kind === 'verifies' && owned.has(l.from)));
  const made: PhaseLink[] = [];
  for (const t of tests) {
    const to = draft[t.name];
    if (!to) continue;
    const prev = links.find((l) => l.kind === 'verifies' && l.from === t.name && l.to === to);
    made.push({ from: t.name, to, kind: 'verifies', at: prev?.at ?? at });
  }
  return [...kept, ...made];
}

/**
 * The suite's link chip: how many tests have no `verifies` link to a
 * criterion. The count is real and the learner can act on it (the editor's
 * gutter offers the criteria, and the map draws the line), but a link is a
 * traceability claim the review does not grade, so it never reads as a fault:
 * it says what it counts, and on a passed phase it is quiet (the neutral tone)
 * rather than the warning it is while the phase is being worked. None at all
 * when every test is linked.
 */
export function unlinkedChip(
  unlinked: number,
  phasePassed: boolean,
): { tone: 'warn' | 'neutral'; text: string } | null {
  if (unlinked <= 0) return null;
  return {
    tone: phasePassed ? 'neutral' : 'warn',
    text: unlinked === 1 ? '1 test not linked to a criterion' : `${unlinked} tests not linked to a criterion`,
  };
}

/**
 * The explorer's line for the same count: the words the room has
 * always used, a warning while the phase is worked, and quiet (the dashed
 * square) once it has passed, as {@link unlinkedChip} is.
 */
export function unlinkedLine(unlinked: number, phasePassed: boolean): { state: 'warn' | 'todo'; text: string } | null {
  if (unlinked <= 0) return null;
  return {
    state: phasePassed ? 'todo' : 'warn',
    text: unlinked === 1 ? 'One test not linked to a criterion' : `${unlinked} tests not linked to a criterion`,
  };
}

/**
 * The Failing first tab's words. While the phase is worked they are
 * the ones it always had. On a passed phase they say why every test there is
 * green from its first run: in Testing the application is finished before a
 * test is written, so a test's red is against the planted bugs, not the code.
 */
export function failingFirstWords(phasePassed: boolean): { purpose: string; neverRed: string; neverRedState: 'warn' | 'done' } {
  return phasePassed
    ? {
        purpose:
          'In Testing the code already worked before your tests were written, so a test shows it can fail against the planted bugs, not here. The platform keeps the first run of each test.',
        neverRed: 'Green from its first run: the code already worked',
        neverRedState: 'done',
      }
    : {
        purpose:
          'A test proves something only if it was red before the code made it green. The platform keeps the first run of each test.',
        neverRed: 'Never seen red: written after the code passed',
        neverRedState: 'warn',
      };
}

/** The Testing room's chip for the planted bugs still alive: "1 bug alive", "3 bugs alive". */
export function bugsAliveText(alive: number): string {
  return `${alive} ${alive === 1 ? 'bug' : 'bugs'} alive`;
}

/* --------------------------------- copy ---------------------------------- */

/** The exception class a first red run reported, when the message names one. */
export function errorName(message: string | undefined): string | null {
  const m = /\b([A-Z]\w*(?:Error|Exception|Failure))\b/.exec(message ?? '');
  return m ? m[1] : null;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * "1 March 2026", from the ISO date the run clock is stored as.
 *
 * Read off the string rather than through `new Date`: `new Date('2026-03-01')`
 * is midnight UTC, and a reader west of Greenwich would be told their suite
 * ran on 28 February. Anything that is not `YYYY-MM-DD` is handed back as it
 * came, which is what the API stores and what a test would read.
 */
export function clockWords(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return date;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** "the clock 1 March 2026" or "the machine's clock", for a sentence. */
export function clockPhrase(date: string | null): string {
  return date ? `the clock ${clockWords(date)}` : "the machine's clock";
}

/** A test no planted bug depends on, in one phrase on the planted bugs page and in the workspace's grid. */
export const NO_BUG_BEHIND = 'No planted bug behind it';
