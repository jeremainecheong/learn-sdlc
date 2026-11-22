/**
 * The project map: every artefact the learner has made, derived purely from
 * what the API already returns for an enrolment, and how each traces to the
 * next, story to criterion to contract to function to test to change.
 *
 * Nothing here fetches. `buildProjectMap` is a pure function of the enrolment
 * and the phase details, so callers can memoise it on those two references.
 * The parsing is deliberately forgiving: it reads headings, bullets, `def`
 * lines and call sites with small regexes rather than a real parser, because
 * the input is a learner's half-finished work and must never throw.
 */
import type { AnalyzerFunction, ContractClaim, MutantRow } from './contract/analysis';
import type { FeedbackCheck, PhaseLink } from './contract/feedback';
import type { EnrollmentView, PhaseDetail, PhaseSummary, WorkspaceFile } from './contract/phase-detail';
import type { TestCaseResult, TestFrame } from './contract/runs';
// From `./phases` and not `./index`: this module is re-exported by `./index`,
// so reading a runtime value from it would be a cycle, and PHASE_ORDER is read
// while this module body runs.
import { PHASE_ORDER, type PhaseKey } from './phases';
import { RUNBOOK_JSON } from './runbook-record';
import { LEARNER_PICKS, parseStoryJson, STORY_JSON, type AcceptanceCriterion } from './requirements-story';
import { statusState, type StatusState } from './status';
// From the modules themselves, as `./phases` is: never through `./index`.
import { API_CONTRACT_JSON, DESIGN_JSON, SCREEN_CONTRACT_JSON, readDesignRecord } from './design-record';
import { isObject } from './record-read';
import { apiEndpoints, operationBaseName, screenRows } from './design-floor';
import { CHANGE_REQUEST_JSON, IMPACT_LISTS, validateChangeRequestRecord } from './change-record';

export type MapNodeKind =
  | 'story'
  | 'criterion'
  | 'contract'
  | 'decision'
  | 'function'
  | 'test'
  | 'file'
  | 'bug'
  | 'change'
  | 'placeholder';

export interface MapNode {
  id: string;
  phase: PhaseKey;
  kind: MapNodeKind;
  label: string;
  sub?: string;
  state: StatusState;
  file?: string;
  line?: number;
  href?: string;
  /** Phase this node was drawn from; placeholders name the locked phase. */
  phaseId?: string;
  /** Render the label in the mono face: identifiers, file names, signatures. */
  mono?: boolean;
  /** Longer text for the drawer: the full criterion, a bug description. */
  detail?: string;
  /** For folded nodes in compact mode: the ids they stand in for. */
  folded?: string[];
  /** Given by the project rather than written by the learner. */
  given?: boolean;
  /**
   * The identifier in full: a test's `test_` prefix is dropped from the label,
   * and a learner's link is stored against this name rather than the node id.
   */
  name?: string;
  /** The code does something no contract or criterion describes. */
  unclaimed?: boolean;
  /** Rows the drawer shows as proof: frames, contract claims, planted bugs. */
  evidence?: MapEvidence[];
}

/** One table of proof in the drawer: a title, a purpose line and rows. */
export interface MapEvidence {
  kind: 'frames' | 'claims' | 'kills';
  title: string;
  purpose: string;
  /** Heading over the sentences. */
  column: string;
  /** Heading over the right-aligned results; absent when rows carry none. */
  resultColumn?: string;
  rows: MapEvidenceRow[];
}

export interface MapEvidenceRow {
  /** The sentence: "manager.py, line 56", a claim, a test name. */
  label: string;
  /** The line under it: a source line, the evidence the grader read. */
  detail?: string;
  /** The right-aligned result. */
  result?: string;
  state: StatusState;
  mono?: boolean;
  /** Draw the result with a dashed edge: nothing claimed it. */
  dashed?: boolean;
}

export interface MapEdge {
  from: string;
  to: string;
  /**
   * `trace` is what verifies what, `system` a call inside the learner's code,
   * `kills` a test that catches a planted bug, `link` a line the learner drew.
   */
  kind: 'trace' | 'system' | 'kills' | 'link';
}

export interface ProjectMapData {
  nodes: MapNode[];
  edges: MapEdge[];
}

export interface BuildOptions {
  /** Show locked phases as one "Opens in phase N" placeholder each. Default true. */
  showLocked?: boolean;
  /** Fold criteria under given stories and tests under their function. */
  compact?: boolean;
}

/** What a node's state means in words, tuned per kind. */
export function stateLabel(state: StatusState, kind: MapNodeKind): string {
  const proving = kind === 'test' || kind === 'function' || kind === 'criterion' || kind === 'file';
  switch (state) {
    case 'pass':
      return proving ? 'Passing' : 'Done';
    case 'done':
      return 'Done';
    case 'now':
      return 'In progress';
    case 'fail':
      return 'Failing';
    case 'warn':
      return 'Needs a decision';
    default:
      return 'Not started';
  }
}

/** "manager.py, line 56": the way file references read everywhere in the app. */
export function fileReference(file?: string, line?: number): string {
  if (!file) return '';
  const base = file.split('/').pop() || file;
  return line ? `${base}, line ${line}` : base;
}

/* ------------------------------------------------------------------------ */
/* small text helpers                                                        */
/* ------------------------------------------------------------------------ */

const stripComments = (md: string) => md.replace(/<!--[\s\S]*?-->/g, '');
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const norm = (name: string) => name.replace(/[^a-z0-9]/gi, '').toLowerCase();
const basename = (p: string) => p.split('/').pop() || p;

/** Inline markdown to plain text: no emphasis marks, no backticks, no links. */
function plain(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What a Maintenance's change names, one entry per line: the ticket's title,
 * summary and acceptance lines, and the impact entries of the change request
 * the workspace holds. Empty for a Maintenance without a change request.
 */
function changeNamingText(d: PhaseDetail): string {
  const ticket = d.change?.ticket;
  if (!ticket) return '';
  const record = validateChangeRequestRecord(d.files.find((f) => f.path === CHANGE_REQUEST_JSON)?.content ?? '', null).change;
  const impact = record ? IMPACT_LISTS.flatMap((list) => record.impact[list]) : [];
  return [ticket.title, ticket.summary, ...ticket.acceptance.map((a) => a.line), ...impact].join('\n');
}

/** Whether `name` appears in `text` as a whole word (an identifier's characters on neither side). */
function namedAsWord(text: string, name: string): boolean {
  if (!text || !name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(text);
}

/** Words of an identifier: complete_task, completeTask, TestCompleteTask → complete task. */
function words(ident: string): string {
  return ident
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.\-:/]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** The verb of a function name, stemmed a little: complete_task → complet. */
function stem(ident: string): string {
  const first = words(ident).split(' ')[0] || ident.toLowerCase();
  return first.length > 4 ? first.replace(/e$/, '') : first;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isTestFile = (path: string) => {
  const b = basename(path).toLowerCase();
  return /^test_|_test\.|\.test\.|\.spec\./.test(b) || /(^|\/)tests?\//.test(path);
};
const isCodeFile = (path: string) => /\.(py|js|ts|mjs|cjs)$/.test(path);
const isMarkdown = (path: string) => /\.md$/i.test(path);

/* ------------------------------------------------------------------------ */
/* parsers                                                                   */
/* ------------------------------------------------------------------------ */

interface StoryRaw {
  id: string; // US-4
  title: string;
  file: string;
  line: number;
  given: boolean;
  written: boolean;
  sentence: string;
  criteria: CriterionRaw[];
}

interface CriterionRaw {
  id: string; // US-4.1
  label: string;
  text: string;
  /** The "when" clause: what the user does. Matching contracts against it avoids setup text. */
  action: string;
  file: string;
  line: number;
}

const STORY_LINE = /^\s{0,3}(?:#{1,6}\s*|\*\*|>\s*)?\s*(US-\d+)\b(.*)$/;

function storyTitle(rest: string): string {
  const t = rest
    .replace(/\*?\([^)]*\)\*?/g, '')
    .replace(/[*_`]+/g, '')
    .replace(/^\s*[·:—–-]+\s*/, '')
    .trim();
  return t || 'Untitled story';
}

function criterionLabel(text: string): string {
  const m = text.match(/^given\s+(.*?),\s*when\s+(.*?),\s*then\s+(.*)$/i);
  const tidy = (s: string) =>
    cap(
      s
        .replace(/^(i|the user|a user)\s+/i, '')
        .replace(/[.;:]\s*$/, '')
        .trim(),
    );
  if (m) return `${tidy(m[2])} → ${tidy(m[3]).replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}`;
  return cap(text.replace(/[.;:]\s*$/, ''));
}

/**
 * Markdown bullets wrap onto indented continuation lines; fold those back into
 * the bullet so a criterion is read whole. Each logical line keeps the number
 * of the line it started on.
 */
function logicalLines(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  src.split('\n').forEach((raw, i) => {
    const prev = out[out.length - 1];
    const continues =
      prev &&
      /^\s*(?:[-*+]|\d+[.)])\s+/.test(prev.text) &&
      /^\s+\S/.test(raw) &&
      !/^\s*(?:[-*+]|\d+[.)])\s+/.test(raw) &&
      !/^\s{0,3}#{1,6}\s/.test(raw);
    if (continues) prev.text += ' ' + raw.trim();
    else out.push({ text: raw, line: i + 1 });
  });
  return out;
}

function criterionAction(text: string): string {
  const m = text.match(/^given\s+(.*?),\s*when\s+(.*?),\s*then\s+/i);
  return m ? m[2] : text;
}

/** The map's id for a learner story whose id the learner picks and has not picked yet: `story:learner`. */
const LEARNER_STORY_NODE = 'learner';

/** The story id a record writes, trimmed; blank when it writes none or is not JSON. */
function rawStoryId(content: string): string {
  try {
    const parsed = JSON.parse(content) as { id?: unknown } | null;
    return parsed && typeof parsed.id === 'string' ? parsed.id.trim() : '';
  } catch {
    return '';
  }
}

/**
 * A story phase's stories, read from its structured parts rather than from
 * markdown: the provided stories the phase hands the learner (`PhaseDetail.story`)
 * and the learner's own record at `requirements/story.json`. Criterion ids take
 * the map's `US-4.2` shape from each story's local `AC-n`.
 */
/**
 * The story sentence's lead words, never doubled, by the web composer's
 * rule (apps/web/components/workspace/panels/requirements/storySentence.ts): a
 * persona typed with its article ("a team member", "As a team member", "the
 * team lead") keeps that one article, any other takes "a" or "an" by its first
 * letter; "I want" and "so that" are written only where the part does not
 * already start with them. A clean part reads as it did.
 */
const PERSONA_LEAD = /^(?:as\s+)?(a|an|the)\b[\s,]+(?=\S)/i;
const CAPABILITY_LEAD = /^(?:i\s+want\b[\s,]*)+/i;
const BENEFIT_LEAD = /^(?:so\s+that\b[\s,]*)+/i;
function personaLead(persona: string): string {
  let who = persona;
  let own: string | null = null;
  for (let lead = who.match(PERSONA_LEAD); lead; lead = who.match(PERSONA_LEAD)) {
    own = lead[1].toLowerCase();
    who = who.slice(lead[0].length);
  }
  return `As ${own ?? (/^[aeiou]/i.test(who) && !/^(?:uni|use|usu|ute|ub|eu|one)/i.test(who) ? 'an' : 'a')} ${who}`;
}
const withoutLead = (text: string, lead: RegExp) => text.replace(lead, '').trim() || text;
/**
 * "I want to" before a capability that starts with a bare verb, by the
 * web composer's closed lists (storySentence.ts, WANT_TO_VERBS and
 * WANT_TO_IF_OBJECT; keep the two copies the same): a verb in the first list
 * always gains "to"; a verb that is also a noun or adjective gains it only when
 * the next word opens an object. Any other capability reads as written.
 */
const WANT_TO_VERBS = new Set(['see', 'add', 'create', 'delete', 'remove', 'know', 'be', 'have', 'get', 'receive', 'manage', 'assign',
  'choose', 'select', 'find', 'write', 'submit', 'show', 'hide', 'spot', 'identify', 'rename', 'keep', 'tell', 'catch']);
const WANT_TO_IF_OBJECT = new Set(['view', 'filter', 'sort', 'search', 'list', 'mark', 'edit', 'update', 'change', 'check', 'review', 'track',
  'set', 'share', 'export', 'import', 'upload', 'download', 'open', 'close', 'complete', 'save', 'read', 'log', 'sign', 'reset', 'report', 'undo']);
const OBJECT_OPENERS = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those',
  'every', 'each', 'all', 'any', 'some', 'both', 'which', 'what', 'whether', 'how', 'when', 'where', 'who', 'it', 'them', 'me', 'us', 'only']);
function wanted(what: string): string {
  const [first = '', second = ''] = what.toLowerCase().split(/\s+/, 2).map((word) => word.replace(/[^a-z'-]+$/, ''));
  return WANT_TO_VERBS.has(first) || (WANT_TO_IF_OBJECT.has(first) && OBJECT_OPENERS.has(second)) ? `to ${what}` : what;
}

function storiesFromRecord(story: NonNullable<PhaseDetail['story']>, files: WorkspaceFile[]): StoryRaw[] {
  const record = files.find((f) => f.path === STORY_JSON);
  const criteriaOf = (id: string, list: AcceptanceCriterion[], file: string): CriterionRaw[] =>
    list
      .filter((c) => c.given.trim() && c.when.trim() && c.then.trim())
      .map((c, i) => {
        const text = `Given ${c.given.trim()}, when ${c.when.trim()}, then ${c.then.trim()}`;
        return {
          id: `${id}.${(c.id.match(/\d+/)?.[0]) ?? i + 1}`,
          label: criterionLabel(text),
          text,
          action: criterionAction(text),
          file,
          line: 1,
        };
      });
  const sentenceOf = (persona: string, capability: string, benefit: string): string =>
    persona.trim() && capability.trim() ? `${personaLead(persona.trim())}, I want ${wanted(withoutLead(capability.trim(), CAPABILITY_LEAD))}${benefit.trim() ? `, so that ${withoutLead(benefit.trim(), BENEFIT_LEAD)}` : ''}` : '';
  const out: StoryRaw[] = story.providedStories.map((p) => ({
    id: p.id,
    title: p.title,
    file: '',
    line: 1,
    given: true,
    written: true,
    sentence: sentenceOf(p.persona, p.capability, p.benefit),
    criteria: criteriaOf(p.id, p.criteria ?? [], ''),
  }));
  const own = parseStoryJson(record?.content ?? '');
  // The id the record itself names: `parseStoryJson` fills a blank one with a
  // default, which would name a story the learner has not picked yet.
  const named = rawStoryId(record?.content ?? '');
  const id = named || (story.id === LEARNER_PICKS ? LEARNER_STORY_NODE : story.id);
  if (id && !out.some((p) => p.id === id)) {
    const file = STORY_JSON;
    const criteria = criteriaOf(id, own.criteria, file);
    const sentence = sentenceOf(own.persona, own.capability, own.benefit);
    out.push({
      id,
      title: own.title.trim() || (id === LEARNER_STORY_NODE ? 'Your story' : id),
      file,
      line: 1,
      given: false,
      written: !!sentence || criteria.length > 0,
      sentence,
      criteria,
    });
  }
  return out;
}

function parseStories(file: WorkspaceFile): StoryRaw[] {
  const src = stripComments(file.content);
  const out: StoryRaw[] = [];
  let cur: StoryRaw | null = null;
  logicalLines(src).forEach(({ text: raw, line }) => {
    const m = raw.match(STORY_LINE);
    if (m) {
      const isHeading = /^\s{0,3}#{1,6}\s/.test(raw) || /^\s*\*\*US-\d+/.test(raw);
      // A story line is a heading or a bold lead; a stray "US-2" in prose is not one.
      if (isHeading) {
        cur = {
          id: m[1],
          title: storyTitle(m[2]),
          file: file.path,
          line,
          given: !file.editable,
          written: !file.editable,
          sentence: '',
          criteria: [],
        };
        out.push(cur);
        return;
      }
    }
    if (!cur) return;
    if (/^\s{0,3}#{1,6}\s/.test(raw) || /^\s*---+\s*$/.test(raw)) {
      cur = null;
      return;
    }
    const text = plain(raw);
    if (!cur.sentence && /^as an?\b.+\bi want\b/i.test(text)) {
      cur.sentence = text;
      cur.written = true;
    }
    const bullet = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!bullet) return;
    const body = plain(bullet[1]);
    if (!body || /\.\.\.|…/.test(body)) return;
    const explicit = body.match(/\b(US-\d+\.\d+|AC-?\d+)\b/);
    const looksLikeCriterion = explicit || /\bgiven\b/i.test(body) || /\bwhen\b[\s\S]*\bthen\b/i.test(body);
    if (!looksLikeCriterion) return;
    // Criterion numbering restarts inside every story: US-1, US-2 and US-3 all
    // write AC-1. A bare AC-n is therefore only unique once the story it sits
    // under is part of it, and `US-4.2` is the shape the rest of the map, and
    // `critKey`, already speak.
    const bare = explicit && /^AC-?\d+$/i.test(explicit[1]);
    const id = !explicit
      ? `${cur.id}.${cur.criteria.length + 1}`
      : bare
        ? `${cur.id}.${explicit[1].replace(/\D+/g, '')}`
        : explicit[1];
    const text2 = explicit ? body.replace(explicit[0], '').replace(/^[\s·:—–-]+/, '') : body;
    cur.criteria.push({
      id,
      label: criterionLabel(text2),
      text: text2,
      action: criterionAction(text2),
      file: file.path,
      line,
    });
    if (file.editable) cur.written = true;
  });
  return out;
}

interface ContractRaw {
  name: string;
  signature: string;
  story: string | null;
  filled: boolean;
  file: string;
  line: number;
}

interface DecisionRaw {
  id: string;
  text: string;
  tradeoff: string;
  file: string;
  line: number;
}

/** The line a JSON text first holds `needle` on, from 1; the first line when it holds none. */
function jsonLineOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  return at < 0 ? 1 : text.slice(0, at).split('\n').length;
}
const textOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const STORY_ID = /[A-Z][A-Z0-9]*-\d+/g;
/** The story ids a contract row names, as a list or in one line ("US-1" or ["US-1", "US-3"]). */
const storyIdsOf = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? (v.match(STORY_ID) ?? []) : []).map((x) => x.trim()).filter(Boolean))];

/**
 * A design phase's contracts and decisions, read from the design record and
 * the contracts its switches leave on (`PhaseDetail.design.contracts`), never
 * from markdown. An operation of the record is a contract under its name; an
 * endpoint of the API contract is one under its id; a screen of the screen
 * contract is one under its route. An older board's record is read folded,
 * as the room reads it. A phase with no design spec (still graded in the
 * older, markdown format) gives nothing.
 */
function designParts(detail: PhaseDetail): { contracts: (ContractRaw & { stories: string[]; key: string; given: boolean })[]; decisions: (DecisionRaw & { given: boolean })[] } {
  const contracts: (ContractRaw & { stories: string[]; key: string; given: boolean })[] = [];
  const decisions: (DecisionRaw & { given: boolean })[] = [];
  const switches = detail.design?.contracts;
  if (!switches) return { contracts, decisions };
  const fileAt = (path: string) => detail.files.find((f) => f.path === path);

  const recordFile = fileAt(DESIGN_JSON);
  const record = recordFile ? readDesignRecord(recordFile.content).design : null;
  if (recordFile && record) {
    for (const o of record.operations) {
      const name = operationBaseName(o.name);
      if (!name) continue;
      const args = /\(([^)]*)\)/.exec(o.name)?.[1]?.trim() ?? '';
      contracts.push({
        key: name, name, signature: `${name}(${args})`, story: o.satisfies[0] ?? null, stories: o.satisfies,
        filled: o.inputs.some((x) => x.trim()) || !!o.returns.trim() || o.errors.some((x) => x.trim()),
        file: recordFile.path, line: jsonLineOf(recordFile.content, `"id": ${JSON.stringify(o.id)}`), given: !recordFile.editable,
      });
    }
    for (const d of record.decisions) {
      const text = plain(d.title || d.choice);
      if (!text) continue;
      decisions.push({ id: d.id, text, tradeoff: plain(d.tradeOff), file: recordFile.path, line: jsonLineOf(recordFile.content, `"id": ${JSON.stringify(d.id)}`), given: !recordFile.editable });
    }
  }
  const apiFile = switches.api ? fileAt(API_CONTRACT_JSON) : undefined;
  if (apiFile) {
    for (const e of apiEndpoints(apiFile.content)) {
      const id = textOf(e.id);
      if (!id) continue;
      const stories = storyIdsOf(e.satisfies);
      const route = [textOf(e.method), textOf(e.path)].filter(Boolean).join(' ');
      contracts.push({
        key: id, name: id, signature: route ? `${id}: ${route}` : id, story: stories[0] ?? null, stories,
        filled: !!textOf(e.summary) || isObject(e.success), file: apiFile.path, line: jsonLineOf(apiFile.content, `"id": ${JSON.stringify(id)}`), given: !apiFile.editable,
      });
    }
  }
  const screensFile = switches.screens ? fileAt(SCREEN_CONTRACT_JSON) : undefined;
  if (screensFile) {
    for (const r of screenRows(screensFile.content)) {
      const route = textOf(r.route);
      if (!route) continue;
      const component = textOf(r.component);
      const stories = storyIdsOf(r.satisfies);
      contracts.push({
        key: `screen ${route}`, name: component || route, signature: component ? `${route} ${component}` : route, story: stories[0] ?? null, stories,
        filled: !!component && !!textOf(r.empty), file: screensFile.path, line: jsonLineOf(screensFile.content, `"route": ${JSON.stringify(route)}`), given: !screensFile.editable,
      });
    }
  }
  return { contracts, decisions };
}

interface FunctionRaw {
  name: string;
  file: string;
  line: number;
  /** Last line of the block, so a traceback frame can be placed inside it. */
  endLine: number;
  body: string;
  text: string;
  given: boolean;
}

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor',
  'else', 'do', 'try', 'with', 'it', 'test', 'describe', 'beforeEach', 'afterEach',
]);

function pyBlocks(src: string, head: RegExp): { name: string; line: number; body: string; text: string }[] {
  const lines = src.split('\n');
  const out: { name: string; line: number; body: string; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(head);
    if (!m) continue;
    const indent = m[1].length;
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() !== '' && (l.match(/^[ \t]*/) as RegExpMatchArray)[0].length <= indent) break;
      j++;
    }
    out.push({
      name: m[2],
      line: i + 1,
      body: lines.slice(i + 1, j).join('\n'),
      text: lines.slice(i, j).join('\n'),
    });
  }
  return out;
}

function braceBody(src: string, from: number): string {
  let depth = 0;
  let start = -1;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) return src.slice(start + 1, i);
    } else if (start < 0 && i - from > 400) {
      break;
    }
  }
  return start >= 0 ? src.slice(start + 1) : '';
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

function jsBlocks(src: string): { name: string; line: number; body: string; text: string }[] {
  const out: { name: string; line: number; body: string; text: string }[] = [];
  const seen = new Set<string>();
  const push = (name: string, index: number, openAt: number) => {
    if (JS_KEYWORDS.has(name) || seen.has(name)) return;
    seen.add(name);
    const body = braceBody(src, openAt);
    out.push({ name, line: lineOf(src, index), body, text: body });
  };
  const method = /^[ \t]*(?:async\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm;
  const fn = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  const arrow = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
  let m: RegExpExecArray | null;
  while ((m = fn.exec(src))) push(m[1], m.index, m.index + m[0].length);
  while ((m = arrow.exec(src))) push(m[1], m.index, m.index + m[0].length);
  while ((m = method.exec(src))) push(m[1], m.index, m.index + m[0].length - 1);
  out.sort((a, b) => a.line - b.line);
  return out;
}

function parseFunctions(file: WorkspaceFile): FunctionRaw[] {
  const blocks = file.path.endsWith('.py')
    ? pyBlocks(file.content, /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
    : jsBlocks(file.content);
  return blocks
    .filter((b) => !b.name.startsWith('_') && !/^test/i.test(b.name))
    .map((b) => ({
      ...b,
      file: file.path,
      // `text` is the whole block for Python and the body for JS; either way its
      // line count is close enough to place a frame inside the right function.
      endLine: b.line + Math.max(0, b.text.split('\n').length - 1),
      given: !file.editable,
    }));
}

interface TestRaw {
  name: string;
  file: string;
  line: number;
  body: string;
  given: boolean;
}

function parseTests(file: WorkspaceFile): TestRaw[] {
  if (file.path.endsWith('.py')) {
    return pyBlocks(file.content, /^([ \t]*)(?:async\s+)?def\s+(test_\w*)\s*\(/).map((b) => ({
      name: b.name,
      file: file.path,
      line: b.line,
      body: b.body,
      given: !file.editable,
    }));
  }
  const out: TestRaw[] = [];
  const re = /\b(?:test|it)\(\s*(['"`])(.*?)\1/g;
  const src = file.content;
  let m: RegExpExecArray | null;
  const starts: number[] = [];
  const names: string[] = [];
  while ((m = re.exec(src))) {
    starts.push(m.index);
    names.push(m[2]);
  }
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : src.length;
    out.push({ name: names[i], file: file.path, line: lineOf(src, s), body: src.slice(s, end), given: !file.editable });
  });
  return out;
}

/** Strip docstrings and comments so a body that is only `pass` reads as empty. */
function pyMeat(body: string): string {
  return body
    .replace(/("""|''')[\s\S]*?\1/g, '')
    .replace(/#[^\n]*/g, '')
    .trim();
}

function isUnimplemented(fn: FunctionRaw): boolean {
  if (/NotImplementedError|TODO|FIXME|not implemented/i.test(fn.body)) return true;
  if (fn.file.endsWith('.py')) {
    const meat = pyMeat(fn.body);
    return meat === '' || meat === 'pass' || meat === '...';
  }
  const meat = fn.body.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim();
  return meat === '';
}

function testHasAssertions(t: TestRaw): boolean {
  return /\bassert|expect\(|\.toBe|\.rejects|\.throws/.test(t.body);
}

/** The bare test name inside a runner's case name: "tests/x.py::T::test_a" → test_a. */
function caseKey(name: string): string {
  const m = name.match(/\b(test_[A-Za-z0-9_]+)/);
  if (m) return m[1];
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}

/* ------------------------------------------------------------------------ */
/* the evidence rows: frames, claims, planted bugs, learner links           */
/* ------------------------------------------------------------------------ */

const CLAIM_WORD: Record<ContractClaim['claim'], string> = {
  inputs: 'Inputs',
  returns: 'Returns',
  errors: 'Errors',
  ordering: 'Ordering',
  boundary: 'Boundary',
};

const VERDICT_WORD: Record<ContractClaim['verdict'], string> = {
  kept: 'Kept',
  broken: 'Broken',
  unclaimed: 'Unclaimed',
  contradicted: 'Contradicted',
};

const VERDICT_STATE: Record<ContractClaim['verdict'], StatusState> = {
  kept: 'pass',
  broken: 'fail',
  unclaimed: 'todo',
  contradicted: 'warn',
};

/**
 * One sentence of evidence, short enough to sit under a row, cut at a word.
 *
 * Cutting at whatever character the limit lands on leaves a map block reading
 * "Complete it → it is stored as done with the tim…" and a palette row
 * "Open the overdue page → it is not on it, becaus…".
 * So the break walks back to the last space, unless that would throw away
 * more than a quarter of the line: a single long token has nowhere to break
 * and is better cut than reduced to nothing.
 */
function clip(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const kept = space > max * 0.75 ? cut.slice(0, space) : cut;
  return `${kept.trimEnd()}…`;
}

/**
 * Criterion ids travel in several shapes: the map builds `crit:US-4.2`, the
 * content packs write `US-4/AC-2`, and a learner's picker may send either. All
 * of them reduce to `us42`, which is what the resolvers compare.
 */
function critKey(id: string): string {
  return id
    .replace(/^crit:/, '')
    .replace(/\bAC-?/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

interface FunctionEntry {
  node: MapNode;
  raw: FunctionRaw;
  phase: PhaseKey;
}

/** The function a traceback frame lands in, by file and line range. */
function functionAtFrame(
  frame: TestFrame,
  functions: FunctionEntry[],
  analyzer: AnalyzerFunction[],
): MapNode | undefined {
  const file = basename(frame.path);
  const hit = analyzer.find(
    (f) => basename(f.path) === file && frame.line >= f.line && frame.line <= f.endLine,
  );
  if (hit) {
    const named = functions.find((f) => f.raw.name === hit.name && basename(f.raw.file) === file);
    if (named) return named.node;
  }
  const inRange = functions.find(
    (f) => basename(f.raw.file) === file && frame.line >= f.raw.line && frame.line <= f.raw.endLine,
  );
  return inRange?.node;
}

/** How each test fared against one planted bug; the catchers come first. */
function mutantRows(row: MutantRow): MapEvidenceRow[] {
  return [...row.cases]
    .sort((a, b) => Number(a.status === 'passed') - Number(b.status === 'passed'))
    .slice(0, 20)
    .map((c): MapEvidenceRow => ({
      label: caseKey(c.name).replace(/^test_/, ''),
      result: c.status === 'passed' ? 'Missed it' : 'Caught it',
      state: c.status === 'passed' ? 'todo' : 'pass',
      mono: true,
    }));
}

/* ------------------------------------------------------------------------ */
/* the builder                                                               */
/* ------------------------------------------------------------------------ */

const PLACEHOLDER_LABEL: Record<PhaseKey, string> = {
  requirements: 'Stories and criteria',
  design: 'Contracts and decisions',
  implementation: 'Functions',
  testing: 'Tests and planted bugs',
  deployment: 'Runbook, Dockerfile, CI',
  maintenance: 'Change request',
};

const PHASE_INDEX: Record<PhaseKey, number> = PHASE_ORDER.reduce(
  (acc, k, i) => ({ ...acc, [k]: i }),
  {} as Record<PhaseKey, number>,
);

export function buildProjectMap(
  enrollment: EnrollmentView | null | undefined,
  details: Record<string, PhaseDetail>,
  opts: BuildOptions = {},
): ProjectMapData {
  const showLocked = opts.showLocked !== false;
  const compact = Boolean(opts.compact);
  if (!enrollment) return { nodes: [], edges: [] };

  const phases = [...enrollment.phases].sort((a, b) => a.order - b.order);
  const byKey = new Map<PhaseKey, PhaseSummary>();
  phases.forEach((p) => byKey.set(p.key, p));
  const detailOf = (key: PhaseKey): PhaseDetail | undefined => {
    const p = byKey.get(key);
    return p ? details[p.id] : undefined;
  };
  const baseState = (key: PhaseKey): StatusState => {
    const p = byKey.get(key);
    if (!p) return 'todo';
    return statusState(p.status, p.order === enrollment.currentPhaseOrder);
  };
  const isPassed = (key: PhaseKey) => byKey.get(key)?.status === 'passed';
  const hrefFor = (key: PhaseKey, file?: string) => {
    const p = byKey.get(key);
    if (!p) return undefined;
    return file ? `/workspace/${p.id}?file=${encodeURIComponent(file)}` : `/workspace/${p.id}`;
  };

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const edgeSeen = new Set<string>();
  const link = (from: string, to: string, kind: MapEdge['kind'] = 'trace') => {
    if (from === to) return;
    const k = `${from}>${to}`;
    if (edgeSeen.has(k)) return;
    edgeSeen.add(k);
    edges.push({ from, to, kind });
  };
  const add = (n: MapNode) => {
    nodes.push(n);
    return n;
  };

  /* ---------------------------- requirements --------------------------- */
  const stories: StoryRaw[] = [];
  const critAction = new Map<string, string>();
  const req = detailOf('requirements');
  if (req) {
    const seen = new Map<string, StoryRaw>();
    const files = [...req.files].sort((a, b) => Number(a.editable) - Number(b.editable));
    // a story phase writes no markdown: its stories are its provided stories and the record
    if (req.story) stories.push(...storiesFromRecord(req.story, req.files));
    else files.forEach((f) => {
      if (!isMarkdown(f.path)) return;
      parseStories(f).forEach((s) => {
        const prev = seen.get(s.id);
        // the learner's file owns any story it names; the backlog only points at it
        if (!prev || f.editable) {
          if (prev) stories.splice(stories.indexOf(prev), 1);
          seen.set(s.id, s);
          stories.push(s);
        }
      });
    });
    const ph = 'requirements';
    stories.forEach((s) => {
      const id = `story:${s.id}`;
      const state: StatusState = s.given ? 'done' : !s.written ? 'todo' : baseState(ph);
      add({
        id,
        phase: ph,
        kind: 'story',
        label: s.title,
        sub: `${s.id}, ${s.given ? 'given' : s.written ? 'written by you' : 'yours to write'}`,
        state,
        file: s.file,
        line: s.line,
        href: hrefFor(ph, s.file),
        phaseId: req.id,
        detail: s.sentence || undefined,
        given: s.given,
      });
      s.criteria.forEach((c) => {
        const cid = `crit:${c.id}`;
        critAction.set(cid, c.action);
        add({
          id: cid,
          phase: ph,
          // Clipped: a block on the map is one or two short lines, and an
          // unclipped criterion sentence made the Requirements column three
          // times the height of every other column. The full sentence is on
          // `detail`, which is what the drawer reads.
          kind: 'criterion',
          label: clip(c.label, 48),
          name: c.id,
          sub: `${c.id}, ${s.title}`,
          state: s.given ? 'done' : baseState(ph),
          file: c.file,
          line: c.line,
          href: hrefFor(ph, c.file),
          phaseId: req.id,
          detail: c.text,
          given: s.given,
        });
        link(id, cid);
      });
    });
  }

  /* ------------------------------- design ------------------------------ */
  const contracts: (ContractRaw & { key: string })[] = [];
  const design = detailOf('design');
  if (design) {
    const ph = 'design';
    const seen = new Set<string>();
    const parts = designParts(design);
    parts.contracts.forEach((c) => {
      const key = norm(c.key);
      if (seen.has(key)) return;
      seen.add(key);
      contracts.push(c);
      const id = `contract:${c.key}`;
      const named = c.stories.length ? c.stories.join(', ') : null;
      add({
        id,
        phase: ph,
        kind: 'contract',
        label: c.signature,
        name: c.name,
        sub: named ? `Contract for ${named}` : 'Contract, no story named',
        state: !c.filled ? 'todo' : baseState(ph),
        file: c.file,
        line: c.line,
        href: hrefFor(ph, c.file),
        phaseId: design.id,
        mono: true,
        given: c.given,
      });
      // a criterion whose action speaks the contract's verb traces to it;
      // a story it names only when none of that story's criteria do
      const verb = new RegExp(`\\b${escapeRe(stem(c.name))}`, 'i');
      const viaCriterion = new Set<string>();
      nodes.forEach((n) => {
        if (n.kind !== 'criterion' || !verb.test(critAction.get(n.id) || '')) return;
        link(n.id, id);
        for (const us of c.stories) if (n.id.startsWith(`crit:${us}.`)) viaCriterion.add(us);
      });
      for (const us of c.stories) if (!viaCriterion.has(us)) link(`story:${us}`, id);
    });
    parts.decisions.forEach((d) => {
      add({
        id: `decision:${d.id}`,
        phase: ph,
        kind: 'decision',
        label: d.text,
        sub: `Decision ${d.id}`,
        state: baseState(ph),
        file: d.file,
        line: d.line,
        href: hrefFor(ph, d.file),
        phaseId: design.id,
        detail: d.tradeoff || undefined,
        given: d.given,
      });
    });
  }

  /* --------------------------- implementation -------------------------- */
  const functions: FunctionEntry[] = [];
  const implPhases: PhaseKey[] = ['implementation', 'maintenance'];
  implPhases.forEach((ph) => {
    const d = detailOf(ph);
    if (!d) return;
    // A Maintenance with a change request names its functions in the ticket
    // and the record's impact; an older one, in its task panel's CR line.
    const cr = ph === 'maintenance' && !d.change ? (d.taskPanel.match(/CR-\d+[^\n]*/) || [''])[0] : '';
    const changeWords = ph === 'maintenance' ? changeNamingText(d) : '';
    d.files.forEach((f) => {
      if (!isCodeFile(f.path) || isTestFile(f.path) || !f.editable) return;
      const fns = parseFunctions(f);
      const inFile: { node: MapNode; raw: FunctionRaw }[] = [];
      fns.forEach((fn) => {
        const marker = /TODO|NotImplementedError|not implemented|US-\d+|CR-\d+/i.test(fn.text);
        const contract = contracts.find((c) => norm(c.name) === norm(fn.name));
        const namedInChange = ph === 'maintenance' && (cr.includes(fn.name) || namedAsWord(changeWords, fn.name) || d.taskPanel.includes(`${fn.name}(`));
        // the maintenance file is the whole finished system again; only the change belongs on the map
        if (ph === 'maintenance' && !namedInChange && !/TODO|NotImplementedError|not implemented|CR-\d+/i.test(fn.text)) return;
        if (nodes.some((n) => n.kind === 'function' && n.id === `fn:${ph}:${fn.name}`)) return;
        const id = `fn:${ph}:${fn.name}`;
        const given = !marker && !contract && !namedInChange;
        const node = add({
          id,
          phase: ph === 'maintenance' ? 'maintenance' : 'implementation',
          kind: 'function',
          label: `${fn.name}()`,
          name: fn.name,
          sub: fileReference(fn.file, fn.line),
          state: isUnimplemented(fn) ? 'todo' : given ? 'done' : baseState(ph),
          file: fn.file,
          line: fn.line,
          href: hrefFor(ph, fn.file),
          phaseId: d.id,
          mono: true,
          given,
        });
        functions.push({ node, raw: fn, phase: ph });
        inFile.push({ node, raw: fn });
        if (contract) link(`contract:${contract.key}`, id);
        (fn.text.match(/US-\d+/g) || []).forEach((us) => {
          const hasPath = contract && contract.story === us;
          if (!hasPath && nodes.some((n) => n.id === `story:${us}`)) link(`story:${us}`, id);
        });
      });
      // system edges: who calls whom inside the same file
      inFile.forEach((a) => {
        inFile.forEach((b) => {
          if (a === b) return;
          if (new RegExp(`\\b${escapeRe(b.raw.name)}\\s*\\(`).test(a.raw.body)) link(a.node.id, b.node.id, 'system');
        });
      });
    });
  });

  /* ------------------------------ testing ------------------------------ */
  const testNodes: MapNode[] = [];
  // every test node by its bare case name, so a mutant row, a traceback frame
  // and a learner's link can all find the block they belong to
  const testByKey = new Map<string, MapNode>();
  const testPhases: PhaseKey[] = ['implementation', 'testing', 'maintenance'];
  // every recorded case, so a parsed test can carry its last result
  const cases = new Map<string, TestCaseResult>();
  const hiddenCases: { phase: PhaseKey; phaseId: string; c: TestCaseResult }[] = [];
  testPhases.forEach((ph) => {
    const d = detailOf(ph);
    const tests = d?.lastSubmission?.report?.tests;
    tests?.cases.forEach((c) => {
      const key = caseKey(c.name);
      const prev = cases.get(key);
      if (!prev || c.status !== 'passed') cases.set(key, c);
      if (c.hidden) hiddenCases.push({ phase: ph, phaseId: d!.id, c });
    });
  });

  const primaryFunctionFor = (name: string, body: string): MapNode[] => {
    const w = words(name);
    let best: { node: MapNode; at: number } | null = null;
    functions.forEach((f) => {
      const at = w.search(new RegExp(`\\b${escapeRe(stem(f.raw.name))}`));
      if (at >= 0 && (!best || at < best.at)) best = { node: f.node, at };
    });
    if (best) return [(best as { node: MapNode }).node];
    if (!body) return [];
    return functions
      .filter((f) => new RegExp(`\\b${escapeRe(f.raw.name)}\\s*\\(`).test(body))
      .map((f) => f.node);
  };

  testPhases.forEach((ph) => {
    const d = detailOf(ph);
    if (!d) return;
    d.files.forEach((f) => {
      if (!isCodeFile(f.path) || !isTestFile(f.path)) return;
      parseTests(f).forEach((t) => {
        const id = `test:${basename(t.file).replace(/\.\w+$/, '')}:${t.name.replace(/[^A-Za-z0-9_.-]+/g, '_')}`;
        if (nodes.some((n) => n.id === id)) return;
        const result = cases.get(caseKey(t.name));
        const state: StatusState = result
          ? result.status === 'passed'
            ? 'pass'
            : 'fail'
          : !testHasAssertions(t)
            ? 'todo'
            : t.given
              ? 'done'
              : isPassed(ph)
                ? 'pass'
                : baseState(ph);
        const node = add({
          id,
          phase: 'testing',
          kind: 'test',
          label: t.name.replace(/^test_/, ''),
          name: t.name,
          sub: t.given ? `Visible test, ${basename(t.file)}` : `Written by you, ${fileReference(t.file, t.line)}`,
          state,
          file: t.file,
          line: t.line,
          href: hrefFor(ph, t.file),
          phaseId: d.id,
          mono: /^[\w.$]+$/.test(t.name),
          detail: result?.message || undefined,
          given: t.given,
        });
        testNodes.push(node);
        testByKey.set(caseKey(t.name), node);
        primaryFunctionFor(t.name, t.body).forEach((fn) => link(fn.id, id));
      });
    });
  });

  const hiddenSeen = new Set<string>();
  hiddenCases.forEach(({ phase, phaseId, c }) => {
    const key = caseKey(c.name);
    if (hiddenSeen.has(key) || nodes.some((n) => n.kind === 'test' && caseKey(n.label) === key.replace(/^test_/, ''))) return;
    hiddenSeen.add(key);
    const id = `test:hidden:${key.replace(/[^A-Za-z0-9_.-]+/g, '_')}`;
    const node = add({
      id,
      phase: 'testing',
      kind: 'test',
      label: key.replace(/^test_/, ''),
      name: key,
      sub: 'Hidden test',
      state: c.status === 'passed' ? 'pass' : 'fail',
      href: hrefFor(phase),
      phaseId,
      mono: /^[\w.$]+$/.test(key),
      detail: c.message || undefined,
    });
    testNodes.push(node);
    testByKey.set(key, node);
    primaryFunctionFor(key, '').forEach((fn) => link(fn.id, id));
  });

  // planted bugs: what the mutation run says about the learner's suite
  const testing = detailOf('testing');
  const mutation = testing?.lastSubmission?.report?.mutation;
  const bugNodes: MapNode[] = [];
  if (testing && mutation) {
    const notRun = mutation.survivors.some((s) => /not evaluated/i.test(s.description));
    // which function a planted bug was aimed at, by the name it mutates
    const aimedAt = (name: string, description: string): MapNode | undefined => {
      const hay = `${name} ${description}`;
      const hit =
        functions.find((f) => hay.includes(f.raw.name)) ||
        functions.find((f) => new RegExp(`\\b${escapeRe(stem(f.raw.name))}`, 'i').test(words(name)));
      return hit?.node;
    };
    const matrix = mutation.matrix?.length ? mutation.matrix : null;
    if (matrix) {
      // The kill matrix names every mutant and how each test fared against it,
      // so each one gets its own block; the coarse survivor list below is only
      // read when a run predates the matrix.
      const caught = new Map<string, MapEvidenceRow[]>();
      matrix.forEach((row) => {
        const node = add({
          id: `bug:${row.mutant}`,
          phase: 'testing',
          kind: 'bug',
          label: row.mutant,
          name: row.mutant,
          sub: row.killed ? 'Caught by your tests' : 'Survived your tests',
          state: row.killed ? 'pass' : 'fail',
          href: hrefFor('testing'),
          phaseId: testing.id,
          mono: true,
          detail: row.covers ? `${row.description} Covers ${row.covers}.` : row.description,
          evidence: [
            {
              kind: 'kills',
              title: 'Tests against this bug',
              purpose: 'A test that fails against the planted bug is the one that catches it.',
              column: 'Test',
              resultColumn: 'Against this bug',
              rows: mutantRows(row),
            },
          ],
        });
        bugNodes.push(node);
        const aim = aimedAt(row.mutant, row.description);
        if (aim) link(aim.id, node.id);
        const killers = row.cases.filter((c) => c.status !== 'passed');
        // the drawing names the first two catchers; the drawer lists every case
        killers.slice(0, 2).forEach((c) => {
          const t = testByKey.get(caseKey(c.name));
          if (t) link(t.id, node.id, 'kills');
        });
        killers.forEach((c) => {
          const key = caseKey(c.name);
          caught.set(key, [
            ...(caught.get(key) || []),
            {
              label: row.mutant,
              detail: clip(row.description),
              result: row.covers,
              state: 'pass',
              mono: true,
            },
          ]);
        });
      });
      caught.forEach((rows, key) => {
        const t = testByKey.get(key);
        if (!t) return;
        t.evidence = [
          ...(t.evidence || []),
          {
            kind: 'kills',
            title: 'Planted bugs it catches',
            purpose: 'Bugs the course plants in the code that this test fails against.',
            column: 'Bug',
            resultColumn: rows.some((r) => r.result) ? 'Breaks' : undefined,
            rows,
          },
        ];
      });
    } else if (mutation.killed > 0) {
      bugNodes.push(
        add({
          id: 'bug:killed',
          phase: 'testing',
          kind: 'bug',
          label: `${mutation.killed} ${mutation.killed === 1 ? 'bug' : 'bugs'} caught`,
          sub: 'Killed by your tests',
          state: 'pass',
          href: hrefFor('testing'),
          phaseId: testing.id,
        }),
      );
    }
    (matrix ? [] : mutation.survivors).forEach((s) => {
      const node = add({
        id: `bug:${s.name}`,
        phase: 'testing',
        kind: 'bug',
        label: s.name,
        sub: notRun ? 'Not run yet' : 'Survived your tests',
        state: notRun ? 'todo' : 'fail',
        href: hrefFor('testing'),
        phaseId: testing.id,
        mono: true,
        detail: s.description,
      });
      bugNodes.push(node);
      const aim = aimedAt(s.name, s.description);
      if (aim) link(aim.id, node.id);
    });
  }

  /* ----------------------------- deployment ---------------------------- */
  const deploy = detailOf('deployment');
  if (deploy) {
    const ph = 'deployment';
    const checks = deploy.lastSubmission?.report?.checks || [];
    const checksFor = (base: string): FeedbackCheck[] => {
      const b = base.toLowerCase();
      return checks.filter((c) => {
        const id = c.id.toLowerCase();
        if (b === 'dockerfile') return id.startsWith('docker') || id === 'build-smoke' || c.label.toLowerCase().includes('dockerfile');
        if (b === 'ci.yml') return id.startsWith('ci') || /\bci\b/i.test(c.label);
        if (b === 'runbook.md') return id.startsWith('runbook') || c.label.toLowerCase().includes('runbook');
        return c.label.toLowerCase().includes(b);
      });
    };
    // The drill outranks the checks on the two files it is about: the one it
    // faulted, and the runbook whose incident section has to name the fault.
    const drill = deploy.lastSubmission?.report?.drill;
    const openDrill = deploy.drill && !deploy.drill.resolvedAt ? deploy.drill : null;
    // A phase with the runbook record: the record is one node, keyed on the
    // `runbook.*` checks, never a file node (its file is written through forms).
    const record = Boolean(deploy.runbook);
    deploy.files.forEach((f) => {
      if (!f.editable) return;
      if (record && f.path === RUNBOOK_JSON) return;
      const base = basename(f.path);
      const mine = checksFor(base);
      const todos = (f.content.match(/TODO/g) || []).length;
      const failed = mine.filter((c) => c.status === 'failed');
      const warned = mine.filter((c) => c.status === 'warning');
      const passed = mine.filter((c) => c.status === 'passed');
      let state: StatusState;
      let sub: string;
      if (mine.length) {
        state = failed.length ? 'fail' : warned.length ? 'warn' : 'pass';
        sub =
          mine.length === 1
            ? failed.length ? 'Its check failed' : warned.length ? 'Its check needs a look' : 'Its check passed'
            : failed.length || warned.length
              ? `${passed.length} of ${mine.length} checks passed`
              : `All ${mine.length} checks passed`;
      } else if (todos) {
        state = 'todo';
        sub = `${todos} ${todos === 1 ? 'TODO' : 'TODOs'} left`;
      } else {
        state = isPassed(ph) ? 'pass' : baseState(ph);
        sub = isPassed(ph) ? 'Checked and passed' : 'Not submitted yet';
      }
      let detail = failed.length ? failed.map((c) => c.label).join('. ') : undefined;
      const isRunbook = /^runbook\.md$/i.test(base);
      const faulted = Boolean(
        drill && new RegExp(`\\b${escapeRe(base)}`, 'i').test(`${drill.fault} ${drill.faultDescription}`),
      );
      if (drill && faulted) {
        state = drill.passedAfterFix ? 'pass' : 'fail';
        sub = drill.passedAfterFix ? 'Fixed, the smoke check passes' : 'The smoke check still fails';
        detail = drill.faultDescription;
      } else if (isRunbook && openDrill) {
        state = 'now';
        sub = 'INCIDENT-1 is open';
        detail = `Paged about ${openDrill.fault}.`;
      } else if (isRunbook && drill && !drill.diagnosisNamesFault) {
        state = 'warn';
        sub = 'The incident section does not name the fault';
        detail = drill.faultDescription;
      }
      add({
        id: `file:${ph}:${base}`,
        phase: ph,
        kind: 'file',
        label: base,
        sub,
        state,
        file: f.path,
        href: hrefFor(ph, f.path),
        phaseId: deploy.id,
        mono: true,
        detail,
      });
    });
    if (record) {
      const mine = checks.filter((c) => c.id.startsWith('runbook.'));
      const failed = mine.filter((c) => c.status === 'failed');
      const warned = mine.filter((c) => c.status === 'warning');
      const passed = mine.filter((c) => c.status === 'passed');
      let state: StatusState;
      let sub: string;
      if (mine.length) {
        state = failed.length ? 'fail' : warned.length ? 'warn' : 'pass';
        sub =
          mine.length === 1
            ? failed.length ? 'Its check failed' : warned.length ? 'Its check needs a look' : 'Its check passed'
            : failed.length || warned.length
              ? `${passed.length} of ${mine.length} checks passed`
              : `All ${mine.length} checks passed`;
      } else {
        state = isPassed(ph) ? 'pass' : baseState(ph);
        sub = isPassed(ph) ? 'Checked and passed' : 'Not submitted yet';
      }
      let detail = failed.length ? failed.map((c) => c.label).join('. ') : undefined;
      // The incident is the record's (the drill writes it there): an open drill, or a write-up that misses the fault.
      const incident = deploy.drill?.incident ?? null;
      if (openDrill) {
        state = 'now';
        sub = 'The incident drill is open';
        detail = `Paged about ${openDrill.fault}.`;
      } else if (drill && !drill.diagnosisNamesFault) {
        state = 'warn';
        sub = 'The incident does not name the fault';
        detail = drill.faultDescription;
      } else if (incident && !detail) {
        detail = `Root cause: ${incident.rootCause}`;
      }
      add({
        id: `record:${ph}:runbook`,
        phase: ph,
        kind: 'file',
        label: 'Runbook',
        sub,
        state,
        href: hrefFor(ph) && `${hrefFor(ph)}?panel=runbook`,
        phaseId: deploy.id,
        detail,
      });
    }
  }

  /* ----------------------------- maintenance --------------------------- */
  const maint = detailOf('maintenance');
  if (maint) {
    const ph = 'maintenance';
    // The ticket names the node where the phase carries one (`checks.ticket`);
    // an older Maintenance is still read from its task panel's CR line.
    const ticket = maint.change?.ticket;
    const mentions = ticket ? [] : Array.from(maint.taskPanel.matchAll(/(CR-\d+)[ \t]*(?:[·:—–-]+[ \t]*\*{0,2}([^\n*.]+))?/g));
    const m = mentions.find((x) => x[2] && x[2].trim()) || mentions[0];
    if (ticket || m) {
      const crId = ticket ? ticket.id : m![1];
      const title = ticket ? ticket.title.trim() || 'Change request' : cap(plain(m![2] || '').replace(/[.;:]\s*$/, '').trim()) || 'Change request';
      const tests = maint.lastSubmission?.report?.tests;
      const state: StatusState = isPassed(ph)
        ? 'pass'
        : tests && (tests.failed > 0 || tests.errored > 0)
          ? 'fail'
          : baseState(ph);
      const id = `change:${crId}`;
      add({
        id,
        phase: ph,
        kind: 'change',
        label: title,
        sub: `Change request ${crId}`,
        state,
        href: hrefFor(ph),
        phaseId: maint.id,
      });
      functions.filter((f) => f.phase === 'maintenance').forEach((f) => link(id, f.node.id));
    }
  }

  /* ----------------- frames, claims and the learner's links ------------- */
  // Every block exists by now, so the rest of the reports can be read against
  // them: where a failing test stopped, what the contract claimed, and the
  // lines the learner drew themselves.
  const nodeIndex = new Map<string, MapNode>();
  nodes.forEach((n) => nodeIndex.set(n.id, n));

  const analyzerFunctions: AnalyzerFunction[] = [];
  testPhases.forEach((ph) => {
    detailOf(ph)?.lastSubmission?.report?.staticAnalysis?.functions?.forEach((f) =>
      analyzerFunctions.push(f),
    );
  });
  cases.forEach((c, key) => {
    const node = testByKey.get(key);
    if (!node || c.status === 'passed') return;
    const frames = (c.frames || []).slice(0, 5);
    if (!frames.length) return;
    // the deepest frame is the line that raised; the function around it is the
    // one the failure belongs to, whatever the test is called
    const fn = functionAtFrame(frames[0], functions, analyzerFunctions);
    if (fn) link(fn.id, node.id);
    node.evidence = [
      ...(node.evidence || []),
      {
        kind: 'frames',
        title: 'Where it failed',
        purpose: 'The frames inside your own files, deepest first. The top one is where the run stopped.',
        column: 'Frame',
        resultColumn: fn ? 'Function' : undefined,
        rows: frames.map(
          (f, i): MapEvidenceRow => ({
            label: fileReference(f.path, f.line),
            detail: f.snippet ? clip(f.snippet) : undefined,
            result: i === 0 && fn ? clip(fn.label, 28) : undefined,
            state: i === 0 ? 'fail' : 'todo',
            mono: true,
          }),
        ),
      },
    ];
  });

  const claims: ContractClaim[] = [];
  (['implementation', 'maintenance'] as PhaseKey[]).forEach((ph) => {
    detailOf(ph)?.lastSubmission?.report?.contract?.forEach((c) => claims.push(c));
  });
  if (claims.length) {
    const byName = new Map<string, ContractClaim[]>();
    claims.forEach((c) => {
      const key = norm(c.name);
      byName.set(key, [...(byName.get(key) || []), c]);
    });
    byName.forEach((list, key) => {
      // the claim is about a contract; a function with no contract of its own
      // still shows the verdict, because that is exactly what unclaimed means
      const target =
        nodes.find((n) => n.kind === 'contract' && norm(n.name || n.label) === key) ||
        nodes.find((n) => n.kind === 'function' && norm(n.name || '') === key);
      if (!target) return;
      if (target.kind === 'contract') {
        if (list.some((c) => c.verdict === 'broken')) target.state = 'fail';
        else if (list.some((c) => c.verdict === 'contradicted')) target.state = 'warn';
      }
      if (list.every((c) => c.verdict === 'unclaimed')) target.unclaimed = true;
      target.evidence = [
        ...(target.evidence || []),
        {
          kind: 'claims',
          title: 'What your contract claimed',
          purpose: 'Each claim in the contract, against what the run actually did.',
          column: 'Claim',
          resultColumn: 'Verdict',
          rows: list.map(
            (c): MapEvidenceRow => ({
              label: clip(plain(c.text), 200),
              detail: [CLAIM_WORD[c.claim], (c.evidence || [])[0] ? clip((c.evidence || [])[0]) : '']
                .filter(Boolean)
                .join('. '),
              result: VERDICT_WORD[c.verdict],
              state: VERDICT_STATE[c.verdict],
              dashed: c.verdict === 'unclaimed',
            }),
          ),
        },
      ];
    });
  }

  // Links the learner drew in the testing panel. The ids they carry may be node
  // ids, bare test names or criterion ids in any of their shapes, so both ends
  // are resolved forgivingly and a link that resolves to nothing is dropped.
  const drawn: PhaseLink[] = [];
  phases.forEach((p) => details[p.id]?.links?.forEach((l) => drawn.push(l)));
  drawn.forEach((l) => {
    const from =
      nodeIndex.get(l.from) ||
      testByKey.get(caseKey(l.from)) ||
      nodes.find((n) => n.name === l.from);
    const to =
      nodeIndex.get(l.to) ||
      nodes.find((n) => n.kind === 'criterion' && critKey(n.name || n.id) === critKey(l.to));
    if (from && to) link(from.id, to.id, 'link');
  });

  /* ------------------------ derived states ----------------------------- */
  const byId = new Map<string, MapNode>();
  nodes.forEach((n) => byId.set(n.id, n));
  const out = new Map<string, string[]>();
  edges.forEach((e) => {
    if (e.kind !== 'trace') return;
    out.set(e.from, [...(out.get(e.from) || []), e.to]);
  });

  // a function is proven by its tests: any failing case turns it red, all passing turns it green
  functions.forEach(({ node }) => {
    if (node.state === 'todo') return;
    const linked = (out.get(node.id) || []).map((id) => byId.get(id)).filter((n): n is MapNode => !!n && n.kind === 'test');
    if (linked.some((t) => t.state === 'fail')) node.state = 'fail';
    else if (linked.length && linked.every((t) => t.state === 'pass') && node.state !== 'pass') node.state = 'pass';
  });

  // a link the learner drew is a promise too: the criterion a failing test was
  // linked to is not met, however the automatic tracing reads
  edges.forEach((e) => {
    if (e.kind !== 'link') return;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (a?.state === 'fail' && b && b.state !== 'todo') b.state = 'fail';
  });

  // a promise whose code fails is not yet kept: stories, criteria and contracts inherit a downstream failure
  const downstreamFunctions = (id: string, depth = 0): MapNode[] => {
    if (depth > 3) return [];
    const next = out.get(id) || [];
    const found: MapNode[] = [];
    next.forEach((nid) => {
      const n = byId.get(nid);
      if (!n) return;
      if (n.kind === 'function') found.push(n);
      else if (n.kind === 'criterion' || n.kind === 'contract' || n.kind === 'story' || n.kind === 'change') found.push(...downstreamFunctions(nid, depth + 1));
    });
    return found;
  };
  nodes.forEach((n) => {
    if (n.kind !== 'story' && n.kind !== 'criterion' && n.kind !== 'contract') return;
    if (n.state === 'todo') return;
    if (downstreamFunctions(n.id).some((f) => f.state === 'fail')) n.state = 'fail';
  });

  /* ----------------------------- compact ------------------------------- */
  let finalNodes = nodes;
  let finalEdges = edges;
  if (compact) {
    const remap = new Map<string, string>();
    const drop = new Set<string>();
    const folds: MapNode[] = [];

    // given stories fold with their criteria into one block; the learner's own stay visible
    stories.filter((s) => s.given).forEach((s) => {
      const sid = `story:${s.id}`;
      const crit = nodes.filter((n) => n.kind === 'criterion' && n.id.startsWith(`crit:${s.id}.`));
      const bad = crit.filter((c) => c.state === 'fail').length;
      const foldId = `fold:crit:${s.id}`;
      folds.push({
        id: foldId,
        phase: 'requirements',
        kind: 'criterion',
        label: crit.length ? `${crit.length} ${crit.length === 1 ? 'criterion' : 'criteria'} for ${s.title}` : s.title,
        sub: `${s.id}, given${bad ? `, ${bad} failing` : crit.length ? ', all met' : ''}`,
        state: bad ? 'fail' : 'done',
        file: s.file,
        line: s.line,
        href: hrefFor('requirements', s.file),
        phaseId: req?.id,
        folded: [sid, ...crit.map((c) => c.id)],
        given: true,
      });
      remap.set(sid, foldId);
      crit.forEach((c) => remap.set(c.id, foldId));
    });
    // the learner's story shows as its criteria once any exist
    const dropEdges = new Set<string>();
    stories.filter((s) => !s.given).forEach((s) => {
      const sid = `story:${s.id}`;
      const crit = nodes.filter((n) => n.kind === 'criterion' && n.id.startsWith(`crit:${s.id}.`));
      if (crit.length) {
        drop.add(sid);
        crit.forEach((c) => dropEdges.add(`${sid}>${c.id}`));
        // the story's other links move onto its first criterion so the chain stays connected
        remap.set(sid, crit[0].id);
      }
    });

    // functions given with the scaffold and never touched by a contract fall away
    functions.forEach(({ node }) => {
      if (node.given) drop.add(node.id);
    });

    // tests fold per function
    const testsOf = new Map<string, MapNode[]>();
    const claimed = new Set<string>();
    edges.forEach((e) => {
      const f = byId.get(e.from);
      const t = byId.get(e.to);
      if (f?.kind === 'function' && t?.kind === 'test' && !claimed.has(t.id)) {
        testsOf.set(f.id, [...(testsOf.get(f.id) || []), t]);
        claimed.add(t.id);
      }
    });
    const short = (fn: MapNode) => fn.label.replace(/\(\)$/, '');
    functions.forEach(({ node }) => {
      const ts = testsOf.get(node.id) || [];
      if (!ts.length) return;
      const bad = ts.filter((t) => t.state === 'fail').length;
      const foldId = `fold:test:${node.id}`;
      folds.push({
        id: foldId,
        phase: 'testing',
        kind: 'test',
        label: `${ts.length} ${ts.length === 1 ? 'test' : 'tests'} for ${short(node)}`,
        sub: bad ? `${bad} failing` : ts.every((t) => t.state === 'pass' || t.state === 'done') ? 'All passing' : 'Not run yet',
        state: bad ? 'fail' : ts.every((t) => t.state === 'pass' || t.state === 'done') ? 'pass' : ts.some((t) => t.state === 'todo') ? 'todo' : 'now',
        href: ts[0].href,
        phaseId: ts[0].phaseId,
        folded: ts.map((t) => t.id),
      });
      ts.forEach((t) => remap.set(t.id, foldId));
    });
    const loose = testNodes.filter((t) => !claimed.has(t.id));
    if (loose.length) {
      const bad = loose.filter((t) => t.state === 'fail').length;
      folds.push({
        id: 'fold:test:other',
        phase: 'testing',
        kind: 'test',
        label: `${loose.length} other ${loose.length === 1 ? 'test' : 'tests'}`,
        sub: bad ? `${bad} failing` : 'Not tied to a function',
        state: bad ? 'fail' : loose.every((t) => t.state === 'pass' || t.state === 'done') ? 'pass' : 'now',
        href: loose[0].href,
        phaseId: loose[0].phaseId,
        folded: loose.map((t) => t.id),
      });
      loose.forEach((t) => remap.set(t.id, 'fold:test:other'));
    }
    if (mutation && bugNodes.length) {
      const notRun = bugNodes.every((b) => b.state === 'todo');
      const survived = mutation.survivors.length;
      folds.push({
        id: 'fold:bug',
        phase: 'testing',
        kind: 'bug',
        label: `${mutation.total} planted ${mutation.total === 1 ? 'bug' : 'bugs'}`,
        sub: notRun ? 'Not run yet' : `${mutation.killed} caught, ${survived} survived`,
        state: notRun ? 'todo' : survived ? 'fail' : 'pass',
        href: bugNodes[0].href,
        phaseId: bugNodes[0].phaseId,
        folded: bugNodes.map((b) => b.id),
      });
      bugNodes.forEach((b) => remap.set(b.id, 'fold:bug'));
    }

    const kept = nodes.filter((n) => !remap.has(n.id) && !drop.has(n.id));
    finalNodes = [...kept, ...folds];
    const keepIds = new Set(finalNodes.map((n) => n.id));
    const seen = new Set<string>();
    finalEdges = [];
    edges.forEach((e) => {
      if (dropEdges.has(`${e.from}>${e.to}`)) return;
      const from = remap.get(e.from) || e.from;
      const to = remap.get(e.to) || e.to;
      if (from === to || !keepIds.has(from) || !keepIds.has(to)) return;
      const k = `${from}>${to}`;
      if (seen.has(k)) return;
      seen.add(k);
      finalEdges.push({ from, to, kind: e.kind });
    });
  }

  /* --------------------------- placeholders ---------------------------- */
  if (showLocked) {
    phases.forEach((p) => {
      if (p.status !== 'locked') return;
      const id = `ph:${p.key}`;
      finalNodes.push({
        id,
        phase: p.key,
        kind: 'placeholder',
        label: PLACEHOLDER_LABEL[p.key],
        sub: `Opens in phase ${p.order}`,
        state: 'todo',
        phaseId: p.id,
      });
      // one thread in, so the flow reads on: from the placeholder before it when
      // that phase is locked too, else from the last piece of work to its left
      const leftKey = PHASE_ORDER[PHASE_INDEX[p.key] - 1];
      const leftPh = leftKey && finalNodes.find((n) => n.id === `ph:${leftKey}`);
      if (leftPh) {
        finalEdges.push({ from: leftPh.id, to: id, kind: 'trace' });
        return;
      }
      const left = PHASE_ORDER.slice(0, PHASE_INDEX[p.key]).reverse();
      for (const key of left) {
        const col = finalNodes.filter((n) => n.phase === key && n.kind !== 'placeholder' && n.kind !== 'test' && n.kind !== 'bug');
        if (col.length) {
          finalEdges.push({ from: col[col.length - 1].id, to: id, kind: 'trace' });
          break;
        }
      }
    });
  }

  /* ---------------------------- ordering ------------------------------- */
  // Ids are the map's identity: edges resolve through them and the drawing keys
  // its blocks on them. Two builders reaching the same id (a file editable in
  // two phases, a criterion minted by both a story and a saved link) would
  // draw one block twice. The last copy is the one every `byId` lookup above
  // resolved to, so it is the one that carries the propagated state.
  const lastById = new Map<string, MapNode>();
  finalNodes.forEach((n) => lastById.set(n.id, n));
  finalNodes = finalNodes.filter((n) => lastById.get(n.id) === n);

  const fnOrder = new Map<string, number>();
  finalNodes.filter((n) => n.kind === 'function').forEach((n, i) => fnOrder.set(n.id, i));
  const firstFn = new Map<string, number>();
  finalEdges.forEach((e) => {
    if (fnOrder.has(e.from) && !firstFn.has(e.to)) firstFn.set(e.to, fnOrder.get(e.from) as number);
  });
  const rank = (n: MapNode, i: number): number => {
    if (n.phase === 'testing') {
      if (n.kind === 'placeholder') return 1e6 + i;
      if (n.kind === 'bug') return 5e5 + i;
      return (firstFn.has(n.id) ? (firstFn.get(n.id) as number) * 1000 : 4e5) + i;
    }
    if (n.kind === 'placeholder') return 1e6 + i;
    if (n.kind === 'decision') return 1e5 + i;
    return i;
  };
  const ordered = finalNodes
    .map((n, i) => ({ n, r: rank(n, i), i }))
    .sort((a, b) => PHASE_INDEX[a.n.phase] - PHASE_INDEX[b.n.phase] || a.r - b.r || a.i - b.i)
    .map((x) => x.n);

  return { nodes: ordered, edges: finalEdges };
}
