import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AUTHORING_ROUTES, AUTHORING_ROUTE_KEYS, INHERITED_TASK_KEY, PHASE_ORDER, SEALED_FILE_ROLES, UPLOAD_REFUSALS, isSealedFileRole } from '@learnsdlc/shared';
import type { AuthoringRouteKey, PhaseKey, RunResult } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { DeepValidationService, hasCurrentDeepReceipt } from '../src/authoring/deep-validation';
import { UPLOAD_PATH } from '../src/authoring/upload.service';
import { sealedFilesOf } from '../src/content/blob.store';
import type { CompiledSnapshot } from '../src/content/pack-compiler';
import type { CodeChecks, ConfigChecks, TestsChecks } from '../src/content/content.types';
import { readZip, zipLimits } from '../src/content/zip-reader';
import { config } from '../src/config';
import { ProjectEntity, ProjectFileEntity, ProjectVersionEntity } from '../src/content/project.entities';
import { AuditEventEntity, PhaseStateEntity, UserEntity } from '../src/db/entities';
import { SandboxService } from '../src/execution/sandbox.service';
import type { SandboxJob } from '../src/execution/sandbox.service';
import { blob as gitBlob, looseObjectPath } from '../src/repo/git';
import { mockAiForRoutes } from './mock-ai';
import { entriesOf, writeZip, zipDirectory } from './fixtures/upload-packs/archive';
import { HOSTILE_ARCHIVES } from './fixtures/upload-packs/hostile';
import { SHELF_MARKERS } from './fixtures/upload-packs/markers';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';
import { OLDER_SHELF_DIR } from './fixtures/paths';

/**
 * The sealed-marker grep over the **real** Shelf pack. sealed-roles.e2e-spec.ts
 * greps TaskTrackr with the Shelf markers planted in it; this file greps an
 * uploaded pack whose own sealed files carry them.
 *
 * The Shelf pack is zipped (`zipDirectory`) and uploaded as base64 through
 * `POST /instructor/projects/upload` on the real AppModule, by a teacher, so the
 * draft is the real `UploadService` + `importTeacherDraft` answer. Then:
 *
 * 1. every `AUTHORING_ROUTES` GET, for the owner, an ADMIN and another
 *    teacher, on all six phases, is byte-grepped;
 * 2. the draft is deep-validated through the real deep-validation route (the sandbox's
 *    transport stubbed: this host's runner refuses without kernel isolation)
 *    and published through the real publish route, a class is put on it, and
 *    every learner GET (the 23 kinds sealed-roles.e2e-spec.ts uses) is byte-grepped on all six
 *    phases, opened;
 * 3. the upload's own answer, and the refusal of every hostile archive built
 *    from the Shelf pack (whose sealed files carry the markers), are byte-grepped.
 *
 * **Needles.** The Shelf pack's six `SHELF_MARKERS` (raw, JSON-escaped, base64), and
 * every line of 28+ characters in its sealed files (`hidden_tests`,
 * `solution`, `reference`, `impl`, `mutants`, `drill`) that no learner-visible
 * part of the pack holds. "Learner-visible" is read from the pack on disk:
 * `canonical/**`, each phase's `files/**`, `task.md`, `phase.json` minus its
 * `checks`, and `project.json`, never from the product's compile, so a compile
 * that put a sealed file in a workspace would not blind the grep.
 *
 * **Known blind spot.** Deployment
 * mounts `canonical/api/shelf.py`, which equals the sealed maintenance solution
 * `api/shelf.py` apart from its marker line (Deployment's other mounts are
 * `files/api.Dockerfile`, `files/runbook.json`, `canonical/api/main.py` and
 * `canonical/deploy/shelf.json`; `canonical/web/src/lib/shelf.ts` is mounted by
 * no phase, so its lines stay needles). Those lines are learner-visible by
 * construction, so they are not needles and are not counted as a leak; the
 * count is recorded, as are the fixture's other overlaps (a sealed line a
 * learner can read in another phase's own files).
 *
 * **Positive control.** A learner-visible line of each executable phase's own
 * editable starter IS found in the owner's `files.list` and in the learner's
 * `/phases/:id`: the grep reads real file bytes, or it reads nothing.
 */
/**
 * Shelf as it shipped in the older layout, before the pack moved to the folder layout:
 * every reading below of what a learner can see is written against its pointers (`canonical/`,
 * `files[].source`, `task.md`), and the door converts it once into the same stored rows the
 * folder-layout Shelf gives, so the seal is proven over the same bytes either way.
 */
const MARK = SHELF_MARKERS;
const MARKERS: string[] = Object.values(MARK);
const SEALED_DIRS = ['hidden_tests', 'solution', 'reference', 'impl', 'mutants', 'drill'] as const;
const NEEDLE_MIN = 28;

/**
 * The export route as the shared contract names it, or undefined where the
 * export route is not mounted. Case 4 holds either way: mounted, the route is
 * this path and the case runs as written; unmounted, this very URL answers 404
 * to every caller, the owner included, with no needle and no
 * `project.exported` row.
 */
const EXPORT_ROUTE = (AUTHORING_ROUTES as unknown as Readonly<Record<string, { method: string; path: string } | undefined>>)['version.export'];
const EXPORT_PATH = '/instructor/projects/:projectId/versions/:versionId/export';

/** One line of the grep table: a route, a caller, what it answered and which needles it carried. */
interface RouteGrep {
  surface: 'authoring' | 'learner' | 'upload';
  route: string;
  caller: string;
  pass: string;
  status: number;
  leaked: string[];
  control?: boolean;
  /**
   * How many needles an answer that serves sealed bytes by design holds (the
   * owner's own `version.export`): not a leak, so never in `leaked`, which a
   * reader of the table counts as one.
   */
  held?: number;
}

/**
 * The needles a response carries, read from its raw bytes, its JSON-escaped
 * text, and the decoded text of every base64 run in it (a marker at an
 * arbitrary offset is not the base64 of the marker inside the base64 of a
 * file, so runs are decoded rather than matched, at each of the four quartet
 * offsets, url-safe runs included). Bytes are read
 * both as UTF-8 (what the routes send; some needles carry non-ASCII text) and
 * as latin1 (no byte sequence is lost), and a needle is also looked for with
 * its non-ASCII characters `\u`-escaped. Every grep asks supertest for the
 * body as raw bytes (`binary` below), so the latin1 arm reads what was sent.
 */
const bothWays = (bytes: Buffer): string => `${bytes.toString('utf-8')}\n${bytes.toString('latin1')}`;
const uEscaped = (text: string): string => text.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
function leakedIn(raw: Buffer | string, needles: string[]): string[] {
  const text = Buffer.isBuffer(raw) ? bothWays(raw) : raw;
  // A run is read in the url-safe alphabet too
  // ("-" and "_" mapped to "+" and "/"), and from each of the four places a
  // quartet can start, so a run that begins one to three characters into
  // other text (which the run pattern swallows) still decodes. Offset 0 is
  // the plain reader.
  const decoded = (text.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? [])
    .flatMap((run) => {
      const standard = run.replace(/-/g, '+').replace(/_/g, '/');
      return [0, 1, 2, 3].map((offset) => bothWays(Buffer.from(standard.slice(offset), 'base64')));
    })
    .join('\n');
  return needles.filter((needle) => {
    const escaped = JSON.stringify(needle).slice(1, -1);
    const forms = [needle, escaped, uEscaped(escaped)];
    return forms.some((form) => text.includes(form) || decoded.includes(form));
  });
}

/** supertest's body as the raw bytes, whatever the content type (an archive, or a refusal's JSON). */
const binary = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

/**
 * What a learner route's body is grepped as. A
 * body that is a zip (a learner's `/repo/:slug/export.zip`) is its raw bytes,
 * then each entry's name and bytes (so a deflated entry is read), then every
 * loose object under `.git/objects/` inflated (`zlib.inflateSync`): git keeps
 * each object as a zlib stream (`repo.service.ts` writes `object.deflated`),
 * so a sealed byte in an older commit is in no entry's bytes as sent. An
 * object that is not a zlib stream is counted in `skipped` and its bytes are
 * still grepped as sent. A zip this reader cannot open fails the test rather
 * than reading as clean.
 */
function learnerBytes(raw: Buffer): { text: Buffer; inflated: number; skipped: number } {
  if (raw.length < 4 || raw.readUInt32LE(0) !== 0x04034b50) return { text: raw, inflated: 0, skipped: 0 };
  const parts: Buffer[] = [raw];
  let inflated = 0;
  let skipped = 0;
  for (const entry of readZip(raw, zipLimits(config.importMaxBytes))) {
    parts.push(Buffer.from(`\n${entry.name}\n`, 'utf-8'), entry.bytes);
    if (!/(^|\/)\.git\/objects\//.test(entry.name)) continue;
    try {
      parts.push(Buffer.from('\n', 'utf-8'), zlib.inflateSync(entry.bytes));
      inflated += 1;
    } catch {
      skipped += 1;
    }
  }
  return { text: Buffer.concat(parts), inflated, skipped };
}

/** An archive as one haystack: its raw bytes, then each entry's name and bytes (so a deflated entry is read too). */
const archiveText = (archive: Buffer): Buffer =>
  Buffer.concat([archive, ...readZip(archive, zipLimits(config.importMaxBytes)).flatMap((one) => [Buffer.from(`\n${one.name}\n`, 'utf-8'), one.bytes])]);

/* --------------------------- the Shelf pack on disk --------------------------- */

interface ShelfFile {
  /** Pack-relative posix path. */
  name: string;
  text: string;
}

const shelfFiles = (): ShelfFile[] => entriesOf(OLDER_SHELF_DIR).map((one) => ({ name: one.name, text: one.data.toString('utf-8') }));

/** `phases/NN-key/<dir>/…` → the sealed dir, or null when the file is not sealed. */
function sealedDirOf(name: string): (typeof SEALED_DIRS)[number] | null {
  const parts = name.split('/');
  if (parts[0] !== 'phases' || parts.length < 4) return null;
  return (SEALED_DIRS as readonly string[]).includes(parts[2]) ? (parts[2] as (typeof SEALED_DIRS)[number]) : null;
}

/**
 * What a learner can be shown, file by file: `project.json`, and for each
 * phase its `phase.json` without `checks`, its brief (`taskFile`) and every
 * file it mounts (`files[].source`, resolved: a `../../canonical/…` mount
 * is visible in that phase; a canonical file no phase mounts is not).
 */
function learnerVisibleFiles(files: ShelfFile[]): Record<string, string> {
  const byName = new Map(files.map((one) => [one.name, one.text]));
  const out: Record<string, string> = { 'project.json': byName.get('project.json') ?? '' };
  for (const file of files) {
    if (!/^phases\/[^/]+\/phase\.json$/.test(file.name)) continue;
    const dir = path.posix.dirname(file.name);
    const { checks: _checks, ...rest } = JSON.parse(file.text);
    out[file.name] = JSON.stringify(rest, null, 2);
    const brief = path.posix.normalize(`${dir}/${rest.taskFile ?? 'task.md'}`);
    out[brief] = byName.get(brief) ?? '';
    for (const mount of (rest.files ?? []) as { source: string }[]) {
      const at = path.posix.normalize(`${dir}/${mount.source}`);
      out[at] = byName.get(at) ?? '';
    }
  }
  return out;
}

const linesOf = (text: string): string[] =>
  text.split('\n').map((line) => line.trim()).filter((line) => line.length >= NEEDLE_MIN);

/** A sealed JSON file's distinctive text is its string values (a raw `"key": "value",` line is never what a payload carries). */
function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
}
/**
 * A mutant's `name` is its identifier, not a sealed byte: it is the folder of
 * its sealed rows, which the teacher's own file list names by path, digest and
 * size, and the learner's kill matrix names it by design
 * (`feedback.service.ts` survivors). Its `description` stays a needle.
 */
const MUTANT_META = /^phases\/[^/]+\/mutants\/[^/]+\/meta\.json$/;
const distinctiveOf = (file: ShelfFile): string[] => {
  if (!file.name.endsWith('.json')) return linesOf(file.text);
  const parsed = JSON.parse(file.text);
  if (MUTANT_META.test(file.name)) delete parsed.name;
  return stringLeaves(parsed).map((one) => one.trim()).filter((one) => one.length >= NEEDLE_MIN);
};

/** The sealed needles, and what was left out because a learner may see it anyway (with the visible file that holds it). */
function sealedNeedles(files: ShelfFile[]): {
  needles: string[];
  visibleByDesign: { from: string; seenIn: string[]; line: string }[];
  byDir: Record<string, number>;
} {
  const visible = Object.entries(learnerVisibleFiles(files));
  const needles = new Set<string>();
  const visibleByDesign: { from: string; seenIn: string[]; line: string }[] = [];
  const byDir: Record<string, number> = {};
  for (const file of files) {
    const dir = sealedDirOf(file.name);
    if (!dir) continue;
    for (const line of distinctiveOf(file)) {
      const seenIn = visible.filter(([, text]) => text.includes(line)).map(([name]) => name);
      if (seenIn.length) {
        visibleByDesign.push({ from: file.name, seenIn, line });
        continue;
      }
      if (!needles.has(line)) byDir[dir] = (byDir[dir] ?? 0) + 1;
      needles.add(line);
    }
  }
  return { needles: [...needles], visibleByDesign, byDir };
}

/** One learner-visible line of each executable phase's editable starter that no sealed file holds. */
function controlLines(files: ShelfFile[]): Record<string, string> {
  const sealed = files.filter((one) => sealedDirOf(one.name)).map((one) => one.text).join('\n');
  const out: Record<string, string> = {};
  for (const [key, dir] of [
    ['implementation', '03-implementation'],
    ['testing', '04-testing'],
    ['maintenance', '06-maintenance'],
  ] as const) {
    const phase = JSON.parse(files.find((one) => one.name === `phases/${dir}/phase.json`)!.text);
    const editable = (phase.files as { path: string; source: string; editable: boolean }[]).filter((one) => one.editable);
    for (const one of editable) {
      const file = files.find((f) => f.name === path.posix.normalize(`phases/${dir}/${one.source}`));
      const line = file && linesOf(file.text).find((candidate) => !sealed.includes(candidate) && /[A-Za-z]{4}/.test(candidate));
      if (line) {
        out[key] = line;
        break;
      }
    }
  }
  return out;
}

/* ----------------------------------- spec ----------------------------------- */

describe('sealed roles over the uploaded shelf pack, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  let address = 0;
  /** Each request from its own address, so the upload path's per-address gate measures the route, not this file. */
  const from = () => ({ 'x-forwarded-for': `10.88.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });
  const table: RouteGrep[] = [];
  const record: Record<string, unknown> = {};

  let owner = { id: '', token: '' };
  let admin = { id: '', token: '' };
  let other = { id: '', token: '' };
  let learner = { id: '', token: '' };
  let cohortId = '';
  let joinCode = '';
  let projectId = '';
  let versionId = '';
  let slug = '';
  let uploadAnswer = '';
  let learnerPhases: Record<string, string> = {};

  const files = shelfFiles();
  const { needles: SEALED_LINES, visibleByDesign, byDir } = sealedNeedles(files);
  const CONTROLS = controlLines(files);
  const NEEDLES = [...MARKERS, ...SEALED_LINES];

  let snapshot: CompiledSnapshot;
  const payloads: Record<string, unknown>[] = [];

  /* -------- the sandbox transport: judges a job by its bytes (as deep-validation.e2e-spec.ts does) -------- */
  const ok = (n = 4): RunResult => ({ ok: true, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1, tests: { total: n, passed: n, failed: 0, errored: 0, cases: [] } });
  const bad = (n = 4): RunResult => ({ ok: false, exitKind: 'error', stdout: '', stderr: '', durationMs: 1, tests: { total: n, passed: n - 1, failed: 1, errored: 0, cases: [] } });
  const same = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys(a).sort().join('\n') === Object.keys(b).sort().join('\n') && Object.keys(a).every((k) => a[k] === b[k]);
  const judge = (job: SandboxJob): RunResult => {
    const phases = snapshot.content.phases;
    if (job.mode === 'smoke') {
      const drill = phases.map((p) => (p.checks.kind === 'config' ? (p.checks as ConfigChecks).drill : undefined)).find(Boolean);
      const faulted = drill && Object.entries(drill.faultedFiles).some(([at, bytes]) => job.files[at] === bytes);
      return { ok: !faulted, exitKind: faulted ? 'error' : 'ok', stdout: '', stderr: '', durationMs: 1 };
    }
    if (job.gradedFiles) {
      const tests = phases.find((p) => p.checks.kind === 'tests')?.checks as TestsChecks | undefined;
      return tests?.runs.some((run) => same(job.gradedFiles!, run.implFiles)) ? ok() : bad();
    }
    for (const phase of phases) {
      if (phase.checks.kind !== 'code') continue;
      const checks = phase.checks as CodeChecks;
      const hidden = checks.runs.some(
        (run) => Object.keys(run.hiddenTestFiles).length > 0 && Object.entries(run.hiddenTestFiles).every(([at, bytes]) => job.files[at] === bytes),
      );
      if (!hidden) continue;
      return Object.entries(checks.solutionFiles).every(([at, bytes]) => job.files[at] === bytes) ? ok() : bad();
    }
    return bad();
  };

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `${name}-${stamp}@sealed-shelf.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const upload = (token: string, archive: Buffer, title: string) =>
    request(http).post(UPLOAD_PATH).set(bearer(token)).set(from()).send({ title, archiveBase64: archive.toString('base64') });

  beforeAll(async () => {
    jest.spyOn(SandboxService.prototype as any, 'runPython').mockImplementation(async (...args: unknown[]) => {
      const payload = args[1] as Record<string, unknown>;
      payloads.push(payload);
      return JSON.stringify(judge(payload as unknown as SandboxJob));
    });
    // Test-only: read the client address from X-Forwarded-For (see `from`).
    // One listening server on loopback (an ephemeral port, closed by app.close):
    // supertest reuses a listening server, so ~620 requests share one port
    // instead of each binding its own while other processes run.
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], trustProxy: true, listen: true }));
    db = app.get(DataSource);

    owner = await account('shelf-owner', 'INSTRUCTOR');
    admin = await account('shelf-admin', 'ADMIN');
    other = await account('shelf-other', 'INSTRUCTOR');
    learner = await account('shelf-learner');

    const made = await request(http).post('/api/v1/instructor/cohorts').set(bearer(owner.token)).send({ name: 'Shelf Wednesday' }).expect(201);
    cohortId = made.body.id;
    joinCode = made.body.joinCode;

    // The Shelf pack, uploaded through the real door.
    const uploaded = await upload(owner.token, zipDirectory(OLDER_SHELF_DIR), `Shelf ${stamp}`);
    expect({ status: uploaded.status, code: uploaded.body?.code }).toEqual({ status: 201, code: undefined });
    uploadAnswer = uploaded.text ?? '';
    projectId = uploaded.body.projectId;
    versionId = uploaded.body.versionId;
    slug = uploaded.body.slug;
    snapshot = (await db.manager.findOneByOrFail(ProjectVersionEntity, { id: versionId })).compiled as CompiledSnapshot;
  }, 120000);

  afterAll(async () => {
    if (process.env.SEALED_ROLES_RECORD_OUT) {
      fs.writeFileSync(process.env.SEALED_ROLES_RECORD_OUT, JSON.stringify({ record, table }, null, 1), { mode: 0o600 });
    }
    jest.restoreAllMocks();
    await app?.close();
  });

  /* ------------------------------ the greps ------------------------------ */

  /**
   * Every authoring GET in `AUTHORING_ROUTES`, for the owner, an ADMIN and
   * another teacher, on every phase a route takes, plus the audit console.
   * `sealed.read` and `version.export` are the owner's audited reads by design
   * so only their owner answer is skipped.
   */
  const grepAuthoring = async (
    pass: string,
    onVersion: string,
    on: { projectId: string; cohortId: string; callers?: Record<'owner' | 'admin' | 'other', { token: string }> } = { projectId, cohortId },
    needles: string[] = NEEDLES,
  ): Promise<RouteGrep[]> => {
    const rows: RouteGrep[] = [];
    const callers = on.callers ?? { owner, admin, other };
    const ownerReads: AuthoringRouteKey[] = ['sealed.read' as AuthoringRouteKey, 'version.export' as AuthoringRouteKey];
    const paths: { key: string; path: string; skipOwner: boolean }[] = [];
    for (const key of AUTHORING_ROUTE_KEYS) {
      const route = AUTHORING_ROUTES[key];
      if (route.method !== 'GET') continue;
      const phases: PhaseKey[] = route.path.includes(':phaseKey') ? [...PHASE_ORDER] : ['implementation'];
      for (const phaseKey of phases) {
        const at = route.path
          .replace(':projectId', on.projectId)
          .replace(':versionId', onVersion)
          .replace(':phaseKey', phaseKey)
          .replace(':taskKey', INHERITED_TASK_KEY)
          .replace(':cohortId', on.cohortId);
        paths.push({ key: route.path.includes(':phaseKey') ? `${key} ${phaseKey}` : key, path: at, skipOwner: ownerReads.includes(key) });
      }
    }
    paths.push({ key: 'instructor.audit', path: '/instructor/audit', skipOwner: false });
    const controls = Object.values(CONTROLS);
    for (const { key, path: at, skipOwner } of paths) {
      for (const [name, who] of Object.entries(callers)) {
        if (name === 'owner' && skipOwner) continue;
        const answer = await request(http).get(`/api/v1${at}`).set(bearer(who.token)).set(from()).buffer(true).parse(binary as never);
        const raw = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.text ?? '', 'utf-8');
        rows.push({
          surface: 'authoring', pass, route: key, caller: name, status: answer.status,
          leaked: leakedIn(raw, needles), control: leakedIn(raw, controls).length > 0,
        });
      }
    }
    table.push(...rows);
    return rows;
  };

  /** Every learner GET (the 23 kinds sealed-roles.e2e-spec.ts uses), on every phase, opened. */
  const grepLearner = async (
    pass: string,
    on: { slug: string; learner: { token: string }; learnerPhases: Record<string, string> } = { slug, learner, learnerPhases },
    needles: string[] = NEEDLES,
  ): Promise<RouteGrep[]> => {
    const rows: RouteGrep[] = [];
    const { slug, learner, learnerPhases } = on;
    const routes = [
      '/projects',
      `/projects/${slug}`,
      `/projects/${slug}/map`,
      `/projects/${slug}/map?unfold=1`,
      '/enrollments/mine',
      '/phases/summaries',
      '/phases/records',
      `/repo/${slug}/summary`,
      `/repo/${slug}/export.zip`,
    ];
    for (const id of Object.values(learnerPhases)) {
      for (const tail of [
        '',
        '/submissions',
        '/runs',
        `/tasks/${INHERITED_TASK_KEY}/submissions`,
        `/tasks/${INHERITED_TASK_KEY}/reset`,
        `/tasks/${INHERITED_TASK_KEY}/quiz`,
        '/solution',
        `/tasks/${INHERITED_TASK_KEY}/solution`,
        '/preview',
        '/lesson/mentor',
        '/interview',
        '/stuck',
        '/agent/proposals',
        '/agent/turns',
      ]) {
        routes.push(`/phases/${id}${tail}`);
      }
    }
    const keyOf = Object.fromEntries(Object.entries(learnerPhases).map(([key, id]) => [id, key]));
    const controls = Object.values(CONTROLS);
    for (const route of routes) {
      const answer = await request(http).get(`/api/v1${route}`).set(bearer(learner.token)).set(from()).buffer(true).parse(binary as never);
      const raw = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.text ?? '', 'utf-8');
      const read = learnerBytes(raw);
      if (route === `/repo/${slug}/export.zip`) record[`repoLooseObjects:${pass}`] = { inflated: read.inflated, skipped: read.skipped };
      rows.push({
        surface: 'learner', pass,
        route: route.replace(/[0-9a-f-]{36}/, (id) => keyOf[id] ?? ':id').replace(slug, ':slug'),
        caller: 'learner', status: answer.status,
        leaked: leakedIn(read.text, needles), control: leakedIn(read.text, controls).length > 0,
      });
      if (pass === 'published' && route === `/phases/${learnerPhases.implementation}`) record.learnerImplementationBytes = raw.length;
    }
    table.push(...rows);
    return rows;
  };

  /**
   * The rows that leaked, each as `route caller: needle…` so a red names its
   * call site, and any row the rate limiter answered, because a 429 reads
   * nothing and would pass a grep for the wrong reason.
   */
  const leaks = (rows: RouteGrep[]) => rows.filter((one) => one.leaked.length > 0 || one.status === 429).map((one) => `${one.surface} ${one.route} ${one.caller} (${one.status}): ${one.leaked.map((n) => n.slice(0, 40)).join(' | ')}`);

  /* ------------------------------ the control ------------------------------ */

  it('the plant is real: the Shelf pack was uploaded, its sealed bytes are stored, and the needles and controls are non-empty', async () => {
    // Needles from every sealed dir the Shelf pack has; the drill's faulted copy is a
    // short JSON file whose one distinctive value is its marker.
    expect(Object.keys(byDir).sort()).toEqual(SEALED_DIRS.filter((dir) => dir !== 'drill').sort());
    expect(files.filter((one) => sealedDirOf(one.name) === 'drill').map((one) => one.text).join('')).toContain(MARK.drill);
    expect(SEALED_LINES.length).toBeGreaterThan(20);
    // The reader reads what a route sends: every needle, served as UTF-8 JSON
    // bytes (raw, \u-escaped, and as base64), is found. Some needles carry
    // non-ASCII text (an em dash in a hidden assertion), so a reader that
    // decodes bytes as latin1 alone would never match them.
    expect(NEEDLES.filter((one) => /[^\x00-\x7f]/.test(one)).length).toBeGreaterThan(0);
    const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const unread = NEEDLES.filter((one) =>
      [
        Buffer.from(JSON.stringify({ x: one }), 'utf-8'),
        Buffer.from(asciiJson({ x: one }), 'utf-8'),
        Buffer.from(JSON.stringify({ x: `${Buffer.from(`\n${one}\n`, 'utf-8').toString('base64')}` }), 'utf-8'),
      ].some((served) => leakedIn(served, [one]).length !== 1),
    );
    expect(unread).toEqual([]);
    // One server, listening on loopback before the first request: supertest
    // reuses it rather than binding a fresh ephemeral port per request.
    expect(http.address()).toEqual(expect.objectContaining({ address: '127.0.0.1' }));
    // The fixture's known blind spot is excluded by construction, and only it: every
    // sealed line a learner may see comes from the maintenance solution's
    // canonical twin (or a line every copy of the file shares).
    record.needles = { markers: MARKERS.length, sealedLines: SEALED_LINES.length, byDir, visibleByDesign: visibleByDesign.length };
    const pairs: Record<string, number> = {};
    for (const one of visibleByDesign) for (const seen of one.seenIn) pairs[`${one.from} <= ${seen}`] = (pairs[`${one.from} <= ${seen}`] ?? 0) + 1;
    record.visibleByDesignPairs = pairs;
    // The blind spot proper: maintenance-solution lines a learner can read
    // only through deployment's canonical mount (no phase's own files hold them).
    record.blindSpotOnlyViaCanonical = visibleByDesign
      .filter((one) => one.from.startsWith('phases/06-maintenance/solution/') && one.seenIn.every((seen) => seen.startsWith('canonical/')))
      .map((one) => ({ from: one.from, seenIn: one.seenIn, chars: one.line.length }));
    // The fixture's other overlaps, recorded beside the blind spot (not leaks:
    // a sealed line the pack itself shows a learner in some phase's own files),
    // each line classed by the phases that mount a file holding it, relative to
    // the sealed file's own phase: samePhase, earlierPhase (seen before, not in
    // its own phase), laterPhaseOnly.
    const phaseDirs = files.filter((one) => /^phases\/[^/]+\/phase\.json$/.test(one.name)).map((one) => one.name.split('/')[1]);
    const mountedIn: Record<string, string[]> = { 'project.json': phaseDirs };
    for (const phaseDir of phaseDirs) {
      const dir = `phases/${phaseDir}`;
      const parsed = JSON.parse(files.find((one) => one.name === `${dir}/phase.json`)!.text);
      const shown = [`${dir}/phase.json`, path.posix.normalize(`${dir}/${parsed.taskFile ?? 'task.md'}`), ...((parsed.files ?? []) as { source: string }[]).map((m) => path.posix.normalize(`${dir}/${m.source}`))];
      for (const at of shown) (mountedIn[at] ??= []).push(phaseDir);
    }
    const overlaps = new Map<string, { from: string; seenInPhases: string[]; seenIn: string[]; kind: string; chars: number }>();
    for (const one of visibleByDesign) {
      if (one.from.startsWith('phases/06-maintenance/solution/') && one.seenIn.every((seen) => seen.startsWith('canonical/'))) continue;
      const own = one.from.split('/')[1];
      const seenInPhases = [...new Set(one.seenIn.flatMap((seen) => mountedIn[seen] ?? []))].sort();
      const kind = seenInPhases.includes(own) ? 'samePhase' : seenInPhases.some((at) => at < own) ? 'earlierPhase' : 'laterPhaseOnly';
      overlaps.set(`${one.from}\n${one.line}`, { from: one.from, seenInPhases, seenIn: one.seenIn, kind, chars: one.line.length });
    }
    const listed = [...overlaps.values()];
    record.fixtureOverlaps = {
      uniqueLinesByKind: listed.reduce<Record<string, number>>((acc, one) => ({ ...acc, [one.kind]: (acc[one.kind] ?? 0) + 1 }), {}),
      notInOwnPhase: listed.filter((one) => one.kind !== 'samePhase'),
    };
    // The fixture's known blind spot is among them: the maintenance solution's lines a
    // deployment learner already holds through canonical/api/shelf.py.
    expect(visibleByDesign.some((one) => one.from === 'phases/06-maintenance/solution/api/shelf.py' && one.seenIn.includes('canonical/api/shelf.py'))).toBe(true);
    // A control for each executable phase with an editable starter.
    expect(Object.keys(CONTROLS).sort()).toEqual(['implementation', 'maintenance', 'testing']);
    for (const line of Object.values(CONTROLS)) expect(SEALED_LINES).not.toContain(line);
    // The draft really holds the Shelf pack's sealed bytes: every marker and every needle is in the stored compile.
    const stored = JSON.stringify(snapshot);
    expect(leakedIn(stored, MARKERS).sort()).toEqual([...MARKERS].sort());
    expect(SEALED_LINES.filter((line) => leakedIn(stored, [line]).length === 0)).toEqual([]);
    // And the learner-visible part of that compile holds none of them (the
    // compile did not put a sealed file in a workspace).
    const visible = JSON.stringify({ ...snapshot.content, phases: snapshot.content.phases.map(({ checks: _checks, ...rest }) => rest) });
    expect(leakedIn(visible, NEEDLES)).toEqual([]);
    expect(Object.values(CONTROLS).every((line) => leakedIn(visible, [line]).length === 1)).toBe(true);
    const project = await db.manager.findOneByOrFail(ProjectEntity, { id: projectId });
    expect({ owner: project.ownerUserId, platform: project.platformOwned }).toEqual({ owner: owner.id, platform: false });
  });

  /* --------------------------- case 2: the upload answer --------------------------- */

  // The reader the learner grep uses
  // must see a sealed byte wherever a route can carry it: inside a learner's
  // /repo/:slug/export.zip, an older commit lives only in a zlib-deflated
  // loose object under .git/objects/ (repo.service.ts writes object.deflated);
  // and a base64 run may start at any offset of its quartet, or be url-safe.
  it('the reader is not blind: a needle only inside a deflated loose object of a repo export.zip is found (a non-zlib object is counted, not read), and base64 runs are read at offsets 0-3 and in the url-safe alphabet', () => {
    const needle = NEEDLES.find((one) => /[^\x00-\x7f]/.test(one)) ?? NEEDLES[0];
    const object = gitBlob(Buffer.from(`older commit\n${needle}\n`, 'utf-8'));
    const repoZip = writeZip([
      { name: 'README.md', data: Buffer.from(`${CONTROLS[Object.keys(CONTROLS)[0]]}\n`, 'utf-8'), method: 0 },
      { name: looseObjectPath(object.id), data: object.deflated, method: 0 },
      { name: '.git/objects/ff/not-a-zlib-stream', data: Buffer.from('PLAIN-NOT-ZLIB', 'utf-8'), method: 0 },
      { name: '.git/HEAD', data: Buffer.from('ref: refs/heads/main\n', 'utf-8'), method: 0 },
    ]);
    // the plant is only deflated: no raw, escaped or base64 form of it is in the archive's bytes
    expect(leakedIn(repoZip, [needle])).toEqual([]);
    const read = learnerBytes(repoZip);
    expect(leakedIn(read.text, [needle])).toEqual([needle]);
    expect({ inflated: read.inflated, skipped: read.skipped }).toEqual({ inflated: 1, skipped: 1 });
    // a body that is not an archive is read as it was sent
    expect(learnerBytes(Buffer.from('{"ok":true}', 'utf-8')).text.toString('utf-8')).toBe('{"ok":true}');

    // a run that starts 1-3 characters into a quartet, and the url-safe alphabet
    const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64');
    const urlSafe = (text: string) => b64(text).replace(/\+/g, '-').replace(/\//g, '_');
    const missed: string[] = [];
    for (const one of NEEDLES) {
      for (const lead of ['A', 'AB', 'ABC']) if (leakedIn(`{"x":"${lead}${b64(`\n${one}\n`)}"}`, [one]).length !== 1) missed.push(`offset ${lead.length}: ${one.slice(0, 32)}`);
      if (leakedIn(`{"x":"${urlSafe(`\n${one}\n`)}"}`, [one]).length !== 1) missed.push(`url-safe: ${one.slice(0, 32)}`);
    }
    expect(missed).toEqual([]);
    // the url-safe arm is not vacuous: some needle's encoding carries "-" or "_"
    expect(NEEDLES.some((one) => /[-_]/.test(urlSafe(`\n${one}\n`)))).toBe(true);
  });

  it("the upload's own answer (ProjectUploadResult) carries no sealed marker or line", () => {
    expect(uploadAnswer.length).toBeGreaterThan(0);
    const row: RouteGrep = { surface: 'upload', route: 'projects.upload shelf', caller: 'owner', pass: 'upload', status: 201, leaked: leakedIn(uploadAnswer, NEEDLES) };
    table.push(row);
    expect(leaks([row])).toEqual([]);
  });

  /* --------------------------- case 1a: authoring, draft --------------------------- */

  it('on the draft, no authoring GET carries a sealed byte of the Shelf pack, for the owner, an ADMIN or another teacher, on any phase', async () => {
    const rows = await grepAuthoring('draft', versionId);
    const at = (route: string, caller: string) => rows.find((one) => one.route === route && one.caller === caller);
    // The grep read real file bytes: the owner's draft and files answered,
    // and every executable phase's control line was in the files list.
    expect(at('version.draft', 'owner')?.status).toBe(200);
    expect(at('files.list', 'owner')?.status).toBe(200);
    const filesList = await request(http).get(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/files`).set(bearer(owner.token)).expect(200);
    for (const line of Object.values(CONTROLS)) expect(leakedIn(filesList.text, [line])).toEqual([line]);
    expect(at('files.list', 'owner')?.control).toBe(true);
    // Another teacher sees nothing of the draft.
    expect(at('version.draft', 'other')?.status).toBe(404);
    expect(leaks(rows)).toEqual([]);
  });

  /* --------------------------- case 1b: deep validation, publish --------------------------- */

  it('publish: a current deep receipt through the real VAL route (stub sandbox), then the real publish route', async () => {
    const route = `/api/v1/instructor/projects/${projectId}/versions/${versionId}/deep-validation`;
    const before = await request(http).get(route).set(bearer(owner.token)).expect(200);
    const microVMs = before.body.costWarning.microVMs as number;
    await request(http).post(route).set(bearer(owner.token)).send({ acknowledgedMicroVMs: microVMs }).expect(202);
    await app.get(DeepValidationService).idle();
    const view = await request(http).get(route).set(bearer(owner.token)).expect(200);
    for (const answer of [before, view]) expect(leakedIn(answer.text, NEEDLES)).toEqual([]);
    table.push({ surface: 'authoring', route: 'deepValidation.read (after)', caller: 'owner', pass: 'deep', status: view.status, leaked: leakedIn(view.text, NEEDLES) });
    record.deep = { status: view.body.status, current: view.body.current, microVMs, jobs: payloads.length };
    expect(view.body.status).toBe('passed');
    expect(view.body.current).toBe(true);
    expect(hasCurrentDeepReceipt(await db.manager.findOneByOrFail(ProjectVersionEntity, { id: versionId }))).toBe(true);

    // The real publish door: no stand-in, no seeded deep-validation receipt,
    // no seeded publish.
    const published = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/publish`)
      .set(bearer(owner.token))
      .send({ version: '1.0.0' });
    expect({ status: published.status, message: published.status === 200 ? null : published.body.message }).toEqual({ status: 200, message: null });
    expect(leakedIn(published.text, NEEDLES)).toEqual([]);
    table.push({ surface: 'authoring', route: 'version.publish', caller: 'owner', pass: 'publish', status: published.status, leaked: leakedIn(published.text, NEEDLES) });

    // A class on it, and a learner in that class, every phase opened.
    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(owner.token))
      .send({ projectVersionId: versionId, reason: 'Wednesday runs the shelf this term.' })
      .expect(200);
    await request(http).post('/api/v1/enrollments/join').set(bearer(learner.token)).send({ code: joinCode }).expect(200);
    const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(learner.token)).send({ projectSlug: slug }).expect(201);
    expect(enrolled.body.projectSlug).toBe(slug);
    learnerPhases = Object.fromEntries(enrolled.body.phases.map((one: any) => [one.key, one.id]));
    expect(Object.keys(learnerPhases).sort()).toEqual([...PHASE_ORDER].sort());
    for (const id of Object.values(learnerPhases)) {
      await db.manager.update(PhaseStateEntity, { id }, { status: 'in_progress', attempts: 1 });
    }
    expect(leakedIn(enrolled.text, NEEDLES)).toEqual([]);
  });

  /* --------------------------- case 1c: learner, published --------------------------- */

  it('once published, no learner GET carries a sealed byte of the Shelf pack, on any phase, opened', async () => {
    expect(Object.keys(learnerPhases)).toHaveLength(6);
    const rows = await grepLearner('published');
    // The grep read real bytes: every phase room answered, and each executable
    // phase's control line was in its own room.
    for (const key of PHASE_ORDER) expect(rows.find((one) => one.route === `/phases/${key}`)?.status).toBe(200);
    for (const key of Object.keys(CONTROLS)) expect(rows.find((one) => one.route === `/phases/${key}`)?.control).toBe(true);
    // The learner's repo export.zip was read as an archive,
    // every loose object under .git/objects/ inflated before the grep, none skipped.
    expect(rows.find((one) => one.route === '/repo/:slug/export.zip')?.status).toBe(200);
    const loose = record['repoLooseObjects:published'] as { inflated: number; skipped: number };
    expect(loose.inflated).toBeGreaterThan(0);
    expect(loose.skipped).toBe(0);
    expect(leaks(rows)).toEqual([]);
  });

  it('no authoring GET on the published version carries a sealed byte of the Shelf pack', async () => {
    const rows = await grepAuthoring('published', versionId);
    expect(rows.find((one) => one.route === 'files.list' && one.caller === 'owner')?.control).toBe(true);
    expect(leaks(rows)).toEqual([]);
  });

  /* --------------------------- case 4: version.export --------------------------- */

  /**
   * `version.export` serves sealed bytes by design, to the owning teacher only
   * (audited as `project.exported`), which is why the authoring grep skips
   * its owner answer. Here every caller reads it: the owner's archive HOLDS
   * every needle (the positive control: the grep reads the archive's bytes,
   * raw and entry by entry), and writes one row; a learner is refused 403 at
   * the staff guard, another teacher 404, an ADMIN who does not own it 403,
   * none with a needle, an archive or a row. A copy of the platform project
   * exports none of TaskTrackr's inherited sealed lines (the real needles
   * sealed-roles.e2e-spec.ts reads), while an open TaskTrackr line it keeps IS
   * in its archive.
   */
  it("version.export: only the owning teacher's archive holds the Shelf pack's sealed bytes (one project.exported row); a learner 403, another teacher 404, an ADMIN 403, none with a needle; a 3a copy's export holds no inherited TaskTrackr sealed byte", async () => {
    const exportPath = (p: string, v: string) => `/api/v1${EXPORT_PATH.replace(':projectId', p).replace(':versionId', v)}`;
    const exportOf = (token: string, p: string, v: string) =>
      request(http).get(exportPath(p, v)).set(bearer(token)).set(from()).buffer(true).parse(binary as never);
    const exportedRows = async (p: string) =>
      (await db.manager.find(AuditEventEntity, { where: { targetId: p } })).filter((one) => (one.event as string) === 'project.exported'); // a plain string: with the export route unmounted the event is not in the shared union
    const zipType = (answer: request.Response) => String(answer.headers['content-type'] ?? '').split(';')[0];
    const before = (await exportedRows(projectId)).length;

    if (!EXPORT_ROUTE) {
      // Export route unmounted: no export exists, so no caller gets an archive, a needle or a row.
      const cut: [string, { token: string }][] = [['owner', owner], ['learner', learner], ['other', other], ['admin', admin]];
      for (const [name, who] of cut) {
        const answer = await exportOf(who.token, projectId, versionId);
        const raw = answer.body as Buffer;
        const row: RouteGrep = { surface: 'authoring', pass: 'export (CUT-2)', route: 'version.export (unmounted)', caller: name, status: answer.status, leaked: leakedIn(raw, NEEDLES), control: false };
        table.push(row);
        // An unmatched route: the platform's own 404 (no archive, no export headers).
        expect({ caller: name, status: answer.status, zip: zipType(answer) === 'application/zip', withheld: answer.headers['x-export-withheld'] })
          .toEqual({ caller: name, status: 404, zip: false, withheld: undefined });
        expect(leaks([row])).toEqual([]);
      }
      expect(await exportedRows(projectId)).toHaveLength(before);
      return;
    }
    // Mounted: the URL probed in the unmounted case is the contract's own.
    expect(EXPORT_ROUTE.path).toBe(EXPORT_PATH);

    // The owner: 200, a zip, nothing withheld (their own upload), every needle in it, one row.
    const mine = await exportOf(owner.token, projectId, versionId);
    const held = mine.status === 200 ? leakedIn(archiveText(mine.body as Buffer), NEEDLES) : [];
    // The owner's archive serves sealed bytes by design: counted in `held`, never in `leaked`.
    table.push({ surface: 'authoring', pass: 'export-owner', route: 'version.export', caller: 'owner', status: mine.status, leaked: [], held: held.length, control: held.length === NEEDLES.length });
    expect({ status: mine.status, type: zipType(mine), withheld: mine.headers['x-export-withheld'] }).toEqual({ status: 200, type: 'application/zip', withheld: '0' });
    expect(NEEDLES.filter((one) => !held.includes(one)).map((one) => one.slice(0, 60))).toEqual([]);
    const ownerRows = await exportedRows(projectId);
    expect(ownerRows).toHaveLength(before + 1);
    expect(ownerRows[ownerRows.length - 1].actorUserId).toBe(owner.id);
    for (const one of ownerRows) expect(leakedIn(JSON.stringify(one), NEEDLES)).toEqual([]);

    // Everyone else: refused, no needle, no archive, no row.
    const refused: [string, { token: string }, number][] = [
      ['learner', learner, 403],
      ['other', other, 404],
      ['admin', admin, 403],
    ];
    for (const [name, who, status] of refused) {
      const answer = await exportOf(who.token, projectId, versionId);
      const raw = answer.body as Buffer;
      const row: RouteGrep = { surface: 'authoring', pass: 'export', route: 'version.export', caller: name, status: answer.status, leaked: leakedIn(raw, NEEDLES), control: leakedIn(raw, Object.values(CONTROLS)).length > 0 };
      table.push(row);
      expect({ caller: name, status: answer.status, type: zipType(answer), withheld: answer.headers['x-export-withheld'] })
        .toEqual({ caller: name, status, type: 'application/json', withheld: undefined });
      expect(leaks([row])).toEqual([]);
      expect(row.control).toBe(false);
    }
    expect(await exportedRows(projectId)).toHaveLength(before + 1);

    // A copy of the platform project exports none of what it inherited
    // sealed, read three ways, since a line grep alone is blind to a sealed
    // file with no distinctive line and to a role it never reads:
    //  - by line: every line of 28+ characters of a sealed file, every string
    //    of the requirements interview and every mutant's description that no
    //    learner-visible part of the pack holds (the needles sealed-roles.e2e-spec.ts uses), in no entry;
    //  - by name: no entry in a sealed folder or at a phase's interview.json
    //    (a support or smoke file only when a phase mounts its very bytes at
    //    its path: the export's `unrowed`, open material by design);
    //  - by whole file: no entry is byte-equal to a sealed file no phase
    //    mounts (each run's and each mutant's files on their own);
    // and `x-export-withheld` is exactly the copy's inherited sealed rows plus
    // the reference material no phase mounts (withheld fail closed).
    const copier = await account('shelf-copier', 'INSTRUCTOR');
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(copier.token)).set(from()).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    expect(platform?.platformOwned).toBe(true);
    const shipped = (await db.manager.findOneByOrFail(ProjectVersionEntity, { id: platform.publishedVersionId })).compiled as CompiledSnapshot;
    // What a learner may see: the content without any phase's checks or interview brief.
    const visible = JSON.stringify({ ...shipped.content, phases: shipped.content.phases.map(({ checks: _checks, interview: _interview, ...rest }) => rest) });
    /** Every sealed file the version holds, one by one (`sealedFilesOf` merges runs and mutants by path). */
    const sealedFiles: { phase: string; role: string; at: string; bytes: string }[] = [];
    const interviews: { phase: string; brief: unknown }[] = [];
    const mutantWords: string[] = [];
    for (const phase of shipped.content.phases) {
      const put = (role: string, files: Record<string, string> | undefined) => {
        for (const [at, bytes] of Object.entries(files ?? {})) sealedFiles.push({ phase: phase.key, role, at, bytes });
      };
      const checks = phase.checks as any;
      if (checks.kind === 'code') {
        put('hidden', checks.hiddenTestFiles);
        put('solution', checks.solutionFiles);
      }
      if (checks.kind === 'tests') {
        put('reference', checks.referenceTestFiles);
        put('reference', checks.implFiles);
        put('support', checks.supportFiles);
        for (const mutant of checks.mutants ?? []) {
          put('mutant', mutant.files);
          mutantWords.push(String(mutant.description ?? ''));
        }
      }
      if (checks.kind === 'code' || checks.kind === 'tests') {
        for (const run of checks.runs ?? []) {
          put('hidden', run.hiddenTestFiles);
          put('reference', run.referenceTestFiles);
          put('reference', run.implFiles);
          put('support', run.supportFiles);
        }
      }
      if (checks.kind === 'config') {
        put('drill', checks.drill?.faultedFiles);
        put('smoke', checks.smokeImplFiles);
      }
      if (phase.interview) interviews.push({ phase: phase.key, brief: phase.interview });
      // The walk misses no sealed file the product's own reader names.
      const sealed = sealedFilesOf(phase);
      for (const role of SEALED_FILE_ROLES) {
        for (const at of Object.keys(sealed[role] ?? {})) {
          expect({ phase: phase.key, role, at, walked: sealedFiles.some((one) => one.phase === phase.key && one.role === role && one.at === at) }).toEqual({ phase: phase.key, role, at, walked: true });
        }
      }
    }
    expect(interviews.map((one) => one.phase)).toEqual(['requirements']);
    expect([...new Set(sealedFiles.map((one) => one.role))].sort()).toEqual(['drill', 'hidden', 'mutant', 'reference', 'smoke', 'solution', 'support']);
    const isOpen = (text: string) => visible.includes(JSON.stringify(text).slice(1, -1));
    const inheritedLines = new Set<string>();
    for (const one of sealedFiles) for (const line of linesOf(one.bytes)) if (!isOpen(line)) inheritedLines.add(line);
    const briefWords = interviews.flatMap((one) => stringLeaves(one.brief)).map((one) => one.trim()).filter((one) => one.length >= NEEDLE_MIN && !isOpen(one));
    expect(briefWords.length).toBeGreaterThan(0);
    for (const one of [...briefWords, ...mutantWords.map((w) => w.trim()).filter((w) => w.length >= NEEDLE_MIN && !isOpen(w))]) inheritedLines.add(one);
    const TASKTRACKR_SEALED = [...inheritedLines];
    expect(TASKTRACKR_SEALED.length).toBeGreaterThan(20);
    expect(TASKTRACKR_SEALED.some((one) => /[^\x00-\x7f]/.test(one))).toBe(true);
    // The copy's control: an open line of TaskTrackr's implementation workspace, which the copy keeps.
    const openLine = shipped.content.phases
      .find((phase) => phase.key === 'implementation')!
      .files.flatMap((file) => linesOf(file.content))
      .find((line) => /[A-Za-z]{4}/.test(line) && !TASKTRACKR_SEALED.includes(line));
    expect(openLine).toBeDefined();

    const made = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(copier.token))
      .set(from())
      .send({ title: `Shelf copy ${stamp}`, slug: `shelf-copy-${stamp}`, fromVersionId: platform.publishedVersionId });
    expect({ status: made.status, message: made.status === 201 ? null : made.body?.message }).toEqual({ status: 201, message: null });
    const copy = { projectId: made.body.project.id as string, versionId: made.body.draftVersionId as string };
    const copied = await exportOf(copier.token, copy.projectId, copy.versionId);
    const copyText = copied.status === 200 ? archiveText(copied.body as Buffer) : (copied.body as Buffer);
    const inherited = leakedIn(copyText, TASKTRACKR_SEALED);
    const copyRow: RouteGrep = { surface: 'authoring', pass: 'export', route: 'version.export (3a copy)', caller: 'copier', status: copied.status, leaked: inherited.map((one) => `real:${one.slice(0, 32)}`), control: leakedIn(copyText, [openLine!]).length === 1 };
    table.push(copyRow);
    expect({ status: copied.status, type: zipType(copied) }).toEqual({ status: 200, type: 'application/zip' });
    expect(copyRow.control).toBe(true);
    expect(leaks([copyRow])).toEqual([]);
    // By name, and by whole file.
    const entries = readZip(copied.body as Buffer, zipLimits(config.importMaxBytes)).map((one) => ({ name: one.name, text: one.bytes.toString('utf-8') }));
    const mounted = new Set(shipped.content.phases.flatMap((phase) => phase.files.map((file) => `${file.path}\n${file.content}`)));
    const mountedBytes = new Set(shipped.content.phases.flatMap((phase) => phase.files.map((file) => file.content)));
    const SEALED_FOLDER = /^[^/]+\/phases\/[^/]+\/(hidden_tests|solution|reference|impl|mutants|drill|support|smoke)\/(.+)$/;
    const openByMount: string[] = [];
    const misplaced = entries.flatMap((one) => {
      if (/^[^/]+\/phases\/[^/]+\/interview\.json$/.test(one.name)) return [one.name];
      const folder = SEALED_FOLDER.exec(one.name);
      if (!folder) return [];
      if ((folder[1] === 'support' || folder[1] === 'smoke') && mounted.has(`${folder[2]}\n${one.text}`)) {
        openByMount.push(one.name.split('/').slice(1).join('/'));
        return [];
      }
      return [one.name];
    });
    expect(misplaced).toEqual([]);
    const sealedOnly = new Map(sealedFiles.filter((one) => !mountedBytes.has(one.bytes)).map((one) => [one.bytes, `${one.phase} ${one.role} ${one.at}`]));
    // (TaskTrackr's testing reference implementation is the app a phase mounts locked, so most of its files are open bytes.)
    expect(sealedOnly.size).toBeGreaterThan(15);
    expect(entries.filter((one) => sealedOnly.has(one.text)).map((one) => `${one.name} = ${sealedOnly.get(one.text)}`)).toEqual([]);
    // Withheld: every inherited sealed row (all of a fresh copy's sealed rows),
    // and each support or smoke file no phase mounts at its path, nothing else.
    const copyFiles = await db.manager.find(ProjectFileEntity, { where: { projectVersionId: copy.versionId } });
    const inheritedRows = copyFiles.filter((one) => isSealedFileRole(one.role));
    expect([...new Set(inheritedRows.map((one) => one.role))].sort()).toEqual(['drill', 'hidden', 'interview', 'mutant', 'reference', 'solution']);
    const unmountedReference = new Set(
      sealedFiles.filter((one) => (one.role === 'support' || one.role === 'smoke') && !mounted.has(`${one.at}\n${one.bytes}`)).map((one) => `${one.phase} ${one.role} ${one.at}`),
    );
    expect(Number(copied.headers['x-export-withheld'])).toBe(inheritedRows.length + unmountedReference.size);
    const copyRows = await exportedRows(copy.projectId);
    expect(copyRows).toHaveLength(1);
    expect(leakedIn(JSON.stringify(copyRows[0]), TASKTRACKR_SEALED)).toEqual([]);
    record.export = {
      ownerNeedlesHeld: held.length,
      needles: NEEDLES.length,
      refused: refused.map(([name, , status]) => `${name} ${status}`),
      copyWithheld: Number(copied.headers['x-export-withheld']),
      copyInheritedSealedRows: inheritedRows.length,
      copyUnmountedReference: unmountedReference.size,
      copyEntries: entries.length,
      copyOpenByMount: openByMount,
      tasktrackrSealedFiles: sealedFiles.length,
      tasktrackrSealedOnlyBytes: sealedOnly.size,
      tasktrackrSealedLines: TASKTRACKR_SEALED.length,
    };
  }, 120000);

  /* --------------------------- case 2b: hostile refusals --------------------------- */

  it("every hostile archive built from the Shelf pack (its sealed files carry the markers) is refused by a sentence and detail that carry no sealed byte", async () => {
    // The hostile set, plus two of this file's own: a phase.json whose
    // body is a marker (the loader's JSON excerpt), and one whose harness is a
    // sealed line (a value the run-shape rule names).
    const shelf = entriesOf(OLDER_SHELF_DIR);
    const replace = (name: string, data: string) => writeZip(shelf.map((one) => (one.name === name ? { name, data: Buffer.from(data, 'utf-8') } : one)));
    const maint = JSON.parse(files.find((one) => one.name === 'phases/06-maintenance/phase.json')!.text);
    maint.checks.runs[0].harness = SEALED_LINES[0];
    // A JSON parser's message quotes only ~10 characters of the body, which a
    // whole-needle grep misses; refusal bodies are also grepped for the
    // markers' shared prefix (no refusal sentence, path or finding spells it).
    const markerBody = `${MARK.hidden} ${SEALED_LINES[0]}`;
    const EXCERPT = 'SHELF-SEAL';
    expect(MARKERS.every((one) => one.startsWith(EXCERPT))).toBe(true);
    const parserSays = (() => {
      try {
        JSON.parse(markerBody);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect({ whole: leakedIn(parserSays, NEEDLES), excerpt: leakedIn(parserSays, [EXCERPT]) }).toEqual({ whole: [], excerpt: [EXCERPT] });
    const set = [
      ...HOSTILE_ARCHIVES.filter((one) => one.expectedOutcome === 'refused').map((one) => ({ name: one.name, archive: one.build(), code: one.expectedUploadCode as string })),
      { name: 'phase-json-is-a-marker', archive: replace('phases/03-implementation/phase.json', markerBody), code: null },
      { name: 'harness-is-a-sealed-line', archive: replace('phases/06-maintenance/phase.json', JSON.stringify(maint, null, 2)), code: null },
    ];
    let uploader = await account('shelf-hostile-0', 'INSTRUCTOR');
    let used = 0;
    const rows: RouteGrep[] = [];
    const shapes: Record<string, number> = {};
    for (const [index, one] of set.entries()) {
      if (used >= 5) {
        uploader = await account(`shelf-hostile-${index}`, 'INSTRUCTOR');
        used = 0;
      }
      used += 1;
      const res = await upload(uploader.token, one.archive, 'Books on a shelf');
      expect({ name: one.name, refused: res.status >= 400 && res.status < 500 }).toEqual({ name: one.name, refused: true });
      if (one.code) expect({ name: one.name, code: res.body.code }).toEqual({ name: one.name, code: one.code });
      expect(typeof res.body.sentence).toBe('string');
      // The sentence is the code's fixed one, or (a pack the loader refuses) the loader's, cleaned.
      if (res.body.code !== 'NOT_A_PACK' && res.body.code in UPLOAD_REFUSALS && !res.body.detail) {
        expect(res.body.sentence).toBe(UPLOAD_REFUSALS[res.body.code as keyof typeof UPLOAD_REFUSALS]);
      }
      const said = [res.body.sentence, res.body.detail ?? '', JSON.stringify(res.body.findings ?? [])].join('\n');
      said.length && (shapes[`${res.body.code}${res.body.detail ? '+detail' : ''}`] = (shapes[`${res.body.code}${res.body.detail ? '+detail' : ''}`] ?? 0) + 1);
      rows.push({ surface: 'upload', route: `projects.upload ${one.name}`, caller: 'teacher', pass: 'hostile', status: res.status, leaked: [...new Set([...leakedIn(said, [...NEEDLES, EXCERPT]), ...leakedIn(res.text ?? '', [...NEEDLES, EXCERPT])])] });
    }
    table.push(...rows);
    record.hostile = { archives: set.length, refused: rows.filter((one) => one.status >= 400).length, codes: shapes };
    expect(leaks(rows)).toEqual([]);
  });
  /* --------------------------- case 3: a new sealed file in run 2 --------------------------- */

  /**
   * The Shelf pack with a second python run in Maintenance (`api-more`), built in
   * memory from the pack's own bytes (its folder is frozen and has one python run
   * per phase): the same variant authoring-executable.e2e-spec.ts uploads. A NEW hidden file,
   * carrying a marker of its own, is written through `sealed.write` with
   * `runId: 'api-more'`; the draft is deep-validated and published, a class is
   * put on it, and every authoring and learner GET is grepped for it. Only the
   * owner's audited `sealed.read` gives it back, with one `project.sealed-read`
   * row; ADMIN 403, another teacher 404.
   */
  it("a new hidden file written into Maintenance's second python run through sealed.write is in no GET; only the owner's audited sealed.read returns it", async () => {
    const RUN_TWO = { marker: 'SEALED-RUN-TWO-HIDDEN-7J4W', line: 'self.assertEqual(shelf_order_more_probe(), "seal-2 run two")' };
    const RUN_TWO_NEEDLES = [RUN_TWO.marker, RUN_TWO.line, ...NEEDLES];
    // Fresh callers: the per-user rate limits on the GETs this spec already
    // drove four passes of would otherwise answer 429 (which reads nothing).
    const owner = await account('shelf-owner-two', 'INSTRUCTOR');
    const admin = await account('shelf-admin-two', 'ADMIN');
    const other = await account('shelf-other-two', 'INSTRUCTOR');
    const callers = { owner, admin, other };
    const made = await request(http).post('/api/v1/instructor/cohorts').set(bearer(owner.token)).send({ name: 'Shelf Thursday' }).expect(201);
    const at = 'tests/test_hidden_seal2_more.py';
    const bytes = `"""${RUN_TWO.marker}"""\nimport unittest\n\n\nclass SealTwo(unittest.TestCase):\n    def test_run_two(self):\n        ${RUN_TWO.line}\n`;

    // The variant archive, in memory.
    const entries = entriesOf(OLDER_SHELF_DIR).map((one) => {
      if (one.name !== 'phases/06-maintenance/phase.json') return one;
      const phase = JSON.parse(one.data.toString('utf-8'));
      phase.checks.runs.push({
        id: 'api-more', language: 'python', harness: 'pytest', hiddenHarness: 'unittest', label: 'More API tests',
        visibleTests: ['tests/test_shelf_order_more.py'], hiddenTestDir: 'hidden_tests/api-more', supportFiles: ['tests/conftest.py'],
      });
      phase.files.push({ path: 'tests/test_shelf_order_more.py', source: 'files/tests/test_shelf_order_more.py', editable: false, language: 'python' });
      return { name: one.name, data: Buffer.from(JSON.stringify(phase, null, 2)) };
    });
    entries.push(
      { name: 'phases/06-maintenance/files/tests/test_shelf_order_more.py', data: Buffer.from('def test_more_visible():\n    assert True\n') },
      { name: 'phases/06-maintenance/hidden_tests/api-more/test_hidden_more.py', data: Buffer.from('import unittest\n\n\nclass More(unittest.TestCase):\n    def test_more(self):\n        self.assertTrue(True)\n') },
    );
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const uploaded = await upload(owner.token, writeZip(entries), `Shelf two runs ${stamp}`);
    expect({ status: uploaded.status, code: uploaded.body?.code }).toEqual({ status: 201, code: undefined });
    expect(leakedIn(uploaded.text, RUN_TWO_NEEDLES)).toEqual([]);
    const two = { projectId: uploaded.body.projectId as string, versionId: uploaded.body.versionId as string, slug: uploaded.body.slug as string };
    const base = `/api/v1/instructor/projects/${two.projectId}/versions/${two.versionId}`;
    const door = `${base}/phases/maintenance/tasks/${INHERITED_TASK_KEY}/sealed`;
    const put = (token: string) =>
      request(http).put(door).set(bearer(token)).send({ role: 'hidden', runId: 'api-more', path: at, contentBase64: Buffer.from(bytes).toString('base64') });

    // The write answers the view only; ADMIN may not write, another teacher cannot see.
    const wrote = await put(owner.token);
    expect({ status: wrote.status, message: wrote.status >= 400 ? wrote.body.message : null }).toEqual({ status: 200, message: null });
    expect(Object.keys(wrote.body).sort()).toEqual(['bytes', 'path', 'sha256']);
    expect(leakedIn(wrote.text, RUN_TWO_NEEDLES)).toEqual([]);
    expect([(await put(admin.token)).status, (await put(other.token)).status]).toEqual([403, 404]);

    // It is stored where it was declared: run 2's hidden suite, and nowhere in run 1.
    await request(http).post(`${base}/validate`).set(bearer(owner.token)).expect(200);
    const compiled = (await db.manager.findOneByOrFail(ProjectVersionEntity, { id: two.versionId })).compiled as CompiledSnapshot;
    const runs = Object.fromEntries((compiled.content.phases.find((p) => p.key === 'maintenance')!.checks as CodeChecks).runs.map((run) => [run.id, run]));
    expect(runs['api-more'].hiddenTestFiles[at]).toBe(bytes);
    expect(runs.api.hiddenTestFiles[at]).toBeUndefined();
    const draftRows = await grepAuthoring('s11-draft', two.versionId, { projectId: two.projectId, cohortId: made.body.id, callers }, RUN_TWO_NEEDLES);
    expect(draftRows.find((one) => one.route === 'files.list' && one.caller === 'owner')?.control).toBe(true);
    expect(leaks(draftRows)).toEqual([]);

    // Deep-validate (the stub judges the variant's own bytes) and publish through the real doors.
    snapshot = compiled;
    const cost = await request(http).get(`${base}/deep-validation`).set(bearer(owner.token)).expect(200);
    await request(http).post(`${base}/deep-validation`).set(bearer(owner.token)).send({ acknowledgedMicroVMs: cost.body.costWarning.microVMs }).expect(202);
    await app.get(DeepValidationService).idle();
    const proved = await request(http).get(`${base}/deep-validation`).set(bearer(owner.token)).expect(200);
    expect({ status: proved.body.status, current: proved.body.current }).toEqual({ status: 'passed', current: true });
    const published = await request(http).post(`${base}/publish`).set(bearer(owner.token)).send({ version: '1.0.0' });
    expect({ status: published.status, message: published.status === 200 ? null : published.body.message }).toEqual({ status: 200, message: null });
    for (const answer of [cost, proved, published]) expect(leakedIn(answer.text, RUN_TWO_NEEDLES)).toEqual([]);

    // A second class and learner on it, every phase opened.
    await request(http).put(`/api/v1/instructor/cohorts/${made.body.id}/project`).set(bearer(owner.token))
      .send({ projectVersionId: two.versionId, reason: 'Thursday runs the two-run shelf.' }).expect(200);
    const learner2 = await account('shelf-learner-two');
    await request(http).post('/api/v1/enrollments/join').set(bearer(learner2.token)).send({ code: made.body.joinCode }).expect(200);
    const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(learner2.token)).send({ projectSlug: two.slug }).expect(201);
    const phases2: Record<string, string> = Object.fromEntries(enrolled.body.phases.map((one: any) => [one.key, one.id]));
    for (const id of Object.values(phases2)) await db.manager.update(PhaseStateEntity, { id }, { status: 'in_progress', attempts: 1 });

    // Every GET, both surfaces: the new file's marker and line are in none of them.
    const authoring = await grepAuthoring('s11', two.versionId, { projectId: two.projectId, cohortId: made.body.id, callers }, RUN_TWO_NEEDLES);
    const learnerRows = await grepLearner('s11', { slug: two.slug, learner: learner2, learnerPhases: phases2 }, RUN_TWO_NEEDLES);
    expect(authoring.find((one) => one.route === 'files.list' && one.caller === 'owner')?.control).toBe(true);
    expect(learnerRows.find((one) => one.route === '/phases/maintenance')?.control).toBe(true);
    expect(leaks([...authoring, ...learnerRows])).toEqual([]);

    // The owner-only audited read: returns it (the base64 arm's positive control), one row; ADMIN 403, other 404, no row.
    const sealedReads = async () =>
      (await db.manager.find(AuditEventEntity, { where: { targetId: two.projectId } })).filter((one) => one.event === 'project.sealed-read');
    expect(await sealedReads()).toHaveLength(0);
    const ask = { role: 'hidden', path: at, runId: 'api-more' };
    const read = await request(http).get(door).query(ask).set(bearer(owner.token)).set(from());
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ role: 'hidden', runId: 'api-more', path: at });
    expect(Buffer.from(read.body.contentBase64, 'base64').toString('utf-8')).toBe(bytes);
    expect(leakedIn(read.text, [RUN_TWO.marker, RUN_TWO.line])).toEqual([RUN_TWO.marker, RUN_TWO.line]);
    const rows = await sealedReads();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(owner.id);
    expect(leakedIn(JSON.stringify(rows[0]), RUN_TWO_NEEDLES)).toEqual([]);
    // The rendered row, through the audit console GET, after the read: the
    // event is listed (owner: their own action; ADMIN: every action) and
    // carries no sealed byte; another teacher's console does not list it.
    const consoles: RouteGrep[] = [];
    for (const [name, who] of Object.entries(callers)) {
      const answer = await request(http).get('/api/v1/instructor/audit').set(bearer(who.token)).set(from()).buffer(true).parse(binary as never);
      const raw = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.text ?? '', 'utf-8');
      consoles.push({ surface: 'authoring', pass: 's11-after-read', route: 'instructor.audit', caller: name, status: answer.status, leaked: leakedIn(raw, RUN_TWO_NEEDLES), control: raw.includes('project.sealed-read') });
    }
    table.push(...consoles);
    expect(consoles.map((one) => [one.caller, one.status, one.control])).toEqual([
      ['owner', 200, true],
      ['admin', 200, true],
      ['other', 200, false],
    ]);
    expect(leaks(consoles)).toEqual([]);
    const byAdmin = await request(http).get(door).query(ask).set(bearer(admin.token)).set(from());
    const byOther = await request(http).get(door).query(ask).set(bearer(other.token)).set(from());
    expect([byAdmin.status, byOther.status]).toEqual([403, 404]);
    for (const answer of [byAdmin, byOther]) expect(leakedIn(answer.text, RUN_TWO_NEEDLES)).toEqual([]);
    expect(await sealedReads()).toHaveLength(1);
    record.s11 = { authoringRows: authoring.length, learnerRows: learnerRows.length, sealedReadRows: 1, adminRead: byAdmin.status, otherRead: byOther.status };
  }, 180000);
});
