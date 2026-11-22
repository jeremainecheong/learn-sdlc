import * as fs from 'fs';
import * as path from 'path';
import { ContentService } from '../content/content.service';
import { compilePack } from '../content/pack-compiler';
import {
  firstDifferingCheck,
  readVerdictFixture,
  recordVerdicts,
  verdictFixturePathFor,
} from '../../test/verdict-golden';

/**
 * The verdict-golden net: TaskTrackr's grader, held against what it produced
 * before the task grain existed.
 *
 * The task grain threads a task through the builders, the rubric they read and
 * the gate they hand their report to. On a phase whose compiled list is the
 * synthesised sole task every one of those new expressions is the identity:
 * the sole task's checks *are* the phase's, its units *are* the phase's, its
 * rubric *is* the phase's, so the shipped project's verdicts must not move by
 * one byte, and this is the file that says so in one command.
 *
 * It is recorded against the **unmodified** grader. Regenerating it is
 * therefore a deliberate act with a reason: the pack's content genuinely
 * changed and its version was bumped, and it is never the fix for a failing
 * step.
 */
describe('the verdict-golden net', () => {
  const content = new ContentService();
  content.loadAll();
  const project = content.getProject('tasktrackr');
  const { sandboxBudgetByPhase } = compilePack(project);
  const recorded = readVerdictFixture('tasktrackr');

  // A golden net is only a net if the module it runs is the module a step
  // edits. `tsconfig.build.json` compiles with `rootDir: src`, so a source under
  // `src/` that imports this recorder from `test/` makes `npm run build -w
  // @learnsdlc/api` compute its output path as `dist/../test/verdict-golden.js`
  // and drop a compiled twin beside its own source, which is why recording CLIs
  // live under `test/cli/` (`build-boundary.spec.ts`). Which of the two an
  // extensionless import gets is decided by Jest's `moduleFileExtensions`,
  // and Jest's default puts `js` ahead of `ts`, so a machine that had once
  // run the build would hold the grader against a build
  // artefact and read a later edit to the recorder as no edit at all. Both
  // halves are pinned here: nothing compiled is left in `test/`, and `ts` wins
  // the race if something ever is.
  it('runs the TypeScript recorder, not a compiled twin left beside it', () => {
    const resolved = require.resolve('../../test/verdict-golden');
    expect(path.extname(resolved)).toBe('.ts');

    const testDir = path.dirname(resolved);
    const twins = fs
      .readdirSync(testDir)
      .filter((name) => name.endsWith('.js'))
      .filter((name) => fs.existsSync(path.join(testDir, `${name.slice(0, -'.js'.length)}.ts`)));
    expect(twins).toEqual([]);

    // `setup-env.js` is hand-written and named with its extension in
    // `setupFiles`, so it is not a twin and is not what this forbids.
    const { moduleFileExtensions } = require('../../jest.config.js');
    expect(moduleFileExtensions.indexOf('ts')).toBeLessThan(moduleFileExtensions.indexOf('js'));
  });

  it('has a committed fixture to be held against', () => {
    // Without it every assertion below would pass by having nothing to compare,
    // which is the one failure a golden net cannot afford.
    expect(recorded).not.toBeNull();
    expect(recorded!.slug).toBe('tasktrackr');
    expect(recorded!.version).toBe(project.version);
    expect(Object.keys(recorded!.phases).sort()).toEqual(
      project.phases.map((phase) => phase.key).sort(),
    );
  });

  it("every phase's report matches its recorded digest", async () => {
    const fresh = await recordVerdicts(content, 'tasktrackr', sandboxBudgetByPhase);
    for (const phase of project.phases) {
      const was = recorded!.phases[phase.key];
      const now = fresh.phases[phase.key];
      const moved = firstDifferingCheck(was.checks, now.checks);
      // The digest is the assertion; the check id is the sentence it fails
      // with, so a reader is told which phase and which check rather than that
      // two hex strings differ.
      expect([phase.key, now.report, moved]).toEqual([phase.key, was.report, null]);
    }
  });

  it('every phase runs the microVMs it is priced for, in order', async () => {
    const fresh = await recordVerdicts(content, 'tasktrackr', sandboxBudgetByPhase);
    for (const phase of project.phases) {
      const was = recorded!.phases[phase.key];
      const now = fresh.phases[phase.key];
      // Element for element, in the order the grader asked for them: the kind,
      // the run id, the harness, the test paths, the smoke argv and the paths
      // of everything mounted or written outside the workspace.
      expect([phase.key, now.jobs]).toEqual([phase.key, was.jobs]);
      // And the count is what the compiler priced the phase at: the number an
      // importer reports and a readiness surface prints.
      expect([phase.key, now.jobs.length]).toEqual([phase.key, sandboxBudgetByPhase[phase.key]]);
      expect(was.sandboxBudget).toBe(sandboxBudgetByPhase[phase.key]);
    }
    // The pack's whole pass, as `pack-compiler.spec.ts` prices it.
    expect(project.phases.reduce((sum, phase) => sum + sandboxBudgetByPhase[phase.key], 0)).toBe(20);
  });

  it('records the fixture the CLI writes, at the path the CLI writes it to', () => {
    expect(verdictFixturePathFor('tasktrackr')).toMatch(
      /apps\/api\/test\/fixtures\/tasktrackr-verdict-digests\.json$/,
    );
  });
});
