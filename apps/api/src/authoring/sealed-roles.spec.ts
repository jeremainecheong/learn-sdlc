import { createHash } from 'crypto';
import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { draftOnlyRefusal, WORKSPACE_FORBIDDEN_BLOB_ROLES } from '@learnsdlc/shared';
import type { PhaseKey } from '@learnsdlc/shared';
import { sealedFilesOf } from '../content/blob.store';
import { ProjectImporterService } from '../content/importer.service';
import {
  ContentBlobEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectVersionEntity,
} from '../content/project.entities';
import { AuditEventEntity } from '../db/entities';
import {
  copyTaskTrackr,
  draftSnapshot,
  openForkWorld,
  S1_TEACHER,
  type Fork,
  type ForkWorld,
} from '../../test/tasktrackr-phase';
import { SHELF_MARKERS } from '../../test/fixtures/upload-packs/markers';
import {
  SEALED_READ_AUDIT_EVENT,
  SealedRoleService,
  decodeSealedBase64,
  sealedViewOf,
  stripSealed,
} from './sealed-roles';

/**
 * The write-only store for a task's hidden suite,
 * reference solution and mutants.
 *
 * The property under test is one sentence: a sealed file goes in through one
 * door and comes back out through one door, the owner's, with a row saying it
 * did. Everything else a caller can hold is `{ path, sha256, bytes }`.
 *
 * The markers are the shelf fixture's (`SHELF_MARKERS`), planted here in an in-spec phase.
 * `support` is this spec's own: the shelf fixture seals no support helper.
 */
const MARK = {
  ...SHELF_MARKERS,
  support: 'SHELF-SEALED-SUPPORT-IN-SPEC',
} as const;
/** A code task's solution is written at one of its editable targets (TaskTrackr's implementation phase). */
const OWN_SOLUTION_TARGET = 'web/src/lib/overdue.ts';
const MARKERS = Object.values(MARK);

const OWNER = S1_TEACHER;
const ADMIN = { id: 'admin-seal', role: 'ADMIN' as const, cohort: 'default' };
const OTHER_TEACHER = { id: 'teacher-seal-other', role: 'INSTRUCTOR' as const, cohort: 'default' };

const sha = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex');
const status = (error: unknown) => (error instanceof HttpException ? error.getStatus() : -1);
const caught = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

/** Every string reachable from a value, cycles included, so a byte grep cannot be fooled by JSON.stringify throwing. */
function stringsIn(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, member]) => [
    key,
    ...stringsIn(member, seen),
  ]);
}

describe('SealedRoleService', () => {
  let world: ForkWorld;
  let importer: ProjectImporterService;
  let seal: SealedRoleService;
  let fork: Fork;

  const hiddenSuite = `"""seal marker: ${MARK.hidden}"""\n\ndef test_marker():\n    assert True\n`;
  const solutionFile = `# seal marker: ${MARK.solution}\n\ndef answer():\n    return 42\n`;
  const mutantFile = `# seal marker: ${MARK.mutant}\n\ndef answer():\n    return 41\n`;

  const audits = async (event: string, targetId: string) =>
    (await world.dataSource.getRepository(AuditEventEntity).find({ where: { targetId } })).filter(
      (row) => row.event === event,
    );
  const phaseRow = async (versionId: string, key: PhaseKey) =>
    world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key });

  beforeAll(async () => {
    world = await openForkWorld();
    importer = new ProjectImporterService(world.content, world.dataSource);
    seal = new SealedRoleService(world.dataSource, importer);
    fork = await copyTaskTrackr(world, 'seal-owner');
  });

  afterAll(async () => {
    await world?.close();
  });

  it('› a write returns only {path, sha256, bytes}', async () => {
    const view = await seal.write(
      OWNER,
      fork.projectId,
      fork.versionId,
      'implementation',
      'main',
      'hidden',
      'tests/test_seal_marker.py',
      hiddenSuite,
    );
    expect(Object.keys(view).sort()).toEqual(['bytes', 'path', 'sha256']);
    expect(view).toEqual({
      path: 'tests/test_seal_marker.py',
      sha256: sha(hiddenSuite),
      bytes: Buffer.byteLength(hiddenSuite, 'utf-8'),
    });
    for (const marker of MARKERS) expect(JSON.stringify(view)).not.toContain(marker);

    // Stored through the blob store under the role's own directory, locked, as
    // the importer stores a pack's hidden suite.
    const implementation = await phaseRow(fork.versionId, 'implementation');
    const row = await world.dataSource.getRepository(ProjectFileEntity).findOneByOrFail({
      projectVersionId: fork.versionId,
      ownerId: implementation.id,
      path: 'hidden/tests/test_seal_marker.py',
    });
    expect(row).toMatchObject({ role: 'hidden', editable: false, ownerKind: 'phase', blobSha: sha(hiddenSuite) });
    const blob = await world.dataSource.getRepository(ContentBlobEntity).findOneByOrFail({ sha: row.blobSha });
    expect(blob.bytes).toBe(hiddenSuite);

    // The reference solution of the same code task, and a tests task's mutant.
    const solution = await seal.write(
      OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'solution', OWN_SOLUTION_TARGET, solutionFile,
    );
    expect(Object.keys(solution).sort()).toEqual(['bytes', 'path', 'sha256']);
    const mutant = await seal.write(
      OWNER, fork.projectId, fork.versionId, 'testing', 'main', 'mutant', 'seal_plant/api/seal_answer.py', mutantFile,
    );
    expect(mutant).toEqual({ path: 'seal_plant/api/seal_answer.py', sha256: sha(mutantFile), bytes: Buffer.byteLength(mutantFile) });
    const testing = await phaseRow(fork.versionId, 'testing');
    const mutantRow = await world.dataSource.getRepository(ProjectFileEntity).findOneByOrFail({
      projectVersionId: fork.versionId,
      ownerId: testing.id,
      path: 'mutants/seal_plant/api/seal_answer.py',
    });
    expect(mutantRow.role).toBe('mutant');

    // Written again at the same path: one row, the new bytes.
    const again = `${hiddenSuite}\n# second write\n`;
    const rewritten = await seal.write(
      OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_seal_marker.py', again,
    );
    expect(rewritten.sha256).toBe(sha(again));
    const rows = await world.dataSource.getRepository(ProjectFileEntity).find({
      where: { projectVersionId: fork.versionId, ownerId: implementation.id, path: 'hidden/tests/test_seal_marker.py' },
    });
    expect(rows.map((one) => one.blobSha)).toEqual([sha(again)]);
    await seal.write(
      OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_seal_marker.py', hiddenSuite,
    );
  });

  it('› a write refuses what the store cannot hold: a mutant on a code task, a written task, a climbing path, a non-owner', async () => {
    const before = await world.dataSource.getRepository(ProjectFileEntity).count({ where: { projectVersionId: fork.versionId } });
    const refusals = [
      // A code task has no mutants.
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'mutant', 'm/api/x.py', mutantFile),
      // A written phase's task has no sealed roles at all.
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'requirements', 'main', 'hidden', 'tests/test_x.py', hiddenSuite),
      // Paths stay inside the role's own directory.
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', '../workspace.py', hiddenSuite),
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', '/etc/passwd', hiddenSuite),
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests\\x.py', hiddenSuite),
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/.env', hiddenSuite),
      // A mutant names itself first.
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'testing', 'main', 'mutant', 'flat.py', mutantFile),
      // Empty, NUL-bearing and oversized bytes.
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_e.py', ''),
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_n.py', 'a\u0000b'),
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_b.py', 'x'.repeat(200001)),
      // An unknown role.
      () => seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'workspace' as never, 'api/x.py', solutionFile),
    ];
    // One at a time: the store is one connection, and each write is a transaction.
    for (const refusal of refusals) {
      const error = await caught(refusal());
      expect(status(error)).toBe(400);
      for (const marker of MARKERS) expect(String((error as Error).message)).not.toContain(marker);
    }

    // The owner gate, in `readQuizKey`'s shape: ADMIN may see and may not write; another teacher cannot see.
    expect(status(await caught(
      seal.write(ADMIN, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_a.py', hiddenSuite),
    ))).toBe(403);
    expect(status(await caught(
      seal.write(OTHER_TEACHER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_o.py', hiddenSuite),
    ))).toBe(404);
    // The platform's own project is never written in place.
    const platform = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: world.seedVersionId });
    expect(status(await caught(
      seal.write(OWNER, platform.projectId, world.seedVersionId, 'implementation', 'main', 'hidden', 'tests/test_p.py', hiddenSuite),
    ))).toBe(403);

    expect(await world.dataSource.getRepository(ProjectFileEntity).count({ where: { projectVersionId: fork.versionId } })).toBe(before);
  });

  it("› a write keeps decision 37's byte rules", async () => {
    const implementation = await phaseRow(fork.versionId, 'implementation');
    const files = world.dataSource.getRepository(ProjectFileEntity);
    const blobs = world.dataSource.getRepository(ContentBlobEntity);
    const editable = await files.findOneByOrFail({
      projectVersionId: fork.versionId, ownerId: implementation.id, role: 'workspace', editable: true, path: 'api/repository/tasks.py',
    });
    const locked = await files.findOneByOrFail({
      projectVersionId: fork.versionId, ownerId: implementation.id, role: 'workspace', editable: false,
    });
    const stub = (await blobs.findOneByOrFail({ sha: editable.blobSha })).bytes;
    const readable = (await blobs.findOneByOrFail({ sha: locked.blobSha })).bytes;

    // Rule 1: a hidden test whose bytes a learner already reads (locked or editable).
    expect(status(await caught(
      seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_dup.py', readable),
    ))).toBe(400);
    // Rule 2: an answer whose bytes sit in a file the learner is asked to write
    // (written at the editable target itself, so only the byte rule can refuse it).
    expect(status(await caught(
      seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'solution', editable.path, stub),
    ))).toBe(400);
  });

  it('› the owner-only read writes one audit row; ADMIN 403; another teacher 404 and no audit row', async () => {
    const before = await audits(SEALED_READ_AUDIT_EVENT, fork.projectId);
    expect(before).toHaveLength(0);

    const read = await seal.readOwnerOnly(
      OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_seal_marker.py',
    );
    expect(read).toEqual({
      role: 'hidden',
      // The run the overlay grades it in: a new Python test lands in the API run.
      runId: 'api',
      path: 'tests/test_seal_marker.py',
      sha256: sha(hiddenSuite),
      bytes: Buffer.byteLength(hiddenSuite, 'utf-8'),
      contentBase64: Buffer.from(hiddenSuite, 'utf-8').toString('base64'),
    });

    const rows = await audits(SEALED_READ_AUDIT_EVENT, fork.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: OWNER.id, subjectUserId: OWNER.id, action: 'implementation' });
    expect(rows[0].detail).toMatchObject({
      versionId: fork.versionId, phaseKey: 'implementation', taskKey: 'main', role: 'hidden',
      path: 'tests/test_seal_marker.py', bytes: Buffer.byteLength(hiddenSuite, 'utf-8'),
    });
    // The row says a sealed file was read, never what it holds or its digest.
    const detail = JSON.stringify(rows[0]);
    for (const marker of MARKERS) expect(detail).not.toContain(marker);
    expect(detail).not.toContain(sha(hiddenSuite));

    const admin = await caught(
      seal.readOwnerOnly(ADMIN, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_seal_marker.py'),
    );
    expect(admin).toBeInstanceOf(ForbiddenException);
    expect(status(admin)).toBe(403);
    const other = await caught(
      seal.readOwnerOnly(OTHER_TEACHER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_seal_marker.py'),
    );
    expect(other).toBeInstanceOf(NotFoundException);
    expect(status(other)).toBe(404);
    for (const error of [admin, other]) {
      for (const marker of MARKERS) expect(String((error as Error).message)).not.toContain(marker);
    }
    expect(await audits(SEALED_READ_AUDIT_EVENT, fork.projectId)).toHaveLength(1);

    // A mutant is written and never read back, the owner included:
    // refused, with no row.
    const mutant = await caught(
      seal.readOwnerOnly(OWNER, fork.projectId, fork.versionId, 'testing', 'main', 'mutant', 'seal_plant/api/seal_answer.py'),
    );
    expect(status(mutant)).toBe(403);
    expect(String((mutant as Error).message)).not.toContain(MARK.mutant);
    // A path the task does not hold is the owner's 404, and no row either.
    expect(status(await caught(
      seal.readOwnerOnly(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/nope.py'),
    ))).toBe(404);
    expect(await audits(SEALED_READ_AUDIT_EVENT, fork.projectId)).toHaveLength(1);
  });

  it('› stripSealed removes every sealed byte from a nested payload', async () => {
    const workspaceText = 'def visible():\n    return "a learner reads this"\n';
    const cycle: Record<string, unknown> = { note: 'loops back' };
    const payload: Record<string, unknown> = {
      id: 'v1',
      version: {
        compiled: {
          content: {
            phases: [
              {
                key: 'implementation',
                files: [{ path: 'api/visible.py', content: workspaceText, editable: true }],
                checks: {
                  kind: 'code',
                  editableTargets: ['api/visible.py'],
                  visibleTests: ['tests/test_visible.py'],
                  hiddenTestFiles: { 'tests/test_hidden.py': `# ${MARK.hidden}` },
                  solutionFiles: { 'api/visible.py': `# ${MARK.solution}` },
                  solutionSources: [`return 42  # ${MARK.solution}`],
                  runs: [
                    {
                      id: 'api',
                      hiddenTestFiles: { 'tests/test_hidden.py': `# ${MARK.hidden}` },
                      referenceTestFiles: {},
                      implFiles: {},
                      supportFiles: { 'tests/helper.py': `# ${MARK.support}` },
                    },
                  ],
                },
              },
              {
                key: 'testing',
                checks: {
                  kind: 'tests',
                  referenceTestFiles: { 'tests/test_ref.py': `# ${MARK.reference}` },
                  implFiles: { 'api/impl.py': `# ${MARK.impl}` },
                  mutants: [{ name: 'plant', description: 'off by one', run: 'api', files: { 'api/impl.py': `# ${MARK.mutant}` } }],
                },
              },
              {
                key: 'deployment',
                checks: {
                  kind: 'config',
                  smokeImplFiles: { 'api/main.py': `# ${MARK.impl}` },
                  drill: { faultedFiles: { 'Dockerfile': `# ${MARK.drill}` }, expectSmokeFailure: true },
                },
              },
            ],
          },
        },
      },
      files: [
        { path: 'hidden/tests/test_hidden.py', role: 'hidden', content: `# ${MARK.hidden}` },
        { path: 'solution/api/visible.py', role: 'solution', contentBase64: Buffer.from(`# ${MARK.solution}`).toString('base64') },
        { path: 'api/visible.py', role: 'workspace', content: workspaceText },
      ],
      cycle,
    };
    cycle.back = payload;
    const before = stringsIn(payload).join('\n');

    const stripped = stripSealed(payload);

    const after = stringsIn(stripped).join('\n');
    for (const marker of MARKERS) expect(after).not.toContain(marker);
    // The base64 of a sealed file is a sealed byte too.
    expect(after).not.toContain(Buffer.from(`# ${MARK.solution}`).toString('base64'));
    // What a learner may read is untouched.
    expect(after).toContain(workspaceText);
    // Each sealed map became views: the path, the digest and the size.
    const implementation = (stripped as any).version.compiled.content.phases[0].checks;
    expect(implementation.hiddenTestFiles).toEqual([sealedViewOf('tests/test_hidden.py', `# ${MARK.hidden}`)]);
    expect(implementation.runs[0].supportFiles).toEqual([sealedViewOf('tests/helper.py', `# ${MARK.support}`)]);
    const testing = (stripped as any).version.compiled.content.phases[1].checks;
    expect(testing.mutants[0].files).toEqual([sealedViewOf('api/impl.py', `# ${MARK.mutant}`)]);
    expect(testing.mutants[0].name).toBe('plant');
    expect((stripped as any).files[0]).toEqual(sealedViewOf('hidden/tests/test_hidden.py', `# ${MARK.hidden}`));
    expect((stripped as any).files[2]).toEqual({ path: 'api/visible.py', role: 'workspace', content: workspaceText });
    // Pure: the input is as it was, and the cycle survives as a cycle.
    expect(stringsIn(payload).join('\n')).toBe(before);
    expect((stripped as any).cycle.back).toBe(stripped);
  });

  it('› stripSealed fails closed on shapes it was not written against', () => {
    const payload = {
      files: [
        // A sealed record holding its bytes in a Buffer, and one holding them under a field nobody listed.
        { path: 'hidden/tests/test_buf.py', role: 'hidden', content: Buffer.from(`# ${MARK.hidden} buffer`) },
        { path: 'solution/api/x.py', role: 'solution', text: `# ${MARK.solution} text`, size: 12 },
      ],
      checks: {
        // A sealed map whose values are records, not strings.
        hiddenTestFiles: { 'tests/test_obj.py': { content: `# ${MARK.hidden} object` } },
        implFiles: { 'api/impl.py': Buffer.from(`# ${MARK.impl} map buffer`) },
      },
    };
    const stripped = stripSealed(payload) as any;
    const text = stringsIn(stripped).join('\n') + JSON.stringify(stripped);
    for (const marker of MARKERS) expect(text).not.toContain(marker);
    for (const marker of MARKERS) expect(text).not.toContain(Buffer.from(`# ${marker}`).toString('base64').slice(0, 12));
    expect(stripped.files[0]).toEqual(sealedViewOf('hidden/tests/test_buf.py', `# ${MARK.hidden} buffer`));
    expect(stripped.files[1]).toEqual({ path: 'solution/api/x.py', role: 'solution', size: 12 });
    expect(stripped.checks.hiddenTestFiles).toEqual([sealedViewOf('tests/test_obj.py', `# ${MARK.hidden} object`)]);
    expect(stripped.checks.implFiles).toEqual([sealedViewOf('api/impl.py', `# ${MARK.impl} map buffer`)]);
  });

  it("› stripSealed removes every hidden, mutant, drill and support byte from TaskTrackr's own compiled snapshot", async () => {
    const snapshot = await draftSnapshot(world, fork);
    // The needles: every sealed file a learner may never read, editable or
    // locked (rule 1's roles). `solution`/`reference` bytes are legitimately a
    // later phase's locked workspace (the five dual-role shas), so they are
    // not needles in a payload that also carries the workspace.
    // A support helper the pack also mounts, locked, in a learner's workspace
    // (TaskTrackr's conftest and clock fixtures) is learner-visible by design,
    // so it is held to the same filter the e2e uses: what no checks-free part
    // of the snapshot holds.
    const visible = JSON.stringify({
      ...snapshot.content,
      phases: snapshot.content.phases.map(({ checks: _checks, ...rest }) => rest),
    });
    const needles = new Set<string>();
    for (const phase of snapshot.content.phases) {
      const sealed = sealedFilesOf(phase);
      for (const role of WORKSPACE_FORBIDDEN_BLOB_ROLES) {
        for (const bytes of Object.values(sealed[role] ?? {})) {
          if (bytes.trim().length === 0 || visible.includes(JSON.stringify(bytes).slice(1, -1))) continue;
          needles.add(bytes);
        }
      }
    }
    expect(needles.size).toBeGreaterThan(0);
    const raw = JSON.stringify(snapshot);
    expect([...needles].some((needle) => raw.includes(JSON.stringify(needle).slice(1, -1)))).toBe(true);
    const stripped = JSON.stringify(stripSealed(snapshot));
    const leaked = [...needles].filter((needle) => stripped.includes(JSON.stringify(needle).slice(1, -1)));
    expect(leaked.map((one) => one.slice(0, 40))).toEqual([]);
  });

  it('› a published version refuses a sealed write', async () => {
    const shipped = await copyTaskTrackr(world, 'seal-published');
    // The teacher's own solution file, written while it was a draft. The bytes
    // are the shipped answer's own, so the phase is still the reference
    // application and this build publishes it (publish refuses any other executable
    // phase until it has a deep receipt); what the read asks is who wrote the
    // row, and here the owner did.
    const shippedPhase = await phaseRow(shipped.versionId, 'implementation');
    const shippedRow = await world.dataSource.getRepository(ProjectFileEntity).findOneByOrFail({
      projectVersionId: shipped.versionId, ownerId: shippedPhase.id, path: 'solution/api/routes/tasks.py',
    });
    const own = (await world.dataSource.getRepository(ContentBlobEntity).findOneByOrFail({ sha: shippedRow.blobSha })).bytes;
    expect(status(await caught(
      seal.readOwnerOnly(OWNER, shipped.projectId, shipped.versionId, 'implementation', 'main', 'solution', 'api/routes/tasks.py'),
    ))).toBe(403);
    await seal.write(OWNER, shipped.projectId, shipped.versionId, 'implementation', 'main', 'solution', 'api/routes/tasks.py', own);
    const published = await world.service.publish(OWNER, shipped.projectId, shipped.versionId, { version: '1.0.0' });
    const files = world.dataSource.getRepository(ProjectFileEntity);
    const before = await files.count({ where: { projectVersionId: published.versionId } });

    const refused = await caught(
      seal.write(OWNER, shipped.projectId, published.versionId, 'implementation', 'main', 'hidden', 'tests/test_late.py', hiddenSuite),
    );
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as Error).message).toBe(draftOnlyRefusal('1.0.0', 'published'));
    expect(await files.count({ where: { projectVersionId: published.versionId } })).toBe(before);

    // The owner may still read what they shipped (readQuizKey's rule), audited.
    const read = await seal.readOwnerOnly(OWNER, shipped.projectId, published.versionId, 'implementation', 'main', 'solution', 'api/routes/tasks.py');
    expect(Buffer.from(read.contentBase64, 'base64').toString('utf-8')).toBe(own);
    expect(await audits(SEALED_READ_AUDIT_EVENT, shipped.projectId)).toHaveLength(1);

    // The next draft opens from the published head: the owner's own answer is
    // still theirs (it was written in an ancestor of their own), and the
    // platform's inherited files are still sealed two copies down.
    const next = await world.service.createDraftVersion(OWNER, shipped.projectId, { fromVersionId: published.versionId } as never);
    const again = await seal.readOwnerOnly(OWNER, shipped.projectId, next.versionId, 'implementation', 'main', 'solution', 'api/routes/tasks.py');
    expect(Buffer.from(again.contentBase64, 'base64').toString('utf-8')).toBe(own);
    expect(status(await caught(
      seal.readOwnerOnly(OWNER, shipped.projectId, next.versionId, 'implementation', 'main', 'solution', 'api/repository/tasks.py'),
    ))).toBe(403);
  });

  it("› the owner's read never reveals a sealed file the copy inherited (the platform's hidden suite and solution stay sealed)", async () => {
    const implementation = await phaseRow(fork.versionId, 'implementation');
    const files = world.dataSource.getRepository(ProjectFileEntity);
    const before = (await audits(SEALED_READ_AUDIT_EVENT, fork.projectId)).length;
    for (const [role, kind] of [['hidden', 'hidden'], ['solution', 'solution']] as const) {
      const inherited = (await files.find({ where: { projectVersionId: fork.versionId, ownerId: implementation.id, role } }))
        .filter((row) => !row.path.includes('seal_') && !row.path.includes('test_seal_marker') && row.path !== `solution/${OWN_SOLUTION_TARGET}`);
      expect(inherited.length).toBeGreaterThan(0);
      for (const row of inherited) {
        const refused = await caught(
          seal.readOwnerOnly(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', kind, row.path.replace(/^(hidden|solution)\//, '')),
        );
        expect(refused).toBeInstanceOf(ForbiddenException);
        expect(status(refused)).toBe(403);
      }
    }
    expect(await audits(SEALED_READ_AUDIT_EVENT, fork.projectId)).toHaveLength(before);
  });

  /* ------------- the declared role and run survive the door ------------- */

  it("› a tests task keeps the role the teacher declared: suite or implementation by the overlay's own rule, never both at one path", async () => {
    const roles = await copyTaskTrackr(world, 'seal-roles');
    const files = world.dataSource.getRepository(ProjectFileEntity);
    const testing = await phaseRow(roles.versionId, 'testing');
    const count = () => files.count({ where: { projectVersionId: roles.versionId, ownerId: testing.id } });
    const write = (role: 'hidden' | 'solution', path: string, bytes: string, runId?: string | null) =>
      seal.write(OWNER, roles.projectId, roles.versionId, 'testing', 'main', role, path, bytes, runId);
    const suite = `"""${MARK.reference}"""\n\ndef test_probe():\n    assert True\n`;
    const impl = `# ${MARK.impl}\n\ndef helper():\n    return 1\n`;
    const before = await count();

    // A suite file whose name the overlay would read as implementation, and the reverse.
    expect(status(await caught(write('hidden', 'tests/suite_probe.py', suite)))).toBe(400);
    expect(status(await caught(write('solution', 'api/test_helpers_probe.py', impl)))).toBe(400);
    // A path the suite already holds is never the implementation, and the reverse (409: a role never changes).
    expect(status(await caught(write('solution', 'tests/test_acceptance.py', impl)))).toBe(409);
    expect(status(await caught(write('hidden', 'api/repository/tasks.py', suite)))).toBe(409);
    expect(await count()).toBe(before);

    // A write that agrees lands; the same path under the other role is refused, and the suite's bytes stay.
    await write('hidden', 'tests/test_seal_probe.py', suite);
    expect(status(await caught(write('solution', 'tests/test_seal_probe.py', impl)))).toBe(409);
    const held = await files.findOneByOrFail({ projectVersionId: roles.versionId, ownerId: testing.id, path: 'reference/tests/test_seal_probe.py' });
    expect(held.blobSha).toBe(sha(suite));
    // Read back under the role it was written as, never the other.
    const read = await seal.readOwnerOnly(OWNER, roles.projectId, roles.versionId, 'testing', 'main', 'hidden', 'tests/test_seal_probe.py');
    expect(read).toMatchObject({ role: 'hidden', runId: 'api', sha256: sha(suite) });
    expect(status(await caught(
      seal.readOwnerOnly(OWNER, roles.projectId, roles.versionId, 'testing', 'main', 'solution', 'tests/test_seal_probe.py'),
    ))).toBe(404);

    // The run is the one the overlay grades the file in, or the write is refused.
    const second = `"""${MARK.reference} two"""\n\ndef test_two():\n    assert True\n`;
    expect(status(await caught(write('hidden', 'tests/test_seal_run.py', second, 'web')))).toBe(400);
    expect(status(await caught(write('hidden', 'tests/test_seal_run.py', second, 'nope')))).toBe(400);
    expect(status(await caught(write('solution', 'api/repository/tasks.py', impl, 'web')))).toBe(400);
    const counted = await count();
    await write('hidden', 'tests/test_seal_run.py', second, 'api');
    await write('solution', 'api/repository/tasks.py', impl, 'api');
    expect(await count()).toBe(counted + 1);
    expect(status(await caught(
      seal.readOwnerOnly(OWNER, roles.projectId, roles.versionId, 'testing', 'main', 'hidden', 'tests/test_seal_run.py', 'web'),
    ))).toBe(404);
    expect(
      (await seal.readOwnerOnly(OWNER, roles.projectId, roles.versionId, 'testing', 'main', 'solution', 'api/repository/tasks.py', 'api')).runId,
    ).toBe('api');
  });

  it("› a code task's solution is one of its editable targets, its hidden suite is never a file the phase mounts, and its run is the overlay's", async () => {
    const code = await copyTaskTrackr(world, 'seal-code');
    const files = world.dataSource.getRepository(ProjectFileEntity);
    const implementation = await phaseRow(code.versionId, 'implementation');
    const count = () => files.count({ where: { projectVersionId: code.versionId, ownerId: implementation.id } });
    const write = (role: 'hidden' | 'solution', path: string, bytes: string, runId?: string | null) =>
      seal.write(OWNER, code.projectId, code.versionId, 'implementation', 'main', role, path, bytes, runId);
    const before = await count();

    // A solution at a path that is no editable target completes no stub: the
    // overlay would ignore it while the write said 200.
    expect(status(await caught(write('solution', 'api/seal_answer.py', solutionFile)))).toBe(400);
    // A code task's solution belongs to no run.
    expect(status(await caught(write('solution', 'api/repository/tasks.py', solutionFile, 'api')))).toBe(400);
    // A hidden file at a path the phase mounts would replace the learner's file in the graded run.
    expect(status(await caught(write('hidden', 'tests/test_tasks_api.py', hiddenSuite)))).toBe(400);
    expect(status(await caught(write('hidden', 'tests/conftest.py', hiddenSuite)))).toBe(400);
    expect(status(await caught(write('hidden', 'api/repository/tasks.py', hiddenSuite)))).toBe(400);
    // The run: the overlay's, or refused.
    expect(status(await caught(write('hidden', 'tests/test_seal_run.py', hiddenSuite, 'web')))).toBe(400);
    expect(status(await caught(write('hidden', 'tests/test_seal_run.py', hiddenSuite, 'nope')))).toBe(400);
    expect(await count()).toBe(before);

    await write('hidden', 'tests/test_seal_run.py', hiddenSuite, 'api');
    await write('solution', 'api/repository/tasks.py', solutionFile, null);
    expect(await count()).toBe(before + 1);
    const read = await seal.readOwnerOnly(OWNER, code.projectId, code.versionId, 'implementation', 'main', 'hidden', 'tests/test_seal_run.py');
    expect(read.runId).toBe('api');
    expect(status(await caught(
      seal.readOwnerOnly(OWNER, code.projectId, code.versionId, 'implementation', 'main', 'hidden', 'tests/test_seal_run.py', 'web'),
    ))).toBe(404);
    expect(
      (await seal.readOwnerOnly(OWNER, code.projectId, code.versionId, 'implementation', 'main', 'solution', 'api/repository/tasks.py')).runId,
    ).toBeNull();
  });

  /* ---------- "inherited" is asked of the copy's ancestry only ---------- */

  it("› another teacher's byte-identical file never seals the owner's own", async () => {
    const mine = await copyTaskTrackr(world, 'seal-mine');
    const boiler = 'import unittest\n\n\nclass Boiler(unittest.TestCase):\n    def test_boiler(self):\n        self.assertEqual(1 + 1, 2)\n';
    await seal.write(OWNER, mine.projectId, mine.versionId, 'implementation', 'main', 'hidden', 'tests/test_boiler.py', boiler);
    const first = await seal.readOwnerOnly(OWNER, mine.projectId, mine.versionId, 'implementation', 'main', 'hidden', 'tests/test_boiler.py');
    expect(Buffer.from(first.contentBase64, 'base64').toString('utf-8')).toBe(boiler);

    // An unrelated teacher writes the same bytes in a project of their own.
    const theirs = await world.service.createProject(OTHER_TEACHER, { title: 'Their copy', slug: 'seal-theirs', fromVersionId: world.seedVersionId });
    await seal.write(OTHER_TEACHER, theirs.project.id, theirs.draftVersionId, 'implementation', 'main', 'hidden', 'tests/test_boiler.py', boiler);

    const again = await seal.readOwnerOnly(OWNER, mine.projectId, mine.versionId, 'implementation', 'main', 'hidden', 'tests/test_boiler.py');
    expect(Buffer.from(again.contentBase64, 'base64').toString('utf-8')).toBe(boiler);
    const theirRead = await seal.readOwnerOnly(OTHER_TEACHER, theirs.project.id, theirs.draftVersionId, 'implementation', 'main', 'hidden', 'tests/test_boiler.py');
    expect(theirRead.sha256).toBe(sha(boiler));
  });

  it("› the owner's read is no oracle: a right guess of the platform's sealed bytes answers as a wrong one does", async () => {
    const guess = await copyTaskTrackr(world, 'seal-guess');
    const implementation = await phaseRow(guess.versionId, 'implementation');
    const files = world.dataSource.getRepository(ProjectFileEntity);
    const inherited = await files.findOneByOrFail({ projectVersionId: guess.versionId, ownerId: implementation.id, role: 'hidden' });
    const exact = (await world.dataSource.getRepository(ContentBlobEntity).findOneByOrFail({ sha: inherited.blobSha })).bytes;
    const wrong = `${exact}\n# not quite\n`;
    const inheritedPath = inherited.path.replace(/^hidden\//, '');

    // The inherited row itself stays sealed.
    expect(status(await caught(
      seal.readOwnerOnly(OWNER, guess.projectId, guess.versionId, 'implementation', 'main', 'hidden', inheritedPath),
    ))).toBe(403);

    const answer = async (path: string, bytes: string) => {
      await seal.write(OWNER, guess.projectId, guess.versionId, 'implementation', 'main', 'hidden', path, bytes);
      try {
        await seal.readOwnerOnly(OWNER, guess.projectId, guess.versionId, 'implementation', 'main', 'hidden', path);
        return 200;
      } catch (error) {
        return status(error);
      }
    };
    expect(await answer('tests/test_guess_right.py', exact)).toBe(200);
    expect(await answer('tests/test_guess_wrong.py', wrong)).toBe(200);
    // Written over the inherited path itself: the owner's own bytes now, so theirs to read.
    expect(await answer(inheritedPath, exact)).toBe(200);
  });

  it('› decodeSealedBase64 refuses what is not base64 of UTF-8 text', () => {
    expect(decodeSealedBase64(Buffer.from('print("ok")\n').toString('base64'))).toBe('print("ok")\n');
    for (const bad of ['', '***', Buffer.from([0xff, 0xfe, 0x00]).toString('base64'), Buffer.from('a\u0000b').toString('base64')]) {
      expect(status((() => { try { decodeSealedBase64(bad); } catch (error) { return error; } return null; })())).toBe(400);
    }
  });
});

/* ======================================================================== *
 * The sealed-role door asks the hidden-test                                *
 * name rule publish asks (door-rules.ts `isHiddenTestName`). There are     *
 * no hidden helper files: a code task's hidden path the rule would refuse is*
 * refused at the door, before any row, so a draft never holds a name that  *
 * publish refuses and no door could remove.                                *
 * ======================================================================== */
describe('the sealed-role door against publish’s run-shape rule on hidden file names', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ContentService } = require('../content/content.service') as typeof import('../content/content.service');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DirectoryPackSource } = require('../content/pack-source') as typeof import('../content/pack-source');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { overlaySealedRows } = require('./draft') as typeof import('./draft');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sealedRoles = require('./sealed-roles') as typeof import('./sealed-roles');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rawPackManifestOf } = require('./validation') as typeof import('./validation');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { checkPackRuns } = require('./upload-limits') as typeof import('./upload-limits');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  const SHELF = path.join(__dirname, '..', '..', 'test', 'fixtures', 'upload-packs', 'shelf');
  const loaded = new ContentService().loadProject(new DirectoryPackSource(SHELF));
  const impl = loaded.phases.find((p) => p.key === 'implementation')!;
  const before = checkPackRuns(rawPackManifestOf(loaded)).map((r) => r.code);
  /** The door's new fixed sentence (looked up loosely so the red is an assertion, not a type error). */
  const HIDDEN_NAME = (): string => (sealedRoles.SEALED_REFUSALS as unknown as Record<string, string>).hiddenName ?? '<no hiddenName sentence>';

  it('baseline: the run-shape rule is clean', () => expect(before).toEqual([]));
  for (const at of ['test_extra.py', 'extra_test.py', 'helpers.py', 'web/src/lib/extra.spec.ts']) {
    it(at, () => {
      let accepted = true;
      try { sealedRoles.sealedPlacement(impl.checks, 'hidden', at, null); } catch { accepted = false; }
      const out = overlaySealedRows(impl.checks as never, [{ role: 'hidden', path: 'hidden/' + at, bytes: 'def test_x():\n    assert True\n' } as never]) as any;
      const content = { ...loaded, phases: loaded.phases.map((p) => (p.key === 'implementation' ? { ...p, checks: out } : p)) };
      const after = checkPackRuns(rawPackManifestOf(content as never)).map((r) => r.code);
      expect({ at, doorAcceptsAndD2Breaks: accepted && after.length > 0, after: accepted ? after : 'refused' }).toEqual({ at, doorAcceptsAndD2Breaks: false, after: accepted ? [] : 'refused' });
    });
  }

  it("the door's refusal is 400 with one fixed sentence that names no path, and a name the run-shape rule accepts in the run it lands in still places there", () => {
    const refusalOf = (at: string, runId: string | null): unknown => {
      try {
        sealedRoles.sealedPlacement(impl.checks, 'hidden', at, runId);
        return null;
      } catch (error) {
        return error;
      }
    };
    for (const at of ['extra_test.py', 'helpers.py', 'conftest.py', 'web/src/lib/extra.spec.ts', 'web/src/lib/helpers.ts']) {
      const error = refusalOf(at, null) as { status: number; message: string } | null;
      expect({ at, status: error?.status, sentence: error?.message }).toEqual({ at, status: 400, sentence: HIDDEN_NAME() });
    }
    // a Python test name declared to the TypeScript run never lands there (the
    // run rule, unchanged: the write answers SEALED_REFUSALS.run)
    const runs = (impl.checks as { runs: { id: string; language: string }[] }).runs;
    const tsRun = runs.find((run) => run.language === 'typescript')!.id;
    const pyRun = runs.find((run) => run.language === 'python')!.id;
    expect(sealedRoles.sealedPlacement(impl.checks, 'hidden', 'test_extra.py', tsRun).runIds).not.toContain(tsRun);
    // a helper declared to any run is refused by name before the run is asked
    expect((refusalOf('helpers.py', pyRun) as { message?: string } | null)?.message).toBe(HIDDEN_NAME());
    // controls: each spelling in its own run
    expect(refusalOf('test_extra.py', null)).toBeNull();
    expect(refusalOf('test_extra.py', pyRun)).toBeNull();
    expect(refusalOf('web/src/lib/extra.test.ts', null)).toBeNull();
    expect(refusalOf('web/src/lib/extra.test.tsx', tsRun)).toBeNull();
    expect(HIDDEN_NAME()).not.toMatch(/helpers|extra/);
  });

  it('CLOSER: a hidden file that lands in no run is refused by name (fail closed), never placed by either spelling', () => {
    const flat = { ...(impl.checks as object), runs: [] } as never;
    for (const at of ['test_extra.py', 'web/src/lib/extra.test.ts', 'helpers.py']) {
      let message: string | null = null;
      try { sealedRoles.sealedPlacement(flat, 'hidden', at, null); } catch (error) { message = (error as Error).message; }
      expect({ at, message }).toEqual({ at, message: HIDDEN_NAME() });
    }
    // GUARD: with its runs, a well-named file still places
    expect(sealedRoles.sealedPlacement(impl.checks, 'hidden', 'test_extra.py', null).runIds.length).toBeGreaterThan(0);
  });

  it("GUARD: the door's text rule is unchanged: NUL and invalid UTF-8 keep their sentences; a byte-order mark is dropped", () => {
    const refused = (b64: string): string | null => {
      try {
        sealedRoles.decodeSealedBase64(b64);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(refused(Buffer.from('a\u0000b').toString('base64'))).toBe(sealedRoles.SEALED_REFUSALS.nul);
    expect(refused(Buffer.from([0xff, 0xfe, 0x41]).toString('base64'))).toBe(sealedRoles.SEALED_REFUSALS.base64);
    expect(refused(Buffer.from([0xc0, 0x80]).toString('base64'))).toBe(sealedRoles.SEALED_REFUSALS.base64);
    expect(refused('')).toBe(sealedRoles.SEALED_REFUSALS.base64);
    expect(refused(Buffer.from('﻿').toString('base64'))).toBe(sealedRoles.SEALED_REFUSALS.empty);
    expect(sealedRoles.decodeSealedBase64(Buffer.from('﻿def test_x(): pass\n').toString('base64'))).toBe('def test_x(): pass\n');
    expect(sealedRoles.SEALED_REFUSALS.nul).toBe('A sealed file is text, and text holds no NUL character.');
    expect(sealedRoles.SEALED_REFUSALS.base64).toBe('A sealed file arrives as base64 of UTF-8 text, and this is not that.');
  });
});
