import * as fs from 'fs';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';
import { AUTHORING_ROUTES, AUTHORING_ROUTE_KEYS, PHASE_ORDER, SEALED_FILE_ROLES } from '@learnsdlc/shared';
import type { AuthoringRouteKey, PhaseKey } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { sealedFilesOf } from '../src/content/blob.store';
import type { CompiledSnapshot } from '../src/content/pack-compiler';
import { ProjectImporterService } from '../src/content/importer.service';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import {
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../src/content/project.entities';
import { SealedRoleService } from '../src/authoring/sealed-roles';
import { AuditEventEntity, PhaseStateEntity, UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { SHELF_MARKERS } from './fixtures/upload-packs/markers';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The export route as the shared contract names it, or undefined where the
 * export route is not mounted. The sealed-role checks hold either way:
 * mounted, the route is this path and its answers are held; unmounted, this
 * very URL is probed and answers 404 to every caller, the owner included.
 */
const EXPORT_ROUTE = (AUTHORING_ROUTES as unknown as Readonly<Record<string, { method: string; path: string } | undefined>>)['version.export'];
const EXPORT_PATH = '/instructor/projects/:projectId/versions/:versionId/export';
const EXPORT_CUT_PROBE = 'version.export (CUT-2: unmounted)';

/**
 * On the wired application: a task's hidden suite, its
 * reference solution and its mutants never ride in a payload.
 *
 * **The planted markers first.** Before anything goes through a sealed door,
 * markers are planted in an
 * in-spec phase on both sides of the surface and every GET a teacher or a
 * learner can reach is byte-grepped for them:
 *
 * - the **authoring** side: a teacher's copy of the platform project holds the
 *   markers as sealed file rows (through the importer's own `insertFiles`, so
 *   the importer's byte rules apply) and inside its tasks' compiled checks,
 *   which is where an executable task's sealed slice travels. Every authoring
 *   GET in `AUTHORING_ROUTES` is driven for the owner, an ADMIN and another
 *   teacher, for every phase.
 * - the **learner** side: the platform's published snapshot carries the same
 *   markers in its sealed fields (hidden suites, solution, solution snippets,
 *   reference suite and implementation, a mutant, a drill's faulted copy) and
 *   the registry is reloaded, so the snapshot every learner payload is built
 *   from holds them. Every learner GET is driven, on every phase, opened.
 *
 * The learner side is also held against TaskTrackr's **real** sealed bytes:
 * every line of a sealed file that no learner-visible part of the pack holds.
 *
 * The markers are the Shelf pack's (`SHELF_MARKERS`), planted here in an in-spec phase.
 */
const MARK = SHELF_MARKERS;
const MARKERS: string[] = Object.values(MARK);
/**
 * The positive control: planted in a **learner-visible** workspace file on
 * both sides, so a grep that finds it proves the payloads read are the ones
 * that carry file bytes: a grep that could not see bytes would pass for the
 * wrong reason.
 */
const CONTROL = 'SEAL-POSITIVE-CONTROL-7Q4V';

/** One line of the grep table: a route, a caller, what it answered and which markers it carried. */
interface RouteGrep {
  surface: 'authoring' | 'learner';
  route: string;
  caller: string;
  /** Which grep wrote the row: `u8` (before any store write), `store`, or the HTTP probe. */
  pass: string;
  status: number;
  leaked: string[];
  /** Whether the learner-visible control marker was in the answer. */
  control?: boolean;
  /** For the HTTP probe: whether the route was mounted. */
  mounted?: boolean;
  /** The answer's media type (an archive, or a refusal's JSON). */
  type?: string;
}

/**
 * The markers (or needles) a response carries, read from its raw bytes, its
 * JSON-escaped text, and the decoded text of every base64 run in it.
 *
 * Base64 is decoded rather than matched: a marker at an arbitrary offset in a
 * file does not appear as the base64 of the marker in the base64 of the file
 * (the alignment differs), so matching encodings would miss exactly the leak a
 * `contentBase64` field would carry. The owner-read case below is the positive
 * control for this arm.
 *
 * Bytes are read both as UTF-8 (what the routes send; some of TaskTrackr's
 * sealed lines carry an em dash) and as latin1 (no byte sequence is lost), and
 * a needle is also looked for with its non-ASCII characters `\u`-escaped.
 * Every grep asks supertest for
 * the body as raw bytes (`binary` below), so the latin1 arm reads what was sent.
 */
const bothWays = (bytes: Buffer): string => `${bytes.toString('utf-8')}\n${bytes.toString('latin1')}`;
const uEscaped = (text: string): string => text.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
function leakedIn(raw: Buffer | string, needles: string[]): string[] {
  const text = Buffer.isBuffer(raw) ? bothWays(raw) : raw;
  const decoded = (text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? [])
    .map((run) => bothWays(Buffer.from(run, 'base64')))
    .join('\n');
  return needles.filter((needle) => {
    const escaped = JSON.stringify(needle).slice(1, -1);
    const forms = [needle, escaped, uEscaped(escaped)];
    return forms.some((form) => text.includes(form) || decoded.includes(form));
  });
}

/** supertest's body as the raw bytes, whatever the content type (an archive, or a JSON answer). */
const binary = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('sealed roles, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  const table: RouteGrep[] = [];

  let owner = { id: '', token: '' };
  let admin = { id: '', token: '' };
  let other = { id: '', token: '' };
  let learner = { id: '', token: '' };
  let cohortId = '';
  let platformProjectId = '';
  let platformVersionId = '';
  let projectId = '';
  let draftVersionId = '';
  let learnerPhases: Record<string, string> = {};
  let realNeedles: string[] = [];

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@sealed-roles.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  /** Plant a marker file in each sealed field of one compiled phase and its tasks. */
  const plantInChecks = (checks: any, phaseKey: PhaseKey): any => {
    if (!checks || typeof checks !== 'object') return checks;
    const out = JSON.parse(JSON.stringify(checks));
    if (out.kind === 'code') {
      out.hiddenTestFiles = { ...out.hiddenTestFiles, 'tests/test_seal_marker.py': `# ${MARK.hidden} ${phaseKey}\n` };
      out.solutionFiles = { ...out.solutionFiles, 'api/seal_marker.py': `# ${MARK.solution} ${phaseKey}\n` };
      out.solutionSources = [...(out.solutionSources ?? []), `return 42  # ${MARK.solution}`];
      if (Array.isArray(out.runs) && out.runs[0]) {
        out.runs[0].hiddenTestFiles = { ...out.runs[0].hiddenTestFiles, 'tests/test_seal_marker.py': `# ${MARK.hidden}\n` };
      }
    }
    if (out.kind === 'tests') {
      out.referenceTestFiles = { ...out.referenceTestFiles, 'tests/test_seal_reference.py': `# ${MARK.reference}\n` };
      out.implFiles = { ...out.implFiles, 'api/seal_impl.py': `# ${MARK.impl}\n` };
      const run = Array.isArray(out.runs) && out.runs[0] ? out.runs[0].id : '';
      out.mutants = [
        ...(out.mutants ?? []),
        { name: 'seal_plant', description: 'A planted mutant.', run, files: { 'api/seal_impl.py': `# ${MARK.mutant}\n` } },
      ];
    }
    if (out.kind === 'config' && out.drill) {
      out.drill.faultedFiles = { ...out.drill.faultedFiles, 'deploy/seal_fault.txt': `${MARK.drill}\n` };
    }
    return out;
  };

  const plantInSnapshot = (snapshot: CompiledSnapshot): CompiledSnapshot => {
    const out = JSON.parse(JSON.stringify(snapshot)) as CompiledSnapshot;
    for (const phase of out.content.phases) {
      phase.checks = plantInChecks(phase.checks, phase.key);
      if (phase.key === 'implementation') {
        phase.files = [...phase.files, { path: 'notes/seal_control.md', content: `${CONTROL}\n`, editable: false, language: 'markdown' } as any];
      }
    }
    for (const phase of out.phases) {
      for (const task of phase.tasks) {
        if (task.checks) (task as any).checks = plantInChecks(task.checks, phase.key);
      }
    }
    return out;
  };

  /** The authoring half's plant: sealed rows through `insertFiles`, and the tasks' checks. */
  const plantInDraft = async (manager: EntityManager, versionId: string) => {
    const importer = app.get(ProjectImporterService);
    const phases = await manager.find(ProjectPhaseEntity, { where: { projectVersionId: versionId } });
    const byKey = new Map(phases.map((phase) => [phase.key, phase.id]));
    const row = (key: PhaseKey, path: string, role: any, bytes: string) => ({
      ownerKind: 'phase' as const, ownerId: byKey.get(key) as string, path, role, editable: false, language: null, bytes,
    });
    await importer.insertFiles(manager, versionId, [
      row('implementation', 'hidden/tests/test_seal_marker.py', 'hidden', `# ${MARK.hidden} rows\n`),
      row('implementation', 'solution/api/seal_marker.py', 'solution', `# ${MARK.solution} rows\n`),
      row('testing', 'reference/tests/test_seal_reference.py', 'reference', `# ${MARK.reference} rows\n`),
      row('testing', 'reference/api/seal_impl.py', 'reference', `# ${MARK.impl} rows\n`),
      row('testing', 'mutants/seal_plant/api/seal_impl.py', 'mutant', `# ${MARK.mutant} rows\n`),
      row('deployment', 'drill/deploy/seal_fault.txt', 'drill', `${MARK.drill} rows\n`),
      row('implementation', 'notes/seal_control.md', 'workspace', `${CONTROL} rows\n`),
    ]);
    for (const phase of phases) {
      const tasks = await manager.find(ProjectTaskEntity, { where: { projectPhaseId: phase.id } });
      for (const task of tasks) {
        await manager.update(ProjectTaskEntity, { id: task.id }, { checks: plantInChecks(task.checks, phase.key) as never });
      }
    }
  };

  beforeAll(async () => {
    // One listening server on loopback (an ephemeral port, closed by app.close
    // in afterAll): supertest reuses a listening server, so every request
    // shares one port instead of each binding its own, which keeps the run
    // from flaking on port churn.
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], listen: true }));
    db = app.get(DataSource);

    owner = await account('seal-owner', 'INSTRUCTOR');
    admin = await account('seal-admin', 'ADMIN');
    other = await account('seal-other', 'INSTRUCTOR');
    learner = await account('seal-learner');

    const made = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(owner.token))
      .send({ name: 'Sealed Thursday' })
      .expect(201);
    cohortId = made.body.id;

    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(owner.token)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    platformProjectId = platform.id;
    platformVersionId = platform.publishedVersionId;

    const copied = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(owner.token))
      .send({ title: 'Sealed Shelf', slug: `sealed-shelf-${stamp}`, fromVersionId: platformVersionId })
      .expect(201);
    projectId = copied.body.project.id;
    draftVersionId = copied.body.draftVersionId;

    // TaskTrackr's real needles, read before anything is planted: every line
    // of a sealed file that is long enough to be distinctive and that no
    // learner-visible part of the pack (files, briefs, lessons, warm-up)
    // holds. A solution line a later phase mounts locked is learner-visible by
    // design (the five dual-role shas), so it is not a needle.
    const shipped = (await db.manager.findOneByOrFail(ProjectVersionEntity, { id: platformVersionId }))
      .compiled as CompiledSnapshot;
    const visible = JSON.stringify({
      ...shipped.content,
      phases: shipped.content.phases.map(({ checks: _checks, ...rest }) => rest),
    });
    const needles = new Set<string>();
    for (const phase of shipped.content.phases) {
      const sealed = sealedFilesOf(phase);
      for (const role of SEALED_FILE_ROLES) {
        for (const bytes of Object.values(sealed[role] ?? {})) {
          for (const line of bytes.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length < 28) continue;
            if (visible.includes(JSON.stringify(trimmed).slice(1, -1))) continue;
            needles.add(trimmed);
          }
        }
      }
    }
    realNeedles = [...needles];

    // The authoring half's plant, in one transaction, then the owner validates
    // so the draft's stored snapshot and report are built from the planted rows.
    await db.transaction((manager) => plantInDraft(manager, draftVersionId));
    await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}/validate`)
      .set(bearer(owner.token))
      .send({});

    // The learner half's plant: the platform's published snapshot, reloaded.
    await db.manager.update(
      ProjectVersionEntity,
      { id: platformVersionId },
      { compiled: plantInSnapshot(shipped) as never },
    );
    await app.get(ProjectRegistryService).load();

    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(learner.token))
      .send({ projectSlug: (await db.manager.findOneByOrFail(ProjectEntity, { id: platformProjectId })).slug })
      .expect(201);
    learnerPhases = Object.fromEntries(enrolled.body.phases.map((one: any) => [one.key, one.id]));
    // Every phase open, so every room's payload is built.
    for (const id of Object.values(learnerPhases)) {
      await db.manager.update(PhaseStateEntity, { id }, { status: 'in_progress', attempts: 1 });
    }
  });

  afterAll(async () => {
    if (process.env.SEALED_ROLES_RECORD_OUT) fs.writeFileSync(process.env.SEALED_ROLES_RECORD_OUT, JSON.stringify(table, null, 1), { mode: 0o600 });
    await app?.close();
  });

  /* ------------------------------ the greps ------------------------------ */

  /**
   * Every authoring GET in `AUTHORING_ROUTES`, for the owner, an ADMIN and
   * another teacher, on every phase a route takes, plus the audit console the
   * writes and reads below leave rows in. `sealed.read` and `version.export`
   * are the owner's audited reads by design, so only their owner answer
   * is skipped.
   */
  const grepAuthoring = async (pass: string, needles: string[]): Promise<RouteGrep[]> => {
    const rows: RouteGrep[] = [];
    const callers = { owner, admin, other };
    const ownerReads: AuthoringRouteKey[] = ['sealed.read' as AuthoringRouteKey, 'version.export' as AuthoringRouteKey];
    const paths: { key: string; path: string; skipOwner: boolean }[] = [];
    for (const key of AUTHORING_ROUTE_KEYS) {
      const route = AUTHORING_ROUTES[key];
      if (route.method !== 'GET') continue;
      const phases: PhaseKey[] = route.path.includes(':phaseKey') ? [...PHASE_ORDER] : ['implementation'];
      for (const phaseKey of phases) {
        const path = route.path
          .replace(':projectId', projectId)
          .replace(':versionId', draftVersionId)
          .replace(':phaseKey', phaseKey)
          .replace(':taskKey', 'main')
          .replace(':cohortId', cohortId);
        paths.push({ key: `${key} ${phaseKey}`, path, skipOwner: ownerReads.includes(key) });
      }
    }
    paths.push({ key: 'instructor.audit', path: '/instructor/audit', skipOwner: false });
    // Export route unmounted: the export URL, probed for every caller.
    if (!EXPORT_ROUTE) {
      paths.push({ key: EXPORT_CUT_PROBE, path: EXPORT_PATH.replace(':projectId', projectId).replace(':versionId', draftVersionId), skipOwner: false });
    }
    for (const { key, path, skipOwner } of paths) {
      for (const [name, who] of Object.entries(callers)) {
        if (name === 'owner' && skipOwner) continue;
        const answer = await request(http).get(`/api/v1${path}`).set(bearer(who.token)).buffer(true).parse(binary as never);
        const raw = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.text ?? '', 'utf-8');
        rows.push({
          surface: 'authoring', pass, route: key, caller: name, status: answer.status,
          leaked: leakedIn(raw, needles), control: leakedIn(raw, [CONTROL]).length > 0,
          type: String(answer.headers['content-type'] ?? '').split(';')[0],
        });
      }
    }
    table.push(...rows);
    return rows;
  };

  /** Every learner GET, on every phase, opened. */
  const grepLearner = async (pass: string, needles: string[]): Promise<RouteGrep[]> => {
    const rows: RouteGrep[] = [];
    const slug = (await db.manager.findOneByOrFail(ProjectEntity, { id: platformProjectId })).slug;
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
        '/tasks/main/submissions',
        '/tasks/main/reset',
        '/tasks/main/quiz',
        '/solution',
        '/tasks/main/solution',
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
    for (const route of routes) {
      const answer = await request(http).get(`/api/v1${route}`).set(bearer(learner.token)).buffer(true).parse(binary as never);
      const raw = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.text ?? '', 'utf-8');
      rows.push({
        surface: 'learner',
        pass,
        route: route.replace(/[0-9a-f-]{36}/, (id) => keyOf[id] ?? ':id'),
        caller: 'learner',
        status: answer.status,
        leaked: [...leakedIn(raw, needles), ...leakedIn(raw, realNeedles).map((one) => `real:${one.slice(0, 32)}`)],
        control: leakedIn(raw, [CONTROL]).length > 0,
      });
    }
    table.push(...rows);
    return rows;
  };

  /** A grep that read real payloads: the answers that must be 200 were, and the control was seen. */
  const expectReadBytes = (authoring: RouteGrep[], learnerRows: RouteGrep[]) => {
    const at = (route: string, caller: string) => authoring.find((one) => one.route === route && one.caller === caller);
    expect(at('version.draft implementation', 'owner')?.status).toBe(200);
    expect(at('files.list implementation', 'owner')?.status).toBe(200);
    expect(at('files.list implementation', 'owner')?.control).toBe(true);
    for (const key of Object.keys(learnerPhases)) {
      expect(learnerRows.find((one) => one.route === `/phases/${key}`)?.status).toBe(200);
    }
    expect(learnerRows.find((one) => one.route === '/phases/implementation')?.control).toBe(true);
    // The export's non-owner answers are refusals, not archives (the owner's is its audited read, skipped).
    const exported = authoring.filter((one) => one.route === 'version.export implementation').map((one) => [one.caller, one.status, one.type]);
    const probed = authoring.filter((one) => one.route === EXPORT_CUT_PROBE).map((one) => [one.caller, one.status]);
    if (EXPORT_ROUTE) {
      expect(EXPORT_ROUTE.path).toBe(EXPORT_PATH);
      expect(exported).toEqual([
        ['admin', 403, 'application/json'],
        ['other', 404, 'application/json'],
      ]);
      expect(probed).toEqual([]);
    } else {
      // Export route unmounted: no export row in the table, and the URL is no route for anyone.
      expect(exported).toEqual([]);
      expect(probed).toEqual([
        ['owner', 404],
        ['admin', 404],
        ['other', 404],
      ]);
    }
  };

  /* -------------------------- the planted markers -------------------------- */

  it('the plant is real (the markers are in the rows, the checks and the served snapshot)', async () => {
    const draft = await db.manager.findOneByOrFail(ProjectVersionEntity, { id: draftVersionId });
    const tasks = await db.manager.find(ProjectTaskEntity, {});
    expect(leakedIn(JSON.stringify(tasks.map((one) => one.checks)), MARKERS).sort()).toEqual([...MARKERS].sort());
    expect(draft.status).toBe('draft');
    const served = await db.manager.findOneByOrFail(ProjectVersionEntity, { id: platformVersionId });
    expect(leakedIn(JSON.stringify(served.compiled), MARKERS).sort()).toEqual([...MARKERS].sort());
    expect(realNeedles.length).toBeGreaterThan(0);
    // The reader reads what a route sends:
    // every needle, served as UTF-8 JSON bytes (raw, \u-escaped, and as
    // base64), is found. Some needles carry non-ASCII text, so a reader that
    // decodes bytes as latin1 alone would never match them.
    const all = [...MARKERS, ...STORE_MARKERS, ...realNeedles];
    expect(all.filter((one) => /[^\x00-\x7f]/.test(one)).length).toBeGreaterThan(0);
    const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const unread = all.filter((one) =>
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
  });

  it('no authoring GET carries a sealed marker, for the owner, an ADMIN or another teacher, on any phase', async () => {
    const authoring = await grepAuthoring('u8', MARKERS);
    expect(authoring.length).toBeGreaterThan(0);
    expect(authoring.filter((one) => one.leaked.length > 0)).toEqual([]);
  });

  it("no learner GET carries a sealed marker or a line of TaskTrackr's sealed files, on any phase", async () => {
    const learnerRows = await grepLearner('u8', MARKERS);
    expectReadBytes(table.filter((one) => one.pass === 'u8' && one.surface === 'authoring'), learnerRows);
    expect(learnerRows.filter((one) => one.leaked.length > 0)).toEqual([]);
  });

  /* ------------------------------ the store ------------------------------- */

  /** Written through the store, each with a marker of its own so a grep cannot credit the planted markers. */
  const STORE = {
    hidden: 'SEAL-STORE-HIDDEN-3W9P',
    solution: 'SEAL-STORE-SOLUTION-6H1C',
    reference: 'SEAL-STORE-REFERENCE-2D5M',
    mutant: 'SEAL-STORE-MUTANT-8K3T',
  } as const;
  const STORE_MARKERS: string[] = Object.values(STORE);
  const storeBytes = {
    hidden: `"""${STORE.hidden}"""\n\ndef test_store():\n    assert True\n`,
    solution: `# ${STORE.solution}\n\ndef shelved():\n    return 7\n`,
    reference: `"""${STORE.reference}"""\n\ndef test_reference():\n    assert True\n`,
    mutant: `# ${STORE.mutant}\n\ndef shelved():\n    return 8\n`,
  };

  /** `sealed.write` / `sealed.read` at the sealed door, for one phase's sole task. */
  const sealedPath = (key: 'sealed.write' | 'sealed.read', phaseKey: PhaseKey) =>
    `/api/v1${AUTHORING_ROUTES[key as AuthoringRouteKey].path
      .replace(':projectId', projectId)
      .replace(':versionId', draftVersionId)
      .replace(':phaseKey', phaseKey)
      .replace(':taskKey', 'main')}`;
  const putSealed = (token: string, phaseKey: PhaseKey, role: string, path: string, bytes: string, runId: string | null = null) =>
    request(http)
      .put(sealedPath('sealed.write', phaseKey))
      .set(bearer(token))
      .send({ role, runId, path, contentBase64: Buffer.from(bytes, 'utf-8').toString('base64') });

  it("a code task's hidden suite never appears in any authoring or learner payload (every route; byte grep on the markers)", async () => {
    // Through the route, so the controller's decodeSealedBase64 and the
    // validate that follows every write run before the grep.
    const written = [
      await putSealed(owner.token, 'implementation', 'hidden', 'tests/test_store.py', storeBytes.hidden),
      await putSealed(owner.token, 'implementation', 'solution', 'api/routes/tasks.py', storeBytes.solution),
      await putSealed(owner.token, 'testing', 'hidden', 'tests/test_store_reference.py', storeBytes.reference),
      await putSealed(owner.token, 'testing', 'mutant', 'store_plant/api/store.py', storeBytes.mutant),
    ];
    expect(written.map((one) => one.status)).toEqual([200, 200, 200, 200]);
    const views = written.map((one) => one.body);
    // What the write answers is the view and only the view.
    for (const view of views) expect(Object.keys(view).sort()).toEqual(['bytes', 'path', 'sha256']);
    for (const answer of written) expect(leakedIn(answer.text ?? '', STORE_MARKERS)).toEqual([]);
    // The gate at the door: an ADMIN may not write, another teacher cannot see; neither stores a byte.
    const rowsBefore = await db.manager.count(ProjectFileEntity, { where: { projectVersionId: draftVersionId } });
    const adminWrite = await putSealed(admin.token, 'implementation', 'hidden', 'tests/test_admin.py', storeBytes.hidden);
    const otherWrite = await putSealed(other.token, 'implementation', 'hidden', 'tests/test_other.py', storeBytes.hidden);
    expect([adminWrite.status, otherWrite.status]).toEqual([403, 404]);
    for (const answer of [adminWrite, otherWrite]) expect(leakedIn(answer.text ?? '', STORE_MARKERS)).toEqual([]);
    expect(await db.manager.count(ProjectFileEntity, { where: { projectVersionId: draftVersionId } })).toBe(rowsBefore);
    // The controller re-validated after the writes: the stored compile carries the store's bytes,
    // so the grep below reads a draft built from them, not a stale one.
    const draft = await db.manager.findOneByOrFail(ProjectVersionEntity, { id: draftVersionId });
    expect(leakedIn(JSON.stringify(draft.compiled), [STORE.hidden, STORE.solution])).toEqual([STORE.hidden, STORE.solution]);
    // Stored: the rows exist under their roles (the grep below is not grepping nothing).
    const stored = await db.manager.find(ProjectFileEntity, { where: { projectVersionId: draftVersionId } });
    const roleOf = (path: string) => stored.find((one) => one.path === path)?.role;
    expect(roleOf('hidden/tests/test_store.py')).toBe('hidden');
    expect(roleOf('solution/api/routes/tasks.py')).toBe('solution');
    expect(roleOf('reference/tests/test_store_reference.py')).toBe('reference');
    expect(roleOf('mutants/store_plant/api/store.py')).toBe('mutant');

    const needles = [...MARKERS, ...STORE_MARKERS];
    const authoring = await grepAuthoring('store', needles);
    const learnerRows = await grepLearner('store', needles);
    expectReadBytes(authoring, learnerRows);
    // The audit console was read, and the store's rows are in it by path and size only.
    expect(authoring.find((one) => one.route === 'instructor.audit' && one.caller === 'owner')?.status).toBe(200);
    expect(authoring.filter((one) => one.leaked.length > 0)).toEqual([]);
    expect(learnerRows.filter((one) => one.leaked.length > 0)).toEqual([]);
  });

  it('the sealed read route is owner-only and audited', async () => {
    const seal = app.get(SealedRoleService);
    const rows = async () =>
      (await db.manager.find(AuditEventEntity, { where: { targetId: projectId } })).filter(
        (one) => one.event === 'project.sealed-read',
      );
    expect(await rows()).toHaveLength(0);

    // The owner reads the bytes back over the route, and the grep finds them
    // in that answer, which is the positive control for the base64 arm of
    // every grep above.
    const answered = await request(http)
      .get(sealedPath('sealed.read', 'implementation'))
      .query({ role: 'hidden', path: 'tests/test_store.py' })
      .set(bearer(owner.token));
    expect(answered.status).toBe(200);
    const read = answered.body;
    expect(read).toMatchObject({ role: 'hidden', runId: 'api', path: 'tests/test_store.py' });
    expect(Buffer.from(read.contentBase64, 'base64').toString('utf-8')).toBe(storeBytes.hidden);
    expect(leakedIn(answered.text ?? '', [STORE.hidden])).toEqual([STORE.hidden]);
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0].actorUserId).toBe(owner.id);
    expect(leakedIn(JSON.stringify(after[0]), STORE_MARKERS)).toEqual([]);

    // An ADMIN who can see the draft is refused; another teacher cannot see it.
    const refused = async (who: { id: string }, role: 'ADMIN' | 'INSTRUCTOR') => {
      try {
        await seal.readOwnerOnly({ id: who.id, role, cohort: 'default' } as never, projectId, draftVersionId, 'implementation', 'main', 'hidden', 'tests/test_store.py');
      } catch (error: any) {
        return error.getStatus?.() ?? -1;
      }
      return 200;
    };
    expect(await refused(admin, 'ADMIN')).toBe(403);
    expect(await refused(other, 'INSTRUCTOR')).toBe(404);
    // A mutant is never read back, the owner included.
    try {
      await seal.readOwnerOnly(owner as never, projectId, draftVersionId, 'testing', 'main', 'mutant', 'store_plant/api/store.py');
      throw new Error('a mutant was read back');
    } catch (error: any) {
      expect(error.getStatus?.()).toBe(403);
    }
    expect(await rows()).toHaveLength(1);

    // Over HTTP: the same answers at the door,
    // with and without a query, and no row.
    const query = { role: 'hidden', path: 'tests/test_store.py' };
    const probe = await request(http).get(sealedPath('sealed.read', 'implementation')).query(query).set(bearer(admin.token));
    const mounted = !/Cannot GET/.test(String(probe.body?.message ?? '') || String(probe.text ?? ''));
    table.push({ surface: 'authoring', pass: 'sealed.read-http', route: 'sealed.read', caller: 'admin', status: probe.status, leaked: leakedIn(probe.text ?? '', STORE_MARKERS), mounted });
    expect(mounted).toBe(true);
    expect(probe.status).toBe(403);
    for (const ask of [query, {}]) {
      const stranger = await request(http).get(sealedPath('sealed.read', 'implementation')).query(ask).set(bearer(other.token));
      expect(stranger.status).toBe(404);
      expect(leakedIn(stranger.text ?? '', STORE_MARKERS)).toEqual([]);
    }
    const bare = await request(http).get(sealedPath('sealed.read', 'implementation')).set(bearer(admin.token));
    expect(bare.status).toBe(403);
    expect(await rows()).toHaveLength(1);
    expect(leakedIn(probe.text ?? '', STORE_MARKERS)).toEqual([]);
  });
});
