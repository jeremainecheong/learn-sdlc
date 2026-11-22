/**
 * Change impact: the call graph the analyzer resolved, with the report's
 * verdict on each function, added, changed or unchanged, and the tests that
 * reach it.
 *
 * The report carries two halves of this. `impact.functions` says what moved
 * and which cases reach each function; `staticAnalysis.functions` says who
 * calls whom. Neither is a drawing, so the layout is done here: one band per
 * file, functions in reading order inside it, and an arrow from a caller to
 * what it calls.
 */
import type { AnalyzerFunction, AnalyzerReport, ImpactFunction, ImpactReport } from '@learnsdlc/shared';
import { ANALYZER_UNAVAILABLE_RULE, andList } from '@learnsdlc/shared';
import { NOT_MEASURED_REASON, analysisNotMeasured } from '@/components/pr/analysisReach';
import { GRAPH_MIN_WIDTH } from '../graph-size';

export type ChangeMark = ImpactFunction['change'];

export interface ImpactNode {
  name: string;
  label: string;
  path: string;
  line: number;
  complexity: number;
  change: ChangeMark;
  /** Test case names that reach this function. */
  reachedBy: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImpactBand {
  path: string;
  label: string;
  count: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImpactEdge {
  key: string;
  d: string;
}

export interface ImpactGraph {
  bands: ImpactBand[];
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  width: number;
  height: number;
  /** Functions the report carried, so a truncated drawing can say so. */
  total: number;
}

export const MARK_GLYPH: Record<ChangeMark, string> = {
  added: '+',
  changed: '~',
  unchanged: '=',
  removed: '−',
};

export const MARK_WORD: Record<ChangeMark, string> = {
  added: 'Added',
  changed: 'Changed',
  unchanged: 'Unchanged',
  removed: 'Removed',
};

const PAD = 6;
const BAND_PAD = 8;
const HDR = 22;
const NODE_H = 48;
const ROW_GAP = 12;
const COL_GAP = 14;
const BAND_GAP = 26;
const NAME_CHAR = 7.3; // mono, 12.5px
const SUB_CHAR = 6.5; // 12px
const MAX_NODES = 30;

/** `TaskManager.complete_task` → `complete_task`; the file already names the class. */
export function shortName(name: string): string {
  const cut = name.lastIndexOf('.');
  return cut === -1 ? name : name.slice(cut + 1);
}

/**
 * "3 tests, cx 6": the sub-line inside a box, where the width is half a
 * column: how many tests reach the function and its complexity, reach first
 * because reach is what the bar under it measures.
 *
 * The API counts a test as reaching a function when the test's NAME spells the
 * function out or names its subject (`reachedBy` in `apps/api/src/feedback/impact.ts`);
 * it never traces a call. So a box no test name matches reads "no test by name":
 * a plain "no test" beside a change suite that passed in full read as
 * if the learner's new code were never run.
 */
export function nodeSub(node: { complexity: number; reachedBy: string[] }): string {
  const tests = node.reachedBy.length;
  return `${tests === 0 ? 'no test by name' : tests === 1 ? '1 test' : `${tests} tests`}, cx ${node.complexity}`;
}

/**
 * One function's key in a drawing: its file and its name. Two files often hold a
 * function of the same name (`get_task` in a repository and in the route over
 * it), and keyed by name alone the second box took the first one's place: its
 * mark, its arrows and its React key.
 */
export const fnKey = (fn: { path: string; name: string }): string => `${fn.path}::${fn.name}`;

/** A file the earlier reading held and this review did not read, with how many of its functions are left out. */
export interface UnreadFile {
  path: string;
  count: number;
}

/**
 * Which "removed" marks are true.
 *
 * The API compares the analyzer's reading at the end of Implementation with the
 * reading of this Maintenance review and marks every earlier function it did
 * not find again as removed (`buildImpactReport`). The two reviews read
 * different files: each reads its own phase's editable targets. A file
 * Implementation edited that Maintenance only mounts read-only (TaskTrackr's
 * `api/routes/tasks.py`) is not read the second time, so every one of its
 * functions came back "removed" while the app still runs them.
 *
 * A function stays removed only where this review read its file: a function of
 * this reading sits in it, or it is a file the learner edits in this phase (an
 * edited file emptied of functions is still read). The others are taken out of
 * the reading and their files named, so the After graph can say they were not
 * compared rather than draw them as deleted. Nothing else moves: added, changed
 * and unchanged rows, and a reading with no such file, come back as they were.
 */
export function readScope(
  impact: ImpactReport | undefined,
  analyzed: AnalyzerFunction[],
  editablePaths: string[] = [],
): { impact: ImpactReport | undefined; unread: UnreadFile[] } {
  if (!impact) return { impact, unread: [] };
  const read = new Set<string>([...editablePaths, ...analyzed.map((f) => f.path)]);
  const unread = new Map<string, number>();
  // A report kept without a list is drawn without functions (`impactNodes` reads `functions ?? []`).
  const kept = (impact.functions ?? []).filter((f) => {
    if (f.change !== 'removed' || read.has(f.path)) return true;
    unread.set(f.path, (unread.get(f.path) ?? 0) + 1);
    return false;
  });
  if (unread.size === 0) return { impact, unread: [] };
  return {
    impact: { ...impact, functions: kept },
    unread: [...unread].map(([path, count]) => ({ path, count })),
  };
}

/**
 * The line under the After graph naming the files it leaves out, or null when
 * it leaves none out. "api/routes/tasks.py (14 functions) is not a file you
 * edit in this phase, so this review did not read it again: it is left out
 * here, not removed."
 *
 * The dossier's impact table says the same line under it: `where` names
 * the table there, and in the teacher's copy (`who`) "you" would be the
 * teacher, so it says "the learner edits". Both left out, the line is the
 * graph's, word for word.
 *
 * `editsKnown` false: the files the person edits are not known (the dossier's
 * copy of a revision whose snapshot retention has pruned holds no files, so only
 * the analyzer's paths count as read). Then the line says only what is known,
 * that this review read none of those functions again, and neither why nor that
 * they were not removed (a file emptied of its functions reads the same).
 */
export function unreadLine(unread: UnreadFile[], who: 'learner' | 'instructor' = 'learner', where = 'the graph after the change', editsKnown = true): string | null {
  if (unread.length === 0) return null;
  const named = unread.map((u) => `${u.path} (${u.count === 1 ? '1 function' : `${u.count} functions`})`);
  const list = andList(named);
  if (!editsKnown) {
    const one = unread.length === 1 && unread[0].count === 1;
    return one
      ? `${list}: this review did not read that function again, so it is left out of ${where}.`
      : `${list}: this review read none of these functions again, so they are left out of ${where}.`;
  }
  const edits = who === 'instructor' ? 'the learner edits' : 'you edit';
  return unread.length === 1
    ? `${list} is not a file ${edits} in this phase, so this review did not read it again: it is left out of ${where}, not removed.`
    : `${list} are not files ${edits} in this phase, so this review did not read them again: they are left out of ${where}, not removed.`;
}

/**
 * The code as it stood before the change: everything the change did not add.
 * The report names the added functions, so the earlier graph is this one with
 * those functions, and every call to or from them, taken out.
 */
export function withoutAdded(
  impact: ImpactReport | undefined,
  analyzed: AnalyzerFunction[],
): { impact: ImpactReport | undefined; analyzed: AnalyzerFunction[] } {
  // By file and name: an added `get_task` in a new file is not the old one.
  const added = new Set((impact?.functions ?? []).filter((f) => f.change === 'added').map(fnKey));
  if (added.size === 0) return { impact, analyzed };
  return {
    impact: impact ? { ...impact, functions: impact.functions.filter((f) => !added.has(fnKey(f))) } : undefined,
    analyzed: analyzed.filter((f) => !added.has(fnKey(f))),
  };
}

/**
 * The functions to draw. The impact section is the authority on what moved, so
 * it leads; a function the analyzer resolved but the impact section never
 * mentions is still drawn, as unchanged, rather than silently dropped.
 */
export function impactNodes(impact: ImpactReport | undefined, analyzed: AnalyzerFunction[]): ImpactFunction[] {
  const out: ImpactFunction[] = [];
  const seen = new Set<string>();
  for (const fn of impact?.functions ?? []) {
    seen.add(fnKey(fn));
    out.push(fn);
  }
  for (const fn of analyzed) {
    if (seen.has(fnKey(fn))) continue;
    seen.add(fnKey(fn));
    out.push({
      name: fn.name,
      path: fn.path,
      line: fn.line,
      endLine: fn.endLine,
      complexity: fn.complexity,
      change: 'unchanged',
      reachedBy: [],
    });
  }
  return out;
}

/**
 * Who calls whom, from the analyzer's own reading of the code, as pairs of
 * {@link fnKey}s. A call names a function only by its name, so where two files
 * hold that name the one in the caller's own file is meant, else the first one
 * drawn (never the last one drawn, which would take every such arrow).
 */
function callPairs(analyzed: AnalyzerFunction[], shown: ImpactFunction[]): [string, string][] {
  const known = new Set(shown.map(fnKey));
  const byName = new Map<string, string[]>();
  for (const f of shown) byName.set(f.name, [...(byName.get(f.name) ?? []), fnKey(f)]);
  const pairs: [string, string][] = [];
  for (const fn of analyzed) {
    const from = fnKey(fn);
    if (!known.has(from)) continue;
    const seen = new Set<string>();
    for (const call of fn.calls) {
      const keys = byName.get(call);
      if (!keys || call === fn.name || seen.has(call)) continue;
      seen.add(call);
      pairs.push([from, keys.find((k) => k === fnKey({ path: fn.path, name: call })) ?? keys[0]]);
    }
  }
  return pairs;
}

/** How deep a function sits in the call chain: 0 for an entry point. */
function depths(names: string[], pairs: [string, string][]): Map<string, number> {
  const depth = new Map<string, number>();
  const called = new Set(pairs.map(([, to]) => to));
  names.forEach((n) => depth.set(n, called.has(n) ? -1 : 0));
  for (let pass = 0; pass < names.length; pass += 1) {
    let moved = false;
    for (const [from, to] of pairs) {
      const next = Math.min(names.length, Math.max(0, depth.get(from) ?? 0) + 1);
      if (next > (depth.get(to) ?? -1)) {
        depth.set(to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  names.forEach((n) => {
    if ((depth.get(n) ?? 0) < 0) depth.set(n, 0);
  });
  return depth;
}

/**
 * Lay the graph out in file bands, callers above what they call. Width is the
 * pane's, so the drawing wraps rather than running off the side; when a row of
 * boxes cannot fit, the canvas keeps its own width and the pane scrolls it.
 */
export function buildImpactGraph(
  impact: ImpactReport | undefined,
  analyzed: AnalyzerFunction[],
  width: number,
): ImpactGraph {
  const all = impactNodes(impact, analyzed);
  const total = all.length;
  const shown = all.slice(0, MAX_NODES);
  if (shown.length === 0) return { bands: [], nodes: [], edges: [], width: 0, height: 0, total };

  const pairs = callPairs(analyzed, shown);
  const depth = depths(shown.map(fnKey), pairs);

  // One band per file, shallowest caller first, so the entry point is on top.
  const order = new Map<string, number>();
  const first = new Map<string, number>();
  shown.forEach((f, i) => {
    const d = depth.get(fnKey(f)) ?? 0;
    order.set(f.path, Math.min(order.get(f.path) ?? d, d));
    if (!first.has(f.path)) first.set(f.path, i);
  });
  const paths = [...order.keys()].sort((a, b) => {
    const d = (order.get(a) ?? 0) - (order.get(b) ?? 0);
    return d !== 0 ? d : (first.get(a) ?? 0) - (first.get(b) ?? 0);
  });

  const canvas = Math.max(GRAPH_MIN_WIDTH, width);
  const bandW = canvas - PAD * 2;
  const inner = bandW - BAND_PAD * 2;

  // One node width for the whole drawing: a band of ragged boxes reads as a
  // chart of different things, which these are not.
  const desired = shown.reduce((max, f) => {
    const name = shortName(f.name).length * NAME_CHAR + 20 + 22;
    const sub = nodeSub(f).length * SUB_CHAR + 20;
    return Math.max(max, name, sub);
  }, 104);
  const nodeW = Math.max(96, Math.min(Math.round(desired), inner));
  const perRow = Math.max(1, Math.floor((inner + COL_GAP) / (nodeW + COL_GAP)));

  const bands: ImpactBand[] = [];
  const nodes: ImpactNode[] = [];
  const at = new Map<string, ImpactNode>();
  let y = PAD;

  for (const path of paths) {
    const members = shown.filter((f) => f.path === path);
    const rows = Math.ceil(members.length / perRow);
    const h = HDR + rows * (NODE_H + ROW_GAP) - ROW_GAP + BAND_PAD;
    bands.push({ path, label: path, count: members.length, x: PAD, y, w: bandW, h });
    members.forEach((f, i) => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const node: ImpactNode = {
        name: f.name,
        label: shortName(f.name),
        path: f.path,
        line: f.line,
        complexity: f.complexity,
        change: f.change,
        reachedBy: f.reachedBy,
        x: PAD + BAND_PAD + c * (nodeW + COL_GAP),
        y: y + HDR + r * (NODE_H + ROW_GAP),
        w: nodeW,
        h: NODE_H,
      };
      nodes.push(node);
      at.set(fnKey(f), node);
    });
    y += h + BAND_GAP;
  }

  const height = y - BAND_GAP + PAD;
  let rightmost = canvas;
  const edges: ImpactEdge[] = [];
  for (const [from, to] of pairs) {
    const a = at.get(from);
    const b = at.get(to);
    if (!a || !b) continue;
    const key = `${from}->${to}`;
    if (b.y > a.y) {
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      const bow = Math.max(12, (y2 - y1) / 2);
      edges.push({ key, d: `M${x1} ${y1} C ${x1} ${y1 + bow}, ${x2} ${y2 - bow}, ${x2} ${y2}` });
      continue;
    }
    if (b.y === a.y && b.x > a.x) {
      const yy = a.y + a.h / 2;
      edges.push({ key, d: `M${a.x + a.w} ${yy} L ${b.x} ${yy}` });
      continue;
    }
    // A call back up, or leftwards along a row, would run through the boxes.
    const out = Math.max(a.x + a.w, b.x + b.w) + 18;
    rightmost = Math.max(rightmost, out + 6);
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    edges.push({ key, d: `M${a.x + a.w} ${y1} C ${out} ${y1}, ${out} ${y2}, ${b.x + b.w} ${y2}` });
  }

  return { bands, nodes, edges, width: rightmost, height, total };
}

/** The counts the section header reads out: "1 added, 1 changed, 4 unchanged". */
export function markCounts(nodes: ImpactFunction[]): { mark: ChangeMark; n: number }[] {
  const marks: ChangeMark[] = ['added', 'changed', 'removed', 'unchanged'];
  return marks
    .map((mark) => ({ mark, n: nodes.filter((f) => f.change === mark).length }))
    .filter((r) => r.n > 0);
}

/**
 * Why a verdict carries no impact reading, from its own static analysis. The
 * API writes none when the current or the earlier reading's function LIST is
 * empty (apps/api/src/feedback/impact.ts, buildImpactReport: `functions ?? []`
 * on each side), so this decides on the list too, not on `metrics.functions`,
 * which for JavaScript also counts anonymous callbacks the list leaves out
 * (apps/api/runner/analyzer.py). In order:
 * - `unavailable`: the analyzer could not run (its one notice);
 * - `unread`: it read no file (it reads Python and JavaScript only);
 * - `no-baseline`: the list holds a function, so the side that was empty is the
 *   earlier one: there was no earlier reading of these functions to compare with;
 * - `no-function`: it counted no function in the files it read;
 * - `no-named-function`: it counted functions (`function` or `=>` in
 *   JavaScript) but listed none, because none of them is named;
 * - `no-list`: it counted functions, but the report carries no list (one made
 *   before the analyzer listed them).
 * `none` is a verdict with no analysis.
 */
export type ImpactAbsence = 'unavailable' | 'unread' | 'no-baseline' | 'no-function' | 'no-named-function' | 'no-list' | 'none';

export function impactAbsence(analysis: AnalyzerReport | null | undefined): ImpactAbsence {
  if (!analysis) return 'none';
  if (analysis.issues.some((i) => i.rule === ANALYZER_UNAVAILABLE_RULE)) return 'unavailable';
  if (analysisNotMeasured(analysis)) return 'unread';
  if ((analysis.functions?.length ?? 0) > 0) return 'no-baseline';
  if (analysis.metrics.functions === 0) return 'no-function';
  return analysis.functions ? 'no-named-function' : 'no-list';
}

/** NOT_MEASURED_REASON without its full stop, to lead a longer sentence. */
const UNREAD_CLAUSE = NOT_MEASURED_REASON.replace(/\.$/, '');

/**
 * The Change impact card's empty state. Before a review it is the graph still
 * to come. After one with no impact reading, submitting again would not bring
 * one: it says why, from the verdict's static analysis (`impactAbsence`). With
 * no analysis, or files read with no function counted in them, it says no
 * function was read. While a submission is queued or running it says the review is running.
 */
export function emptyImpact(
  pr: string,
  reviewed: boolean,
  running = false,
  analysis?: AnalyzerReport | null,
): { title: string; body: string } {
  if (reviewed) {
    const why = impactAbsence(analysis);
    const body =
      why === 'unavailable'
        ? `The analyzer could not run in the review of ${pr}, so there is no call graph to draw.`
        : why === 'unread'
          ? `${UNREAD_CLAUSE}, so the review of ${pr} has no call graph to draw.`
          : why === 'no-baseline'
            ? `The review of ${pr} had no earlier reading of these functions to compare with, so there is no call graph to draw.`
            : why === 'no-named-function'
              ? `The review of ${pr} counted functions in your files but could not name any of them, so there is no call graph to draw.`
              : why === 'no-list'
                ? `The review of ${pr} kept no list of the functions in your files, so there is no call graph to draw.`
                : `The review of ${pr} read no function in your files, so there is no call graph to draw.`;
    return { title: 'No call graph', body };
  }
  // A submission queued or running: asking for another would not bring the graph sooner.
  if (running) return { title: 'No call graph yet', body: `The review of ${pr} is running. The graph is drawn from the static analysis in its verdict.` };
  return { title: 'No call graph yet', body: `The graph is drawn from the static analysis in the verdict. Submit ${pr} to get one.` };
}
