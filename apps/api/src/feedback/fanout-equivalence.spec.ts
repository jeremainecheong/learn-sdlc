import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import type { FeedbackReport, RunResult, TestCaseResult } from '@learnsdlc/shared';
import { config } from '../config';
import { digestOf } from '../content/blob.store';
import { ContentService } from '../content/content.service';
import type { CodeChecks, PhaseContent, TestsChecks } from '../content/content.types';
import { soleTaskFor } from '../content/pack-compiler';
import type { SandboxJob } from '../execution/sandbox.service';
import { FIXTURES_DIR } from '../../test/fixtures/paths';
import { fixedState, graderFor } from '../../test/verdict-golden';

/**
 * The grading fan-out, held against the serial grader it must equal.
 *
 * `GRADING_RUN_FANOUT` lets one submission hold several sandbox runs at once,
 * and `GRADING_SPECULATIVE_MUTANTS` starts a Testing review's mutant runs
 * beside its reference runs. Neither may change a verdict, a job or a failure:
 * the same jobs run with the same bytes, the report is the same object, and an
 * unreachable runner reads as it did. This spec is that promise for
 * TaskTrackr's three phases that run learner code (Implementation, Testing and
 * Maintenance).
 *
 * The sandbox is scripted. Each job's answer is a fixed function of **which**
 * job it is, found by the digest of the job's whole JSON in the recorded list,
 * so the answer cannot depend on when the job ran, and a job whose bytes moved
 * is not in the list and fails the spec at once. Each job finishes after a
 * seeded random delay, so the jobs finish in a different order at every
 * fan-out and seed.
 *
 * The fixture (`test/fixtures/tasktrackr-fanout-equivalence.json`) is the
 * recorded serial grader: written by this file against the grader with no
 * fan-out (`FANOUT_EQUIVALENCE_RECORD=write`). It holds digests only, never a
 * file's bytes: the jobs in the order the serial grader started them, the most
 * runs it held at once, each scenario's report digest and, for a scenario that
 * fails, the message it rethrew. Its `recordedAt` names the grader it was
 * recorded against. Re-record it only when a report's wording changes, and
 * only after checking that the jobs, start orders, peaks and failures still
 * match.
 */

const FIXTURE = path.join(FIXTURES_DIR, 'tasktrackr-fanout-equivalence.json');
const RECORD = process.env.FANOUT_EQUIVALENCE_RECORD === 'write';

type Answer = { result: RunResult } | { reject: string };

interface Scenario {
  /** Which phases it applies to. */
  kinds: ('code' | 'tests')[];
  /** The answer for job `at` (its index in the recorded list), given the phase's run count and kind. */
  answer: (at: number, runCount: number, kind: 'code' | 'tests') => Answer;
  /** A fixed delay for some jobs, to force a later job to finish first. */
  delay?: (at: number) => number | undefined;
}

interface RecordedScenario {
  report: string | null;
  error: string | null;
  starts: number[];
  maxInFlight: number;
}

interface RecordedPhase {
  jobs: string[];
  scenarios: Record<string, RecordedScenario>;
}

interface Fixture {
  slug: string;
  version: string;
  recordedAt: string;
  phases: Record<string, RecordedPhase>;
}

/** A case whose failure carries one frame the learner may see and one they may not. */
function failingCase(at: number, visiblePath: string): TestCaseResult {
  return {
    name: `case ${at} fails`,
    status: 'failed',
    message: `assertion ${at} failed\nTraceback (most recent call last): line two`,
    frames: [
      { path: visiblePath, line: 10 + at, snippet: `value_${at}` },
      { path: 'tests/hidden/test_edge_cases.py', line: 4 + at, snippet: 'sealed' },
    ],
    durationMs: 5 + at,
  };
}

function result(at: number, failed: boolean, visiblePath: string, exitKind: RunResult['exitKind'] = 'ok'): RunResult {
  const cases: TestCaseResult[] = [
    { name: `case ${at} passes`, status: 'passed', durationMs: 3 + at },
    failed ? failingCase(at, visiblePath) : { name: `case ${at} also passes`, status: 'passed', durationMs: 4 + at },
  ];
  return {
    ok: !failed && exitKind === 'ok',
    exitKind,
    stdout: '',
    stderr: failed ? `stderr of job ${at}` : '',
    durationMs: 100 + at,
    tests: { total: 2, passed: failed ? 1 : 2, failed: failed ? 1 : 0, errored: 0, cases },
  };
}

/** The visible path every scripted frame points at: the phase's first file. */
let visiblePath = 'api/app.py';

const SCENARIOS: Record<string, Scenario> = {
  // Code: every third job fails one case. Tests: both references pass, and
  // the mutants are a mix of killed, survived and a harness error (not a kill).
  mixed: {
    kinds: ['code', 'tests'],
    answer: (at, runs, kind) => {
      if (kind === 'code') return { result: result(at, at % 3 === 1, visiblePath) };
      if (at < runs) return { result: result(at, false, visiblePath) };
      const mutant = at - runs;
      if (mutant === 5) return { result: { ...result(at, true, visiblePath, 'error'), ok: false } };
      return { result: result(at, mutant % 2 === 0, visiblePath) };
    },
  },
  // The second reference fails: the serial grader's "Not evaluated" report.
  'failing-reference': {
    kinds: ['tests'],
    answer: (at, runs) => ({ result: result(at, at === 1 || at >= runs, visiblePath) }),
  },
  // The second reference fails and a mutant's run is refused: still the
  // "Not evaluated" report, never the mutant's error.
  'failing-reference-mutant-refused': {
    kinds: ['tests'],
    answer: (at, runs) => (at === runs + 2 ? { reject: `runner refused job ${at}` } : { result: result(at, at === 1, visiblePath) }),
    delay: (at) => (at === 4 ? 0 : undefined),
  },
  // A reference and a mutant both refused, the mutant first: the reference's.
  'reference-and-mutant-refused': {
    kinds: ['tests'],
    answer: (at, runs) =>
      at === 1 || at === runs + 7 ? { reject: `runner refused job ${at}` } : { result: result(at, false, visiblePath) },
    delay: (at) => (at === 1 ? 8 : at === 9 ? 0 : undefined),
  },
  // Two mutants refused, the later first: the earlier one's, in pack order.
  'two-mutants-refused': {
    kinds: ['tests'],
    answer: (at, runs) =>
      at === runs + 2 || at === runs + 5 ? { reject: `runner refused job ${at}` } : { result: result(at, false, visiblePath) },
    delay: (at) => (at === 4 ? 8 : at === 7 ? 0 : undefined),
  },
  // Visible web and hidden api refused, the hidden one first: visible web's.
  'visible-and-hidden-refused': {
    kinds: ['code'],
    answer: (at) => (at === 1 || at === 2 ? { reject: `runner refused job ${at}` } : { result: result(at, false, visiblePath) }),
    delay: (at) => (at === 1 ? 8 : at === 2 ? 0 : undefined),
  },
  // Every run refused, the last finishing first: visible api's.
  'all-refused': {
    kinds: ['code'],
    answer: (at) => ({ reject: `runner refused job ${at}` }),
    delay: (at) => 8 - 2 * at,
  },
};

/** A small seeded generator, so a failure reproduces from its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ledger {
  /** Recorded-list index of every job, in the order it started. */
  starts: number[];
  /** The jobs themselves, in the order they started. */
  jobs: SandboxJob[];
  maxInFlight: number;
  /** Recorded-list indices of results whose fields the grader read beyond `exitKind`. */
  read: Set<number>;
}

/**
 * A result the grader can hold without it counting as read. `exitKind` is what
 * `runSandbox` checks on every result, and `then` is what `await` asks of any
 * value; any other field read marks the result as consumed.
 */
function watched<T extends object>(value: T, at: number, read: Set<number>): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key !== 'exitKind' && key !== 'then') read.add(at);
      return Reflect.get(target, key, receiver);
    },
  });
}

/** The scripted sandbox: answers by job identity, finishes after a seeded delay. */
function scriptedSandbox(
  known: string[] | null,
  scenario: Scenario,
  runCount: number,
  kind: 'code' | 'tests',
  seed: number,
): { sandbox: { execute: (job: SandboxJob) => Promise<RunResult>; analyze: () => Promise<unknown> }; ledger: Ledger } {
  const ledger: Ledger = { starts: [], jobs: [], maxInFlight: 0, read: new Set() };
  const random = seeded(seed);
  let inFlight = 0;
  const sandbox = {
    async execute(job: SandboxJob): Promise<RunResult> {
      const digest = digestOf(job);
      // While recording, a job's index is the order the serial grader started it.
      const at = known ? known.indexOf(digest) : ledger.starts.length;
      ledger.starts.push(at);
      ledger.jobs.push(job);
      inFlight += 1;
      ledger.maxInFlight = Math.max(ledger.maxInFlight, inFlight);
      const wait = scenario.delay?.(at) ?? Math.floor(random() * 5);
      await new Promise((resolve) => setTimeout(resolve, wait));
      inFlight -= 1;
      if (at < 0) throw new Error(`a job that the recorded serial grader never sent: ${digest}`);
      const answer = scenario.answer(at, runCount, kind);
      if ('reject' in answer) throw new Error(answer.reject);
      return watched(answer.result, at, ledger.read);
    },
    async analyze() {
      return {
        issues: [{ severity: 'warning', message: 'scripted finding', path: visiblePath, line: 3 }],
        metrics: { files: 2, functions: 4, todosRemaining: 0, maxComplexity: 3, docstringCoverage: 0.5 },
      };
    },
  };
  return { sandbox, ledger };
}

const content = new ContentService();
content.loadAll();
const project = content.getProject('tasktrackr');
const graded = project.phases.filter((phase) => phase.checks.kind === 'code' || phase.checks.kind === 'tests');

function runCountOf(phase: PhaseContent): number {
  return ((phase.checks as CodeChecks | TestsChecks).runs ?? []).length || 1;
}

interface Outcome {
  report: FeedbackReport | null;
  error: string | null;
  ledger: Ledger;
}

/** The two settings, as `config` holds them (absent before the fan-out existed). */
const settings = config as unknown as Record<string, unknown>;

async function grade(
  phase: PhaseContent,
  scenario: Scenario,
  known: string[] | null,
  {
    fanout,
    speculative,
    seed,
    workspace,
  }: { fanout: number | null; speculative: boolean; seed: number; workspace?: Record<string, string> },
): Promise<Outcome> {
  const heldFanout = settings.gradingRunFanout;
  const heldSpeculative = settings.gradingSpeculativeMutants;
  settings.gradingRunFanout = fanout;
  settings.gradingSpeculativeMutants = speculative;
  try {
    visiblePath = phase.files[0]?.path ?? 'api/app.py';
    const { service } = graderFor(content, 'tasktrackr');
    const { sandbox, ledger } = scriptedSandbox(known, scenario, runCountOf(phase), phase.checks.kind as 'code' | 'tests', seed);
    (service as unknown as { sandbox: unknown }).sandbox = sandbox;
    const tasks = [soleTaskFor(phase)];
    // A case that edits the learner's files passes its own workspace; every
    // other case grades the verdict net's fixed one.
    const state = fixedState(phase, phase.order);
    if (workspace) state.workspace = workspace;
    try {
      const report = await service.buildReport(phase, state as never, tasks, tasks[0]);
      // Let a discarded speculative run finish before the ledger is read.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { report, error: null, ledger };
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { report: null, error: (error as Error).message, ledger };
    }
  } finally {
    settings.gradingRunFanout = heldFanout;
    settings.gradingSpeculativeMutants = heldSpeculative;
  }
}

function scenariosFor(phase: PhaseContent): [string, Scenario][] {
  return Object.entries(SCENARIOS).filter(([, scenario]) => scenario.kinds.includes(phase.checks.kind as 'code' | 'tests'));
}

const DEFAULTS = { fanout: null, speculative: false, seed: 1 };

if (RECORD) {
  it('records the fixture against the serial grader', async () => {
    const fixture: Fixture = { slug: 'tasktrackr', version: project.version, recordedAt: 'd1733fa148ae', phases: {} };
    for (const phase of graded) {
      const all = await grade(phase, SCENARIOS.mixed, null, DEFAULTS);
      const jobs = all.ledger.jobs.map((job) => digestOf(job));
      const scenarios: Record<string, RecordedScenario> = {};
      for (const [name, scenario] of scenariosFor(phase)) {
        const out = await grade(phase, scenario, jobs, DEFAULTS);
        scenarios[name] = {
          report: out.report ? digestOf(out.report) : null,
          error: out.error,
          starts: out.ledger.starts,
          maxInFlight: out.ledger.maxInFlight,
        };
      }
      fixture.phases[phase.key] = { jobs, scenarios };
    }
    fs.writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  });
} else {
  describe('the grading fan-out changes when runs start, and nothing else', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as Fixture;

    it('has a fixture for the pack version being graded, covering the three phases', () => {
      expect(fixture.version).toBe(project.version);
      expect(Object.keys(fixture.phases).sort()).toEqual(graded.map((phase) => phase.key).sort());
      // Implementation and Maintenance: 2 visible + 2 hidden; Testing: 2 references + the mutants.
      for (const phase of graded) expect(fixture.phases[phase.key].jobs.length).toBeGreaterThanOrEqual(4);
    });

    describe.each(graded.map((phase) => [phase.key, phase] as const))('%s', (key, phase) => {
      const recorded = () => fixture.phases[key];

      it.each(scenariosFor(phase).map(([name]) => name))(
        'at defaults the start order equals the recorded serial grader’s order (%s)',
        async (name) => {
          for (const seed of [1, 2, 3]) {
            const out = await grade(phase, SCENARIOS[name], recorded().jobs, { ...DEFAULTS, seed });
            const was = recorded().scenarios[name];
            expect(out.ledger.starts).toEqual(was.starts);
            expect(out.ledger.maxInFlight).toBe(was.maxInFlight);
            expect(out.error).toBe(was.error);
            expect(out.report ? digestOf(out.report) : null).toBe(was.report);
          }
        },
      );

      const matrix = [1, 2, 4, 8].flatMap((fanout) =>
        [false, true].flatMap((speculative) =>
          scenariosFor(phase).map(([name]) => [fanout, speculative, name] as const),
        ),
      );

      it.each(matrix)(
        'for F=%i, speculative %p, the report deep-equals the recorded serial grader’s (%s)',
        async (fanout, speculative, name) => {
          const was = recorded().scenarios[name];
          const serial = await grade(phase, SCENARIOS[name], recorded().jobs, DEFAULTS);
          for (const seed of [11, 12, 13]) {
            const out = await grade(phase, SCENARIOS[name], recorded().jobs, { fanout, speculative, seed });
            // The verdict, field for field, and the same failure if it failed.
            expect(out.error).toBe(was.error);
            expect(out.report).toEqual(serial.report);
            expect(out.report ? digestOf(out.report) : null).toBe(was.report);
            // Jobs start in the serial order: an increasing walk of the recorded list.
            expect(out.ledger.starts.every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]))).toBe(true);
            // Every job the serial grader started is started, except that after a
            // refusal no further job starts (the review fails with the same
            // error either way, and nothing a discarded job did is recorded).
            if (was.error === null) for (const at of was.starts) expect(out.ledger.starts).toContain(at);
            else expect(out.ledger.starts).toContain(Number(was.error.replace('runner refused job ', '')));
            // At most F at once, and F really is used: the peak is F, or the
            // size of the largest wave the scenario has to run.
            expect(out.ledger.maxInFlight).toBeLessThanOrEqual(fanout);
            if (was.error === null) {
              const total = recorded().jobs.length;
              const runs = runCountOf(phase);
              const mutantsRan = was.starts.length === total;
              const wave =
                phase.checks.kind === 'code' || speculative ? total : mutantsRan ? Math.max(runs, total - runs) : runs;
              expect(out.ledger.maxInFlight).toBe(Math.min(fanout, wave));
            }
          }
        },
      );

      it.each([[null], [1], [2], [4], [8]] as const)('every job’s bytes equal the recorded serial grader’s at F=%p', async (fanout) => {
        for (const speculative of fanout === null ? [false] : [false, true]) {
          const out = await grade(phase, SCENARIOS.mixed, recorded().jobs, { fanout, speculative, seed: 21 });
          expect(out.ledger.jobs.map((job) => digestOf(job))).toEqual(recorded().jobs);
        }
      });

      if (phase.checks.kind === 'code') {
        it.each([[null], [1], [2], [4], [8]] as const)('no visible job carries a hidden test path at F=%p', async (fanout) => {
          const runs = (phase.checks as CodeChecks).runs ?? [];
          const hiddenPaths = new Set(runs.flatMap((run) => Object.keys(run.hiddenTestFiles)));
          expect(hiddenPaths.size).toBeGreaterThan(0);
          const out = await grade(phase, SCENARIOS.mixed, recorded().jobs, { fanout, speculative: false, seed: 31 });
          out.ledger.jobs.forEach((job, i) => {
            const at = out.ledger.starts[i];
            const carried = Object.keys(job.files).filter((file) => hiddenPaths.has(file));
            // The first `runs.length` jobs are the visible ones; the hidden ones do carry their suite.
            if (at < runs.length) expect(carried).toEqual([]);
            else expect(carried.length).toBeGreaterThan(0);
          });
        });

        it('visible and hidden rejections rethrow in the serial order (visible api, visible web, hidden api, hidden web)', async () => {
          for (const fanout of [null, 1, 2, 4, 8]) {
            const one = await grade(phase, SCENARIOS['visible-and-hidden-refused'], recorded().jobs, { fanout, speculative: false, seed: 41 });
            expect(one.error).toBe('runner refused job 1');
            // Not by luck: from F=2 the hidden api run starts, and is refused, before visible web's refusal.
            if (fanout !== null && fanout >= 2) expect(one.ledger.starts).toContain(2);
            const all = await grade(phase, SCENARIOS['all-refused'], recorded().jobs, { fanout, speculative: false, seed: 41 });
            expect(all.error).toBe('runner refused job 0');
          }
        });
      }

      if (phase.checks.kind === 'tests') {
        it('speculative with a failing reference: the serial grader’s Not-evaluated report, no mutant timing row, no mutant result read', async () => {
          const runs = runCountOf(phase);
          for (const fanout of [1, 2, 4, 8]) {
            for (const name of ['failing-reference', 'failing-reference-mutant-refused']) {
              const out = await grade(phase, SCENARIOS[name], recorded().jobs, { fanout, speculative: true, seed: 51 });
              expect(out.error).toBeNull();
              expect(digestOf(out.report)).toBe(recorded().scenarios[name].report);
              expect(out.report!.mutation!.killed).toBe(0);
              expect(out.report!.mutation!.survivors.every((s) => s.description.startsWith('Not evaluated'))).toBe(true);
              expect((out.report!.timings ?? []).filter((row) => row.step.startsWith('mutant'))).toEqual([]);
              expect([...out.ledger.read].filter((at) => at >= runs)).toEqual([]);
              // Not by absence: the mutant runs did start, beside the references, and were discarded.
              if (name === 'failing-reference') expect(out.ledger.starts).toEqual(recorded().jobs.map((_, at) => at));
              else expect(out.ledger.starts).toContain(runs + 2);
            }
          }
        });

        it('speculative with a learner who wrote no tests: no mutant run starts, and the report is the serial one', async () => {
          // The learner's test files emptied, as a submission with no tests
          // has them. Those jobs carry other bytes than the recorded list's,
          // so this case numbers jobs by start order (no known list) and holds
          // the speculative grader against the serial one run here; the
          // fixture is not read and not moved.
          const runs = runCountOf(phase);
          const checks = phase.checks as TestsChecks;
          const editable = new Set(phase.files.filter((file) => file.editable).map((file) => file.path));
          expect(checks.learnerTestFiles.length).toBeGreaterThan(0);
          for (const file of checks.learnerTestFiles) expect(editable.has(file)).toBe(true);
          const fixed = (fixedState(phase, phase.order).workspace ?? {}) as Record<string, string>;
          const workspace = { ...fixed, ...Object.fromEntries(checks.learnerTestFiles.map((file) => [file, ''])) };
          const references = Array.from({ length: runs }, (_, at) => at);
          const serial = await grade(phase, SCENARIOS.mixed, null, { ...DEFAULTS, workspace });
          // Today's grader: zero tests found, the references run, no mutant does.
          expect(serial.error).toBeNull();
          expect(JSON.stringify(serial.report)).toContain('0 test method(s) found.');
          expect(serial.ledger.starts).toEqual(references);
          for (const fanout of [1, 2, 4, 8]) {
            const out = await grade(phase, SCENARIOS.mixed, null, { fanout, speculative: true, seed: 71, workspace });
            expect(out.error).toBeNull();
            // Not one speculative mutant run, so no machine is spent on a
            // result the grader would discard.
            expect(out.ledger.starts).toEqual(references);
            expect(out.report).toEqual(serial.report);
            expect(digestOf(out.report)).toBe(digestOf(serial.report));
          }
        });

        it('a reference rejection and a mutant rejection together rethrow the reference’s', async () => {
          for (const fanout of [null, 1, 2, 4, 8]) {
            for (const speculative of fanout === null ? [false] : [false, true]) {
              const out = await grade(phase, SCENARIOS['reference-and-mutant-refused'], recorded().jobs, { fanout, speculative, seed: 61 });
              expect(out.error).toBe('runner refused job 1');
              // Not by luck: at F=8 speculative, the last mutant starts and is refused before the reference is.
              if (speculative && fanout === 8) expect(out.ledger.starts).toContain(recorded().jobs.length - 1);
              const two = await grade(phase, SCENARIOS['two-mutants-refused'], recorded().jobs, { fanout, speculative, seed: 61 });
              expect(two.error).toBe(`runner refused job ${runCountOf(phase) + 2}`);
            }
          }
        });
      }
    });
  });
}
