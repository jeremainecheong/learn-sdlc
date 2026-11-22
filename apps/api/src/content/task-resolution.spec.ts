import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EXECUTABLE_SPLIT_NOT_READY, INHERITED_TASK_KEY } from '@learnsdlc/shared';
import { config } from '../config';
import { SeedService } from '../seed/seed.service';
import { ContentService } from './content.service';
import type { PhaseContent, ProjectContent } from './content.types';
import { ProjectImporterService } from './importer.service';
import {
  COMPILER_IDENTITY,
  compilePack,
  editablePathsOf,
  gradedUnitsOf,
  soleTaskFor,
  type AuthoredTask,
  type CompiledPhaseTasks,
  type CompiledTask,
} from './pack-compiler';
import { ProjectRegistryService } from './project-registry.service';
import { soleTaskList } from './task-units';
import { fixtureQuizChecks } from '../../test/quiz-fixture';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The seam the compiled tasks reach the runtime through.
 *
 * `compilePack` produces a task list per phase, and the registry carries it to
 * `ContentService` with the version's content. Every question the task grain
 * asks (which keys gate this phase, which task
 * is this submission about, which rules does it own) is a question about that
 * list, so the first thing to settle is that the list a learner is served is
 * the one the version they hold was published with.
 *
 * Two properties are what the seam is for, and each has its own test
 * below.
 *
 * **One resolution.** `getForEnrollment` and `getTasksForEnrollment` share a
 * single `resolveForEnrollment`, so a phase and its task list can never come
 * from two different versions. An accessor that looked the tasks up on its own
 * would, on either of the two documented pin faults, answer the *pinned*
 * version's nothing and fall back to a sole task synthesised over the *head's*
 * phase: a head declaring three required tasks resolving to the one required
 * key `''`, the phase opening on a single verdict and the answer door behind
 * it.
 *
 * **A snapshot this build cannot grade is refused.** A published version is
 * immutable and `installVersions` installs a foreign one verbatim, recording a
 * compiler mismatch as a warning; the split-phase rules are not reflected in
 * the compiler identity, so there is no drift signal either. A two-task `code` phase compiled by a
 * later build and arriving through a rolling upgrade, a revert or a restore
 * would otherwise be served, and `buildCodeReport` would grade both tasks
 * against the whole phase's suite. Nothing this build can produce takes that
 * shape; these two tests are the statement that says so.
 */

const SHIPPED = 'tasktrackr';
const ANY_PIN = { projectSlug: SHIPPED, projectVersionId: null };

/** A `SeedService` that has imported what it is told it has. */
const seedThatImported = (results: unknown[] | null): SeedService =>
  ({ importedContent: results }) as unknown as SeedService;

const freshDatabase = async (): Promise<DataSource> =>
  memoryDataSource();

/**
 * A hand-built compiled task, over the phase's own sole task.
 *
 * Hand-built rather than compiled on purpose: the compile rules that decide
 * which split lists are legal live in the pack compiler, and a fixture that went through
 * `compilePack` would be a fixture about those rules. What is under test here
 * is what the runtime does with a list it has been handed.
 */
const taskLike = (phase: PhaseContent, over: Partial<CompiledTask>): CompiledTask => ({
  ...soleTaskFor(phase),
  ...over,
});

/** One authored task per phase, keyed `main`: what a copied project compiles to. */
const inheritedTasks = (project: ProjectContent): Record<string, AuthoredTask[]> =>
  Object.fromEntries(
    project.phases.map((phase) => [
      phase.key,
      [
        {
          taskKey: INHERITED_TASK_KEY,
          order: 1,
          owns: editablePathsOf(phase),
          gradedUnits: gradedUnitsOf(phase),
        },
      ],
    ]),
  );

describe('the compiled tasks reach the runtime', () => {
  let db: DataSource;
  let registered: ContentService;
  let onDisk: ProjectContent;
  let pin = '';

  beforeAll(async () => {
    db = await freshDatabase();
    const loader = new ContentService();
    loader.loadAll();
    onDisk = loader.getProject(SHIPPED);
    await new ProjectImporterService(loader, db).importContentDirectory(config.contentDir, {
      origin: 'seed',
      platformOwned: true,
    });
    registered = new ContentService();
    await new ProjectRegistryService(registered, db, seedThatImported([])).load();
    pin = registered.headVersionIdFor(SHIPPED) as string;
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('the compiled tasks survive the round trip', () => {
    // The tell is the same one `registry-boot.spec.ts` uses: a
    // `project_versions.id` exists nowhere on disk, so an answer keyed on one
    // came out of the table.
    expect(pin).toEqual(expect.any(String));
    for (const phase of onDisk.phases) {
      expect(
        registered.getTasksForEnrollment({ projectSlug: SHIPPED, projectVersionId: pin }, phase.key),
      ).toEqual([soleTaskFor(phase)]);
    }
  });

  it('both arms are the same task', () => {
    // TaskTrackr equivalence: `soleTaskFor` is the function that produced the
    // stored list, so a deployment that holds the snapshot and one that has
    // only walked the directory answer the same task for every phase.
    const unregistered = new ContentService();
    unregistered.loadAll();
    for (const phase of onDisk.phases) {
      expect(
        registered.getTasksForEnrollment({ projectSlug: SHIPPED, projectVersionId: pin }, phase.key),
      ).toEqual(unregistered.getTasksForEnrollment(ANY_PIN, phase.key));
    }
  });

  it('a deployment storing no tasks for a version falls back to the sole task', () => {
    const walked = new ContentService();
    walked.loadAll();
    for (const phase of walked.getProject(SHIPPED).phases) {
      expect(walked.getTasksForEnrollment(ANY_PIN, phase.key)).toEqual([soleTaskFor(phase)]);
    }
    // and there is no second accessor that could answer a different list:
    // the head's compiled tasks have no accessor of their own, so no reader
    // can compose the head's keys with a pinned board by reaching for one.
    expect((walked as unknown as Record<string, unknown>).getTasks).toBeUndefined();
  });

  it("a key the pinned version does not declare keeps getPhase's own 404", () => {
    expect(() =>
      registered.getTasksForEnrollment(
        { projectSlug: SHIPPED, projectVersionId: pin },
        'nosuchphase',
      ),
    ).toThrow(/unknown phase: nosuchphase/);
  });
});

describe('one resolution answers the phase and its tasks', () => {
  let content: ContentService;
  let head: ProjectContent;
  let pinned: ProjectContent;
  let headTasks: CompiledPhaseTasks[];
  let pinnedTasks: CompiledPhaseTasks[];

  beforeAll(() => {
    const loader = new ContentService();
    loader.loadAll();
    const loaded = loader.getProject(SHIPPED);

    // The head: one phase retitled, and its requirements phase split three
    // ways. The superseded version: the same phase retitled differently, one
    // task.
    head = {
      ...loaded,
      version: '2.0.0',
      phases: loaded.phases.map((phase, at) =>
        at === 0 ? { ...phase, title: 'Requirements (head)' } : phase,
      ),
    };
    pinned = {
      ...loaded,
      version: '1.0.0',
      phases: loaded.phases.map((phase, at) =>
        at === 0 ? { ...phase, title: 'Requirements (1.0.0)' } : phase,
      ),
    };
    const headRequirements = head.phases[0];
    headTasks = head.phases.map((phase) =>
      phase.key === 'requirements'
        ? {
            key: phase.key,
            tasks: [
              taskLike(headRequirements, { taskKey: 'story', order: 1 }),
              taskLike(headRequirements, { taskKey: 'criteria', order: 2 }),
              taskLike(headRequirements, { taskKey: 'scope', order: 3, required: false }),
            ],
          }
        : { key: phase.key, tasks: [soleTaskFor(phase)] },
    );
    pinnedTasks = pinned.phases.map((phase) => ({ key: phase.key, tasks: [soleTaskFor(phase)] }));

    content = new ContentService();
    content.installVersions([
      { versionId: 'version-2', content: head, compiler: COMPILER_IDENTITY, phases: headTasks },
      { versionId: 'version-1', content: pinned, compiler: COMPILER_IDENTITY, phases: pinnedTasks },
    ]);
  });

  it('the phase and its task list come from one resolution', () => {
    const at = { projectSlug: SHIPPED, projectVersionId: 'version-1' };
    const phase = content.getPhaseForEnrollment(at, 'requirements');
    const tasks = content.getTasksForEnrollment(at, 'requirements');
    expect(phase.title).toBe('Requirements (1.0.0)');
    expect(tasks).toHaveLength(1);
    // The head declares three tasks on this key and the pinned version one, so
    // a task list resolved independently of the phase would answer the head's
    // three over a phase titled for 1.0.0.
    expect(tasks[0].title).toBe(phase.title);
    // The head, read through the same one accessor with the null pin that
    // resolves it: three keys where the pin answers one, so the property above
    // is under test rather than true of a fixture that declares the same list
    // twice.
    const atHead = { projectSlug: SHIPPED, projectVersionId: null };
    expect(content.getTasksForEnrollment(atHead, 'requirements').map((one) => one.taskKey)).toEqual([
      'story',
      'criteria',
      'scope',
    ]);
  });

  it("a pin this deployment holds no row for reads the head's task list, not a synthesised one", () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const at = { projectSlug: SHIPPED, projectVersionId: 'no-such-version' };
      expect(content.getForEnrollment(at).version).toBe('2.0.0');
      expect(content.getTasksForEnrollment(at, 'requirements').map((task) => task.taskKey)).toEqual([
        'story',
        'criteria',
        'scope',
      ]);
      // the same warning the pin fault already emitted, and one line for the
      // pin rather than one per accessor
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no-such-version'));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a pin belonging to another slug reads this slug's head", () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const crossed = new ContentService();
      crossed.installVersions([
        { versionId: 'version-2', content: head, compiler: COMPILER_IDENTITY, phases: headTasks },
        {
          versionId: 'other-1',
          content: { ...head, slug: 'otherpack', version: '3.0.0' },
          compiler: COMPILER_IDENTITY,
          phases: pinnedTasks,
        },
      ]);
      const at = { projectSlug: SHIPPED, projectVersionId: 'other-1' };
      expect(crossed.getForEnrollment(at).slug).toBe(SHIPPED);
      expect(crossed.getTasksForEnrollment(at, 'requirements').map((task) => task.taskKey)).toEqual([
        'story',
        'criteria',
        'scope',
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('otherpack'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a copied project compiles every phase to its inherited task', () => {
  it("a teacher project's phases resolve their authored key", () => {
    const loader = new ContentService();
    loader.loadAll();
    const loaded = loader.getProject(SHIPPED);
    const copy: ProjectContent = { ...loaded, slug: 'ms-tan-tasktrackr', version: '1.0.0' };
    // Exactly what `AuthoringService`'s publish compiles: a copied project
    // materialises each phase's inherited sole task as a real authored row.
    const snapshot = compilePack(copy, { authored: inheritedTasks(copy) });

    const content = new ContentService();
    content.installVersions([
      {
        versionId: 'copy-1',
        content: copy,
        compiler: COMPILER_IDENTITY,
        phases: snapshot.phases,
      },
    ]);

    const at = { projectSlug: copy.slug, projectVersionId: 'copy-1' };
    for (const phase of copy.phases) {
      const tasks = content.getTasksForEnrollment(at, phase.key);
      expect(tasks.map((task) => task.taskKey)).toEqual([INHERITED_TASK_KEY]);
      // A one-task list keyed `main` is **not** the synthesised sole task, so
      // the per-task machinery applies to every phase of every teacher-authored
      // project, of every check kind.
      expect({ key: phase.key, sole: soleTaskList(tasks) }).toEqual({
        key: phase.key,
        sole: false,
      });
    }
  });
});

describe('a snapshot this build cannot grade is refused', () => {
  let head: ProjectContent;
  let flat: CompiledPhaseTasks[];

  beforeAll(() => {
    const loader = new ContentService();
    loader.loadAll();
    head = loader.getProject(SHIPPED);
    flat = head.phases.map((phase) => ({ key: phase.key, tasks: [soleTaskFor(phase)] }));
  });

  const splitAt = (key: string): CompiledPhaseTasks[] => {
    const phase = head.phases.find((one) => one.key === key) as PhaseContent;
    return flat.map((entry) =>
      entry.key === key
        ? {
            key: entry.key,
            tasks: [
              taskLike(phase, { taskKey: 'one', order: 1 }),
              taskLike(phase, { taskKey: 'two', order: 2 }),
            ],
          }
        : entry,
    );
  };

  it('a stored two-task executable phase is refused at the seam and named at install', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const content = new ContentService();
    try {
      content.installVersions([
        {
          versionId: 'v-split-code',
          content: head,
          compiler: COMPILER_IDENTITY,
          phases: splitAt('implementation'),
        },
      ]);
      expect(content.unservableVersions()).toEqual([
        {
          versionId: 'v-split-code',
          slug: SHIPPED,
          version: head.version,
          phaseKey: 'implementation',
          tasks: 2,
        },
      ]);
      // An operator sees it at boot rather than when a learner hits it, and the
      // line carries the slug, the version, the phase key and the count.
      const said = warn.mock.calls.map((call) => String(call[0])).join(' ');
      expect(said).toContain(SHIPPED);
      expect(said).toContain(head.version);
      expect(said).toContain('implementation');
      expect(said).toContain(EXECUTABLE_SPLIT_NOT_READY);
    } finally {
      warn.mockRestore();
    }

    // and the seam reads shut for every phase of that version, not only the
    // split one: without this, `buildCodeReport` grades both tasks against the
    // whole phase's suite and `correctness_hidden` scores the sibling's work
    // into each task's `bestScore`.
    const at = { projectSlug: SHIPPED, projectVersionId: 'v-split-code' };
    expect(() => content.getForEnrollment(at)).toThrow(/implementation/);
    expect(() => content.getForEnrollment(at)).toThrow(new RegExp(EXECUTABLE_SPLIT_NOT_READY));
    expect(() => content.getPhaseForEnrollment(at, 'requirements')).toThrow(/implementation/);
    expect(() => content.getTasksForEnrollment(at, 'requirements')).toThrow(/implementation/);
    // the version is the head here, so the null pin resolves it and reads shut too
    expect(() => content.getForEnrollment(ANY_PIN)).toThrow(/implementation/);
  });

  it("a two-task written phase is servable, and that is the wall's whole scope", () => {
    const content = new ContentService();
    content.installVersions([
      {
        versionId: 'v-split-markdown',
        content: head,
        compiler: COMPILER_IDENTITY,
        phases: splitAt('requirements'),
      },
    ]);
    expect(content.unservableVersions()).toEqual([]);
    const at = { projectSlug: SHIPPED, projectVersionId: 'v-split-markdown' };
    expect(content.getForEnrollment(at).slug).toBe(SHIPPED);
    expect(content.getTasksForEnrollment(at, 'requirements').map((task) => task.taskKey)).toEqual([
      'one',
      'two',
    ]);
  });

  it("a version whose head is unservable does not take a pinned learner's door away", () => {
    const content = new ContentService();
    content.installVersions([
      {
        versionId: 'v-old',
        content: { ...head, version: '1.0.0' },
        compiler: COMPILER_IDENTITY,
        phases: flat,
      },
      {
        versionId: 'v-head',
        content: { ...head, version: '9.0.0' },
        compiler: COMPILER_IDENTITY,
        phases: splitAt('testing'),
      },
    ]);
    const at = { projectSlug: SHIPPED, projectVersionId: 'v-old' };
    // The refusal is about the version that resolved, not about the project:
    // a learner pinned to a snapshot this build can grade keeps their board.
    expect(content.getForEnrollment(at).version).toBe('1.0.0');
    expect(content.getTasksForEnrollment(at, 'testing')).toEqual([
      soleTaskFor(head.phases.find((one) => one.key === 'testing') as PhaseContent),
    ]);
    expect(() => content.getForEnrollment(ANY_PIN)).toThrow(/testing/);
  });
});

/**
 * A stored older written phase, as a store may hold it.
 *
 * Two published teacher versions hold a Requirements of two markdown tasks
 * and a quiz. An upload never publishes markdown checks, so no new version
 * takes that shape, but such rows may already be published with learners
 * pinned to them. This build serves them, under the two keys a structured
 * kind still keeps, and grades nothing through them.
 */
describe('a stored older written phase stays servable', () => {
  let head: ProjectContent;

  beforeAll(() => {
    const loader = new ContentService();
    loader.loadAll();
    head = loader.getProject(SHIPPED);
  });

  /** The 2.0.1 shape: `key` holds markdown checks and the tasks markdown, markdown, quiz. */
  const olderWrittenAt = (key: string): { content: ProjectContent; phases: CompiledPhaseTasks[] } => {
    const phases = head.phases.map((phase) =>
      phase.key === key
        ? ({
            ...phase,
            artifactKind: 'markdown',
            checks: { kind: 'markdown', targets: ['requirements/my-story.md'], rules: [] },
          } as unknown as PhaseContent)
        : phase,
    );
    const content: ProjectContent = { ...head, version: '2.0.1', phases };
    const quiz = fixtureQuizChecks();
    return {
      content,
      phases: phases.map((phase) => {
        if (phase.key !== key) return { key: phase.key, tasks: [soleTaskFor(phase)] };
        const written = (taskKey: string, order: number): CompiledTask => ({
          ...soleTaskFor(phase),
          taskKey,
          order,
          checkKind: 'markdown' as never,
          artefactType: 'document',
        });
        return {
          key: phase.key,
          tasks: [
            written('story', 1),
            written('criteria', 2),
            {
              ...soleTaskFor(phase),
              taskKey: 'concepts',
              order: 3,
              checkKind: 'quiz',
              artefactType: 'quiz',
              artefactPath: null,
              owns: [],
              gradedUnits: quiz.questions.map((one) => ({ kind: 'question' as const, id: one.id })),
              checks: quiz,
            },
          ],
        };
      }),
    };
  };

  it('a stored older Requirements of two written tasks and a quiz stays servable', () => {
    const { content, phases } = olderWrittenAt('requirements');
    const service = new ContentService();
    service.installVersions([
      { versionId: 'v-older-written', content, compiler: COMPILER_IDENTITY, phases },
    ]);
    expect(service.unservableVersions()).toEqual([]);
    expect(service.compilerDrift()).toEqual([]);
    const at = { projectSlug: SHIPPED, projectVersionId: 'v-older-written' };
    expect(service.getForEnrollment(at).version).toBe('2.0.1');
    expect(service.getTasksForEnrollment(at, 'requirements').map((task) => task.taskKey)).toEqual([
      'story',
      'criteria',
      'concepts',
    ]);
    expect(service.getPhaseForEnrollment(at, 'requirements').checks.kind).toBe('markdown');
  });

  it('the same shape under a retired key is still unservable', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { content, phases } = olderWrittenAt('deployment');
      const service = new ContentService();
      service.installVersions([
        { versionId: 'v-retired-written', content, compiler: COMPILER_IDENTITY, phases },
      ]);
      expect(service.unservableVersions()).toEqual([
        {
          versionId: 'v-retired-written',
          slug: SHIPPED,
          version: '2.0.1',
          phaseKey: 'deployment',
          tasks: 3,
        },
      ]);
      const at = { projectSlug: SHIPPED, projectVersionId: 'v-retired-written' };
      expect(() => service.getForEnrollment(at)).toThrow(/deployment/);
    } finally {
      warn.mockRestore();
    }
  });
});
