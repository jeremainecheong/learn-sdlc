/**
 * The Deadline badge pack, for the web tests that draw its page.
 *
 * The pack is the tracked upload fixture `apps/api/test/fixtures/upload-packs/deadline-badge`,
 * the same folder the browser tests zip and upload. A room's files are read
 * from it as the learner's workspace holds them: every file under the phase's
 * `files/` (editable) and `readonly/` (locked) folders, keyed by workspace path.
 *
 * The learner's finished work for each room is not in the pack, which seals
 * its reference answers behind a marker line and holds no learner tests. It is
 * kept in `test/fixtures/deadline-badge-web.json` (its `learner` half), which
 * the browser tests type into the rooms as well.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { repoPath, WEB_ROOT } from './paths';

/** The pack's folder on disk. */
export const DEADLINE_BADGE_PACK = repoPath('apps/api/test/fixtures/upload-packs/deadline-badge');

/** The pack's phase folders, in their order (`01-requirements` to `06-maintenance`). */
export function deadlineBadgePhases(): string[] {
  return readdirSync(join(DEADLINE_BADGE_PACK, 'phases')).sort();
}

/** Every file under one folder of a phase (`files`, `readonly`, `solution`, ...), by its path from that folder; empty when the folder is absent. */
export function deadlineBadgeFolder(phase: string, sub: string): Record<string, string> {
  const root = join(DEADLINE_BADGE_PACK, 'phases', phase, sub);
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name);
      if (statSync(at).isDirectory()) walk(at);
      else out[relative(root, at).split(sep).join('/')] = readFileSync(at, 'utf8');
    }
  };
  walk(root);
  return out;
}

/** What a room shows: its editable files and its locked files, as the phase detail lists them. */
export function deadlineBadgeRoom(phase: string): Record<string, string> {
  return { ...deadlineBadgeFolder(phase, 'files'), ...deadlineBadgeFolder(phase, 'readonly') };
}

const LEARNER_WORK = JSON.parse(readFileSync(join(WEB_ROOT, 'test/fixtures/deadline-badge-web.json'), 'utf8')) as {
  learner: Record<string, Record<string, string>>;
};

/** The learner's finished files for one room (Implementation, Testing or Maintenance), by workspace path. */
export function deadlineBadgeLearnerWork(phase: string): Record<string, string> {
  const work = LEARNER_WORK.learner[phase];
  if (!work) throw new Error(`no learner work for ${phase} in the Deadline badge fixture`);
  return { ...work };
}
