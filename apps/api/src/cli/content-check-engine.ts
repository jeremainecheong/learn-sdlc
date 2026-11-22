import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  CHANGE_REQUEST_JSON,
  DESIGN_JSON,
  rubricCapBreaches,
  RUNBOOK_JSON,
  evaluateChangeFloor,
  evaluateDesignFloor,
  evaluateRunbookFloor,
  evaluateStoryFloor,
  isPlainText,
  isRunnerUnavailable,
  parseStoryJson,
  phaseKeyOfFolder,
  designDocumentError,
  validateChangeRequestRecord,
  validateDesignRecord,
  phaseSetRefusal,
} from '@learnsdlc/shared';
import type { PhaseKey, RunHarness, RunResult } from '@learnsdlc/shared';
import { config, findUp } from '../config';
import {
  dockerEntrypoint,
  smokeArgvFor,
  stripCodeComments,
} from '../feedback/checkers';
import { buildDrillReport } from '../feedback/drill';
import { SandboxService } from '../execution/sandbox.service';
import type { SandboxJob } from '../execution/sandbox.service';
import { ContentService, seededDesignRecord } from '../content/content.service';
import { scoredKeysFor } from '../content/rubric-scoring';
// The reference project is always in scope of every check.
import { referencePacks } from '../content/reference-content';
import { RUN_LANGUAGES } from '../content/run-languages';
import { VERSION_PATTERN } from '../content/validate';
import type {
  CodeChecks,
  ConfigChecks,
  PhaseChecks,
  PhaseContent,
  PhaseRun,
  ProjectContent,
  TestsChecks,
} from '../content/content.types';

/**
 * The content checker: every proof `content.spec.ts` asserts, rewritten to
 * report problems instead of throwing.
 *
 * The spec is the regression gate a commit has to clear; this is the tool a
 * pack author runs while they write, so it says *what* is wrong, in which
 * pack, in which phase, and which file to open, and it keeps going after the
 * first problem. Both read the same `ContentService`, the same `checkers.ts`
 * helpers and the same kill rule, so a pack change moves them together.
 *
 * Nothing here touches the database. The checker opens the packs on disk and
 * runs the sandbox; it can run against a laptop with no database at all.
 *
 * The distinction the exit code carries: **1 means a pack is wrong, 2 means
 * the checker could not tell.** A run the sandbox never performed is
 * `unavailable` (the runner's outcome, read through `isRunnerUnavailable` and
 * nothing else), never a defect: a missing socket must not mark a pack broken.
 */

export type CheckOutcome = 'ok' | 'defect' | 'unavailable' | 'skipped';

export interface CheckResult {
  /** Stable id, e.g. 'mutants-die'. `--json` is a contract: add ids, never rename them. */
  id: string;
  /** The sentence the report prints, in the product's voice. */
  label: string;
  outcome: CheckOutcome;
  pack: string;
  phase: PhaseKey | null;
  /** The right-hand column: counts, never adjectives. */
  detail: string;
  /** Only on a defect: what to open and what to add, one sentence each. */
  remedy: string[];
  /** Only on a defect: the file paths a person should open. */
  files: string[];
  durationMs: number;
}

export interface ContentCheckReport {
  packs: { slug: string; version: string; language: string; phases: number }[];
  results: CheckResult[];
  defects: number;
  unavailable: number;
  skipped: number;
  /** Pack directories the loader refused, with its own message. */
  loadFailures: { pack: string; message: string }[];
  durationMs: number;
  /** 0 clean, 1 a pack is wrong, 2 the checker could not tell. */
  exitCode: 0 | 1 | 2;
}

/* ----------------------------- the preview job ---------------------------- */

/**
 * The preview job, as `preview-starts` sends it: the app-start envelope,
 * with the fields the runner's `/app/start` already reads.
 */
export interface SandboxAppJob {
  mode: 'preview';
  files: Record<string, string>;
  build?: { tool: 'esbuild'; entry: string; outfile: string; jsx: string };
  service: { command: string[]; portEnv: string; health: string };
  web: { root: string; html: string };
  env?: Record<string, string>;
  seed?: string[];
  ttlSeconds?: number;
  idleSeconds?: number;
  memoryMb?: number;
}

/** What the runner answers about a live preview. Never the port, never the capability. */
export interface SandboxAppSession {
  id: string;
  /** 'starting' | 'ready' | 'failed' | 'stopped' | 'busy' | 'unavailable'. */
  status: string;
  message?: string | null;
  bundleOk?: boolean;
  console?: { stream: string; text: string; at?: string }[];
}

/**
 * The preview transport `preview-starts` calls. The real one lives on
 * `SandboxService`; this is the seam the checker was written against, and it is
 * **optional** on `SandboxLike` on purpose: a build whose sandbox cannot start
 * an app reports the check as `unavailable` ("the checker could not tell"),
 * never as a defect in the pack.
 */
export interface SandboxAppLike {
  startApp(job: SandboxAppJob): Promise<SandboxAppSession>;
  statusApp(id: string): Promise<SandboxAppSession>;
  /** `at` is relative to `web.root`, e.g. "index.html"; `body` is already decoded. */
  assetApp(id: string, at: string): Promise<{ status: number; contentType: string; body: string }>;
  stopApp(id: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */

/** Just enough of `SandboxService` to run a job: a stub stands in for it in tests. */
export interface SandboxLike extends Partial<SandboxAppLike> {
  execute(job: SandboxJob): Promise<RunResult>;
}

export interface ContentCheckOptions {
  /** The packs to check. Defaults to whatever `CONTENT_DIR` holds. */
  projects?: ProjectContent[];
  sandbox?: SandboxLike;
  /** Skip every sandbox proof: the loader and the static invariants only. */
  quick?: boolean;
  /** Run only these check ids. */
  only?: string[];
  /** Called as each result lands, so a caller can print while the sandbox works. */
  onResult?: (result: CheckResult) => void;
}

/* ------------------------------ loading ---------------------------------- */

export interface PackLoad {
  /** The directory the packs were read from. */
  dir: string;
  /** Every directory under it that holds a `project.json`. */
  packs: string[];
  projects: ProjectContent[];
  /** Directories that did not load; `message` is the loader's own, verbatim. */
  failures: { pack: string; message: string }[];
}

/**
 * Load every pack, keeping what loaded when one refuses. `loadAll` throws on
 * the first bad pack, so the packs it had already read stay in the service and
 * the rest are reported as unchecked rather than silently dropped.
 */
export function loadPacks(): PackLoad {
  const dir = config.contentDir;
  const packs = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'project.json')))
        .map((e) => e.name)
        .sort()
    : [];
  const content = new ContentService();
  let message = '';
  try {
    content.loadAll();
  } catch (err) {
    message = (err as Error).message;
  }
  // sorted, so a report reads the same on every machine
  const projects = content.listProjects().sort((a, b) => a.slug.localeCompare(b.slug));
  const loaded = new Set(projects.map((p) => p.slug));
  const failures = packs
    .filter((pack) => !loaded.has(pack))
    .map((pack) => ({ pack, message: message.startsWith(`${pack}/`) ? message : '' }));
  return { dir, packs, projects, failures };
}

/* ------------------------------- helpers --------------------------------- */

/**
 * A run that never happened: the transport failed, so nothing is known. The
 * message is the report's detail line, because "the runner could not be
 * reached" and "this transport cannot run an app at all" are different facts
 * about a deployment and both are "could not tell", never a defect.
 */
class RunnerUnavailable extends Error {
  constructor(message = 'the code runner could not be reached') {
    super(message);
  }
}

async function mustRun(sandbox: SandboxLike, job: SandboxJob): Promise<RunResult> {
  const run = await sandbox.execute(job);
  // the runner's own outcome, and nothing else: never re-derived from stderr
  if (isRunnerUnavailable(run)) throw new RunnerUnavailable();
  return run;
}

const firstLine = (text: string): string => (text.split('\n')[0] || '').trim().slice(0, 160);

/** The authored layout of a pack on disk, so a finding can name a file to open. */
interface PackLayout {
  /** phase key -> directory, relative to the repository. */
  dirs: Map<string, string>;
  /** phase key -> the authored `phase.json`. */
  specs: Map<string, any>;
}

/** Keyed by content directory as well as slug: a test may point CONTENT_DIR elsewhere. */
const layouts = new Map<string, PackLayout>();

function layoutOf(slug: string): PackLayout {
  const key = `${config.contentDir}:${slug}`;
  const cached = layouts.get(key);
  if (cached) return cached;
  const layout: PackLayout = { dirs: new Map(), specs: new Map() };
  const root = path.join(config.contentDir, slug, 'phases');
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // the folder's name says the phase: phase.json names no key
      const key = phaseKeyOfFolder(entry.name);
      const spec = JSON.parse(fs.readFileSync(path.join(root, entry.name, 'phase.json'), 'utf-8'));
      layout.dirs.set(key, [path.basename(config.contentDir), slug, 'phases', entry.name].join('/'));
      layout.specs.set(key, spec);
    }
  } catch {
    // a pack held only in memory (a test's doctored copy) has no layout; the
    // conventional paths below are still the right thing to print
  }
  layouts.set(key, layout);
  return layout;
}

const packPath = (slug: string, ...rest: string[]): string =>
  [path.basename(config.contentDir), slug, ...rest].join('/');

const phasePath = (slug: string, key: string, ...rest: string[]): string => {
  const dir = layoutOf(slug).dirs.get(key) || packPath(slug, 'phases', key);
  return [dir, ...rest].join('/');
};

/**
 * The pack files the testing phase's reference suite is authored in: each
 * under `reference/` at the workspace path it lands on.
 */
const referenceFilesOf = (slug: string, checks: TestsChecks): string[] => {
  const dir = checksDir(slug, 'testing', 'reference');
  const paths = Object.keys(checks.referenceTestFiles).map((at) => `${dir}/${at}`);
  return paths.length ? paths : [dir];
};

/**
 * A sealed folder the layout fixes: `solution/` or `reference/`,
 * or a run's hidden suite, `hidden_tests/<run id>/`. No `checks` member names
 * a folder any more.
 */
const checksDir = (slug: string, key: string, folder: 'solution' | 'reference' | 'hidden_tests', run?: string): string =>
  folder === 'hidden_tests' ? phasePath(slug, key, folder, ...(run ? [run] : [])) : phasePath(slug, key, folder);

function requirePhase<K extends PhaseContent['checks']['kind']>(
  project: ProjectContent,
  key: PhaseKey,
  kind: K,
): PhaseContent {
  const phase = project.phases.find((p) => p.key === key);
  if (!phase) throw new Error(`the pack has no ${key} phase`);
  if (phase.checks.kind !== kind) {
    throw new Error(`the ${key} phase declares checks.kind "${phase.checks.kind}", not "${kind}"`);
  }
  return phase;
}

const fileContent = (phase: PhaseContent, at: string): string =>
  phase.files.find((f) => f.path === at)?.content || '';

/**
 * The approved backlog a criterion id is looked up in: the Requirements
 * phase's provided stories (`checks.providedStories`, each story's own
 * `criteria`), and the learner's story, whose criteria the learner mints. A
 * pack whose Requirements is not a story phase is refused by name.
 */
function backlogOf(project: ProjectContent): {
  source: string;
  file: string;
  learnerStory: string | null;
  declares: (story: string, ac: string) => boolean;
} {
  const checks = requirePhase(project, 'requirements', 'story').checks as Extract<PhaseContent['checks'], { kind: 'story' }>;
  return {
    source: "the Requirements phase's provided stories",
    file: phasePath(project.slug, 'requirements', 'phase.json'),
    learnerStory: checks.learnerStory.id,
    declares: (story, ac) =>
      checks.providedStories.some((s) => s.id === story && (s.criteria ?? []).some((c) => c.id === ac)),
  };
}

/** The smoke run exactly as the feedback pipeline performs it. */
async function smokeRun(
  sandbox: SandboxLike,
  phase: PhaseContent,
  files: Record<string, string>,
): Promise<{ ok: boolean; detail: string }> {
  const checks = phase.checks as ConfigChecks;
  // A two-service pack ships api/Dockerfile and web/Dockerfile, and the
  // pack says which one the container under the smoke run is built from. Read
  // 'Dockerfile' here and the smoke run parses a file the phase never mounts,
  // which fails every workspace for a missing ENTRYPOINT whatever it holds.
  const entry = dockerEntrypoint(files[checks.smokeDockerfile] || '', {
    ...checks.smokeImplFiles,
    ...files,
  });
  // an entrypoint the parser refuses never reaches the runner: that is a
  // verdict about the Dockerfile, not a run that failed
  if (!entry.argv.length) return { ok: false, detail: entry.problem || '' };
  const run = await mustRun(sandbox, {
    files: { ...checks.smokeImplFiles, ...files },
    mode: 'smoke',
    smokeCommands: smokeArgvFor(entry.argv, checks.smokeCommands),
    expectInOutput: checks.expectInOutput,
    language: phase.language,
  });
  // stderr first, then stdout: a program that refuses politely writes its one
  // sentence to stdout and exits 1 (`ops/selfcheck.py` does), so a check that
  // reads only stderr sees a failure with nothing in it
  return { ok: run.ok, detail: [run.stderr, run.stdout].filter(Boolean).join('\n') };
}

/** A Dockerfile a learner could hand in: WORKDIR and ENTRYPOINT agree. */
const WORKING_DOCKERFILE: Record<string, string> = {
  python: 'FROM python:3.11-slim\nWORKDIR /app\nCOPY . /app\nENTRYPOINT ["python", "cli.py"]\n',
  javascript: 'FROM node:22-slim\nWORKDIR /app\nCOPY . /app\nENTRYPOINT ["node", "cli.js"]\n',
};

/* ------------------------- the two-service forgery ------------------------ */

/**
 * A two-service image a learner could hand in, for a pack whose smoke run
 * builds `api/Dockerfile` rather than a root one. It is a *pair*: the api image
 * and the compose file the selfcheck reads, because this pack's build check
 * asks whether the web service can reach the api service, and a Dockerfile
 * alone cannot answer that.
 */
const WORKING_API_DOCKERFILE =
  'FROM python:3.11-slim\nWORKDIR /app\nCOPY requirements.txt ./\nCOPY api/ ./api/\n' +
  'COPY ops/ ./ops/\nCOPY docker-compose.yml ./\n' +
  'RUN pip install --no-cache-dir -r requirements.txt\n' +
  'ENV TASKTRACKR_DB=/data/tasktrackr.db\nENV HOST=0.0.0.0\nENV PORT=8000\n' +
  'VOLUME ["/data"]\nEXPOSE 8000\nENTRYPOINT ["python3", "api/main.py"]\n';

/**
 * A workspace a learner could hand in for this pack's build check, keyed by the
 * Dockerfile the smoke run builds. `null` when the pack's shape has no reference
 * pair here, which is `skipped` rather than a defect.
 */
function workingWorkspace(
  project: ProjectContent,
  checks: ConfigChecks,
): Record<string, string> | null {
  if (checks.smokeDockerfile === 'api/Dockerfile') {
    const compose = canonicalTree(project.slug)['docker-compose.yml'];
    if (!compose) return null;
    return { 'api/Dockerfile': WORKING_API_DOCKERFILE, 'docker-compose.yml': compose };
  }
  const working = WORKING_DOCKERFILE[project.language];
  return working ? { [checks.smokeDockerfile]: working } : null;
}

/** The runs a phase grades. Markdown and config phases declare none. */
const runsOf = (checks: PhaseChecks): PhaseRun[] =>
  checks.kind === 'code' || checks.kind === 'tests' ? checks.runs : [];

/**
 * One run's job, built the way `feedback.service.ts` builds it: the run's own
 * language, its own harness and its own transform. Sending the phase's language
 * with no harness is the defect this helper exists to prevent: unittest
 * collects nothing from a file of pytest functions and nothing from a `.tsx`
 * file, and a run that collected nothing reads as a green one.
 */
const runJob = (
  run: PhaseRun,
  files: Record<string, string>,
  testPaths: string[],
  harness: RunHarness,
): SandboxJob => ({
  files,
  mode: 'tests',
  testPaths,
  language: run.language,
  harness,
  ...(run.transform ? { transform: { tool: 'esbuild' as const, jsx: 'automatic' as const } } : {}),
});

/** How a run is named in a report line: the layer a learner would say. */
const runName = (phase: PhaseContent, run: PhaseRun, runs: PhaseRun[]): string =>
  runs.length > 1 ? `${phase.key} ${run.language}` : phase.key;

const SKIP_IN_CANONICAL = new Set(['node_modules', '__pycache__', 'dist', 'build']);

/** The pack's canonical application on disk, or null when it ships none. */
function canonicalRoot(slug: string): string | null {
  const at = path.join(config.contentDir, slug, 'canonical');
  return fs.existsSync(at) ? at : null;
}

/**
 * Every file under the pack's canonical application, keyed by its path inside
 * it. The canonical is where the application actually lives: the phases mount
 * pieces of it, and two of them mount a *scaffold* of `shared/contract/api.json`
 * with operations removed, so a check about the application has to read the
 * canonical rather than a phase.
 */
function canonicalTree(slug: string, sub = ''): Record<string, string> {
  const root = canonicalRoot(slug);
  const out: Record<string, string> = {};
  if (!root) return out;
  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIP_IN_CANONICAL.has(entry.name)) continue;
      const at = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(at, rel);
      else out[rel] = fs.readFileSync(at, 'utf-8');
    }
  };
  const start = sub ? path.join(root, sub) : root;
  if (!fs.existsSync(start)) return out;
  walk(start, sub);
  return out;
}

/** A route path with every parameter reduced to one token: `/api/tasks/{}`. */
const routeShape = (at: string): string => at.replace(/<[^>]*>|\{[^}]*\}/g, '{}');

/**
 * Flask's route decorators, as they are written in this pack:
 * `@bp.get("/api/lists")`, `@app.post(...)`, `@bp.route("/x", methods=["PUT"])`.
 */
const ROUTE_DECORATOR = /@[A-Za-z_][\w.]*\.(get|post|put|patch|delete|route)\(\s*(['"])([^'"]+)\2([^)]*)\)/g;

function declaredRoutes(sources: Record<string, string>): Map<string, string> {
  const found = new Map<string, string>();
  for (const [at, source] of Object.entries(sources)) {
    if (!at.endsWith('.py')) continue;
    for (const match of source.matchAll(ROUTE_DECORATOR)) {
      const [, verb, , route, rest] = match;
      const methods =
        verb === 'route'
          ? [...(rest.match(/methods\s*=\s*\[([^\]]*)\]/)?.[1] || 'GET').matchAll(/['"]([A-Z]+)['"]/g)].map(
              (m) => m[1],
            )
          : [verb.toUpperCase()];
      for (const method of methods.length ? methods : ['GET']) {
        found.set(`${method} ${routeShape(route)}`, at);
      }
    }
  }
  return found;
}

/** Column name -> "is it NOT NULL", per table, read out of the pack's own DDL. */
function schemaColumns(source: string): Map<string, Map<string, boolean>> {
  const tables = new Map<string, Map<string, boolean>>();
  const CONSTRAINT = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i;
  // comments go first, whole-file: a column commented "-- ISO date, or NULL"
  // carries a comma, and splitting before stripping makes the next column's
  // name "or"
  const ddl = source.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of ddl.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(/gi)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let i = start;
    for (; i < ddl.length && depth > 0; i += 1) {
      if (ddl[i] === '(') depth += 1;
      else if (ddl[i] === ')') depth -= 1;
    }
    const body = ddl.slice(start, i - 1);
    const parts: string[] = [];
    let level = 0;
    let current = '';
    for (const ch of body) {
      if (ch === '(') level += 1;
      if (ch === ')') level -= 1;
      if (ch === ',' && level === 0) {
        parts.push(current);
        current = '';
      } else current += ch;
    }
    parts.push(current);
    const columns = new Map<string, boolean>();
    for (const raw of parts) {
      const line = raw.trim();
      if (!line || CONSTRAINT.test(line)) continue;
      const name = (line.match(/^["`]?(\w+)["`]?/) || [])[1];
      if (!name) continue;
      columns.set(name, /\bNOT\s+NULL\b/i.test(line) || /\bPRIMARY\s+KEY\b/i.test(line));
    }
    tables.set(match[1], columns);
  }
  return tables;
}

/** The browser-held state the opaque-origin preview iframe makes unusable. */
const BROWSER_STORAGE = [
  { name: 'localStorage', pattern: /\blocalStorage\b/ },
  { name: 'sessionStorage', pattern: /\bsessionStorage\b/ },
  { name: 'document.cookie', pattern: /\bdocument\s*\.\s*cookie\b/ },
  { name: 'history.pushState', pattern: /\bhistory\s*\.\s*pushState\b/ },
];

/* -------------------------------- checks --------------------------------- */

interface CheckFinding {
  detail: string;
  remedy?: string[];
  files?: string[];
  skipped?: boolean;
}

interface CheckContext {
  project: ProjectContent;
  /** The pack's own folder on disk (`<content>/<slug>`), the folder the loader read it from. */
  root: string;
  /** Used only for its pure helpers: `executionFiles`, `drillSpec`, `faultedExecutionFiles`. */
  content: ContentService;
  sandbox: SandboxLike;
}

interface CheckSpec {
  id: string;
  label: string;
  phase: PhaseKey | null;
  /** Calls the sandbox: skipped by `--quick`, unavailable when the runner is down. */
  sandbox: boolean;
  run(ctx: CheckContext): Promise<CheckFinding>;
  /**
   * Whether the check applies to this pack: null
   * when it does, else the one sentence a skipped row prints. Absent means it
   * always applies. A check written for the reference project's conventions
   * applies to the reference project whatever is doctored in it, and to any
   * other pack only once that pack opts into the convention it proves.
   */
  applies?(project: ProjectContent): string | null;
}

/** A reference project is held to every convention it set. */
const isReferencePack = (project: ProjectContent): boolean => referencePacks().includes(project.slug);

const CRITERION_ID = /^US-\d+\/AC-\d+$/;

/** What the runner can execute: the pack may not name anything else. */
const RUNNER_LANGUAGES = new Set<string>(RUN_LANGUAGES);

/**
 * The runner's own sentence for a machine that has not run the pre-bake. It is
 * a machine that is not set up, not a pack that is wrong, so a check that meets
 * it is `skipped`: `prebake-available` is the one that reports it.
 */
const NO_PREBAKE = /sandbox dependencies are not built/i;

/**
 * How long `preview-starts` waits for the pack's own app. Longer than the
 * runner's own boot budget (PREVIEW_BOOT_SECONDS, 45), because the bundle and
 * the seed happen before the probe starts.
 */
const PREVIEW_CHECK_SECONDS = 90;

export const CHECKS: CheckSpec[] = [
  {
    id: 'pack-loads',
    label: 'the pack loads',
    phase: null,
    sandbox: false,
    async run({ project }) {
      const remedy: string[] = [];
      // the subset rule: at least one phase, each once, in
      // LearnSDLC's order, numbered 1 to n; its gapped arm is the order check
      const fault = phaseSetRefusal(project.phases);
      if (fault) remedy.push(fault.sentence);
      if (!VERSION_PATTERN.test(project.version)) {
        remedy.push(`the version "${project.version}" is not MAJOR.MINOR.PATCH`);
      }
      const phaseFiles: string[] = [];
      let textRemedies = 0;
      for (const phase of project.phases) {
        const sum = phase.rubric.criteria.reduce((s, c) => s + c.weight, 0);
        if (Math.abs(sum - 1) >= 1e-9) {
          remedy.push(`${phase.key}: the rubric weights sum to ${sum.toFixed(3)}, not 1`);
        }
        // the builder's Criteria step sends every row as loaded, and the
        // editor's DTO caps them, so a pack over a cap is refused on any copy
        // of the pack, even for a weight change alone (`rubricCapBreaches`,
        // the loader's own check on an upload)
        const before = remedy.length;
        for (const breach of rubricCapBreaches(phase.rubric)) remedy.push(`${phase.key}: ${breach}`);
        if (remedy.length > before) {
          textRemedies += remedy.length - before;
          phaseFiles.push(phasePath(project.slug, phase.key, 'phase.json'));
        }
      }
      // a pack that names a language the runner cannot execute, or a run
      // whose language the pack never declared, loads and then fails every
      // learner at the first Run press with a transport-shaped error
      const declared = project.languages || [];
      for (const language of declared) {
        if (!RUNNER_LANGUAGES.has(language)) {
          remedy.push(
            `project.languages names "${language}", which the runner cannot execute; it runs ${[...RUNNER_LANGUAGES].join(', ')}`,
          );
        }
      }
      if (declared.length && !declared.some((l) => l === project.language)) {
        remedy.push(
          `project.language is "${project.language}", which project.languages does not list`,
        );
      }
      for (const phase of project.phases) {
        for (const run of runsOf(phase.checks)) {
          if (!declared.includes(run.language)) {
            remedy.push(
              `${phase.key}: run "${run.id}" is ${run.language}, which project.languages does not list`,
            );
          }
        }
      }
      // a written phase and a story phase run nothing; code, tests and config do
      const runsCode = project.phases.filter((p) => ['code', 'tests', 'config'].includes(p.checks.kind)).length;
      const runs = project.phases.reduce((n, p) => n + runsOf(p.checks).length, 0);
      return {
        detail: `${project.phases.length} phases, ${runsCode} run code, ${runs} runs in ${declared.join(' and ') || project.language}, weights sum to 1 in each`,
        remedy,
        files: remedy.length > textRemedies ? [packPath(project.slug, 'project.json'), ...phaseFiles] : phaseFiles,
      };
    },
  },
  {
    id: 'brief-plain',
    label: 'every brief and phase text is plain text',
    phase: null,
    sandbox: false,
    async run({ project }) {
      const remedy: string[] = [];
      for (const phase of project.phases) {
        const texts: [string, string][] = [['taskPanel', phase.taskPanel], ['intro', phase.intro], ...phase.objectives.map((one, at): [string, string] => [`objectives[${at}]`, one]),
          ...phase.rubric.criteria.flatMap((c): [string, string][] => [[`rubric ${c.key} title`, c.title], [`rubric ${c.key} description`, c.description ?? '']]),
          ['assistant.systemPrompt', phase.assistant.systemPrompt],
          // each hint's own string, so the remedy names the hint and no JSON punctuation is read as markdown
          ...phase.assistant.topics.flatMap((one, at) => one.hints.map((hint, step): [string, string] => [`assistant.topics[${at}].hints[${step}]`, hint])),
          ...phase.assistant.progressive.map((hint, step): [string, string] => [`assistant.progressive[${step}]`, hint])];
        for (const [member, text] of texts) if (!isPlainText(text)) remedy.push(`${phase.key}: ${member} is not plain text`);
      }
      return { detail: `${project.phases.length} phases read`, remedy, files: [] };
    },
  },
  {
    id: 'canonical-copies-agree',
    label: "every read-only copy of a canonical file is the canonical file's bytes",
    phase: null,
    sandbox: false,
    applies: (project) => (isReferencePack(project) ? null : 'only the reference project keeps a canonical/ folder'),
    async run({ project, root }) {
      // the three locked files each phase owns by design
      const own = new Set(['implementation:tests/test_tasks_api.py', 'implementation:web/src/lib/overdue.test.ts', 'maintenance:tests/test_comments_api.py']);
      const remedy: string[] = [];
      for (const phase of project.phases) {
        for (const file of phase.files) {
          if (file.editable || own.has(`${phase.key}:${file.path}`)) continue;
          const canonical = path.join(root, 'canonical', file.path);
          if (fs.existsSync(canonical) && fs.readFileSync(canonical, 'utf8') !== file.content) remedy.push(`${phase.key}: readonly/${file.path} differs from canonical/${file.path}`);
        }
      }
      return { detail: 'read-only copies checked against canonical/', remedy, files: [] };
    },
  },
  {
    id: 'rubric-keys-scored',
    label: 'every rubric key is one the grader sets',
    phase: null,
    sandbox: false,
    async run({ project }) {
      const remedy: string[] = [];
      const files: string[] = [];
      let criteria = 0;
      for (const phase of project.phases) {
        const declared = phase.rubric.criteria.map((c) => c.key);
        criteria += declared.length;
        const scored = scoredKeysFor(phase.checks, phase.rubric);
        const unscored = declared.filter((k) => !scored.has(k));
        const unclaimed = [...scored].filter((k) => !declared.includes(k));
        // `assembleCriteria` reads `scores.get(key) ?? 0`, so a key nothing
        // scores is a flat zero with no evidence for every learner of the pack
        for (const key of unscored) {
          remedy.push(`${phase.key}: the rubric names "${key}" but nothing scores it, so it is a flat zero for every learner`);
        }
        for (const key of unclaimed) {
          remedy.push(`${phase.key}: "${key}" is scored but no rubric criterion claims it, so it is graded into nothing`);
        }
        if (unscored.length || unclaimed.length) {
          files.push(phasePath(project.slug, phase.key, 'phase.json'));
        }
      }
      return { detail: `${criteria} criteria across ${project.phases.length} phases`, remedy, files };
    },
  },
  // The design board opens on the record this scaffold ships: the Design must
  // be of the design kind, and its record a valid design record holding at
  // least one decision (an empty scaffold is a scaffold; the board supplies
  // the rest of each record).
  {
    id: 'design-decision-scaffold',
    label: 'the design scaffold offers a decision record',
    phase: 'design',
    sandbox: false,
    // the decision board is the reference project's design room; another
    // pack is held to it only when it ships a starting record of its own (a
    // design-kind phase that ships none is mounted the empty one the loader
    // seeds, which the teacher chose by shipping nothing)
    applies: (project) => {
      const design = project.phases.find((p) => p.key === 'design');
      if (isReferencePack(project) || !design) return null;
      const record = design.files.find((f) => f.path === DESIGN_JSON);
      if (!record) return 'the design phase ships no decision board (design/design.json), so there is no decision record to prove';
      if (design.checks.kind === 'design' && record.content === seededDesignRecord()) {
        return 'the design phase ships no starting record (design/design.json is the empty one the loader seeds), so there is no decision record to prove';
      }
      return null;
    },
    async run({ project }) {
      // a Design still of the markdown kind is refused by name, as the
      // Requirements rule refuses a markdown Requirements
      const phase = requirePhase(project, 'design', 'design');
      const file = phase.files.find((f) => f.path === DESIGN_JSON);
      const out = validateDesignRecord(file?.content ?? '');
      const remedy: string[] = [];
      // the loader's sentence, by the one door every reader of the record uses
      if (out.error !== null) remedy.push(`${DESIGN_JSON}: ${designDocumentError(DESIGN_JSON, file?.content ?? '')}`);
      else if (out.design.decisions.length === 0) {
        remedy.push(`${DESIGN_JSON} ships no decision; ship one entry so the learner starts on a record rather than on a button`);
      }
      const decisions = out.design?.decisions.length ?? 0;
      return {
        detail: `${decisions} ${decisions === 1 ? 'decision record' : 'decision records'} in the scaffold`,
        remedy,
        files: remedy.length ? [phasePath(project.slug, 'design', 'files', 'design', 'design.json')] : [],
      };
    },
  },
  {
    id: 'runs-agree',
    label: 'every run names files the phase ships',
    phase: null,
    sandbox: false,
    async run({ project }) {
      const remedy: string[] = [];
      const files: string[] = [];
      let runs = 0;
      let paths = 0;
      for (const phase of project.phases) {
        const mounted = new Map(phase.files.map((f) => [f.path, f]));
        const flag = (): void => {
          const at = phasePath(project.slug, phase.key, 'phase.json');
          if (!files.includes(at)) files.push(at);
        };
        for (const run of runsOf(phase.checks)) {
          runs += 1;
          const known = [...mounted.keys(), ...Object.keys(run.hiddenTestFiles)];
          // a test path may name a directory, which is what a walked run does
          const carried = (at: string): boolean =>
            known.some((p) => p === at || p.startsWith(`${at}/`));
          for (const at of run.testPaths) {
            paths += 1;
            if (carried(at)) continue;
            remedy.push(
              `${phase.key}, run ${run.id}: testPaths names "${at}", which the phase neither mounts nor hides, so the run collects nothing`,
            );
            flag();
          }
          for (const at of run.visibleTests) {
            paths += 1;
            if (mounted.has(at)) continue;
            remedy.push(
              `${phase.key}, run ${run.id}: visibleTests names "${at}", which the phase does not mount, so the learner cannot run the test they are shown`,
            );
            flag();
          }
          for (const at of Object.keys(run.supportFiles)) {
            paths += 1;
            const file = mounted.get(at);
            if (!file) {
              remedy.push(
                `${phase.key}, run ${run.id}: the support file "${at}" is not one of the phase's files, so the learner would import a file they cannot see`,
              );
              flag();
            } else if (file.editable) {
              remedy.push(
                `${phase.key}, run ${run.id}: the support file "${at}" is editable, so the learner can rewrite the helper their own suite is scored through`,
              );
              flag();
            }
          }
        }
        if (project.build && phase.canPreview && !mounted.has(project.build.entry)) {
          remedy.push(
            `${phase.key} can preview but does not mount ${project.build.entry}, which project.json's build names as the front end's entry point, so the preview would start an API with no page in front of it`,
          );
          flag();
        }
      }
      return {
        detail: remedy.length
          ? `${runs} runs, ${paths} paths, ${remedy.length} the phase does not ship`
          : `${runs} runs, ${paths} paths, all accounted for`,
        remedy,
        files,
      };
    },
  },
  {
    id: 'no-graded-file-in-the-workspace',
    label: 'no graded file is in the workspace',
    phase: null,
    sandbox: false,
    async run({ project }) {
      const remedy: string[] = [];
      const files: string[] = [];
      let hidden = 0;
      let planted = 0;
      for (const phase of project.phases) {
        const mounted = new Map(phase.files.map((f) => [f.path, f]));
        for (const run of runsOf(phase.checks)) {
          for (const at of Object.keys(run.hiddenTestFiles)) {
            hidden += 1;
            if (!mounted.has(at)) continue;
            remedy.push(
              `${phase.key}, run ${run.id}: the hidden suite ships "${at}", which the phase also mounts, so the learner can read the suite that grades them`,
            );
            files.push(
              checksDir(project.slug, phase.key, 'hidden_tests', run.id),
              phasePath(project.slug, phase.key, 'phase.json'),
            );
          }
        }
        if (phase.checks.kind !== 'tests') continue;
        const checks = phase.checks as TestsChecks;
        for (const mutant of checks.mutants) {
          const run = runsOf(checks).find((r) => r.id === mutant.run);
          for (const at of Object.keys(mutant.files)) {
            planted += 1;
            // a mutant lands on the implementation it grades, which the phase
            // may well mount: the whole application is mounted so the phase
            // can preview. What must not happen is a mutant landing on a file
            // the learner edits: their own copy overwrites the planted bug and
            // the mutant is unkillable for a reason no report explains.
            if (mounted.get(at)?.editable) {
              remedy.push(
                `${phase.key}: the mutant ${mutant.name} rewrites "${at}", which the learner edits, so their own file overwrites the planted bug`,
              );
              files.push(phasePath(project.slug, 'testing', 'mutants', mutant.name));
            } else if (run && !(at in run.implFiles)) {
              remedy.push(
                `${phase.key}: the mutant ${mutant.name} rewrites "${at}", which run "${run.id}" does not grade, so nothing the reference suite exercises ever loads it`,
              );
              files.push(phasePath(project.slug, 'testing', 'mutants', mutant.name));
            }
          }
        }
      }
      return {
        detail: remedy.length
          ? `${hidden} hidden files, ${planted} planted files, ${remedy.length} in the workspace`
          : `${hidden} hidden files, ${planted} planted files, none in the workspace`,
        remedy,
        files,
      };
    },
  },
  {
    id: 'prebake-available',
    label: 'the pre-baked dependency layer is here',
    phase: null,
    sandbox: false,
    async run({ project }) {
      if (!project.runtime) {
        return { detail: 'the pack declares no runtime, so nothing has to be baked', skipped: true };
      }
      const root = findUp(__dirname, path.join('scripts', 'prebake.mjs'), 8);
      if (!root) {
        return { detail: 'scripts/prebake.mjs is not on this machine', skipped: true };
      }
      const out = spawnSync(process.execPath, [path.join(root, 'scripts', 'prebake.mjs'), 'verify'], {
        encoding: 'utf-8',
        // the same packs the checker read, so a doctored content root is
        // verified against itself rather than against the shipped one
        env: { ...process.env, PREBAKE_CONTENT_DIR: config.contentDir },
      });
      const said = firstLine(out.stderr || '') || firstLine(out.stdout || '');
      if (out.status === 0) return { detail: said || 'the pre-baked layer matches the packs' };
      return {
        detail: said || 'prebake verify failed',
        remedy: [
          said,
          `Run npm run prebake. Nothing here is wrong with the pack: the sandbox runs pytest and the DOM harness out of apps/api/runner/runtime, and every check below that executes code needs it.`,
        ],
        files: [packPath(project.slug, 'project.json')],
      };
    },
  },
  {
    id: 'solution-passes-hidden',
    label: 'the shipped solution passes its hidden suite',
    phase: null,
    sandbox: true,
    async run({ project, content, sandbox }) {
      const phases = project.phases.filter((p) => p.checks.kind === 'code');
      if (!phases.length) throw new Error('the pack has no code phase, so no solution is proven');
      // one job per run, with that run's own sealed harness: the union of two
      // runs sent under one language is how a `.tsx` suite is silently dropped
      // and 8 hidden cases read as a green 14
      const outcomes: { phase: PhaseContent; run: PhaseRun; result: RunResult }[] = [];
      for (const phase of phases) {
        const checks = phase.checks as CodeChecks;
        const runs = runsOf(checks);
        for (const run of runs) {
          const testPaths = Object.keys(run.hiddenTestFiles);
          if (!testPaths.length) {
            throw new Error(`${phase.key}: run "${run.id}" ships no hidden suite`);
          }
          // overlaid exactly as a learner's workspace would be
          const result = await mustRun(
            sandbox,
            runJob(
              run,
              { ...content.executionFiles(phase, checks.solutionFiles), ...run.hiddenTestFiles },
              testPaths,
              run.hiddenHarness,
            ),
          );
          outcomes.push({ phase, run, result });
        }
      }
      const detail: string[] = [];
      const remedy: string[] = [];
      const files: string[] = [];
      for (const { phase, run, result } of outcomes) {
        const tests = result.tests;
        const total = tests?.total || 0;
        const name = runName(phase, run, runsOf(phase.checks));
        detail.push(`${name} ${tests?.passed || 0} of ${total}`);
        // total > 0 is asserted per RUN, not per phase: a phase whose other
        // run collected fourteen cases is exactly how a suite that collected
        // none stays invisible
        const clean = result.ok && !result.stderr && total > 0 && !tests?.failed && !tests?.errored;
        if (clean) continue;
        const failing = (tests?.cases || []).filter((c) => c.status !== 'passed').map((c) => c.name);
        remedy.push(
          total === 0
            ? `${name}: the hidden suite reported no cases against the shipped solution (${result.exitKind}${result.stderr ? `: ${firstLine(result.stderr)}` : ''})`
            : `${name}: the shipped solution fails ${total - (tests?.passed || 0)} of ${total} hidden cases${failing.length ? ` (${failing.slice(0, 3).join(', ')})` : ''}`,
        );
        remedy.push(
          `Either the solution is behind the suite or the suite is wrong; the first learner to find out would be the one who wrote the answer the pack calls correct.`,
        );
        files.push(
          checksDir(project.slug, phase.key, 'solution'),
          checksDir(project.slug, phase.key, 'hidden_tests', run.id),
        );
      }
      return { detail: detail.join(', '), remedy, files };
    },
  },
  {
    id: 'stub-fails-hidden',
    label: 'the shipped stub fails it',
    phase: null,
    sandbox: true,
    async run({ project, content, sandbox }) {
      const phases = project.phases.filter((p) => p.checks.kind === 'code');
      if (!phases.length) throw new Error('the pack has no code phase, so no stub is proven');
      const outcomes: { phase: PhaseContent; run: PhaseRun; result: RunResult }[] = [];
      for (const phase of phases) {
        const checks = phase.checks as CodeChecks;
        for (const run of runsOf(checks)) {
          const result = await mustRun(
            sandbox,
            runJob(
              run,
              { ...content.executionFiles(phase, null), ...run.hiddenTestFiles },
              Object.keys(run.hiddenTestFiles),
              run.hiddenHarness,
            ),
          );
          outcomes.push({ phase, run, result });
        }
      }
      const detail: string[] = [];
      const remedy: string[] = [];
      const files: string[] = [];
      for (const { phase, run, result } of outcomes) {
        const caught = (result.tests?.failed || 0) + (result.tests?.errored || 0);
        const name = runName(phase, run, runsOf(phase.checks));
        detail.push(`${name} ${caught} failed`);
        // per run, again: a run that collected nothing "fails" nothing, and
        // without this it reads as a stub the suite caught
        if (!result.ok && caught > 0) continue;
        remedy.push(
          `${name}: the stub the learner opens passes the hidden suite, so the suite has no teeth on this run`,
        );
        remedy.push(`Add a case the stub cannot satisfy, or stub the target the suite exercises.`);
        files.push(
          phasePath(project.slug, phase.key, 'files'),
          checksDir(project.slug, phase.key, 'hidden_tests', run.id),
        );
      }
      return { detail: detail.join(', '), remedy, files };
    },
  },
  {
    id: 'front-end-suite-runs',
    label: 'the canonical front-end suite runs',
    phase: null,
    sandbox: true,
    async run({ project, sandbox }) {
      if (!project.build) {
        return { detail: 'the pack builds no front end', skipped: true };
      }
      const web = canonicalTree(project.slug, 'web/src');
      const tests = Object.keys(web)
        .filter((at) => /\.test\.tsx?$/.test(at))
        .sort();
      if (!tests.length) {
        return { detail: 'the canonical front end ships no suite beside its code', skipped: true };
      }
      // the transform, the jsdom setup and the harness's async support, proved
      // together on the pack's own components rather than on a fixture
      const result = await mustRun(sandbox, {
        // The rendered screens import shared contract JSON outside web/src.
        // Keep that real build input in the isolated canonical test bundle.
        files: { ...canonicalTree(project.slug, 'shared/contract'), ...web },
        mode: 'tests',
        testPaths: tests,
        language: 'typescript',
        transform: { tool: 'esbuild', jsx: 'automatic' },
      });
      if (NO_PREBAKE.test(result.stderr || '')) {
        return { detail: firstLine(result.stderr), skipped: true };
      }
      const counts = result.tests;
      const detail = `${counts?.passed || 0} of ${counts?.total || 0} cases in ${tests.length} files`;
      if (result.ok && (counts?.total || 0) > 0 && !counts?.failed && !counts?.errored) {
        return { detail };
      }
      const bad = (counts?.cases || []).filter((c) => c.status !== 'passed');
      const compileFailure = result.exitKind === 'error';
      const networked = bad.some((c) => /made a network call/.test(c.message || ''));
      return {
        detail,
        remedy: [
          compileFailure
            ? `the canonical front end does not compile: ${firstLine(result.stderr) || bad[0]?.message || 'esbuild refused it'}`
            : `the canonical front-end suite does not pass its own components${bad.length ? `: ${bad.slice(0, 3).map((c) => c.name).join(', ')}` : ''}`,
          networked
            ? `A case reached for the network. Stub fetch in the test or exercise the API layer directly; the sandbox has no network and neither will the marking run.`
            : `The transform, the jsdom setup and the harness's async support are proved by this one run, so a learner's front-end phase cannot be graded until it passes.`,
        ],
        files: [packPath(project.slug, 'canonical', 'web', 'src')],
      };
    },
  },
  {
    id: 'reference-passes-impl',
    label: 'the reference suite passes the implementation',
    phase: 'testing',
    sandbox: true,
    async run({ project, sandbox }) {
      const phase = requirePhase(project, 'testing', 'tests');
      const checks = phase.checks as TestsChecks;
      const runs = runsOf(checks);
      const detail: string[] = [];
      const remedy: string[] = [];
      for (const run of runs) {
        const result = await mustRun(
          sandbox,
          runJob(
            run,
            // the locked helpers the suite imports ride
            // in the workspace here exactly as they do in the grader's job.
            // supportFiles is what carries api/db.py and api/schema.sql, and a
            // graded artefact that opens a file beside itself cannot be graded
            //: the graded directory is deleted before the suite runs.
            { ...run.supportFiles, ...run.implFiles, ...run.referenceTestFiles },
            run.testPaths,
            run.harness,
          ),
        );
        const tests = result.tests;
        const name = runName(phase, run, runs);
        detail.push(
          `${name} ${tests?.total || 0} cases, ${tests?.failed || 0} failed, ${tests?.errored || 0} errored`,
        );
        // a suite that fails on correct code is a bug in the suite
        const clean =
          result.ok && !result.stderr && !tests?.failed && !tests?.errored && (tests?.total || 0) > 0;
        if (clean) continue;
        const failing = (tests?.cases || []).filter((c) => c.status !== 'passed');
        remedy.push(
          `${name}: the reference suite does not pass the reference implementation (${result.exitKind}${result.stderr ? `: ${firstLine(result.stderr)}` : ''})${failing.length ? `: ${failing.slice(0, 3).map((c) => c.name).join(', ')}` : ''}`,
        );
        if (failing.some((c) => c.status === 'errored')) {
          remedy.push(
            `A graded implementation file that opens a file beside itself cannot be graded: the graded directory is deleted before the learner's code runs, so the data file and the module that reads it both belong in checks.supportFiles.`,
          );
        }
        remedy.push(`A suite that fails on correct code fails every learner who writes correct code.`);
      }
      return {
        detail: detail.join('; '),
        remedy,
        files: remedy.length ? referenceFilesOf(project.slug, checks) : [],
      };
    },
  },
  {
    id: 'mutants-die',
    label: 'every planted bug dies',
    phase: 'testing',
    sandbox: true,
    async run({ project, sandbox }) {
      const phase = requirePhase(project, 'testing', 'tests');
      const checks = phase.checks as TestsChecks;
      if (!checks.mutants.length) throw new Error('the testing phase ships no mutants');
      // a mutant belongs to one run, so it is overlaid on that run's own
      // implementation and graded by that run's own reference suite: eight
      // mutants sent through one language is six survivors that are not real
      const outcomes: { mutant: TestsChecks['mutants'][number]; result: RunResult }[] = [];
      for (const run of runsOf(checks)) {
        for (const mutant of checks.mutants.filter((m) => m.run === run.id)) {
          outcomes.push({
            mutant,
            result: await mustRun(
              sandbox,
              runJob(
                run,
                { ...run.supportFiles, ...run.implFiles, ...mutant.files, ...run.referenceTestFiles },
                run.testPaths,
                run.harness,
              ),
            ),
          });
        }
      }
      const reference = referenceFilesOf(project.slug, checks);
      const remedy: string[] = [];
      const files: string[] = [];
      let killed = 0;
      const orphans = checks.mutants.filter((m) => !runsOf(checks).some((r) => r.id === m.run));
      for (const mutant of orphans) {
        remedy.push(
          `${mutant.name} names run "${mutant.run}", which this phase does not declare, so nothing ever ran against it`,
        );
        files.push(phasePath(project.slug, 'testing', 'mutants', mutant.name));
      }
      for (const { mutant, result } of outcomes) {
        // the grader's own kill rule (buildTestsReport): a failure or an error
        // is a kill; a harness that returned no result says nothing, and must
        // never be counted as one
        const died = !!result.tests && (result.tests.failed > 0 || result.tests.errored > 0);
        if (died) {
          killed += 1;
          continue;
        }
        remedy.push(
          `${mutant.name} survived: the reference suite ran ${result.tests?.total || 0} cases and none of them failed. ${mutant.description}`,
        );
        if (mutant.covers) {
          remedy.push(`It covers ${mutant.covers}, so that criterion has no evidence.`);
        }
        remedy.push(`Add a case that fails against it to ${reference.join(', ')}.`);
        files.push(...reference, phasePath(project.slug, 'testing', 'mutants', mutant.name));
      }
      return { detail: `${killed} of ${checks.mutants.length}`, remedy, files };
    },
  },
  {
    id: 'both-layers-mutated',
    label: 'the planted bugs cover every layer',
    phase: 'testing',
    sandbox: false,
    async run({ project }) {
      const phase = requirePhase(project, 'testing', 'tests');
      const checks = phase.checks as TestsChecks;
      const runs = runsOf(checks);
      const counted = runs.map((run) => ({
        run,
        mutants: checks.mutants.filter((m) => m.run === run.id).length,
      }));
      const detail = counted.map((c) => `${c.run.id} ${c.mutants}`).join(', ');
      if (runs.length < 2) {
        return { detail: `${detail}, one layer to cover` };
      }
      // without this a later author can quietly move all eight mutants into one
      // layer and the kill matrix's whole claim breaks with nothing red
      const empty = counted.filter((c) => c.mutants === 0);
      return {
        detail,
        remedy: empty.map(
          (c) =>
            `no mutant belongs to run "${c.run.id}" (${c.run.label}), so the kill matrix says nothing about the ${c.run.language} half and a learner who tests one layer scores as if they tested both`,
        ),
        files: empty.length ? [phasePath(project.slug, 'testing', 'mutants')] : [],
      };
    },
  },
  {
    id: 'criterion-verified',
    label: 'every criterion has a verifier',
    phase: 'testing',
    sandbox: false,
    // the US-n/AC-m backlog is the reference project's convention
    applies: (project) => {
      if (isReferencePack(project)) return null;
      const testing = project.phases.find((p) => p.key === 'testing');
      if (!testing || testing.checks.kind !== 'tests') return null;
      const checks = testing.checks as TestsChecks;
      const ids = [...checks.coverageKeywords.map((g) => g.criterionId), ...checks.mutants.map((m) => m.covers)];
      return ids.some((id) => id && CRITERION_ID.test(id))
        ? null
        : 'no keyword group or mutant names a criterion as US-n/AC-m, so the backlog convention this proves is not the pack\'s';
    },
    async run({ project }) {
      const phase = requirePhase(project, 'testing', 'tests');
      const checks = phase.checks as TestsChecks;
      const backlog = backlogOf(project);

      const verifiers: { kind: string; name: string; id?: string }[] = [
        ...checks.coverageKeywords.map((g) => ({ kind: 'keyword group', name: g.criterion, id: g.criterionId })),
        ...checks.mutants.map((m) => ({ kind: 'mutant', name: m.name, id: m.covers })),
      ];
      const remedy: string[] = [];
      let orphans = 0;
      for (const verifier of verifiers) {
        if (!verifier.id || !CRITERION_ID.test(verifier.id)) {
          orphans += 1;
          remedy.push(
            `the ${verifier.kind} "${verifier.name}" names no story criterion; give it a "${verifier.kind === 'mutant' ? 'covers' : 'criterionId'}" of the form US-n/AC-m`,
          );
          continue;
        }
        const [story, ac] = verifier.id.split('/');
        // the story the learner writes is the gap, so its criteria are the learner's to mint
        if (story === backlog.learnerStory) continue;
        if (!backlog.declares(story, ac)) {
          orphans += 1;
          remedy.push(
            `the ${verifier.kind} "${verifier.name}" covers ${verifier.id}, which ${backlog.source} does not declare`,
          );
        }
      }
      const seen = new Map<string, string>();
      for (const mutant of checks.mutants) {
        if (!mutant.covers) continue;
        const first = seen.get(mutant.covers);
        if (first) {
          orphans += 1;
          remedy.push(
            `${first} and ${mutant.name} both cover ${mutant.covers}; a duplicate hides a criterion whose only evidence is another mutant's kill`,
          );
        } else {
          seen.set(mutant.covers, mutant.name);
        }
      }
      return {
        detail: `${checks.coverageKeywords.length} keyword groups, ${checks.mutants.length} mutants, ${orphans} orphans`,
        remedy,
        files: remedy.length
          ? [
              phasePath(project.slug, 'testing', 'mutants'),
              backlog.file,
            ]
          : [],
      };
    },
  },
  {
    id: 'contract-matches-routes',
    label: 'the contract and the routes are the same list',
    phase: null,
    sandbox: false,
    async run({ project }) {
      const canonical = canonicalTree(project.slug);
      const raw = canonical['shared/contract/api.json'];
      if (!raw) {
        return { detail: 'the pack ships no shared/contract/api.json', skipped: true };
      }
      let contract: { operations?: { id?: string; method?: string; path?: string }[] };
      try {
        contract = JSON.parse(raw);
      } catch (err) {
        return {
          detail: 'shared/contract/api.json is not JSON',
          remedy: [firstLine((err as Error).message)],
          files: [packPath(project.slug, 'canonical', 'shared', 'contract', 'api.json')],
        };
      }
      const sources = Object.fromEntries(
        Object.entries(canonical).filter(([at]) => at.startsWith('api/') && at.endsWith('.py')),
      );
      const routes = declaredRoutes(sources);
      const operations = new Map<string, string>();
      for (const op of contract.operations || []) {
        operations.set(`${(op.method || 'GET').toUpperCase()} ${routeShape(op.path || '')}`, op.id || '');
      }
      const remedy: string[] = [];
      for (const [key, id] of operations) {
        if (routes.has(key)) continue;
        remedy.push(
          `the contract publishes ${key}${id ? ` ("${id}")` : ''} and no route in api/ answers it, so the front end would call an operation that does not exist`,
        );
      }
      for (const [key, at] of routes) {
        if (operations.has(key)) continue;
        remedy.push(
          `${at} serves ${key} and the contract does not publish it, so the API has a route nobody designed`,
        );
      }
      return {
        detail: remedy.length
          ? `${operations.size} operations, ${routes.size} routes, ${remedy.length} on one side alone`
          : `${operations.size} operations, ${routes.size} routes, the same list`,
        remedy,
        files: remedy.length
          ? [
              packPath(project.slug, 'canonical', 'shared', 'contract', 'api.json'),
              packPath(project.slug, 'canonical', 'api', 'routes'),
            ]
          : [],
      };
    },
  },
  {
    id: 'schema-matches-contract',
    label: 'the contract and the schema are the same tables',
    phase: null,
    sandbox: false,
    async run({ project }) {
      const canonical = canonicalTree(project.slug);
      const raw = canonical['shared/contract/api.json'];
      const ddl = canonical['api/schema.sql'];
      if (!raw || !ddl) {
        return { detail: 'the pack ships no contract and schema pair', skipped: true };
      }
      const contract = JSON.parse(raw) as {
        entities?: Record<string, { table?: string; fields?: { name: string; required?: boolean }[] }>;
      };
      const tables = schemaColumns(ddl);
      const remedy: string[] = [];
      let fields = 0;
      for (const [name, entity] of Object.entries(contract.entities || {})) {
        const table = entity.table || name;
        const columns = tables.get(table);
        if (!columns) {
          remedy.push(
            `the contract declares the entity "${name}" on table "${table}", which api/schema.sql does not create`,
          );
          continue;
        }
        const declared = new Map((entity.fields || []).map((f) => [f.name, f.required === true]));
        for (const [field, required] of declared) {
          fields += 1;
          if (!columns.has(field)) {
            remedy.push(
              `the contract gives ${table} a field "${field}", which api/schema.sql has no column for`,
            );
            continue;
          }
          // the direction that bites: a column the database will not accept a
          // null in, published as optional, is a 500 the learner reads as their
          // own bug
          if (columns.get(field) && !required) {
            remedy.push(
              `${table}.${field} is NOT NULL in api/schema.sql and optional in the contract, so a request the contract allows is a database error`,
            );
          }
        }
        for (const [column, notNull] of columns) {
          if (declared.has(column) || !notNull) continue;
          remedy.push(
            `${table}.${column} is NOT NULL in api/schema.sql and the contract's "${name}" entity does not mention it, so nothing the contract describes can create a row`,
          );
        }
      }
      return {
        detail: `${Object.keys(contract.entities || {}).length} entities, ${fields} fields, ${tables.size} tables`,
        remedy,
        files: remedy.length
          ? [
              packPath(project.slug, 'canonical', 'shared', 'contract', 'api.json'),
              packPath(project.slug, 'canonical', 'api', 'schema.sql'),
            ]
          : [],
      };
    },
  },
  {
    id: 'no-browser-storage',
    label: 'the front end keeps no state in the browser',
    phase: null,
    sandbox: false,
    async run({ project }) {
      const web = canonicalTree(project.slug, 'web/src');
      const sources = Object.keys(web);
      if (!sources.length) {
        return { detail: 'the pack ships no front end', skipped: true };
      }
      const remedy: string[] = [];
      const files: string[] = [];
      for (const at of sources) {
        // comments are stripped first: the author who writes down *why* there
        // is no localStorage here should not fail the pack for saying so
        const source = stripCodeComments(web[at], 'typescript');
        for (const held of BROWSER_STORAGE) {
          if (!held.pattern.test(source)) continue;
          remedy.push(
            `${at} uses ${held.name}. The preview runs the front end in an opaque-origin iframe, where every one of those is unavailable or unreliable, so the app would work in the deployed copy and be broken in the one the learner is looking at.`,
          );
          files.push(packPath(project.slug, 'canonical', at));
        }
      }
      return {
        detail: remedy.length
          ? `${sources.length} front-end files, ${remedy.length} that keep state in the browser`
          : `${sources.length} front-end files, no cookies, no storage, no pushState`,
        remedy,
        files,
      };
    },
  },
  {
    id: 'drill-breaks-smoke',
    label: 'the drill breaks the smoke check',
    phase: 'deployment',
    sandbox: true,
    async run({ project, content, sandbox }) {
      const phase = requirePhase(project, 'deployment', 'config');
      const checks = phase.checks as ConfigChecks;
      const drill = content.drillSpec(phase);
      if (!drill) throw new Error('the deployment phase declares no drill, so nothing is diagnosed');
      // the reference workspace is keyed by the Dockerfile the pack's smoke run
      // builds: a two-service pack's api image needs the compose file beside it,
      // because its build check asks whether web can reach api
      const workspace = workingWorkspace(project, checks);
      if (!workspace) {
        return {
          detail: `no reference workspace for ${checks.smokeDockerfile} in ${project.language}`,
          skipped: true,
        };
      }
      const fixed = await smokeRun(sandbox, phase, content.executionFiles(phase, workspace));
      const faulted = content.faultedExecutionFiles(phase, workspace) || {};
      const broken = await smokeRun(sandbox, phase, faulted);
      const entrypoint = (faulted[checks.smokeDockerfile] || '').match(/^\s*ENTRYPOINT\s+(\[.*\])\s*$/m);
      let started = '';
      try {
        started = entrypoint ? JSON.parse(entrypoint[1])[1] || '' : '';
      } catch {
        started = '';
      }
      // a drill that faults the Dockerfile is diagnosed through the file it
      // starts; a drill that faults a config file is diagnosed through the
      // directive its own description names, which is the same rule
      // `drill.ts` derives the learner's diagnosis tokens from
      const faultedDockerfile = Object.keys(drill.faultedFiles).includes(checks.smokeDockerfile);
      const named = faultedDockerfile
        ? started
        : (drill.description.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/) || [''])[0];
      const remedy: string[] = [];
      if (!fixed.ok) {
        remedy.push(
          `a working ${checks.smokeDockerfile} does not smoke clean${fixed.detail ? `: ${firstLine(fixed.detail)}` : ''}`,
        );
        remedy.push(`Every learner would fail the build check on a container that starts correctly.`);
      }
      if (broken.ok) {
        remedy.push(
          `the faulted copy (${drill.fault}) passes the same smoke check, so the drill hands every learner a green run and nothing to diagnose`,
        );
      } else if (named && !broken.detail.includes(named)) {
        // it must fail for the fault, not for a harness problem
        remedy.push(
          `the faulted copy fails, but not for the fault: the failure never names ${named}, which the drill's own description says was broken`,
        );
      }
      return {
        detail: `${drill.fault}, fails on ${named || 'the faulted entrypoint'}`,
        remedy,
        files: remedy.length ? [phasePath(project.slug, 'deployment', 'drill')] : [],
      };
    },
  },
  {
    id: 'forged-entrypoint-refused',
    label: 'a forged entrypoint is refused',
    phase: 'deployment',
    sandbox: true,
    async run({ project, content, sandbox }) {
      const phase = requirePhase(project, 'deployment', 'config');
      const checks = phase.checks as ConfigChecks;
      const inline = project.language === 'python' ? '-c' : '-e';
      const launcher = project.language === 'python' ? 'python' : 'node';
      const base = project.language === 'python' ? 'FROM python:3.11-slim' : 'FROM node:22-slim';
      // The graded build check and the drill must both refuse an ENTRYPOINT
      // that runs the interpreter with an inline program.
      //
      // It goes to the Dockerfile the pack's smoke run builds. Written to
      // 'Dockerfile' on a pack that builds api/Dockerfile, the forgery is never
      // read at all: the run fails for the scaffold's missing ENTRYPOINT and
      // this check reports that the inline-program guard has been undone when
      // it has not.
      const forged = `${base}\nWORKDIR /app\nCOPY . /app\nENTRYPOINT ["${launcher}", "${inline}", "print('${checks.expectInOutput}')"]\n`;
      const out = await smokeRun(
        sandbox,
        phase,
        content.executionFiles(phase, {
          ...workingWorkspace(project, checks),
          [checks.smokeDockerfile]: forged,
        }),
      );
      const refused = !out.ok && out.detail.includes(inline);
      return {
        detail: `${launcher} ${inline} is not the CLI`,
        remedy: refused
          ? []
          : [
              `a container that prints the expectation with ${launcher} ${inline} passes the build check without ever starting the CLI`,
              `The smoke path must refuse an entrypoint that is not the shipped CLI.`,
            ],
        files: refused ? [] : [phasePath(project.slug, 'deployment', 'phase.json')],
      };
    },
  },
  {
    id: 'incident-gated',
    label: "the incident record is gated on naming the fault in the drill's own words",
    phase: 'deployment',
    sandbox: false,
    // the probe names the fault in the drill's own words, so it needs a drill
    applies: (project) => {
      const deployment = project.phases.find((p) => p.key === 'deployment');
      return deployment?.checks.kind === 'config' && !deployment.checks.drill
        ? 'the deployment phase declares no drill, so no incident is written from one for the record to name'
        : null;
    },
    async run({ project }) {
      const phase = requirePhase(project, 'deployment', 'config');
      const checks = phase.checks as ConfigChecks;
      const files = [phasePath(project.slug, 'deployment', 'phase.json')];
      // A Deployment of the config kind carries its runbook record: the loader refuses one without it.
      if (!checks.runbook) return { detail: 'no runbook record', remedy: ["the deployment phase carries no runbook record, so the drill's own incident is graded by nothing"], files };
      // The drill's diagnosis reads the record's root cause and fix, and the
      // probe names the fault in the drill's own words, so it holds for a
      // compose drill (TaskTrackr's API_URL) as for a Dockerfile one.
      const remedy: string[] = [];
      if (!checks.runbook.floor.requireIncident) remedy.push("the phase declares a drill, but the runbook floor does not require the incident, so the drill's own record is graded by nothing");
      // `applies` skips a phase with no drill
      const drill = checks.drill!;
      const names = (rootCause: string) => buildDrillReport({ fault: drill.fault, description: drill.description, failedBeforeFix: true, passedAfterFix: true, beforeStderr: '', afterStdout: '', incident: { rootCause, fix: 'changed the line' } }).diagnosisNamesFault;
      // the fault in the pack's own words: the description's directive or setting, and the fault id's words the diagnosis falls back to
      const named = `${drill.fault.split(/[^A-Za-z0-9]+/).join(' ')}: ${drill.description}`;
      if (!names(named)) remedy.push("a record whose root cause names the fault in the drill's own words does not count as naming it");
      if (names('the container was broken on start')) remedy.push('a record that says something broke without naming what already counts as naming the fault');
      return { detail: `runbook incident ${checks.runbook.floor.requireIncident ? 'required' : 'not required'}`, remedy, files: remedy.length ? files : [] };
    },
  },
  {
    id: 'scaffold-fails-gate',
    label: 'no scaffold passes its own gate',
    phase: null,
    sandbox: false,
    async run({ project }) {
      const remedy: string[] = [];
      const files: string[] = [];
      const proven: string[] = [];
      for (const key of ['requirements', 'design'] as const) {
        const story = project.phases.find((p) => p.key === key && p.checks.kind === 'story');
        if (story && story.checks.kind === 'story') {
          // A story phase's scaffold is its seeded record, held to the floor.
          const record = story.checks.record;
          const floor = evaluateStoryFloor(parseStoryJson(fileContent(story, record)), story.checks.floor);
          proven.push(key);
          if (floor.some((one) => !one.passed)) continue;
          remedy.push(`${key}: the untouched ${record} already meets the story floor`);
          remedy.push(`Raise the floor, so the learner's own story is what meets it.`);
          files.push(phasePath(project.slug, key, 'phase.json'));
          continue;
        }
        const design = project.phases.find((p) => p.key === key && p.checks.kind === 'design');
        if (design && design.checks.kind === 'design') {
          // A design phase's scaffold is its seeded documents, held to the design floor.
          const docs = Object.fromEntries(design.files.map((f) => [f.path, f.content]));
          proven.push(key);
          if (evaluateDesignFloor(docs, design.checks).some((one) => !one.passed)) continue;
          remedy.push(`${key}: the untouched ${DESIGN_JSON} already meets the design floor`);
          remedy.push(`Raise the floor, so the learner's own design is what meets it.`);
          files.push(phasePath(project.slug, key, 'phase.json'));
          continue;
        }
        // a Requirements or Design that is neither story nor design is refused by name
        requirePhase(project, key, key === 'requirements' ? 'story' : 'design');
      }
      const deployment = requirePhase(project, 'deployment', 'config');
      const checks = deployment.checks as ConfigChecks;
      // A runbook record: its starting record, held to the runbook floor.
      if (checks.runbook) {
        proven.push('deployment');
        const starting = fileContent(deployment, RUNBOOK_JSON);
        if (evaluateRunbookFloor(starting, checks.runbook.floor).every((one) => one.passed)) {
          remedy.push('deployment: the untouched starting runbook already meets the runbook floor');
          files.push(phasePath(project.slug, 'deployment', 'files', 'deployment', 'runbook.json'));
        }
      }
      // A change request record: its starting record, held to the change floor.
      const maintenance = project.phases.find((p) => p.key === 'maintenance' && p.checks.kind === 'code');
      if (maintenance && maintenance.checks.kind === 'code' && maintenance.checks.change && maintenance.checks.ticket) {
        proven.push('maintenance');
        const spec = { contract: maintenance.checks.change.contract, floor: maintenance.checks.change.floor, ticket: maintenance.checks.ticket };
        if (evaluateChangeFloor(fileContent(maintenance, CHANGE_REQUEST_JSON), spec).every((one) => one.passed)) {
          remedy.push('maintenance: the untouched starting change request already meets the change floor');
          files.push(phasePath(project.slug, 'maintenance', 'files', 'maintenance', 'change-request.json'));
        }
      }
      return { detail: proven.join(', '), remedy, files };
    },
  },
  {
    id: 'change-request-complete',
    label: 'the change request is complete',
    phase: 'maintenance',
    sandbox: false,
    // the change request record and the seeded contract are the reference project's change request
    applies: (project) =>
      isReferencePack(project) ||
      !project.phases.some((p) => p.key === 'maintenance') ||
      project.phases.some(
        (p) => p.key === 'maintenance' && p.files.some((f) => f.path === 'design/contracts.json' || f.path === CHANGE_REQUEST_JSON),
      )
        ? null
        : 'the maintenance phase ships no change request record and no design/contracts.json, so its change request is the code alone',
    async run({ project }) {
      const phase = requirePhase(project, 'maintenance', 'code');
      const remedy: string[] = [];
      const contracts = phase.files.find((f) => f.path === 'design/contracts.json');
      const checks = phase.checks as CodeChecks;
      if (!contracts) {
        // a change request with its contract switch off amends no design contract (Shelf's), so it needs none
        if (!checks.change || checks.change.contract) remedy.push(`the maintenance phase ships no design/contracts.json for the workflow to seed`);
      } else {
        if (!contracts.editable) remedy.push(`design/contracts.json is locked, so the learner cannot complete it`);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(contracts.content);
        } catch (err) {
          remedy.push(`design/contracts.json is not JSON: ${firstLine((err as Error).message)}`);
        }
        if (parsed && JSON.stringify(parsed) !== JSON.stringify({ operations: [] })) {
          remedy.push(
            `design/contracts.json ships ${JSON.stringify(parsed).slice(0, 80)}; it ships empty, because the workflow seeds it from the learner's own design record`,
          );
        }
      }
      // The change request record: it ships valid, and no line of it covers an acceptance item yet.
      const record = checks.change ? phase.files.find((f) => f.path === CHANGE_REQUEST_JSON) : undefined;
      const read = record ? validateChangeRequestRecord(record.content, (checks.ticket?.acceptance ?? []).map((a) => a.id)).change : null;
      if (!read) remedy.push('the maintenance phase ships no valid maintenance/change-request.json');
      const covering = (read?.release.changes ?? []).filter((l) => l.covers.length > 0);
      for (const line of covering) remedy.push(`the starting change request's ${line.id} already covers ${line.covers.join(', ')}; it ships uncovered, because the trace is the learner's to write`);
      return {
        detail: read ? `the starting change request carries ${read.release.changes.length} change line(s)` : 'no starting change request',
        remedy,
        files: remedy.length ? [phasePath(project.slug, 'maintenance', 'files')] : [],
      };
    },
  },
  {
    id: 'preview-starts',
    label: 'the declared preview starts and serves the app',
    phase: null,
    sandbox: true,
    async run({ project, sandbox }) {
      const preview = project.preview;
      if (!preview) {
        return { detail: 'the pack declares no preview', skipped: true };
      }
      if (!project.phases.some((p) => p.canPreview)) {
        return { detail: 'no phase in the pack sets canPreview', skipped: true };
      }
      // "could not tell", never a defect: a deployment that cannot run an app is
      // a fact about this machine, and the pack is exactly as good as it was
      if (config.runnerMode === 'lambda') {
        throw new RunnerUnavailable(
          'preview is not available on the lambda transport, where an app has nowhere to keep running',
        );
      }
      const app = sandbox as Partial<SandboxAppLike>;
      if (!app.startApp || !app.statusApp || !app.assetApp || !app.stopApp) {
        throw new RunnerUnavailable('this build has no preview transport, so the app was not started');
      }
      const files = canonicalTree(project.slug);
      if (!files[preview.service.command[1]]) {
        return {
          detail: `the canonical application ships no ${preview.service.command[1]}`,
          remedy: [
            `project.json's preview starts ${preview.service.command.join(' ')} and the canonical application has no ${preview.service.command[1]}, so Run app would start nothing`,
          ],
          files: [packPath(project.slug, 'project.json')],
        };
      }
      const startedAt = Date.now();
      let session = await app.startApp({
        mode: 'preview',
        files,
        ...(project.build ? { build: { ...project.build } } : {}),
        service: preview.service,
        web: preview.web,
        env: preview.env,
        ...(preview.seed ? { seed: preview.seed } : {}),
      });
      // A transport that cannot preview answers rather than throwing, so the
      // loop below would leave `starting` at once and report "unavailable
      // after 0 s" as a defect: the outcome the comment above says this check
      // must never produce. The pack is exactly as good as it was; this
      // machine just cannot run an app right now.
      if (session.status === 'unavailable' || session.status === 'busy') {
        throw new RunnerUnavailable(
          session.message || 'the preview transport could not be reached',
        );
      }
      try {
        const deadline = startedAt + PREVIEW_CHECK_SECONDS * 1000;
        while (session.status === 'starting' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          session = await app.statusApp(session.id);
        }
        const took = Math.round((Date.now() - startedAt) / 1000);
        const console_ = (session.console || [])
          .filter((line) => line.stream === 'err')
          .map((line) => line.text);
        if (session.status !== 'ready') {
          return {
            detail: `${session.status} after ${took} s`,
            remedy: [
              `the pack's own preview did not come up: ${session.message || session.status}${console_.length ? ` (${firstLine(console_[console_.length - 1])})` : ''}`,
              `Run app is the first thing a learner presses in the implementation phase; a preview that does not start reads to them as their own code.`,
            ],
            files: [packPath(project.slug, 'project.json'), packPath(project.slug, 'canonical', 'api')],
          };
        }
        // through the same door the browser uses: the runner serves the built
        // front end itself, and the page it serves has to be the pack's own
        let page = await app.assetApp(session.id, '');
        if (page.status === 404) page = await app.assetApp(session.id, 'index.html');
        const html = canonicalTree(project.slug)[preview.web.html] || '';
        const marker =
          (html.match(/data-app="[^"]*"/) || html.match(/<div\s+id="[^"]*"[^>]*>/) || [''])[0];
        const remedy: string[] = [];
        if (session.bundleOk === false) {
          remedy.push(
            `the front end did not build, so the preview served the built-in page instead of the app${console_.length ? `: ${firstLine(console_[0])}` : ''}`,
          );
        }
        if (page.status !== 200) {
          remedy.push(`the preview answered ${page.status} for its own page`);
        } else if (marker && !page.body.includes(marker)) {
          remedy.push(
            `the preview served a page that does not carry ${marker}, which ${preview.web.html} declares, so it is not the pack's own document`,
          );
        }
        return {
          detail: `ready in ${took} s, ${page.body.length} bytes of ${preview.web.html}`,
          remedy,
          files: remedy.length
            ? [packPath(project.slug, 'project.json'), packPath(project.slug, 'canonical', preview.web.html)]
            : [],
        };
      } finally {
        // an already-reaped session must never turn a passing check into a defect
        await app.stopApp(session.id).catch(() => undefined);
      }
    },
  },
];

/** The ids of the checks that call the sandbox: the ones `--quick` skips. */
export const SANDBOX_CHECK_IDS: string[] = CHECKS.filter((c) => c.sandbox).map((c) => c.id);

/** Every published check id, in report order. */
export const CHECK_IDS: string[] = CHECKS.map((c) => c.id);

/* -------------------------------- driver --------------------------------- */

export async function checkContent(options: ContentCheckOptions = {}): Promise<ContentCheckReport> {
  const startedAt = Date.now();
  const load = options.projects ? null : loadPacks();
  const projects = options.projects || load?.projects || [];
  const sandbox = options.sandbox || new SandboxService();
  // constructed for its pure helpers only: executionFiles, drillSpec,
  // faultedExecutionFiles read the phase they are handed, never the map
  const content = new ContentService();
  const only = options.only && options.only.length ? new Set(options.only) : null;
  const results: CheckResult[] = [];

  for (const project of projects) {
    for (const check of CHECKS) {
      if (only && !only.has(check.id)) continue;
      const at = Date.now();
      const base = {
        id: check.id,
        label: check.label,
        pack: project.slug,
        phase: check.phase,
        remedy: [] as string[],
        files: [] as string[],
      };
      let result: CheckResult;
      // a check that does not apply to this pack is skipped, never run
      const notApplicable = check.applies ? check.applies(project) : null;
      if (notApplicable) {
        result = { ...base, outcome: 'skipped', detail: notApplicable, durationMs: 0 };
      } else if (check.sandbox && options.quick) {
        result = { ...base, outcome: 'skipped', detail: 'sandbox proof skipped', durationMs: 0 };
      } else {
        try {
          const finding = await check.run({ project, root: path.join(config.contentDir, project.slug), content, sandbox });
          const defect = (finding.remedy || []).length > 0;
          result = {
            ...base,
            outcome: finding.skipped ? 'skipped' : defect ? 'defect' : 'ok',
            detail: finding.detail,
            remedy: finding.remedy || [],
            files: finding.files || [],
            durationMs: Date.now() - at,
          };
        } catch (err) {
          const unavailable = err instanceof RunnerUnavailable;
          result = {
            ...base,
            outcome: unavailable ? 'unavailable' : 'defect',
            detail: unavailable ? (err as Error).message : 'the check could not complete',
            remedy: unavailable ? [] : [firstLine((err as Error).message)],
            durationMs: Date.now() - at,
          };
        }
      }
      results.push(result);
      if (options.onResult) options.onResult(result);
    }
  }

  const count = (outcome: CheckOutcome): number => results.filter((r) => r.outcome === outcome).length;
  const defects = count('defect');
  const unavailable = count('unavailable');
  const loadFailures = load ? load.failures : [];
  return {
    packs: projects.map((p) => ({
      slug: p.slug,
      version: p.version,
      language: p.language,
      phases: p.phases.length,
    })),
    results,
    defects,
    unavailable,
    skipped: count('skipped'),
    loadFailures,
    durationMs: Date.now() - startedAt,
    // a defect is a defect however many runs were lost; only an otherwise
    // clean report that missed runs is "could not tell"
    exitCode: defects > 0 ? 1 : unavailable > 0 || loadFailures.length > 0 ? 2 : 0,
  };
}
