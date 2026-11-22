import 'reflect-metadata';
import type { ProjectFileRole } from '@learnsdlc/shared';
import {
  contentDigestManifest,
  describeDifference,
  digestDifferences,
  digestOf,
  projectHeaderOf,
  readGoldenDigests,
  sealedGroupOf,
  sealedPathsOf,
  sealedRoleFacts,
} from '../../test/content-golden';
import { ContentService } from './content.service';
import type { ProjectContent } from './content.types';

/**
 * The roles a phase's own `checks` can seal, and therefore the only keys its
 * sealed map may hold. `workspace`, `canonical`, `warmup` and `interview` are
 * roles a `project_files` row carries and a phase's checks never declare.
 */
const PHASE_SEALED_ROLES: ProjectFileRole[] = [
  'hidden',
  'solution',
  'reference',
  'support',
  'mutant',
  'drill',
];

/**
 * The golden-equivalence net.
 *
 * A project is served out of Postgres rather than out of the image, and the
 * promise is that no learner can tell: TaskTrackr must load, run, grade,
 * preview and export exactly as the on-disk pack says. This spec is that
 * promise written down as arithmetic. It records what **the on-disk loader**
 * produces, one sha256 per phase per field group, so that the compiler, the
 * compiled snapshot and the registry that reads it can each be held against the
 * same numbers by `import-identity.spec.ts`, and a storage path that lost a
 * rubric criterion, reordered the explorer, dropped a mutant or promoted a
 * hidden test into `files[]` fails by naming the phase and the group.
 *
 * It is a regression guard: if it goes red without `content/` having changed
 * and its version bumped, the storage path is wrong. Regenerating the fixture
 * is never the fix for that.
 */
describe("the loader's output, recorded (golden equivalence)", () => {
  let content: ContentService;
  let projects: ProjectContent[];

  beforeAll(() => {
    content = new ContentService();
    content.loadAll();
    projects = content.listProjects();
  });

  it("the shipped pack's every phase matches its recorded digests", () => {
    for (const project of projects) {
      const recorded = readGoldenDigests(project.slug);
      expect(recorded.version).toBe(project.version);
      // every phase the pack ships is recorded, and nothing else is
      expect(Object.keys(recorded.phases).sort()).toEqual(
        project.phases.map((p) => p.key).sort(),
      );
      const moved = digestDifferences(project, recorded);
      expect(moved.map(describeDifference)).toEqual([]);
    }
  });

  it('the project header matches its recorded digest', () => {
    for (const project of projects) {
      const recorded = readGoldenDigests(project.slug);
      expect({ slug: project.slug, header: digestOf(projectHeaderOf(project)) }).toEqual({
        slug: recorded.slug,
        header: recorded.project,
      });
    }
  });

  /**
   * The fourth isolation seal, restated as a fact about paths so that the swap
   * cannot quietly move a sealed file into `files[]`.
   *
   * It is deliberately not "the sealed paths are disjoint from the workspace",
   * which is false of the platform's own content and would have to be weakened
   * the first time it was run: a `solution` file sits at the very path the
   * learner edits, a `support` helper has to be a locked file they can read
   * because they are told to import it, and a `mutant` lands on the locked
   * implementation the reference suite exercises. The seal is per role, and
   * each role's statement is the one its own safety rests on.
   */
  it('every sealed byte is accounted for', () => {
    for (const project of projects) {
      for (const phase of project.phases) {
        const where = `${project.slug}/${phase.key}`;

        // hidden: the suite that grades the learner is mounted nowhere
        expect({ where, mounted: sealedRoleFacts(phase, 'hidden').mounted }).toEqual({
          where,
          mounted: [],
        });

        // mutant: a planted bug may sit on the locked implementation it grades,
        // but never on a file the learner edits: their own copy would
        // overwrite it and the mutant would be unkillable for no stated reason
        expect({ where, editable: sealedRoleFacts(phase, 'mutant').mountedEditable }).toEqual({
          where,
          editable: [],
        });

        // solution: the pack's answer is at the paths the learner edits, all of
        // them, which is what makes overlaying it and running the hidden suite
        // a proof that the two still agree
        const solution = sealedRoleFacts(phase, 'solution');
        expect({ where, unaccounted: solution.unmounted }).toEqual({ where, unaccounted: [] });
        expect({ where, notEditable: solution.paths.filter((at) => !solution.mountedEditable.includes(at)) }).toEqual({
          where,
          notEditable: [],
        });

        // support: a helper the learner's suite imports is a locked file in the
        // explorer, because a module they cannot see is one they cannot be told
        // to import
        const support = sealedRoleFacts(phase, 'support');
        expect({ where, unaccounted: support.unmounted }).toEqual({ where, unaccounted: [] });
        expect({ where, editable: support.mountedEditable }).toEqual({ where, editable: [] });

        // reference: the pack's own suite and the implementation it grades.
        // Only the learner's own test paths are editable among them: a
        // reference file at any other editable path would be an answer handed
        // to the work it answers
        const reference = sealedRoleFacts(phase, 'reference');
        const learnerTests = phase.checks.kind === 'tests' ? phase.checks.learnerTestFiles : [];
        expect({ where, editable: reference.mountedEditable.slice().sort() }).toEqual({
          where,
          editable: learnerTests.slice().sort(),
        });

        // drill: the faulted copy is overlaid on files the phase declares, so
        // the smoke check it is expected to fail is the learner's own
        expect({ where, unaccounted: sealedRoleFacts(phase, 'drill').unmounted }).toEqual({
          where,
          unaccounted: [],
        });

        // and the sealed map holds only roles a phase's own `checks` declare.
        // The other four are properties of a *row* and not of a phase: a
        // `workspace` or `canonical` entry appearing here would be decision
        // 37's mistake made in the one place that would make it invisible,
        // since the byte rules are then asked of a set that already calls the
        // answer material sealed.
        const held = Object.keys(sealedPathsOf(phase)) as ProjectFileRole[];
        expect({ where, held: held.filter((role) => !PHASE_SEALED_ROLES.includes(role)) }).toEqual({
          where,
          held: [],
        });
      }
    }
  });

  /**
   * The interview is sealed, and it is sealed as a **document**.
   *
   * It is the one piece of answer material a phase carries that is not a file:
   * no path, so no `project_files` row, so none of the path facts above can say
   * anything about it, which is why asserting `sealedPathsFor(phase,
   * 'interview')` is empty says nothing at all. What has to be true is that the
   * customer's answers are covered by the phase's `sealed` digest, so the swap
   * cannot drop them, and that none of them is in a file the learner can open.
   */
  it('the interview is sealed as a document, not as a path', () => {
    let interviewed = 0;
    for (const project of projects) {
      for (const phase of project.phases) {
        const interview = phase.interview;
        if (!interview) continue;
        interviewed += 1;
        const where = `${project.slug}/${phase.key}`;

        // covered by the digest the net records, so a lost brief fails by name
        expect(sealedGroupOf(phase).interview).toBe(interview);
        expect(interview.facts.length).toBeGreaterThan(0);

        // and no answer the customer has not said out loud is in the workspace
        const answers = interview.facts.map((fact) => fact.answer.trim()).filter((at) => at.length > 20);
        expect({ where, answers: answers.length }).toEqual({ where, answers: interview.facts.length });
        const leaked = phase.files
          .filter((file) => answers.some((answer) => file.content.includes(answer)))
          .map((file) => file.path);
        expect({ where, leaked }).toEqual({ where, leaked: [] });
      }
    }
    // the assertion is about the shipped pack, so it has to have been reached:
    // the requirements phase carries an interview
    expect(interviewed).toBeGreaterThan(0);
  });

  /**
   * The manifest is a function of the content and of nothing else, not of the
   * order the loader happened to build its objects in. Without this the net
   * could pass on one machine and fail on the next for no reason a reader could
   * name.
   */
  it('the same content digests the same twice', () => {
    const again = new ContentService();
    again.loadAll();
    for (const project of projects) {
      const other = again.getProject(project.slug);
      expect(contentDigestManifest(other)).toEqual(contentDigestManifest(project));
    }
  });
});
