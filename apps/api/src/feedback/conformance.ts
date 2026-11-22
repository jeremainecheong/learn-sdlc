import type {
  AnalyzerFunction,
  AnalyzerReport,
  ContractClaim,
  FeedbackReport,
  TestCaseResult,
} from '@learnsdlc/shared';
import {
  API_CONTRACT_JSON,
  claimAsserted,
  CLAIMS_LOW_FIRST,
  CLAIMS_NO_ERRORS,
  CLAIMS_NO_INPUTS,
  CLAIMS_NO_ORDER,
  CLAIMS_NO_RETURN,
  CLAIMS_TODAY_OVERDUE,
} from '@learnsdlc/shared';
import { asText, capWithEllipsis } from './text-caps';
import { subjectToken, words } from './impact';

type ClaimKind = ContractClaim['claim'];

/** The order a ledger reads in, per operation. */
const KIND_ORDER: ClaimKind[] = ['inputs', 'returns', 'errors', 'ordering', 'boundary'];

const MAX_CLAIMS = 60;
const MAX_TEXT = 400;
const MAX_EVIDENCE = 4;

/** Words in a test name that show it is about an error path. */
const ERROR_WORDS = new Set([
  'raise',
  'raises',
  'raised',
  'raising',
  'throw',
  'throws',
  'thrown',
  'error',
  'errors',
  'keyerror',
  'valueerror',
  'typeerror',
  'exception',
  'invalid',
  'unknown',
  'rejects',
]);

const ORDER_WORDS = new Set(['order', 'orders', 'ordered', 'ordering', 'sort', 'sorted', 'priority']);

const BOUNDARY_WORDS = new Set([
  'today',
  'boundary',
  'due',
  'inclusive',
  'exclusive',
  'overdue',
  'excludes',
]);

const RETURN_WORDS = new Set(['return', 'returns', 'returned', 'returning']);

const stripComments = (source: string): string => source.replace(/<!--[\s\S]*?-->/g, ' ');

const tidy = (value: string): string => capWithEllipsis(value.replace(/\s+/g, ' ').trim(), MAX_TEXT);

/** A claim line with nothing behind it: the scaffold's bare label, or a marker. */
const isBlankClaim = (value: string): boolean => {
  const bare = value
    .replace(/`/g, '')
    .replace(/\bTODO\b.*$/i, '')
    .replace(/[…\-–—.:;,?*_]/g, '')
    .trim();
  return bare.length < 3;
};

interface ParsedClaim {
  name: string;
  /** Whatever stood inside the parentheses of the declared signature. */
  params: string;
  story?: string;
  claim: ClaimKind;
  text: string;
  source: string;
  /** The claim was read off a Returns line rather than its own line. */
  derived?: boolean;
}

interface ParsedOperation {
  name: string;
  params: string;
  story?: string;
  source: string;
  claims: Map<ClaimKind, ParsedClaim>;
}

/* ------------------------------ markdown ------------------------------ */

const LABEL_KIND: { pattern: RegExp; kind: ClaimKind }[] = [
  { pattern: /^inputs?\b/i, kind: 'inputs' },
  { pattern: /^(arguments?|args|params?|parameters?)\b/i, kind: 'inputs' },
  { pattern: /^returns?\b/i, kind: 'returns' },
  { pattern: /^(outputs?|result)\b/i, kind: 'returns' },
  { pattern: /^(errors?|raises|throws|exceptions?)\b/i, kind: 'errors' },
  { pattern: /^order(ing)?\b/i, kind: 'ordering' },
  { pattern: /^(sort|sorting)\b/i, kind: 'ordering' },
  { pattern: /^boundar(y|ies)\b/i, kind: 'boundary' },
];

const kindForLabel = (label: string): ClaimKind | null => {
  const clean = label.replace(/\([^)]*\)/g, ' ').trim();
  for (const entry of LABEL_KIND) {
    if (entry.pattern.test(clean)) return entry.kind;
  }
  return null;
};

/**
 * Read the `### `name(args)` — US-n` contract blocks out of a design markdown
 * file. HTML comments are stripped first: the scaffold explains the format
 * inside comments, and an instruction is not a claim.
 */
function parseMarkdownOperations(source: string, sourceLabel: string): ParsedOperation[] {
  const body = stripComments(asText(source));
  const headings = [...body.matchAll(/^###[ \t]*(.+)$/gm)];
  const operations: ParsedOperation[] = [];

  for (const heading of headings) {
    const title = heading[1];
    const signature = /`?\b([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(title);
    if (!signature) continue;
    const story = /\bUS-?\s?(\d+)\b/i.exec(title);

    const start = heading.index! + heading[0].length;
    const rest = body.slice(start);
    const next = /^#{1,3}[ \t]/m.exec(rest);
    const block = next ? rest.slice(0, next.index) : rest;

    const operation: ParsedOperation = {
      name: signature[1],
      params: signature[2].trim(),
      story: story ? `US-${story[1]}` : undefined,
      source: sourceLabel,
      claims: new Map(),
    };

    // Bullet lines, with wrapped continuation lines folded in.
    const record = (pending: { label: string; parts: string[] } | null) => {
      if (!pending) return;
      const kind = kindForLabel(pending.label);
      if (!kind) return;
      const body = tidy(pending.parts.join(' '));
      const base = {
        name: operation.name,
        params: operation.params,
        story: operation.story,
        text: body,
        source: sourceLabel,
      };
      if (!operation.claims.has(kind)) {
        operation.claims.set(kind, { ...base, claim: kind });
      }
      // A `Returns (including ordering)` label carries a second claim.
      if (kind !== 'returns') return;
      const qualifier = /\(([^)]*)\)/.exec(pending.label)?.[1] ?? '';
      const extra: ClaimKind | null = /order/i.test(qualifier)
        ? 'ordering'
        : /boundar/i.test(qualifier)
          ? 'boundary'
          : null;
      if (extra && !operation.claims.has(extra)) {
        operation.claims.set(extra, { ...base, claim: extra, derived: true });
      }
    };

    let current: { label: string; parts: string[] } | null = null;
    for (const line of block.split(/\r?\n/)) {
      const bullet = /^[ \t]*[-*+][ \t]*([A-Za-z][A-Za-z \t/()]{0,40}?)[ \t]*:(.*)$/.exec(line);
      if (bullet) {
        record(current);
        current = { label: bullet[1].trim(), parts: [bullet[2].trim()] };
        continue;
      }
      if (/^[ \t]*([-*+#|>]|```)/.test(line) || !line.trim()) {
        record(current);
        current = null;
        continue;
      }
      if (current) current.parts.push(line.trim());
    }
    record(current);

    if (operations.every((existing) => existing.name !== operation.name)) {
      operations.push(operation);
    }
  }

  return operations;
}

/* -------------------------------- json -------------------------------- */

const JSON_FIELD_KIND: { keys: string[]; kind: ClaimKind }[] = [
  { keys: ['inputs', 'input', 'args', 'arguments', 'params', 'parameters'], kind: 'inputs' },
  { keys: ['returns', 'return', 'output', 'outputs', 'result'], kind: 'returns' },
  { keys: ['errors', 'error', 'raises', 'throws', 'exceptions'], kind: 'errors' },
  { keys: ['ordering', 'order', 'orderRule', 'sort'], kind: 'ordering' },
  { keys: ['boundary', 'boundaryRule', 'boundaries'], kind: 'boundary' },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const operationArray = (parsed: unknown): unknown[] => {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return [];
  for (const key of ['operations', 'contracts', 'contract', 'api', 'functions']) {
    const value = parsed[key];
    if (Array.isArray(value)) return value;
  }
  return [];
};

/**
 * An HTTP contract row (`shared/contract/api.json`) written as the claims
 * this ledger speaks: `parameters` are the inputs, `success` is what comes
 * back, `failures` are what it refuses.
 *
 * Without this every operation in api.json was skipped: the row names itself
 * with `id`, not `name`, and states itself with `summary` / `success` /
 * `failures`, none of which JSON_FIELD_KIND looks for, so a learner who wrote
 * the whole contract was told by their own pull request that all three
 * operations were unclaimed.
 */
function contractClaimText(entry: Record<string, unknown>, kind: ClaimKind): string {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  if (kind === 'inputs') {
    const params = list(entry.parameters)
      .map((p) => {
        if (!isRecord(p)) return '';
        const name = asText(p.name);
        if (!name) return '';
        const about = asText(p.description) || asText(p.type);
        return about ? `${name} (${about})` : name;
      })
      .filter(Boolean);
    const body = isRecord(entry.request) ? asText(entry.request.body) || asText(entry.request.schema) : '';
    if (params.length === 0 && !body) return '';
    return [params.join(', '), body].filter(Boolean).join('; ');
  }
  if (kind === 'returns') {
    const success = entry.success;
    if (!isRecord(success)) return asText(success);
    const status = success.status == null ? '' : String(success.status);
    const body = asText(success.body) || asText(success.description) || asText(success.schema);
    return [body, status && `status ${status}`].filter(Boolean).join(', ');
  }
  if (kind === 'errors') {
    const failures = list(entry.failures)
      .map((f) => {
        if (!isRecord(f)) return asText(f);
        const code = asText(f.code);
        const when = asText(f.when) || asText(f.message) || asText(f.description);
        const status = f.status == null ? '' : String(f.status);
        return [code, status && `(${status})`, when && `when ${when}`].filter(Boolean).join(' ');
      })
      .filter(Boolean);
    return failures.join('; ');
  }
  return '';
}

/**
 * Read design.json / contracts.json / shared/contract/api.json, tolerating an
 * array, a wrapper, and either of the two shapes the packs use.
 */
function parseJsonOperations(source: string, sourceLabel: string): ParsedOperation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(asText(source));
  } catch {
    return [];
  }

  const operations: ParsedOperation[] = [];
  for (const entry of operationArray(parsed)) {
    if (!isRecord(entry)) continue;
    // `id` last: design.json's rows carry a signature under `name`, and the
    // HTTP contract's carry a bare identifier under `id`.
    const declared =
      asText(entry.name) || asText(entry.signature) || asText(entry.operation) || asText(entry.id);
    if (!declared.trim()) continue;
    const signature = /([A-Za-z_$][\w$]*)\s*(?:\(([^)]*)\))?/.exec(declared);
    if (!signature) continue;
    const satisfies = Array.isArray(entry.satisfies)
      ? entry.satisfies.map(asText).filter(Boolean).join(', ')
      : asText(entry.satisfies);
    const story = satisfies || asText(entry.story) || '';
    const operation: ParsedOperation = {
      name: signature[1],
      params: (signature[2] ?? '').trim(),
      story: /\bUS-?\s?\d+\b/i.test(story) ? story.trim() : undefined,
      source: sourceLabel,
      claims: new Map(),
    };
    const record = (kind: ClaimKind, value: string) => {
      if (!value.trim() || operation.claims.has(kind)) return;
      operation.claims.set(kind, {
        name: operation.name,
        params: operation.params,
        story: operation.story,
        claim: kind,
        text: tidy(value),
        source: sourceLabel,
      });
    };
    for (const field of JSON_FIELD_KIND) {
      for (const key of field.keys) {
        // The design record's inputs and errors are lists, and Maintenance's
        // contracts.json seeded from it keeps them as lists: read a list as
        // the joined text, so its claims read as they did when they were text.
        // Not the HTTP contract's: its `errors` list of codes stays read
        // through its `failures`, as it always was.
        const raw = entry[key];
        const value = Array.isArray(raw) && sourceLabel !== API_CONTRACT_JSON
          ? raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ')
          : raw;
        if (typeof value !== 'string' || !value.trim()) continue;
        record(field.kind, value);
        break;
      }
    }
    // The HTTP contract states the same three claims in its own shape, so it
    // fills whatever the flat keys did not.
    for (const kind of ['inputs', 'returns', 'errors'] as ClaimKind[]) {
      record(kind, contractClaimText(entry, kind));
    }
    if (operations.every((existing) => existing.name !== operation.name)) {
      operations.push(operation);
    }
  }
  return operations;
}

/* ------------------------------ evidence ------------------------------ */

interface CaseFact {
  name: string;
  words: string[];
  status: TestCaseResult['status'];
  hidden: boolean;
}

const bearingWords = (kind: ClaimKind): Set<string> | null => {
  if (kind === 'errors') return ERROR_WORDS;
  if (kind === 'ordering') return ORDER_WORDS;
  if (kind === 'boundary') return BOUNDARY_WORDS;
  if (kind === 'returns') return RETURN_WORDS;
  return null;
};

/**
 * The cases that bear on one claim: those named after the operation, narrowed to
 * the ones whose name is about that aspect.
 *
 * `inputs` keeps every case for the operation on purpose. The hidden suite calls
 * the function with the arguments the phase specifies, so an implementation that
 * takes different ones fails or errors across the board: every case for the
 * operation is evidence about its signature.
 */
function bearingCases(operation: ParsedOperation, kind: ClaimKind, cases: CaseFact[]): CaseFact[] {
  const subject = subjectToken(operation.name);
  if (!subject) return [];
  const named = cases.filter((c) => c.words.includes(subject));
  const narrow = bearingWords(kind);
  if (!narrow) return named;
  const focused = named.filter((c) => c.words.some((word) => narrow.has(word)));
  return focused.length > 0 ? focused : kind === 'returns' ? named : [];
}

const caseLabel = (fact: CaseFact): string => `${fact.hidden ? 'hidden test' : 'test'} ${fact.name}`;

const analyzerFunction = (
  operation: ParsedOperation,
  analysis: AnalyzerReport | undefined,
): AnalyzerFunction | undefined => {
  const functions = analysis?.functions ?? [];
  const exact = functions.find((fn) => fn.name === operation.name);
  if (exact) return exact;
  const subject = subjectToken(operation.name);
  if (!subject) return undefined;
  const near = functions.filter((fn) => words(fn.name).includes(subject));
  return near.length === 1 ? near[0] : undefined;
};

/** Exception constructors the function body raises, per the analyzer's calls. */
const raisedErrors = (fn: AnalyzerFunction | undefined): string[] =>
  (fn?.calls ?? []).filter((call) => /(Error|Exception)$/.test(call));

/**
 * Failed content checks that speak to one claim: the rule named after this
 * operation (`api-complete`), plus the document-wide `api-errors` rule, which
 * only belongs on an errors row.
 */
function failedChecksFor(
  operation: ParsedOperation,
  kind: ClaimKind,
  report: FeedbackReport,
): string[] {
  const subject = subjectToken(operation.name);
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  return checks
    .filter((check) => check.status === 'failed')
    .filter((check) => {
      const idWords = words(check.id);
      if (subject && idWords.includes(subject)) return true;
      return kind === 'errors' && idWords.includes('api') && idWords.includes('errors');
    })
    .map((check) => `Check ${check.id} failed: ${tidy(check.detail)}`);
}

/* ---------------------------- contradictions --------------------------- */

// The claim patterns, the hedge words and the sentence splitter come from the
// shared package, so this review and the Design editor's live warnings agree
// about the same sentence.

/**
 * Does the claim state the opposite of a fact? Every branch needs one: a
 * bearing test, an analyzer observation, or the signature the design itself
 * declares, so a line the grader cannot check is never called a contradiction.
 */
function contradiction(
  claim: ParsedClaim,
  operation: ParsedOperation,
  bearing: CaseFact[],
  fn: AnalyzerFunction | undefined,
): string | null {
  const body = claim.text;

  if (claim.claim === 'errors') {
    const raises = raisedErrors(fn);
    if (!claimAsserted(body, CLAIMS_NO_ERRORS)) return null;
    // "Errors: none; tasks with no due date are simply excluded" is a real
    // contract, so the fact has to come from the run, not from the wording.
    const errorTest = bearing.find((c) => c.words.some((word) => ERROR_WORDS.has(word)));
    if (errorTest) {
      return `${caseLabel(errorTest)} expects an error from ${operation.name}, but the design says there is none.`;
    }
    if (raises.length > 0 && fn) {
      return `${fn.path}:${fn.line} raises ${raises[0]}, but the design says ${operation.name} raises nothing.`;
    }
    return null;
  }

  if (claim.claim === 'inputs') {
    if (!claimAsserted(body, CLAIMS_NO_INPUTS) || !operation.params) return null;
    return `The design says ${operation.name} takes no arguments, but the same block declares ${operation.name}(${operation.params}).`;
  }

  if (claim.claim === 'returns') {
    if (!claimAsserted(body, CLAIMS_NO_RETURN)) return null;
    const returnTest = bearing.find((c) => c.words.some((word) => RETURN_WORDS.has(word)));
    return returnTest
      ? `${caseLabel(returnTest)} expects a value back, but the design says ${operation.name} returns nothing.`
      : null;
  }

  if (claim.claim === 'boundary') {
    const notOverdue = bearing.find(
      (c) => c.words.includes('today') && c.words.includes('not'),
    );
    if (!notOverdue) return null;
    if (claimAsserted(body, CLAIMS_TODAY_OVERDUE)) {
      return `${caseLabel(notOverdue)} expects a task due today to be open, but the design puts it in the overdue set.`;
    }
    return null;
  }

  if (claim.claim === 'ordering') {
    const orderTest = bearing.find((c) => c.words.some((word) => ORDER_WORDS.has(word)));
    if (!orderTest) return null;
    if (claimAsserted(body, CLAIMS_LOW_FIRST)) {
      return `${caseLabel(orderTest)} expects the highest priority first, but the design orders the other way.`;
    }
    if (claimAsserted(body, CLAIMS_NO_ORDER)) {
      return `${caseLabel(orderTest)} pins an order, but the design says the order does not matter.`;
    }
    return null;
  }

  return null;
}

/* ------------------------------- assembly ------------------------------ */

/** The claim kinds an operation is expected to state, from its own name. */
function expectedKinds(name: string): ClaimKind[] {
  const kinds: ClaimKind[] = ['inputs', 'returns', 'errors'];
  if (/filter|list|search|sort|order/i.test(name)) kinds.push('ordering');
  if (/overdue|due|expire|boundary/i.test(name)) kinds.push('boundary');
  return kinds;
}

/** Fill an expected ordering or boundary claim from the Returns line's prose. */
function deriveFromReturns(operation: ParsedOperation, kind: ClaimKind): ParsedClaim | null {
  const returns = operation.claims.get('returns');
  if (!returns || isBlankClaim(returns.text)) return null;
  const signal =
    kind === 'ordering'
      ? /\b(order|ordered|ordering|sort|sorted|priority|then id)\b/i
      : /\b(today|boundary|inclusive|exclusive|strictly|before|due date)\b/i;
  if (!signal.test(returns.text)) return null;
  return { ...returns, claim: kind, derived: true };
}

/**
 * Build the conformance ledger: one row per contract line the learner's design
 * states (or should state), with the verdict the run supports.
 *
 * The ledger is advisory. Every verdict has to point at a fact:
 * - `kept`, every hidden test bearing on the line passed, or the analyzer saw
 *   what the line describes.
 * - `broken`: a bearing test failed or errored, so the code does not do what
 *   the design says.
 * - `contradicted`: the line states the opposite of what a test expects or of
 *   what the code does.
 * - `unclaimed`: the line is missing or blank, or nothing in the run bears on
 *   it. The evidence says which, so a grey row is never mistaken for a pass.
 *
 * Pure: no I/O, no clock, no randomness.
 */
export function buildContractLedger(
  designSources: Record<string, string>,
  report: FeedbackReport,
  analysis: AnalyzerReport | undefined,
): ContractClaim[] {
  const sources = designSources && typeof designSources === 'object' ? designSources : {};

  const markdown: ParsedOperation[] = [];
  const structured: ParsedOperation[] = [];
  for (const path of Object.keys(sources).sort()) {
    const source = asText(sources[path]);
    if (!source.trim()) continue;
    if (/\.json$/i.test(path)) structured.push(...parseJsonOperations(source, path));
    else markdown.push(...parseMarkdownOperations(source, path));
  }

  // The rendered markdown is what the graders read, so it wins. Structured
  // records fill in the operations and lines the markdown never rendered.
  const operations: ParsedOperation[] = [];
  for (const operation of markdown) {
    if (operations.every((existing) => existing.name !== operation.name)) operations.push(operation);
  }
  for (const operation of structured) {
    const existing = operations.find((candidate) => candidate.name === operation.name);
    if (!existing) {
      operations.push(operation);
      continue;
    }
    if (!existing.story) existing.story = operation.story;
    if (!existing.params) existing.params = operation.params;
    for (const [kind, claim] of operation.claims) {
      const held = existing.claims.get(kind);
      if (!held || isBlankClaim(held.text)) existing.claims.set(kind, claim);
    }
  }
  if (operations.length === 0) return [];

  const caseFacts: CaseFact[] = (report?.tests?.cases ?? [])
    .filter((testCase) => typeof testCase?.name === 'string' && testCase.name.length > 0)
    .map((testCase) => ({
      name: testCase.name,
      words: words(testCase.name),
      status: testCase.status,
      hidden: testCase.hidden === true,
    }));

  const ledger: ContractClaim[] = [];

  for (const operation of operations) {
    const fn = analyzerFunction(operation, analysis);
    const kinds = [...new Set([...expectedKinds(operation.name), ...operation.claims.keys()])].sort(
      (a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b),
    );

    for (const kind of kinds) {
      if (ledger.length >= MAX_CLAIMS) return ledger;

      let claim = operation.claims.get(kind);
      if ((!claim || isBlankClaim(claim.text)) && (kind === 'ordering' || kind === 'boundary')) {
        claim = deriveFromReturns(operation, kind) ?? claim;
      }
      const body = claim ? claim.text : '';
      const bearing = bearingCases(operation, kind, caseFacts);
      const checkEvidence = failedChecksFor(operation, kind, report);
      const evidence: string[] = [];

      if (!claim || isBlankClaim(body)) {
        evidence.push(
          claim
            ? `The ${kind} line is present but empty, so there is no contract to check.`
            : `The design states no ${kind} for ${operation.name}.`,
        );
        if (bearing.length > 0) {
          evidence.push(`${caseLabel(bearing[0])} checks this anyway.`);
        }
        ledger.push({
          name: operation.name,
          story: operation.story,
          claim: kind,
          text: '',
          verdict: 'unclaimed',
          evidence: evidence.slice(0, MAX_EVIDENCE),
        });
        continue;
      }

      if (claim.derived) {
        evidence.push(`Read from the Returns line, which is where the design states it.`);
      } else if (/\.json$/i.test(claim.source)) {
        evidence.push(`From ${claim.source}.`);
      }

      const conflict = contradiction(claim, operation, bearing, fn);
      if (conflict) {
        evidence.unshift(conflict);
        ledger.push({
          name: operation.name,
          story: operation.story,
          claim: kind,
          text: body,
          verdict: 'contradicted',
          evidence: [...evidence, ...checkEvidence].slice(0, MAX_EVIDENCE),
        });
        continue;
      }

      const broke = bearing.filter((c) => c.status !== 'passed');
      if (broke.length > 0) {
        evidence.unshift(
          `${caseLabel(broke[0])} ${broke[0].status === 'errored' ? 'errored' : 'failed'}${
            broke.length > 1 ? `, and ${broke.length - 1} more` : ''
          }.`,
        );
        ledger.push({
          name: operation.name,
          story: operation.story,
          claim: kind,
          text: body,
          verdict: 'broken',
          evidence: [...evidence, ...checkEvidence].slice(0, MAX_EVIDENCE),
        });
        continue;
      }

      if (bearing.length > 0) {
        evidence.unshift(
          bearing.length === 1
            ? `${caseLabel(bearing[0])} passed.`
            : `${caseLabel(bearing[0])} and ${bearing.length - 1} more passed.`,
        );
        ledger.push({
          name: operation.name,
          story: operation.story,
          claim: kind,
          text: body,
          verdict: 'kept',
          evidence: [...evidence, ...checkEvidence].slice(0, MAX_EVIDENCE),
        });
        continue;
      }

      // No test bears on the line. The analyzer can still confirm an errors
      // claim that names the exception the body actually raises.
      const raises = raisedErrors(fn);
      const named = raises.find((name) => new RegExp(`\\b${name}\\b`).test(body));
      if (kind === 'errors' && named && fn) {
        evidence.unshift(`${fn.path}:${fn.line} raises ${named}.`);
        ledger.push({
          name: operation.name,
          story: operation.story,
          claim: kind,
          text: body,
          verdict: 'kept',
          evidence: [...evidence, ...checkEvidence].slice(0, MAX_EVIDENCE),
        });
        continue;
      }

      evidence.unshift(
        fn
          ? `Nothing in this run bears on the ${kind} of ${operation.name}, so it stands unverified.`
          : `No function named ${operation.name} was found in your files, and no test bears on this line.`,
      );
      ledger.push({
        name: operation.name,
        story: operation.story,
        claim: kind,
        text: body,
        verdict: 'unclaimed',
        evidence: [...evidence, ...checkEvidence].slice(0, MAX_EVIDENCE),
      });
    }
  }

  return ledger;
}
