/**
 * The pull request, derived from what the API already returned. Everything a
 * revision, a thread, the ledger or the call graph needs comes off
 * `submissions` and each submission's report; nothing here fetches.
 */
import type {
  AnalyzerFunction,
  ContractClaim,
  FeedbackReport,
  PhaseKey,
  SubmissionView,
} from '@learnsdlc/shared';
import { PHASE_TITLES, pluralWord } from '@learnsdlc/shared';
import { scoreLabel, type StatusState } from '@/lib/phase';
import { messageHead } from '../../message-head';

/* -------------------------------- revisions ------------------------------- */

export interface Revision {
  id: string;
  /** 1-based, oldest first, as the API numbers it. */
  attempt: number;
  createdAt: string;
  score: number | null;
  report: FeedbackReport | null;
  state: StatusState;
  /** "14:32, 5 of 10 cases pass, 1 check failed" */
  detail: string;
  /** "Passed with 86" / "Scored 64 of 70" / "Running in the sandbox" */
  result: string;
  /**
   * What the learner said this revision changes, or null. Null covers both a
   * revision submitted with the field empty and one stored without the field:
   * to a reader of the log the two are the same thing.
   */
  message: string | null;
}

/** "1 revision", "3 revisions". Plurals the copy rules would otherwise leave ragged. */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${pluralWord(n, noun, plural)}`;
}

export function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function dateOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long' });
}

/** What ran, in one line: the cases first, then anything a check objected to. */
export function checksSummary(report: FeedbackReport): string {
  const parts: string[] = [];
  const tests = report.tests;
  if (tests && tests.total > 0) parts.push(`${tests.passed} of ${tests.total} cases pass`);
  const failed = report.checks.filter((c) => c.status === 'failed').length;
  const warned = report.checks.filter((c) => c.status === 'warning').length;
  if (failed > 0) parts.push(`${count(failed, 'check')} failed`);
  if (warned > 0) parts.push(`${count(warned, 'warning')}`);
  if (failed === 0 && warned === 0 && report.checks.length > 0) parts.push('every check passed');
  return parts.join(', ');
}

export function buildRevisions(submissions: SubmissionView[], threshold: number): Revision[] {
  return submissions.map((s, i) => {
    const attempt = s.attempt ?? i + 1;
    const time = timeOf(s.createdAt);
    if (s.status === 'failed') {
      return {
        id: s.id,
        attempt,
        createdAt: s.createdAt,
        score: null,
        report: null,
        state: 'fail' as StatusState,
        detail: [time, s.error || 'The review failed to run'].filter(Boolean).join(', '),
        result: 'Review unavailable',
        message: s.commitMessage ?? null,
      };
    }
    if (s.status !== 'completed' || !s.report) {
      return {
        id: s.id,
        attempt,
        createdAt: s.createdAt,
        score: null,
        report: null,
        state: 'now' as StatusState,
        detail: [time, 'still running in the sandbox'].filter(Boolean).join(', '),
        result: 'Running',
        message: s.commitMessage ?? null,
      };
    }
    const score = s.score ?? s.report.overall;
    const passed = (s.passed ?? s.report.passed) && !s.report.aiReview.assessmentError;
    const gate = s.report.passThreshold || threshold;
    return {
      id: s.id,
      attempt,
      createdAt: s.createdAt,
      score,
      report: s.report,
      state: (passed ? 'pass' : 'fail') as StatusState,
      detail: [time, checksSummary(s.report)].filter(Boolean).join(', '),
      result: passed ? 'Pass' : 'Needs revision',
      message: s.commitMessage ?? null,
    };
  });
}

/* --------------------------------- threads -------------------------------- */

/**
 * One thread per thing a reviewer would leave a comment on: a failing case
 * whose traceback lands in the learner's own files, and each analyzer error or
 * warning. A thread closes when a later revision passes that case, or stops
 * reporting that rule in that file.
 */
export interface Thread {
  key: string;
  kind: 'test' | 'analyzer';
  /** Test name, or the analyzer rule. */
  source: string;
  path: string;
  line: number;
  /** The assertion, or the analyzer message. First line only; the trace is in Tests. */
  message: string;
  /** The source line the frame points at. */
  snippet?: string;
  state: 'open' | 'resolved';
  /** Attempt number of the revision that closed it. */
  resolvedIn: number | null;
  severity: 'error' | 'warning';
}

/** A thread's message: the first line of the case's or the analyzer's message, at most this many characters. */
const THREAD_MESSAGE_MAX = 200;

export function buildThreads(revision: Revision, later: Revision[]): Thread[] {
  const report = revision.report;
  if (!report) return [];
  const threads: Thread[] = [];

  for (const c of report.tests?.cases ?? []) {
    if (c.status === 'passed') continue;
    const frame = c.frames?.[0];
    if (!frame) continue; // a harness error outside the learner's files has no line to open
    const closed = later.find((r) =>
      r.report?.tests?.cases.some((o) => o.name === c.name && o.status === 'passed'),
    );
    threads.push({
      key: `test:${c.name}`,
      kind: 'test',
      source: c.name,
      path: frame.path,
      line: frame.line,
      message: messageHead(c.message, THREAD_MESSAGE_MAX) || 'The case failed.',
      snippet: frame.snippet,
      state: closed ? 'resolved' : 'open',
      resolvedIn: closed?.attempt ?? null,
      severity: 'error',
    });
  }

  for (const issue of report.staticAnalysis?.issues ?? []) {
    if (issue.severity === 'info') continue;
    const closed = later.find(
      (r) =>
        r.report?.staticAnalysis &&
        !r.report.staticAnalysis.issues.some((o) => o.rule === issue.rule && o.path === issue.path),
    );
    threads.push({
      key: `analyzer:${issue.path}:${issue.line}:${issue.rule}`,
      kind: 'analyzer',
      source: issue.rule,
      path: issue.path,
      line: issue.line,
      message: messageHead(issue.message, THREAD_MESSAGE_MAX),
      state: closed ? 'resolved' : 'open',
      resolvedIn: closed?.attempt ?? null,
      severity: issue.severity,
    });
  }

  // Open threads first: they are the work. Then by file and line, so a thread
  // sits where the reader would look for it.
  return threads.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'open' ? -1 : 1;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.line - b.line;
  });
}

/* --------------------------------- ledger --------------------------------- */

export interface LedgerGroup {
  name: string;
  story?: string;
  /** The worst verdict among the claims, which is what the row reports. */
  verdict: ContractClaim['verdict'];
  claims: ContractClaim[];
}

const VERDICT_RANK: Record<ContractClaim['verdict'], number> = {
  contradicted: 3,
  broken: 2,
  unclaimed: 1,
  kept: 0,
};

export const VERDICT_STATE: Record<ContractClaim['verdict'], StatusState> = {
  kept: 'pass',
  broken: 'fail',
  contradicted: 'warn',
  unclaimed: 'todo',
};

export const CLAIM_WORD: Record<ContractClaim['claim'], string> = {
  inputs: 'Inputs',
  returns: 'Returns',
  errors: 'Errors',
  ordering: 'Ordering',
  boundary: 'Boundary',
};

/** "Returns: every task past its due date." keeps its own lead-in; a bare claim gets one. */
export function claimSentence(claim: ContractClaim): string {
  const word = CLAIM_WORD[claim.claim];
  const text = claim.text.trim();
  return text.toLowerCase().startsWith(word.toLowerCase()) ? text : `${word}. ${text}`;
}

/**
 * One row per contract, not per claim: a function's claims are read together,
 * and the row reports the worst of them.
 */
export function buildLedger(contract: ContractClaim[]): LedgerGroup[] {
  const groups = new Map<string, LedgerGroup>();
  for (const claim of contract) {
    const group = groups.get(claim.name) ?? {
      name: claim.name,
      story: claim.story,
      verdict: 'kept' as ContractClaim['verdict'],
      claims: [],
    };
    group.claims.push(claim);
    if (!group.story && claim.story) group.story = claim.story;
    if (VERDICT_RANK[claim.verdict] > VERDICT_RANK[group.verdict]) group.verdict = claim.verdict;
    groups.set(claim.name, group);
  }
  return [...groups.values()].sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict]);
}

/**
 * The phases whose review builds a conformance ledger: the API reads the
 * design's claims against the code for an Implementation or Maintenance
 * review that is not a quiz's (`FeedbackService.reportExtras`), and for no
 * other phase.
 */
const LEDGER_PHASES: ReadonlySet<PhaseKey> = new Set<PhaseKey>(['implementation', 'maintenance']);

/**
 * What the IDE's Ledger tab says while it holds no row. Before a
 * review in a ledger phase, that the first verdict brings it; after one, that
 * the review checked no design claim; in any other phase the room opens in
 * (Deployment, or Requirements and Design where a task opens the IDE), review
 * or not, that the phase has none and where the claims are checked.
 */
export function emptyLedgerLine(phase: PhaseKey, reviewed: boolean): string {
  if (!LEDGER_PHASES.has(phase)) {
    return `${PHASE_TITLES[phase]} has no conformance ledger: the design's claims are checked against the code in Implementation and Maintenance.`;
  }
  return reviewed
    ? 'This review checked no design claim against the code, so there is nothing in the ledger.'
    : 'The conformance ledger arrives with the first verdict: every claim your design made, against what the code did.';
}

/* ------------------------------- call graph ------------------------------- */

export interface GraphNode {
  name: string;
  /** The name as it fits the box; the full name stays on `name`. */
  label: string;
  path: string;
  line: number;
  /** A failing case's traceback lands inside this function. */
  failing: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphEdge {
  key: string;
  d: string;
}

export interface CallGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /** How many functions the analyzer reported, when more than the graph draws. */
  total: number;
}

const NODE_H = 30;
const ROW_GAP = 34;
const COL_GAP = 14;
const PAD = 6;
/** Geist Mono at 11.5px, near enough to size a box from a name. */
const CHAR = 6.9;
const MAX_NODES = 14;
const MAX_DEPTH = 5;

const MAX_W = 210;
/** Room for the 16px text inset and a 10px tail. */
const BOX_PAD = 26;
const MAX_CHARS = Math.floor((MAX_W - BOX_PAD) / CHAR);

function labelOf(name: string): string {
  return name.length > MAX_CHARS ? `${name.slice(0, MAX_CHARS - 1)}…` : name;
}

function nodeWidth(label: string): number {
  return Math.min(MAX_W, Math.max(78, Math.round(label.length * CHAR) + BOX_PAD));
}

/**
 * Lays the functions out in call order: callers above what they call. Cycles
 * are common in real code, so depth is relaxed a bounded number of times
 * rather than walked recursively.
 */
export function buildCallGraph(
  functions: AnalyzerFunction[],
  failingLines: { path: string; line: number }[],
  width: number,
): CallGraph {
  const total = functions.length;
  const shown = functions.slice(0, MAX_NODES);
  if (shown.length === 0) return { nodes: [], edges: [], width: 0, height: 0, total };

  const index = new Map<string, number>();
  shown.forEach((f, i) => index.set(f.name, i));

  const links: [number, number][] = [];
  shown.forEach((f, i) => {
    const seen = new Set<number>();
    for (const call of f.calls) {
      const j = index.get(call);
      if (j === undefined || j === i || seen.has(j)) continue;
      seen.add(j);
      links.push([i, j]);
    }
  });

  const called = new Set(links.map(([, j]) => j));
  const depth: number[] = shown.map((_, i) => (called.has(i) ? -1 : 0));
  for (let pass = 0; pass < shown.length; pass += 1) {
    let moved = false;
    for (const [from, to] of links) {
      const next = Math.min(MAX_DEPTH, (depth[from] < 0 ? 0 : depth[from]) + 1);
      if (next > depth[to]) {
        depth[to] = next;
        moved = true;
      }
    }
    if (!moved) break;
  }
  depth.forEach((d, i) => {
    if (d < 0) depth[i] = 0;
  });

  // A cycle can leave a depth unused, and a row drawn at an index no other row
  // fills would sit outside the canvas, so the rows are packed before layout.
  const sparse: number[][] = [];
  depth.forEach((d, i) => {
    (sparse[d] ??= []).push(i);
  });
  const packed = sparse.filter((row): row is number[] => Array.isArray(row) && row.length > 0);

  // Most of a learner's functions are called from outside the file, so a level
  // is often every method at once. A level wider than the pane wraps onto the
  // next line rather than sending the whole graph sideways.
  const rows: number[][] = [];
  const limit = width - PAD * 2;
  for (const row of packed) {
    let line: number[] = [];
    let used = 0;
    for (const i of row) {
      const w = nodeWidth(labelOf(shown[i].name));
      const next = line.length === 0 ? w : used + COL_GAP + w;
      if (line.length > 0 && next > limit) {
        rows.push(line);
        line = [i];
        used = w;
      } else {
        line.push(i);
        used = next;
      }
    }
    if (line.length > 0) rows.push(line);
  }

  const placed: GraphNode[] = new Array(shown.length);
  let widest = 0;
  rows.forEach((row, r) => {
    const widths = row.map((i) => nodeWidth(labelOf(shown[i].name)));
    const rowWidth = widths.reduce((a, b) => a + b, 0) + COL_GAP * (row.length - 1);
    widest = Math.max(widest, rowWidth);
    let x = PAD;
    row.forEach((i, k) => {
      const fn = shown[i];
      placed[i] = {
        name: fn.name,
        label: labelOf(fn.name),
        path: fn.path,
        line: fn.line,
        failing: failingLines.some(
          (f) => f.path === fn.path && f.line >= fn.line && f.line <= (fn.endLine || fn.line),
        ),
        x,
        y: PAD + r * (NODE_H + ROW_GAP),
        w: widths[k],
        h: NODE_H,
      };
      x += widths[k] + COL_GAP;
    });
  });

  // Centre each row in whichever is wider: the widest row, or the pane.
  const canvas = Math.max(widest + PAD * 2, width);
  rows.forEach((row) => {
    const first = placed[row[0]];
    const last = placed[row[row.length - 1]];
    const shift = Math.round((canvas - (last.x + last.w - first.x)) / 2 - first.x);
    row.forEach((i) => {
      placed[i].x += shift;
    });
  });

  // A call down a row leaves the bottom of the caller and enters the top of the
  // callee. A call back up, or across a row, would run through the boxes, so it
  // leaves both sides and bows out to the right of everything.
  let rightmost = canvas;
  const edges: GraphEdge[] = links.map(([from, to]) => {
    const a = placed[from];
    const b = placed[to];
    const key = `${a.name}->${b.name}`;
    if (b.y > a.y) {
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      const bow = Math.max(14, (y2 - y1) / 2);
      return { key, d: `M${x1} ${y1} C ${x1} ${y1 + bow}, ${x2} ${y2 - bow}, ${x2} ${y2}` };
    }
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x + b.w;
    const y2 = b.y + b.h / 2;
    const out = Math.max(x1, x2) + 18;
    rightmost = Math.max(rightmost, out + 4);
    return { key, d: `M${x1} ${y1} C ${out} ${y1}, ${out} ${y2}, ${x2} ${y2}` };
  });

  return {
    nodes: placed,
    edges,
    width: rightmost,
    height: PAD * 2 + rows.length * NODE_H + Math.max(0, rows.length - 1) * ROW_GAP,
    total,
  };
}

/** Where every failing case's traceback landed, for colouring the graph. */
export function failingFrames(report: FeedbackReport | null): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  for (const c of report?.tests?.cases ?? []) {
    if (c.status === 'passed') continue;
    for (const f of c.frames ?? []) out.push({ path: f.path, line: f.line });
  }
  return out;
}
