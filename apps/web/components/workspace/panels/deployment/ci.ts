/**
 * The pipeline the learner wrote, read from `.github/workflows/ci.yml`.
 *
 * The web app has no YAML dependency, and pulling one in for a single file
 * would ship a parser for a language this panel never sees in full. What it
 * needs is the shape a GitHub Actions workflow has: nested mappings, sequences
 * of steps, flow lists, block scalars for `run: |`. That subset is small
 * enough to read here, and reading it in the browser keeps the drawing live
 * while the learner types instead of one verdict behind.
 *
 * The one deliberate extension: a `# TODO(learner)` comment inside `steps:`
 * becomes a step of its own. The scaffold marks the missing steps that way, so
 * the pipeline can draw the work that is still to do rather than pretend the
 * job is complete.
 */
import type { CiStep } from '@learnsdlc/shared';
import type { StatusState } from '@/lib/phase';

export type YamlNode = string | YamlNode[] | { [key: string]: YamlNode };

/** Anything past this is not a workflow file, and the panel will not parse it. */
const MAX_CHARS = 60000;
const TODO_RE = /TODO\(learner\)/i;
const TODO_KEY = '__todo';
const BLOCK_RE = /^[|>][+-]?\d*$/;

interface RawLine {
  indent: number;
  /** Comment markers and quotes removed; the body of a comment for comment lines. */
  text: string;
  /** The line as written, kept so a block scalar keeps its own indentation. */
  raw: string;
  comment: boolean;
}

/** Drops a trailing `# comment`, leaving `#` inside a quoted string alone. */
function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}

function scan(src: string): RawLine[] {
  const out: RawLine[] = [];
  for (const line of src.slice(0, MAX_CHARS).split('\n')) {
    const flat = line.replace(/\t/g, '  ').replace(/\s+$/, '');
    const body = flat.trim();
    if (!body || body === '---') continue;
    const indent = flat.length - flat.trimStart().length;
    if (body.startsWith('#')) {
      out.push({ indent, text: body.slice(1).trim(), raw: flat, comment: true });
      continue;
    }
    out.push({ indent, text: stripComment(body), raw: flat, comment: false });
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** `[main, next]` is a list; everything else on one line is a scalar. */
function inlineValue(v: string): YamlNode {
  const t = v.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    return inner ? inner.split(',').map((p) => unquote(p)) : [];
  }
  return unquote(t);
}

const isItem = (l: RawLine): boolean => !l.comment && (l.text === '-' || l.text.startsWith('- '));

/** The next line that is not a comment, so a comment never decides a node's kind. */
function nextContent(lines: RawLine[], from: number): RawLine | undefined {
  for (let i = from; i < lines.length; i += 1) if (!lines[i].comment) return lines[i];
  return undefined;
}

function blockScalar(lines: RawLine[], cur: { i: number }, keyIndent: number): string {
  const body: string[] = [];
  let min = Infinity;
  while (cur.i < lines.length && lines[cur.i].indent > keyIndent) {
    body.push(lines[cur.i].raw);
    min = Math.min(min, lines[cur.i].indent);
    cur.i += 1;
  }
  const cut = min === Infinity ? 0 : min;
  return body.map((s) => s.slice(cut)).join('\n').trimEnd();
}

function parseNode(lines: RawLine[], cur: { i: number }, indent: number): YamlNode {
  const first = nextContent(lines, cur.i);
  if (!first) return {};
  return isItem(first) ? parseSeq(lines, cur, indent) : parseMap(lines, cur, indent);
}

function parseSeq(lines: RawLine[], cur: { i: number }, indent: number): YamlNode[] {
  const arr: YamlNode[] = [];
  while (cur.i < lines.length) {
    const l = lines[cur.i];
    if (l.indent < indent) break;
    if (l.comment) {
      // A TODO marker at the list's own indentation is a step nobody wrote yet.
      if (l.indent === indent && TODO_RE.test(l.text)) arr.push({ [TODO_KEY]: l.text });
      cur.i += 1;
      continue;
    }
    if (l.indent !== indent || !isItem(l)) break;
    const rest = l.text === '-' ? '' : l.text.slice(2).trim();
    const childIndent = l.indent + 2;
    if (!rest) {
      cur.i += 1;
      const next = lines[cur.i];
      if (next && next.indent > l.indent) arr.push(parseNode(lines, cur, next.indent));
      else arr.push('');
      continue;
    }
    lines[cur.i] = { indent: childIndent, text: rest, raw: rest, comment: false };
    arr.push(parseNode(lines, cur, childIndent));
  }
  return arr;
}

function parseMap(lines: RawLine[], cur: { i: number }, indent: number): { [key: string]: YamlNode } {
  const map: { [key: string]: YamlNode } = {};
  while (cur.i < lines.length) {
    const l = lines[cur.i];
    if (l.comment) {
      if (l.indent >= indent) {
        cur.i += 1;
        continue;
      }
      break;
    }
    if (l.indent !== indent || isItem(l)) break;
    const m = /^([^:]+?)\s*:(?:\s+([\s\S]*))?$/.exec(l.text);
    if (!m) {
      cur.i += 1;
      continue;
    }
    const key = unquote(m[1]);
    const rest = (m[2] ?? '').trim();
    cur.i += 1;
    if (BLOCK_RE.test(rest)) {
      map[key] = blockScalar(lines, cur, l.indent);
      continue;
    }
    if (rest) {
      map[key] = inlineValue(rest);
      continue;
    }
    const next = nextContent(lines, cur.i);
    if (next && next.indent > l.indent) map[key] = parseNode(lines, cur, next.indent);
    else if (next && next.indent === l.indent && isItem(next)) map[key] = parseSeq(lines, cur, l.indent);
    else map[key] = '';
  }
  return map;
}

/** Reads the subset of YAML a workflow file uses. Never throws: bad input yields {}. */
export function parseYaml(src: string): { [key: string]: YamlNode } {
  const lines = scan(src);
  if (lines.length === 0) return {};
  const cur = { i: 0 };
  const node = parseNode(lines, cur, lines[0].indent);
  return isRecord(node) ? node : {};
}

const isRecord = (n: YamlNode | undefined): n is { [key: string]: YamlNode } =>
  typeof n === 'object' && n !== null && !Array.isArray(n);
const str = (n: YamlNode | undefined): string => (typeof n === 'string' ? n : '');

/* ------------------------------ the pipeline ----------------------------- */

export type StepState = 'pass' | 'fail' | 'todo' | 'skip';

export interface PipelineStep {
  /** What the step is called: its `name`, else the action, else the command. */
  name: string;
  /** The command or the action version, one line under the name. */
  detail: string;
  state: StepState;
  /** Why it failed, from the verdict. */
  note: string;
  /** True for a step the scaffold still marks as unwritten. */
  todo: boolean;
}

export interface PipelineJob {
  id: string;
  needs: string[];
  steps: PipelineStep[];
  state: StatusState;
}

export interface Pipeline {
  /** The workflow's own `name:`, empty when it has none. */
  name: string;
  jobs: PipelineJob[];
  /** Set when the file is missing or names no jobs, so the panel can say so. */
  problem: string | null;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Matches a drawn step to the verdict's row for the same job. */
function outcomeFor(rows: CiStep[], job: string, candidates: string[]): CiStep | undefined {
  const mine = rows.filter((r) => norm(r.job) === norm(job));
  const wanted = candidates.map(norm).filter(Boolean);
  for (const w of wanted) {
    const exact = mine.find((r) => norm(r.step) === w);
    if (exact) return exact;
  }
  for (const w of wanted) {
    const loose = mine.find((r) => norm(r.step).includes(w) || w.includes(norm(r.step)));
    if (loose) return loose;
  }
  return undefined;
}

function readStep(node: YamlNode, job: string, rows: CiStep[]): PipelineStep {
  if (!isRecord(node)) {
    const text = str(node);
    return { name: text || 'Step', detail: '', state: 'todo', note: '', todo: false };
  }
  const todo = str(node[TODO_KEY]);
  if (todo) {
    // "TODO(learner): add a step that runs the unit test suite" → the sentence.
    const said = todo.replace(/^TODO\(learner\):\s*/i, '').trim();
    return {
      name: said ? said.charAt(0).toUpperCase() + said.slice(1) : 'A step to write',
      detail: '',
      state: 'todo',
      note: '',
      todo: true,
    };
  }
  const uses = str(node.uses);
  const run = str(node.run);
  const named = str(node.name);
  const firstLine = run.split('\n')[0].trim();
  const action = uses.split('@')[0];
  const name = named || action || firstLine || 'Step';
  // The second line says what the step actually does: the command under a
  // named step, or the action's version under a bare `uses:`.
  const detail = named ? (run ? firstLine : uses) : run ? '' : uses.split('@')[1] ?? '';
  const row = outcomeFor(rows, job, [named, uses, action, firstLine]);
  // Older reviews inferred CI success/failure from an unrelated selfcheck.
  // Those persisted inferences are not execution evidence either.
  const inferred = /smoke run.*(?:would go green|would go red)/i.test(row?.detail ?? '');
  const state: StepState = !inferred && row?.ok === true ? 'pass' : !inferred && row?.ok === false ? 'fail' : rows.length ? 'skip' : 'todo';
  const note = inferred ? 'This workflow step was not executed. The earlier selfcheck does not establish its outcome.' : row?.detail ?? '';
  return { name, detail: name === detail ? '' : detail, state, note, todo: false };
}

function jobState(steps: PipelineStep[]): StatusState {
  if (steps.length === 0) return 'todo';
  if (steps.some((s) => s.state === 'fail')) return 'fail';
  if (steps.every((s) => s.state === 'todo')) return 'todo';
  if (steps.every((s) => s.state === 'pass')) return 'pass';
  if (steps.some((s) => s.state === 'pass')) return 'now';
  return 'todo';
}

/**
 * The jobs, their order and each step's outcome. `rows` is `report.ci` from the
 * last verdict; without it every step reads as not run yet.
 */
export function readPipeline(text: string, rows?: CiStep[] | null): Pipeline {
  const ci = rows ?? [];
  if (!text.trim()) {
    return { name: '', jobs: [], problem: 'The workflow file is empty.' };
  }
  const doc = parseYaml(text);
  const jobsNode = doc.jobs;
  if (!isRecord(jobsNode)) {
    return { name: str(doc.name), jobs: [], problem: 'No jobs found under jobs: in this file.' };
  }
  const jobs: PipelineJob[] = Object.keys(jobsNode).map((id) => {
    const body = jobsNode[id];
    const def = isRecord(body) ? body : {};
    const needsNode = def.needs;
    const needs = Array.isArray(needsNode)
      ? needsNode.map((n) => str(n)).filter(Boolean)
      : str(needsNode)
        ? [str(needsNode)]
        : [];
    const stepsNode = def.steps;
    const steps = (Array.isArray(stepsNode) ? stepsNode : []).map((s) => readStep(s, id, ci));
    return { id, needs, steps, state: jobState(steps) };
  });
  return {
    name: str(doc.name),
    jobs,
    problem: jobs.length === 0 ? 'No jobs found under jobs: in this file.' : null,
  };
}

/** Column per job: one past the deepest job it needs, capped so the drawing stays readable. */
export function columnsOf(jobs: PipelineJob[], maxCols = 4): Map<string, number> {
  const col = new Map<string, number>(jobs.map((j) => [j.id, 0]));
  for (let pass = 0; pass < jobs.length + 1; pass += 1) {
    let moved = false;
    for (const j of jobs) {
      for (const need of j.needs) {
        const from = col.get(need);
        if (from === undefined || need === j.id) continue;
        const want = Math.min(maxCols - 1, from + 1);
        if ((col.get(j.id) ?? 0) < want) {
          col.set(j.id, want);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return col;
}
