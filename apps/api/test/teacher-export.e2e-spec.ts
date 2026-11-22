import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import { DRAFT_FIRST_VERSION, INHERITED_TASK_KEY, SEALED_FILE_ROLES } from '@learnsdlc/shared';
import type { AuthoringLibraryView } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { EXPORT_AUDIT_EVENT, EXPORT_REFUSALS, ExportService, type ExportResult } from '../src/authoring/export.service';
import { UPLOAD_PATH } from '../src/authoring/upload.service';
import { blobShaFor, canonicalJson } from '../src/content/blob.store';
import type { CompiledSnapshot } from '../src/content/pack-compiler';
import type { PhaseRun } from '../src/content/content.types';
import { ContentBlobEntity, ProjectFileEntity, ProjectPhaseEntity, ProjectVersionEntity } from '../src/content/project.entities';
import { readZip, zipLimits, type ArchiveEntry } from '../src/content/zip-reader';
import { config } from '../src/config';
import { AuditEventEntity, UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { zipDirectory } from './fixtures/upload-packs/archive';
import { SHELF_DIR, TASKTRACKR_SENTINELS } from './fixtures/upload-packs/markers';
import { storeTaskTypeEdit } from './stored-task-edit';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * `version.export` over the real AppModule.
 *
 * One listening loopback server (an ephemeral port, closed in afterAll), the
 * real pipeline (`configureApp`), and every archive through the real doors:
 *
 * (a) the semantic round trip, checked in place of pack-digest equality:
 *     the Shelf pack uploaded, a written task edited through
 *     the task door and a sealed hidden test written through the sealed door,
 *     exported, and the archive uploaded again under a new title: the
 *     re-upload loads and compiles to the same task list, the same run shapes
 *     and the same sealed bytes (by the owner-only sealed read and by digest);
 * (b) the same over a whole TaskTrackr-free teacher project carrying a
 *     preview block (`upload-packs/shelf-preview`);
 * (c) a copy of the platform project withholds every inherited sealed file:
 *     `x-export-withheld` is the count, no archive entry is an inherited
 *     sealed blob, and exactly one `project.exported` row;
 *     and no entry holds a 48-byte window of one that the copy
 *     does not already show in the open;
 * (d) another teacher 404 (no row), a learner 403;
 * (e) `Cache-Control: no-store`, `application/zip`, and the file name;
 * (f) a 409 `taskEdited` refusal crosses `configureApp` as the
 *     API's JSON sentence, with no archive headers and no audit row;
 * (g) a draft whose last edit failed validation:
 *     through the doors, the task made optional (the defect fast validation
 *     reports, and the compile with it) and a retitle stored after it: the
 *     edit the archive cannot carry is refused by name, never dropped in
 *     silence; undone, the retitle is carried and the re-upload validates
 *     afresh; and a draft whose stored compile row failed with only carried
 *     edits in its rows exports 200 holding exactly what the rows say.
 *
 * No model call (the provider is the routes' mock), no sandbox run, no port
 * but the one ephemeral loopback listener.
 */
const SHELF_PREVIEW_DIR = path.join(path.dirname(SHELF_DIR), 'shelf-preview');

/** supertest's body as the raw bytes, whatever the content type. */
const binary = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

const entriesOf = (archive: Buffer): ArchiveEntry[] => readZip(archive, zipLimits(config.importMaxBytes));

/** The window for (c): no 48-byte run of an inherited sealed blob may be in the archive. */
const LEAK_WINDOW = 48;
/** UTF-8 text as one character per byte, so a window of 48 characters is 48 bytes. */
const latin1Of = (text: string): string => Buffer.from(text, 'utf-8').toString('latin1');

describe('teacher export over the real AppModule', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  let address = 0;
  /** Each request from its own address, so per-address gates measure the route, not this file. */
  const from = () => ({ 'x-forwarded-for': `10.89.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });

  let owner = { id: '', token: '' };
  let other = { id: '', token: '' };
  let copier = { id: '', token: '' };
  let learner = { id: '', token: '' };

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `${name}-${stamp}@teacher-export.test`, password: PASSWORD, displayName: name })
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

  const versionBase = (projectId: string, versionId: string) => `/api/v1/instructor/projects/${projectId}/versions/${versionId}`;

  /** The export door, its bytes raw. */
  const exportOf = (token: string, projectId: string, versionId: string) =>
    request(http).get(`${versionBase(projectId, versionId)}/export`).set(bearer(token)).set(from()).buffer(true).parse(binary as never);

  const exportedRows = async (projectId: string): Promise<AuditEventEntity[]> =>
    (await db.manager.find(AuditEventEntity, { where: { targetId: projectId } })).filter((row) => row.event === EXPORT_AUDIT_EVENT);

  /** An upload that must be accepted, by its ids. */
  const uploaded = async (token: string, archive: Buffer, title: string) => {
    const answer = await upload(token, archive, title);
    expect({ status: answer.status, code: answer.body?.code, message: answer.status === 201 ? null : answer.body?.message }).toEqual({
      status: 201,
      code: undefined,
      message: null,
    });
    return { projectId: answer.body.projectId as string, versionId: answer.body.versionId as string, slug: answer.body.slug as string };
  };

  /* ------------------------------ what is compared ----------------------------- */

  const snapshotOf = async (versionId: string): Promise<CompiledSnapshot> =>
    (await db.manager.findOneByOrFail(ProjectVersionEntity, { id: versionId })).compiled as CompiledSnapshot;

  /** The task list, as the learner is graded on it: every phase's compiled tasks, the sole key as a pack says it. */
  const taskListOf = (snapshot: CompiledSnapshot): unknown =>
    JSON.parse(
      canonicalJson(
        snapshot.phases.map((phase) => ({
          key: phase.key,
          tasks: phase.tasks.map((task) => ({ ...task, taskKey: task.taskKey === INHERITED_TASK_KEY ? '' : task.taskKey })),
        })),
      ),
    );

  /** Every executable phase's runs, by shape: what is run, under what, and over which files (no bytes). */
  const runShapesOf = (snapshot: CompiledSnapshot): unknown =>
    snapshot.content.phases
      .filter((phase) => phase.checks.kind === 'code' || phase.checks.kind === 'tests')
      .map((phase) => ({
        key: phase.key,
        kind: phase.checks.kind,
        runs: ((phase.checks as { runs: PhaseRun[] }).runs ?? []).map((run) => ({
          id: run.id,
          language: run.language,
          harness: run.harness,
          hiddenHarness: run.hiddenHarness,
          label: run.label,
          transform: run.transform ?? null,
          visibleTests: run.visibleTests ?? [],
          testPaths: run.testPaths ?? [],
          learnerTestFiles: run.learnerTestFiles ?? [],
          hidden: Object.keys(run.hiddenTestFiles ?? {}).sort(),
          impl: Object.keys(run.implFiles ?? {}).sort(),
          reference: Object.keys(run.referenceTestFiles ?? {}).sort(),
          support: Object.keys(run.supportFiles ?? {}).sort(),
        })),
      }));

  /** Every sealed row of a version as (phase, path, role, digest), sorted. */
  const sealedDigestsOf = async (versionId: string): Promise<string[]> => {
    const phases = await db.manager.find(ProjectPhaseEntity, { where: { projectVersionId: versionId } });
    const keyOf = new Map(phases.map((phase) => [phase.id, phase.key as string]));
    const rows = await db.manager.find(ProjectFileEntity, { where: { projectVersionId: versionId, role: In(SEALED_FILE_ROLES) } });
    return rows.map((row) => [keyOf.get(row.ownerId) ?? 'project', row.path, row.role, row.blobSha].join(' ')).sort();
  };

  /** The compiled bytes of every sealed file of a version, by place (phase/run/role/path → sha). */
  const sealedPlacesOf = (snapshot: CompiledSnapshot): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const phase of snapshot.content.phases) {
      const checks = phase.checks as unknown as Record<string, unknown> & { runs?: PhaseRun[]; mutants?: { name: string; files: Record<string, string> }[] };
      const put = (where: string, files: Record<string, string> | undefined) => {
        for (const [at, bytes] of Object.entries(files ?? {})) out[`${phase.key} ${where} ${at}`] = blobShaFor(bytes);
      };
      if (phase.checks.kind === 'code') {
        for (const run of checks.runs ?? []) put(`hidden:${run.id}`, run.hiddenTestFiles);
        put('solution', checks.solutionFiles as Record<string, string>);
      } else if (phase.checks.kind === 'tests') {
        put('reference', checks.referenceTestFiles as Record<string, string>);
        put('impl', checks.implFiles as Record<string, string>);
        for (const mutant of checks.mutants ?? []) put(`mutant:${mutant.name}`, mutant.files);
      } else if (phase.checks.kind === 'config') {
        const drill = (checks.drill ?? null) as { faultedFiles?: Record<string, string> } | null;
        put('drill', drill?.faultedFiles);
      }
      if (phase.interview) out[`${phase.key} interview`] = blobShaFor(canonicalJson(phase.interview));
    }
    return out;
  };

  /* ----------------------- (c) the window rule, by bytes ----------------------- */

  /** The keys of compiled content that hold sealed bytes or a sealed brief: never open text. */
  const SEALED_CONTENT_KEYS = new Set([
    'hiddenTestFiles',
    'solutionFiles',
    'referenceTestFiles',
    'implFiles',
    'mutants',
    'faultedFiles',
    'supportFiles',
    'smokeImplFiles',
    'interview',
  ]);

  /** Every string of a JSON value, keys left out, under the keys `skip` does not name. */
  const stringsOf = (value: unknown, skip: ReadonlySet<string> = new Set()): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap((one) => stringsOf(one, skip));
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, one]) => (skip.has(key) ? [] : stringsOf(one, skip)));
    }
    return [];
  };

  /** What the copy already shows in the open: its open files, and its compiled content's strings with every sealed key and sealed blob left out. */
  const openCorpusOf = async (versionId: string, rows: ProjectFileEntity[], sealed: ContentBlobEntity[]): Promise<string> => {
    const openShas = [...new Set(rows.filter((row) => row.role === 'workspace' || row.role === 'warmup').map((row) => row.blobSha))];
    const open = openShas.length ? await db.manager.find(ContentBlobEntity, { where: { sha: In(openShas) } }) : [];
    const sealedBytes = new Set(sealed.map((blob) => blob.bytes));
    const said = stringsOf((await snapshotOf(versionId)).content, SEALED_CONTENT_KEYS).filter((one) => !sealedBytes.has(one));
    return [...open.map((blob) => blob.bytes), ...said].map(latin1Of).join('\u0000');
  };

  /** An entry as text, and a JSON entry's strings each as text of their own (an escaped newline hides nothing). */
  const haystacksOf = (entry: ArchiveEntry): { name: string; text: string }[] => {
    const out = [{ name: entry.name, text: entry.bytes.toString('latin1') }];
    if (entry.name.endsWith('.json')) {
      try {
        out.push({ name: `${entry.name} (strings)`, text: stringsOf(JSON.parse(entry.bytes.toString('utf-8'))).map(latin1Of).join('\u0000') });
      } catch {
        // not JSON: its bytes are read above
      }
    }
    return out;
  };

  /** The sealed blobs' 48-byte windows found in a haystack and not in the open corpus, one line per blob and entry. */
  const windowLeaks = (sealed: ContentBlobEntity[], haystacks: { name: string; text: string }[], openCorpus: string) => {
    const windows = new Map<string, string>();
    for (const blob of sealed) {
      const text = latin1Of(blob.bytes);
      for (let at = 0; at + LEAK_WINDOW <= text.length; at += 1) {
        const window = text.slice(at, at + LEAK_WINDOW);
        if (!windows.has(window)) windows.set(window, blob.sha);
      }
    }
    const leaks = new Map<string, string>();
    const excused = new Set<string>();
    for (const hay of haystacks) {
      for (let at = 0; at + LEAK_WINDOW <= hay.text.length; at += 1) {
        const window = hay.text.slice(at, at + LEAK_WINDOW);
        const sha = windows.get(window);
        if (sha === undefined) continue;
        if (openCorpus.includes(window)) excused.add(`${sha.slice(0, 12)} ${hay.name}`);
        else if (!leaks.has(`${sha.slice(0, 12)} ${hay.name}`)) leaks.set(`${sha.slice(0, 12)} ${hay.name}`, JSON.stringify(window));
      }
    }
    return { leaks: [...leaks].map(([pair, first]) => `${pair}: ${first}`).sort(), excused: [...excused].sort() };
  };

  /** One sealed file through the owner-only audited read door, as bytes. */
  const sealedRead = async (token: string, projectId: string, versionId: string, phaseKey: string, query: Record<string, string>) => {
    const answer = await request(http)
      .get(`${versionBase(projectId, versionId)}/phases/${phaseKey}/tasks/${INHERITED_TASK_KEY}/sealed`)
      .query(query)
      .set(bearer(token))
      .set(from());
    expect({ status: answer.status, message: answer.status === 200 ? null : answer.body?.message }).toEqual({ status: 200, message: null });
    return Buffer.from(answer.body.contentBase64 as string, 'base64').toString('utf-8');
  };

  beforeAll(async () => {
    // Test-only: read the client address from X-Forwarded-For (see `from`).
    // One listening server on loopback, an ephemeral port, closed by app.close.
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], trustProxy: true, listen: true }));
    db = app.get(DataSource);

    owner = await account('export-owner', 'INSTRUCTOR');
    other = await account('export-other', 'INSTRUCTOR');
    copier = await account('export-copier', 'INSTRUCTOR');
    learner = await account('export-learner');
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  /* ------------------------- (a) the semantic round trip ------------------------- */

  let shelf = { projectId: '', versionId: '', slug: '' };

  it('(a) the Shelf pack, edited through the task door and the sealed door, exported and uploaded again: same task list, run shapes and sealed bytes', async () => {
    shelf = await uploaded(owner.token, zipDirectory(SHELF_DIR), `Shelf export ${stamp}`);
    const base = versionBase(shelf.projectId, shelf.versionId);

    // A written task, edited through the task door: its brief.
    const brief = '## Your stories\n\nWrite the shelf as user stories, each naming the reader who asks for it. EXP2-BRIEF-3HT';
    const edited = await request(http).patch(`${base}/phases/requirements/tasks/${INHERITED_TASK_KEY}`).set(bearer(owner.token)).set(from()).send({ brief });
    expect({ status: edited.status, message: edited.status === 200 ? null : edited.body?.message }).toEqual({ status: 200, message: null });

    // A sealed hidden test, written through the sealed door into run `api`.
    const hiddenAt = 'tests/test_exp2_round_trip.py';
    const hidden = 'import unittest\n\n\nclass RoundTrip(unittest.TestCase):\n    def test_round_trip(self):\n        self.assertTrue("EXP2-SEALED-ROUND-TRIP-9PM")\n';
    const wrote = await request(http)
      .put(`${base}/phases/implementation/tasks/${INHERITED_TASK_KEY}/sealed`)
      .set(bearer(owner.token))
      .set(from())
      .send({ role: 'hidden', runId: 'api', path: hiddenAt, contentBase64: Buffer.from(hidden).toString('base64') });
    expect({ status: wrote.status, message: wrote.status === 200 ? null : wrote.body?.message }).toEqual({ status: 200, message: null });

    const before = (await exportedRows(shelf.projectId)).length;
    const out = await exportOf(owner.token, shelf.projectId, shelf.versionId);
    expect({ status: out.status, message: out.status === 200 ? null : JSON.parse((out.body as Buffer).toString('utf-8')).message }).toEqual({ status: 200, message: null });
    expect(out.headers['x-export-withheld']).toBe('0');
    expect((await exportedRows(shelf.projectId)).length).toBe(before + 1);
    const archive = out.body as Buffer;
    const names = entriesOf(archive).map((entry) => entry.name);
    expect(names).toContain(`${shelf.slug}/phases/03-implementation/hidden_tests/api/${hiddenAt}`);

    // Uploaded again, under a new title, through the same door.
    const again = await uploaded(owner.token, archive, `Shelf export again ${stamp}`);
    const held = await snapshotOf(shelf.versionId);
    const back = await snapshotOf(again.versionId);
    expect(taskListOf(back)).toEqual(taskListOf(held));
    expect(runShapesOf(back)).toEqual(runShapesOf(held));
    expect(sealedPlacesOf(back)).toEqual(sealedPlacesOf(held));
    expect(await sealedDigestsOf(again.versionId)).toEqual(await sealedDigestsOf(shelf.versionId));
    // the edit and the new sealed file came back
    expect(back.content.phases.find((phase) => phase.key === 'requirements')!.taskPanel).toContain('EXP2-BRIEF-3HT');
    const api = (back.content.phases.find((phase) => phase.key === 'implementation')!.checks as { runs: PhaseRun[] }).runs.find((run) => run.id === 'api')!;
    expect(api.hiddenTestFiles[hiddenAt]).toBe(hidden);

    // The sealed bytes through the owner-only audited read door, both versions.
    const reads: [string, Record<string, string>][] = [
      ['implementation', { role: 'hidden', path: hiddenAt, runId: 'api' }],
      ['implementation', { role: 'solution', path: 'api/shelf.py' }],
      ['testing', { role: 'hidden', path: 'tests/test_acceptance.py' }],
      ['maintenance', { role: 'solution', path: 'web/src/lib/shelf.ts' }],
    ];
    for (const [phaseKey, query] of reads) {
      const one = await sealedRead(owner.token, shelf.projectId, shelf.versionId, phaseKey, query);
      const two = await sealedRead(owner.token, again.projectId, again.versionId, phaseKey, query);
      expect(`${phaseKey} ${query.path}: ${blobShaFor(two)}`).toBe(`${phaseKey} ${query.path}: ${blobShaFor(one)}`);
    }
  }, 120000);

  /* ----------------- (b) a whole TaskTrackr-free project with a preview ----------------- */

  it('(b) a TaskTrackr-free teacher project with a preview block round-trips the same way, and no TaskTrackr name, path or fact is in it', async () => {
    const made = await uploaded(owner.token, zipDirectory(SHELF_PREVIEW_DIR), `Shelf preview export ${stamp}`);
    const held = await snapshotOf(made.versionId);
    expect(held.content.preview).toBeTruthy();

    const out = await exportOf(owner.token, made.projectId, made.versionId);
    expect({ status: out.status, message: out.status === 200 ? null : JSON.parse((out.body as Buffer).toString('utf-8')).message }).toEqual({ status: 200, message: null });
    expect(out.headers['x-export-withheld']).toBe('0');
    const archive = out.body as Buffer;
    const text = `${archive.toString('utf-8')}\n${archive.toString('latin1')}`;
    expect(TASKTRACKR_SENTINELS.filter((sentinel) => text.includes(sentinel))).toEqual([]);

    const again = await uploaded(owner.token, archive, `Shelf preview export again ${stamp}`);
    const back = await snapshotOf(again.versionId);
    expect(back.content.preview).toEqual(held.content.preview);
    expect(taskListOf(back)).toEqual(taskListOf(held));
    expect(runShapesOf(back)).toEqual(runShapesOf(held));
    expect(sealedPlacesOf(back)).toEqual(sealedPlacesOf(held));
    expect(await sealedDigestsOf(again.versionId)).toEqual(await sealedDigestsOf(made.versionId));
    const backText = JSON.stringify(back);
    expect(TASKTRACKR_SENTINELS.filter((sentinel) => backText.includes(sentinel))).toEqual([]);
  }, 120000);

  /* --------------------------- (c) a copy withholds --------------------------- */

  it('(c) a copy of the platform project withholds every inherited sealed file: the header is the count, no entry is an inherited blob, one audit row', async () => {
    const library = (await request(http).get('/api/v1/instructor/projects').set(bearer(copier.token)).set(from()).expect(200)).body as AuthoringLibraryView;
    const platform = library.library.find((one) => one.isDefault)!;
    expect(platform.platformOwned).toBe(true);
    const made = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(copier.token))
      .set(from())
      .send({ title: `Copied for export ${stamp}`, slug: `copied-for-export-${stamp}`, fromVersionId: platform.publishedVersionId });
    expect({ status: made.status, message: made.status === 201 ? null : made.body?.message }).toEqual({ status: 201, message: null });
    const copy = { projectId: made.body.project.id as string, versionId: made.body.draftVersionId as string };

    const exporter = app.get(ExportService);
    const spy = jest.spyOn(exporter, 'export');
    let out;
    let result: ExportResult;
    try {
      out = await exportOf(copier.token, copy.projectId, copy.versionId);
      expect(spy).toHaveBeenCalledTimes(1);
      // the ExportResult the door answered from (read before the spy is restored)
      result = (await spy.mock.results[0].value) as ExportResult;
    } finally {
      spy.mockRestore();
    }
    expect({ status: out.status, message: out.status === 200 ? null : JSON.parse((out.body as Buffer).toString('utf-8')).message }).toEqual({ status: 200, message: null });
    expect(result.withheld.length).toBeGreaterThan(0);
    expect(out.headers['x-export-withheld']).toBe(String(result.withheld.length));
    expect(await exportedRows(copy.projectId)).toHaveLength(1);

    // The inherited sealed blobs: every sealed row of the copy whose bytes no open file holds.
    const rows = await db.manager.find(ProjectFileEntity, { where: { projectVersionId: copy.versionId } });
    const open = new Set(rows.filter((row) => row.role === 'workspace' || row.role === 'warmup').map((row) => row.blobSha));
    const sealedShas = [...new Set(rows.filter((row) => SEALED_FILE_ROLES.includes(row.role) && !open.has(row.blobSha)).map((row) => row.blobSha))];
    expect(sealedShas.length).toBeGreaterThan(0);
    const blobs = await db.manager.find(ContentBlobEntity, { where: { sha: In(sealedShas) } });
    expect(blobs).toHaveLength(sealedShas.length);
    const archive = out.body as Buffer;
    const entries = entriesOf(archive);
    // no entry is one of them, at any size (by sha256 set) ...
    const entryShas = new Set(entries.map((entry) => blobShaFor(entry.bytes.toString('utf-8'))));
    expect(blobs.filter((blob) => entryShas.has(blob.sha)).map((blob) => blob.sha)).toEqual([]);
    // ... and none of 48 bytes or more is held inside any entry or anywhere in the archive
    for (const blob of blobs.filter((one) => one.size >= 48)) {
      const needle = Buffer.from(blob.bytes, 'utf-8');
      expect(archive.includes(needle)).toBe(false);
      for (const entry of entries) expect(entry.bytes.includes(needle)).toBe(false);
    }
    // and no withheld path is an entry
    const names = new Set(entries.map((entry) => entry.name.slice(entry.name.indexOf('/') + 1)));
    for (const view of result.withheld) expect(names.has(view.path)).toBe(false);

    // The window rule: no entry holds any 48-byte window of
    // an inherited sealed blob, a JSON entry's strings read as text too. A
    // window the copy already shows in the open (an open file, or the
    // learner-facing text of its compiled content: a sealed comment that
    // repeats an objective or a hint) is no leak, and is left out by name.
    const openCorpus = await openCorpusOf(copy.versionId, rows, blobs);
    const haystacks = entries.flatMap((entry) => haystacksOf(entry));
    const found = windowLeaks(blobs, haystacks, openCorpus);
    expect(found.leaks).toEqual([]);
    // the rule is live: a window planted in a haystack is found
    const planted = blobs.find((one) => one.size >= 96)!;
    const plantedAt = latin1Of(planted.bytes).slice(40, 40 + LEAK_WINDOW);
    expect(windowLeaks([planted], [{ name: 'planted', text: `x${plantedAt}y` }], '').leaks).toHaveLength(1);
  }, 120000);

  /* ------------- (f) a refusal crosses the wire as the API's own JSON ------------- */

  it("(f) a 409 refusal of an edit the layout cannot carry is the API's JSON sentence (the read-back's taskDrift), with no archive headers and no audit row", async () => {
    const made = await uploaded(owner.token, zipDirectory(SHELF_DIR), `Shelf refused export ${stamp}`);
    // An edit the archive layout cannot carry that leaves the draft valid (so it
    // is compiled): what the task hands in, stored as an older editor could
    // leave it (no editor save moves a story task's type any more). (A task made
    // optional is not one: its phase then fails validation, so the draft is not
    // compiled and the export is of the last compiled snapshot.)
    await storeTaskTypeEdit(db, made.versionId, 'requirements', 'document');
    const held = (await snapshotOf(made.versionId)).phases.find((phase) => phase.key === 'requirements')!.tasks;
    expect(held.map((task) => task.artefactType)).toEqual(['document']);
    const title = (await snapshotOf(made.versionId)).content.phases.find((phase) => phase.key === 'requirements')!.title;

    const out = await exportOf(owner.token, made.projectId, made.versionId);
    expect(out.status).toBe(409);
    expect(out.headers['content-type']).toMatch(/^application\/json/);
    const body = JSON.parse((out.body as Buffer).toString('utf-8')) as { statusCode: number; message: string };
    expect(body.statusCode).toBe(409);
    // what a task hands in is no member of the folder layout: the read-back compiles the phase to its own task
    expect(body.message).toBe(`${EXPORT_REFUSALS.unloadable} ${EXPORT_REFUSALS.taskDrift(title)}.`);
    expect(out.headers['x-export-withheld']).toBeUndefined();
    expect(out.headers['content-disposition']).toBeUndefined();
    expect(await exportedRows(made.projectId)).toHaveLength(0);
  }, 120000);

  /* -------- (g) a draft whose last edit failed validation -------- */

  /** The stored fast report of a version (what the editor drew after its last edit). */
  const storedReportOf = async (versionId: string) =>
    ((await db.manager.findOneByOrFail(ProjectVersionEntity, { id: versionId })).validation as unknown as {
      report: { publishable: boolean; blocking: string[]; checks: { id: string; status: string }[] };
    }).report;

  /** One phase.json of an archive, parsed. */
  const phaseJsonOf = (archive: Buffer, folder: string): Record<string, unknown> =>
    JSON.parse(entriesOf(archive).find((entry) => entry.name.endsWith(`/phases/${folder}/phase.json`))!.bytes.toString('utf-8'));

  it("a draft whose last edit failed validation is exported as the draft: the task made optional is refused by the read-back's drift, naming the phase (409), never dropped; undone, the retitle stored meanwhile is carried and the re-upload validates afresh", async () => {
    // A teacher of its own: the upload door's per-teacher rate limit is spent by (a), (b) and (f).
    const owner = await account('export-failing', 'INSTRUCTOR');
    const made = await uploaded(owner.token, zipDirectory(SHELF_DIR), `Shelf failing validation ${stamp}`);
    const base = versionBase(made.projectId, made.versionId);
    const ok = (answer: request.Response) => ({ status: answer.status, message: answer.status === 200 ? null : answer.body?.message });
    const designTitle = (await snapshotOf(made.versionId)).content.phases.find((phase) => phase.key === 'design')!.title;

    // The edit: Design's only task made optional, through the task door. The
    // door stores it; fast validation reports the defect, and the compile row
    // fails with it, so the stored task list stays the last one that compiled.
    const optional = await request(http).put(`${base}/phases/design/tasks/${INHERITED_TASK_KEY}/required`).set(bearer(owner.token)).set(from()).send({ required: false });
    expect(ok(optional)).toEqual({ status: 200, message: null });
    // The latest edit, stored while the draft still fails: a retitle the archive carries.
    const retitled = await request(http)
      .patch(`${base}/phases/implementation/tasks/${INHERITED_TASK_KEY}`)
      .set(bearer(owner.token))
      .set(from())
      .send({ title: 'EXP3 retitled while the draft fails' });
    expect(ok(retitled)).toEqual({ status: 200, message: null });
    const failing = await storedReportOf(made.versionId);
    expect(failing.publishable).toBe(false);
    expect(failing.blocking).toContain(`${designTitle} has no required task, so no learner could ever pass it. Mark at least one task required.`);
    expect(failing.checks.find((check) => check.id === 'version-compiles')?.status).toBe('failed');
    const stale = await snapshotOf(made.versionId);
    expect(stale.phases.find((phase) => phase.key === 'design')!.tasks.map((task) => task.required)).toEqual([true]);
    expect(stale.phases.find((phase) => phase.key === 'implementation')!.tasks.map((task) => task.title)).toEqual(['Implementation']);

    // Exported: the stored "optional" is a task the archive cannot carry, so a
    // 409 names it, never a 200 whose Design comes back required.
    const refused = await exportOf(owner.token, made.projectId, made.versionId);
    expect(refused.status).toBe(409);
    expect(refused.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse((refused.body as Buffer).toString('utf-8')).message).toBe(`${EXPORT_REFUSALS.unloadable} ${EXPORT_REFUSALS.taskDrift(designTitle)}.`);
    expect(refused.headers['x-export-withheld']).toBeUndefined();
    expect(refused.headers['content-disposition']).toBeUndefined();
    expect(await exportedRows(made.projectId)).toHaveLength(0);

    // Undone through the same door: the compile moves again and holds the retitle.
    const required = await request(http).put(`${base}/phases/design/tasks/${INHERITED_TASK_KEY}/required`).set(bearer(owner.token)).set(from()).send({ required: true });
    expect(ok(required)).toEqual({ status: 200, message: null });
    const out = await exportOf(owner.token, made.projectId, made.versionId);
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('application/zip');
    expect(phaseJsonOf(out.body as Buffer, '03-implementation').task).toEqual({ title: 'EXP3 retitled while the draft fails' });
    expect(phaseJsonOf(out.body as Buffer, '02-design').task).toBeUndefined();

    // The re-upload validates afresh: its own fast report, as the upload answers it.
    const again = await upload(owner.token, out.body as Buffer, `Shelf failing validation again ${stamp}`);
    expect({ status: again.status, publishable: again.body?.validation?.publishable, blocking: again.body?.validation?.blocking }).toEqual({
      status: 201,
      publishable: true,
      blocking: [],
    });
    expect(taskListOf(await snapshotOf(again.body.versionId))).toEqual(taskListOf(await snapshotOf(made.versionId)));
  }, 120000);

  it('a draft whose stored compile row failed, with only carried edits in its rows, exports 200 holding exactly what the rows say (never the stale task list), and its re-upload is validated afresh', async () => {
    const owner = await account('export-stale', 'INSTRUCTOR');
    const made = await uploaded(owner.token, zipDirectory(SHELF_DIR), `Shelf stale compile ${stamp}`);
    const base = versionBase(made.projectId, made.versionId);
    const clean = await snapshotOf(made.versionId);
    const retitled = await request(http)
      .patch(`${base}/phases/implementation/tasks/${INHERITED_TASK_KEY}`)
      .set(bearer(owner.token))
      .set(from())
      .send({ title: 'EXP3 the title the rows hold' });
    expect(retitled.status).toBe(200);
    // The state a failed compile leaves (AuthoringService.persist): the stored
    // compile row failed and the stored task list is the one before the edit.
    // Through the doors only an uncarriable edit fails the compile (above), so
    // this state is written here to pin what the export reads in it.
    const version = await db.manager.findOneByOrFail(ProjectVersionEntity, { id: made.versionId });
    const validation = JSON.parse(JSON.stringify(version.validation)) as { report: { publishable: boolean; checks: { id: string; status: string }[] } };
    validation.report.checks.find((check) => check.id === 'version-compiles')!.status = 'failed';
    validation.report.publishable = false;
    await db.manager.update(ProjectVersionEntity, { id: made.versionId }, { compiled: { ...version.compiled!, phases: clean.phases }, validation: validation as never });
    expect((await snapshotOf(made.versionId)).phases.find((phase) => phase.key === 'implementation')!.tasks[0].title).toBe('Implementation');

    const out = await exportOf(owner.token, made.projectId, made.versionId);
    expect({ status: out.status, message: out.status === 200 ? null : JSON.parse((out.body as Buffer).toString('utf-8')).message }).toEqual({ status: 200, message: null });
    expect(out.headers['content-type']).toBe('application/zip');
    expect(out.headers['x-export-withheld']).toBe('0');
    // Exactly what the rows say, phase by phase: the retitle in its block, every other phase untouched.
    for (const folder of ['01-requirements', '02-design', '04-testing', '05-deployment', '06-maintenance']) {
      expect({ folder, task: phaseJsonOf(out.body as Buffer, folder).task }).toEqual({ folder, task: undefined });
    }
    expect(phaseJsonOf(out.body as Buffer, '03-implementation').task).toEqual({ title: 'EXP3 the title the rows hold' });
    expect(await exportedRows(made.projectId)).toHaveLength(1);

    const again = await upload(owner.token, out.body as Buffer, `Shelf stale compile again ${stamp}`);
    expect({ status: again.status, publishable: again.body?.validation?.publishable }).toEqual({ status: 201, publishable: true });
    const back = await snapshotOf(again.body.versionId);
    expect(back.phases.find((phase) => phase.key === 'implementation')!.tasks.map((task) => task.title)).toEqual(['EXP3 the title the rows hold']);
  }, 120000);

  /* ----------------------- (d) who may not; (e) how it is sent ----------------------- */

  it('(d) another teacher is 404 with no audit row, and a learner is 403', async () => {
    const before = (await exportedRows(shelf.projectId)).length;
    const theirs = await exportOf(other.token, shelf.projectId, shelf.versionId);
    expect(theirs.status).toBe(404);
    expect(theirs.headers['content-type']).toMatch(/^application\/json/);
    const learners = await exportOf(learner.token, shelf.projectId, shelf.versionId);
    expect(learners.status).toBe(403);
    expect((await exportedRows(shelf.projectId)).length).toBe(before);
  });

  it('(e) the archive is application/zip, never cached, and named <slug>-<version>.zip', async () => {
    const out = await exportOf(owner.token, shelf.projectId, shelf.versionId);
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('application/zip');
    expect(out.headers['cache-control']).toBe('no-store');
    expect(out.headers['content-disposition']).toBe(`attachment; filename="${shelf.slug}-${DRAFT_FIRST_VERSION}.zip"`);
    expect(Number(out.headers['content-length'])).toBe((out.body as Buffer).length);
    expect((out.body as Buffer).subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
  });
});
