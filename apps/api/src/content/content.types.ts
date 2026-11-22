import type {
  ArtifactKind,
  ChangeChecks,
  ChangeTicket,
  DesignChecksSpec,
  PhaseKey,
  PhaseRubric,
  QuizChecks,
  RunbookChecks,
  RunHarness,
  RunLanguage,
  StoryChecksSpec,
} from '@learnsdlc/shared';

export interface ContentFileSpec {
  path: string;
  content: string;
  editable: boolean;
  language: string;
}

/* ------------------------- builds, runs and preview ----------------------- */

/**
 * How a pack's front end is produced (`project.json.build`).
 *
 * `tool` is an enum of one on purpose: a pack names a tool the runner already
 * knows, never an argv, so content can never ask the sandbox to run a command
 * of its own.
 */
export interface BuildSpec {
  tool: 'esbuild';
  /** Workspace-relative entry point, e.g. `web/src/main.tsx`. */
  entry: string;
  /** Workspace-relative bundle the build writes, e.g. `web/dist/app.js`. */
  outfile: string;
  jsx: 'automatic' | 'transform';
}

/**
 * What a pack needs pre-baked into the runner's read-only dependency layer
 * (`project.json.runtime`). Every version is pinned exactly: a range would
 * make what a learner runs depend on the day the image was built.
 *
 * The names are held against the runner's own allowlist
 * (`apps/api/runner/runtime_manifest.py`), not against anything in the pack:
 * a pack may not add a dependency to the jail by editing content alone.
 */
export interface RuntimeSpec {
  python?: { version: string; packages: string[] };
  node?: {
    version: string;
    packages: Record<string, string>;
    tools: Record<string, string>;
  };
}

/** The one long-running service the live preview starts for the learner. */
export interface PreviewServiceSpec {
  /** argv, validated exactly as a smoke command is: an interpreter and a file the pack ships. */
  command: string[];
  /** The environment variable the kernel-chosen loopback port is passed in. */
  portEnv: string;
  /** The path the runner polls until the app answers, e.g. `/api/health`. */
  health: string;
}

/**
 * `project.json.preview`: what "Run app" starts. Absent means no phase in the
 * pack can preview, whatever a phase's `canPreview` says.
 */
export interface PreviewSpec {
  service: PreviewServiceSpec;
  /** Where the built front end lands, and the HTML document that loads it. */
  web: { root: string; html: string };
  /** Extra environment for the app's own process; never a key the runner sets itself. */
  env: Record<string, string>;
  /** Optional argv run once before the service starts, e.g. `["python3", "ops/seed.py"]`. */
  seed?: string[];
}

/**
 * One graded run inside a phase (`checks.runs[]`): a language, a harness and
 * the files that run under it.
 *
 * A phase that spans two layers declares two, and the API executes them
 * sequentially and pools the result, which is why `id` is stable and quoted:
 * it is the `step` on every merged case and the group label in the Tests pane.
 * A phase that declares none gets exactly one run synthesised from the flat
 * shape it already had, so every existing pack loads and grades identically.
 *
 * The kind-specific members are empty rather than absent: `hiddenTestFiles`
 * and `visibleTests` are a `code` phase's, `learnerTestFiles`, `implFiles` and
 * `referenceTestFiles` are a `tests` phase's, and one shape means the graders
 * and the execution service have one loop rather than two.
 */
export interface PhaseRun {
  /** `^[a-z][a-z0-9-]{0,15}$`, unique in the phase, e.g. "api" or "web". */
  id: string;
  language: RunLanguage;
  /** The harness the learner-visible run uses. */
  harness: RunHarness;
  /** The harness the sealed run uses: the one whose seal has been proved. */
  hiddenHarness: RunHarness;
  /** The words a learner reads above this group, e.g. "API tests". */
  label: string;
  /** esbuild the workspace's TypeScript before the child starts. */
  transform: boolean;
  /** What the graded run collects, e.g. `["tests"]` or `["web/src"]`. */
  testPaths: string[];
  /** `code`: the tests the learner can see and run. */
  visibleTests: string[];
  /** `code`: the sealed suite, workspace path -> content. */
  hiddenTestFiles: Record<string, string>;
  /** `tests`: the learner's own suite files that belong to this run. */
  learnerTestFiles: string[];
  /** `tests`: the pack's own suite, workspace path -> content. */
  referenceTestFiles: Record<string, string>;
  /** `tests`: the reference implementation this run grades against. */
  implFiles: Record<string, string>;
  /** Locked helpers that ride into this run's workspace, workspace path -> content. */
  supportFiles: Record<string, string>;
}

/**
 * A config phase's rule: a regular expression over one named workspace file
 * (a Dockerfile, a Compose file, a workflow). `target` is required, and in a
 * phase with a runbook it never names a markdown file: the runbook is a
 * record of its own.
 */
export interface FileRule {
  id: string;
  label: string;
  criterion: string;
  pattern?: string;
  forbidden?: string;
  flags?: string;
  required: boolean;
  failDetail: string;
  target: string;
}

/**
 * A structured Requirements phase: the learner fills one story record (JSON at
 * `record`) beside the pack's provided stories, and the floor is the bar.
 */
export type StoryChecks = StoryChecksSpec;

/** A structured Design phase: the record and the contracts that are on, graded by the floor. */
export type DesignChecks = DesignChecksSpec;

export interface CodeChecks {
  kind: 'code';
  editableTargets: string[];
  visibleTests: string[];
  /** Map of workspace path -> file content for the hidden suite. */
  hiddenTestFiles: Record<string, string>;
  /**
   * The pack's own answer to its stubs, at the workspace paths it completes:
   * every `editableTargets` entry has one. Overlaying it and running
   * `hiddenTestFiles` is what proves the shipped solution and the hidden suite
   * still agree.
   */
  solutionFiles: Record<string, string>;
  /** Normalized solution snippets used by the assistant guardrails. */
  solutionSources: string[];
  /**
   * The runs this phase grades, in the order they execute. Always at least
   * one: a pack that declares no `checks.runs` gets a single run built from the
   * flat shape above, so the fields above stay the union of the runs and a
   * reader of the flat fields keeps working.
   */
  runs: PhaseRun[];
  /** Maintenance only: the teacher's ticket, present exactly when `change` is. */
  ticket?: ChangeTicket;
  /** Maintenance only: the change request record, its contract switch and its floor. Never in `editableTargets`. */
  change?: ChangeChecks;
}

/** One mutant from `mutants/<name>/`: the meta plus the files it overlays. */
export interface MutantSpec {
  name: string;
  description: string;
  /** Workspace path -> mutated content, placed over the reference implementation. */
  files: Record<string, string>;
  /**
   * The criterion the mutant proves, e.g. "US-4/AC-2", from `meta.json.covers`.
   * Absent for packs that do not declare it.
   */
  covers?: string;
  /**
   * Which `checks.runs[].id` the mutant belongs to: it decides which
   * implementation the mutant overlays and which reference suite is run
   * against it, so the kill matrix is one grid over both layers. A phase with
   * one run fills it in; a phase with two must declare it.
   */
  run: string;
}

/** A keyword group that evidences one rubric criterion in the learner's tests. */
export interface CoverageKeywordSpec {
  criterion: string;
  keywords: string[];
  /**
   * The story criterion id the group maps to, e.g. "US-2/AC-1". Absent for
   * packs that do not declare it.
   */
  criterionId?: string;
}

export interface TestsChecks {
  kind: 'tests';
  learnerTestFiles: string[];
  /**
   * The acceptance suite the pack itself would hand in, at the learner test
   * paths it stands in for. It must pass against `implFiles` and kill every
   * mutant, which is how a pack proves its own kill matrix is complete.
   */
  referenceTestFiles: Record<string, string>;
  /** Reference implementation files (workspace path -> content). */
  implFiles: Record<string, string>;
  mutants: MutantSpec[];
  coverageKeywords: CoverageKeywordSpec[];
  minTests: number;
  /**
   * Locked helper modules the learner's suite may import, keyed by the
   * workspace path they are written to.
   *
   * They have to be declared separately from `files` because the grading runs
   * do not carry the phase's files at all: `mutationJob` writes only the
   * learner's test files into the workspace, so that a suite cannot read the
   * implementation it is being scored against. A helper the suite imports
   * (`tests/clock.py`, the run clock's one function) has to be named here to
   * ride along, and the loader refuses one that is not also a locked entry in
   * `files`, so nothing reaches the sandbox that the explorer does not show.
   */
  supportFiles: Record<string, string>;
  /**
   * The runs this phase grades, in the order they execute. Always at least
   * one, exactly as on `CodeChecks`.
   */
  runs: PhaseRun[];
}

/**
 * The deployment incident drill: a faulted copy of the learner's config that
 * the smoke check is expected to fail on, so the learner diagnoses a real
 * break instead of describing one. Optional: packs without it have no drill.
 */
export interface DrillSpec {
  /** Short id of the fault, e.g. "shell-form-entrypoint". */
  fault: string;
  /** One sentence an instructor could read, describing what was broken. */
  description: string;
  /** Workspace path -> faulted content, overlaid on the learner's files. */
  faultedFiles: Record<string, string>;
  /** The smoke check must fail against the faulted copy. Defaults to true. */
  expectFailure: boolean;
}

export interface ConfigChecks {
  kind: 'config';
  rules: FileRule[];
  smokeImplFiles: Record<string, string>;
  /**
   * The Dockerfile the smoke check parses for an entry point.
   * `"Dockerfile"` unless the pack says otherwise, which is what a two-service
   * application needs: `api/Dockerfile` builds the service the smoke run
   * starts, `web/Dockerfile` builds the other one.
   */
  smokeDockerfile: string;
  smokeCommands: string[][];
  expectInOutput: string;
  /** Present only when the pack declares `checks.drill`. */
  drill?: DrillSpec;
  /** Deployment only: the runbook record and its floor; graded as the unit `record:deployment/runbook.json`. */
  runbook?: RunbookChecks;
}

/**
 * What scores a phase, or, since the task grain, one task of it.
 *
 * `QuizChecks` is the fifth member and it is declared in
 * `packages/shared` rather than here, because the learner's report, the
 * teacher's draft payload and the attempt row all name its questions and the
 * browser has to have the shape. Every other member is the API's alone.
 *
 * **Adding a member is what lists the work.** Four of the sites that must
 * answer for a new kind are switches over this union whose return type
 * excludes `undefined` (`gradedPathsOf`, `scoredRubricKeys`, `sealedTask` and
 * `buildReport`'s `let partial`), so they stop compiling the moment a member
 * is added, and that is deliberate. The four the compiler stays
 * silent about are `gradedUnitsOf`'s if-chain, `rulesOf`'s guard,
 * `sandboxBudgetFor` and the runtime allow-list `ARTIFACT_KINDS`; each carries
 * its own note where it lives.
 *
 * `design` answers like `story` at every site listed here: it grades a
 * structured record (and the contracts that are on) by its floor. A config
 * phase with a runbook and a code phase with a change request each grade one
 * more unit, their record, beside the rules or the runs, and answer the
 * sentinel beside their locked keys in `scoredRubricKeys`.
 */
export type PhaseChecks =
  | StoryChecks
  | DesignChecks
  | CodeChecks
  | TestsChecks
  | ConfigChecks
  | QuizChecks;

/**
 * One thing the customer knows, and the words they would say it in.
 */
export interface InterviewFact {
  id: string;
  /** A short label for what the fact settles. Shown to the learner; the answer is not. */
  topic: string;
  /** Words in a question that mean this fact is being asked for. */
  keywords: string[];
  answer: string;
}

/**
 * The hidden truth document behind a requirements interview: what the customer
 * knows, in their own words, and what they will not do. Optional: a phase
 * without one has no interview. Hidden the way `hiddenTestFiles` is: it never
 * appears in `files`, so it never reaches a workspace, and the API returns the
 * fact topics but never the answers until the customer says one out loud.
 */
export interface InterviewBrief {
  persona: { name: string; role: string };
  opening: string;
  /** Said when the question is about something the facts do not cover. */
  unknownReply: string;
  /** Said when the learner asks the customer to write the artefact. */
  refusal: string;
  maxTurns: number;
  /** How many facts are worth settling before writing the story. */
  factsExpected: number;
  facts: InterviewFact[];
}

export interface AssistantTopic {
  keywords: string[];
  hints: string[];
}

export interface AssistantContent {
  systemPrompt: string;
  topics: AssistantTopic[];
  progressive: string[];
}

/**
 * What the loader reads of one phase, wherever its bytes live: the
 * pointer layout's readers (`pointerInputs`, `legacy-layout.ts`), which follow
 * a `phase.json`'s file, folder and source names exactly as the loader always
 * has, or the folder layout's (`folderInputs`, `folder-layout.ts`), which
 * answer from the folders `derivePack` read. `ContentService` keeps every
 * validation and asks here only where it once read a directory.
 */
export interface PhaseInputs {
  /** The phase's mounts, each { path, content, editable, language }: the pointer path in authored order, the folder path unsorted (the loader sorts after seeding). */
  files(): ContentFileSpec[];
  /** The brief: `taskFile`'s bytes or `taskPanel` on the pointer path; `taskPanel` on the folder path. */
  brief(spec: Record<string, unknown>): string;
  /** The interview's JSON text, or null when the phase holds none. */
  interviewText(spec: Record<string, unknown>): string | null;
  /** A run's hidden suite by workspace path: `runSpec` null for a flat phase's one run. */
  hiddenFor(runSpec: Record<string, unknown> | null, flat: Record<string, unknown>, field: string, runId: string): Record<string, string>;
  solution(raw: Record<string, unknown>, targets: string[]): Record<string, string>;
  reference(raw: Record<string, unknown>, targets: string[]): Record<string, string>;
  impl(raw: Record<string, unknown>, declared: string[]): Record<string, string>;
  support(raw: Record<string, unknown>, files: ContentFileSpec[]): Record<string, string>;
  /** Each mutant: its folder's name, its `meta.json`, and its files placed on the implementation paths given. */
  mutants(raw: Record<string, unknown>): { name: string; meta: Record<string, unknown>; files: (implPaths: string[]) => Record<string, string> }[];
  smoke(raw: Record<string, unknown>): Record<string, string>;
  drill(raw: Record<string, unknown>): Record<string, string>;
  /**
   * How a sentence names a piece: the pointer path's own member
   * (`checks.solutionDir`), the folder path's folder (`solution/`), so a
   * refusal that named a manifest position names the folder in its place (7.3).
   */
  named(member: string): string;
  /** Where a refusal says it was: `phases/03-implementation` on the folder path; the phase directory's location on the pointer path. */
  readonly where: string;
}

export interface PhaseContent {
  key: PhaseKey;
  order: number;
  title: string;
  intro: string;
  artifactKind: ArtifactKind;
  /** Execution language for this phase's runner jobs ('python' | 'javascript'). */
  language: string;
  canRun: boolean;
  runLabel: string;
  taskPanel: string;
  objectives: string[];
  files: ContentFileSpec[];
  rubric: PhaseRubric;
  checks: PhaseChecks;
  assistant: AssistantContent;
  /** The customer interview, requirements phases only. */
  interview?: InterviewBrief;
  /**
   * Whether this phase can start the live preview. False unless the
   * phase says otherwise, and the pack has to declare a `preview` block for it
   * to mean anything: a phase that claims it without one is refused at boot.
   */
  canPreview: boolean;
}

export interface ProjectContent {
  slug: string;
  /**
   * The pack version, `MAJOR.MINOR.PATCH`, from `project.json`. Stamped on
   * enrolments and submissions so a score can be read against the pack that
   * produced it.
   */
  version: string;
  title: string;
  tagline: string;
  description: string;
  language: string;
  /**
   * Every language any phase of this pack runs, with `language` as
   * the primary and always a member. The loader refuses a `checks.runs[]`
   * whose language is not in this list, so a pack cannot reach a harness it
   * never declared.
   */
  languages: RunLanguage[];
  /** How the pack's front end is built, absent in a pack with none. */
  build?: BuildSpec;
  /** What the pack needs pre-baked into the runner, absent when it needs nothing. */
  runtime?: RuntimeSpec;
  /** What "Run app" starts, absent in a pack that cannot be previewed. */
  preview?: PreviewSpec;
  phases: PhaseContent[];
  /** The warm-up before Requirements, absent in a pack that ships none. */
  warmup?: WarmupContent;
}

/**
 * The warm-up a pack ships in its own `warmup/` directory, a sibling of
 * `phases/`.
 *
 * It is deliberately not a phase: no rubric, no criteria, no mutants, no
 * threshold. Its whole check is "every case in `testPaths` passed", which is
 * what a first exercise should ask, and it keeps the phase loader's
 * `order 1..6` invariant untouched.
 */
export interface WarmupContent {
  title: string;
  /** Markdown, the brief in the right column of the room. */
  brief: string;
  runLabel: string;
  /** The three things the learner is asked to do, in order. */
  steps: string[];
  files: ContentFileSpec[];
  /**
   * The one check: every case in these files must pass.
   *
   * `language`, `harness` and `transform` are optional: a warm-up written in
   * TypeScript is how a learner meets the transform and the DOM harness on a
   * one-line function, and the run needs to say so. They default to the pack's
   * own language and that language's harness, so a warm-up that declares
   * neither runs in the pack's language.
   */
  check: {
    kind: 'tests';
    testPaths: string[];
    language: RunLanguage;
    harness: RunHarness;
    transform: boolean;
  };
}
