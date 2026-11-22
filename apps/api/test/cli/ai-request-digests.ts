import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { readSharedFromSource } from './shared-from-source';
import type * as Golden from '../ai-request-golden';

/**
 * Record what TaskTrackr's model calls send, as one sha256 per request body.
 *
 *   npx ts-node --project apps/api/tsconfig.json apps/api/test/cli/ai-request-digests.ts [--check] [--payload trim | --variant strict]
 *
 * The fixture it writes: `apps/api/test/fixtures/tasktrackr-ai-request-digests.json`:
 * is the request-bytes golden net: `src/assistant/ai-request-golden.spec.ts`
 * holds the real `OpenAiProvider` against it, so a step that scoped a prompt
 * and moved one byte of a TaskTrackr request fails by naming the scenario, the
 * phase, the call and the surface. Digests only: no body, prompt or key is
 * written (see `test/ai-request-golden.ts`).
 *
 * It lives under `test/` beside `verdict-digests.ts`, and not in `src/cli/`,
 * because it imports the recorder from `test/`: the production build compiles
 * with `rootDir: src`, so the same file under `src/` stops `npm run build`
 * (TS6059) and with it the API image: `build-boundary.spec.ts` holds that line.
 *
 * **It reads `@learnsdlc/shared` from source, as the spec does.** Jest maps the
 * package to `packages/shared/src/index.ts`; plain Node would resolve it to the
 * built `dist/`, and a stale build would then make `--check` disagree with the
 * spec about bytes neither of them changed. The resolver below points this
 * process at the same source file before anything imports it.
 *
 * Regenerating it is a deliberate act with a reason: a planned change to a
 * reference prompt, declared per surface in the change that makes it. It is
 * never the fix for a failing step.
 *
 * Exit codes: 0 written (or matches under --check), 1 the pack failed to load,
 * a recording failed, or a digest differs, 3 bad usage.
 */

const USAGE = `usage: ts-node test/cli/ai-request-digests.ts [-- <options>]

  --check         compare against the committed fixture and write nothing
  --out <dir>     where the fixture is written (default: apps/api/test/fixtures)
  --payload trim  record with AI_AGENTIC_PAYLOAD=trim, against the trim fixture
                  (tasktrackr-ai-request-digests-trim.json); without it, the
                  shipped default, full, against the default fixture
  --variant strict
                  record with AI_AGENTIC_EDIT_LIST=strict (payload full), as the
                  preview ships, against the strict fixture
                  (tasktrackr-ai-request-digests-strict.json); without it, the
                  code default, off
  --help          print this
`;

interface Options {
  check: boolean;
  out: string | null;
  payload: 'trim' | null;
  variant: 'strict' | null;
}

function parse(argv: string[]): Options | 'help' | null {
  const options: Options = { check: false, out: null, payload: null, variant: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return 'help';
    else if (arg === '--check') options.check = true;
    else if (arg === '--out') {
      const dir = argv[(i += 1)];
      if (typeof dir !== 'string' || !dir.length) return null;
      options.out = dir;
    } else if (arg === '--payload') {
      const mode = argv[(i += 1)];
      if (mode !== 'trim') return null;
      options.payload = mode;
    } else if (arg === '--variant') {
      const variant = argv[(i += 1)];
      if (variant !== 'strict') return null;
      options.variant = variant;
    } else {
      process.stderr.write(`unknown option: ${arg}\n`);
      return null;
    }
  }
  // One setting moved per fixture: the trim payload is recorded with the edit list off, the strict list with the payload full.
  if (options.payload && options.variant) return null;
  return options;
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

  readSharedFromSource();
  // Loaded after the resolver, so every module below reads the shared source.
  const { Logger } = require('@nestjs/common') as typeof import('@nestjs/common');
  const { ContentService } = require('../../src/content/content.service') as typeof import('../../src/content/content.service');
  const golden = require('../ai-request-golden') as typeof Golden;
  const { config } = require('../../src/config') as typeof import('../../src/config');
  // The default records the shipped mode whatever this shell's environment says.
  config.agenticPayload = options.payload ?? 'full';
  // And the code default's edit list, off, unless the strict variant is asked for.
  config.agenticEditList = options.variant ?? 'off';

  // Every model call logs an `ai_call` line; the output is the one line below.
  Logger.overrideLogger(false);

  const content = new ContentService();
  try {
    content.loadAll();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const manifest = await golden.recordAiRequests(content);
  const at = golden.aiRequestFixturePath(options.out ?? undefined, options.payload ?? options.variant ?? undefined);
  const body = golden.serialiseAiRequestFixture(manifest);
  const label = `${manifest.pack} ${manifest.version} (${manifest.model}, effort ${manifest.effort}${options.payload ? `, payload ${options.payload}` : ''}${options.variant ? `, edit list ${options.variant}` : ''})`;

  // The trim mode may move only agentic.generate bodies: list the ones it
  // moved against the default fixture, and refuse any other surface.
  if (options.payload) {
    const shipped = golden.readAiRequestFixture(options.out ?? undefined);
    if (!shipped || shipped.entries.length !== manifest.entries.length) {
      process.stdout.write(`the default fixture is missing or has another scenario count\n`);
      return 1;
    }
    const moved = manifest.entries.filter((entry, index) => entry.sha256 !== shipped.entries[index].sha256 || golden.entryKey(entry) !== golden.entryKey(shipped.entries[index]));
    for (const entry of moved) process.stdout.write(`moved by ${options.payload}: ${golden.entryKey(entry)}\n`);
    const outside = moved.filter((entry) => entry.surface !== 'agentic.generate');
    if (outside.length) {
      process.stdout.write(`${outside.length} moved bodies are not agentic.generate\n`);
      return 1;
    }
  }

  // The strict variant may move only the Agentic generation bodies, which it
  // records as agentic.generate.edits, and appends the one regeneration
  // scenario and the one prompt assessment re-ask, in that order:
  // list what moved against the default fixture, refuse anything else.
  if (options.variant) {
    const shipped = golden.readAiRequestFixture(options.out ?? undefined);
    const edits = (entry: Golden.AiRequestEntry): Golden.AiRequestEntry => entry.surface === 'agentic.generate' ? { ...entry, surface: 'agentic.generate.edits' } : entry;
    if (!shipped || manifest.entries.length < shipped.entries.length) {
      process.stdout.write(`the default fixture is missing or has more scenarios than the strict recording\n`);
      return 1;
    }
    const before = manifest.entries.slice(0, shipped.entries.length);
    const keyed = before.every((entry, index) => golden.entryKey(entry) === golden.entryKey(edits(shipped.entries[index])));
    const moved = before.flatMap((entry, index) => entry.sha256 === shipped.entries[index].sha256 ? [] : [{ entry, grew: entry.length - shipped.entries[index].length }]);
    const appended = manifest.entries.slice(shipped.entries.length);
    for (const { entry, grew } of moved) process.stdout.write(`moved by ${options.variant}: ${golden.entryKey(entry)} (${grew >= 0 ? '+' : ''}${grew} bytes)\n`);
    for (const entry of appended) process.stdout.write(`added by ${options.variant}: ${golden.entryKey(entry)}\n`);
    const outside = moved.filter(({ entry }) => entry.surface !== 'agentic.generate.edits');
    const order = ['agentic:regenerate', 'agentic:classify-reask'];
    const ordered = appended.every((entry, index) => index === 0 || order.indexOf(entry.scenario) >= order.indexOf(appended[index - 1].scenario));
    if (!keyed || outside.length || appended.some((entry) => !order.includes(entry.scenario)) || !ordered) {
      process.stdout.write(`the strict recording moved ${outside.length} bodies that are not agentic generations, or its scenarios are not the default's\n`);
      return 1;
    }
  }

  if (options.check) {
    const held = fs.existsSync(at) ? fs.readFileSync(at, 'utf-8') : '';
    const same = held === body;
    if (!same && held) {
      const moved = golden.firstDifferingEntry((JSON.parse(held) as Golden.AiRequestManifest).entries, manifest.entries);
      if (moved) process.stdout.write(`first difference: ${moved}\n`);
    }
    process.stdout.write(`${label}: ${manifest.entries.length} request bodies ${same ? 'match' : 'DIFFER FROM'} ${at}\n`);
    return same ? 0 : 1;
  }

  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, body, 'utf-8');
  process.stdout.write(`${label}: ${manifest.entries.length} request bodies -> ${at}\n`);
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
