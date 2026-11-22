import * as fs from 'fs';
import * as path from 'path';
import { Redactor, leakPaths, leaksIn, shapeOf } from '../contract-bodies/recorder';

/**
 * The recorded contract between the API and the web for the authoring seams,
 * held as request/answer exchanges.
 *
 * The contract-bodies recorder (`../contract-bodies/recorder.ts`) is imported
 * read-only: its `Redactor`, `shapeOf` and leak checks are the rules here too.
 * What differs is the unit of a recording. A contract-bodies recording holds a
 * bag of named bodies; these hold
 * **exchanges**: one request the web makes and the answer the API gave to it,
 * method, path, query, request body, status and response body, because the
 * web wiring tests replay them from a real HTTP server
 * (`replay.ts`), and a replay needs to know which answer belongs to which
 * request.
 *
 * **Recording vs checking.** `CONTRACT_EXCHANGES_RECORD=1` (set inline) rewrites a
 * file. Without it a spec reads the file and asserts that what the routes
 * answered now has the same *shape*, exchange by exchange (method, path,
 * status, and the shape of both bodies), so an ordinary run never rewrites a
 * packaged file and a contract change is a red test.
 *
 * **Redaction.** As in contract-bodies: ids `<uuid:n>`, emails `<email:n>`, tokens `<jwt>`,
 * digests `<sha256:n>` (the same digest is the same placeholder within one
 * file), named values `<label>`, times as ordinal instants. `holdExchangeContract`
 * refuses to write a file that would leak, and the redaction test in
 * `upload-contract-wiring.e2e-spec.ts` reads every
 * file in this folder and asserts none holds `@`, `eyJ` or a 64-hex string.
 */

export const CONTRACT_EXCHANGES_DIR = __dirname;
export const EXCHANGES_RECORDING = process.env.CONTRACT_EXCHANGES_RECORD === '1';

export interface Exchange {
  /** A name the web test asks for this exchange by. Unique within a file. */
  name: string;
  method: string;
  /** The path under `/api/v1`, ids redacted, no query. */
  path: string;
  /** The query, redacted, as an object (empty when none). */
  query: Record<string, string>;
  /** What the web (or the spec standing in for it) sent; null for none. */
  requestBody: unknown;
  status: number;
  /** The JSON answer, or for a non-JSON answer `{ contentType, text }`. */
  body: unknown;
  /** Response headers the web reads (content type, disposition), redacted. */
  headers?: Record<string, string>;
}

export interface ExchangeRecording {
  recordedBy: string;
  redaction: string;
  /** Values that are not exchanges: an id the web is handed as a prop, a cap. */
  facts: Record<string, unknown>;
  exchanges: Exchange[];
}

export const exchangeRecordingPath = (name: string) => path.join(CONTRACT_EXCHANGES_DIR, `${name}.json`);

/** Every recording on disk, by name. */
export function exchangeRecordingNames(): string[] {
  return fs
    .readdirSync(CONTRACT_EXCHANGES_DIR)
    .filter((one) => one.endsWith('.json'))
    .map((one) => one.replace(/\.json$/, ''))
    .sort();
}

export function readExchangeRecording(name: string): ExchangeRecording {
  return JSON.parse(fs.readFileSync(exchangeRecordingPath(name), 'utf-8')) as ExchangeRecording;
}

/**
 * Collects exchanges as a spec drives the real routes. `take` is handed the
 * supertest response; the path is split from its query here, so a spec writes
 * the URL it sent once.
 */
export class ExchangeLog {
  readonly exchanges: Exchange[] = [];

  take(
    name: string,
    method: string,
    url: string,
    requestBody: unknown,
    res: { status: number; body: unknown; text?: string; headers: Record<string, string | string[] | undefined> },
    headerNames: string[] = [],
  ): void {
    if (this.exchanges.some((one) => one.name === name)) throw new Error(`exchange ${name} recorded twice`);
    const [pathname, search = ''] = url.split('?');
    const contentType = String(res.headers['content-type'] ?? '');
    const json = contentType.includes('application/json');
    const headers: Record<string, string> = {};
    for (const header of headerNames) {
      const value = res.headers[header];
      if (value !== undefined) headers[header] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    this.exchanges.push({
      name,
      method,
      path: pathname.replace(/^\/api\/v1/, ''),
      query: Object.fromEntries(new URLSearchParams(search)),
      requestBody: requestBody === undefined ? null : requestBody,
      status: res.status,
      body: json ? res.body : { contentType: contentType.split(';')[0], text: res.text ?? '' },
      ...(headerNames.length ? { headers } : {}),
    });
  }
}

const shapeKey = (one: Exchange) =>
  JSON.stringify([one.name, one.method, one.path.replace(/<[^>]+>/g, '<id>'), one.status, shapeOf(one.requestBody), shapeOf(one.body)]);

/**
 * Record (with `CONTRACT_EXCHANGES_RECORD=1`) or check one recording. Redacts first;
 * refuses to write a file that would hold `@`, `eyJ`, a 64-hex string or a
 * uuid; when checking, every exchange must match the recorded one in name,
 * method, path (ids aside), status and both bodies' shapes, and the facts'
 * shapes must match too.
 */
/** A scoped npm package name (`@scope/name`, as a runtime's allow-list holds it). */
const NPM_SCOPED = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

/**
 * Name every scoped npm package in a value as `<npm:scope/name>`, so an
 * allow-list (the runtime profile, a draft's `supportedStacks`) puts no `@` in
 * a file. The same package reads the same everywhere it appears.
 */
export function nameScopedPackages(redactor: Redactor, value: unknown): void {
  if (typeof value === 'string') {
    if (NPM_SCOPED.test(value)) redactor.name(value, `npm:${value.slice(1)}`);
  } else if (Array.isArray(value)) value.forEach((one) => nameScopedPackages(redactor, one));
  else if (value && typeof value === 'object') Object.values(value).forEach((one) => nameScopedPackages(redactor, one));
}

export function holdExchangeContract(
  name: string,
  recordedBy: string,
  log: ExchangeLog,
  facts: Record<string, unknown>,
  redactor: Redactor,
): { live: ExchangeRecording; recorded: ExchangeRecording } {
  nameScopedPackages(redactor, log.exchanges);
  const live: ExchangeRecording = {
    recordedBy,
    redaction:
      'ids <uuid:n>, emails <email:n>, tokens <jwt>, digests <sha256:n> (one digest, one placeholder), named values <label>, times as ordinal instants from 2026-01-01T00:00:00Z',
    facts: redactor.redact(facts),
    exchanges: redactor.redact(log.exchanges),
  };
  const text = `${JSON.stringify(live, null, 1)}\n`;
  const leaks = leaksIn(text);
  if (leaks.length) throw new Error(`the ${name} recording would hold ${leaks.join(', ')} at ${leakPaths(live).slice(0, 8).join(', ')}`);
  const at = exchangeRecordingPath(name);
  if (EXCHANGES_RECORDING) {
    fs.writeFileSync(at, text, { encoding: 'utf-8', mode: 0o644 });
    return { live, recorded: live };
  }
  if (!fs.existsSync(at)) throw new Error(`no recording ${name}.json: record it once with CONTRACT_EXCHANGES_RECORD=1`);
  const recorded = readExchangeRecording(name);
  const was = recorded.exchanges.map(shapeKey);
  const now = live.exchanges.map(shapeKey);
  const moved = [...new Set([...was, ...now])].filter((key) => !was.includes(key) || !now.includes(key)).map((key) => JSON.parse(key)[0]);
  const factDrift = Object.keys({ ...recorded.facts, ...live.facts }).filter(
    (key) => JSON.stringify(shapeOf(recorded.facts[key])) !== JSON.stringify(shapeOf(live.facts[key])),
  );
  if (moved.length || factDrift.length) {
    throw new Error(
      `the ${name} contract moved in: ${[...new Set(moved), ...factDrift].join(', ')} (re-record with CONTRACT_EXCHANGES_RECORD=1 and re-run the web wiring tests)`,
    );
  }
  return { live, recorded };
}

export { Redactor };
