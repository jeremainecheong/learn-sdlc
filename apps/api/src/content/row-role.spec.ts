import 'reflect-metadata';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import type { ProjectFileRole } from '@learnsdlc/shared';
import { DataSource } from 'typeorm';
import { config } from '../config';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectVersionEntity,
} from '../db/entities';
import { blobShaFor, canonicalJson } from './blob.store';
import { ContentService } from './content.service';
import { DirectoryPackSource } from './pack-source';
import { ProjectImporterService, type ImportResult } from './importer.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * A role is a property of a `(version, phase, path)`, never of bytes.
 *
 * This is the spec that decides where a role lives: the platform's own default
 * project is the counter-example to the obvious design. **Five shas in `content/tasktrackr`
 * are simultaneously a locked `workspace` row and a sealed `solution` file**,
 * so a table keyed by sha would have to pick one of two true answers, and
 * the next person reaching for one meets those five by name in a failing test
 * rather than in a learner's workspace.
 *
 * The other four cases are the rules that keep the column honest: a role is set
 * at insert and never updated, sealed bytes never reach a workspace row, answer
 * material never reaches an *editable* one, and publish re-asks both questions
 * so that a row written before a rule landed cannot be published after it.
 */
describe('a file row carries the role, and the role is never re-written', () => {
  let dataSource: DataSource;
  let importer: ProjectImporterService;
  let content: ContentService;
  let seeded: ImportResult;

  /** The five shas the design names, with the file each one is. */
  const DUAL_ROLE: [string, string][] = [
    ['b1ec2b8726f65cfe2dfeb91567768b42377ccca4cafa83c82bb0b0f70e093f6b', 'api/repository/tasks.py'],
    ['d3215fe30f7996cde62c152dbddda76195fda4d6e69ce4cb654d9a4b46235350', 'web/src/lib/overdue.ts'],
    ['45737739a73d658cb5cb40e9baf182f5404c7af44400d46bb2b96fdc91e23e5a', 'web/src/hooks/useTasks.ts'],
    ['03cfbdbbde4b509fc80cda50a3507400f0303dc1de0a97fe36f3e94d64b917df', 'api/repository/comments.py'],
    ['54448befa1305d0fc4006c5e2591a7fb5c2f00277fe609f3cee7735e59ce219c', 'api/routes/comments.py'],
  ];

  /**
   * Every row of the seeded version holding `sha`, as `<phase>:<role>:<path>`,
   * sorted. Scoped to that version because a role is a property of a
   * `(version, phase, path)`: the fork below holds the same shas under the
   * same roles, which is the point of it.
   */
  const rowsHolding = async (sha: string): Promise<string[]> => {
    const files = await dataSource
      .getRepository(ProjectFileEntity)
      .find({ where: { projectVersionId: seeded.projectVersionId, blobSha: sha } });
    const phases = await dataSource.getRepository(ProjectPhaseEntity).find();
    const keyOf = (ownerId: string): string =>
      phases.find((phase) => phase.id === ownerId)?.key ?? 'project';
    return files.map((file) => `${keyOf(file.ownerId)}:${file.role}:${file.path}`).sort();
  };

  const shippedPack = (): DirectoryPackSource =>
    new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr'));

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    importer = new ProjectImporterService(content, dataSource);
    // The shipped pack is imported here rather than by the first test, because
    // every test below reads the rows it wrote. A file whose second test needs
    // its first to have run is a file that fails the day the order changes, and
    // this one did: `--randomize --seed 4242` put the fork test first and it
    // threw looking for a `project_versions` row nobody had written yet.
    seeded = await importer.importPack(shippedPack(), { origin: 'seed', platformOwned: true });
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  /** A hand-built version, because the rules below fire on nothing a pack can declare. */
  const handBuilt = async (
    slug: string,
  ): Promise<{ projectId: string; versionId: string; phaseId: string; where: string }> => {
    const project = await dataSource
      .getRepository(ProjectEntity)
      .save({ slug, title: slug, origin: 'blank' });
    const version = await dataSource.getRepository(ProjectVersionEntity).save({
      projectId: project.id,
      version: '0.1.0',
      status: 'draft',
      manifest: { tagline: 't', description: 'd', language: 'python', languages: ['python'] },
    });
    const phase = await dataSource.getRepository(ProjectPhaseEntity).save({
      projectVersionId: version.id,
      key: 'implementation',
      order: 3,
      title: 'Implementation',
      intro: 'i',
      artifactKind: 'code',
      assistant: { systemPrompt: 'help', topics: [], progressive: [] },
    });
    return {
      projectId: project.id,
      versionId: version.id,
      phaseId: phase.id,
      where: `${slug} 0.1.0`,
    };
  };

  it('the seed imports with zero refusals, and five shas are two roles at once', async () => {
    expect(seeded.outcome).toBe('imported');
    expect(seeded.slug).toBe('tasktrackr');

    // The counter-example, by name. Each of the five is one row in
    // `content_blobs` reached by several `project_files` rows under at least two
    // roles: including a **locked `workspace`** row in one phase and a sealed
    // `solution` file in another, which is the whole of why the role cannot live
    // on the bytes.
    for (const [sha, at] of DUAL_ROLE) {
      expect(await dataSource.getRepository(ContentBlobEntity).count({ where: { sha } })).toBe(1);
      const rows = await rowsHolding(sha);
      const roles = new Set(rows.map((row) => row.split(':')[1]));
      expect({ at, rows: rows.length > 1, roles: roles.size > 1 }).toEqual({
        at,
        rows: true,
        roles: true,
      });
      expect(rows).toContain(`testing:workspace:${at}`);
      expect(rows.some((row) => row.includes(':solution:'))).toBe(true);
    }

    // and the exact shape, so a pack that moves one of them says which
    expect(await rowsHolding(DUAL_ROLE[0][0])).toEqual([
      'implementation:solution:solution/api/repository/tasks.py',
      'maintenance:solution:solution/api/repository/tasks.py',
      'testing:reference:reference/api/repository/tasks.py',
      'testing:workspace:api/repository/tasks.py',
    ]);
    // no workspace row is editable where the bytes are somebody's answer: the
    // testing phase mounts the whole application, locked, so it can preview
    const mounted = await dataSource
      .getRepository(ProjectFileEntity)
      .find({
        where: {
          projectVersionId: seeded.projectVersionId,
          blobSha: DUAL_ROLE[0][0],
          role: 'workspace',
        },
      });
    expect(mounted.map((row) => row.editable)).toEqual([false]);
  });

  it("a fork's sealed rows reference the source's blobs and carry the source's roles", async () => {
    const source = await dataSource
      .getRepository(ProjectVersionEntity)
      .findOneByOrFail({ id: seeded.projectVersionId });
    const blobsBefore = await dataSource.getRepository(ContentBlobEntity).count();

    const fork = await dataSource
      .getRepository(ProjectEntity)
      .save({ slug: 'tasktrackr-fork', title: 'A fork', origin: 'fork' });
    const forked = await dataSource.getRepository(ProjectVersionEntity).save({
      projectId: fork.id,
      version: '2.0.1',
      status: 'draft',
      manifest: { tagline: 't', description: 'd', language: 'python', languages: ['python'] },
      forkedFromVersionId: source.id,
    });
    const copied = await importer.copyFilesToVersion(dataSource.manager, source.id, forked.id);

    const files = dataSource.getRepository(ProjectFileEntity);
    const shape = (rows: ProjectFileEntity[]) =>
      rows.map((row) => `${row.ownerKind}:${row.path}:${row.role}:${row.blobSha}`).sort();
    expect(copied).toBeGreaterThan(0);
    expect(shape(await files.find({ where: { projectVersionId: forked.id } }))).toEqual(
      shape(await files.find({ where: { projectVersionId: source.id } })),
    );
    // Metadata only: a hundred forks of TaskTrackr store one copy of it.
    expect(await dataSource.getRepository(ContentBlobEntity).count()).toBe(blobsBefore);
  });

  it('the interview brief is a row of its own, so rule 1 can see it', async () => {
    // The interview is answer material: the API answers the fact topics and
    // never the answers, and `WORKSPACE_FORBIDDEN_BLOB_ROLES` names the role.
    // With no row carrying it, that arm of the rule could not fire and a
    // version mounting the customer interview's bytes as a workspace file
    // published cleanly. `project_phases.interview` is still the reader; this
    // row exists so the version's own rows can be asked the question.
    const phases = await dataSource
      .getRepository(ProjectPhaseEntity)
      .find({ where: { projectVersionId: seeded.projectVersionId } });
    const withInterview = phases.filter((phase) => phase.interview !== null);
    const rows = await dataSource
      .getRepository(ProjectFileEntity)
      .find({ where: { projectVersionId: seeded.projectVersionId, role: 'interview' } });

    expect(withInterview.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(withInterview.length);
    for (const row of rows) {
      const phase = withInterview.find((one) => one.id === row.ownerId);
      expect({ path: row.path, editable: row.editable, phase: Boolean(phase) }).toEqual({
        path: 'interview/brief.json',
        editable: false,
        phase: true,
      });
      expect(row.blobSha).toBe(blobShaFor(canonicalJson(phase?.interview)));
      const blob = await dataSource
        .getRepository(ContentBlobEntity)
        .findOneByOrFail({ sha: row.blobSha });
      expect(JSON.parse(blob.bytes)).toEqual(phase?.interview);
    }
  });

  it("a workspace row holding the interview's bytes is refused", async () => {
    const { versionId, phaseId } = await handBuilt('mounted-interview');
    const bytes = canonicalJson({
      customer: 'Dana',
      facts: [{ topic: 'overdue', answer: 'anything due before today' }],
    });
    await importer.insertFiles(dataSource.manager, versionId, [
      {
        ownerKind: 'phase',
        ownerId: phaseId,
        path: 'interview/brief.json',
        role: 'interview',
        editable: false,
        language: null,
        bytes,
      },
    ]);

    await expect(
      importer.insertFiles(dataSource.manager, versionId, [
        {
          ownerKind: 'phase',
          ownerId: phaseId,
          path: 'requirements/interview.json',
          role: 'workspace',
          editable: false,
          language: null,
          bytes,
        },
      ]),
    ).rejects.toThrow(
      /the workspace file "requirements\/interview\.json" holds bytes this version also holds as an interview file/,
    );
  });

  it('a role on an existing row is refused', async () => {
    const row = await dataSource.getRepository(ProjectFileEntity).findOneByOrFail({
      projectVersionId: seeded.projectVersionId,
      path: 'requirements/story.json',
      role: 'workspace',
    });

    // There is no re-role operation. Changing a role is a delete and a create,
    // which means the bytes are supplied again and the create's own rules apply.
    await expect(
      importer.updateFile(dataSource.manager, row.id, { role: 'solution' } as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      importer.updateFile(dataSource.manager, row.id, { role: 'solution' } as never),
    ).rejects.toThrow(/role is set when the row is created and never changed/);
    expect(
      (await dataSource.getRepository(ProjectFileEntity).findOneByOrFail({ id: row.id })).role,
    ).toBe('workspace');

    // a patch that names no role is the ordinary edit and goes through: on a
    // draft, which is the only status whose rows are editable at all
    const { versionId, phaseId } = await handBuilt('ordinary-edit');
    await importer.insertFiles(dataSource.manager, versionId, [
      {
        ownerKind: 'phase',
        ownerId: phaseId,
        path: 'requirements/story.json',
        role: 'workspace',
        editable: true,
        language: 'json',
        bytes: '{}\n',
      },
    ]);
    const draftRow = await dataSource
      .getRepository(ProjectFileEntity)
      .findOneByOrFail({ projectVersionId: versionId });
    await importer.updateFile(dataSource.manager, draftRow.id, { language: 'md' });
    expect(
      (await dataSource.getRepository(ProjectFileEntity).findOneByOrFail({ id: draftRow.id }))
        .language,
    ).toBe('md');
  });

  it("a published version's file row is not patchable at all", async () => {
    // A published version is immutable, and that is the whole basis of the pin:
    // a learner resolved to it cannot have the ground move under an attempt.
    // `updateFile` refused a role patch and wrote every other one, including
    // onto a published row, so a path could be rewritten and an `editable`
    // flag flipped on content a class was being graded against.
    const row = await dataSource.getRepository(ProjectFileEntity).findOneByOrFail({
      projectVersionId: seeded.projectVersionId,
      // TaskTrackr 6.0.0's Design record, a workspace row of the published head
      path: 'design/design.json',
      role: 'workspace',
    });

    for (const patch of [{ language: 'md' }, { editable: true }, { path: 'design/moved.json' }]) {
      await expect(importer.updateFile(dataSource.manager, row.id, patch)).rejects.toThrow(
        /tasktrackr 6\.0\.0 is published; only a draft's file rows can be changed/,
      );
    }
    expect(
      await dataSource.getRepository(ProjectFileEntity).findOneByOrFail({ id: row.id }),
    ).toEqual(row);
  });

  it('un-sealing an editable flag re-asks the byte rules', async () => {
    // The five dual-role shas are the reason rule 2 is about `editable` rather
    // than about bytes, and `editable` was patchable without re-asking it: a
    // locked workspace row holding the answer is the shipped shape, and one
    // flag flip turned it into a learner being handed the finished function.
    const { versionId, phaseId } = await handBuilt('unsealed-by-patch');
    const bytes = 'def overdue(task, today):\n    return task.due < today\n';
    await importer.insertFiles(dataSource.manager, versionId, [
      {
        ownerKind: 'phase',
        ownerId: phaseId,
        path: 'canonical/api/repository/tasks.py',
        role: 'canonical',
        editable: false,
        language: 'python',
        bytes,
      },
      {
        ownerKind: 'phase',
        ownerId: phaseId,
        path: 'api/repository/tasks.py',
        role: 'workspace',
        editable: false,
        language: 'python',
        bytes,
      },
    ]);
    const locked = await dataSource
      .getRepository(ProjectFileEntity)
      .findOneByOrFail({ projectVersionId: versionId, role: 'workspace' });

    await expect(
      importer.updateFile(dataSource.manager, locked.id, { editable: true }),
    ).rejects.toThrow(
      /the editable workspace file "api\/repository\/tasks\.py" holds bytes this version also holds as a canonical file/,
    );
    expect(
      (await dataSource.getRepository(ProjectFileEntity).findOneByOrFail({ id: locked.id }))
        .editable,
    ).toBe(false);

    // and the patch that does not un-seal anything still goes through
    await importer.updateFile(dataSource.manager, locked.id, { path: 'api/repository/moved.py' });
    expect(
      (await dataSource.getRepository(ProjectFileEntity).findOneByOrFail({ id: locked.id })).path,
    ).toBe('api/repository/moved.py');
  });

  /**
   * Rule 1 is a question about every role a learner reads, not about the
   * literal string `workspace`: `warmup` holds learner material, with the
   * learner's own editability, so a version holding the implementation phase's
   * hidden suite as a warm-up file would have published it cleanly as learner
   * material.
   */
  it.each([
    ['workspace', true],
    ['workspace', false],
    ['warmup', true],
    ['warmup', false],
  ] as [ProjectFileRole, boolean][])(
    'a %s row holding sealed bytes is refused (editable: %s)',
    async (role, editable) => {
      const { projectId, versionId, phaseId } = await handBuilt(`sealed-${role}-${editable}`);
      const bytes = 'def test_overdue_marks_late_tasks():\n    assert True\n';
      await importer.insertFiles(dataSource.manager, versionId, [
        {
          ownerKind: 'phase',
          ownerId: phaseId,
          path: 'hidden/tests/test_hidden.py',
          role: 'hidden',
          editable: false,
          language: 'python',
          bytes,
        },
      ]);

      await expect(
        importer.insertFiles(dataSource.manager, versionId, [
          {
            ownerKind: role === 'warmup' ? 'project' : 'phase',
            ownerId: role === 'warmup' ? projectId : phaseId,
            path: role === 'warmup' ? 'warmup/tests/test_hidden.py' : 'tests/test_hidden.py',
            role,
            editable,
            language: 'python',
            bytes,
          },
        ]),
      ).rejects.toThrow(
        new RegExp(
          `the ${role} file "${role === 'warmup' ? 'warmup/' : ''}tests/test_hidden\\.py" holds ` +
            'bytes this version also holds as a hidden file',
        ),
      );
      expect(
        await dataSource.getRepository(ProjectFileEntity).count({ where: { projectVersionId: versionId } }),
      ).toBe(1);
    },
  );

  it('an editable warm-up row holding answer material is refused', async () => {
    // The other half of the same widening: rule 2 is about a file the learner
    // is scored on filling in, and a warm-up file is exactly that.
    const { projectId, versionId, phaseId } = await handBuilt('warmup-answer');
    const bytes = 'def overdue(task, today):\n    return task.due < today\n';
    await importer.insertFiles(dataSource.manager, versionId, [
      {
        ownerKind: 'phase',
        ownerId: phaseId,
        path: 'solution/api/repository/tasks.py',
        role: 'solution',
        editable: false,
        language: 'python',
        bytes,
      },
    ]);

    await expect(
      importer.insertFiles(dataSource.manager, versionId, [
        {
          ownerKind: 'project',
          ownerId: projectId,
          path: 'warmup/overdue.py',
          role: 'warmup',
          editable: true,
          language: 'python',
          bytes,
        },
      ]),
    ).rejects.toThrow(
      /the editable warmup file "warmup\/overdue\.py" holds bytes this version also holds as a solution file/,
    );
  });

  it('an editable workspace row holding canonical or sealed bytes is refused', async () => {
    const { versionId, phaseId } = await handBuilt('editable-canonical');
    const bytes = 'def overdue(task, today):\n    return task.due < today\n';
    await importer.insertFiles(dataSource.manager, versionId, [
      {
        ownerKind: 'phase',
        ownerId: phaseId,
        path: 'canonical/api/repository/tasks.py',
        role: 'canonical',
        editable: false,
        language: 'python',
        bytes,
      },
    ]);

    await expect(
      importer.insertFiles(dataSource.manager, versionId, [
        {
          ownerKind: 'phase',
          ownerId: phaseId,
          path: 'api/repository/tasks.py',
          role: 'workspace',
          editable: true,
          language: 'python',
          bytes,
        },
      ]),
    ).rejects.toThrow(
      /the editable workspace file "api\/repository\/tasks\.py" holds bytes this version also holds as a canonical file/,
    );

    // Locked is a different question, and it is the shipped shape: a phase
    // mounts the whole application so that it can run and preview, and the
    // bytes of a file the learner is not being scored on writing may be the
    // finished ones.
    await importer.insertFiles(dataSource.manager, versionId, [
      {
        ownerKind: 'phase',
        ownerId: phaseId,
        path: 'api/repository/tasks.py',
        role: 'workspace',
        editable: false,
        language: 'python',
        bytes,
      },
    ]);
    expect(
      await dataSource.getRepository(ProjectFileEntity).count({ where: { projectVersionId: versionId } }),
    ).toBe(2);
  });

  it('publish refuses a version containing either violation', async () => {
    const { versionId, phaseId, where } = await handBuilt('unpublishable');
    const bytes = 'ENTRYPOINT ["python3", "api/main.py"]\n';
    // Written straight to the table, which is what a row inserted before the
    // rule landed looks like: publish is the second place the question is asked,
    // so such a row cannot be published after the fact.
    await dataSource.getRepository(ProjectFileEntity).save([
      {
        projectVersionId: versionId,
        ownerKind: 'phase',
        ownerId: phaseId,
        path: 'drill/Dockerfile',
        role: 'drill',
        editable: false,
        language: null,
        blobSha: blobShaFor(bytes),
      },
      {
        projectVersionId: versionId,
        ownerKind: 'phase',
        ownerId: phaseId,
        path: 'Dockerfile',
        role: 'workspace',
        editable: true,
        language: null,
        blobSha: blobShaFor(bytes),
      },
    ]);

    await expect(importer.publishVersion(dataSource.manager, versionId)).rejects.toThrow(
      new RegExp(`${where}: the workspace file "Dockerfile" holds bytes this version also holds as a drill file`),
    );
    expect(
      (await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).status,
    ).toBe('draft');
  });

  it('publish refuses a version that is not a draft, and one with no snapshot', async () => {
    // Re-publishing is the other way to mutate a published version, and it is
    // the one the pin cannot survive: `publishedAt` and the publisher would be
    // rewritten on content a class is being graded against.
    await expect(
      importer.publishVersion(dataSource.manager, seeded.projectVersionId),
    ).rejects.toThrow(/tasktrackr 6\.0\.0 is already published; only a draft can be published/);

    // And a draft with no compiled snapshot: the registry skips such a row by
    // name, so publishing one silently resolves an enrolment pinned to it to
    // the head instead. Refused at the door rather than logged at boot.
    const { versionId, where } = await handBuilt('no-snapshot');
    await expect(importer.publishVersion(dataSource.manager, versionId)).rejects.toThrow(
      new RegExp(`${where} holds no compiled snapshot`),
    );
    expect(
      (await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).status,
    ).toBe('draft');
  });
});
