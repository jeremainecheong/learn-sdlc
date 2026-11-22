import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CHANGE_REQUEST_JSON,
  DESIGN_JSON,
  EMPTY_CHANGE_REQUEST,
  EMPTY_DESIGN,
  EMPTY_STORY,
  RUBRIC_CRITERION_DESCRIPTION_MAX,
  RUBRIC_CRITERION_TITLE_MAX,
  RUNBOOK_JSON,
  serialiseChangeRequest,
  serialiseDesign,
  serialiseRunbook,
  serialiseStory,
  type RunResult,
} from '@learnsdlc/shared';
import { config } from '../config';
import type { SandboxJob } from '../execution/sandbox.service';
import {
  CHECK_IDS,
  SANDBOX_CHECK_IDS,
  checkContent,
  loadPacks,
} from './content-check-engine';
import type {
  CheckResult,
  ContentCheckReport,
  SandboxAppJob,
  SandboxAppSession,
  SandboxLike,
} from './content-check-engine';
import type { CodeChecks, ConfigChecks, ProjectContent, TestsChecks } from '../content/content.types';
import { ContentService, validateStoryChecks } from '../content/content.service';
import { DirectoryPackSource } from '../content/pack-source';
import { recordPack } from '../../test/record-pack';
// The `shelf` fixture pack: a pack that is not the reference project.
import { createHash } from 'crypto';
import { SHELF_DIR, SHELF_SLUG } from '../../test/fixtures/upload-packs/markers';
// The prebake verifier asked directly, as the check asks it.
import { spawnSync } from 'child_process';

/**
 * The checker is `content.spec.ts` rewritten to report rather than throw, so
 * this file proves the two things that spec cannot: that a defect is *found
 * and named* rather than raised as an assertion, and that a runner which never
 * answered is not reported as a broken pack.
 *
 * Every defect case doctors a copy of the shipped pack: in memory where the
 * check reads the loaded project, and on disk in a temporary content root where
 * it reads the pack's canonical application. Nothing in `content/` is edited,
 * so the packs a class runs are never at the mercy of a test.
 */

const packs = loadPacks();

/** A deep copy of a shipped pack: plain data all the way down. */
const packOf = (slug: string): ProjectContent => {
  const project = packs.projects.find((p) => p.slug === slug);
  if (!project) throw new Error(`no pack named ${slug}`);
  return JSON.parse(JSON.stringify(project)) as ProjectContent;
};

/** The one pack this product ships. */
const THE_PACK = 'tasktrackr';

const phaseOf = (project: ProjectContent, key: string) => {
  const phase = project.phases.find((p) => p.key === key);
  if (!phase) throw new Error(`${project.slug} has no ${key} phase`);
  return phase;
};

const only = (report: ContentCheckReport): CheckResult => {
  expect(report.results).toHaveLength(1);
  return report.results[0];
};

/** The report a defect case expects: one check, one defect, exit 1. */
const expectDefect = (report: ContentCheckReport, id: string): CheckResult => {
  const result = only(report);
  expect({ id: result.id, outcome: result.outcome }).toEqual({ id, outcome: 'defect' });
  expect(report.defects).toBe(1);
  expect(report.exitCode).toBe(1);
  expect(result.remedy.length).toBeGreaterThan(0);
  return result;
};

/*
 * prebake-available is the one check whose answer is the
 * host's, not the pack's: it runs `scripts/prebake.mjs verify`, which runs
 * runtime_dependencies.py under PYTHON_BIN or the first python3 on PATH (3.11
 * in the container and Anaconda; not Homebrew's 3.13). The report cases that
 * assert "no defect" keep it out of that assertion and assert it on its own:
 * exactly what the verifier answers on this host (or `skipped` for a pack
 * with no runtime, as the check answers), and never a defect of the pack.
 */
const PREBAKE = 'prebake-available';
const prebakeOnThisHost = (project: ProjectContent): CheckResult['outcome'] => {
  if (!project.runtime) return 'skipped';
  let root = __dirname;
  while (!fs.existsSync(path.join(root, 'scripts', 'prebake.mjs'))) {
    const up = path.dirname(root);
    if (up === root) return 'skipped';
    root = up;
  }
  const out = spawnSync(process.execPath, [path.join(root, 'scripts', 'prebake.mjs'), 'verify'], {
    encoding: 'utf-8',
    env: { ...process.env, PREBAKE_CONTENT_DIR: config.contentDir },
  });
  return out.status === 0 ? 'ok' : 'defect';
};
/**
 * The prebake row is the host's answer, and a host defect is the only defect
 * the report counts: `otherwise` is the exit code the report gives with no
 * defect (0 for a quick run, 2 when the runner never answered).
 */
const expectPrebakeIsTheHosts = (report: ContentCheckReport, project: ProjectContent, otherwise: 0 | 2 = 0): CheckResult => {
  const prebake = report.results.find((r) => r.id === PREBAKE);
  if (!prebake) throw new Error('the report has no prebake-available row');
  expect({ id: prebake.id, phase: prebake.phase, outcome: prebake.outcome }).toEqual({
    id: PREBAKE,
    phase: null,
    outcome: prebakeOnThisHost(project),
  });
  if (prebake.outcome === 'defect') expect(prebake.remedy.join('\n')).toContain('Nothing here is wrong with the pack');
  expect({ defects: report.defects, exitCode: report.exitCode }).toEqual(
    prebake.outcome === 'defect' ? { defects: 1, exitCode: 1 } : { defects: 0, exitCode: otherwise },
  );
  return prebake;
};

/**
 * A copy of the content directory on disk, doctored, with `config.contentDir`
 * pointed at it for the duration.
 *
 * Four of the new checks read the pack's *canonical application* (the contract,
 * the schema, the routes, the front-end suite), because two phases mount a
 * scaffold of `shared/contract/api.json` with operations removed, so a check
 * about the application cannot read a phase.
 */
const withContentRoot = async (
  edit: (root: string) => void,
  body: (project: ProjectContent) => Promise<void>,
): Promise<void> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-check-'));
  fs.cpSync(config.contentDir, root, { recursive: true });
  edit(root);
  const original = config.contentDir;
  (config as any).contentDir = root;
  try {
    const load = loadPacks();
    const project = load.projects.find((p) => p.slug === THE_PACK);
    expect(project).toBeDefined();
    await body(project as ProjectContent);
  } finally {
    (config as any).contentDir = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const canonical = (root: string, ...rest: string[]): string =>
  path.join(root, THE_PACK, 'canonical', ...rest);

/** A preview transport that behaves, standing in for SandboxService's real one. */
const previewStub = (
  answers: Partial<SandboxAppSession> & { page?: { status: number; body: string } } = {},
): SandboxLike & { started: SandboxAppJob[]; stopped: string[] } => {
  const started: SandboxAppJob[] = [];
  const stopped: string[] = [];
  const session = (): SandboxAppSession => ({
    id: 'app-1',
    status: 'ready',
    bundleOk: true,
    ...answers,
  });
  return {
    started,
    stopped,
    async execute(): Promise<RunResult> {
      throw new Error('preview-starts must not execute a test job');
    },
    async startApp(job: SandboxAppJob): Promise<SandboxAppSession> {
      started.push(job);
      return session();
    },
    async statusApp(): Promise<SandboxAppSession> {
      return session();
    },
    async assetApp(): Promise<{ status: number; contentType: string; body: string }> {
      const page = answers.page || {
        status: 200,
        body: '<!doctype html><div id="root" data-app="tasktrackr"></div>',
      };
      return { contentType: 'text/html', ...page };
    },
    async stopApp(id: string): Promise<void> {
      stopped.push(id);
    },
  };
};

describe('checkContent (the shipped pack, real sandbox)', () => {
  let report: ContentCheckReport;

  beforeAll(async () => {
    report = await checkContent();
  }, 300000);

  it('finds no defect in the pack', () => {
    // named, not counted: a failure here should say which check and why
    const defects = report.results
      .filter((r) => r.outcome === 'defect')
      .map((r) => `${r.pack}/${r.id}: ${r.remedy.join(' ')}`);
    expect(defects).toEqual([]);
    expect(report.loadFailures).toEqual([]);
    expect(report.defects).toBe(0);
    // `preview-starts` may say "could not tell" on a host that cannot run an
    // app right now; that is the one allowed exception. Every other check has
    // to be green here.
    const lost = report.results.filter((r) => r.outcome === 'unavailable').map((r) => r.id);
    expect(lost.filter((id) => id !== 'preview-starts')).toEqual([]);
    // 2 while the preview cannot be proved on this build, 0 the moment it can:
    // "could not tell" is an exit code, not a defect
    expect(report.exitCode).toBe(lost.length ? 2 : 0);
  });

  it('runs every published check against the pack', () => {
    expect(report.packs.map((p) => p.slug)).toEqual([THE_PACK]);
    for (const pack of report.packs) {
      const ids = report.results.filter((r) => r.pack === pack.slug).map((r) => r.id);
      expect({ pack: pack.slug, ids }).toEqual({ pack: pack.slug, ids: CHECK_IDS });
    }
    // counts, never adjectives: every check says what it proved
    for (const result of report.results) expect(result.detail).not.toBe('');
  });

  it('proves both layers of every two-run phase, and says so in the detail', () => {
    // every run of a two-run phase is proved: otherwise a phase whose python run
    // collects fourteen cases and whose typescript run collects none reads green
    const solution = report.results.find((r) => r.id === 'solution-passes-hidden');
    expect(solution?.detail).toContain('implementation python');
    expect(solution?.detail).toContain('implementation typescript');
    expect(solution?.detail).not.toContain(' 0 of 0');
    const reference = report.results.find((r) => r.id === 'reference-passes-impl');
    expect(reference?.detail).toContain('testing python');
    expect(reference?.detail).toContain('testing typescript');
  });
});

describe('checkContent (a doctored pack, one defect class each)', () => {
  const check = (project: ProjectContent, id: string): Promise<ContentCheckReport> =>
    checkContent({ projects: [project], only: [id] });

  it('reports no rubric-keys finding on a story phase, whose floor scores every criterion', async () => {
    const project = packOf(THE_PACK);
    const requirements = phaseOf(project, 'requirements');
    requirements.checks = validateStoryChecks({ kind: 'story' }, 'requirements');
    const result = only(await check(project, 'rubric-keys-scored'));
    expect({ id: result.id, outcome: result.outcome, remedy: result.remedy }).toEqual({
      id: 'rubric-keys-scored',
      outcome: 'ok',
      remedy: [],
    });
  });

  /* The decision record the design board opens on. */
  const designJson = (project: ProjectContent) =>
    phaseOf(project, 'design').files.find((f) => f.path === 'design/design.json')!;

  it('passes on the pack as it ships, which offers one decision record', async () => {
    const report = await check(packOf(THE_PACK), 'design-decision-scaffold');
    const result = only(report);
    expect({ id: result.id, outcome: result.outcome }).toEqual({
      id: 'design-decision-scaffold',
      outcome: 'ok',
    });
    expect(result.detail).toBe('1 decision record in the scaffold');
  });

  it('catches a scaffold that declares the same decision id twice', async () => {
    const project = packOf(THE_PACK);
    const file = designJson(project);
    const doc = JSON.parse(file.content) as { decisions: Record<string, unknown>[] };
    doc.decisions = [...doc.decisions, { ...doc.decisions[0] }];
    file.content = JSON.stringify(doc, null, 2);

    const result = expectDefect(
      await check(project, 'design-decision-scaffold'),
      'design-decision-scaffold',
    );
    expect(result.remedy.join('\n')).toContain('decision id D1 is used twice');
    // the finding names the record where the folder layout holds it: files/ at its workspace path
    expect(result.files.join('\n')).toContain('02-design/files/design/design.json');
  });

  it('catches a scaffold with no decision to open on, and a status nobody knows', async () => {
    const empty = packOf(THE_PACK);
    const emptyDoc = JSON.parse(designJson(empty).content) as { decisions: unknown[] };
    designJson(empty).content = JSON.stringify({ ...emptyDoc, decisions: [] });
    const emptyResult = expectDefect(
      await check(empty, 'design-decision-scaffold'),
      'design-decision-scaffold',
    );
    expect(emptyResult.remedy.join('\n')).toContain('design/design.json ships no decision');

    const odd = packOf(THE_PACK);
    const file = designJson(odd);
    const doc = JSON.parse(file.content) as { decisions: Record<string, unknown>[] };
    doc.decisions[0].status = 'shipped';
    file.content = JSON.stringify(doc, null, 2);
    const oddResult = expectDefect(
      await check(odd, 'design-decision-scaffold'),
      'design-decision-scaffold',
    );
    expect(oddResult.remedy.join('\n')).toContain('decision D1 has an unknown status');
  });

  it('refuses a pack whose Design is still of the markdown kind, by name', async () => {
    const project = packOf(THE_PACK);
    const design = phaseOf(project, 'design');
    design.checks = { kind: 'markdown', targets: ['design/my-design.md'], rules: [] } as never;
    const report = await check(project, 'design-decision-scaffold');
    const result = only(report);
    expect(result.outcome).not.toBe('ok');
    expect(JSON.stringify(result)).toContain('the design phase declares checks.kind \\"markdown\\", not \\"design\\"');
  });

  /*
   * A design-kind Design phase, loaded as the loader loads it (the pack
   * design-kind.spec.ts builds): the brief inline, the record at
   * design/design.json and the API contract beside it.
   */
  const designKindPack = (record?: string, checks: Record<string, unknown> = { kind: 'design' }): ProjectContent => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-check-'));
    try {
      fs.cpSync(path.join(config.contentDir, THE_PACK), root, { recursive: true });
      // the folder layout mounts the record by where it sits, files/ at its workspace path; TaskTrackr's
      // own design mounts are cleared first, so the phase mounts the record alone or nothing
      const design = path.join(root, 'phases', '02-design');
      for (const folder of ['files', 'readonly']) fs.rmSync(path.join(design, folder), { recursive: true, force: true });
      if (record !== undefined) {
        fs.mkdirSync(path.dirname(path.join(design, 'files', DESIGN_JSON)), { recursive: true });
        fs.writeFileSync(path.join(design, 'files', DESIGN_JSON), record);
      }
      fs.writeFileSync(path.join(design, 'phase.json'), JSON.stringify({
        title: 'Design', intro: 'Two services and one contract.', artifactKind: 'design', canRun: false,
        taskPanel: 'Design the overdue report.', objectives: ['one'],
        rubric: { passThreshold: 70, criteria: [{ key: 'traceability', title: 'Traceability', weight: 1, description: 'Every story lands.' }] },
        checks, assistant: { systemPrompt: 'Be a mentor.', topics: [], progressive: [] },
      }));
      return new ContentService().loadProject(new DirectoryPackSource(root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const oneDecision = serialiseDesign({
    ...EMPTY_DESIGN,
    decisions: [{ id: 'D1', title: 'Store', choice: '', alternative: '', rationale: '', tradeOff: '', status: 'proposed', satisfies: [] }],
  });

  it('passes a design-kind Design whose record ships one decision', async () => {
    const result = only(await check(designKindPack(oneDecision), 'design-decision-scaffold'));
    expect({ id: result.id, outcome: result.outcome, detail: result.detail }).toEqual({
      id: 'design-decision-scaffold',
      outcome: 'ok',
      detail: '1 decision record in the scaffold',
    });
  });

  it('catches a design-kind Design whose seeded record holds no decision', async () => {
    const result = expectDefect(await check(designKindPack(), 'design-decision-scaffold'), 'design-decision-scaffold');
    expect(result.remedy).toEqual([
      'design/design.json ships no decision; ship one entry so the learner starts on a record rather than on a button',
    ]);
  });

  it('names a design-kind record that is not valid in the loader\'s one sentence form', async () => {
    const pack = designKindPack(oneDecision);
    // the loader refuses such a record, so it is broken here, after loading, as a pack edited in place would be
    pack.phases.find((p) => p.key === 'design')!.files.find((f) => f.path === DESIGN_JSON)!.content = '{"entities":[]}';
    const result = expectDefect(await check(pack, 'design-decision-scaffold'), 'design-decision-scaffold');
    expect(result.remedy).toEqual(['design/design.json: The design record is not valid: relations is not a list.']);
  });

  it('holds a design-kind Design scaffold to the design floor, which the untouched record does not meet', async () => {
    const result = only(await check(designKindPack(oneDecision), 'scaffold-fails-gate'));
    expect({ outcome: result.outcome, remedy: result.remedy }).toEqual({ outcome: 'ok', remedy: [] });
    expect(result.detail.split(', ')).toContain('design');
  });

  it('catches a design-kind Design whose untouched record already meets the design floor', async () => {
    const nothing = { minEntities: 0, minRelations: 0, minOperations: 0, minDecisions: 0, decisionShape: false };
    const project = designKindPack(oneDecision, { kind: 'design', contracts: { api: false, screens: false }, floor: nothing });
    const result = expectDefect(await check(project, 'scaffold-fails-gate'), 'scaffold-fails-gate');
    expect(result.remedy).toEqual([
      'design: the untouched design/design.json already meets the design floor',
      "Raise the floor, so the learner's own design is what meets it.",
    ]);
  });

  it(
    'catches a mutant no shipped suite can kill, and names the criterion it left unevidenced',
    async () => {
      const project = packOf(THE_PACK);
      const checks = phaseOf(project, 'testing').checks as TestsChecks;
      // drop the one case that fails against filter_keyword_case_sensitive:
      // exactly the hole that lets a mutant survive in CI with nothing red
      const at = 'tests/test_acceptance.py';
      const run = checks.runs.find((r) => r.id === 'api')!;
      const blocks = run.referenceTestFiles[at].split(/(?=^def test_)/m);
      const kept = blocks.filter((b) => !b.startsWith('def test_a_keyword_matches_whatever_the_case'));
      expect(kept).toHaveLength(blocks.length - 1);
      run.referenceTestFiles[at] = kept.join('');
      checks.referenceTestFiles[at] = run.referenceTestFiles[at];

      const result = expectDefect(await check(project, 'mutants-die'), 'mutants-die');
      expect(result.detail).toBe('7 of 8');
      expect(result.remedy.join('\n')).toContain('filter_keyword_case_sensitive survived');
      expect(result.remedy.join('\n')).toContain('US-3/AC-2');
      // the file to open, at the path the reference actually nests under
      expect(result.files.join(' ')).toContain('reference/tests/test_acceptance.py');
    },
    180000,
  );

  it(
    'catches a shipped solution the hidden suite fails, in the front-end run',
    async () => {
      const project = packOf(THE_PACK);
      const phase = phaseOf(project, 'implementation');
      const checks = phase.checks as CodeChecks;
      const at = 'web/src/lib/overdue.ts';
      // the boundary the phase is about: a task due today is not late yet
      const doctored = checks.solutionFiles[at].replace(
        'return task.due_date < today;',
        'return task.due_date <= today;',
      );
      expect(doctored).not.toBe(checks.solutionFiles[at]);
      checks.solutionFiles[at] = doctored;

      const result = expectDefect(await check(project, 'solution-passes-hidden'), 'solution-passes-hidden');
      // it is found in the TYPESCRIPT run: sending the phase's language for
      // both runs is how a .tsx suite is silently dropped and reads as green
      expect(result.remedy.join('\n')).toContain('implementation typescript');
      expect(result.detail).toContain('implementation python 14 of 14');
    },
    180000,
  );

  it(
    'catches a drill the smoke check cannot fail',
    async () => {
      const project = packOf(THE_PACK);
      const checks = phaseOf(project, 'deployment').checks as ConfigChecks;
      // a drill that faults nothing: the learner gets a green run and nothing
      // to diagnose
      checks.drill!.faultedFiles = {};

      const result = expectDefect(await check(project, 'drill-breaks-smoke'), 'drill-breaks-smoke');
      expect(result.remedy.join('\n')).toContain('passes the same smoke check');
    },
    180000,
  );

  it('catches two mutants covering one criterion', async () => {
    const project = packOf(THE_PACK);
    const checks = phaseOf(project, 'testing').checks as TestsChecks;
    checks.mutants[1].covers = checks.mutants[0].covers;

    const result = expectDefect(await check(project, 'criterion-verified'), 'criterion-verified');
    expect(result.remedy.join('\n')).toContain(checks.mutants[0].name);
    expect(result.remedy.join('\n')).toContain(checks.mutants[1].name);
    expect(result.detail).toContain('1 orphans');
  });

  it('catches a mutant that covers a criterion the backlog never declared', async () => {
    const project = packOf(THE_PACK);
    const checks = phaseOf(project, 'testing').checks as TestsChecks;
    checks.mutants[0].covers = 'US-2/AC-9';

    const result = expectDefect(await check(project, 'criterion-verified'), 'criterion-verified');
    expect(result.remedy.join('\n')).toContain('US-2/AC-9');
  });

  it('refuses, by name, a pack whose Requirements is still the markdown kind: the backlog is read only from a story phase', async () => {
    const project = packOf(THE_PACK);
    phaseOf(project, 'requirements').checks = { kind: 'markdown', targets: ['requirements/draft.md'], rules: [] } as never;

    const result = expectDefect(await check(project, 'criterion-verified'), 'criterion-verified');
    expect(result.detail).toBe('the check could not complete');
    expect(result.remedy).toEqual(['the requirements phase declares checks.kind "markdown", not "story"']);
  });

  it('catches every mutant sitting in one layer', async () => {
    const project = packOf(THE_PACK);
    const checks = phaseOf(project, 'testing').checks as TestsChecks;
    // the silent regression this check exists for: an author moves the two
    // front-end mutants into the API run and the kill matrix still reads 8 of 8
    for (const mutant of checks.mutants) mutant.run = 'api';

    const result = expectDefect(await check(project, 'both-layers-mutated'), 'both-layers-mutated');
    expect(result.detail).toBe('api 8, web 0');
    expect(result.remedy.join('\n')).toContain('no mutant belongs to run "web"');
  });

  it('catches a rubric key the grader never scores', async () => {
    const project = packOf(THE_PACK);
    // one transposition, and every learner loses 40% of the phase with no
    // evidence line to say why
    phaseOf(project, 'implementation').rubric.criteria[0].key = 'correctness_hiden';

    const result = expectDefect(await check(project, 'rubric-keys-scored'), 'rubric-keys-scored');
    expect(result.remedy.join('\n')).toContain('correctness_hiden');
    expect(result.remedy.join('\n')).toContain('correctness_hidden');
  });

  it('catches a run whose language the pack never declared', async () => {
    const project = packOf(THE_PACK);
    (phaseOf(project, 'implementation').checks as CodeChecks).runs[1].language = 'ruby' as never;

    const result = expectDefect(await check(project, 'pack-loads'), 'pack-loads');
    expect(result.remedy.join('\n')).toContain('run "web" is ruby');
  });

  it('passes a pack of three phases, Requirements, Design and Implementation, numbered 1 to 3', async () => {
    const project = packOf(THE_PACK);
    project.phases = project.phases
      .filter((p) => p.key === 'requirements' || p.key === 'design' || p.key === 'implementation')
      .map((p, at) => ({ ...p, order: at + 1 }));

    const result = only(await check(project, 'pack-loads'));
    expect({ outcome: result.outcome, remedy: result.remedy }).toEqual({ outcome: 'ok', remedy: [] });
  });

  it("refuses a pack whose phases read Testing then Implementation, in the subset rule's sentence", async () => {
    const project = packOf(THE_PACK);
    const implementation = phaseOf(project, 'implementation');
    const testing = phaseOf(project, 'testing');
    project.phases = [{ ...testing, order: 1 }, { ...implementation, order: 2 }];

    const result = expectDefect(await check(project, 'pack-loads'), 'pack-loads');
    expect(result.remedy).toContain("A project keeps LearnSDLC's order, and Implementation comes before Testing.");
  });

  it('catches a rubric title or description longer than the editor saves, naming the phase file', async () => {
    const project = packOf(THE_PACK);
    // the builder's Criteria step sends every row as loaded, so a pack text
    // past the DTO's cap is refused on every copy, even for a weight change
    const criteria = phaseOf(project, 'deployment').rubric.criteria;
    const runbook = criteria.find((c) => c.key === 'runbook_quality')!;
    runbook.description = 'w'.repeat(RUBRIC_CRITERION_DESCRIPTION_MAX + 1);
    runbook.title = 't'.repeat(RUBRIC_CRITERION_TITLE_MAX + 1);
    // exactly at the caps is what the editor saves
    const other = criteria.find((c) => c.key !== 'runbook_quality')!;
    other.description = 'w'.repeat(RUBRIC_CRITERION_DESCRIPTION_MAX);
    other.title = 't'.repeat(RUBRIC_CRITERION_TITLE_MAX);

    const result = expectDefect(await check(project, 'pack-loads'), 'pack-loads');
    expect(result.remedy).toEqual([
      `deployment: the rubric title of "runbook_quality" is ${RUBRIC_CRITERION_TITLE_MAX + 1} characters; the editor saves at most ${RUBRIC_CRITERION_TITLE_MAX}`,
      `deployment: the rubric description of "runbook_quality" is ${RUBRIC_CRITERION_DESCRIPTION_MAX + 1} characters; the editor saves at most ${RUBRIC_CRITERION_DESCRIPTION_MAX}`,
    ]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatch(/05-deployment[\\/]phase\.json$/);
  });

  it('holds every shipped pack\'s rubric titles and descriptions to the editor\'s caps', async () => {
    const upload = ['shelf', 'shelf-preview', 'starter'].map((pack) =>
      new ContentService().loadProject(new DirectoryPackSource(path.join(SHELF_DIR, '..', pack))),
    );
    for (const project of [packOf(THE_PACK), ...upload]) {
      const result = only(await check(project, 'pack-loads'));
      expect({ pack: project.slug, outcome: result.outcome, remedy: result.remedy }).toEqual({ pack: project.slug, outcome: 'ok', remedy: [] });
    }
  });

  it('catches a run that names a test path the phase never ships', async () => {
    const project = packOf(THE_PACK);
    (phaseOf(project, 'implementation').checks as CodeChecks).runs[0].testPaths = ['tests/nowhere.py'];

    const result = expectDefect(await check(project, 'runs-agree'), 'runs-agree');
    expect(result.remedy.join('\n')).toContain('tests/nowhere.py');
    expect(result.remedy.join('\n')).toContain('collects nothing');
  });

  it('catches a support file the learner can edit', async () => {
    const project = packOf(THE_PACK);
    const phase = phaseOf(project, 'testing');
    phase.files.find((f) => f.path === 'tests/clock.py')!.editable = true;

    const result = expectDefect(await check(project, 'runs-agree'), 'runs-agree');
    expect(result.remedy.join('\n')).toContain('tests/clock.py');
    expect(result.remedy.join('\n')).toContain('scored through');
  });

  it('catches a hidden test file the phase also mounts', async () => {
    const project = packOf(THE_PACK);
    const phase = phaseOf(project, 'implementation');
    const at = Object.keys((phase.checks as CodeChecks).runs[0].hiddenTestFiles)[0];
    // the whole seal, undone by one line of phase.json: a suite the learner
    // can read is a suite they can satisfy without writing the code
    phase.files.push({ path: at, content: '# whatever', editable: false, language: 'python' });

    const result = expectDefect(
      await check(project, 'no-graded-file-in-the-workspace'),
      'no-graded-file-in-the-workspace',
    );
    expect(result.remedy.join('\n')).toContain(at);
    expect(result.remedy.join('\n')).toContain('read the suite that grades them');
  });

  it('catches a mutant planted on a file the learner edits', async () => {
    const project = packOf(THE_PACK);
    const phase = phaseOf(project, 'testing');
    const checks = phase.checks as TestsChecks;
    const at = Object.keys(checks.mutants[0].files)[0];
    phase.files.push({ path: at, content: 'whatever', editable: true, language: 'typescript' });

    const result = expectDefect(
      await check(project, 'no-graded-file-in-the-workspace'),
      'no-graded-file-in-the-workspace',
    );
    expect(result.remedy.join('\n')).toContain('overwrites the planted bug');
  });

  it('catches a change request the pack has already written', async () => {
    const project = packOf(THE_PACK);
    const maintenance = phaseOf(project, 'maintenance');
    // the starting change request shipped with a release line that already covers an acceptance item
    const record = maintenance.files.find((f) => f.path === CHANGE_REQUEST_JSON)!;
    record.content = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, release: { version: '2.1.0', summary: '', changes: [{ id: 'L1', line: 'CR-1: comments on a task.', covers: ['AC-1'] }], rollback: '' } });

    const result = expectDefect(await check(project, 'change-request-complete'), 'change-request-complete');
    expect(result.remedy.join('\n')).toContain("the starting change request's L1 already covers AC-1");
  });

  it('catches an untouched scaffold that would pass its own gate', async () => {
    const project = packOf(THE_PACK);
    const requirements = phaseOf(project, 'requirements');
    // the seeded record shipped already filled in: the floor is met before the
    // learner has written a word
    const record = requirements.files.find((f) => f.path === 'requirements/story.json')!;
    record.content = serialiseStory({
      ...EMPTY_STORY,
      id: 'US-4',
      persona: 'busy learner',
      capability: 'an overdue report',
      benefit: 'I see what I missed',
      criteria: [
        { id: 'AC-1', given: 'a task due yesterday', when: 'I open the report', then: 'it is listed', tag: 'happy' },
        { id: 'AC-2', given: 'a task due today', when: 'I open the report', then: 'it is not listed', tag: 'boundary' },
      ],
      scopeExclusions: ['notifications'],
    });
    const result = expectDefect(await check(project, 'scaffold-fails-gate'), 'scaffold-fails-gate');
    expect(result.remedy.join('\n')).toContain('requirements: the untouched requirements/story.json already meets the story floor');
  });
});

describe('the record arms', () => {
  /** The record pack as plain data, as `packOf` gives a shipped pack. */
  const recordProject = (edit?: Parameters<typeof recordPack>[0]): ProjectContent =>
    JSON.parse(JSON.stringify(new ContentService().loadProject(recordPack(edit)))) as ProjectContent;
  const check = (project: ProjectContent, id: string): Promise<ContentCheckReport> =>
    checkContent({ projects: [project], only: [id], quick: true });
  /**
   * A starting record the phase ships, in place of the one it mounts: the folder layout mounts a
   * record by where it sits, files/ at its workspace path, so an `extra` at that path replaces it.
   */
  const startingRecord = (folder: string, at: string, text: string): Record<string, string> => ({ [`phases/${folder}/files/${at}`]: text });

  it('incident-gated: the record pack names its fault in the drill\'s own words, and a vague root cause does not count', async () => {
    const result = only(await check(recordProject(), 'incident-gated'));
    expect({ outcome: result.outcome, remedy: result.remedy }).toEqual({ outcome: 'ok', remedy: [] });
  });
  it('incident-gated: a drill phase whose runbook floor does not require the incident is a defect', async () => {
    const project = recordProject({ deployment: (s) => { s.checks.runbook.floor.requireIncident = false; } });
    const result = expectDefect(await check(project, 'incident-gated'), 'incident-gated');
    expect(result.remedy).toContain("the phase declares a drill, but the runbook floor does not require the incident, so the drill's own record is graded by nothing");
  });
  it('incident-gated: a runbook phase with no drill is skipped, since no incident is written from one', async () => {
    // the folder layout refuses a drill/ folder no drill is declared for, so the folder goes with the declaration
    const noDrill = recordProject({ deployment: (s) => { delete s.checks.drill; }, drop: (name) => name.startsWith('phases/05-deployment/drill/') });
    const result = only(await check(noDrill, 'incident-gated'));
    expect({ outcome: result.outcome, detail: result.detail }).toEqual({ outcome: 'skipped', detail: 'the deployment phase declares no drill, so no incident is written from one for the record to name' });
  });
  it('incident-gated: a drill whose own words name nothing a diagnosis can carry is a defect', async () => {
    // no directive or setting in the description, and every id word a stopword
    const project = recordProject({ deployment: (s) => { s.checks.drill.fault = 'broken-fault'; s.checks.drill.description = 'It was wrong.'; } });
    const result = expectDefect(await check(project, 'incident-gated'), 'incident-gated');
    expect(result.remedy).toEqual(["a record whose root cause names the fault in the drill's own words does not count as naming it"]);
  });
  it('incident-gated: a drill whose words a vague root cause already carries is a defect', async () => {
    const project = recordProject({ deployment: (s) => { s.checks.drill.fault = 'container-start'; s.checks.drill.description = 'The container would not start.'; } });
    const result = expectDefect(await check(project, 'incident-gated'), 'incident-gated');
    expect(result.remedy).toEqual(['a record that says something broke without naming what already counts as naming the fault']);
  });
  it('scaffold-fails-gate: the record pack proves deployment and maintenance with no remedy', async () => {
    const result = only(await check(recordProject(), 'scaffold-fails-gate'));
    expect({ outcome: result.outcome, remedy: result.remedy }).toEqual({ outcome: 'ok', remedy: [] });
  });
  it('scaffold-fails-gate: a starting runbook that already meets the floor is named', async () => {
    // the incident stays empty (a drill phase's starting incident must be), so the floor is met with the incident toggle off
    const full = serialiseRunbook({
      environment: [{ id: 'E1', name: 'TASKTRACKR_DB', purpose: 'Database path.', kind: 'config' }, { id: 'E2', name: 'API_URL', purpose: 'Where web sends /api.', kind: 'config' }],
      health: [{ id: 'H1', name: 'Selfcheck', how: 'python3 api/main.py --selfcheck', expected: 'selfcheck: web reaches api' }],
      rollback: [{ id: 'R1', step: 'Retag the previous images', verify: 'docker compose ps' }, { id: 'R2', step: 'docker compose up -d', verify: 'The selfcheck passes' }],
      data: [{ id: 'D1', what: 'The database file', how: 'sqlite3 .backup', where: 'tasktrackr-data' }],
      incident: { rootCause: '', fix: '', actionItem: '' },
    });
    const project = recordProject({
      deployment: (s) => { s.checks.runbook.floor.requireIncident = false; },
      extra: startingRecord('05-deployment', RUNBOOK_JSON, full),
    });
    const result = expectDefect(await check(project, 'scaffold-fails-gate'), 'scaffold-fails-gate');
    expect(result.remedy).toContain('deployment: the untouched starting runbook already meets the runbook floor');
  });
  it('change-request-complete: a starting change line that covers an acceptance id is named', async () => {
    const covering = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, release: { ...EMPTY_CHANGE_REQUEST.release, changes: [{ id: 'L1', line: 'Comments on a task', covers: ['AC-1'] }] } });
    const project = recordProject({
      extra: startingRecord('06-maintenance', CHANGE_REQUEST_JSON, covering),
    });
    const result = expectDefect(await check(project, 'change-request-complete'), 'change-request-complete');
    expect(result.remedy.join('\n')).toContain("the starting change request's L1 already covers AC-1");
  });
});

describe('checkContent (a doctored canonical application)', () => {
  const check = (project: ProjectContent, id: string): Promise<ContentCheckReport> =>
    checkContent({ projects: [project], only: [id] });

  it('catches a contract operation no route answers', async () => {
    await withContentRoot(
      (root) => {
        const at = canonical(root, 'shared', 'contract', 'api.json');
        const contract = JSON.parse(fs.readFileSync(at, 'utf-8'));
        contract.operations.push({
          id: 'archiveTask',
          method: 'POST',
          path: '/api/tasks/{id}/archive',
          summary: 'Put a task away.',
        });
        fs.writeFileSync(at, JSON.stringify(contract, null, 2));
      },
      async (project) => {
        const result = expectDefect(
          await check(project, 'contract-matches-routes'),
          'contract-matches-routes',
        );
        expect(result.remedy.join('\n')).toContain('POST /api/tasks/{}/archive');
        expect(result.remedy.join('\n')).toContain('archiveTask');
      },
    );
  });

  it('catches a route the contract does not publish', async () => {
    await withContentRoot(
      (root) => {
        const at = canonical(root, 'api', 'routes', 'lists.py');
        fs.appendFileSync(
          at,
          '\n\n@bp.delete("/api/lists/<int:list_id>")\ndef delete_list(list_id):\n    return "", 204\n',
        );
      },
      async (project) => {
        const result = expectDefect(
          await check(project, 'contract-matches-routes'),
          'contract-matches-routes',
        );
        expect(result.remedy.join('\n')).toContain('DELETE /api/lists/{}');
        expect(result.remedy.join('\n')).toContain('a route nobody designed');
      },
    );
  });

  it('catches a NOT NULL column the contract never mentions', async () => {
    await withContentRoot(
      (root) => {
        const at = canonical(root, 'shared', 'contract', 'api.json');
        const contract = JSON.parse(fs.readFileSync(at, 'utf-8'));
        contract.entities.tasks.fields = contract.entities.tasks.fields.filter(
          (f: { name: string }) => f.name !== 'title',
        );
        fs.writeFileSync(at, JSON.stringify(contract, null, 2));
      },
      async (project) => {
        const result = expectDefect(
          await check(project, 'schema-matches-contract'),
          'schema-matches-contract',
        );
        expect(result.remedy.join('\n')).toContain('tasks.title is NOT NULL');
      },
    );
  });

  it('catches a contract field the schema has no column for', async () => {
    await withContentRoot(
      (root) => {
        const at = canonical(root, 'shared', 'contract', 'api.json');
        const contract = JSON.parse(fs.readFileSync(at, 'utf-8'));
        contract.entities.tasks.fields.push({ name: 'archived_at', type: 'timestamp', required: false });
        fs.writeFileSync(at, JSON.stringify(contract, null, 2));
      },
      async (project) => {
        const result = expectDefect(
          await check(project, 'schema-matches-contract'),
          'schema-matches-contract',
        );
        expect(result.remedy.join('\n')).toContain('"archived_at"');
      },
    );
  });

  it('catches a front end that keeps state in the browser', async () => {
    await withContentRoot(
      (root) => {
        const at = canonical(root, 'web', 'src', 'hooks', 'useLists.ts');
        fs.appendFileSync(at, "\nconst remembered = localStorage.getItem('lists');\n");
      },
      async (project) => {
        const result = expectDefect(await check(project, 'no-browser-storage'), 'no-browser-storage');
        expect(result.remedy.join('\n')).toContain('web/src/hooks/useLists.ts uses localStorage');
        expect(result.remedy.join('\n')).toContain('opaque-origin iframe');
      },
    );
  });

  it('passes a front end that only explains why it keeps none', async () => {
    await withContentRoot(
      (root) => {
        const at = canonical(root, 'web', 'src', 'hooks', 'useLists.ts');
        fs.appendFileSync(at, '\n// Deliberately no localStorage here: see the preview contract.\n');
      },
      async (project) => {
        const result = only(await check(project, 'no-browser-storage'));
        expect(result.outcome).toBe('ok');
      },
    );
  });

  it(
    'catches a canonical front end its own suite fails',
    async () => {
      await withContentRoot(
        (root) => {
          const at = canonical(root, 'web', 'src', 'lib', 'overdue.ts');
          const source = fs.readFileSync(at, 'utf-8');
          fs.writeFileSync(at, source.replace('return task.due_date < today;', 'return task.due_date <= today;'));
        },
        async (project) => {
          const result = expectDefect(
            await check(project, 'front-end-suite-runs'),
            'front-end-suite-runs',
          );
          expect(result.remedy.join('\n')).toContain('does not pass its own components');
        },
      );
    },
    180000,
  );

  it('catches a pre-baked layer the packs have moved past', async () => {
    await withContentRoot(
      (root) => {
        const at = path.join(root, THE_PACK, 'project.json');
        const project = JSON.parse(fs.readFileSync(at, 'utf-8'));
        project.runtime.python.packages = project.runtime.python.packages.map((pin: string) =>
          pin.startsWith('flask==') ? 'flask==3.0.2' : pin,
        );
        fs.writeFileSync(at, JSON.stringify(project, null, 2));
      },
      async (project) => {
        const result = expectDefect(await check(project, 'prebake-available'), 'prebake-available');
        expect(result.remedy.join('\n')).toContain('npm run prebake');
      },
    );
  }, 60000);
});

describe('checkContent (the preview)', () => {
  const check = (sandbox: SandboxLike): Promise<ContentCheckReport> =>
    checkContent({ projects: [packOf(THE_PACK)], sandbox, only: ['preview-starts'] });

  it('starts the pack’s own app, reads its page and stops it', async () => {
    const sandbox = previewStub();
    const result = only(await check(sandbox));

    expect(result.outcome).toBe('ok');
    expect(result.detail).toContain('ready in');
    // the job the checker sends is the pack's own preview block over the
    // canonical application, and the app is stopped however the check ends
    const [job] = sandbox.started;
    expect(job.service.command).toEqual(['python3', 'api/main.py']);
    expect(job.web).toEqual({ root: 'web/dist', html: 'web/index.html' });
    expect(job.files['api/main.py']).toContain('create_app');
    expect(job.build?.entry).toBe('web/src/main.tsx');
    expect(sandbox.stopped).toEqual(['app-1']);
  });

  it('reports an app that never came up, and still stops it', async () => {
    const sandbox = previewStub({ status: 'failed', message: 'Your API did not start.' });
    const result = expectDefect(await check(sandbox), 'preview-starts');

    expect(result.remedy.join('\n')).toContain('Your API did not start.');
    expect(sandbox.stopped).toEqual(['app-1']);
  });

  it('reports a page that is not the pack’s own document', async () => {
    const sandbox = previewStub({ page: { status: 200, body: '<html><body>nothing here</body></html>' } });
    const result = expectDefect(await check(sandbox), 'preview-starts');

    expect(result.remedy.join('\n')).toContain('data-app="tasktrackr"');
  });

  it('says "could not tell" on a build with no preview transport', async () => {
    const sandbox: SandboxLike = {
      async execute(): Promise<RunResult> {
        throw new Error('not reached');
      },
    };
    const report = await check(sandbox);
    const result = only(report);

    // never a defect: a deployment that cannot run an app says nothing about
    // whether the pack is right
    expect(result.outcome).toBe('unavailable');
    expect(result.detail).toContain('no preview transport');
    expect(report.defects).toBe(0);
    expect(report.exitCode).toBe(2);
  });

  it('says "could not tell" when the transport answers rather than throwing', async () => {
    // `SandboxService.startApp` returns `{status: "unavailable"}` instead of
    // raising when the socket is not there: a runner that is simply down.
    // Read as a session that left `starting` at once, that would be a defect
    // in the pack and the whole run would exit 1 instead of 2, telling a CI
    // operator their content is broken when their runner is off.
    const sandbox = previewStub({
      status: 'unavailable',
      message: 'socket runner (/tmp/no-such.sock): connect ENOENT /tmp/no-such.sock',
    });
    const report = await check(sandbox);
    const result = only(report);

    expect(result.outcome).toBe('unavailable');
    expect(result.detail).toContain('connect ENOENT');
    expect(report.defects).toBe(0);
    expect(report.exitCode).toBe(2);
  });

  it('says "could not tell" when the runner is full of other people´s previews', async () => {
    const sandbox = previewStub({ status: 'busy', message: 'The runner is busy.' });
    const report = await check(sandbox);

    expect(only(report).outcome).toBe('unavailable');
    expect(report.defects).toBe(0);
  });
});

describe('checkContent (the runner never answered)', () => {
  const unavailable = (): RunResult => ({
    ok: false,
    exitKind: 'unavailable',
    stdout: '',
    stderr: '',
    durationMs: 0,
  });

  const recorder = (): { sandbox: SandboxLike; jobs: SandboxJob[] } => {
    const jobs: SandboxJob[] = [];
    return {
      jobs,
      sandbox: {
        async execute(job: SandboxJob): Promise<RunResult> {
          jobs.push(job);
          return unavailable();
        },
      },
    };
  };

  // The two cases' bodies, as helpers, so the
  // stand-in-python case at the end of this block asks exactly what they ask.
  // prebake-available (the host's python, not the runner and not the pack) is
  // kept out of "nothing as a defect" and asserted on its own.
  const expectUnavailableNotDefect = async (): Promise<void> => {
    const { sandbox, jobs } = recorder();
    const pack = packOf(THE_PACK);
    const report = await checkContent({ projects: [pack], sandbox });

    // this is the assertion that stops a missing socket from being reported
    // as a broken pack
    expect(report.results.filter((r) => r.id !== PREBAKE && r.outcome === 'defect')).toEqual([]);
    expectPrebakeIsTheHosts(report, pack, 2);
    expect(report.results.filter((r) => r.outcome === 'unavailable').map((r) => r.id)).toEqual([
      'solution-passes-hidden',
      'stub-fails-hidden',
      'front-end-suite-runs',
      'reference-passes-impl',
      'mutants-die',
      'drill-breaks-smoke',
      'preview-starts',
    ]);
    expect(report.unavailable).toBe(7);
    expect(jobs.length).toBeGreaterThan(0);
    // the forged entrypoint is refused by the Dockerfile parser, so it never
    // reaches the runner and stays a verdict
    const forged = report.results.find((r) => r.id === 'forged-entrypoint-refused');
    expect(forged?.outcome).toBe('ok');
  };

  it('reports the sandbox proofs as unavailable and nothing as a defect', async () => {
    await expectUnavailableNotDefect();
  });

  it('sends each run its own harness, language and transform', async () => {
    const jobs: SandboxJob[] = [];
    const sandbox: SandboxLike = {
      async execute(job: SandboxJob): Promise<RunResult> {
        jobs.push(job);
        return {
          ok: true,
          exitKind: 'ok',
          stdout: '',
          stderr: '',
          durationMs: 1,
          tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] },
        };
      },
    };
    await checkContent({
      projects: [packOf(THE_PACK)],
      sandbox,
      only: ['solution-passes-hidden'],
    });

    // the union of two runs sent under one language and no harness is how a
    // pytest file collects nothing and a .tsx file is dropped in silence
    const sealed = jobs.filter((j) => j.mode === 'tests') as Extract<SandboxJob, { mode: 'tests' }>[];
    expect(sealed.map((j) => `${j.language}/${j.harness}`)).toEqual([
      'python/unittest',
      'typescript/js',
      'python/unittest',
      'typescript/js',
    ]);
    expect(sealed.filter((j) => j.transform).map((j) => j.transform?.tool)).toEqual([
      'esbuild',
      'esbuild',
    ]);
  });

  const expectQuickRunsNoJob = async (): Promise<void> => {
    const { sandbox, jobs } = recorder();
    const pack = packOf(THE_PACK);
    const report = await checkContent({ projects: [pack], sandbox, quick: true });

    expect(jobs).toEqual([]);
    expect(report.skipped).toBe(SANDBOX_CHECK_IDS.length);
    expect(report.results.filter((r) => r.outcome === 'skipped').map((r) => r.id)).toEqual(
      SANDBOX_CHECK_IDS,
    );
    expect(report.results.filter((r) => r.id !== PREBAKE && r.outcome === 'defect')).toEqual([]);
    expectPrebakeIsTheHosts(report, pack, 0);
  };

  it('runs no sandbox job at all with quick', async () => {
    await expectQuickRunsNoJob();
  });

  it('both cases above hold whichever python the host puts first (a stand-in interpreter the dependency lock refuses)', async () => {
    const was = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = process.execPath;
    try {
      await expectUnavailableNotDefect();
      await expectQuickRunsNoJob();
    } finally {
      if (was === undefined) delete process.env.PYTHON_BIN;
      else process.env.PYTHON_BIN = was;
    }
  });
});

describe('loadPacks (a pack that will not load)', () => {
  it('keeps the packs that loaded and carries the loader message for the one that did not', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-check-'));
    fs.cpSync(config.contentDir, root, { recursive: true });
    // a second pack, so there is something left to keep when the first refuses
    fs.cpSync(path.join(root, THE_PACK), path.join(root, 'other-pack'), { recursive: true });
    const at = path.join(root, 'other-pack', 'project.json');
    const meta = JSON.parse(fs.readFileSync(at, 'utf-8'));
    meta.slug = 'other-pack';
    delete meta.version;
    fs.writeFileSync(at, JSON.stringify(meta, null, 2));

    const original = config.contentDir;
    (config as any).contentDir = root;
    try {
      const load = loadPacks();
      expect(load.packs).toEqual(['other-pack', THE_PACK]);
      expect(load.projects.map((p) => p.slug)).not.toContain('other-pack');
      const failure = load.failures.find((f) => f.pack === 'other-pack');
      // the loader's own message, verbatim: it already names the file and field
      expect(failure?.message).toMatch(/project\.json: version must be a non-empty string/);
    } finally {
      (config as any).contentDir = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/* --------------------------- the applies() rows --------------------------- */

/**
 * The `shelf` fixture pack is a teacher's own application in the authoring format: a
 * sole work task per executable phase, its own design contract, its own story
 * ids, a drill that faults a config file rather than a Dockerfile directive,
 * and a change request made of code alone. Four checks were written for the
 * reference project's conventions and would call those choices defects, so
 * each says whether it applies to the pack in front of it;
 * the reference project is always in scope, so its report does not move.
 */
describe('checkContent (a pack that is not the reference project)', () => {
  // the Shelf pack on its own: its directory's other upload fixtures include two older-format packs the platform loader names
  const loadShelf = (): ProjectContent => {
    const project = new ContentService().loadProject(new DirectoryPackSource(SHELF_DIR));
    expect(project.slug).toBe(SHELF_SLUG);
    return JSON.parse(JSON.stringify(project)) as ProjectContent;
  };
  const check = (project: ProjectContent, id: string): Promise<ContentCheckReport> =>
    checkContent({ projects: [project], only: [id], quick: true });
  const expectSkipped = (report: ContentCheckReport, id: string): CheckResult => {
    const result = only(report);
    expect({ id: result.id, outcome: result.outcome }).toEqual({ id, outcome: 'skipped' });
    expect(result.detail).not.toBe('');
    expect(report.defects).toBe(0);
    return result;
  };

  it('› the Shelf pack: design-decision-scaffold does not apply to a design phase that ships no starting record', async () => {
    const shelf = loadShelf();
    // the shelf's Design is a design phase that ships no files: its record is the empty one the loader seeds
    expect(phaseOf(shelf, 'design').checks.kind).toBe('design');
    expect(phaseOf(shelf, 'design').files.find((f) => f.path === DESIGN_JSON)?.content).toBe(serialiseDesign(EMPTY_DESIGN));
    expectSkipped(await check(shelf, 'design-decision-scaffold'), 'design-decision-scaffold');
    // a pack that ships a record of its own is held to it
    const shipped = loadShelf();
    const record = phaseOf(shipped, 'design').files.find((f) => f.path === DESIGN_JSON)!;
    record.content = serialiseDesign({ ...EMPTY_DESIGN, entities: [{ id: 'E1', name: 'Book', kind: 'class', attributes: [], responsibilities: [], satisfies: [] }] });
    expectDefect(await check(shipped, 'design-decision-scaffold'), 'design-decision-scaffold');
  });

  it('› the Shelf pack: criterion-verified does not apply to verifiers that do not use the US-n/AC-m backlog', async () => {
    const shelf = loadShelf();
    const checks = phaseOf(shelf, 'testing').checks as TestsChecks;
    // the shelf pack traces its own story ids (SH-n), in a backlog of its own shape
    const ids = [...checks.coverageKeywords.map((g) => g.criterionId), ...checks.mutants.map((m) => m.covers)];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => /^US-\d+\/AC-\d+$/.test(id || ''))).toEqual([]);
    expectSkipped(await check(shelf, 'criterion-verified'), 'criterion-verified');
    // a pack that names one is held to all of them
    const traced = loadShelf();
    (phaseOf(traced, 'testing').checks as TestsChecks).mutants[0].covers = 'US-9/AC-9';
    expectDefect(await check(traced, 'criterion-verified'), 'criterion-verified');
  });

  it('› the Shelf pack: change-request-complete holds the shelf\'s starting change request, which needs no design contract with its contract switch off', async () => {
    const shelf = loadShelf();
    const maintenance = phaseOf(shelf, 'maintenance');
    expect(maintenance.files.map((f) => f.path)).not.toContain('design/contracts.json');
    expect((maintenance.checks as CodeChecks).change!.contract).toBe(false);
    expect({ outcome: only(await check(shelf, 'change-request-complete')).outcome }).toEqual({ outcome: 'ok' });
    // a maintenance phase that ships neither change-request file is skipped
    const bare = loadShelf();
    const phase = phaseOf(bare, 'maintenance');
    phase.files = phase.files.filter((f) => f.path !== CHANGE_REQUEST_JSON);
    expectSkipped(await check(bare, 'change-request-complete'), 'change-request-complete');
    // with the contract switch on, the design contract it amends must ship
    const switched = loadShelf();
    (phaseOf(switched, 'maintenance').checks as CodeChecks).change!.contract = true;
    expectDefect(await check(switched, 'change-request-complete'), 'change-request-complete');
  });

  it('incident-gated applies to the shelf\'s runbook record, whose drill faults deploy/shelf.json, and the probe names port-zero in its own words', async () => {
    const shelf = loadShelf();
    const checks = phaseOf(shelf, 'deployment').checks as ConfigChecks;
    expect(Object.keys(checks.drill!.faultedFiles)).toEqual(['deploy/shelf.json']);
    expect(checks.runbook).toEqual({ record: RUNBOOK_JSON, floor: { minEnvironment: 0, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true } });
    const result = only(await check(shelf, 'incident-gated'));
    expect({ outcome: result.outcome, remedy: result.remedy, detail: result.detail }).toEqual({ outcome: 'ok', remedy: [], detail: 'runbook incident required' });
  });

  // The two shelf-pack report cases, as helpers, so the
  // stand-in-python case below asks exactly what they ask. prebake-available
  // is asked on its own (`expectPrebakeIsTheHosts`, top of this file).
  const expectShelfZeroDefects = async (): Promise<void> => {
    // static and quick: the sandbox proofs of an uploaded pack are deep
    // validation's (authoring/deep-validation.ts), and this host's runner
    // refuses to run without kernel isolation
    const shelf = loadShelf();
    const report = await checkContent({ projects: [shelf], quick: true });
    expect(report.results.map((r) => r.id)).toEqual(CHECK_IDS);
    const defects = report.results
      .filter((r) => r.id !== PREBAKE && r.outcome === 'defect')
      .map((r) => `${r.id}: ${r.remedy.join(' ')}`);
    expect(defects).toEqual([]);
    expectPrebakeIsTheHosts(report, shelf);
  };
  const expectTaskTrackrUnchanged = async (): Promise<void> => {
    // every field but the clock: every row but prebake-available's (the
    // host's) by a pin of its own, and, where this host's layer matches the
    // packs, the whole report by a second pin. A check that applies only to
    // packs that are not the reference project must leave this report as it is.
    const pack = packOf(THE_PACK);
    const report = await checkContent({ projects: [pack], quick: true });
    const stable = report.results.map(({ durationMs: _ms, ...rest }) => rest);
    const digestOf = (rows: unknown[]): string => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    // The pin moves only with the shipped pack: rubric-keys-scored counts its 23 criteria, incident-gated is
    // labelled by the fault in the drill's own words and reads the runbook record, scaffold-fails-gate proves
    // maintenance too, change-request-complete reads the starting change request, and the finding paths name
    // the folder layout.
    expect(digestOf(stable.filter((r) => r.id !== PREBAKE))).toBe('bef60aaf1d4d906461d1e5e3d4767cf420b208520df1af20c0ad2223baece58e');
    const prebake = expectPrebakeIsTheHosts(report, pack);
    if (prebake.outcome === 'ok') {
      // This whole-report value was recorded for an earlier TaskTrackr version, without the brief-plain and
      // canonical-copies-agree rows that `stable` now holds, so it is red on the first host whose prebake row is
      // ok. A host without the prebaked runtime layer never reaches it. The value must be recorded again on a
      // host with the layer before the next run there is trusted; until it is, this assertion fails on that host.
      expect(digestOf(stable)).toBe('2019c07a013cf3b0568c9712004db0aafa7f81b840abfa8d5eadf8de10367d0f');
    }
  };

  it("› the Shelf pack's content-check report has zero defects", async () => {
    await expectShelfZeroDefects();
  });

  it("GUARD › TaskTrackr's content-check report is unchanged", async () => {
    await expectTaskTrackrUnchanged();
  });

  it('› both report cases hold whichever python the host puts first (a stand-in interpreter the dependency lock refuses)', async () => {
    // prebake-available runs `scripts/prebake.mjs verify`, which runs
    // runtime_dependencies.py under PYTHON_BIN or the first python3 on PATH:
    // 3.11 passes it, Homebrew's 3.13 does not. The stand-in (this node, which
    // refuses python's -I) fails it the same way on every host.
    const was = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = process.execPath;
    try {
      await expectShelfZeroDefects();
      await expectTaskTrackrUnchanged();
    } finally {
      if (was === undefined) delete process.env.PYTHON_BIN;
      else process.env.PYTHON_BIN = was;
    }
  });
});
