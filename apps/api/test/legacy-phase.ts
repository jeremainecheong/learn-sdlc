import * as fs from 'fs';
import * as path from 'path';
import type { LegacyPhaseInput } from '../src/content/runbook-legacy';
import type { ConfigChecks, CodeChecks, ContentFileSpec } from '../src/content/content.types';
import { MemoryPackSource } from '../src/content/memory-pack-source';
import { entriesOf } from './fixtures/upload-packs/archive';
import { FIXTURES_DIR, OLDER_SHELF_DIR, OLDER_TASKTRACKR_DIR } from './fixtures/paths';

/**
 * TaskTrackr 5.0.0 (the frozen `older-tasktrackr/`) with its phases 5 and 6 as
 * 4.0.0 shipped them (the frozen fixtures), one whole pack in the older layout,
 * as a teacher's older export would carry it. `edit` changes the
 * text of `project.json` and of any entry of phases 5 and 6 before it is read. It has no warm-up: the warm-up loader reads
 * `source.location` as a disk path and a MemoryPackSource's location is a
 * label (`importer.service.ts:1541-1556`), so the warm-up folder and
 * project.json's `warmup` key are left out. `loadProject` without the
 * conversion flags loads it as it is; only `loadAll` asks `requireRecords`.
 */
export function olderTaskTrackrPack(edit: (name: string, text: string) => string = (_n, t) => t): MemoryPackSource {
  const swap = (folder: string, fixture: string) => entriesOf(path.join(FIXTURES_DIR, fixture)).map((e) => {
    const name = `phases/${folder}/${e.name}`;
    return { name, bytes: Buffer.from(edit(name, e.data.toString('utf8'))) };
  });
  const rest = entriesOf(OLDER_TASKTRACKR_DIR).flatMap((e) => {
    if (/^phases\/0[56]-/.test(e.name) || e.name.startsWith('warmup/')) return [];
    if (e.name !== 'project.json') return [{ name: e.name, bytes: e.data }];
    const meta = JSON.parse(e.data.toString('utf8'));
    delete meta.warmup;
    return [{ name: e.name, bytes: Buffer.from(edit(e.name, JSON.stringify(meta, null, 2))) }];
  });
  return new MemoryPackSource([...rest, ...swap('05-deployment', 'legacy-deployment'), ...swap('06-maintenance', 'legacy-maintenance')], 'tasktrackr');
}

/**
 * The Shelf pack with its phases 5 and 6 as it shipped them before its records
 * (the frozen `legacy-shelf` fixture: Deployment's phase.json, task.md and
 * RUNBOOK.md, Maintenance's phase.json and task.md; every other file is
 * the frozen `older-shelf/`'s), one whole pack in the older layout, as an older
 * teacher's draft or export carries it.
 */
export function olderShelfPack(): MemoryPackSource {
  const older = path.join(FIXTURES_DIR, 'legacy-shelf');
  const frozen = entriesOf(older).map((e) => ({ name: `phases/${e.name}`, bytes: e.data }));
  const replaced = new Set(frozen.map((e) => e.name));
  const rest = entriesOf(OLDER_SHELF_DIR)
    .filter((e) => !replaced.has(e.name) && e.name !== 'phases/05-deployment/files/runbook.json' && e.name !== 'phases/06-maintenance/files/change-request.json')
    .map((e) => ({ name: e.name, bytes: e.data }));
  return new MemoryPackSource([...rest, ...frozen], 'shelf');
}

/**
 * TaskTrackr 4.0.0's Deployment or Maintenance as the older-shape converters
 * read it, from the frozen fixture folders: every mount with its bytes when
 * the fixture holds them (`files/...`), the canonical ones as empty
 * read-only text (the converters read only markdown mounts, rules and the
 * rubric), the brief from task.md.
 */
export function legacyPhaseInput(key: 'deployment' | 'maintenance'): LegacyPhaseInput {
  const dir = path.join(FIXTURES_DIR, key === 'deployment' ? 'legacy-deployment' : 'legacy-maintenance');
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'phase.json'), 'utf8'));
  const files: ContentFileSpec[] = spec.files.map((f: { path: string; source: string; editable?: boolean; language?: string }) => ({
    path: f.path,
    content: f.source.startsWith('../') ? '' : fs.readFileSync(path.join(dir, f.source), 'utf8'),
    editable: !!f.editable,
    language: f.language ?? 'plaintext',
  }));
  const checks = key === 'deployment'
    ? ({ kind: 'config', rules: spec.checks.rules, smokeImplFiles: {}, smokeDockerfile: spec.checks.smoke.dockerfile, smokeCommands: [], expectInOutput: '', drill: { fault: spec.checks.drill.fault, description: spec.checks.drill.description, faultedFiles: {}, expectFailure: true } } as ConfigChecks)
    : ({ kind: 'code', editableTargets: spec.checks.editableTargets, visibleTests: [], hiddenTestFiles: {}, solutionFiles: {}, solutionSources: [], runs: [] } as unknown as CodeChecks);
  return { files, checks, rubric: spec.rubric, title: spec.title, intro: spec.intro, taskPanel: fs.readFileSync(path.join(dir, spec.taskFile), 'utf8'), objectives: spec.objectives };
}
