import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { contentDigestManifest } from '../../src/content/blob.store';
import { ContentService } from '../../src/content/content.service';
import type { ProjectContent } from '../../src/content/content.types';
import { DirectoryPackSource } from '../../src/content/pack-source';
import { FIXTURES_DIR } from '../fixtures/paths';
import { runCli } from '../../src/cli/run';

/**
 * Record what the loader produces, as one digest per field group per phase.
 *
 *   npx ts-node --project apps/api/tsconfig.json apps/api/test/cli/content-digests.ts [--pack tasktrackr]
 *
 * Run it with the Node version in `.nvmrc`.
 *
 * The fixture it writes (`apps/api/test/fixtures/<slug>-content-digests.json`)
 * is the golden-equivalence net for the storage swap: `content-golden.spec.ts`
 * holds the on-disk loader against it, and `import-identity.spec.ts` holds
 * the compiled database snapshot against the same numbers, so a swap that moved
 * a byte, reordered a file list or promoted a sealed file into the explorer
 * fails by naming the phase and the group rather than surfacing as a learner's
 * score three services away.
 *
 * Regenerating it is therefore a deliberate act with a reason: a pack's content
 * genuinely changed, and the version in `project.json` was bumped to say so. It
 * is never the fix for a failing swap.
 *
 * Exit codes: 0 written or matching, 1 a pack failed to load or, with
 * `--check`, a fixture differs, 3 bad usage, 70 an unexpected failure
 * (src/cli/run.ts).
 */

const USAGE = `usage: ts-node test/cli/content-digests.ts [-- <options>]

  --pack <slug>   record one pack (repeatable; default: every pack on disk)
  --check         compare against the committed fixture and write nothing
  --out <dir>     where the fixtures are written (default: apps/api/test/fixtures)
  --pack-dir <dir> record the pack in <dir> instead (repeatable; a directory in the
                  authoring format, e.g. an upload fixture), as <slug>-<version>-content-digests.json
  --help          print this
`;

interface Options {
  packs: string[];
  check: boolean;
  out: string;
  packDirs: string[];
}

function parse(argv: string[]): Options | 'help' | null {
  const options: Options = {
    packs: [],
    check: false,
    out: FIXTURES_DIR,
    packDirs: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return 'help';
    else if (arg === '--check') options.check = true;
    else if (arg === '--pack') options.packs.push(argv[(i += 1)]);
    else if (arg === '--out') options.out = argv[(i += 1)];
    else if (arg === '--pack-dir') options.packDirs.push(argv[(i += 1)]);
    else {
      process.stderr.write(`unknown option: ${arg}\n`);
      return null;
    }
  }
  if (!options.packDirs.every((dir) => typeof dir === 'string' && dir.length > 0)) return null;
  if (options.packDirs.length && options.packs.length) {
    process.stderr.write('--pack and --pack-dir record different things; pass one or the other\n');
    return null;
  }
  return options.packs.every((slug) => typeof slug === 'string' && slug.length > 0)
    ? options
    : null;
}

/** The committed fixture for one pack, whether or not it exists yet. */
export function fixturePathFor(slug: string, dir: string): string {
  return path.join(dir, `${slug}-content-digests.json`);
}

function main(): number {
  const options = parse(process.argv.slice(2));
  if (options === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options === null) {
    process.stderr.write(USAGE);
    return 3;
  }
  if (options.packDirs.length) return recordPackDirs(options);

  const content = new ContentService();
  try {
    content.loadAll();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const wanted = options.packs.length
    ? content.listProjects().filter((p) => options.packs.includes(p.slug))
    : content.listProjects();
  const missing = options.packs.filter((slug) => !wanted.some((p) => p.slug === slug));
  if (missing.length) {
    process.stderr.write(`unknown project: ${missing.join(', ')}\n`);
    return 1;
  }

  let differed = false;
  for (const project of wanted) {
    const same = writeOrCheck(project, fixturePathFor(project.slug, options.out), options.check);
    differed = differed || !same;
  }
  return differed ? 1 : 0;
}

/**
 * Write one pack's digests to `at`, or with `check` compare them with what is
 * there and write nothing, and print one line either way. False only when a
 * check found the fixture different (or missing).
 */
function writeOrCheck(project: ProjectContent, at: string, check: boolean): boolean {
  const manifest = contentDigestManifest(project);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  if (check) {
    const recorded = fs.existsSync(at) ? fs.readFileSync(at, 'utf-8') : '';
    const same = recorded === body;
    process.stdout.write(
      `${project.slug} ${project.version}: ${same ? 'matches' : 'DIFFERS FROM'} ${at}\n`,
    );
    return same;
  }
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, body, 'utf-8');
  process.stdout.write(
    `${project.slug} ${project.version}: ${Object.keys(manifest.phases).length} phases -> ${at}\n`,
  );
  return true;
}

/**
 * The fixture for a pack read from a directory rather than from CONTENT_DIR
 * (the upload fixtures), named for its version as well as its slug so it
 * can never be mistaken for, or overwrite, a `<slug>-content-digests.json`.
 */
export function packDirFixturePathFor(slug: string, version: string, dir: string): string {
  return path.join(dir, `${slug}-${version}-content-digests.json`);
}

/**
 * `--pack-dir`: record each named directory's pack, read through the same
 * loader the boot uses, and nothing from CONTENT_DIR. TaskTrackr's fixture
 * is written and checked by the default path alone.
 */
function recordPackDirs(options: Options): number {
  const content = new ContentService();
  let differed = false;
  for (const dir of options.packDirs) {
    let project;
    try {
      project = content.loadProject(new DirectoryPackSource(path.resolve(dir)));
    } catch (err) {
      process.stderr.write(`${dir}: ${(err as Error).message}\n`);
      return 1;
    }
    const same = writeOrCheck(project, packDirFixturePathFor(project.slug, project.version, options.out), options.check);
    differed = differed || !same;
  }
  return differed ? 1 : 0;
}

/** For `upload-packs.spec.ts`: the option parser and the `--pack-dir` path, called in-process. */
export { parse as parseOptions, recordPackDirs };

if (require.main === module) void runCli(async () => main());
