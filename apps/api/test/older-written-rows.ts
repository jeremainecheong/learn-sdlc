import type { DataSource } from 'typeorm';
import type { PhaseKey } from '@learnsdlc/shared';
import { writeBlob } from '../src/authoring/legacy-rows';
import type { ContentService, LoadProjectOptions } from '../src/content/content.service';
import type { ContentFileSpec, PhaseContent } from '../src/content/content.types';
import type { OlderWrittenChecks } from '../src/content/older-written';
import type { CompiledSnapshot } from '../src/content/pack-compiler';
import type { PackSource } from '../src/content/pack-source';
import { ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../src/content/project.entities';

/**
 * Rows stored before the markdown kind was retired, stood up for the specs of
 * the readers that still convert them (the Requirements and Design
 * conversions, the copy and next-draft doors, the stored-draft passes, the
 * export of an older Requirements or Design).
 *
 * The product loader does not keep a Requirements or Design phase of the
 * older written kind as written (it converts one at the upload door and names
 * the older format everywhere else), and the compiler does not grade the
 * kind, so no import writes such rows. A version or a draft stored by an
 * earlier release of the product can still hold them, so a spec writes them
 * here: the pack is imported converted, and then each phase whose `phase.json` declares the
 * older kind is written back exactly as an older import wrote it: the phase's
 * kind, its task rows' checks, type, path and rubric, its workspace files, and
 * the stored snapshot's phase and sole task.
 */

/** A pack imported through `importPack` (a boot or seed import), its older phases stored as an older import stored them. */
export async function importOlderPack(
  content: ContentService,
  dataSource: DataSource,
  source: PackSource,
  importPack: () => Promise<{ projectVersionId: string }>,
): Promise<{ projectVersionId: string }> {
  const load = content.loadProject.bind(content);
  // the boot import loads without the conversion; the converted rows are the starting point the older ones are written over
  const converting = jest
    .spyOn(content, 'loadProject')
    .mockImplementation((pack: PackSource, options: LoadProjectOptions = {}) => load(pack, { ...options, convertLegacyRequirements: true, convertLegacyDesign: true, warnings: [] }));
  let imported: { projectVersionId: string };
  try {
    imported = await importPack();
  } finally {
    converting.mockRestore();
  }
  await storeOlderPhases(dataSource, imported.projectVersionId, source);
  return imported;
}

/**
 * Writes each phase of `versionId` whose `phase.json` in `source` declares the
 * older written kind back to the rows an older import stored: a teacher draft
 * stored before uploads converted, or a version published before the kind was retired.
 * `only` names the phases to write back (every older one when absent): a draft
 * stored before the design kind whose Requirements the story pass already
 * converted holds its Design alone in the older kind.
 */
export async function storeOlderPhases(dataSource: DataSource, versionId: string, source: PackSource, only?: readonly PhaseKey[]): Promise<void> {
  await dataSource.transaction(async (manager) => {
    const version = await manager.findOneByOrFail(ProjectVersionEntity, { id: versionId });
    const compiled = JSON.parse(JSON.stringify(version.compiled)) as CompiledSnapshot;
    for (const row of await manager.findBy(ProjectPhaseEntity, { projectVersionId: versionId })) {
      const at = compiled.content.phases.findIndex((one) => one.key === row.key);
      if (at < 0 || (only && !only.includes(row.key))) continue;
      const older = olderPhaseOf(source, compiled.content.phases[at]);
      if (!older) continue;
      const checks = older.checks as unknown as OlderWrittenChecks;
      const artefactType = row.key === 'design' ? ('design-doc' as const) : ('user-story' as const);
      const artefactPath = olderArtefactPathOf(older, checks);
      // the retired kind, which no product type names any more
      await manager.update(ProjectPhaseEntity, { id: row.id }, { artifactKind: 'markdown' as never });
      for (const task of await manager.findBy(ProjectTaskEntity, { projectPhaseId: row.id })) {
        if (task.checks.kind === 'quiz') continue;
        await manager.update(ProjectTaskEntity, { id: task.id }, { checks: older.checks as never, artefactType, artefactPath, rubric: older.rubric });
      }
      // the phase's workspace, as the older pack mounted it
      await manager.delete(ProjectFileEntity, { projectVersionId: versionId, ownerKind: 'phase', ownerId: row.id, role: 'workspace' });
      for (const file of older.files) {
        await manager.insert(ProjectFileEntity, {
          projectVersionId: versionId,
          ownerKind: 'phase',
          ownerId: row.id,
          path: file.path,
          role: 'workspace',
          editable: file.editable,
          language: file.language,
          blobSha: await writeBlob(manager, file.content),
        });
      }
      // and the stored snapshot: the phase as written, its sole work task as the older compiler wrote it
      compiled.content.phases[at] = older;
      const tasks = compiled.phases.find((one) => one.key === row.key);
      if (tasks) {
        tasks.tasks = tasks.tasks.map((task) => {
          if (task.checkKind === 'quiz') return task;
          const { checks: _slice, ...rest } = task;
          return {
            ...rest,
            checkKind: 'markdown' as never,
            artefactType,
            artefactPath,
            owns: older.files.filter((file) => file.editable).map((file) => file.path),
            gradedUnits: checks.rules.map((rule) => ({ kind: 'rule' as const, id: rule.id })),
            rubric: older.rubric,
          };
        });
      }
    }
    await manager.update(ProjectVersionEntity, { id: versionId }, { compiled });
  });
}

/**
 * The path an older import stored on the phase's written task: the phase's one
 * editable prose file, which the task owned (it owned every editable path).
 * The fixtures this helper writes back name that file as their first target,
 * and a pack that does not is refused here rather than written with a path the
 * older import would not have stored.
 */
function olderArtefactPathOf(older: PhaseContent, checks: OlderWrittenChecks): string {
  const prose = older.files.filter((file) => file.editable && (file.language === 'markdown' || file.path.endsWith('.md'))).map((file) => file.path);
  const first = checks.targets[0];
  if (prose.length !== 1 || prose[0] !== first) {
    throw new Error(
      `The ${older.key} phase's editable prose files are [${prose.join(', ')}], not its first target alone (${first ?? 'none'}), ` +
        'so the path an older import stored on its task cannot be told.',
    );
  }
  return first;
}

/** The phase's directory in the pack, by its key, as `project.json` lists it. */
function phaseDirOf(source: PackSource, key: PhaseKey): PackSource | null {
  const project = JSON.parse(source.read('project.json')) as { phases?: string[] };
  for (const rel of project.phases ?? []) {
    const dir = source.child(rel);
    if ((JSON.parse(dir.read('phase.json')) as { key?: string }).key === key) return dir;
  }
  return null;
}

/** The phase exactly as its `phase.json` wrote it, when it declares the older written kind; null otherwise. */
function olderPhaseOf(source: PackSource, converted: PhaseContent): PhaseContent | null {
  const dir = phaseDirOf(source, converted.key);
  if (!dir) return null;
  const spec = JSON.parse(dir.read('phase.json')) as {
    checks?: { kind?: string };
    rubric: PhaseContent['rubric'];
    files?: { path: string; source: string; editable: boolean; language: string }[];
    taskFile?: string;
    taskPanel?: string;
  };
  if (spec.checks?.kind !== 'markdown') return null;
  const files: ContentFileSpec[] = (spec.files ?? []).map((file) => ({
    path: file.path,
    content: dir.read(file.source),
    editable: file.editable,
    language: file.language,
  }));
  return {
    ...converted,
    // the retired kind, which no product type names any more
    artifactKind: 'markdown' as never,
    checks: spec.checks as unknown as PhaseContent['checks'],
    rubric: spec.rubric,
    files,
    taskPanel: spec.taskFile ? dir.read(spec.taskFile) : spec.taskPanel ?? converted.taskPanel,
  };
}
