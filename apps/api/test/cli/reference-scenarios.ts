import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { readSharedFromSource } from './shared-from-source';
import type * as Table from '../reference-scenario-table';

/**
 * Record the digests of the reference project's written scenario into
 * `apps/api/src/content/reference-scenarios.ts`.
 *
 *   npx ts-node --project apps/api/tsconfig.json apps/api/test/cli/reference-scenarios.ts [--check]
 *
 * It lives under `test/`: a tool that writes source must not
 * ship in the image, and a `src/` file importing `test/` stops `npm run build`.
 * The generated table is the only runtime file, and it imports nothing.
 *
 * It keeps every row of another pack version and replaces the current
 * version's (a copy of 2.0.1 is still the reference's content when the pack
 * moves on). Recording is a deliberate act (a pack bump, declared in the
 * change that makes it) and never the fix for a failing step.
 *
 * It reads `@learnsdlc/shared` from source, as the specs do, so a stale
 * `packages/shared/dist` can never make `--check` disagree with the drift spec.
 *
 * Exit codes: 0 written (or matches under --check), 1 the pack failed to load
 * or the table differs, 3 bad usage.
 */

const TABLE = path.resolve(__dirname, '..', '..', 'src', 'content', 'reference-scenarios.ts');

const USAGE = `usage: ts-node test/cli/reference-scenarios.ts [--check]

  --check   compare against the committed table and write nothing
  --help    print this
`;

/** The rows the committed table holds now, or none when it has not been recorded yet. */
function heldRows(): readonly import('../../src/content/reference-scenarios').ReferenceScenarioRow[] {
  if (!fs.existsSync(TABLE)) return [];
  return (require('../../src/content/reference-scenarios') as typeof import('../../src/content/reference-scenarios'))
    .REFERENCE_SCENARIOS;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length) {
    process.stderr.write(`unknown option: ${unknown[0]}\n${USAGE}`);
    return 3;
  }
  const check = args.includes('--check');

  readSharedFromSource();
  const { Logger } = require('@nestjs/common') as typeof import('@nestjs/common');
  const { ContentService } = require('../../src/content/content.service') as typeof import('../../src/content/content.service');
  const table = require('../reference-scenario-table') as typeof Table;
  Logger.overrideLogger(false);

  const content = new ContentService();
  try {
    content.loadAll();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const fresh = table.recordReferenceScenarioRows(content);
  const body = table.renderReferenceScenariosModule(table.mergeReferenceScenarioRows(heldRows(), fresh));
  const label = `${table.SCENARIO_PACK} ${fresh[0]?.version ?? '?'}: ${fresh.length} scenario rows`;
  if (check) {
    const held = fs.existsSync(TABLE) ? fs.readFileSync(TABLE, 'utf-8') : '';
    const same = held === body;
    process.stdout.write(`${label} ${same ? 'match' : 'DIFFER FROM'} ${TABLE}\n`);
    return same ? 0 : 1;
  }
  fs.writeFileSync(TABLE, body, 'utf-8');
  process.stdout.write(`${label} -> ${TABLE}\n`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
