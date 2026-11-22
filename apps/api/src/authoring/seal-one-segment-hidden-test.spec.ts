import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, HttpException } from '@nestjs/common';
import type { PhaseKey } from '@learnsdlc/shared';
import { ProjectImporterService } from '../content/importer.service';
import { ProjectFileEntity, ProjectPhaseEntity } from '../content/project.entities';
import { copyTaskTrackr, openForkWorld, S1_TEACHER, type Fork, type ForkWorld } from '../../test/tasktrackr-phase';
import { EXPORT_REFUSALS } from './export.service';
import { SEALED_FOLDER_REFUSAL, SEALED_REFUSALS, SealedRoleService } from './sealed-roles';

/**
 * The seal door refuses a one-segment hidden test (`test_demo_shelf.py`),
 * which the export cannot write back where the loader reads it: every version
 * published from such a draft would refuse to export ("Implementation holds
 * …") with a remedy a published version cannot take. The door refuses that
 * path, writes nothing, and answers every other path and role unchanged.
 *
 * The door says it in its own sentence, defined in sealed-roles.ts, which
 * names the folder to use and says "seal it again", not the export's
 * sentence, whose tail ("Rename it in the editor and export again.") is the
 * export's remedy. sealed-roles.ts does not import export.service.
 */
const DOOR = (at: string) =>
  `"${at}" is not under a folder, so an export of this project could not put it back where it is read. Put it under a folder, such as tests/${at}, and seal it again.`;

const OWNER = S1_TEACHER;
const suite = '"""seal"""\n\ndef test_seal():\n    assert True\n';

async function refusal(work: Promise<unknown>): Promise<HttpException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected a refusal, and the write succeeded');
}

describe('the seal door refuses a path the export cannot carry, by its own sentence', () => {
  let world: ForkWorld;
  let seal: SealedRoleService;
  let fork: Fork;
  const phase = (key: PhaseKey) =>
    world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: fork.versionId, key });
  const rows = async (key: PhaseKey) =>
    (await world.dataSource.getRepository(ProjectFileEntity).find({ where: { projectVersionId: fork.versionId, ownerId: (await phase(key)).id } }))
      .map((row) => `${row.role} ${row.path} ${row.blobSha}`)
      .sort();

  beforeAll(async () => {
    world = await openForkWorld();
    seal = new SealedRoleService(world.dataSource, new ProjectImporterService(world.content, world.dataSource));
    fork = await copyTaskTrackr(world, 'seal-owner');
  });
  afterAll(async () => {
    await world?.close();
  });

  it('a one-segment hidden test in a code task: 400 with the door\'s sentence, no row written', async () => {
    const before = await rows('implementation');
    const error = await refusal(seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'test_seal_bare.py', suite));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe(DOOR('test_seal_bare.py'));
    expect(error.message).not.toBe(EXPORT_REFUSALS.path((await phase('implementation')).title, 'test_seal_bare.py'));
    expect(await rows('implementation')).toEqual(before);
  });

  it('a one-segment suite file in a tests task that is not a learner test file: the same door sentence', async () => {
    const before = await rows('testing');
    const error = await refusal(seal.write(OWNER, fork.projectId, fork.versionId, 'testing', 'main', 'hidden', 'test_seal_suite.py', suite));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe(DOOR('test_seal_suite.py'));
    expect(error.message).not.toBe(EXPORT_REFUSALS.path((await phase('testing')).title, 'test_seal_suite.py'));
    expect(await rows('testing')).toEqual(before);
  });

  it('GUARD › the same file under a folder is sealed', async () => {
    const view = await seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'tests/test_seal_ok.py', suite);
    expect(Object.keys(view).sort()).toEqual(['bytes', 'path', 'sha256']);
    expect(view.path).toBe('tests/test_seal_ok.py');
  });

  it('GUARD › a helper name is still answered by its own sentence first', async () => {
    const error = await refusal(seal.write(OWNER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', 'helper.py', 'def helper():\n    return 1\n'));
    expect(error.message).toBe(SEALED_REFUSALS.hiddenName);
  });

  it('the door sentence is the seal door\'s own: sealed-roles.ts does not import export.service', () => {
    const source = fs.readFileSync(path.join(__dirname, 'sealed-roles.ts'), 'utf-8');
    expect(source).not.toMatch(/from '\.\/export\.service'/);
    expect(SEALED_FOLDER_REFUSAL('test_x.py')).toBe(DOOR('test_x.py'));
  });

  it('GUARD › the export\'s own sentence is unchanged', () => {
    expect(EXPORT_REFUSALS.path('Implementation', 'test_x.py')).toBe(
      'Implementation holds "test_x.py", which the archive layout cannot carry where the loader would read it back (a sealed file needs a folder in its path, no part starting with a dot, and no build-output name). Rename it in the editor and export again.',
    );
  });
});
