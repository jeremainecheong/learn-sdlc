import * as fs from 'fs';
import * as path from 'path';
import { inflateRawSync } from 'zlib';
import { SHELF_DIR } from '../test/fixtures/upload-packs/markers';
import { listArchive, packFilesOf } from '../test/fixtures/upload-packs/archive';
import { HOSTILE_ARCHIVES } from '../test/fixtures/upload-packs/hostile';

/**
 * The upload fixtures are test material and never ship.
 *
 * `apps/api/test/fixtures/upload-packs/**` sits inside `apps/api`, which the
 * build stage of `apps/api/Dockerfile` copies whole (`COPY apps/api apps/api`)
 * because the compiler needs it. The runtime stage must copy none of it: a
 * hostile archive builder or a teacher's sealed hidden suite in the image a
 * learner's submission is graded beside is test material in production.
 *
 * The second half is the hostile set's own hygiene: it is built to be
 * refused, and a refusal sentence, a log line or a fixture diff may print what
 * it held, so none of it may look like a credential.
 */

const API_DIR = path.join(__dirname, '..');
const DOCKERFILE = path.join(API_DIR, 'Dockerfile');
const FIXTURE_REL = 'apps/api/test/fixtures/upload-packs';

/** The instructions of each stage, `FROM` to the next `FROM`, continuation lines joined. */
function stages(text: string): string[][] {
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const out: string[][] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^FROM\s/i.test(trimmed)) out.push([]);
    if (out.length) out[out.length - 1].push(trimmed);
  }
  return out;
}

/** One path segment against one Dockerfile source segment (Go `filepath.Match`: `*`, `?`, `[...]`, never across `/`). */
function segmentMatches(pattern: string, segment: string): boolean {
  if (!/[*?[]/.test(pattern)) return pattern === segment;
  const body = pattern
    .split(/(\*|\?|\[[^\]]*\])/)
    .map((part) => {
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      if (part.startsWith('[') && part.endsWith(']')) return part; // a class reads the same in both
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${body}$`).test(segment);
}

/**
 * True when copying `source` would carry the fixture directory with it: the
 * source is the fixture directory, an ancestor of it, or a path inside it,
 * compared segment by segment so a glob in any segment is honoured.
 */
function carriesFixtures(source: string): boolean {
  const rel = source.replace(/^\/app(?:\/|$)/, '').replace(/^\.\/?/, '').replace(/\/+$/, '');
  if (rel === '' || rel === '.') return true;
  if (rel.includes('upload-packs')) return true;
  const want = FIXTURE_REL.split('/');
  const have = rel.split('/').filter((segment) => segment !== '' && segment !== '.');
  const shared = Math.min(want.length, have.length);
  for (let i = 0; i < shared; i += 1) if (!segmentMatches(have[i], want[i])) return false;
  return true;
}

/** The sources of one COPY/ADD line, in the shell form or the exec (JSON-array) form. */
function sourcesOf(line: string): string[] {
  let rest = line.replace(/^(COPY|ADD)\s+/i, '');
  while (/^--\S+\s+/.test(rest)) rest = rest.replace(/^--\S+\s+/, '');
  let words: string[];
  if (rest.startsWith('[')) {
    try {
      words = (JSON.parse(rest) as unknown[]).map(String);
    } catch {
      // an exec form that is not JSON is read by Docker as the shell form
      words = rest.split(/\s+/);
    }
  } else {
    words = rest.split(/\s+/);
  }
  return words.slice(0, -1);
}

/**
 * The COPY/ADD lines that would carry the fixture directory into the shipped
 * image: the last stage's own, and those of every stage it is built `FROM`
 * (a stage inherits its base stage's filesystem whole).
 */
function fixtureCopiesInRuntime(text: string): string[] {
  const all = stages(text);
  const named = new Map<string, number>();
  all.forEach((stage, index) => {
    const as = /^FROM\s+.*\s+AS\s+(\S+)\s*$/i.exec(stage[0] ?? '');
    if (as) named.set(as[1].toLowerCase(), index);
  });
  const chain: number[] = [];
  for (let at: number | undefined = all.length - 1; at !== undefined && at >= 0 && !chain.includes(at); ) {
    chain.push(at);
    const base = (stage: string[]) =>
      (stage[0] ?? '').replace(/^FROM\s+/i, '').split(/\s+/).find((word) => !word.startsWith('--')) ?? '';
    at = named.get(base(all[at]).toLowerCase());
  }
  const offending: string[] = [];
  for (const index of chain.reverse()) {
    for (const line of all[index].filter((one) => /^(COPY|ADD)\s/i.test(one))) {
      if (sourcesOf(line).some(carriesFixtures)) offending.push(line);
    }
  }
  return offending;
}

/**
 * Each shape, with the literal it cannot match without (checked first, so a
 * 34 MiB bomb is not run through a backtracking pattern for nothing).
 */
const SECRET_SHAPES: [string, RegExp, string | null][] = [
  ['aws access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'IA'],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'eyJ'],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/, '-----BEGIN'],
  ['provider key', /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, 'k-'],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{8,}/, 'xox'],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{20,}/, 'gh'],
  ['long hex', /\b[0-9a-fA-F]{40,}\b/, null],
  ['account id', /(?<![0-9])[0-9]{12}(?![0-9])/, null],
  ['email', /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, '@'],
  ['credential assignment', /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*['"]?[^\s'"]{6,}/i, null],
];

function secretShapesIn(text: string): string[] {
  return SECRET_SHAPES.filter(([, shape, hint]) => (hint === null || text.includes(hint)) && shape.test(text)).map(
    ([label]) => label,
  );
}

describe('upload fixtures are not in the runtime image', () => {
  it('the runtime stage of apps/api/Dockerfile copies nothing from test/fixtures/upload-packs', () => {
    // the fixture this is about exists, or the assertion below proves nothing
    expect(fs.existsSync(path.join(SHELF_DIR, 'project.json'))).toBe(true);
    const text = fs.readFileSync(DOCKERFILE, 'utf-8');
    const all = stages(text);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[all.length - 1].filter((line) => /^(COPY|ADD)\s/i.test(line)).length).toBeGreaterThan(0);
    expect(fixtureCopiesInRuntime(text)).toEqual([]);
    // the build stage's output that the runtime stage takes is compiled from src only
    const build = JSON.parse(fs.readFileSync(path.join(API_DIR, 'tsconfig.build.json'), 'utf-8'));
    expect(build.include).toEqual(['src']);
  });

  it('the check sees a JSON-array COPY, a glob, and a shipped stage built FROM a stage that holds the fixtures', () => {
    const build = 'FROM node:24 AS build\nWORKDIR /app\nCOPY apps/api apps/api\n';
    const ship = (lines: string) => `${build}FROM node:24-slim\nWORKDIR /app\n${lines}\n`;
    // the shipped shape: only build outputs and the runner leave the build stage
    expect(fixtureCopiesInRuntime(ship('COPY --from=build /app/apps/api/dist apps/api/dist\nCOPY apps/api/runner apps/api/runner'))).toEqual([]);
    // the plain form still counts
    expect(fixtureCopiesInRuntime(ship('COPY apps/api apps/api'))).toHaveLength(1);
    expect(fixtureCopiesInRuntime(ship('COPY --from=build /app/apps/api/test apps/api/test'))).toHaveLength(1);
    // the exec (JSON-array) form
    expect(fixtureCopiesInRuntime(ship('COPY ["apps/api", "apps/api"]'))).toHaveLength(1);
    expect(fixtureCopiesInRuntime(ship('ADD --chown=node ["apps/api/test/fixtures", "/fx"]'))).toHaveLength(1);
    expect(fixtureCopiesInRuntime(ship('COPY ["apps/api/dist", "apps/api/dist"]'))).toEqual([]);
    // a glob that matches the fixture directory or one of its ancestors
    expect(fixtureCopiesInRuntime(ship('COPY apps/* apps/'))).toHaveLength(1);
    expect(fixtureCopiesInRuntime(ship('COPY apps/api/te* apps/api/'))).toHaveLength(1);
    expect(fixtureCopiesInRuntime(ship('COPY --from=build /app/apps/api/test/fixtures/upload-pack? /fx'))).toHaveLength(1);
    expect(fixtureCopiesInRuntime(ship('COPY apps/api/runner/*.py apps/api/runner/'))).toEqual([]);
    // the whole of the build stage's /app
    expect(fixtureCopiesInRuntime(ship('COPY --from=build /app /app'))).toHaveLength(1);
    // the shipped stage inherits a stage that copied the fixtures in (reordered or re-based stages)
    expect(fixtureCopiesInRuntime(`${build}FROM build AS runtime\nCOPY content content\n`)).toEqual([
      'COPY apps/api apps/api',
    ]);
    expect(
      fixtureCopiesInRuntime(`${build}FROM build AS mid\nRUN true\nFROM mid\nCOPY content content\n`),
    ).toEqual(['COPY apps/api apps/api']);
  });

  it('FIX-2 carries no secret-shaped value', () => {
    const found: string[] = [];
    for (const hostile of HOSTILE_ARCHIVES) {
      for (const entry of listArchive(hostile.build())) {
        const shapesInName = secretShapesIn(entry.name);
        if (shapesInName.length) found.push(`${hostile.name} ${entry.name}: ${shapesInName.join(', ')}`);
        const bytes = entry.method === 8 ? inflateRawSync(entry.rawData) : entry.rawData;
        const shapes = secretShapesIn(bytes.toString('latin1'));
        if (shapes.length) found.push(`${hostile.name} ${entry.name}: ${shapes.join(', ')}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('the Shelf pack carries no secret-shaped value either', () => {
    const found: string[] = [];
    for (const file of packFilesOf(SHELF_DIR)) {
      const shapes = secretShapesIn(`${file.name}\n${file.data.toString('utf-8')}`);
      if (shapes.length) found.push(`${file.name}: ${shapes.join(', ')}`);
    }
    expect(found).toEqual([]);
  });

  // Every sibling pack beside `shelf` (shelf-preview, run shape 6) is held to the same
  // hygiene, and sits in the one fixture directory the runtime-stage check above keeps out of the image.
  it('every sibling pack under upload-packs carries no secret-shaped value or secret-named file', () => {
    const root = path.dirname(SHELF_DIR);
    expect(path.relative(path.join(API_DIR, '..', '..'), root).split(path.sep).join('/')).toBe(FIXTURE_REL);
    const siblings = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== path.basename(SHELF_DIR))
      .map((entry) => entry.name)
      .sort();
    expect(siblings).toContain('shelf-preview');
    const found: string[] = [];
    for (const sibling of siblings) {
      for (const file of packFilesOf(path.join(root, sibling))) {
        const base = file.name.split('/').pop() ?? '';
        if (/^\.env/i.test(base) || /\.env$/i.test(base) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(base)) {
          found.push(`${sibling}/${file.name}: secret-named file`);
        }
        const shapes = secretShapesIn(`${file.name}\n${file.data.toString('utf-8')}`);
        if (shapes.length) found.push(`${sibling}/${file.name}: ${shapes.join(', ')}`);
      }
    }
    expect(found).toEqual([]);
  });

  // The shelf-task sibling (phase.json's task block) and the shelf-design-task
  // sibling (a Requirements and a Design of the older kind, the drafts a
  // conversion starts from) are among those siblings, so the hygiene check
  // above reads them, and they sit in the fixture directory the runtime stage never copies.
  it.each(['shelf-task', 'shelf-design-task'])('the %s sibling is under upload-packs, read by the sibling hygiene check, with no secret-named file', (sibling) => {
    const root = path.dirname(SHELF_DIR);
    const dir = path.join(root, sibling);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(path.relative(path.join(API_DIR, '..', '..'), dir).split(path.sep).join('/')).toBe(`${FIXTURE_REL}/${sibling}`);
    const files = packFilesOf(dir).map((file) => file.name);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((name) => /(^|\/)\.env|\.env$|\.(pem|key|p12|pfx|jks|keystore)$/i.test(name))).toEqual([]);
    expect(packFilesOf(dir).flatMap((file) => secretShapesIn(`${file.name}\n${file.data.toString('utf-8')}`))).toEqual([]);
  });
});
