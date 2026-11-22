import 'reflect-metadata';
import * as fs from 'fs';
import { Logger } from '@nestjs/common';
import { pluralWord } from '@learnsdlc/shared';

import {
  CHECKS,
  CheckResult,
  ContentCheckReport,
  checkContent,
  loadPacks,
} from './content-check-engine';
import { runCli } from './run';

/**
 * Prove the content packs, in a report a pack author can read.
 *
 *   npm run content:check
 *   npm run content:check -- --quick
 *   npm run content:check -- --pack tasktrackr --json content-report.json
 *
 * Every proof `content.spec.ts` asserts, run as a tool rather than a gate: it
 * keeps going after the first finding and names the file to open. The sandbox
 * proofs run against the real runner, so RUNNER_MODE decides how the code is
 * executed: `local` spawns the harness here, `socket` reaches the runner
 * container, and a runner that cannot be reached is reported as "could not
 * tell", never as a broken pack.
 *
 * Exit codes: 0 clean, 1 a pack is wrong, 2 the checker could not tell
 * (the runner never answered, or a pack failed to load), 3 bad usage, 70 an
 * unexpected failure (cli/run.ts).
 */

const USAGE = `usage: npm run content:check [-- <options>]

  --quick            skip every sandbox proof: the loader and the static invariants only
  --pack <slug>      check one pack (repeatable)
  --only <ids>       run only these check ids, comma separated
  --json <path>      write the report as JSON
  --markdown <path>  write the report as markdown
  --quiet            print the last lines only
  --help             print this

exit codes: 0 clean, 1 a pack is wrong, 2 the checker could not tell, 3 bad usage,
70 an unexpected failure`;

interface Options {
  quick: boolean;
  packs: string[];
  only: string[];
  json: string;
  markdown: string;
  quiet: boolean;
}

function usage(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(3);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { quick: false, packs: [], only: [], json: '', markdown: '', quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) usage(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--quick') options.quick = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--pack') options.packs.push(value());
    else if (arg === '--only') options.only.push(...value().split(',').map((s) => s.trim()).filter(Boolean));
    else if (arg === '--json') options.json = value();
    else if (arg === '--markdown') options.markdown = value();
    else usage(`unknown option ${arg}`);
  }
  return options;
}

/** "tasktrackr", "a and b", "a, b and c": the sentence a person reads. */
const listOf = (names: string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const OUTCOME_WORD: Record<CheckResult['outcome'], string> = {
  ok: 'ok  ',
  defect: 'fail',
  unavailable: 'lost',
  skipped: 'skip',
};

const LABEL_WIDTH = Math.max(...CHECKS.map((c) => c.label.length)) + 2;
const plural = (n: number, one: string): string => `${n} ${pluralWord(n, one)}`;
const seconds = (ms: number): string =>
  ms < 1000 ? 'under a second' : plural(Math.round(ms / 1000), 'second');

function printResult(result: CheckResult): void {
  const label = result.label.padEnd(LABEL_WIDTH, ' ');
  console.log(`    ${OUTCOME_WORD[result.outcome]}  ${label}${result.detail}`);
  for (const line of result.remedy) console.log(`          ${line}`);
  for (const file of [...new Set(result.files)]) console.log(`          open ${file}`);
}

function markdownReport(report: ContentCheckReport): string {
  const rows = report.results.map(
    (r) => `| ${r.pack} | ${r.phase || '—'} | ${r.label} | ${r.outcome} | ${r.detail.replace(/\|/g, ' ')} |`,
  );
  const defects = report.results.filter((r) => r.outcome === 'defect');
  return [
    '# Content check',
    '',
    `${plural(report.packs.length, 'pack')}, ${plural(report.results.length, 'check')}, ${plural(report.defects, 'defect')}, ${seconds(report.durationMs)}.`,
    '',
    '| pack | phase | check | outcome | detail |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...(defects.length
      ? ['## Defects', '', ...defects.flatMap((d) => [`### ${d.pack}, ${d.phase || d.id}: ${d.label}`, '', ...d.remedy.map((line) => `- ${line}`), ...d.files.map((f) => `- open \`${f}\``), ''])]
      : []),
  ].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  // the loader logs one line per pack at boot; the report is the output here
  Logger.overrideLogger(false);

  const load = loadPacks();
  if (!load.packs.length) {
    console.error(
      `No content packs found in ${load.dir}. CONTENT_DIR names the directory that holds them.`,
    );
    return 2;
  }
  for (const slug of options.packs) {
    if (!load.packs.includes(slug)) {
      console.error(
        `No pack named "${slug}". The packs in ${load.dir} are ${listOf(load.packs)}.`,
      );
      return 3;
    }
  }
  for (const id of options.only) {
    if (!CHECKS.some((c) => c.id === id)) {
      console.error(`No check named "${id}". The checks are ${listOf(CHECKS.map((c) => c.id))}.`);
      return 3;
    }
  }

  const projects = load.projects.filter((p) => !options.packs.length || options.packs.includes(p.slug));
  if (!options.quiet) {
    const what = options.quick
      ? ', the loader and the static invariants only'
      : ' against the real sandbox';
    console.log(`\n==> Checking ${plural(projects.length, 'content pack')}${what}\n`);
  }

  let printing = '';
  const report = await checkContent({
    projects,
    quick: options.quick,
    only: options.only,
    onResult: (result) => {
      if (options.quiet) return;
      if (result.pack !== printing) {
        printing = result.pack;
        const pack = packHeading(projects, result.pack);
        console.log(`  ${pack}`);
      }
      printResult(result);
    },
  });

  if (options.json) fs.writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
  if (options.markdown) fs.writeFileSync(options.markdown, `${markdownReport(report)}\n`);

  // the packs that never loaded: the loader's own message, then what it means
  for (const failure of load.failures) {
    console.error('');
    if (failure.message) console.error(failure.message);
    console.error(`${failure.pack} could not be loaded, so nothing about it was checked.`);
  }

  const packs = plural(report.packs.length, 'pack');
  const checks = plural(report.results.length, 'check');
  console.log('');
  if (report.defects > 0) {
    console.log(
      `==> ${plural(report.defects, 'defect')} across ${packs}, ${checks}, ${seconds(report.durationMs)}`,
    );
    for (const defect of report.results.filter((r) => r.outcome === 'defect')) {
      console.log(`    ${defect.pack}, ${defect.phase || defect.id}: ${defect.label}`);
    }
  } else if (options.quick) {
    console.log(
      `==> ${packs}, ${plural(report.results.length - report.skipped, 'check')}, sandbox proofs skipped (drop --quick before you commit)`,
    );
  } else if (report.unavailable > 0) {
    console.log(
      `==> ${packs}, ${checks}, ${report.unavailable} not run, no defects. ${seconds(report.durationMs)}`,
    );
  } else {
    console.log(`==> ${packs}, ${checks}, no defects. ${seconds(report.durationMs)}`);
  }

  if (report.unavailable > 0) {
    // each lost check says why in its own words: "the runner could not be
    // reached" and "this transport cannot run an app at all" are different
    // facts about the machine, and both are "could not tell"
    console.error(`\n${plural(report.unavailable, 'check')} could not be run:`);
    for (const lost of report.results.filter((r) => r.outcome === 'unavailable')) {
      console.error(`    ${lost.label} — ${lost.detail}`);
    }
    console.error(
      'Nothing here says the packs are wrong. Start the runner with scripts/start.sh, or run with --quick.',
    );
  }

  if (report.defects > 0) return 1;
  if (report.unavailable > 0 || load.failures.length > 0) return 2;
  return 0;
}

/** The pack heading: slug, version, language, phase count. */
function packHeading(projects: { slug: string; version: string; language: string; phases: unknown[] }[], slug: string): string {
  const project = projects.find((p) => p.slug === slug);
  if (!project) return slug;
  return `${project.slug} ${project.version}, ${project.language}, ${project.phases.length} phases`;
}

void runCli(() => main(process.argv.slice(2)));
