import 'reflect-metadata';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../db/database.module';
import { ContentService } from '../content/content.service';
import { ProjectImporterService, type ImportResult } from '../content/importer.service';
import { describeFirstPublishPins, describeImport } from '../content/import-report';
import { DirectoryPackSource } from '../content/pack-source';
import { NullPinService } from '../seed/null-pin.service';
import { config } from '../config';
import { runCli } from './run';

/**
 * Import a pack directory into the store, compile it and publish it.
 *
 *   npx ts-node --project apps/api/tsconfig.json apps/api/src/cli/import-pack.ts \
 *     [--pack content/tasktrackr | --all] [--default]
 *
 * Run it with the Node version in `.nvmrc`.
 *
 * The API does the same work at every boot for everything under `CONTENT_DIR`
 * (`SeedService.importPlatformContent`), which is how the platform's own pack
 * ships. This command is for the other cases: a pack that lives somewhere else,
 * a machine where the boot has not been run yet, and the operator who wants the
 * refusal on a terminal rather than in a log nobody is watching.
 *
 * It decides nothing the boot does not decide. Idempotence is the importer's
 * (`(slug, version)` and a digest of the pack's own bytes), so running this
 * twice is a no-op and running it after an unbumped content change refuses by
 * name. One answer differs from the boot's, on purpose: a pack whose slug a
 * teacher's project holds is refused by name here (exit 1), where the boot
 * skips it with one line so that it can still start.
 *
 * Exit codes: 0 imported, 1 a pack was refused, 3 bad usage, 70 an unexpected
 * failure (cli/run.ts).
 */

const USAGE = `usage: ts-node src/cli/import-pack.ts [options]

  --pack <dir>    a pack directory holding a project.json (repeatable)
  --all           every pack under CONTENT_DIR (${config.contentDir})
  --default       flag the imported project as the one a request naming none answers for
  --help          print this
`;

interface Options {
  packs: string[];
  all: boolean;
  makeDefault: boolean;
}

export function parse(argv: string[]): Options | 'help' | null {
  const options: Options = { packs: [], all: false, makeDefault: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return 'help';
    else if (arg === '--all') options.all = true;
    else if (arg === '--default') options.makeDefault = true;
    else if (arg === '--pack') options.packs.push(argv[(i += 1)]);
    else {
      process.stderr.write(`unknown option: ${arg}\n`);
      return null;
    }
  }
  if (!options.packs.every((at) => typeof at === 'string' && at.length > 0)) return null;
  // Exactly one of the two: naming both, or neither, is a command that has not
  // said which packs it means.
  const named = options.packs.length > 0;
  if (options.all === named) return null;
  return options;
}

export interface ImportOutput {
  log: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Open the store, import what was asked for, print one line each, and close it.
 * Takes its options rather than reading the environment so a spec can point it
 * at a scratch file.
 */
export async function importPacks(
  options: Options,
  out: ImportOutput = { log: console.log, error: console.error },
): Promise<number> {
  const dataSource = await new DataSource({
    ...buildDataSourceOptions(),
    migrationsRun: false,
    synchronize: false,
  }).initialize();
  const importer = new ProjectImporterService(new ContentService(), dataSource);
  try {
    // First, as at boot: a stored null pin is pinned to the version it reads
    // before this import can publish another. A pass that
    // cannot finish is printed like a refused pack, and nothing is imported.
    await new NullPinService(dataSource).run();
    const results: ImportResult[] = [];
    if (options.all) {
      results.push(
        ...(await importer.importContentDirectory(config.contentDir, {
          origin: 'seed',
          platformOwned: true,
          defaultSlug: options.makeDefault ? config.defaultProject : undefined,
          // Refused by name, unlike the boot's skip: the operator asked for
          // this directory, and the refusal aborts its one transaction, so
          // nothing from it is imported and the command exits 1.
          heldSlug: 'refuse',
        })),
      );
    } else {
      for (const at of options.packs) {
        const result = await importer.importPack(
          new DirectoryPackSource(path.resolve(at)),
          { origin: 'seed', platformOwned: true, heldSlug: 'refuse' },
        );
        out.log(describeImport(result));
        const pins = describeFirstPublishPins(result);
        if (pins) out.log(pins);
        results.push(result);
      }
    }
    return results.length ? 0 : 1;
  } catch (error) {
    // The loader's and the importer's refusals are written for a person: a
    // sentence naming the file, the field or the version to bump. Printing the
    // message rather than a stack is the whole point of having the command.
    out.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await dataSource.destroy().catch(() => undefined);
  }
}

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);
  if (options === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options === null) {
    process.stderr.write(USAGE);
    return 3;
  }
  return importPacks(options);
}

if (require.main === module) void runCli(() => main(process.argv.slice(2)));
