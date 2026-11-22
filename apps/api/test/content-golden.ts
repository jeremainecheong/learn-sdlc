import * as fs from 'fs';
import type { ProjectFileRole } from '@learnsdlc/shared';
import {
  ContentDigestManifest,
  PhaseDigests,
  canonicalJson,
  contentDigestManifest,
  digestOf,
  mountedPathsOf,
  projectHeaderOf,
  sealedFilesOf,
  sealedGroupOf,
  sealedPathsOf,
} from '../src/content/blob.store';
import type { PhaseContent, ProjectContent } from '../src/content/content.types';
import { fixturePathFor } from './cli/content-digests';
import { FIXTURES_DIR } from './fixtures/paths';

/**
 * The golden-equivalence net for content storage (teacher-authored projects).
 *
 * A project is served out of Postgres rather than out of the image, and the
 * promise is that no learner can tell. The way that promise is kept honest is
 * this: the directory loader's output is recorded as one sha256 per phase per
 * field group, and every other source of content (the compiler, the compiled
 * snapshot, the registry that reads it) is held against the same numbers. A
 * storage path that dropped a rubric criterion, reordered the
 * explorer, lost a mutant or promoted a hidden test into `files[]` fails by
 * naming the phase and the group.
 *
 * The digest engine itself is production code (`content/blob.store.ts`), because
 * the importer computes a published version's `contentDigest` with the same
 * canonicaliser. This module is the specs' half: reading the committed fixture,
 * comparing a manifest against it, and the sealed-path facts the third golden
 * test asserts.
 */

export type { ContentDigestManifest, PhaseDigests };
export {
  canonicalJson,
  contentDigestManifest,
  digestOf,
  mountedPathsOf,
  projectHeaderOf,
  sealedFilesOf,
  sealedGroupOf,
  sealedPathsOf,
};

/** The field groups every phase is recorded under, in the order a failure reads them. */
export const DIGEST_GROUPS: (keyof PhaseDigests)[] = [
  'header',
  'files',
  'checks',
  'rubric',
  'assistant',
  'runtime',
  'preview',
  'sealed',
  'sealedPaths',
];

/**
 * The recorded digests for one pack.
 *
 * A missing fixture is a sentence naming the CLI that writes it rather than an
 * `ENOENT`: the fixture is generated, and a reader who has just added a pack
 * needs to be told that rather than shown a stack.
 */
export function readGoldenDigests(slug: string, dir: string = FIXTURES_DIR): ContentDigestManifest {
  const at = fixturePathFor(slug, dir);
  if (!fs.existsSync(at)) {
    throw new Error(
      `no recorded digests for "${slug}" (${at}): run apps/api/test/cli/content-digests.ts to write them`,
    );
  }
  return JSON.parse(fs.readFileSync(at, 'utf-8')) as ContentDigestManifest;
}

/** One field group that moved, in the words the assertion prints. */
export interface DigestDifference {
  phaseKey: string;
  group: keyof PhaseDigests;
  recorded: string;
  actual: string;
}

/**
 * Every phase field group of `project` that does not match what was recorded.
 *
 * A phase the fixture does not know, or one the pack no longer ships, is
 * reported as a difference of its own so that a phase list that changed cannot
 * pass by having nothing to compare.
 */
export function digestDifferences(
  project: ProjectContent,
  recorded: ContentDigestManifest,
): DigestDifference[] {
  const manifest = contentDigestManifest(project);
  const out: DigestDifference[] = [];
  const keys = new Set([...Object.keys(recorded.phases), ...Object.keys(manifest.phases)]);
  for (const phaseKey of keys) {
    const before = recorded.phases[phaseKey];
    const after = manifest.phases[phaseKey];
    if (!before || !after) {
      out.push({
        phaseKey,
        group: 'header',
        recorded: before ? 'recorded' : 'no such phase',
        actual: after ? 'loaded' : 'no such phase',
      });
      continue;
    }
    for (const group of DIGEST_GROUPS) {
      if (before[group] !== after[group]) {
        out.push({ phaseKey, group, recorded: before[group], actual: after[group] });
      }
    }
  }
  return out;
}

/** A difference, as the one line a failure should read. */
export function describeDifference(difference: DigestDifference): string {
  return `${difference.phaseKey}: ${difference.group} moved (recorded ${difference.recorded.slice(0, 12)}, loaded ${difference.actual.slice(0, 12)})`;
}

/* --------------------------- the sealed-set facts -------------------------- */

/** The sealed paths of one role, sorted, or `[]` when the phase holds none. */
export function sealedPathsFor(phase: PhaseContent, role: ProjectFileRole): string[] {
  return sealedPathsOf(phase)[role] ?? [];
}

/**
 * How one sealed role sits against the phase's workspace: the paths it holds,
 * and how many of them the phase mounts, locked or editable.
 *
 * The three numbers are what the fourth isolation seal is a statement about. A
 * `hidden` file must be mounted nowhere; a `solution` file must be at the very
 * path the learner edits; a `support` file must be a locked file the learner
 * can read, because they are told to import it.
 */
export interface SealedRoleFacts {
  paths: string[];
  mounted: string[];
  mountedEditable: string[];
  unmounted: string[];
}

export function sealedRoleFacts(phase: PhaseContent, role: ProjectFileRole): SealedRoleFacts {
  const mounted = mountedPathsOf(phase);
  const paths = sealedPathsFor(phase, role);
  return {
    paths,
    mounted: paths.filter((at) => mounted.has(at)),
    mountedEditable: paths.filter((at) => mounted.get(at) === true),
    unmounted: paths.filter((at) => !mounted.has(at)),
  };
}
