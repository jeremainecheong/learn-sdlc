import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import type { AnalyzerReport, FeedbackReport, RunResult } from '@learnsdlc/shared';
import { canonicalJson, digestOf } from '../src/content/blob.store';
import { ContentService } from '../src/content/content.service';
import type { PhaseContent } from '../src/content/content.types';
import { soleTaskFor } from '../src/content/pack-compiler';
import { ExecutionService } from '../src/execution/execution.service';
import type { SandboxJob } from '../src/execution/sandbox.service';
import { FeedbackService } from '../src/feedback/feedback.service';
import { FIXTURES_DIR } from './fixtures/paths';

/**
 * The verdict-golden net for the task grain (teacher-authored projects).
 *
 * The content-golden net records what the **loader** produces. This one
 * records what the **grader** produces, which is the thing a task is threaded
 * through: the builders, the rubric they read, the gate they hand their report
 * to, and the order the microVMs run in. Its one promise is that a learner of
 * the shipped project cannot tell the task grain is there, and it turns that
 * promise into a command.
 *
 * Two numbers per phase, both recorded against the **unmodified** grader:
 *
 * 1. **A sha256 of the canonical report.** `checks` in order with their ids and
 *    statuses, `criteria` in order with their keys, weights and scores, the
 *    `overall`, the strict verdict, the suite, the mutation summary and the
 *    four phase sections. Every wall-clock duration is excluded **by name**
 *    (`timings`, `durationMs` and their siblings) because a net that moved with
 *    the machine's speed would be re-recorded until it meant nothing.
 * 2. **The ordered sandbox job sequence.** What proves *the same microVMs in
 *    the same order*: one row per `sandbox.execute`, in the order the grader
 *    asked for them.
 *
 * > **Why the row has no `dockerfile`.** There is no `dockerfile` on a
 * > `SandboxJob`: the smoke job carries `smokeCommands`, which is what the
 * > learner's Dockerfile has already been read into by the time a job exists
 * > (`dockerEntrypoint` then `smokeArgvFor`). So the row carries the fields the
 * > type has: the kind, the run id, the harness, the test paths, the smoke
 * > argv, and the **paths** of the mounted and graded files. Paths, never
 * > bytes: a sealed file's contents do not go in a committed fixture.
 *
 * The workspace is fixed by being the pack's own shipped scaffold: every
 * phase graded with `workspace: null`, which is what a learner's first
 * submission grades. It needs no fixture of its own and it cannot drift without
 * the content digests moving first.
 *
 * The sandbox is a recorder that answers the same canned result to every job,
 * so nothing here starts a machine and nothing here is a test of the runner.
 * What it is a test of is everything between the phase and the verdict.
 */

/** The committed fixture for one pack, whether or not it exists yet. */
export function verdictFixturePathFor(slug: string, dir: string = FIXTURES_DIR): string {
  return path.join(dir, `${slug}-verdict-digests.json`);
}

/** One sandbox job, as the net records it. Paths, never bytes. */
export interface RecordedJob {
  kind: string;
  runId: string | null;
  harness: string | null;
  testPaths: string[];
  smokeCommands: string[][];
  /** The workspace the job was given, by path. */
  filePaths: string[];
  /** The sealed files written outside it, by path. */
  gradedPaths: string[];
}

/** One check of a report, as the fixture keeps it so a failure can name one. */
export interface RecordedCheck {
  id: string;
  status: string;
}

export interface PhaseVerdictDigest {
  /** sha256 of the canonical report. */
  report: string;
  /** What the phase is priced at, from the compiler. */
  sandboxBudget: number;
  /**
   * The check list the digest was taken over, kept beside it so that a failure
   * says *which check moved* rather than only that the number did. The digest
   * is still the assertion; this is the sentence it fails with.
   */
  checks: RecordedCheck[];
  jobs: RecordedJob[];
}

/** The first check that is not where it was, or null when the list is unmoved. */
export function firstDifferingCheck(
  recorded: RecordedCheck[],
  fresh: RecordedCheck[],
): string | null {
  const most = Math.max(recorded.length, fresh.length);
  for (let at = 0; at < most; at += 1) {
    const was = recorded[at];
    const now = fresh[at];
    if (!was) return `${now.id} (new, ${now.status})`;
    if (!now) return `${was.id} (gone, was ${was.status})`;
    if (was.id !== now.id) return `${was.id} -> ${now.id}`;
    if (was.status !== now.status) return `${was.id} (${was.status} -> ${now.status})`;
  }
  return null;
}

export interface VerdictDigestManifest {
  slug: string;
  version: string;
  phases: Record<string, PhaseVerdictDigest>;
}

/**
 * Keys excluded from the canonical report **by name**, because they are
 * wall-clock facts about the machine rather than facts about the verdict.
 */
export const EXCLUDED_KEYS: readonly string[] = [
  'timings',
  'durationMs',
  'elapsedMs',
  'startedAt',
  'finishedAt',
  'ranAt',
  'seconds',
];

function withoutDurations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((one) => withoutDurations(one));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
      if (EXCLUDED_KEYS.includes(key)) continue;
      out[key] = withoutDurations(held);
    }
    return out;
  }
  return value;
}

/**
 * The report, reduced to what a learner's verdict actually is.
 *
 * `aiReview` is left out on purpose: the reviewer is stubbed here, so recording
 * it would record the stub. What the review decides (the strict verdict) is
 * recorded, as `passed`.
 */
export function canonicalVerdict(report: FeedbackReport): unknown {
  return withoutDurations({
    checks: report.checks.map((check) => ({ id: check.id, status: check.status })),
    criteria: report.criteria.map((criterion) => ({
      key: criterion.key,
      weight: criterion.weight,
      score: criterion.score,
    })),
    overall: report.overall,
    passed: report.passed,
    assessmentMode: report.assessmentMode,
    tests: report.tests ?? null,
    mutation: report.mutation ?? null,
    extras: {
      contract: report.contract ?? null,
      ci: report.ci ?? null,
      drill: report.drill ?? null,
      impact: report.impact ?? null,
    },
  });
}

/** The canned result every job gets, so two runs of the net are one answer. */
const CANNED_RUN: RunResult = {
  ok: true,
  exitKind: 'ok',
  stdout: '',
  stderr: '',
  durationMs: 0,
  tests: { total: 4, passed: 4, failed: 0, errored: 0, cases: [] },
};

const CANNED_ANALYSIS: AnalyzerReport = {
  issues: [],
  metrics: { files: 1, functions: 1, todosRemaining: 0, maxComplexity: 1, docstringCoverage: 1 },
};

/** A sandbox that starts nothing and remembers everything, in order. */
export function recordingSandbox(): { sandbox: unknown; jobs: RecordedJob[] } {
  const jobs: RecordedJob[] = [];
  const sandbox = {
    async execute(job: SandboxJob): Promise<RunResult> {
      const test = job as Partial<Extract<SandboxJob, { mode: 'tests' }>>;
      const smoke = job as Partial<Extract<SandboxJob, { mode: 'smoke' }>>;
      jobs.push({
        kind: job.mode,
        runId: test.runId ?? null,
        harness: test.harness ?? null,
        testPaths: [...(test.testPaths ?? [])],
        smokeCommands: (smoke.smokeCommands ?? []).map((command) => [...command]),
        filePaths: Object.keys(job.files).sort(),
        gradedPaths: Object.keys(test.gradedFiles ?? {}).sort(),
      });
      return { ...CANNED_RUN, tests: { ...CANNED_RUN.tests!, cases: [] } };
    },
    async analyze(): Promise<AnalyzerReport> {
      return { ...CANNED_ANALYSIS, issues: [] };
    },
  };
  return { sandbox, jobs };
}

/** A repository double that answers nothing, for the reads a report makes. */
function emptyRepo() {
  return {
    find: async () => [],
    findOne: async () => null,
    findOneBy: async () => null,
    findOneByOrFail: async (where: { id?: string }) => ({ id: where?.id ?? 'ps-1' }),
    count: async () => 0,
    save: async (row: unknown) => row,
    update: async () => ({ affected: 0 }),
    create: (fields: unknown) => fields,
  };
}

/**
 * A grader wired to the real content and a recording sandbox.
 *
 * The reviewer is a stub that answers a full pass over the phase's own rubric,
 * so the strict verdict is decided by the checks rather than by a provider,
 * which is what makes `passed` a recordable fact.
 */
export function graderFor(content: ContentService, slug = 'tasktrackr'): {
  service: FeedbackService;
  jobs: RecordedJob[];
} {
  const { sandbox, jobs } = recordingSandbox();
  const assistant = {
    reviewSubmission: async (phase: PhaseContent) => ({
      provider: 'recorded-stub',
      verdict: 'pass' as const,
      summary: 'recorded',
      strengths: [],
      improvements: [],
      processNote: '',
      criteriaEvidence: phase.rubric.criteria.map((criterion) => ({
        key: criterion.key,
        met: true,
        evidence: 'recorded',
        issue: '',
        nextStep: '',
      })),
    }),
  };
  // The enrolment the graded phase is resolved through. It answers a slug
  // because the conformance ledger asks the enrolment for the design phase:
  // a double that answered nothing would lose the ledger to the catch around
  // the report sections, and the net would record a report with a hole in it.
  // It answers the slug being graded: a fixed 'tasktrackr' would make any
  // other pack's ledger ask for a project that is not loaded.
  const enrollments = {
    ...emptyRepo(),
    findOneByOrFail: async () => ({ id: 'e-1', userId: 'u-1', projectSlug: slug }),
  };
  // The one thing the graders ask the execution service for: which of the
  // learner's files a tests run collects. It is a pure function of the content
  // and the workspace, so the net borrows the **real** method rather than
  // copying its four lines: a copy would keep passing on the day the original
  // changed.
  const learnerTestFiles = ExecutionService.prototype.learnerTestFiles as unknown as (
    this: { content: ContentService },
    phase: PhaseContent,
    workspace: Record<string, string> | null,
    paths: string[],
  ) => Record<string, string>;
  const execution = { learnerTestFiles: learnerTestFiles.bind({ content }) };
  const service = new FeedbackService(
    emptyRepo() as never,
    emptyRepo() as never,
    enrollments as never,
    emptyRepo() as never,
    content,
    sandbox as never,
    execution as never,
    assistant as never,
    { register: () => undefined, enqueue: async () => undefined, durable: false } as never,
    { emitJob: () => undefined } as never,
    { onVerdict: async () => undefined } as never,
  );
  return { service, jobs };
}

/**
 * The fixed learner workspace, by phase key.
 *
 * Every phase is graded against the pack's own shipped scaffold (the bytes a
 * learner's first submission is made of) with **one** overlay, and the overlay
 * earns its place: the deployment phase's scaffold Dockerfile has three TODOs
 * in it, and a Dockerfile with no ENTRYPOINT has nothing to start, so the smoke
 * run and the drill's run against the faulted copy never happen and the phase
 * records no microVM at all. The net's second number is *the same microVMs in
 * the same order*, and a phase that runs none would record nothing to compare.
 *
 * So the deployment workspace carries a finished Dockerfile: fixed bytes, in
 * this file, written once. `dockerEntrypoint` reads `WORKDIR` and the exec-form
 * `ENTRYPOINT`, makes the path relative to the working directory, and checks
 * the script is one of the job's own files: `api/main.py`, which the phase's
 * smoke declaration mounts.
 */
export const FIXED_WORKSPACE: Record<string, Record<string, string>> = {
  deployment: {
    'api/Dockerfile': [
      '# syntax=docker/dockerfile:1',
      'FROM python:3.11-slim',
      'WORKDIR /app',
      'COPY . .',
      'RUN pip install --no-cache-dir -r requirements.txt',
      'ENV TASKTRACKR_DB=/data/tasktrackr.db',
      'ENV HOST=0.0.0.0',
      'ENV PORT=8000',
      'VOLUME ["/data"]',
      'EXPOSE 8000',
      'ENTRYPOINT ["python3", "/app/api/main.py"]',
      '',
    ].join('\n'),
  },
};

/** The phase state a phase is graded against: the scaffold, and the overlay. */
export function fixedState(phase: PhaseContent, order: number): Record<string, unknown> {
  return {
    id: `ps-${phase.key}`,
    enrollmentId: 'e-1',
    userId: 'u-1',
    phaseKey: phase.key,
    phaseOrder: order,
    status: 'in_progress',
    bestScore: null,
    attempts: 1,
    reflection: null,
    workspace: FIXED_WORKSPACE[phase.key] ?? null,
    acceptedScreenCopy: null,
    links: null,
    drill: null,
    ranBeforeSubmit: true,
    unlockedAt: null,
    passedAt: null,
    interview: null,
    solutionReadAt: null,
    runClock: null,
  };
}

/** Grade every phase of a pack and record what came out, in phase order. */
export async function recordVerdicts(
  content: ContentService,
  slug = 'tasktrackr',
  budgets: Record<string, number> = {},
): Promise<VerdictDigestManifest> {
  const project = content.getProject(slug);
  const manifest: VerdictDigestManifest = { slug, version: project.version, phases: {} };
  for (const phase of project.phases) {
    const { service, jobs } = graderFor(content, slug);
    // The phase's synthesised sole task: the list the compiler produces for
    // every phase of the shipped project, and the list `getTasksForEnrollment`
    // falls back to. `soleTaskList` is true over it, so every per-task
    // derivation in the grader takes its phase-wide arm, and the digests below
    // hold phase-wide grading unchanged.
    const tasks = [soleTaskFor(phase)];
    const report = await service.buildReport(
      phase,
      fixedState(phase, phase.order) as never,
      tasks,
      tasks[0],
    );
    manifest.phases[phase.key] = {
      report: digestOf(canonicalJson(canonicalVerdict(report))),
      sandboxBudget: budgets[phase.key] ?? 0,
      checks: report.checks.map((check) => ({ id: check.id, status: check.status })),
      jobs,
    };
  }
  return manifest;
}

/** Read the committed fixture, or null where a pack has none yet. */
export function readVerdictFixture(slug: string, dir: string = FIXTURES_DIR): VerdictDigestManifest | null {
  const at = verdictFixturePathFor(slug, dir);
  if (!fs.existsSync(at)) return null;
  return JSON.parse(fs.readFileSync(at, 'utf-8')) as VerdictDigestManifest;
}

/** What the fixture file holds, byte for byte, so the CLI and the spec agree. */
export function serialiseVerdictFixture(manifest: VerdictDigestManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
