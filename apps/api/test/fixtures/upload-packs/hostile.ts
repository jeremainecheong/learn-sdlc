import * as path from 'path';
import {
  RUN_SHAPE_REFUSAL_CODES,
  RunShapeRefusalCode,
  UploadRefusalCode,
  uploadRefusalForRunShape,
} from '@learnsdlc/shared';
import { crc32Of, entriesOf, writeZip, ZipEntrySpec } from './archive';
import { SHELF_MARKERS } from './markers';

/**
 * The hostile set: one archive per attack, each built in memory from the
 * clean Shelf pack archive with exactly one thing changed.
 *
 * `expectedCode` names the one code each refused archive must draw, from the
 * shared contract (`@learnsdlc/shared`; this file keeps no copy of either list): an
 * archive attack from `UPLOAD_REFUSAL_CODES`, or a run-shape finding from
 * `RUN_SHAPE_REFUSAL_CODES`. The two are different levels: the upload door
 * answers a run-shape finding with `RUN_SHAPE_NOT_ALLOWED` or
 * `RUN_LIMIT_ABOVE_LEARNER` and carries the finding in `findings[]`, so
 * `expectedUploadCode` is the door's code, derived here with the shared contract's
 * `uploadRefusalForRunShape`. Compare a refusal's `code` with
 * `expectedUploadCode`, and a finding's `code` with `expectedCode`.
 *
 * One entry is not a refusal: `slug-tasktrackr`. D-X2 and skeptic m3 say the
 * slug is minted from the title and never read from the archive, so an archive
 * whose project.json names `tasktrackr` is imported like any other, under a
 * minted slug that is never `tasktrackr` (`mintedSlugIsNot`). Its
 * `expectedOutcome` is `accepted` and both codes are null.
 *
 * `touches` lists the archive entries the attack adds, removes or changes (a
 * trailing `*` is a prefix), and the fixture spec proves nothing outside it
 * moved.
 *
 * The bombs are generated, never committed, and are memoised per process so a
 * spec that builds each archive several times pays for it once.
 */

export type HostileExpectedCode = UploadRefusalCode | RunShapeRefusalCode;

export interface HostileArchive {
  name: string;
  /** One sentence: what the archive does. */
  attack: string;
  build(): Buffer;
  /** The finding or refusal code it must draw; null when it is accepted. */
  expectedCode: HostileExpectedCode | null;
  /** `refused` for every attack but the one the importer never reads. */
  expectedOutcome: 'refused' | 'accepted';
  /** The upload door's own code (the shared `uploadRefusalForRunShape` for a run-shape finding); null when accepted. */
  expectedUploadCode: UploadRefusalCode | null;
  /** For an accepted archive: the slug the import must never mint. */
  mintedSlugIsNot?: string;
  touches: string[];
}

/** An entry as written below; its outcome and its door code are derived. */
type HostileEntry = Omit<HostileArchive, 'expectedOutcome' | 'expectedUploadCode'>;

const RUN_SHAPE_CODES: readonly string[] = RUN_SHAPE_REFUSAL_CODES;

function withOutcome(entry: HostileEntry): HostileArchive {
  const code = entry.expectedCode;
  if (code === null) return { ...entry, expectedOutcome: 'accepted', expectedUploadCode: null };
  const door = RUN_SHAPE_CODES.includes(code)
    ? uploadRefusalForRunShape(code as RunShapeRefusalCode)
    : (code as UploadRefusalCode);
  return { ...entry, expectedOutcome: 'refused', expectedUploadCode: door };
}

const IMPL = 'phases/03-implementation/phase.json';
const TESTING = 'phases/04-testing';
const DEPLOY = 'phases/05-deployment/phase.json';
const MAINT = 'phases/06-maintenance/phase.json';

/* ------------------------------ the helpers ------------------------------ */

/**
 * The Shelf pack in the older layout (the frozen `older-shelf/`):
 * every attack is an older archive, which the door converts once
 * before the rule each one is aimed at reads it.
 */
const OLDER_SHELF_DIR = path.join(__dirname, '..', 'older-shelf');

function clean(): ZipEntrySpec[] {
  return entriesOf(OLDER_SHELF_DIR);
}

function find(entries: ZipEntrySpec[], name: string): ZipEntrySpec {
  const entry = entries.find((one) => one.name === name);
  if (!entry) throw new Error(`the Shelf pack has no ${name}`);
  return entry;
}

/** Re-serialise one JSON entry after `edit`; only that entry's bytes move. */
function editJson(entries: ZipEntrySpec[], name: string, edit: (json: any) => void): ZipEntrySpec[] {
  const entry = find(entries, name);
  const json = JSON.parse(entry.data.toString('utf8'));
  edit(json);
  entry.data = Buffer.from(`${JSON.stringify(json, null, 2)}\n`, 'utf8');
  return entries;
}

/** Replace one entry's header fields; its bytes stay. */
function editHeader(entries: ZipEntrySpec[], name: string, patch: Partial<ZipEntrySpec>): ZipEntrySpec[] {
  Object.assign(find(entries, name), patch);
  return entries;
}

function text(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

/** The deployment smoke's commands, replaced. */
function smoke(commands: unknown): () => Buffer {
  return () =>
    writeZip(
      editJson(clean(), DEPLOY, (phase) => {
        phase.checks.smoke.commands = commands;
      }),
    );
}

/** The implementation phase's first run, edited. */
function firstRun(edit: (run: any) => void): () => Buffer {
  return () =>
    writeZip(
      editJson(clean(), IMPL, (phase) => {
        edit(phase.checks.runs[0]);
      }),
    );
}

/** A run of `id`, the same as the phase's `like` run in every field but its id and label. */
function againRun(phase: any, like: string, id: string): void {
  const base = phase.checks.runs.find((run: any) => run.id === like);
  phase.checks.runs.push({ ...base, id, label: `${base.label} again` });
}

const MEMO = new Map<string, Buffer>();

/** A copy every time, so a caller that writes into its archive cannot change the next caller's. */
function memo(key: string, make: () => Buffer): Buffer {
  let held = MEMO.get(key);
  if (!held) {
    held = make();
    MEMO.set(key, held);
  }
  return Buffer.from(held);
}

/** Deterministic pseudo-random letters (mulberry32), so a bomb is the same bytes every time. */
function letters(seed: number, count: number): string {
  let state = seed >>> 0;
  let out = '';
  for (let i = 0; i < count; i += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += String.fromCharCode(0x61 + (((t ^ (t >>> 14)) >>> 0) % 26));
  }
  return out;
}

/**
 * One MiB of text that deflates at well under 100:1: every 512-byte line is
 * four pseudo-random letters, dots, and a newline. Many of these together are
 * a total-size bomb that no single-entry ratio rule sees.
 */
function bulkPart(seed: number): Buffer {
  const lines: string[] = [];
  for (let line = 0; line < 2048; line += 1) {
    lines.push(`${letters(seed * 4096 + line, 4)}${'.'.repeat(507)}\n`);
  }
  return text(lines.join(''));
}

const MIB = 1024 * 1024;

/* ---------------------------- the hostile set ---------------------------- */

const ENTRIES: HostileEntry[] = [
  /* -- archive structure -- */
  {
    name: 'path-traversal',
    attack: 'An entry climbs out of the archive root with "../".',
    expectedCode: 'PATH_CLIMB',
    touches: ['phases/03-implementation/../../../escape.py'],
    build: () =>
      writeZip([...clean(), { name: 'phases/03-implementation/../../../escape.py', data: text('print("outside")\n') }]),
  },
  {
    name: 'absolute-path',
    attack: 'An entry names an absolute path.',
    expectedCode: 'PATH_CLIMB',
    touches: ['/tmp/shelf-absolute.txt'],
    build: () => writeZip([...clean(), { name: '/tmp/shelf-absolute.txt', data: text('absolute\n') }]),
  },
  {
    name: 'symlink-entry',
    attack: 'An entry is a Unix symlink pointing outside the pack.',
    expectedCode: 'SYMLINK',
    touches: ['canonical/api/link.py'],
    build: () =>
      writeZip([
        ...clean(),
        {
          name: 'canonical/api/link.py',
          data: text('../../../../etc/hosts'),
          method: 0,
          versionMadeBy: (3 << 8) | 30,
          externalAttributes: (0o120777 << 16) >>> 0,
        },
      ]),
  },
  {
    name: 'duplicate-names',
    attack: 'Two entries share one name, with different bytes.',
    expectedCode: 'DUPLICATE_NAME',
    touches: ['canonical/api/shelf.py'],
    build: () =>
      writeZip([...clean(), { name: 'canonical/api/shelf.py', data: text('raise SystemExit("the second copy")\n') }]),
  },
  {
    name: 'case-colliding-names',
    attack: 'Two entries differ only in case, one file on a case-insensitive disk.',
    expectedCode: 'CASE_COLLISION',
    touches: ['canonical/api/Shelf.py'],
    build: () => writeZip([...clean(), { name: 'canonical/api/Shelf.py', data: text('raise SystemExit("the other case")\n') }]),
  },
  {
    name: 'nul-in-name',
    attack: 'An entry name holds a NUL byte.',
    expectedCode: 'NUL_IN_NAME',
    touches: ['canonical/api/shelf.py\u0000.txt'],
    build: () => writeZip([...clean(), { name: 'canonical/api/shelf.py\u0000.txt', data: text('nul\n') }]),
  },
  {
    name: 'ratio-bomb',
    attack: 'One entry inflates 16 MiB of zeros from a few kilobytes: far past 100:1, under the total cap.',
    expectedCode: 'RATIO_BOMB',
    touches: ['canonical/padding.bin'],
    build: () =>
      memo('ratio-bomb', () => writeZip([...clean(), { name: 'canonical/padding.bin', data: Buffer.alloc(16 * MIB) }])),
  },
  {
    name: 'total-size-bomb',
    attack: 'Thirty-four 1 MiB entries, each under 100:1, inflate past the 32 MiB total cap.',
    expectedCode: 'TOTAL_SIZE_BOMB',
    touches: ['canonical/bulk/*'],
    build: () =>
      memo('total-size-bomb', () => {
        const parts: ZipEntrySpec[] = [];
        for (let n = 0; n < 34; n += 1) {
          parts.push({ name: `canonical/bulk/part-${String(n).padStart(2, '0')}.txt`, data: bulkPart(n + 1) });
        }
        return writeZip([...clean(), ...parts]);
      }),
  },
  {
    name: 'too-many-entries',
    attack: 'Two thousand small notes take the archive past 2,000 entries.',
    expectedCode: 'TOO_MANY_ENTRIES',
    touches: ['canonical/notes/*'],
    build: () =>
      memo('too-many-entries', () => {
        const notes: ZipEntrySpec[] = [];
        for (let n = 0; n < 2000; n += 1) {
          notes.push({ name: `canonical/notes/note-${String(n).padStart(4, '0')}.txt`, data: text(`note ${n}\n`) });
        }
        return writeZip([...clean(), ...notes]);
      }),
  },
  {
    name: 'encrypted-flag',
    attack: 'An entry sets the "encrypted" general-purpose bit.',
    expectedCode: 'ENCRYPTED_ENTRY',
    touches: ['canonical/api/shelf.py'],
    build: () => writeZip(editHeader(clean(), 'canonical/api/shelf.py', { flags: 0x0001 })),
  },
  {
    name: 'crc-mismatch',
    attack: 'An entry declares a CRC-32 its bytes do not have.',
    expectedCode: 'CRC_MISMATCH',
    touches: ['canonical/api/main.py'],
    build: () => {
      const entries = clean();
      const main = find(entries, 'canonical/api/main.py');
      return writeZip(editHeader(entries, main.name, { crc32: (crc32Of(main.data) ^ 0xffffffff) >>> 0 }));
    },
  },
  {
    name: 'declared-size-mismatch',
    attack: 'An entry declares an uncompressed size 4 KiB larger than what it inflates to.',
    expectedCode: 'ZIP64_OR_SIZE_MISMATCH',
    touches: ['canonical/api/main.py'],
    build: () => {
      const entries = clean();
      const main = find(entries, 'canonical/api/main.py');
      return writeZip(editHeader(entries, main.name, { declaredUncompressedSize: main.data.length + 4096 }));
    },
  },

  /* -- what the pack declares -- */
  {
    name: 'runtime-outside-allow-lists',
    attack: 'project.json pins a Python package the runner does not bake.',
    expectedCode: 'RUNTIME_OUTSIDE_PROFILE',
    touches: ['project.json'],
    build: () =>
      writeZip(
        editJson(clean(), 'project.json', (project) => {
          project.runtime.python.packages.push('requests==2.32.3');
        }),
      ),
  },
  {
    name: 'run-timeout-above-limit',
    attack: 'A run asks for 120 seconds, above the 15 s a learner run gets.',
    expectedCode: 'LIMIT_TIMEOUT',
    touches: [IMPL],
    build: firstRun((run) => {
      run.timeoutSeconds = 120;
    }),
  },
  {
    name: 'run-memory-above-limit',
    attack: 'A run asks for 2048 MB, above the 256 MB a learner run gets.',
    expectedCode: 'LIMIT_MEMORY',
    touches: [IMPL],
    build: firstRun((run) => {
      run.memoryMb = 2048;
    }),
  },
  {
    name: 'run-freeform-command-string',
    attack: 'The smoke command is a shell string, not an argv array.',
    expectedCode: 'RUN_FREEFORM_STRING',
    touches: [DEPLOY],
    build: smoke(['python3 api/main.py --selfcheck']),
  },
  {
    name: 'run-own-command-key',
    attack: 'A test run declares its own command.',
    expectedCode: 'RUN_OWN_COMMAND',
    touches: [IMPL],
    build: firstRun((run) => {
      run.command = ['python3', '-m', 'pytest'];
    }),
  },
  {
    name: 'run-other-interpreter',
    attack: 'The smoke command names node instead of python3.',
    expectedCode: 'ARGV_INTERPRETER',
    touches: [DEPLOY],
    build: smoke([['node', 'api/main.py', '--selfcheck']]),
  },
  {
    name: 'run-unshipped-script',
    // The preview's seed, since a smoke command naming a script smoke/ does not
    // hold is refused first by the folder layout's own sentence, once
    // the door converts the archive; the seed's script is held to the
    // run-shape rule alone.
    attack: 'The preview seed runs a script the pack does not ship.',
    expectedCode: 'ARGV_SCRIPT',
    touches: ['project.json'],
    build: () =>
      writeZip(
        editJson(clean(), 'project.json', (project) => {
          project.preview = { seed: ['python3', 'ops/missing.py'] };
        }),
      ),
  },
  {
    name: 'run-extra-arg',
    attack: 'The smoke command passes an argument after --selfcheck.',
    expectedCode: 'ARGV_EXTRA',
    touches: [DEPLOY],
    build: smoke([['python3', 'api/main.py', '--selfcheck', '--verbose']]),
  },
  {
    name: 'run-shell-metacharacter',
    attack: 'A smoke argument carries a shell metacharacter.',
    expectedCode: 'ARGV_SHELL',
    touches: [DEPLOY],
    build: smoke([['python3', 'api/main.py', '--selfcheck;id']]),
  },
  {
    name: 'run-harness-not-allowed',
    attack: 'A run names a harness outside the closed list.',
    expectedCode: 'HARNESS_NOT_ALLOWED',
    touches: [IMPL],
    build: firstRun((run) => {
      run.harness = 'mocha';
    }),
  },
  {
    name: 'run-hidden-not-a-file',
    attack: 'The hidden suite carries a shell script, not a test file the runner executes.',
    expectedCode: 'HIDDEN_NOT_FILE',
    touches: ['phases/03-implementation/hidden_tests/api/grade.sh'],
    build: () =>
      writeZip([...clean(), { name: 'phases/03-implementation/hidden_tests/api/grade.sh', data: text('exit 0\n') }]),
  },
  {
    name: 'phase-two-work-tasks',
    attack: 'The implementation phase declares two code tasks.',
    expectedCode: 'TWO_WORK_TASKS',
    touches: [IMPL],
    build: () =>
      writeZip(
        editJson(clean(), IMPL, (phase) => {
          phase.tasks = [
            { taskKey: 'api', order: 1, checkKind: 'code', owns: ['api/shelf.py'], gradedUnits: [{ kind: 'run', id: 'api' }] },
            { taskKey: 'web', order: 2, checkKind: 'code', owns: ['web/src/lib/shelf.ts'], gradedUnits: [{ kind: 'run', id: 'web' }] },
          ];
        }),
      ),
  },
  {
    name: 'workspace-holds-hidden-blob',
    attack: 'A locked workspace file is the hidden suite itself (decision 37, rule 1).',
    expectedCode: 'HIDDEN_IN_WORKSPACE',
    touches: [IMPL],
    build: () =>
      writeZip(
        editJson(clean(), IMPL, (phase) => {
          phase.files.push({
            path: 'tests/test_peek.py',
            source: 'hidden_tests/api/test_hidden_shelf.py',
            editable: false,
            language: 'python',
          });
        }),
      ),
  },
  {
    name: 'editable-holds-solution-blob',
    attack: 'The editable starter is the reference solution itself (decision 37, rule 2).',
    expectedCode: 'SOLUTION_IN_EDITABLE',
    touches: [IMPL],
    build: () =>
      writeZip(
        editJson(clean(), IMPL, (phase) => {
          const starter = phase.files.find((file: any) => file.path === 'api/shelf.py');
          starter.source = 'solution/api/shelf.py';
        }),
      ),
  },
  {
    name: 'version-priced-25',
    attack: 'Two more runs in implementation and maintenance and one more mutant price the version at 25 microVMs, every phase still at 10 or under.',
    expectedCode: 'CEILING_PER_VERSION',
    touches: [IMPL, MAINT, `${TESTING}/mutants/sort_ignores_case/*`],
    build: () => {
      const entries = clean();
      editJson(entries, IMPL, (phase) => {
        againRun(phase, 'api', 'api-again');
        againRun(phase, 'web', 'web-again');
      });
      editJson(entries, MAINT, (phase) => {
        againRun(phase, 'api', 'api-again');
        againRun(phase, 'web', 'web-again');
      });
      const impl = find(entries, `${TESTING}/impl/web/src/lib/shelf.ts`).data.toString('utf8');
      const mutant = impl
        .replace(SHELF_MARKERS.impl, SHELF_MARKERS.mutant)
        .replace('byText(a.title.toLowerCase(), b.title.toLowerCase())', 'byText(a.title, b.title)');
      return writeZip([
        ...entries,
        {
          name: `${TESTING}/mutants/sort_ignores_case/meta.json`,
          data: text(
            `${JSON.stringify(
              {
                name: 'sort_ignores_case',
                description: 'The page sorts titles with case, so a lower-case title lands after every capital.',
                covers: 'SH-1/AC-1',
                run: 'web',
              },
              null,
              2,
            )}\n`,
          ),
        },
        { name: `${TESTING}/mutants/sort_ignores_case/web/src/lib/shelf.ts`, data: text(mutant) },
      ]);
    },
  },
  {
    name: 'phase-priced-11',
    attack: 'Five more mutants price the testing phase at 11 microVMs, the version still at 24 or under.',
    expectedCode: 'CEILING_PER_PHASE',
    touches: [`${TESTING}/mutants/extra_*`],
    build: () => {
      const entries = clean();
      const meta = JSON.parse(find(entries, `${TESTING}/mutants/label_ignores_loan/meta.json`).data.toString('utf8'));
      const file = find(entries, `${TESTING}/mutants/label_ignores_loan/web/src/lib/shelf.ts`).data;
      const extra: ZipEntrySpec[] = [];
      for (let n = 1; n <= 5; n += 1) {
        const name = `extra_${n}`;
        extra.push(
          { name: `${TESTING}/mutants/${name}/meta.json`, data: text(`${JSON.stringify({ ...meta, name, covers: `SH-4/AC-${n + 1}` }, null, 2)}\n`) },
          { name: `${TESTING}/mutants/${name}/web/src/lib/shelf.ts`, data: file },
        );
      }
      return writeZip([...entries, ...extra]);
    },
  },
  {
    name: 'slug-tasktrackr',
    attack:
      'project.json names the slug the platform reference project owns. Not a refusal: the slug is minted from the title and never read from the archive (D-X2, skeptic m3), so the import is accepted under a minted slug that is never tasktrackr.',
    expectedCode: null,
    mintedSlugIsNot: 'tasktrackr',
    touches: ['project.json'],
    build: () =>
      writeZip(
        editJson(clean(), 'project.json', (project) => {
          project.slug = 'tasktrackr';
        }),
      ),
  },
  {
    name: 'canonical-dot-env',
    attack: 'The pack ships a canonical/.env file (its value is harmless; the file is the attack).',
    expectedCode: 'SECRET_FILE',
    touches: ['canonical/.env'],
    build: () => writeZip([...clean(), { name: 'canonical/.env', data: text('SHELF_PAGE_SIZE=20\n') }]),
  },
];

export const HOSTILE_ARCHIVES: HostileArchive[] = ENTRIES.map(withOutcome);

/** The hostile archives by name, for a lane that wants one. */
export const HOSTILE_BY_NAME: ReadonlyMap<string, HostileArchive> = new Map(
  HOSTILE_ARCHIVES.map((one) => [one.name, one]),
);

/** Whether `name` is an entry the hostile archive says its attack touches. */
export function touchesName(hostile: HostileArchive, name: string): boolean {
  return hostile.touches.some((touch) =>
    touch.endsWith('*') ? name.startsWith(touch.slice(0, -1)) : name === touch,
  );
}
