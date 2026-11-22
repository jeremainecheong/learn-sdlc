import * as fs from 'fs';
import * as path from 'path';

/**
 * The recorded contract between the API and the web for the copy, reset,
 * quiz-reveal and enrolment seams.
 *
 * The four recorder specs (`test/{copy-provenance,reset,quiz-reveal,enrollment}-contract-wiring.e2e-spec.ts`)
 * drive the same routes the seam specs drive, through the real `AppModule`,
 * and hold what the routes answered here. The web wiring tests
 * (`apps/web/test/*-wiring.test.tsx`) render the real page components from
 * these files, so a field the API renames or drops fails on both sides.
 *
 * **Recording vs checking.** `CONTRACT_BODIES_RECORD=1` (set inline) rewrites a
 * file. Without it a spec reads the file it recorded and asserts that what the
 * routes answer now has the same *shape* (every key and every value's type,
 * recursively), and each spec pins its seam's values by name. So an ordinary
 * run never rewrites a packaged file, and a contract change is a red test,
 * not a silent diff.
 *
 * **Redaction.** `apps/api/**` is packaged, so a recording carries no id,
 * email, token, join code, display name or digest: each is replaced by an
 * ordinal placeholder (`<uuid:3>`, `<email:1>`, `<jwt>`, `<sha256:2>`, a named
 * `<…>` for the values a spec registers), and timestamps by ordinal instants
 * from 2026-01-01T00:00:00Z so two different times stay different and ordered
 * by first appearance. `contract-bodies-recordings.e2e-spec.ts` asserts no
 * file holds `@`, `eyJ`, a 64-hex string or a uuid.
 */

export const CONTRACT_BODIES_DIR = __dirname;
export const RECORDING = process.env.CONTRACT_BODIES_RECORD === '1';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX64 = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const EPOCH = Date.UTC(2026, 0, 1);

export interface Recording {
  recordedBy: string;
  redaction: string;
  bodies: Record<string, unknown>;
}

/** One recording's placeholders: the same value always reads as the same placeholder in one file. */
export class Redactor {
  private readonly seen = new Map<string, Map<string, string>>();
  private readonly named: Array<[string, string]> = [];

  /** A literal (a join code, a display name, a run stamp) to replace by `<label>` wherever it appears. */
  name(value: string | null | undefined, label: string): this {
    if (value) this.named.push([value, `<${label}>`]);
    // Longest first, so a name inside a longer one is not replaced half-way.
    this.named.sort((a, b) => b[0].length - a[0].length);
    return this;
  }

  private ordinal(kind: string, value: string, make: (n: number) => string): string {
    const table = this.seen.get(kind) ?? new Map<string, string>();
    this.seen.set(kind, table);
    const key = kind === 'time' ? value : value.toLowerCase();
    if (!table.has(key)) table.set(key, make(table.size + 1));
    return table.get(key)!;
  }

  text(input: string): string {
    let out = input;
    for (const [value, label] of this.named) out = out.split(value).join(label);
    out = out.replace(JWT, '<jwt>');
    out = out.replace(EMAIL, (one) => this.ordinal('email', one, (n) => `<email:${n}>`));
    out = out.replace(UUID, (one) => this.ordinal('uuid', one, (n) => `<uuid:${n}>`));
    out = out.replace(HEX64, (one) => this.ordinal('sha256', one, (n) => `<sha256:${n}>`));
    out = out.replace(ISO, (one) => this.ordinal('time', one, (n) => new Date(EPOCH + n * 1000).toISOString()));
    return out;
  }

  redact<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((one) => this.walk(one));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, one]) => [this.text(key), this.walk(one)]));
    }
    return value;
  }
}

/**
 * The shape of a JSON value: object keys (sorted) to shapes, an array to the
 * sorted set of its elements' shapes, a leaf to its type. Two answers of one
 * route in one scenario have one shape; a renamed, dropped or retyped field
 * changes it.
 */
export function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const shapes = [...new Set(value.map((one) => JSON.stringify(shapeOf(one))))].sort();
    return { '[]': shapes.map((one) => JSON.parse(one)) };
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]),
    );
  }
  return typeof value;
}

/** What no recording may hold. */
export function leaksIn(text: string): string[] {
  const found: string[] = [];
  if (text.includes('@')) found.push('@');
  if (text.includes('eyJ')) found.push('eyJ');
  if (new RegExp(HEX64.source, 'i').test(text)) found.push('64-hex');
  if (new RegExp(UUID.source, 'i').test(text)) found.push('uuid');
  return found;
}

/** Where in a body a leak sits, as JSON paths (never the value), so a failure names the field. */
export function leakPaths(value: unknown, at = '$'): string[] {
  if (typeof value === 'string') return leaksIn(value).length ? [at] : [];
  if (Array.isArray(value)) return value.flatMap((one, index) => leakPaths(one, `${at}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, one]) => leakPaths(one, `${at}.${key}`));
  }
  return [];
}

export const recordingPath = (name: string) => path.join(CONTRACT_BODIES_DIR, `${name}.json`);

/**
 * A phase detail with each file's bytes replaced by their length. The seams
 * recorded here are about provenance, tasks and versions, not starter bytes,
 * and a starter can hold anything (a decorator's `@`, a digest).
 */
export function elideFiles<T>(detail: T): T {
  const body = detail as unknown as { files?: Array<{ content?: unknown }> };
  if (!Array.isArray(body?.files)) return detail;
  return {
    ...(detail as object),
    files: body.files.map((file) =>
      typeof file.content === 'string' ? { ...file, content: `<elided ${file.content.length} chars>` } : file,
    ),
  } as T;
}

/** A workspace map (path to bytes) with the same elision. */
export function elideWorkspace(files: Record<string, string> | null | undefined): Record<string, string> | null | undefined {
  if (!files) return files;
  return Object.fromEntries(Object.entries(files).map(([at, bytes]) => [at, `<elided ${bytes.length} chars>`]));
}

/**
 * Record (with `CONTRACT_BODIES_RECORD=1`) or check one recording. `bodies` is
 * redacted first; the call returns the redacted live bodies. When checking,
 * the file must exist and every body's shape must equal the recorded one.
 */
export function holdContract(
  name: string,
  recordedBy: string,
  bodies: Record<string, unknown>,
  redactor: Redactor,
): { live: Record<string, unknown>; recorded: Recording } {
  const live = redactor.redact(bodies);
  const recording: Recording = {
    recordedBy,
    redaction:
      'ids <uuid:n>, emails <email:n>, tokens <jwt>, digests <sha256:n>, named values <label>, times as ordinal instants from 2026-01-01T00:00:00Z',
    bodies: live,
  };
  const text = `${JSON.stringify(recording, null, 1)}\n`;
  const leaks = leaksIn(text);
  if (leaks.length) throw new Error(`the ${name} recording would hold ${leaks.join(', ')} at ${leakPaths(live).slice(0, 8).join(', ')}`);
  const at = recordingPath(name);
  if (RECORDING) {
    fs.writeFileSync(at, text, { encoding: 'utf-8', mode: 0o644 });
    return { live, recorded: recording };
  }
  if (!fs.existsSync(at)) throw new Error(`no recording ${name}.json: record it once with CONTRACT_BODIES_RECORD=1`);
  const recorded = JSON.parse(fs.readFileSync(at, 'utf-8')) as Recording;
  const drift = Object.keys({ ...recorded.bodies, ...live }).filter(
    (key) => JSON.stringify(shapeOf(recorded.bodies[key])) !== JSON.stringify(shapeOf(live[key])),
  );
  if (drift.length) {
    throw new Error(`the ${name} contract moved in: ${drift.join(', ')} (re-record with CONTRACT_BODIES_RECORD=1 and re-run the web wiring tests)`);
  }
  return { live, recorded };
}
