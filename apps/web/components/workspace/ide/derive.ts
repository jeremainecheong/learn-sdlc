'use client';

/**
 * What the IDE chrome shows, derived from the phase, the buffers and the last
 * verdict. Nothing here fetches and nothing here is invented: every row is a
 * fact the API already reported, moved into the shape the explorer, the strip,
 * the problems list and the inline notes read.
 */
import type {
  AnalyzerFunction,
  ContractClaim,
  FeedbackReport,
  PhaseDetail,
  TestCaseResult,
  WorkspaceFile,
} from '@learnsdlc/shared';
import type { ExplorerNode } from '@/components/shell';
import { LIBRARY_FRAME, frameOf } from '@/components/workspace/trace';
import type { StatusState } from '@/lib/phase';

/* --------------------------------- tree ---------------------------------- */

interface Dir {
  name: string;
  /** The folder's own path from the root: `web/src/components`. */
  path: string;
  dirs: Map<string, Dir>;
  files: string[];
}

function emptyDir(name: string, path: string): Dir {
  return { name, path, dirs: new Map(), files: [] };
}

function dirsOf(files: WorkspaceFile[]): Dir {
  const root = emptyDir('', '');
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    for (const seg of parts.slice(0, -1)) {
      if (!dir.dirs.has(seg)) {
        dir.dirs.set(seg, emptyDir(seg, dir.path ? `${dir.path}/${seg}` : seg));
      }
      dir = dir.dirs.get(seg)!;
    }
    dir.files.push(f.path);
  }
  return root;
}

/**
 * A chain of single sub-folders is one row: `.github/workflows` is one line in
 * the mockup, not two. The row is identified by the deepest folder in the
 * chain, which is the one whose children it actually opens.
 */
function fold(d: Dir): { node: Dir; label: string } {
  let node = d;
  let label = d.name;
  while (node.files.length === 0 && node.dirs.size === 1) {
    const only = [...node.dirs.values()][0];
    label = `${label}/${only.name}`;
    node = only;
  }
  return { node, label };
}

/** The id a folder row is toggled and remembered by. */
export const folderTestId = (path: string) => `explorer-folder-${path.replace(/[/.]/g, '-')}`;

/**
 * Which folders a phase opens closed.
 *
 * A two-directory, twenty-six-file application is a wall when every folder is
 * open at once, and the folders that matter are the ones the learner is asked
 * to write in. So a folder holding no editable file anywhere below it starts
 * closed, and everything on the way to a gap starts open. It is only ever a
 * starting point: the set is the learner's from their first click, and it is
 * remembered per phase.
 */
export function defaultCollapsed(files: WorkspaceFile[]): Set<string> {
  const editable = new Set(files.filter((f) => f.editable).map((f) => f.path));
  const holdsEditable = (d: Dir): boolean =>
    d.files.some((p) => editable.has(p)) || [...d.dirs.values()].some(holdsEditable);
  const out = new Set<string>();
  const walk = (dir: Dir) => {
    for (const d of dir.dirs.values()) {
      const { node } = fold(d);
      if (holdsEditable(node)) walk(node);
      else out.add(node.path);
    }
  };
  walk(dirsOf(files));
  return out;
}

/**
 * The explorer tree, folders first then files, each level alphabetical.
 *
 * A folder in `collapsed` draws its own row and none of its children: the
 * chevron is the whole point, so a closed folder is one line whatever is
 * inside it.
 */
export function buildTree(
  files: WorkspaceFile[],
  opts: {
    activePath: string;
    modified: (path: string) => boolean;
    onOpen: (path: string) => void;
    /** Folder paths the learner has closed. Absent means every folder is open. */
    collapsed?: ReadonlySet<string>;
    onToggle?: (path: string) => void;
  },
): ExplorerNode[] {
  const root = dirsOf(files);
  const collapsed = opts.collapsed;

  const out: ExplorerNode[] = [];
  const walk = (dir: Dir, depth: number) => {
    const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      const { node, label } = fold(d);
      const open = !collapsed?.has(node.path);
      out.push({
        name: label,
        depth,
        kind: 'folder',
        open,
        onToggle: opts.onToggle ? () => opts.onToggle!(node.path) : undefined,
        testId: folderTestId(node.path),
      });
      if (open) walk(node, depth + 1);
    }
    for (const path of [...dir.files].sort((a, b) => a.localeCompare(b))) {
      const name = path.split('/').pop() ?? path;
      out.push({
        name,
        depth,
        kind: 'file',
        active: path === opts.activePath,
        modified: opts.modified(path),
        onSelect: () => opts.onOpen(path),
        // `file-tab-*` belongs to the editor's own tab strip; two elements on
        // one id would make every getByTestId('file-tab-…') ambiguous.
        testId: `explorer-file-${path.replace(/[/.]/g, '-')}`,
      });
    }
  };
  walk(root, 1);
  return out;
}

/* ------------------------------- functions -------------------------------- */

export interface FnSpan {
  name: string;
  qualname?: string;
  path: string;
  line: number;
  endLine: number;
}

const DEF = /^\s*(?:async\s+)?(?:def|function|class)\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/;

/**
 * The functions of one file. The analyzer's own list wins whenever a verdict
 * has produced one: it knows the class a method hangs off. Before the first
 * submission there is no report, so the buffer is read directly rather than
 * leaving the strip and the breadcrumb blank.
 */
export function functionsIn(path: string, text: string, analyzer: AnalyzerFunction[]): FnSpan[] {
  const known = analyzer.filter((f) => f.path === path);
  if (known.length > 0) {
    return known
      .map((f) => ({ name: f.name, qualname: f.qualname, path: f.path, line: f.line, endLine: f.endLine }))
      .sort((a, b) => a.line - b.line);
  }
  if (!/\.(py|[cm]?[jt]sx?)$/i.test(path)) return [];
  const lines = text.split('\n');
  const found: FnSpan[] = [];
  lines.forEach((raw, i) => {
    const m = DEF.exec(raw);
    if (!m) return;
    const name = m[1] ?? m[2];
    if (!name) return;
    found.push({ name, path, line: i + 1, endLine: lines.length });
  });
  for (let i = 0; i < found.length - 1; i += 1) found[i].endLine = found[i + 1].line - 1;
  return found;
}

/** The function a line sits inside, if any. */
export function fnAt(spans: FnSpan[], line: number): FnSpan | null {
  let hit: FnSpan | null = null;
  for (const s of spans) {
    if (line >= s.line && line <= s.endLine && (!hit || s.line > hit.line)) hit = s;
  }
  return hit;
}

/**
 * The breadcrumb over the code: the folders, the file, then the class and the
 * function the cursor is in; `tasktrackr › manager.py › TaskManager › filter_tasks`.
 */
export function breadcrumb(path: string, fn: FnSpan | null): string[] {
  const crumbs = path.split('/');
  if (!fn) return crumbs;
  const qual = fn.qualname ?? fn.name;
  return [...crumbs, ...qual.split('.')];
}

/**
 * The label a file wears in a list that shows several of them at once.
 *
 * Two of this pack's files are called `tasks.py`, `api/repository/tasks.py`
 * and `api/routes/tasks.py`, and a tab strip that draws the basename alone
 * gives the learner two tabs it is impossible to tell apart. Where a basename
 * repeats, enough of the path is kept to separate them,
 * and where it does not the basename stands on its own.
 */
export function shortNames(paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  for (const p of paths) {
    const base = p.split('/').pop() ?? p;
    byBase.set(base, [...(byBase.get(base) ?? []), p]);
  }
  for (const [base, group] of byBase) {
    if (group.length === 1) {
      out.set(group[0], base);
      continue;
    }
    // Walk one folder further up at a time until every path in the group has a
    // label of its own, or there is no more path to walk.
    let depth = 2;
    for (;;) {
      const labels = group.map((p) => p.split('/').slice(-depth).join('/'));
      const distinct = new Set(labels).size === labels.length;
      const exhausted = labels.every((l, i) => l === group[i]);
      if (distinct || exhausted) {
        group.forEach((p, i) => out.set(p, labels[i]));
        break;
      }
      depth += 1;
    }
  }
  return out;
}

/* ------------------------------- verdict facts ---------------------------- */

export interface Frame {
  path: string;
  line: number;
  /** The case whose traceback landed here. */
  test: string;
  message: string;
  hidden: boolean;
}

/** Every failing case's deepest frame inside the learner's own files. */
export function failingFrames(report: FeedbackReport | null): Frame[] {
  const out: Frame[] = [];
  for (const c of report?.tests?.cases ?? []) {
    if (c.status === 'passed') continue;
    const frame = c.frames?.[0];
    if (!frame) continue;
    out.push({
      path: frame.path,
      line: frame.line,
      test: c.name,
      message: firstLine(c.message),
      hidden: Boolean(c.hidden),
    });
  }
  return out;
}

export function firstLine(message: string | undefined): string {
  const first = (message ?? '').trim().split('\n')[0];
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

const CLAIM_STATE: Record<ContractClaim['verdict'], StatusState> = {
  kept: 'pass',
  broken: 'fail',
  contradicted: 'warn',
  unclaimed: 'todo',
};

/** How a claim reads as a sentence: "Your contract says the ordering is …". */
const CLAIM_LEAD: Record<ContractClaim['claim'], string> = {
  inputs: 'Your contract takes',
  returns: 'Your contract returns',
  errors: 'Your contract says the errors are',
  ordering: 'Your contract orders by',
  boundary: 'Your contract draws the boundary at',
};

export const CLAIM_WHAT: Record<ContractClaim['verdict'], string> = {
  kept: 'Contract kept',
  broken: 'Contract broken',
  contradicted: 'Contract contradicted',
  unclaimed: 'Nothing claims this',
};

export interface Problem {
  state: StatusState;
  where: string;
  what: string;
  path: string;
  line: number;
  /**
   * The case whose traceback landed here, when a case is what produced this
   * problem. Absent for a contract claim, which no test names.
   * `note.test` carries it as well; the row needs it too, because the row
   * is where the reviewer is asked about it.
   */
  test?: string;
  /** The inline note this problem draws in the editor. */
  note: {
    tone: 'warn' | 'fail' | 'neutral';
    label: string;
    text: string;
    test?: string;
  };
}

/**
 * What is wrong, and where. A failing case is placed at the line its traceback
 * named; a contract claim at the function it was made about. Both read the same
 * way in the explorer's Problems block and in the note the editor draws.
 */
export function buildProblems(
  report: FeedbackReport | null,
  spans: FnSpan[],
  editable: (path: string) => boolean,
): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  const push = (p: Problem) => {
    const key = `${p.path}:${p.line}:${p.what}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  for (const claim of report?.contract ?? []) {
    if (claim.verdict === 'kept') continue;
    const span = spans.find((s) => s.name === claim.name);
    if (!span || !editable(span.path)) continue;
    push({
      state: CLAIM_STATE[claim.verdict],
      where: `Line ${span.line}`,
      what: CLAIM_WHAT[claim.verdict],
      path: span.path,
      line: span.line,
      note: {
        tone: claim.verdict === 'contradicted' ? 'warn' : 'fail',
        label: claim.story ?? 'Contract',
        text: `${CLAIM_LEAD[claim.claim]} ${claim.text}`,
        test: claim.evidence[0],
      },
    });
  }

  for (const f of failingFrames(report)) {
    if (!editable(f.path)) continue;
    const claim = (report?.contract ?? []).find((c) => c.evidence.includes(f.test));
    const notImplemented = /NotImplementedError/.test(f.message);
    push({
      state: 'fail',
      where: `Line ${f.line}`,
      what: notImplemented
        ? 'Not implemented'
        : claim?.story
          ? `Criterion ${claim.story} not met`
          : 'A test fails here',
      path: f.path,
      line: f.line,
      test: f.test,
      note: {
        tone: 'fail',
        label: claim?.story ?? (f.hidden ? 'Hidden test' : 'Test'),
        text: f.message || 'This line is where the failing case landed.',
        test: f.test,
      },
    });
  }

  return out.sort((a, b) => a.line - b.line);
}

/* -------------------------------- the strip ------------------------------- */

export interface StripChip {
  tone: 'pass' | 'fail' | 'warn' | 'neutral';
  text: string;
}

/**
 * The implementation strip: one chip per function in the file being worked on,
 * saying whether it passes, how many cases it fails, or that it has not been
 * started. Read from the last verdict's frames and the buffer itself.
 */
export function functionChips(
  spans: FnSpan[],
  text: string,
  report: FeedbackReport | null,
): StripChip[] {
  const frames = failingFrames(report);
  const claims = report?.contract ?? [];
  const lines = text.split('\n');
  const chips = spans.map((s) => {
    const mine = claims.filter((c) => c.name === s.name);
    // What is failing about this function: a case whose traceback landed in it,
    // and a claim its design made that the code did not keep.
    const failing =
      frames.filter((f) => f.path === s.path && f.line >= s.line && f.line <= s.endLine).length +
      mine.filter((c) => c.verdict === 'broken' || c.verdict === 'contradicted').length;
    const body = lines.slice(s.line, Math.min(s.endLine, lines.length)).join('\n');
    const unstarted = /NotImplementedError|TODO/.test(body);
    // A function the contract talks about is what the phase is about; __init__
    // and the storage helpers pass every time and say nothing.
    const claimed = mine.length > 0;
    // A function that still raises NotImplementedError has not started, however
    // many cases fail on it: the failures are the consequence, not the news.
    if (unstarted) return { tone: 'neutral' as const, text: `${s.name} not started`, rank: 1 };
    if (failing > 0) {
      return { tone: 'fail' as const, text: `${s.name}: ${failing} failing in last review`, rank: 0 };
    }
    // A private row mapper such as `_to_task` is never what the phase asks
    // anyone to write, and with no verdict yet every function ranks the same,
    // so file order would put it first and the strip would lead with the one
    // function the lab is not about. A private helper that passes comes last.
    const helper = s.name.startsWith('_');
    const kept = mine.length > 0 && mine.every((claim) => claim.verdict === 'kept');
    return kept
      ? { tone: 'pass' as const, text: `${s.name}: contract kept in last review`, rank: 2 }
      : { tone: 'neutral' as const, text: `${s.name} not reviewed`, rank: claimed ? 2 : helper ? 4 : 3 };
  });
  // Which three: what is wrong first, then what has not been started, then
  // what is done: three chips of the twenty a file may hold, and never the
  // three that say nothing. In what order: the order they appear in the file,
  // so the strip reads down the code the way the mockup draws it.
  const keep = new Set(
    chips
      .map((c, i) => ({ rank: c.rank, i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .slice(0, 3)
      .map((c) => c.i),
  );
  const shown: StripChip[] = chips
    .filter((_, i) => keep.has(i))
    .map(({ tone, text: t }) => ({ tone, text: t }));
  // Drawing three of twenty and dropping the other seventeen without a word
  // would make a strip that ends at the edge of the window read as a strip
  // that has said everything. The count is the last chip.
  const hidden = chips.length - shown.length;
  if (hidden > 0) shown.push({ tone: 'neutral', text: `+${hidden} more` });
  return shown;
}

/* ------------------------------ source control ---------------------------- */

/** "Submission 3: hidden 5 of 10" and "Visible 4 of 4" for the explorer. */
export function sourceLines(report: FeedbackReport | null, attempt: number | undefined): {
  state: StatusState;
  text: string;
}[] {
  const cases = report?.tests?.cases ?? [];
  if (cases.length === 0) return [];
  const of = (hidden: boolean) => {
    const set = cases.filter((c) => Boolean(c.hidden) === hidden);
    return { total: set.length, passed: set.filter((c) => c.status === 'passed').length };
  };
  const hidden = of(true);
  const visible = of(false);
  const rows: { state: StatusState; text: string }[] = [];
  if (hidden.total > 0) {
    rows.push({
      state: hidden.passed === hidden.total ? 'pass' : 'fail',
      text: `Submission ${attempt ?? 1}: hidden ${hidden.passed} of ${hidden.total}`,
    });
  }
  if (visible.total > 0) {
    rows.push({
      state: visible.passed === visible.total ? 'pass' : 'fail',
      text: `Visible ${visible.passed} of ${visible.total}`,
    });
  }
  return rows;
}

/** "Hidden 5 of 10" for the status bar, or nothing before the first verdict. */
export function hiddenLabel(report: FeedbackReport | null): string | undefined {
  const hidden = (report?.tests?.cases ?? []).filter((c) => c.hidden);
  if (hidden.length > 0) {
    return `Hidden ${hidden.filter((c) => c.status === 'passed').length} of ${hidden.length}`;
  }
  // A verdict that counted the suite without naming its cases still says how
  // the hidden suite stood, and that is the number the status bar is for.
  const tests = report?.tests;
  if (tests && tests.total > 0) return `Hidden ${tests.passed} of ${tests.total}`;
  return undefined;
}

/* -------------------------------- terminal -------------------------------- */

/**
 * The transcript with the platform's own stack frames taken out, and the
 * learner's own written the way this product writes a file reference.
 *
 * A failing first run prints nine frames under sandbox/python/werkzeug,
 * sandbox/python/flask and flask/app.py before the one line the learner can
 * act on, and the sandbox path would publish the platform's internal layout
 * into the room. The frames are not information a learner can
 * use; the file and line in their own test is.
 */
export function learnerFrames(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const frame = frameOf(line);
    if (!frame) {
      out.push(line);
      continue;
    }
    if (LIBRARY_FRAME.test(frame.path)) continue;
    const file = frame.path.split(/[\\/]/).pop() || frame.path;
    out.push(`${file}, line ${frame.line}${frame.fn ? `, in ${frame.fn}` : ''}`);
  }
  return out;
}

/**
 * The terminal transcript: what the sandbox printed, in the order it ran. The
 * visible suite comes from the run the learner started; the hidden suite is the
 * summary line of the last verdict, which ran somewhere they cannot watch.
 */
export function terminalLines(
  run: { result: { stdout: string; stderr: string; tests?: { total: number; passed: number } | null } | null } | null,
  report: FeedbackReport | null,
  attempt: number | undefined,
  runLabel: string,
): { text: string; tone?: 'fail' | 'ink' }[] {
  const out: { text: string; tone?: 'fail' | 'ink' }[] = [];
  out.push({ text: `$ ${runLabel.toLowerCase()}`, tone: 'ink' });
  const result = run?.result;
  if (!result) {
    out.push({ text: 'Nothing has been run in this browser yet.' });
  } else {
    for (const line of learnerFrames((result.stdout || '').split('\n')).slice(-14)) {
      if (line.trim()) out.push({ text: line });
    }
    for (const line of learnerFrames((result.stderr || '').split('\n')).slice(-8)) {
      if (line.trim()) out.push({ text: line, tone: 'fail' });
    }
    if (result.tests) {
      out.push({ text: `${result.tests.passed} of ${result.tests.total} passed`, tone: 'ink' });
    }
  }
  const cases = report?.tests?.cases ?? [];
  if (cases.length > 0) {
    out.push({ text: `$ submission ${attempt ?? 1}`, tone: 'ink' });
    for (const c of cases.filter((x): x is TestCaseResult => x.status !== 'passed').slice(0, 8)) {
      out.push({ text: `FAILED ${c.name}   ${firstLine(c.message)}`, tone: 'fail' });
    }
    const passed = cases.filter((c) => c.status === 'passed').length;
    // The counts and nothing else: the review says the phase has no numerical pass threshold, so the
    // terminal does not print a score out of 100 beside it.
    out.push({ text: `${passed} passed, ${cases.length - passed} failed.`, tone: 'ink' });
  }
  return out;
}

/* --------------------------------- headline ------------------------------- */

const HEADLINES: Record<PhaseDetail['key'], string> = {
  requirements: 'Write US-4, the overdue report, with criteria a test can check',
  // The design phase names operations and screens, not functions.
  design: 'Name every operation and every screen, and say what each promises',
  // Five gaps across two layers, so the sentence names no single file.
  implementation: 'Fill the marked gaps, across the API and the front end',
  testing: 'Write one test per criterion, and see each one fail first',
  deployment: 'Define the pipeline, then investigate the incident',
  maintenance: 'Change the contract without breaking what depends on it',
};

/** The Requirements headline for a room that is not the reference story's. */
const NEUTRAL_REQUIREMENTS_HEADLINE = 'Write your story, with criteria a test can check';

/**
 * The line a room that is not the reference project's carries, where its pack
 * gives no intro to read. Each names no deliverable of the
 * reference project's.
 */
const OWN_FALLBACK_HEADLINES: Record<PhaseDetail['key'], string> = {
  requirements: NEUTRAL_REQUIREMENTS_HEADLINE,
  design: 'Design what the brief asks for',
  implementation: 'Change the editable files the brief names',
  testing: 'Write the tests the brief asks for',
  deployment: 'Fix the release the brief describes',
  maintenance: 'Make the requested change and keep what works',
};

/**
 * The line for a room that is not the reference project's: what
 * its pack asks, never "across the API and the front end". Implementation
 * names its editable targets, the one file where there is one ("Work in
 * web/src/lib/overdue.ts") and the count otherwise ("Work in the 2 editable
 * files"), claiming nothing about markers the web cannot see; every other
 * phase, and an Implementation with no editable file, reads the opening
 * paragraph of the phase's own intro, on one line.
 */
export function ownRoomHeadline(key: PhaseDetail['key'], files: WorkspaceFile[], intro: string | null | undefined): string {
  if (key === 'implementation') {
    const editable = files.filter((file) => file.editable);
    if (editable.length === 1) return `Work in ${editable[0].path}`;
    if (editable.length > 1) return `Work in the ${editable.length} editable files`;
  }
  const opening = (intro ?? '').split(/\n[ \t]*\n/)[0].replace(/\s+/g, ' ').trim();
  return opening || OWN_FALLBACK_HEADLINES[key];
}

/**
 * The one sentence the phase strip carries.
 *
 * On the reference project it does not override the implementation headline
 * with the basename of the first editable file, which reads well only while a
 * phase has one gap in one file. A phase with five gaps over two layers has no
 * first file worth naming, so the sentence names the work instead.
 *
 * `own`: the room is not the reference project's (`roomIsReference` false),
 * with the phase's own intro. Its line is `ownRoomHeadline`'s, except on
 * Requirements, whose neutral line already fits any project. Left out, the
 * reference project's lines are drawn as they always were.
 */
export function headlineFor(key: PhaseDetail['key'], files: WorkspaceFile[], reference = true, own?: { intro?: string | null } | null): string {
  // The Requirements sentence is the reference
  // story's. A room task that is not the reference's, and every teacher's
  // written task this page opens, reads the neutral one.
  if (key === 'requirements' && !reference) return NEUTRAL_REQUIREMENTS_HEADLINE;
  if (own && key !== 'requirements') return ownRoomHeadline(key, files, own.intro);
  return HEADLINES[key];
}
