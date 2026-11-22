import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { retiredWrittenPhaseUploadRefusal, TASK_KEY_INVALID } from '@learnsdlc/shared';
import {
  codeFolder,
  configFolder,
  designFolder,
  folderPack,
  onePhasePack,
  projectJson,
  storyFolder,
  testsFolder,
  threePhasePack,
  type PackFiles,
  type PhaseEdit,
} from '../../test/fixtures/folder-packs';
import { contentDigestManifest, sealedFilesOf } from './blob.store';
import { ContentService, validateInterviewBrief, type LoadProjectOptions } from './content.service';
import type { PhaseContent, ProjectContent } from './content.types';
import { derivePack, isFolderLayout, LAYOUT_SENTENCES, LayoutRefusal } from './folder-layout';
import { MemoryPackSource } from './memory-pack-source';
import { DirectoryPackSource, LayoutWalkRefusal } from './pack-source';
import { olderTaskTrackrPack } from '../../test/legacy-phase';
import { pointerLoad } from '../../test/pointer-load';
import { FIXTURES_DIR, OLDER_SHELF_DIR } from '../../test/fixtures/paths';

/**
 * The folder layout: a pack's phases, mounts, sealed files
 * and checks derived from its folders alone, every misplaced folder, file or
 * member refused by name in the spec's own sentence. The loader reads only
 * this layout; an older pack's pointers are read once, by `legacy-layout.ts`,
 * whose proof is `legacy-layout.spec.ts`.
 */

const CONTENT_DIR = path.resolve(__dirname, '../../../../content');

function load(files: PackFiles, origin: 'platform' | 'upload' = 'upload'): ProjectContent {
  return new ContentService().loadProject(folderPack(files), { origin });
}

/** The sentence a pack is refused with, held to be a layout refusal, never another error. */
function refusal(files: PackFiles, origin: 'platform' | 'upload' = 'upload'): string {
  try {
    load(files, origin);
  } catch (error) {
    expect(error).toBeInstanceOf(LayoutRefusal);
    return (error as Error).message;
  }
  throw new Error('the pack loaded');
}

const phaseOf = (project: ProjectContent, key: string): PhaseContent => project.phases.find((p) => p.key === key)!;
const mounts = (phase: PhaseContent) => phase.files.map((f) => ({ path: f.path, editable: f.editable, language: f.language }));

/** The three kinds that hold sealed folders, side by side. */
const sealedPack = (): PackFiles => ({ ...projectJson(), ...codeFolder(), ...testsFolder(), ...configFolder() });

/** One phase with its `phase.json` edited. */
const edited = (build: (folder?: string, edit?: PhaseEdit) => PackFiles, edit: PhaseEdit): PackFiles => ({ ...projectJson(), ...build(undefined, edit) });

/** A pack without the paths that start with `prefix`. */
const without = (files: PackFiles, prefix: string): PackFiles =>
  Object.fromEntries(Object.entries(files).filter(([at]) => !at.startsWith(prefix)));

describe('the folder layout: loading', () => {
  it('reads the layout from project.json alone: no phases member', () => {
    expect(isFolderLayout({ slug: 'x' })).toBe(true);
    expect(isFolderLayout({ slug: 'x', phases: [] })).toBe(false);
  });

  it("loads a three-phase folder pack: phases in LearnSDLC's order, orders 1 to 3, every mount at its path with its derived language, mounts in path order", () => {
    const project = load(threePhasePack());
    expect(project.phases.map((p) => [p.key, p.order])).toEqual([['requirements', 1], ['design', 2], ['implementation', 3]]);
    expect(mounts(phaseOf(project, 'requirements'))).toEqual([{ path: 'requirements/story.json', editable: true, language: 'json' }]);
    expect(mounts(phaseOf(project, 'design'))).toEqual([
      { path: 'assets/legend.json', editable: true, language: 'json' },
      { path: 'design/design.json', editable: true, language: 'json' },
    ]);
    expect(mounts(phaseOf(project, 'implementation'))).toEqual([
      { path: 'app/main.py', editable: true, language: 'python' },
      { path: 'tests/test_main.py', editable: false, language: 'python' },
    ]);
    const code = phaseOf(project, 'implementation');
    expect(code.checks.kind === 'code' && code.checks.runs.map((r) => r.id)).toEqual(['main']);
    expect(code.taskPanel).toBe('Make add return the sum of its two arguments.');
  });

  it('loads a one-phase pack holding only Implementation, at order 1', () => {
    const project = load(onePhasePack());
    expect(project.phases.map((p) => [p.key, p.order])).toEqual([['implementation', 1]]);
  });

  it("orders phases by LearnSDLC's order, never by the folder's number", () => {
    const project = load({ ...projectJson(), ...testsFolder('01-testing'), ...codeFolder('02-implementation') });
    expect(project.phases.map((p) => [p.key, p.order])).toEqual([['implementation', 1], ['testing', 2]]);
  });

  it('reads a phase folder named for its key alone, with no number', () => {
    const project = load({ ...projectJson(), ...codeFolder('implementation') });
    expect(project.phases.map((p) => [p.key, p.order])).toEqual([['implementation', 1]]);
  });

  it('refuses phases/03-Implementation by name', () => {
    expect(refusal({ ...projectJson(), ...codeFolder('03-Implementation') })).toBe(LAYOUT_SENTENCES.unknownPhase('phases/03-Implementation', 'Implementation'));
    expect(LAYOUT_SENTENCES.unknownPhase('phases/03-Implementation', 'Implementation')).toBe(
      "phases/03-Implementation: Implementation is not one of LearnSDLC's phases. A phase folder is named for its key: requirements, design, implementation, testing, deployment or maintenance.",
    );
  });

  it("mounts TaskTrackr Deployment's .github/workflows/ci.yml from files/, editable, with the same bytes as today's mount", () => {
    // TaskTrackr ships it in the folder layout too: under files/, at the learner's path
    const bytes = fs.readFileSync(path.join(CONTENT_DIR, 'tasktrackr/phases/05-deployment/files/.github/workflows/ci.yml'), 'utf-8');
    const project = load({ ...projectJson(), ...configFolder(), 'phases/05-deployment/files/.github/workflows/ci.yml': bytes });
    const mount = phaseOf(project, 'deployment').files.find((f) => f.path === '.github/workflows/ci.yml')!;
    expect({ editable: mount.editable, language: mount.language }).toEqual({ editable: true, language: 'yaml' });
    expect(mount.content).toBe(bytes);
    const today = new ContentService();
    today.loadAll();
    const shipped = today.getPhase('tasktrackr', 'deployment').files.find((f) => f.path === '.github/workflows/ci.yml')!;
    expect(shipped.editable).toBe(true);
    expect(mount.content).toBe(shipped.content);
  });

  it('keeps the sealed roles of the folder layout', () => {
    const project = load(sealedPack());
    expect(Object.fromEntries(Object.entries(sealedFilesOf(phaseOf(project, 'implementation'))).map(([role, files]) => [role, Object.keys(files!)]))).toEqual({
      hidden: ['tests/test_hidden.py'],
      solution: ['app/main.py'],
    });
    expect(Object.fromEntries(Object.entries(sealedFilesOf(phaseOf(project, 'testing'))).map(([role, files]) => [role, Object.keys(files!).sort()]))).toEqual({
      reference: ['app/core.py', 'tests/test_app.py'],
      mutant: ['app/core.py'],
    });
    const config = phaseOf(project, 'deployment');
    expect(Object.fromEntries(Object.entries(sealedFilesOf(config)).map(([role, files]) => [role, Object.keys(files!)]))).toEqual({ drill: ['Dockerfile'] });
    // smoke/ is not sealed, as today: its files ride in the checks only
    expect(config.checks.kind === 'config' && Object.keys(config.checks.smokeImplFiles)).toEqual(['app/main.py']);
  });

  it("sorts mounts after seeding, so a Design phase's design/design.json is in path order", () => {
    const project = load({ ...projectJson(), ...designFolder(undefined, (spec) => { spec.checks.contracts.api = true; }) });
    expect(phaseOf(project, 'design').files.map((f) => f.path)).toEqual(['assets/legend.json', 'design/design.json', 'shared/contract/api.json']);
  });

  it('places each run of a code phase at hidden_tests/<run id>/, and a tests phase reads its support files from readonly/', () => {
    const code = codeFolder(undefined, (spec) => {
      spec.checks.runs = [{ id: 'api', language: 'python', harness: 'pytest', visibleTests: ['tests/test_main.py'] }];
    });
    const hidden = code['phases/03-implementation/hidden_tests/main/tests/test_hidden.py'];
    delete code['phases/03-implementation/hidden_tests/main/tests/test_hidden.py'];
    const project = load({
      ...projectJson(),
      ...code,
      'phases/03-implementation/hidden_tests/api/tests/test_hidden.py': hidden,
      ...testsFolder(undefined, (spec) => { spec.checks.supportFiles = ['app/core.py']; }),
    });
    const implementation = phaseOf(project, 'implementation');
    expect(implementation.checks.kind === 'code' && implementation.checks.runs.map((r) => [r.id, r.hiddenTestFiles])).toEqual([
      ['api', { 'tests/test_hidden.py': hidden }],
    ]);
    const testing = phaseOf(project, 'testing');
    expect(testing.checks.kind === 'tests' && testing.checks.supportFiles).toEqual({ 'app/core.py': 'def add(a, b):\n    return a + b\n' });
  });

  it('passes a machine-output refusal from the walk through in its own words', () => {
    let refused: unknown;
    try {
      load({ ...projectJson(), ...codeFolder(), 'phases/03-implementation/files/.pytest_cache/v/x': 'x' });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(LayoutWalkRefusal);
    expect((refused as Error).message).toBe('phases/03-implementation/files/.pytest_cache is machine output. Remove it from the archive and upload again.');
  });

  it('leaves desktop entries out of every folder it lists or walks, and refuses none', () => {
    const clean = { ...sealedPack(), 'phases/04-testing/quizzes/concepts.json': '{}' };
    const leftovers: PackFiles = {
      'phases/.DS_Store': 'x',
      'phases/03-implementation/.DS_Store': 'x',
      'phases/03-implementation/hidden_tests/.DS_Store': 'x',
      'phases/03-implementation/hidden_tests/main/.DS_Store': 'x',
      'phases/03-implementation/solution/.DS_Store': 'x',
      'phases/04-testing/mutants/.DS_Store': 'x',
      'phases/04-testing/mutants/off_by_one/.DS_Store': 'x',
      'phases/04-testing/quizzes/.DS_Store': 'x',
      'phases/04-testing/impl/.DS_Store': 'x',
      'phases/05-deployment/smoke/.DS_Store': 'x',
      'phases/05-deployment/drill/.DS_Store': 'x',
      'phases/04-testing/reference/._x.py': 'x',
      'phases/03-implementation/__MACOSX/._phase.json': 'x',
    };
    const source = folderPack({ ...clean, ...leftovers });
    const project = new ContentService().loadProject(source, { origin: 'upload' });
    expect(project).toEqual(load(clean));
    expect(source.leftOut()).toEqual([
      'phases/.DS_Store',
      'phases/03-implementation/.DS_Store',
      'phases/03-implementation/__MACOSX/',
      'phases/03-implementation/hidden_tests/.DS_Store',
      'phases/03-implementation/hidden_tests/main/.DS_Store',
      'phases/03-implementation/solution/.DS_Store',
      'phases/04-testing/impl/.DS_Store',
      'phases/04-testing/mutants/.DS_Store',
      'phases/04-testing/mutants/off_by_one/.DS_Store',
      'phases/04-testing/quizzes/.DS_Store',
      'phases/04-testing/reference/._x.py',
      'phases/05-deployment/drill/.DS_Store',
      'phases/05-deployment/smoke/.DS_Store',
    ]);
    // the quiz is kept for the door, never compiled here
    expect(derivePack(source, { origin: 'upload' }).phases.find((p) => p.key === 'testing')!.quizzes).toEqual([
      { key: 'concepts', at: 'phases/04-testing/quizzes/concepts.json', text: '{}' },
    ]);
  });

  it('refuses a file directly under hidden_tests/ or mutants/, and an entry under quizzes/ that is not a .json file, by name', () => {
    expect(refusal({ ...sealedPack(), 'phases/03-implementation/hidden_tests/test_extra.py': 'x' })).toBe(
      "phases/03-implementation/hidden_tests/test_extra.py sits in no run's folder. Each run's hidden suite sits under hidden_tests/ in a folder named for the run's id.",
    );
    expect(refusal({ ...sealedPack(), 'phases/04-testing/mutants/off_by_one.py': 'x' })).toBe(
      "phases/04-testing/mutants/off_by_one.py sits in no mutant's folder. Each mutant is a folder under mutants/ holding its meta.json and the files it changes.",
    );
    expect(refusal({ ...sealedPack(), 'phases/04-testing/quizzes/notes.txt': 'x' })).toBe(
      'phases/04-testing/quizzes/notes.txt is not a quiz file. A quiz is quizzes/<task key>.json.',
    );
    expect(refusal({ ...sealedPack(), 'phases/04-testing/quizzes/old/a.json': '{}' })).toBe(
      'phases/04-testing/quizzes/old/ is not a quiz file. A quiz is quizzes/<task key>.json.',
    );
  });

  // The pointer layout this case once loaded is gone from the loader (TaskTrackr ships in the folder
  // layout), and the pointer reading's own proof is legacy-layout.spec.ts's `pointerLoad` case. What
  // stays is the shipped pack loading to its recorded content digests, now in the folder layout.
  it('loads the shipped TaskTrackr to its recorded content digests', () => {
    const service = new ContentService();
    service.loadAll();
    const recorded = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'tasktrackr-content-digests.json'), 'utf-8'));
    expect(contentDigestManifest(service.getProject('tasktrackr'))).toEqual(recorded);
  });
});

describe('the folder layout: every refusal, by name', () => {
  it('noPhase', () => {
    const sentence = "The archive holds no phase folder under phases/. A project holds at least one of LearnSDLC's six phases.";
    expect(LAYOUT_SENTENCES.noPhase).toBe(sentence);
    expect(refusal({ ...projectJson() })).toBe(sentence);
    expect(refusal({ ...projectJson(), 'phases/README.md': 'notes' })).toBe(sentence);
  });

  it('unknownPhase', () => {
    expect(refusal({ ...projectJson(), ...codeFolder(), 'phases/07-review/phase.json': '{}' })).toBe(
      "phases/07-review: review is not one of LearnSDLC's phases. A phase folder is named for its key: requirements, design, implementation, testing, deployment or maintenance.",
    );
  });

  it('twice', () => {
    expect(refusal({ ...projectJson(), ...designFolder('03-design'), ...designFolder('02-design') })).toBe(
      'phases/02-design and phases/03-design both hold design. A project holds each phase once.',
    );
  });

  it('noPhaseJson', () => {
    expect(refusal({ ...projectJson(), 'phases/03-implementation/files/app/main.py': 'x' })).toBe('phases/03-implementation has no phase.json.');
  });

  it('listsPhases (a caller that reads the folder layout by hand)', () => {
    const source = folderPack({ ...projectJson((meta) => { meta.phases = ['phases/03-implementation']; }), ...codeFolder() });
    expect(() => derivePack(source, { origin: 'upload' })).toThrow(new LayoutRefusal(
      'project.json lists phases, and the folders under phases/ are the list now. Remove phases from project.json.',
    ));
  });

  it("listsPhases at boot: loadProject refuses an older pack on disk, prefixed with the pack's folder", () => {
    const older = new DirectoryPackSource(OLDER_SHELF_DIR);
    expect(() => new ContentService().loadProject(older)).toThrow(new Error(
      'older-shelf/project.json lists phases, and the folders under phases/ are the list now. Remove phases from project.json.',
    ));
    expect(`older-shelf/${LAYOUT_SENTENCES.listsPhases}`).toBe(errorOf(() => new ContentService().loadProject(older)).message);
  });

  it('namesWarmup', () => {
    expect(refusal({ ...projectJson((meta) => { meta.warmup = 'warmup'; }), ...codeFolder() }, 'platform')).toBe(
      'project.json names a warm-up folder, and a warm-up is found by its folder now. Remove warmup from project.json.',
    );
  });

  it('keyOrOrder', () => {
    const sentence = 'phases/03-implementation/phase.json names its key or order, and the folder\'s name says both now. Remove key and order.';
    expect(refusal(edited(codeFolder, (spec) => { spec.key = 'implementation'; }))).toBe(sentence);
    expect(refusal(edited(codeFolder, (spec) => { spec.order = 3; }))).toBe(sentence);
  });

  it('namesFiles', () => {
    expect(refusal(edited(codeFolder, (spec) => { spec.files = []; }))).toBe(
      'phases/03-implementation/phase.json names files. Put each file under files/ or readonly/ at the path the learner sees, and remove files.',
    );
  });

  it('pointer, for every member the layout fixes', () => {
    const named = (build: (folder?: string, edit?: PhaseEdit) => PackFiles, edit: PhaseEdit) => refusal(edited(build, edit));
    expect(named(codeFolder, (s) => { s.checks.solutionDir = 'solution'; })).toBe(
      'phases/03-implementation/phase.json names solutionDir, a folder the layout fixes. Put the solution under solution/ and remove solutionDir.',
    );
    expect(named(codeFolder, (s) => { s.checks.hiddenTestDir = 'hidden_tests/main'; })).toBe(
      "phases/03-implementation/phase.json names hiddenTestDir, a folder the layout fixes. Put the run's hidden suite under hidden_tests/main/ and remove hiddenTestDir.",
    );
    expect(named(codeFolder, (s) => { s.checks.runs = [{ id: 'api', hiddenTestDir: 'hidden_tests/api' }]; })).toBe(
      "phases/03-implementation/phase.json names runs[0].hiddenTestDir, a folder the layout fixes. Put the run's hidden suite under hidden_tests/api/ and remove runs[0].hiddenTestDir.",
    );
    expect(named(testsFolder, (s) => { s.checks.referenceDir = 'reference'; })).toBe(
      'phases/04-testing/phase.json names referenceDir, a folder the layout fixes. Put the reference suite under reference/ and remove referenceDir.',
    );
    expect(named(testsFolder, (s) => { s.checks.implDir = 'impl'; })).toBe(
      'phases/04-testing/phase.json names implDir, a folder the layout fixes. Put the implementation under impl/ and remove implDir.',
    );
    expect(named(testsFolder, (s) => { s.checks.implFiles = { 'app/core.py': 'impl/core.py' }; })).toBe(
      'phases/04-testing/phase.json names implFiles, a folder the layout fixes. Put the implementation under impl/ and remove implFiles.',
    );
    expect(named(testsFolder, (s) => { s.checks.supportFiles = { 'app/core.py': 'readonly/app/core.py' }; })).toBe(
      'phases/04-testing/phase.json names supportFiles, a folder the layout fixes. Put each support file under readonly/ and remove supportFiles.',
    );
    expect(named(testsFolder, (s) => { s.checks.mutantsDir = 'mutants'; })).toBe(
      'phases/04-testing/phase.json names mutantsDir, a folder the layout fixes. Put each mutant under mutants/ and remove mutantsDir.',
    );
    expect(named(configFolder, (s) => { s.checks.smoke.implFiles = { 'app/main.py': 'smoke/app/main.py' }; })).toBe(
      "phases/05-deployment/phase.json names smoke.implFiles, a folder the layout fixes. Put the smoke run's files under smoke/ and remove smoke.implFiles.",
    );
    expect(named(configFolder, (s) => { s.checks.drill.faultedFiles = { Dockerfile: 'FROM x' }; })).toBe(
      "phases/05-deployment/phase.json names drill.faultedFiles, a folder the layout fixes. Put the drill's faulted files under drill/ and remove drill.faultedFiles.",
    );
    expect(named(storyFolder, (s) => { s.interview = 'interview.json'; })).toBe(
      'phases/01-requirements/phase.json names interview, a file the layout fixes. Put the interview in interview.json and remove interview.',
    );
  });

  it('taskFile', () => {
    expect(refusal(edited(codeFolder, (spec) => { spec.taskFile = 'task.md'; }))).toBe(
      'phases/03-implementation/phase.json: Implementation keeps its brief in taskPanel, not in a file.',
    );
  });

  it('blockBrief', () => {
    expect(refusal(edited(codeFolder, (spec) => { spec.task = { key: 'main', brief: 'Do the work.' }; }))).toBe(
      "phases/03-implementation's phase.json task block: the brief is the phase's taskPanel now; move it there.",
    );
  });

  it('unknownFolder', () => {
    expect(refusal({ ...projectJson(), ...codeFolder(), 'phases/03-implementation/file/app/main.py': 'x' })).toBe(
      "phases/03-implementation/file/ is not one of a phase's folders. A phase folder holds files/, readonly/ and quizzes/, and by its kind hidden_tests/, solution/, reference/, impl/, mutants/, smoke/ or drill/.",
    );
    // a name the role table holds as an object member is still not a phase folder
    expect(refusal({ ...projectJson(), ...codeFolder(), 'phases/03-implementation/constructor/x': 'x' })).toBe(
      LAYOUT_SENTENCES.unknownFolder('phases/03-implementation', 'constructor'),
    );
  });

  it('wrongKind', () => {
    expect(refusal({ ...projectJson(), ...testsFolder(), 'phases/04-testing/hidden_tests/main/tests/x.py': 'x' })).toBe(
      'phases/04-testing/hidden_tests/ belongs to a code phase, and testing is a tests phase.',
    );
    expect(refusal({ ...projectJson(), ...codeFolder(), 'phases/03-implementation/smoke/x.py': 'x' })).toBe(
      'phases/03-implementation/smoke/ belongs to a config phase, and implementation is a code phase.',
    );
  });

  it("refuses an unknown artifactKind in today's words before the folders are read", () => {
    expect(() => load({ ...edited(testsFolder, (spec) => { spec.artifactKind = 'essay'; }) })).toThrow(
      'upload/phases/04-testing: artifactKind "essay" is not one of story, design, code, tests, config, quiz',
    );
    expect(() => load({ ...edited(testsFolder, (spec) => { delete spec.artifactKind; }) })).toThrow(
      'upload/phases/04-testing: artifactKind must be a non-empty string',
    );
  });

  it('interviewElsewhere', () => {
    expect(refusal({ ...projectJson(), ...designFolder(), 'phases/02-design/interview.json': '{}' })).toBe(
      'phases/02-design/interview.json: only Requirements holds a stakeholder interview.',
    );
  });

  it('noRunFolder', () => {
    expect(refusal(without({ ...projectJson(), ...codeFolder() }, 'phases/03-implementation/hidden_tests/'))).toBe(
      "phases/03-implementation: the run main has no hidden_tests/main/ folder. Each run's hidden suite sits under hidden_tests/ in a folder named for the run's id.",
    );
  });

  it('noSolution', () => {
    expect(refusal(without({ ...projectJson(), ...codeFolder() }, 'phases/03-implementation/solution/'))).toBe(
      'phases/03-implementation has no solution/ folder. A code phase holds its reference solution under solution/.',
    );
  });

  it('noReference', () => {
    expect(refusal(without({ ...projectJson(), ...testsFolder() }, 'phases/04-testing/reference/'))).toBe(
      'phases/04-testing has no reference/ folder. A tests phase holds its reference suite under reference/.',
    );
  });

  it('quizIsWorkTask', () => {
    expect(refusal({ ...projectJson(), ...testsFolder(), 'phases/04-testing/quizzes/main.json': '{}' })).toBe(
      "phases/04-testing/quizzes/main.json: main is the key of the phase's work task. A quiz file is named for a task key of its own.",
    );
    expect(refusal({ ...edited(testsFolder, (spec) => { spec.task = { key: 'testing' }; }), 'phases/04-testing/quizzes/testing.json': '{}' })).toBe(
      "phases/04-testing/quizzes/testing.json: testing is the key of the phase's work task. A quiz file is named for a task key of its own.",
    );
  });

  it('quizKeyInvalid', () => {
    expect(refusal({ ...projectJson(), ...testsFolder(), 'phases/04-testing/quizzes/Concepts.json': '{}' })).toBe(
      `phases/04-testing/quizzes/Concepts.json: Concepts is not a task key. ${TASK_KEY_INVALID}`,
    );
    expect(TASK_KEY_INVALID).toBe("A task key is lower case, opens on a letter and is at most 32 characters, so that a learner's work follows the task across versions rather than its position.");
  });

  it('hiddenAtNoPath', () => {
    expect(refusal({ ...projectJson(), ...codeFolder(), 'phases/03-implementation/hidden_tests/main/test_hidden_tasks.py': 'x' })).toBe(
      'phases/03-implementation/hidden_tests/main/test_hidden_tasks.py sits at no workspace path: a hidden test sits at the path it runs from, for example hidden_tests/main/tests/test_hidden_tasks.py.',
    );
  });

  it('hiddenNoRun', () => {
    expect(refusal({ ...projectJson(), ...codeFolder(), 'phases/03-implementation/hidden_tests/web/tests/x.test.ts': 'x' })).toBe(
      "phases/03-implementation/hidden_tests/web names no run of the phase. Each folder under hidden_tests/ is named for a run's id.",
    );
  });

  it('solutionCompletesNothing', () => {
    expect(refusal({ ...projectJson(), ...codeFolder(), 'phases/03-implementation/solution/api/x.py': 'x' })).toBe(
      'phases/03-implementation/solution/api/x.py completes no file the learner edits.',
    );
  });

  it('checksNamesMissing, for each member and the folder it belongs to', () => {
    expect(refusal(edited(codeFolder, (s) => { s.checks.editableTargets = ['app/main.py', 'app/extra.py']; }))).toBe(
      'phases/03-implementation: checks names app/extra.py in editableTargets, which files/ does not hold.',
    );
    expect(refusal(edited(codeFolder, (s) => { s.checks.visibleTests = ['tests/test_other.py']; }))).toBe(
      'phases/03-implementation: checks names tests/test_other.py in visibleTests, which files/ or readonly/ does not hold.',
    );
    expect(refusal(edited(testsFolder, (s) => {
      s.checks.runs = [{ id: 'main', language: 'python', harness: 'pytest', learnerTestFiles: ['tests/test_app.py'], implFiles: ['web/src/lib/overdue.ts'] }];
    }))).toBe('phases/04-testing: checks names web/src/lib/overdue.ts in implFiles, which impl/ does not hold.');
    expect(refusal(edited(testsFolder, (s) => { s.checks.supportFiles = ['tests/clock.py']; }))).toBe(
      'phases/04-testing: checks names tests/clock.py in supportFiles, which readonly/ does not hold.',
    );
    expect(refusal(edited(testsFolder, (s) => { s.checks.learnerTestFiles = ['tests/test_web.py']; }))).toBe(
      'phases/04-testing: checks names tests/test_web.py in learnerTestFiles, which files/ does not hold.',
    );
    expect(refusal(edited(configFolder, (s) => { s.checks.rules[0].target = 'api/Dockerfile'; }))).toBe(
      'phases/05-deployment: checks names api/Dockerfile in rules, which files/ or readonly/ does not hold.',
    );
    expect(refusal(edited(configFolder, (s) => { s.checks.smoke.dockerfile = 'web/Dockerfile'; }))).toBe(
      'phases/05-deployment: checks names web/Dockerfile in smoke.dockerfile, which files/, readonly/ or smoke/ does not hold.',
    );
  });

  it('bothWays', () => {
    expect(refusal({ ...projectJson(), ...codeFolder(), 'phases/03-implementation/readonly/app/main.py': 'x' })).toBe(
      'phases/03-implementation/files/app/main.py and readonly/app/main.py are one path. A file is editable or read-only, never both.',
    );
  });

  it('drillMountsNothing', () => {
    expect(refusal({ ...projectJson(), ...configFolder(), 'phases/05-deployment/drill/docker-compose.yml': 'x' })).toBe(
      'phases/05-deployment/drill/docker-compose.yml faults a file the phase does not mount.',
    );
  });

  it('smokeScriptMissing', () => {
    expect(refusal(edited(configFolder, (s) => { s.checks.smoke.commands = [['python3', 'api/main.py']]; }))).toBe(
      'phases/05-deployment: the smoke command runs api/main.py, which smoke/ does not hold.',
    );
  });

  it('notAQuiz (raised at the door; named here)', () => {
    expect(LAYOUT_SENTENCES.notAQuiz(
      'phases/01-requirements/quizzes/concepts.json',
      'A pass mark is a whole percentage from 0 to 100, and this one is 500. A mark above 100 is a gate no paper can clear.',
    )).toBe('phases/01-requirements/quizzes/concepts.json is not a quiz: A pass mark is a whole percentage from 0 to 100, and this one is 500. A mark above 100 is a gate no paper can clear.');
  });

  it('quizzesInPlatformPack', () => {
    expect(refusal({ ...projectJson(), ...testsFolder(), 'phases/04-testing/quizzes/concepts.json': '{}' }, 'platform')).toBe(
      "phases/04-testing/quizzes/ is read in an upload only: a platform pack's tasks are its phases' own.",
    );
  });

  it('hiddenOutsideRun, mutantOutsideFolder and notAQuizFile word for word', () => {
    expect(LAYOUT_SENTENCES.hiddenOutsideRun('phases/03-implementation/hidden_tests/test_extra.py')).toBe(
      "phases/03-implementation/hidden_tests/test_extra.py sits in no run's folder. Each run's hidden suite sits under hidden_tests/ in a folder named for the run's id.",
    );
    expect(LAYOUT_SENTENCES.mutantOutsideFolder('phases/04-testing/mutants/off_by_one.py')).toBe(
      "phases/04-testing/mutants/off_by_one.py sits in no mutant's folder. Each mutant is a folder under mutants/ holding its meta.json and the files it changes.",
    );
    expect(LAYOUT_SENTENCES.notAQuizFile('phases/04-testing/quizzes/notes.txt')).toBe(
      'phases/04-testing/quizzes/notes.txt is not a quiz file. A quiz is quizzes/<task key>.json.',
    );
  });
});

/** One older phase.json's text, edited as JSON, for `olderTaskTrackrPack`'s `edit`. */
const phaseText = (folder: string, change: (spec: Record<string, any>) => void) => (name: string, text: string): string => {
  if (name !== `phases/${folder}/phase.json`) return text;
  const spec = JSON.parse(text);
  change(spec);
  return JSON.stringify(spec, null, 2);
};

/** The error a load throws, whatever its class; a load that succeeds fails the case. */
function errorOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('the pack loaded');
}

/**
 * TaskTrackr's own pack (the folder layout) as an upload, its warm-up left out
 * (the one part an upload refuses), with one `phase.json` edited in memory.
 */
function tasktrackrUpload(phase: string, edit: (spec: Record<string, any>) => void): MemoryPackSource {
  const root = path.join(CONTENT_DIR, 'tasktrackr');
  const entries: { name: string; bytes: Buffer }[] = [];
  const visit = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (child === 'warmup' || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      if (entry.isDirectory()) visit(child);
      else entries.push({ name: child, bytes: fs.readFileSync(path.join(root, child)) });
    }
  };
  visit('');
  const rewrite = (name: string, change: (value: Record<string, any>) => void): void => {
    const one = entries.find((entry) => entry.name === name)!;
    const value = JSON.parse(one.bytes.toString('utf-8'));
    change(value);
    one.bytes = Buffer.from(JSON.stringify(value, null, 2), 'utf-8');
  };
  rewrite('project.json', (meta) => { delete meta.warmup; });
  rewrite(`phases/${phase}/phase.json`, edit);
  return new MemoryPackSource(entries, 'upload', '');
}

const UPLOADED_WARMUP = "warmup/ is a platform pack's warm-up, and a warm-up cannot be uploaded yet. Leave the warmup/ folder out of the archive and upload again.";

describe('the folder layout: the drill a phase.json does not declare', () => {
  it('refuses a drill/ folder that phase.json declares no drill for, by name', () => {
    const undeclared = edited(configFolder, (s) => { delete s.checks.drill; });
    const sentence = 'phases/05-deployment/drill/ holds files, but phase.json declares no drill. Declare the drill in phase.json or remove the folder.';
    expect(LAYOUT_SENTENCES.drillUndeclared('phases/05-deployment')).toBe(sentence);
    expect(refusal(undeclared)).toBe(sentence);
    expect(refusal(undeclared, 'platform')).toBe(sentence);
    expect(refusal(edited(configFolder, (s) => { s.checks.drill = null; }))).toBe(sentence);
    // a drill/ holding only a desktop leftover holds nothing: it loads, and the leftover is noted
    const leftover = { ...without(undeclared, 'phases/05-deployment/drill/'), 'phases/05-deployment/drill/.DS_Store': 'x' };
    const source = folderPack(leftover);
    const project = new ContentService().loadProject(source, { origin: 'upload' });
    expect(phaseOf(project, 'deployment').checks.kind === 'config' && phaseOf(project, 'deployment').checks).not.toHaveProperty('drill');
    expect(source.leftOut()).toEqual(['phases/05-deployment/drill/.DS_Store']);
  });
});

describe('the folder layout: a warm-up in an upload', () => {
  const withWarmup = (): PackFiles => ({ ...onePhasePack(), 'warmup/warmup.json': '{ "title": "Warm-up" }' });

  it('refuses an upload holding warmup/ by name, before any phase is derived, and never reads the disk for it', () => {
    expect(LAYOUT_SENTENCES.warmupUploaded).toBe(UPLOADED_WARMUP);
    expect(() => derivePack(folderPack(withWarmup()), { origin: 'upload' })).toThrow(new LayoutRefusal(UPLOADED_WARMUP));
    // before the phases: a phase with no phase.json is not what is named
    const broken = { ...without(withWarmup(), 'phases/01-implementation/phase.json') };
    expect(() => derivePack(folderPack(broken), { origin: 'upload' })).toThrow(new LayoutRefusal(UPLOADED_WARMUP));
    // the loader passes it through in its own words, which hold no path outside the archive
    const refused = errorOf(() => new ContentService().loadProject(folderPack(withWarmup()), { origin: 'upload' }));
    expect(refused).toBeInstanceOf(LayoutRefusal);
    expect(refused.message).toBe(UPLOADED_WARMUP);
    expect(refused.message).not.toContain(process.cwd());
    expect(refused.message).not.toContain('upload:');
  });

  it('finds a warm-up by its folder only for a platform pack', () => {
    expect(derivePack(folderPack(withWarmup()), { origin: 'platform' }).warmup).toBe(true);
    expect(derivePack(folderPack(onePhasePack()), { origin: 'upload' }).warmup).toBe(false);
    expect(derivePack(folderPack(onePhasePack()), { origin: 'platform' }).warmup).toBe(false);
  });
});

describe('the folder layout: rules pinned one by one', () => {
  it("loads a Requirements interview.json as the phase's interview", () => {
    const text = fs.readFileSync(path.join(CONTENT_DIR, 'tasktrackr/phases/01-requirements/interview.json'), 'utf-8');
    const project = load({ ...projectJson(), ...storyFolder(), 'phases/01-requirements/interview.json': text });
    expect(phaseOf(project, 'requirements').interview).toEqual(validateInterviewBrief(JSON.parse(text)));
    expect(phaseOf(load({ ...projectJson(), ...storyFolder() }), 'requirements')).not.toHaveProperty('interview');
  });

  it("names the folder, not the pointer member, in the loader's four sentences on the folder path", () => {
    const solution = edited(codeFolder, (s) => { s.checks.editableTargets = ['app/main.py', 'app/other.py']; });
    solution['phases/03-implementation/files/app/other.py'] = 'x = 1  # TODO(learner)\n';
    expect(errorOf(() => load(solution)).message).toBe(
      'upload/phases/03-implementation: solution/: nothing in it completes app/other.py, so the pack ships a stub with no answer to hold the hidden suite against',
    );
    const reference = without({ ...projectJson(), ...testsFolder() }, 'phases/04-testing/reference/');
    reference['phases/04-testing/reference/tests/test_other.py'] = 'def test_other():\n    pass\n';
    expect(errorOf(() => load(reference)).message).toBe(
      'upload/phases/04-testing: reference/: nothing in it lands on tests/test_app.py, so the reference suite would never be the file the graders run',
    );
    expect(errorOf(() => load(edited(configFolder, (s) => { s.checks.smoke.expect = 'healthy'; }))).message).toBe(
      'upload/phases/05-deployment: checks.smoke.expect ("healthy") is not printed by the reference implementation: none of healthy appears in smoke/',
    );
    expect(errorOf(() => load(without(edited(configFolder, () => undefined), 'phases/05-deployment/drill/'))).message).toBe(
      'upload/phases/05-deployment: checks.drill (entrypoint) needs at least one entry in drill/',
    );
  });

  it('reads a load given no origin as a platform load, so a quizzes/ folder is refused', () => {
    const quizzes = { ...projectJson(), ...testsFolder(), 'phases/04-testing/quizzes/concepts.json': '{}' };
    const refused = errorOf(() => new ContentService().loadProject(folderPack(quizzes)));
    expect(refused).toBeInstanceOf(LayoutRefusal);
    expect(refused.message).toBe(LAYOUT_SENTENCES.quizzesInPlatformPack('phases/04-testing'));
  });

  it("finds a platform pack's warm-up on disk by its warmup/ folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-warmup-'));
    try {
      const files: PackFiles = { ...onePhasePack(), ...projectJson((meta) => { meta.languages = ['python', 'typescript']; }) };
      for (const [at, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, at)), { recursive: true });
        fs.writeFileSync(path.join(dir, at), text);
      }
      fs.cpSync(path.join(CONTENT_DIR, 'tasktrackr/warmup'), path.join(dir, 'warmup'), { recursive: true });
      const project = new ContentService().loadProject(new DirectoryPackSource(dir));
      expect(project.warmup?.title).toBe('Warm-up');
      expect(project.warmup?.files.map((f) => f.path)).toEqual(['web/src/lib/greeting.ts', 'web/src/lib/greeting.test.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a run folder, solution/ or reference/ holding only desktop leftovers as absent, and notes the leftover', () => {
    const cases: [PackFiles, string, string][] = [
      [without({ ...projectJson(), ...codeFolder() }, 'phases/03-implementation/hidden_tests/'), 'phases/03-implementation/hidden_tests/main/.DS_Store', LAYOUT_SENTENCES.noRunFolder('phases/03-implementation', 'main')],
      [without({ ...projectJson(), ...codeFolder() }, 'phases/03-implementation/solution/'), 'phases/03-implementation/solution/.DS_Store', LAYOUT_SENTENCES.noSolution('phases/03-implementation')],
      [without({ ...projectJson(), ...testsFolder() }, 'phases/04-testing/reference/'), 'phases/04-testing/reference/.DS_Store', LAYOUT_SENTENCES.noReference('phases/04-testing')],
    ];
    for (const [files, leftover, sentence] of cases) {
      const source = folderPack({ ...files, [leftover]: 'x' });
      const refused = errorOf(() => new ContentService().loadProject(source, { origin: 'upload' }));
      expect({ leftover, refused: refused instanceof LayoutRefusal, message: refused.message }).toEqual({ leftover, refused: true, message: sentence });
      expect(source.leftOut()).toEqual([leftover]);
    }
  });

  it("refuses a path a run's own check names that the run's folders do not hold, member by member", () => {
    const run = { id: 'main', language: 'python', harness: 'pytest' };
    expect(refusal(edited(codeFolder, (s) => { s.checks.runs = [{ ...run, visibleTests: ['tests/test_other.py'] }]; }))).toBe(
      'phases/03-implementation: checks names tests/test_other.py in visibleTests, which files/ or readonly/ does not hold.',
    );
    expect(refusal(edited(codeFolder, (s) => { s.checks.runs = [{ ...run, visibleTests: ['tests/test_main.py'], supportFiles: ['tests/conftest.py'] }]; }))).toBe(
      'phases/03-implementation: checks names tests/conftest.py in supportFiles, which readonly/ does not hold.',
    );
    expect(refusal(edited(testsFolder, (s) => { s.checks.runs = [{ ...run, learnerTestFiles: ['tests/test_web.py'] }]; }))).toBe(
      'phases/04-testing: checks names tests/test_web.py in learnerTestFiles, which files/ does not hold.',
    );
  });

  it("gives an older markdown Requirements the story kind's folders, and converts it at the door", () => {
    const markdown = (spec: Record<string, any>): void => {
      spec.artifactKind = 'markdown';
      spec.rubric = {
        passThreshold: 70,
        criteria: [
          { key: 'story_quality', title: 'Story', weight: 0.5, description: 'Who wants it, what they want, and why.' },
          { key: 'acceptance_criteria', title: 'Acceptance criteria', weight: 0.3, description: 'Given / When / Then criteria a tester could check.' },
          { key: 'completeness', title: 'Completeness', weight: 0.2, description: 'Enough words to say it all.' },
        ],
      };
      spec.checks = {
        kind: 'markdown',
        targets: ['requirements/my-story.md'],
        minWords: 50,
        minWordsCriterion: 'completeness',
        rules: [{ id: 'story-form', label: 'One story sentence', criterion: 'story_quality', pattern: '\\bAs an? ', flags: 'i', required: true, failDetail: 'Write the story as one sentence.' }],
      };
    };
    const pack = { ...projectJson(), ...storyFolder(undefined, markdown), 'phases/01-requirements/files/requirements/my-story.md': '# My story\n' };
    expect(refusal({ ...pack, 'phases/01-requirements/smoke/x.py': 'x' })).toBe(
      LAYOUT_SENTENCES.wrongKind('phases/01-requirements', 'smoke', 'config', 'requirements', 'story'),
    );
    const project = new ContentService().loadProject(folderPack(pack), { origin: 'upload', convertLegacyRequirements: true, warnings: [] } as LoadProjectOptions);
    expect(phaseOf(project, 'requirements').checks.kind).toBe('story');
  });

  it('refuses a markdown Implementation in the retired-kind sentence', () => {
    const retired = edited(codeFolder, (s) => {
      s.artifactKind = 'markdown';
      s.checks = { kind: 'markdown', targets: ['app/main.py'] };
    });
    expect(errorOf(() => load(retired)).message).toBe(`upload/phases/03-implementation: ${retiredWrittenPhaseUploadRefusal('Implementation')}`);
  });
});

describe('the folder layout: the loader sentences the move touched', () => {
  it("keeps the pointer path's run-shape sentence for a null run of a tests phase with no implDir", () => {
    const source = tasktrackrUpload('04-testing', (spec) => {
      expect(spec.checks.implDir).toBeUndefined();
      spec.checks.runs.push(null);
    });
    expect(errorOf(() => new ContentService().loadProject(source, { origin: 'upload' })).message).toBe(
      `upload/phases/04-testing: checks.runs[${2}] must be an object`,
    );
  });

  it('names taskPanel and smoke/ on the folder path, and keeps the pointer words on the pointer path', () => {
    expect(errorOf(() => load(edited(codeFolder, (s) => { delete s.taskPanel; }))).message).toBe('upload/phases/03-implementation: phase needs taskPanel');
    // the older runbook conversion asks for the brief before it converts
    const older = edited(configFolder, (s) => { delete s.taskPanel; });
    expect(errorOf(() => new ContentService().loadProject(folderPack(older), { origin: 'upload', convertLegacyRunbook: true, warnings: [] } as LoadProjectOptions)).message).toBe(
      'upload/phases/05-deployment: phase needs taskPanel',
    );
    const noDockerfile = without(edited(configFolder, (s) => {
      delete s.checks.smoke.dockerfile;
      delete s.checks.drill;
      s.checks.rules[0].target = 'compose.yml';
    }), 'phases/05-deployment/drill/');
    delete noDockerfile['phases/05-deployment/files/Dockerfile'];
    noDockerfile['phases/05-deployment/files/compose.yml'] = 'FROM python:3.11-slim\n';
    expect(errorOf(() => load(noDockerfile)).message).toBe(
      'upload/phases/05-deployment: checks.smoke.dockerfile ("Dockerfile") is neither a file this phase ships nor one of smoke/, so the smoke run would read an entry point out of nothing',
    );
    // the pointer path keeps its member names: the older TaskTrackr read through the pointer readers
    // (its edit reaches phases 5 and 6 only, so the brief taken away is Deployment's)
    expect(errorOf(() => pointerLoad(olderTaskTrackrPack(phaseText('05-deployment', (s) => { delete s.taskFile; delete s.taskPanel; })))).message).toBe(
      'tasktrackr/phases/05-deployment: phase needs taskFile or taskPanel',
    );
    expect(errorOf(() => pointerLoad(olderTaskTrackrPack(phaseText('05-deployment', (s) => { s.checks.smoke.dockerfile = 'api/Nowhere'; })))).message).toBe(
      'tasktrackr/phases/05-deployment: checks.smoke.dockerfile ("api/Nowhere") is neither a file this phase ships nor one of checks.smoke.implFiles, so the smoke run would read an entry point out of nothing',
    );
  });
});

describe('the folder layout: machine output in an upload is named as machine output', () => {
  const walkRefusal = (files: PackFiles): string => {
    const refused = errorOf(() => load(files));
    expect(refused).toBeInstanceOf(LayoutWalkRefusal);
    return refused.message;
  };

  it('refuses machine output directly under hidden_tests/, quizzes/ or mutants/ as machine output, before the structural sentence', () => {
    expect(walkRefusal({ ...sealedPack(), 'phases/03-implementation/hidden_tests/__pycache__/x.pyc': 'x' })).toBe(
      'phases/03-implementation/hidden_tests/__pycache__ is machine output. Remove it from the archive and upload again.',
    );
    expect(walkRefusal({ ...sealedPack(), 'phases/03-implementation/hidden_tests/x.pyc': 'x' })).toBe(
      'phases/03-implementation/hidden_tests/x.pyc is machine output. Remove it from the archive and upload again.',
    );
    expect(walkRefusal({ ...sealedPack(), 'phases/04-testing/quizzes/__pycache__/x.pyc': 'x' })).toBe(
      'phases/04-testing/quizzes/__pycache__ is machine output. Remove it from the archive and upload again.',
    );
    expect(walkRefusal({ ...sealedPack(), 'phases/04-testing/mutants/__pycache__/x.pyc': 'x' })).toBe(
      'phases/04-testing/mutants/__pycache__ is machine output. Remove it from the archive and upload again.',
    );
  });

  it("refuses a tool's or an editor's folder in a phase folder or under phases/ in its own words, not as an unknown folder or phase", () => {
    expect(walkRefusal({ ...sealedPack(), 'phases/03-implementation/.pytest_cache/v/x': 'x' })).toBe(
      'phases/03-implementation/.pytest_cache is machine output. Remove it from the archive and upload again.',
    );
    expect(walkRefusal({ ...sealedPack(), 'phases/.vscode/settings.json': '{}' })).toBe(
      "phases/.vscode is an editor's settings folder. Remove it from the archive and upload again.",
    );
  });

  it('leaves an AppleDouble twin of machine output out as a desktop file, as the walk does', () => {
    const source = folderPack({ ...sealedPack(), 'phases/03-implementation/hidden_tests/._x.pyc': 'x' });
    new ContentService().loadProject(source, { origin: 'upload' });
    expect(source.leftOut()).toEqual(['phases/03-implementation/hidden_tests/._x.pyc']);
  });
});

describe("the folder layout: the disk skips what a maintainer's machine leaves at every level it lists", () => {
  /**
   * What a local run, a type checker and an editor leave in a pack folder, at
   * each level `listLayout` reads (`phases/`, a phase folder, `hidden_tests/`,
   * `mutants/`), with the path an upload's refusal names for each. A desktop
   * file and a file walk's `__pycache__/` ride along: the disk skips those
   * everywhere.
   */
  const LEFTOVERS: [string, string | null][] = [
    ['phases/.idea/workspace.xml', 'phases/.idea'],
    ['phases/__pycache__/x.cpython-312.pyc', 'phases/__pycache__'],
    ['phases/x.map', 'phases/x.map'],
    ['phases/.DS_Store', null],
    ['phases/03-implementation/.pytest_cache/v/cache/nodeids', 'phases/03-implementation/.pytest_cache'],
    ['phases/03-implementation/.vscode/settings.json', 'phases/03-implementation/.vscode'],
    ['phases/03-implementation/node_modules/left/index.js', 'phases/03-implementation/node_modules'],
    ['phases/03-implementation/hidden_tests/__pycache__/conftest.cpython-312.pyc', 'phases/03-implementation/hidden_tests/__pycache__'],
    ['phases/03-implementation/hidden_tests/.idea/workspace.xml', 'phases/03-implementation/hidden_tests/.idea'],
    ['phases/03-implementation/hidden_tests/conftest.cpython-312.pyc', 'phases/03-implementation/hidden_tests/conftest.cpython-312.pyc'],
    ['phases/03-implementation/files/api/__pycache__/x.cpython-312.pyc', 'phases/03-implementation/files/api/__pycache__'],
    ['phases/04-testing/mutants/__pycache__/x.cpython-312.pyc', 'phases/04-testing/mutants/__pycache__'],
    ['phases/04-testing/mutants/.mypy_cache/3.12/x.json', 'phases/04-testing/mutants/.mypy_cache'],
    ['phases/04-testing/mutants/x.js.map', 'phases/04-testing/mutants/x.js.map'],
  ];
  /** The same at `quizzes/`, which only an upload-origin load reads. */
  const QUIZ_LEFTOVERS: [string, string][] = [
    ['phases/04-testing/quizzes/__pycache__/x.cpython-312.pyc', 'phases/04-testing/quizzes/__pycache__'],
    ['phases/04-testing/quizzes/.vscode/settings.json', 'phases/04-testing/quizzes/.vscode'],
    ['phases/04-testing/quizzes/concepts.cpython-312.pyc', 'phases/04-testing/quizzes/concepts.cpython-312.pyc'],
  ];

  const write = (dir: string, files: PackFiles): void => {
    for (const [at, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, at)), { recursive: true });
      fs.writeFileSync(path.join(dir, at), text);
    }
  };
  const filesOf = (list: [string, string | null][]): PackFiles => Object.fromEntries(list.map(([at]) => [at, 'x']));

  it('loads a copy of TaskTrackr 6.0.0 holding every leftover equal to the clean copy, at boot, refusing none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-leftovers-'));
    try {
      fs.cpSync(path.join(CONTENT_DIR, 'tasktrackr'), dir, { recursive: true });
      const clean = new ContentService().loadProject(new DirectoryPackSource(dir));
      expect(clean.version).toBe('6.0.0');
      write(dir, filesOf(LEFTOVERS));
      expect(new ContentService().loadProject(new DirectoryPackSource(dir))).toEqual(clean);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a folder pack on disk holding every leftover, quizzes/ included, equal to the clean pack as an upload-origin load', () => {
    const pack: PackFiles = { ...sealedPack(), 'phases/04-testing/quizzes/concepts.json': '{}' };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-leftovers-'));
    try {
      write(dir, pack);
      const clean = new ContentService().loadProject(new DirectoryPackSource(dir), { origin: 'upload' });
      const cleanQuizzes = derivePack(new DirectoryPackSource(dir), { origin: 'upload' }).phases.find((p) => p.key === 'testing')!.quizzes;
      write(dir, { ...filesOf(LEFTOVERS), ...filesOf(QUIZ_LEFTOVERS) });
      expect(new ContentService().loadProject(new DirectoryPackSource(dir), { origin: 'upload' })).toEqual(clean);
      expect(derivePack(new DirectoryPackSource(dir), { origin: 'upload' }).phases.find((p) => p.key === 'testing')!.quizzes).toEqual(cleanQuizzes);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still refuses each leftover in an upload (MemoryPackSource) by name, and leaves the desktop file out', () => {
    const pack: PackFiles = { ...sealedPack(), 'phases/04-testing/quizzes/concepts.json': '{}' };
    for (const [at, named] of [...LEFTOVERS, ...QUIZ_LEFTOVERS]) {
      const source = folderPack({ ...pack, [at]: 'x' });
      if (named === null) {
        new ContentService().loadProject(source, { origin: 'upload' });
        expect(source.leftOut()).toEqual([at]);
        continue;
      }
      const refused = errorOf(() => new ContentService().loadProject(source, { origin: 'upload' }));
      expect({ at, refused: refused instanceof LayoutWalkRefusal }).toEqual({ at, refused: true });
      const editor = /\/\.(idea|vscode)$/.test(named);
      expect({ at, message: refused.message }).toEqual({
        at,
        message: editor
          ? `${named} is an editor's settings folder. Remove it from the archive and upload again.`
          : `${named} is machine output. Remove it from the archive and upload again.`,
      });
    }
  });
});
