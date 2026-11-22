import * as fs from 'fs';
import * as path from 'path';

/**
 * The privacy scan for everything the harness writes or prints: model outputs,
 * the report, the spot-check sheet, stdout. Findings name the kind only, never
 * the matched text, so the error that reports a leak is not itself a leak.
 *
 * The learner-name and join-code patterns are not written in this file: they
 * name real people and classes, so they stay with the evaluation folder and
 * are read at run time from its corpus builder (`tools/build_corpus.py` under
 * EVAL_ROOT; see `loadCorpusPrivacyPatterns`). No name is copied into source.
 */

const BASE: Array<[RegExp, string]> = [
  // an address, not a decorator: "\n@bp.get" / "@pytest.fixture" are skipped
  [/(?<![\\\w])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|org|net|edu|io|test|sg|ai|dev|co|gov|me|app|example)\b/g, 'email'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'uuid'],
  [/\barn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[^\s"']+/g, 'arn'],
  // twelve digits standing alone: not the fraction or the integer part of a decimal (a cost such as 0.000012345678)
  [/(?<![\d.])\d{12}(?!\d|\.\d|e[-+]?\d)/g, 'aws-account-like'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/g, 'jwt'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g, 'key'],
  [/\b[a-z0-9-]+\.(?:execute-api|lambda-url|elb|compute|rds)\.[a-z0-9-]+\.amazonaws\.com\b/gi, 'host'],
];

/**
 * A long hex token with at least one letter (a sha256 or md5 digest, as every
 * raw record carries): masked before the account-like pattern runs, so twelve
 * digits inside a digest are not read as an account id.
 */
const HEX_DIGEST = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{32,}\b/gi;
const subjectFor = (kind: string, text: string): string => (kind === 'aws-account-like' ? text.replace(HEX_DIGEST, ' ') : text);

let extraFromCorpus: RegExp[] | null = null;

/** Where the evaluation folder keeps the learner-name and join-code patterns. */
export const corpusPrivacyPatternsFile = (evalRoot: string): string => path.join(evalRoot, 'tools', 'build_corpus.py');

/**
 * Read the learner-name and join-code patterns, once. The file is the corpus
 * builder, a Python script; each pattern is one entry of the form
 * `re.compile(r'<pattern>'), '<learner-name|join-code>'`, and every such
 * entry is read. Without the file nothing may be written, so the harness
 * stops rather than scan with less.
 */
export function loadCorpusPrivacyPatterns(buildCorpusPy: string): RegExp[] {
  if (extraFromCorpus) return extraFromCorpus;
  const out: RegExp[] = [];
  try {
    const text = fs.readFileSync(buildCorpusPy, 'utf8');
    for (const m of text.matchAll(/re\.compile\(r'([^']+)'\),\s*'(learner-name|join-code)'/g)) {
      out.push(new RegExp(m[1], 'g'));
    }
  } catch {
    throw new Error(`privacy scan: ${buildCorpusPy} not found. The evaluation folder must hold tools/build_corpus.py with the learner-name and join-code patterns (see apps/api/eval/README.md); nothing is written without them`);
  }
  extraFromCorpus = out;
  return out;
}

export interface PrivacyFinding { kind: string; count: number }

export function privacyFindings(text: string, extra: readonly RegExp[] = extraFromCorpus ?? []): PrivacyFinding[] {
  const out: PrivacyFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: string, n: number) => {
    if (!n) return;
    if (seen.has(kind)) { out.find((f) => f.kind === kind)!.count += n; return; }
    seen.add(kind);
    out.push({ kind, count: n });
  };
  let rest = text;
  for (const [rx, kind] of BASE) {
    const matches = subjectFor(kind, rest).match(new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : `${rx.flags}g`));
    add(kind, matches?.length ?? 0);
    // An ARN's account digits are reported once, as the ARN.
    if (kind === 'arn') rest = rest.replace(new RegExp(rx.source, 'g'), ' ');
  }
  for (const rx of extra) {
    const isJoin = /^[A-Z0-9]{6,}$/.test(rx.source);
    const matches = text.match(new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : `${rx.flags}g`));
    add(isJoin ? 'join-code' : 'learner-name', matches?.length ?? 0);
  }
  return out;
}

export function assertNoPrivateData(text: string, where: string, extra?: readonly RegExp[]): void {
  const found = privacyFindings(text, extra);
  if (found.length) throw new Error(`privacy scan refused ${where}: ${found.map((f) => `${f.kind}×${f.count}`).join(', ')}`);
}

/** Replace anything private before a line reaches stdout. */
export function redactForStdout(line: string, extra: readonly RegExp[] = extraFromCorpus ?? []): string {
  let out = line;
  for (const [rx, kind] of BASE) {
    const re = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : `${rx.flags}g`);
    // Digests stay as they are; only what sits outside them is redacted.
    out = kind === 'aws-account-like'
      ? out.split(/(\b(?=[0-9a-f]*[a-f])[0-9a-f]{32,}\b)/i).map((part, i) => (i % 2 ? part : part.replace(re, `[${kind}]`))).join('')
      : out.replace(re, `[${kind}]`);
  }
  for (const rx of extra) out = out.replace(new RegExp(rx.source, 'g'), '[name]');
  return out;
}
