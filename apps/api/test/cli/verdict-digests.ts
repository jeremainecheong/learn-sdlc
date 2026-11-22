import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { assertGradingFanout, config, gradingFanoutAtLoad } from '../../src/config';
import { ContentService } from '../../src/content/content.service';
import { compilePack } from '../../src/content/pack-compiler';
import { DirectoryPackSource } from '../../src/content/pack-source';
import {
  recordVerdicts,
  serialiseVerdictFixture,
  verdictFixturePathFor,
} from '../verdict-golden';
import { FIXTURES_DIR } from '../fixtures/paths';

/**
 * Record what the grader produces, as one digest and one microVM sequence per
 * phase.
 *
 *   npx ts-node --project apps/api/tsconfig.json apps/api/test/cli/verdict-digests.ts [--pack tasktrackr]
 *
 * The fixture it writes: `apps/api/test/fixtures/<slug>-verdict-digests.json`:
 * is the verdict-golden net for the task grain: `verdict-golden.spec.ts`
 * holds the grader against it, so a step that threaded a task through a builder
 * and changed what the shipped project scores fails by naming the phase and the
 * check rather than surfacing as a learner's mark.
 *
 * It lives under `test/` and not beside its twin in `src/cli/` because it
 * imports the recorder from `test/`: the production build compiles with
 * `rootDir: src`, so the same file under `src/` stops `npm run build` (TS6059)
 * and with it the API image: `build-boundary.spec.ts` holds that line.
 *
 * `test/cli/content-digests.ts` records the same kind of promise one layer
 * earlier (what the **loader** produces) and this one is deliberately its
 * twin, down to the options and the exit codes.
 *
 * Regenerating it is a deliberate act with a reason: the pack's content
 * genuinely changed and `project.json`'s version was bumped to say so. It is
 * never the fix for a failing step.
 *
 * Exit codes: 0 written, 1 a pack failed to load or a digest differs, 3 bad
 * usage or a grading fan-out the API's boot would refuse. The loaded fan-out
 * (`fanout=<n|off> speculativeMutants=<on|off>`) is printed to stderr first.
 */

const USAGE = `usage: ts-node test/cli/verdict-digests.ts [-- <options>]

  --pack <slug>   record one pack (repeatable; default: every pack on disk)
  --check         compare against the committed fixture and write nothing
  --out <dir>     where the fixtures are written (default: apps/api/test/fixtures)
  --pack-dir <dir> record the pack in <dir> instead (repeatable; a directory in the
                  authoring format, e.g. an upload fixture), as <slug>-<version>-verdict-digests.json
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

type LoadedFanout = { runFanout: number | null; speculativeMutants: boolean };

const fanoutWords = (value: LoadedFanout) =>
  `fanout=${value.runFanout ?? 'off'} speculativeMutants=${value.speculativeMutants ? 'on' : 'off'}`;

/**
 * The grading fan-out this process grades with, checked before anything is
 * graded. `config` loads a refused value as today's serial grader (only the
 * API's boot refuses it), so a check "in fan-out mode" could prove the serial
 * path and exit 0. Here a value the API's boot would refuse is refused, a
 * loaded value that differs from the environment is refused, and the loaded
 * values are returned as one line for stderr.
 */
export function fanoutPreflight(
  env: NodeJS.ProcessEnv = process.env,
  loaded: LoadedFanout = { runFanout: config.gradingRunFanout, speculativeMutants: config.gradingSpeculativeMutants },
): { line: string } | { error: string } {
  if (env.GRADING_RUN_FANOUT !== undefined || env.GRADING_SPECULATIVE_MUTANTS !== undefined) {
    try {
      assertGradingFanout(env);
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  const wanted = gradingFanoutAtLoad(env);
  if (wanted.runFanout !== loaded.runFanout || wanted.speculativeMutants !== loaded.speculativeMutants) {
    return { error: `the grader loaded ${fanoutWords(loaded)} but the environment says ${fanoutWords(wanted)}` };
  }
  return { line: fanoutWords(loaded) };
}

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  if (options === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options === null) {
    process.stderr.write(USAGE);
    return 3;
  }
  const fanout = fanoutPreflight();
  if ('error' in fanout) {
    process.stderr.write(`${fanout.error}\n`);
    return 3;
  }
  process.stderr.write(`${fanout.line}\n`);
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
  for (const listed of wanted) {
    const project = content.getProject(listed.slug);
    const { sandboxBudgetByPhase } = compilePack(project);
    const manifest = await recordVerdicts(content, listed.slug, sandboxBudgetByPhase);
    const at = verdictFixturePathFor(listed.slug, options.out);
    const body = serialiseVerdictFixture(manifest);
    if (options.check) {
      const held = fs.existsSync(at) ? fs.readFileSync(at, 'utf-8') : '';
      const same = held === body;
      differed = differed || !same;
      process.stdout.write(
        `${listed.slug} ${project.version}: ${same ? 'matches' : 'DIFFERS FROM'} ${at}\n`,
      );
      continue;
    }
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, body, 'utf-8');
    const jobs = Object.values(manifest.phases).reduce((sum, phase) => sum + phase.jobs.length, 0);
    process.stdout.write(
      `${listed.slug} ${project.version}: ${Object.keys(manifest.phases).length} phases, ${jobs} sandbox jobs -> ${at}\n`,
    );
  }
  return differed ? 1 : 0;
}

/**
 * The fixture for a pack read from a directory rather than from CONTENT_DIR
 * (the upload fixtures), named for its version as well as its slug so it
 * can never be mistaken for, or overwrite, a `<slug>-verdict-digests.json`.
 */
export function packDirVerdictFixturePathFor(slug: string, version: string, dir: string): string {
  return path.join(dir, `${slug}-${version}-verdict-digests.json`);
}

/**
 * `--pack-dir`: grade each named directory's pack against the recording
 * sandbox, with that pack installed as the only published version, and
 * nothing from CONTENT_DIR. The default path above never comes through here,
 * so TaskTrackr's fixture is written and checked without it.
 */
async function recordPackDirs(options: Options): Promise<number> {
  let differed = false;
  for (const dir of options.packDirs) {
    const content = new ContentService();
    let project;
    try {
      project = content.loadProject(new DirectoryPackSource(path.resolve(dir)));
    } catch (err) {
      process.stderr.write(`${dir}: ${(err as Error).message}\n`);
      return 1;
    }
    content.installVersions([{ versionId: `${project.slug}@${project.version}`, content: project }]);
    const { sandboxBudgetByPhase } = compilePack(project);
    const { result: manifest, errors } = await withLoggedErrors(() =>
      recordVerdicts(content, project.slug, sandboxBudgetByPhase),
    );
    if (errors) {
      // The grader catches a failing report section and logs it rather than
      // fail the grade, so the run would succeed with a hole in every report it
      // touched. A golden recorded over that hole is wrong, so nothing is
      // written and nothing is compared.
      process.stderr.write(
        `${project.slug} ${project.version}: ${errors} error(s) logged while grading; refusing to record a degraded fixture\n`,
      );
      return 1;
    }
    const at = packDirVerdictFixturePathFor(project.slug, project.version, options.out);
    const body = serialiseVerdictFixture(manifest);
    if (options.check) {
      const held = fs.existsSync(at) ? fs.readFileSync(at, 'utf-8') : '';
      const same = held === body;
      differed = differed || !same;
      process.stdout.write(
        `${project.slug} ${project.version}: ${same ? 'matches' : 'DIFFERS FROM'} ${at}\n`,
      );
      continue;
    }
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, body, 'utf-8');
    const jobs = Object.values(manifest.phases).reduce((sum, phase) => sum + phase.jobs.length, 0);
    process.stdout.write(
      `${project.slug} ${project.version}: ${Object.keys(manifest.phases).length} phases, ${jobs} sandbox jobs -> ${at}\n`,
    );
  }
  return differed ? 1 : 0;
}

/**
 * Run `work` and count what it logs at error level through the app logger
 * (where `captureException` writes every error the grader swallows).
 */
async function withLoggedErrors<T>(work: () => Promise<T>): Promise<{ result: T; errors: number }> {
  const original = Logger.prototype.error;
  let errors = 0;
  Logger.prototype.error = function counted(this: Logger, ...args: unknown[]) {
    errors += 1;
    return (original as (...a: unknown[]) => void).apply(this, args);
  } as typeof original;
  try {
    return { result: await work(), errors };
  } finally {
    Logger.prototype.error = original;
  }
}

/** For `upload-packs.spec.ts`: the option parser and the `--pack-dir` path, called in-process. */
export { parse as parseOptions, recordPackDirs };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
