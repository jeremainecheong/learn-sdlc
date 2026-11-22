import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import {
  ARTEFACT_TYPES,
  DEFAULT_DESIGN_FLOOR,
  INHERITED_TASK_KEY,
  PHASE_ROOM_ARTEFACT_PATHS,
  isAuthorableTask,
} from '@learnsdlc/shared';
import type { ArtifactKind, PhaseKey } from '@learnsdlc/shared';
import { digestOf } from '../content/blob.store';
import type { PhaseContent } from '../content/content.types';
import { ProjectPhaseEntity } from '../content/project.entities';
import { soleTaskFor, type CompiledTask } from '../content/pack-compiler';
import {
  REFERENCE_SCOPE,
  authoredPhaseScope,
  authoredTaskScope,
  isMintedScope,
  isReferenceTaskAnchor,
  phaseReferenceAnchor,
  phaseRoomTaskKeyOf,
  phaseScopeOf,
  referenceAnchor,
  taskScopeOf,
} from './project-scope';
import { REFERENCE_ANCHORS } from './reference-anchors';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from '../../test/quiz-fixture';
import { recordReferenceAnchorRows } from '../../test/reference-anchor-table';
import {
  ROOM_DESIGN_EDIT,
  S1_TEACHER,
  copyTaskTrackr,
  draftSnapshot,
  openForkWorld,
  phaseOf,
  tasktrackrContent,
  tasktrackrPhase,
  tasktrackrTask,
  type Fork,
  type ForkWorld,
} from '../../test/tasktrackr-phase';

/**
 * Which content is TaskTrackr's.
 *
 * The rule under test: **every TaskTrackr fragment belongs to TaskTrackr's
 * task content, identified by its bytes.** A task key cannot tell (an
 * inherited task and a teacher's are both authored keys) and lineage would
 * keep TaskTrackr's rules on a brief a teacher rewrote, so the resolver hashes
 * what the task *is*, its brief, objectives, rubric, check slice, the paths
 * it owns and their baseline bytes, and asks a committed table.
 *
 * Three outcomes are pinned on real forks made by the authoring service: an
 * untouched copy keeps TaskTrackr's reviewer, an edited inherited task becomes
 * the teacher's, and a phase that holds a teacher's task beside TaskTrackr's is
 * the teacher's at phase grain while the inherited task keeps its own.
 */

const ALL_PHASES: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const WRITTEN: PhaseKey[] = ['requirements', 'design'];
/** The phases TaskTrackr's own task is the reference's in: every phase but Design, a design phase since 4.0.0, which is always its room task. */
const REFERENCE_PHASES: PhaseKey[] = ALL_PHASES.filter((key) => key !== 'design');

describe('the reference anchors of the shipped pack', () => {
  it.each(REFERENCE_PHASES)('resolves TaskTrackr %s to reference at task grain and at phase grain', (key) => {
    const phase = tasktrackrPhase(key);
    const task = soleTaskFor(phase);
    expect(taskScopeOf(phase, task, [task])).toBe(REFERENCE_SCOPE);
    expect(taskScopeOf(phase)).toBe(REFERENCE_SCOPE);
    expect(phaseScopeOf(phase, [task])).toBe(REFERENCE_SCOPE);
    expect(phaseScopeOf(phase)).toBe(REFERENCE_SCOPE);
    expect(phaseScopeOf(phase, [task], { lesson: true })).toBe(REFERENCE_SCOPE);
  });

  it('resolves TaskTrackr design to its room task on the authored arm, at task grain and at phase grain', () => {
    // a design phase never takes the reference scope: its review is the one neutral design scope
    const phase = tasktrackrPhase('design');
    const task = soleTaskFor(phase);
    const scope = taskScopeOf(phase, task, [task]);
    expect(scope.kind).toBe('authored');
    expect(scope.kind === 'authored' && scope.roomTask).toBe(true);
    const grain = phaseScopeOf(phase, [task]);
    expect(grain.kind === 'authored' && grain.roomTaskKey).toBe(task.taskKey);
  });

  it('is a function of the bytes, not of the object: a structural copy anchors the same', () => {
    for (const key of WRITTEN) {
      const phase = tasktrackrPhase(key);
      const clone = JSON.parse(JSON.stringify(phase)) as PhaseContent;
      expect(referenceAnchor(clone, soleTaskFor(clone))).toBe(referenceAnchor(phase, soleTaskFor(phase)));
      expect(phaseReferenceAnchor(clone, soleTaskFor(clone))).toBe(phaseReferenceAnchor(phase, soleTaskFor(phase)));
      // task grain and phase grain are different digests
      expect(phaseReferenceAnchor(phase, soleTaskFor(phase))).not.toBe(referenceAnchor(phase, soleTaskFor(phase)));
    }
  });

  // On Requirements, a reference phase: Design is a design phase since 4.0.0, always the authored arm
  it('moves the anchor on any one graded byte: brief, objective, rubric, rule, owned baseline, key', () => {
    const phase = tasktrackrPhase('requirements');
    const task = soleTaskFor(phase);
    const base = referenceAnchor(phase, task);
    const variants: Array<[string, PhaseContent, CompiledTask]> = [
      ['brief', phase, { ...task, brief: `${task.brief} ` }],
      ['objective', phase, { ...task, objectives: [...task.objectives, 'One more.'] }],
      ['rubric', phase, { ...task, rubric: { ...task.rubric, criteria: task.rubric.criteria.slice(1) } }],
      ['owns', phase, { ...task, owns: task.owns.slice(1) }],
      // a story phase's rules are its floor
      ['rule', { ...phase, checks: phase.checks.kind === 'story' ? { ...phase.checks, floor: { ...phase.checks.floor, minCriteria: phase.checks.floor.minCriteria + 1 } } : phase.checks }, task],
      ['baseline', { ...phase, files: phase.files.map((file) => (file.path === task.owns[0] ? { ...file, content: `${file.content}\n` } : file)) }, task],
      ['key', { ...phase, key: 'design' }, task],
    ];
    for (const [what, where, which] of variants) {
      expect([what, referenceAnchor(where, which)]).not.toEqual([what, base]);
    }
    // the mentor prompt is phase grain only
    const prompt = { ...phase, assistant: { ...phase.assistant, systemPrompt: `${phase.assistant.systemPrompt} ` } };
    expect(referenceAnchor(prompt, task)).toBe(base);
    expect(phaseReferenceAnchor(prompt, task)).not.toBe(phaseReferenceAnchor(phase, task));
    expect(phaseScopeOf(prompt, [task]).kind).toBe('authored');
    expect(taskScopeOf(prompt, task, [task])).toBe(REFERENCE_SCOPE);
  });
});

describe('the committed anchor table', () => {
  it('holds exactly what the pack on disk anchors to, for its own version (the drift check)', () => {
    const recorded = recordReferenceAnchorRows(tasktrackrContent());
    const project = tasktrackrContent().getProject('tasktrackr');
    const committed = REFERENCE_ANCHORS.filter((row) => row.pack === 'tasktrackr' && row.version === project.version);
    expect(committed).toEqual(recorded);
    // written phases only: an executable phase is anchored in the separate exec table, not here
    expect([...new Set(committed.map((row) => row.phaseKey))].sort()).toEqual(['design', 'requirements']);
    expect(committed.map((row) => row.grain).sort()).toEqual(['phase', 'phase', 'task', 'task']);
  });

  it('pins the 2.0.1 rows by digest, so a later pack can only append', () => {
    const rows = REFERENCE_ANCHORS.filter((row) => row.pack === 'tasktrackr' && row.version === '2.0.1');
    expect(rows).toHaveLength(4);
    expect(digestOf(rows)).toBe(PINNED_2_0_1_ROWS);
  });
});

/*
 * The exec rows, in their own generated table
 * (`reference-exec-anchors.ts`, written by `reference-anchors.ts --exec`),
 * held to the pack on disk the way the written rows are.
 */
describe('the committed exec anchor table', () => {
  type ExecRow = { anchor: string; grain: 'exec'; pack: string; version: string; phaseKey: string };
  const loadExec = (): ReadonlyArray<ExecRow> | null => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return (require('./reference-exec-anchors') as { REFERENCE_EXEC_ANCHORS: ReadonlyArray<ExecRow> }).REFERENCE_EXEC_ANCHORS;
    } catch {
      return null;
    }
  };

  it('the exec rows match content/tasktrackr (drift)', () => {
    const rows = loadExec();
    expect(rows).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cli = require('../../test/cli/reference-anchors') as typeof import('../../test/cli/reference-anchors');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { executableReferenceAnchor } = require('./project-scope') as typeof import('./project-scope');
    const project = tasktrackrContent().getProject('tasktrackr');
    const recorded = cli.recordReferenceExecAnchorRows(project, executableReferenceAnchor, soleTaskFor);
    const committed = rows!.filter((row) => row.pack === 'tasktrackr' && row.version === project.version);
    expect(committed).toEqual(recorded);
    expect(committed.map((row) => row.phaseKey)).toEqual(['implementation', 'testing', 'deployment', 'maintenance']);
    expect(committed.every((row) => row.grain === 'exec' && row.version === project.version)).toBe(true);
    // the file is the CLI's rendering, byte for byte
    const file = fs.readFileSync(path.join(__dirname, 'reference-exec-anchors.ts'), 'utf-8');
    expect(file).toBe(cli.renderReferenceExecAnchorsModule(cli.mergeReferenceExecAnchorRows(rows!, recorded)));
  });

  it('records each exec row from the pack directory itself, so --root reads the same bytes as the loader', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DirectoryPackSource } = require('../content/pack-source') as typeof import('../content/pack-source');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ContentService: Loader } = require('../content/content.service') as typeof import('../content/content.service');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('../config') as typeof import('../config');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cli = require('../../test/cli/reference-anchors') as typeof import('../../test/cli/reference-anchors');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { executableReferenceAnchor } = require('./project-scope') as typeof import('./project-scope');
    const fromRoot = new Loader().loadProject(new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')));
    expect(cli.recordReferenceExecAnchorRows(fromRoot, executableReferenceAnchor, soleTaskFor))
      .toEqual(cli.recordReferenceExecAnchorRows(tasktrackrContent().getProject('tasktrackr'), executableReferenceAnchor, soleTaskFor));
  });
});

/** sha256 of `canonicalJson` over the four 2.0.1 rows. Append-only; never regenerate. */
const PINNED_2_0_1_ROWS = '15dab97b63c3e5378c9e144a3f496f667bcab2fdd31eeab01ecfb188c2ddf236';

describe('the executable phases: reference by their exec anchor', () => {
  // An executable phase is not reference unconditionally: an upload is a
  // whole application of the teacher's own, so a rewritten task or mentor
  // prompt on an executable phase is the teacher's. TaskTrackr's own
  // executable phases are reference by their recorded exec anchors (pinned
  // above and in authored-executable-scope.spec.ts).
  it.each(['implementation', 'testing', 'deployment', 'maintenance'] as PhaseKey[])(
    'answers authored for %s once its task or its mentor prompt is not the reference\'s',
    (key) => {
      const phase = tasktrackrPhase(key);
      const rewritten = { ...soleTaskFor(phase), brief: 'A teacher rewrote this brief.', objectives: ['Mine.'] };
      expect(taskScopeOf(phase, rewritten, [rewritten]).kind).toBe('authored');
      expect(phaseScopeOf({ ...phase, assistant: { ...phase.assistant, systemPrompt: 'Mine.' } }, [soleTaskFor(phase)]).kind).toBe('authored');
      // the written table holds no exec rows: they live in their own file
      expect(REFERENCE_ANCHORS.some((row) => row.phaseKey === key)).toBe(false);
    },
  );

  it('holds only while no non-quiz task of an executable phase can be authored', () => {
    const why = 'C1 must design authored executable scopes before this wall moves';
    for (const kind of ['code', 'tests', 'config'] as ArtifactKind[]) {
      for (const type of ARTEFACT_TYPES.filter((one) => one !== 'quiz')) {
        expect([why, kind, type, isAuthorableTask(kind, type)]).toEqual([why, kind, type, false]);
      }
    }
    for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as PhaseKey[]) {
      const task = tasktrackrTask(key);
      expect([why, key, isAuthorableTask(task.checkKind, task.artefactType)]).toEqual([why, key, false]);
    }
  });
});

describe('a resolver that is total and fails safe', () => {
  const partials: Array<[string, unknown]> = [
    ['no checks, files or tasks', { key: 'design', title: 'Design', objectives: [], taskPanel: 'Mine.' }],
    ['no key at all', { assistant: { systemPrompt: 'You are the mentor for Requirements.' } }],
    ['markdown checks but no files', { key: 'requirements', checks: { kind: 'markdown', targets: [], rules: [] } }],
    ['an empty object', {}],
  ];
  it.each(partials)('never throws and answers authored for %s', (_what, phase) => {
    expect(() => taskScopeOf(phase as PhaseContent)).not.toThrow();
    expect(() => phaseScopeOf(phase as PhaseContent)).not.toThrow();
    expect(taskScopeOf(phase as PhaseContent).kind).toBe('authored');
    expect(phaseScopeOf(phase as PhaseContent).kind).toBe('authored');
  });

  it("answers authored for a synthetic design fixture, which is not TaskTrackr's bytes", () => {
    const synthetic = {
      key: 'design', title: 'Design', objectives: [], files: [],
      taskPanel: 'completeTask: what it returns, and what an unknown id does (US-2).',
      rubric: { criteria: [{ key: 'api_contract', title: 'API precision', description: 'Document it.' }] },
    } as unknown as PhaseContent;
    expect(taskScopeOf(synthetic).kind).toBe('authored');
    expect(phaseScopeOf(synthetic).kind).toBe('authored');
  });

  it('mints scopes only here: a forged reference scope is not a scope', () => {
    expect(isMintedScope(REFERENCE_SCOPE)).toBe(true);
    expect(isMintedScope({ kind: 'reference' })).toBe(false);
    expect(isMintedScope(authoredTaskScope(tasktrackrPhase('design'), tasktrackrTask('design'), []))).toBe(true);
    expect(isMintedScope(authoredPhaseScope(tasktrackrPhase('design'), [], { lesson: false }))).toBe(true);
    expect(Object.isFrozen(REFERENCE_SCOPE)).toBe(true);
  });

  it('is the only production module that mints one (the lens grep, as a test)', () => {
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const at = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(at);
        else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) && !at.endsWith(path.join('assistant', 'project-scope.ts'))) {
          const text = fs.readFileSync(at, 'utf8');
          if (/\bREFERENCE_SCOPE\b|\bauthoredTaskScope\s*\(|\bauthoredPhaseScope\s*\(|\bmintScope\b/.test(text)) offenders.push(path.relative(root, at));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('the room a task is worked in, mirrored from the web', () => {
  const task = (over: Partial<CompiledTask>): CompiledTask => ({
    ...tasktrackrTask('requirements'),
    ...over,
  });

  it('holds the four room artefacts the web routes to', () => {
    expect(PHASE_ROOM_ARTEFACT_PATHS).toEqual({
      requirements: 'requirements/story.json',
      design: 'design/design.json',
      deployment: 'deployment/runbook.json',
      maintenance: 'maintenance/change-request.json',
    });
  });

  it('asks the declarer first across the whole list, then ownership, in order', () => {
    const owner = task({ taskKey: 'owner', order: 1, artefactPath: 'requirements/other.md', owns: ['requirements/story.json'] });
    const declarer = task({ taskKey: 'declarer', order: 2, artefactPath: 'requirements/story.json', owns: ['requirements/story.json'] });
    expect(phaseRoomTaskKeyOf('requirements', [owner, declarer])).toBe('declarer');
    expect(phaseRoomTaskKeyOf('requirements', [owner])).toBe('owner');
    expect(phaseRoomTaskKeyOf('requirements', [task({ taskKey: 'mine', artefactPath: 'requirements/x.md', owns: ['requirements/x.md'] })])).toBeNull();
    expect(phaseRoomTaskKeyOf('implementation', [declarer])).toBeNull();
    expect(phaseRoomTaskKeyOf('requirements', [])).toBeNull();
  });

  it("finds TaskTrackr's own tasks in their rooms", () => {
    expect(phaseRoomTaskKeyOf('requirements', [tasktrackrTask('requirements')])).toBe('');
    expect(phaseRoomTaskKeyOf('design', [tasktrackrTask('design')])).toBe('');
  });
});

describe('real forks made by the authoring service', () => {
  let world: ForkWorld;
  beforeAll(async () => {
    world = await openForkWorld();
  });
  afterAll(async () => {
    await world?.close();
  });

  it('keeps an untouched copy reference at task and phase grain in every phase', async () => {
    const fork = await copyTaskTrackr(world, 's1-untouched');
    const snapshot = await draftSnapshot(world, fork);
    for (const key of ALL_PHASES) {
      const { phase, tasks } = phaseOf(snapshot, key);
      expect([key, tasks.map((one) => one.taskKey)]).toEqual([key, [INHERITED_TASK_KEY]]);
      // Design is a design phase: the copy's scope is the platform's own, its room task on the authored arm
      const want = (grain: 'task' | 'phase') => (key === 'design'
        ? (grain === 'task' ? taskScopeOf(tasktrackrPhase(key), tasktrackrTask(key), [tasktrackrTask(key)]).kind : phaseScopeOf(tasktrackrPhase(key), [tasktrackrTask(key)]).kind)
        : REFERENCE_SCOPE);
      expect([key, key === 'design' ? taskScopeOf(phase, tasks[0], tasks).kind : taskScopeOf(phase, tasks[0], tasks)]).toEqual([key, want('task')]);
      expect([key, key === 'design' ? phaseScopeOf(phase, tasks).kind : phaseScopeOf(phase, tasks)]).toEqual([key, want('phase')]);
    }
    for (const key of WRITTEN) {
      const { phase, tasks } = phaseOf(snapshot, key);
      expect(referenceAnchor(phase, tasks[0])).toBe(referenceAnchor(tasktrackrPhase(key), tasktrackrTask(key)));
    }
  });

  it('makes an inherited task the teacher\'s once its brief is edited', async () => {
    const fork = await copyTaskTrackr(world, 's1-edited-brief');
    await world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', INHERITED_TASK_KEY, {
      brief: `${tasktrackrTask('requirements').brief}\n\nOur class adds one more rule of its own.`,
    });
    const { phase, tasks } = phaseOf(await draftSnapshot(world, fork), 'requirements');
    expect(taskScopeOf(phase, tasks[0], tasks).kind).toBe('authored');
    expect(phaseScopeOf(phase, tasks).kind).toBe('authored');
  });

  it("makes an inherited task the teacher's once its design is saved (a markdown Design task takes no rules now: its first design save converts it)", async () => {
    const fork = await copyTaskTrackr(world, 's1-added-rule');
    await world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'design', INHERITED_TASK_KEY, {
      design: { contracts: { api: true, screens: true }, sequence: false, stories: [], floor: { ...DEFAULT_DESIGN_FLOOR, minDecisions: 2 } },
    });
    const { phase, tasks } = phaseOf(await draftSnapshot(world, fork), 'design');
    expect(phase.checks.kind).toBe('design');
    expect(taskScopeOf(phase, tasks[0], tasks).kind).toBe('authored');
    expect(phaseScopeOf(phase, tasks).kind).toBe('authored');
  });

  it("makes an inherited task the teacher's when an owned baseline file is replaced", async () => {
    // on Requirements, whose story record its task owns (Design is always the authored arm since 4.0.0)
    const fork = await copyTaskTrackr(world, 's1-replaced-file');
    const { phase, tasks } = phaseOf(await draftSnapshot(world, fork), 'requirements');
    expect(taskScopeOf(phase, tasks[0], tasks)).toBe(REFERENCE_SCOPE);
    const owned = tasks[0].owns[0];
    const replaced = { ...phase, files: phase.files.map((file) => (file.path === owned ? { ...file, content: '# Our own scaffold\n' } : file)) };
    expect(taskScopeOf(replaced, tasks[0], tasks).kind).toBe('authored');
    expect(phaseScopeOf(replaced, tasks).kind).toBe('authored');
  });

  // Requirements alone: Design is a design phase since 4.0.0, never the reference's, with or without a quiz
  it.each(['requirements'] as PhaseKey[])('keeps the %s phase reference when the only addition is a quiz', async (key) => {
    const fork = await copyTaskTrackr(world, `s1-quiz-${key}`);
    await world.service.addTask(S1_TEACHER, fork.projectId, fork.versionId, key, {
      taskKey: 'concepts',
      title: 'Concepts',
      brief: FIXTURE_QUIZ_NOTICE,
      artefactType: 'quiz',
      required: false,
      quiz: { questions: fixtureQuizQuestions(5), drawn: 3 },
    });
    const { phase, tasks } = phaseOf(await draftSnapshot(world, fork), key);
    expect(tasks.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY, 'concepts']);
    expect(phaseScopeOf(phase, tasks)).toBe(REFERENCE_SCOPE);
    expect(taskScopeOf(phase, tasks[0], tasks)).toBe(REFERENCE_SCOPE);
  });

  /* ---- the scenario anchor ---- */

  /** A phase row's intro or interview, written beneath the service the way the phase doors will write them. */
  const writePhaseRow = async (fork: Fork, key: PhaseKey, patch: Partial<ProjectPhaseEntity>) => {
    await world.dataSource.getRepository(ProjectPhaseEntity).update({ projectVersionId: fork.versionId, key }, patch);
  };



  it("makes Requirements the teacher's when only its interview is edited, task untouched", async () => {
    const fork = await copyTaskTrackr(world, 'bx-interview-only');
    const brief = tasktrackrPhase('requirements').interview!;
    await writePhaseRow(fork, 'requirements', { interview: { ...brief, persona: { name: 'Priya Nair', role: 'Facilities manager' } } });
    const { phase, tasks } = phaseOf(await draftSnapshot(world, fork), 'requirements');
    expect(referenceAnchor(phase, tasks[0])).toBe(referenceAnchor(tasktrackrPhase('requirements'), tasktrackrTask('requirements')));
    expect(taskScopeOf(phase, tasks[0], tasks).kind).toBe('authored');
    expect(phaseScopeOf(phase, tasks).kind).toBe('authored');
    // the task's own anchor still matches: the screen-copy throw keys on this alone
    expect(isReferenceTaskAnchor(phase, tasks[0])).toBe(true);
  });

  it("makes a phase the teacher's when only its intro is edited", async () => {
    // on Requirements, a reference phase until its intro is edited (Design is always the authored arm since 4.0.0)
    const fork = await copyTaskTrackr(world, 'bx-intro-only');
    expect(phaseScopeOf(phaseOf(await draftSnapshot(world, fork), 'requirements').phase, phaseOf(await draftSnapshot(world, fork), 'requirements').tasks)).toBe(REFERENCE_SCOPE);
    await writePhaseRow(fork, 'requirements', { intro: 'Specify the room-booking service.' });
    const { phase, tasks } = phaseOf(await draftSnapshot(world, fork), 'requirements');
    expect(taskScopeOf(phase, tasks[0], tasks).kind).toBe('authored');
    expect(phaseScopeOf(phase, tasks).kind).toBe('authored');
  });

  it('keeps Requirements reference when the inherited interview is written back unchanged, whatever its key order', async () => {
    const fork = await copyTaskTrackr(world, 'bx-interview-resaved');
    const brief = tasktrackrPhase('requirements').interview!;
    const reversed = <T>(value: T): T =>
      Array.isArray(value)
        ? (value.map(reversed) as unknown as T)
        : value && typeof value === 'object'
          ? (Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reversed(v)])) as T)
          : value;
    await writePhaseRow(fork, 'requirements', { interview: reversed(brief) });
    const { phase, tasks } = phaseOf(await draftSnapshot(world, fork), 'requirements');
    expect(taskScopeOf(phase, tasks[0], tasks)).toBe(REFERENCE_SCOPE);
    expect(phaseScopeOf(phase, tasks)).toBe(REFERENCE_SCOPE);
  });

  it('answers the task anchor alone for an untouched task and not for an edited one', async () => {
    const fork = await copyTaskTrackr(world, 'bx-anchor-alone');
    await world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'design', INHERITED_TASK_KEY, {
      brief: `${tasktrackrTask('design').brief}\n\nOur class adds one more rule of its own.`,
    });
    const snapshot = await draftSnapshot(world, fork);
    expect(isReferenceTaskAnchor(phaseOf(snapshot, 'requirements').phase, phaseOf(snapshot, 'requirements').tasks[0])).toBe(true);
    expect(isReferenceTaskAnchor(phaseOf(snapshot, 'design').phase, phaseOf(snapshot, 'design').tasks[0])).toBe(false);
    // total: a phase it cannot read is not the reference's
    expect(isReferenceTaskAnchor(undefined as unknown as PhaseContent, undefined as unknown as CompiledTask)).toBe(false);
  });

  it("answers authored for a design phase the teacher made their own, its one task still the room's", async () => {
    // a Design phase holds one design task since 4.0.0, so it is never left without its room task
    const fork = await copyTaskTrackr(world, 's1-authored-only');
    await world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'design', INHERITED_TASK_KEY, ROOM_DESIGN_EDIT as never);
    const { phase, tasks } = phaseOf(await draftSnapshot(world, fork), 'design');
    expect(tasks.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY]);
    expect(isReferenceTaskAnchor(phase, tasks[0])).toBe(false);
    const scope = taskScopeOf(phase, tasks[0], tasks);
    expect(scope.kind).toBe('authored');
    expect(scope.kind === 'authored' && scope.roomTask).toBe(true);
    expect(scope.kind === 'authored' && scope.ownsRecord).toBe(false);
    const grain = phaseScopeOf(phase, tasks);
    expect(grain.kind).toBe('authored');
    expect(grain.kind === 'authored' && grain.roomTaskKey).toBe(INHERITED_TASK_KEY);
  });
});
