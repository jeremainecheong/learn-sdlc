import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ContentService } from '../content/content.service';
import type { ProjectContent } from '../content/content.types';
import { compilePack, soleTaskFor } from '../content/pack-compiler';
import { DirectoryPackSource } from '../content/pack-source';
import { FIXTURES_DIR, uploadPack } from '../../test/fixtures/paths';
import {
  canonicalVerdict,
  fixedState,
  graderFor,
  recordVerdicts,
  serialiseVerdictFixture,
  type VerdictDigestManifest,
} from '../../test/verdict-golden';

/**
 * The verdict net answers the slug it grades.
 *
 * The recorder's enrolment double is what the conformance ledger asks for the
 * design phase. If it answered `tasktrackr` for every pack, an uploaded
 * project's implementation and maintenance ledger lookups would fail with
 * "unknown project: tasktrackr" (logged and swallowed) and the CLI refuses
 * to write a golden over a logged error. These cases hold the lookup to the
 * graded slug with nothing logged, the `shelf` fixture's grade deterministic
 * and priced, and TaskTrackr's net byte-identical beside it (the guard). They
 * also declare what the slug does NOT change: `shelf`'s design scaffold
 * carries no structured contract, so its reports have no ledger either way
 * and its golden bytes are the same under either slug.
 */

/** The `shelf` fixture (the Shelf pack), loaded the way `verdict-digests.ts --pack-dir` loads it. */
const SHELF_DIR = uploadPack('shelf');

function loadShelf(): { content: ContentService; project: ProjectContent; budgets: Record<string, number> } {
  const content = new ContentService();
  const project = content.loadProject(new DirectoryPackSource(path.resolve(SHELF_DIR)));
  content.installVersions([{ versionId: `${project.slug}@${project.version}`, content: project }]);
  return { content, project, budgets: compilePack(project).sandboxBudgetByPhase };
}

/** Run `work` with the app logger's error level counted and silenced. */
async function counted<T>(work: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(String(args[0]));
  });
  const quiet = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  try {
    return { result: await work(), errors };
  } finally {
    spy.mockRestore();
    quiet.mockRestore();
  }
}

/**
 * One phase's report, graded the way `recordVerdicts` grades it, through a
 * grader whose enrolment double answers `graderSlug`: `undefined` is the
 * default ('tasktrackr').
 */
async function reportFor(content: ContentService, slug: string, phaseKey: string, graderSlug?: string) {
  const phase = content.getProject(slug).phases.find((p) => p.key === phaseKey)!;
  const { service } = graderSlug === undefined ? graderFor(content) : graderFor(content, graderSlug);
  const tasks = [soleTaskFor(phase)];
  return service.buildReport(phase, fixedState(phase, phase.order) as never, tasks, tasks[0]);
}

describe('the verdict net answers the graded slug', () => {
  it('loads the Shelf pack from apps/api/test/fixtures/upload-packs/shelf (the directory the --pack-dir write names)', () => {
    expect(path.relative(path.join(__dirname, '..', '..', '..', '..'), SHELF_DIR)).toBe(
      path.join('apps', 'api', 'test', 'fixtures', 'upload-packs', 'shelf'),
    );
    const { project } = loadShelf();
    expect([project.slug, project.version]).toEqual(['shelf', '1.0.0']);
  });

  it("recordVerdicts over the Shelf pack logs no error, and implementation's and maintenance's ledger lookups ask for shelf's design", async () => {
    const { content, budgets } = loadShelf();
    // The conformance ledger resolves the design phase through the enrolment;
    // every resolution the grade makes is recorded by the slug it asked for.
    const asked: Array<[string, string]> = [];
    const original = content.getPhaseForEnrollment.bind(content);
    jest
      .spyOn(content, 'getPhaseForEnrollment')
      .mockImplementation((enrollment: Parameters<ContentService['getPhaseForEnrollment']>[0], key: string) => {
        asked.push([enrollment.projectSlug, key]);
        return original(enrollment, key);
      });

    const { errors } = await counted(() => recordVerdicts(content, 'shelf', budgets));

    expect(errors).toEqual([]);
    // Both report-section phases reached the ledger, and asked for shelf's design.
    expect(asked.filter(([, key]) => key === 'design')).toEqual([
      ['shelf', 'design'],
      ['shelf', 'design'],
    ]);
    expect(asked.every(([slug]) => slug === 'shelf')).toBe(true);
  });

  it("DECLARED: the Shelf pack's implementation and maintenance reports carry no contract or impact under the scaffold workspace", async () => {
    // The slug decides the lookup, not a section: `shelf`'s design scaffold is
    // a record with no operation, so buildContractLedger finds none to
    // hold the code against, and shelf's ledger is empty under either slug.
    // TaskTrackr's design ships a structured contract, and its two
    // phases do carry one, so this probe can see a ledger where there is one.
    //
    // So the shelf golden is the same bytes under either slug: the default
    // arm (the enrolment double answering 'tasktrackr')
    // logs the two lost sections and still records the same canonical
    // verdicts. The regression guards for the lookup are the no-error and
    // asked-slug assertions above and the CLI's refuse-on-logged-error.
    const { content } = loadShelf();
    const { result: fixedArm, errors: fixedErrors } = await counted(async () => ({
      implementation: await reportFor(content, 'shelf', 'implementation', 'shelf'),
      maintenance: await reportFor(content, 'shelf', 'maintenance', 'shelf'),
    }));
    expect(fixedErrors).toEqual([]);
    for (const report of [fixedArm.implementation, fixedArm.maintenance]) {
      expect([report.contract, report.impact]).toEqual([undefined, undefined]);
    }

    const { result: preFixArm, errors: preFixErrors } = await counted(async () => ({
      implementation: await reportFor(content, 'shelf', 'implementation'),
      maintenance: await reportFor(content, 'shelf', 'maintenance'),
    }));
    expect(preFixErrors).toHaveLength(2);
    expect(preFixErrors.every((line) => line.includes('unknown project: tasktrackr'))).toBe(true);
    expect(canonicalVerdict(preFixArm.implementation)).toEqual(canonicalVerdict(fixedArm.implementation));
    expect(canonicalVerdict(preFixArm.maintenance)).toEqual(canonicalVerdict(fixedArm.maintenance));

    // The contrast: the same probe over TaskTrackr finds a ledger in both phases.
    const shipped = new ContentService();
    shipped.loadAll();
    const { result: tasktrackr } = await counted(async () => ({
      implementation: await reportFor(shipped, 'tasktrackr', 'implementation', 'tasktrackr'),
      maintenance: await reportFor(shipped, 'tasktrackr', 'maintenance', 'tasktrackr'),
    }));
    expect(tasktrackr.implementation.contract?.length ?? 0).toBeGreaterThan(0);
    expect(tasktrackr.maintenance.contract?.length ?? 0).toBeGreaterThan(0);
  });

  it('recordVerdicts over the Shelf pack is deterministic: two runs serialise byte-identically', async () => {
    const first = await counted(async () => {
      const { content, budgets } = loadShelf();
      return serialiseVerdictFixture(await recordVerdicts(content, 'shelf', budgets));
    });
    const second = await counted(async () => {
      const { content, budgets } = loadShelf();
      return serialiseVerdictFixture(await recordVerdicts(content, 'shelf', budgets));
    });
    expect([first.errors, second.errors]).toEqual([[], []]);
    expect(second.result).toBe(first.result);
  });

  it("the Shelf pack's job sequence equals its budget, in the order the phases price it", async () => {
    const { content, project, budgets } = loadShelf();
    const { result: manifest, errors } = await counted<VerdictDigestManifest>(() =>
      recordVerdicts(content, 'shelf', budgets),
    );
    expect(errors).toEqual([]);
    expect(budgets).toEqual({
      requirements: 0,
      design: 0,
      implementation: 4,
      testing: 6,
      deployment: 2,
      maintenance: 4,
    });
    const counts = Object.fromEntries(project.phases.map((p) => [p.key, manifest.phases[p.key].jobs.length]));
    expect(counts).toEqual(budgets);
    for (const phase of project.phases) {
      expect([phase.key, manifest.phases[phase.key].sandboxBudget]).toEqual([phase.key, budgets[phase.key]]);
    }

    const runs = (key: string) => manifest.phases[key].jobs.map((job) => [job.kind, job.runId]);
    // implementation and maintenance: the visible runs, then the hidden runs, api before web.
    expect(runs('implementation').map(([, runId]) => runId)).toEqual(['api', 'web', 'api', 'web']);
    expect(runs('maintenance').map(([, runId]) => runId)).toEqual(['api', 'web', 'api', 'web']);
    // testing: two reference runs (api, web), then four mutants (three api, one web),
    // each graded against the sealed implementation written outside the workspace.
    expect(runs('testing')).toEqual([
      ['tests', 'api'],
      ['tests', 'web'],
      ['tests', 'api'],
      ['tests', 'web'],
      ['tests', 'api'],
      ['tests', 'api'],
    ]);
    expect(manifest.phases.testing.jobs.every((job) => job.gradedPaths.length > 0)).toBe(true);
    // deployment: the smoke, then the drill's smoke against the faulted copy.
    expect(manifest.phases.deployment.jobs.map((job) => job.kind)).toEqual(['smoke', 'smoke']);
    expect(manifest.phases.deployment.jobs.map((job) => job.smokeCommands)).toEqual([
      [['python3', 'api/main.py', '--selfcheck']],
      [['python3', 'api/main.py', '--selfcheck']],
    ]);
  });

  it('GUARD: recordVerdicts(content, "tasktrackr", budgets) serialises byte-identically to the committed fixture', async () => {
    const content = new ContentService();
    content.loadAll();
    const { sandboxBudgetByPhase } = compilePack(content.getProject('tasktrackr'));
    const { result } = await counted(async () =>
      serialiseVerdictFixture(await recordVerdicts(content, 'tasktrackr', sandboxBudgetByPhase)),
    );
    expect(result).toBe(fs.readFileSync(path.join(FIXTURES_DIR, 'tasktrackr-verdict-digests.json'), 'utf-8'));
  });
});
