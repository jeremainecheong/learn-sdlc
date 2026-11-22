import * as fs from 'fs';
import * as path from 'path';
import { isPlainText } from '@learnsdlc/shared';
import { ContentService } from './content.service';
import { DirectoryPackSource } from './pack-source';
import { ProjectContent } from './content.types';
import { UPLOAD_PACKS_DIR } from '../../test/fixtures/paths';

/**
 * TaskTrackr 6.0.0 and the Shelf family in the folder layout. These cases
 * read the packs as they sit on disk, so they hold
 * the layout itself, not only what the loader derives from it.
 */
const ROOT = path.join(__dirname, '..', '..', '..', '..');
const TASKTRACKR = path.join(ROOT, 'content', 'tasktrackr');
const UPLOAD_PACKS = UPLOAD_PACKS_DIR;
const SHELF_FAMILY = ['shelf', 'shelf-preview', 'starter', 'shelf-three'].map((name) => path.join(UPLOAD_PACKS, name));
const PACKS = [TASKTRACKR, ...SHELF_FAMILY];
const PHASE_FOLDERS = ['01-requirements', '02-design', '03-implementation', '04-testing', '05-deployment', '06-maintenance'];

const readJson = (at: string): Record<string, any> => JSON.parse(fs.readFileSync(at, 'utf8'));

/** Every file under `dir`, relative to it, in code-unit order. */
function filesUnder(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((entry) => {
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filesUnder(dir, at) : [at];
    })
    .sort();
}

/** The phase folders of a pack, by their names under `phases/`. */
const phaseDirsOf = (pack: string): string[] =>
  fs.readdirSync(path.join(pack, 'phases'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(pack, 'phases', e.name)).sort();

/** Every member name at any depth of a JSON value. */
function membersOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(membersOf);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([name, inner]) => [name, ...membersOf(inner)]);
  return [];
}

/** Each teacher-written text of a phase.json, named by its member, as `brief-plain` reads them. */
function phaseTexts(spec: Record<string, any>): [string, string][] {
  const assistant = spec.assistant ?? {};
  return [
    ['taskPanel', spec.taskPanel],
    ['intro', spec.intro],
    ...(spec.objectives ?? []).map((one: string, at: number): [string, string] => [`objectives[${at}]`, one]),
    ...(spec.rubric?.criteria ?? []).flatMap((c: { key: string; title: string; description?: string }): [string, string][] => [
      [`rubric ${c.key} title`, c.title], [`rubric ${c.key} description`, c.description ?? ''],
    ]),
    ['assistant.systemPrompt', assistant.systemPrompt],
    ...(assistant.topics ?? []).flatMap((topic: { hints: string[] }, at: number) => topic.hints.map((hint, step): [string, string] => [`assistant.topics[${at}].hints[${step}]`, hint])),
    ...(assistant.progressive ?? []).map((hint: string, step: number): [string, string] => [`assistant.progressive[${step}]`, hint]),
    ...(spec.task && typeof spec.task === 'object' ? ([['task.title', spec.task.title ?? ''], ['task.brief', spec.task.brief ?? '']] as [string, string][]) : []),
  ];
}

/** Each text of a quiz file: its title, brief, objectives and every question's stem, options and explanation. */
function quizTexts(quiz: Record<string, any>): [string, string][] {
  const questions: Record<string, any>[] = quiz.checks?.questions ?? [];
  return [
    ['title', quiz.title ?? ''],
    ['brief', quiz.brief ?? ''],
    ...(quiz.objectives ?? []).map((one: string, at: number): [string, string] => [`objectives[${at}]`, one]),
    ...questions.flatMap((q, at): [string, string][] => [
      [`questions[${at}].stem`, q.stem ?? ''],
      ...(q.options ?? []).map((o: { text?: string } | string, n: number): [string, string] => [`questions[${at}].options[${n}]`, typeof o === 'string' ? o : o.text ?? '']),
      [`questions[${at}].explanation`, q.explanation ?? ''],
    ]),
  ];
}

describe('TaskTrackr 6.0.0 and the Shelf family in the folder layout', () => {
  let project: ProjectContent;

  beforeAll(() => {
    const content = new ContentService();
    content.loadAll();
    project = content.getProject('tasktrackr');
  });

  it('TaskTrackr is 6.0.0 in the folder layout, its project.json lists no phases and names no warm-up', () => {
    const meta = readJson(path.join(TASKTRACKR, 'project.json'));
    expect(meta.version).toBe('6.0.0');
    expect(meta).not.toHaveProperty('phases');
    expect(meta).not.toHaveProperty('warmup');
    expect(phaseDirsOf(TASKTRACKR).map((dir) => path.basename(dir))).toEqual(PHASE_FOLDERS);
    // the warm-up is found by its folder now
    expect(fs.existsSync(path.join(TASKTRACKR, 'warmup', 'warmup.json'))).toBe(true);
    expect(project.version).toBe('6.0.0');
    expect(project.phases.map((p) => [p.key, p.order])).toEqual([
      ['requirements', 1], ['design', 2], ['implementation', 3], ['testing', 4], ['deployment', 5], ['maintenance', 6],
    ]);
  });

  it('ls of 03-implementation prints README.md files hidden_tests phase.json readonly solution', () => {
    expect(fs.readdirSync(path.join(TASKTRACKR, 'phases', '03-implementation')).sort())
      .toEqual(['README.md', 'files', 'hidden_tests', 'phase.json', 'readonly', 'solution']);
  });

  it('no phase.json under content/ or the Shelf family names phases, files, source, solutionDir, hiddenTestDir, referenceDir, implDir, mutantsDir, taskFile or interview', () => {
    // a pointer at any depth of the file (the folders and the fixed names say each one now, 7.2)
    const POINTERS = ['source', 'solutionDir', 'hiddenTestDir', 'referenceDir', 'implDir', 'mutantsDir', 'taskFile', 'faultedFiles'];
    const found: string[] = [];
    for (const pack of PACKS) {
      const meta = readJson(path.join(pack, 'project.json'));
      for (const member of ['phases', 'warmup']) if (member in meta) found.push(`${path.basename(pack)}/project.json: ${member}`);
      for (const dir of phaseDirsOf(pack)) {
        const spec = readJson(path.join(dir, 'phase.json'));
        const where = `${path.basename(pack)}/${path.basename(dir)}/phase.json`;
        // the phase's own members the layout replaces (7.3); key and order are the folder's name now
        for (const member of ['files', 'interview', 'key', 'order']) if (member in spec) found.push(`${where}: ${member}`);
        for (const member of membersOf(spec)) if (POINTERS.includes(member)) found.push(`${where}: ${member}`);
        // a map of paths to sources is a pointer too; the lists of workspace paths stay
        for (const map of [spec.checks?.implFiles, spec.checks?.supportFiles, spec.checks?.smoke?.implFiles]) {
          if (map && typeof map === 'object' && !Array.isArray(map)) found.push(`${where}: a map of sources`);
        }
      }
    }
    // the warm-up keeps its files[] and loses briefFile
    const warmup = readJson(path.join(TASKTRACKR, 'warmup', 'warmup.json'));
    if ('briefFile' in warmup) found.push('tasktrackr/warmup/warmup.json: briefFile');
    expect(found).toEqual([]);
    expect(typeof warmup.brief).toBe('string');
  });

  it('no task.md and no taskFile anywhere under content/ or the Shelf family', () => {
    const found: string[] = [];
    for (const pack of PACKS) {
      for (const rel of filesUnder(pack)) {
        if (path.basename(rel) === 'task.md') found.push(`${path.basename(pack)}/${rel}`);
        if (rel.endsWith('.json') && fs.readFileSync(path.join(pack, rel), 'utf8').includes('"taskFile"')) found.push(`${path.basename(pack)}/${rel}: taskFile`);
      }
    }
    expect(found).toEqual([]);
    expect(fs.existsSync(path.join(TASKTRACKR, 'warmup', 'brief.md'))).toBe(false);
  });

  it('every brief, objective, intro, rubric sentence, quiz text and mentor prompt is plain', () => {
    const notPlain: string[] = [];
    for (const pack of PACKS) {
      for (const dir of phaseDirsOf(pack)) {
        const where = `${path.basename(pack)}/${path.basename(dir)}`;
        for (const [member, text] of phaseTexts(readJson(path.join(dir, 'phase.json')))) {
          if (typeof text === 'string' && !isPlainText(text)) notPlain.push(`${where}: ${member}`);
        }
        const quizzes = path.join(dir, 'quizzes');
        if (!fs.existsSync(quizzes)) continue;
        for (const name of fs.readdirSync(quizzes).filter((one) => one.endsWith('.json'))) {
          for (const [member, text] of quizTexts(readJson(path.join(quizzes, name)))) {
            if (!isPlainText(text)) notPlain.push(`${where}/quizzes/${name}: ${member}`);
          }
        }
      }
    }
    const warmup = readJson(path.join(TASKTRACKR, 'warmup', 'warmup.json'));
    if (!isPlainText(warmup.brief ?? '')) notPlain.push('tasktrackr/warmup: brief');
    expect(notPlain).toEqual([]);
    // every phase of TaskTrackr has a brief of substance
    for (const phase of project.phases) expect(phase.taskPanel.length).toBeGreaterThan(100);
  });

  it('Deployment mounts .github/workflows/ci.yml from files/, editable, graded by the ci extra at that path', () => {
    const CI = '.github/workflows/ci.yml';
    expect(fs.existsSync(path.join(TASKTRACKR, 'phases', '05-deployment', 'files', CI))).toBe(true);
    expect(fs.existsSync(path.join(TASKTRACKR, 'phases', '05-deployment', 'readonly', CI))).toBe(false);
    const deployment = project.phases.find((p) => p.key === 'deployment')!;
    const mount = deployment.files.find((f) => f.path === CI);
    expect(mount).toMatchObject({ path: CI, editable: true, language: 'yaml' });
    if (deployment.checks.kind !== 'config') throw new Error('expected config checks');
    // the three ci-* rules target the file at its workspace path, where the ci extra reads it (`feedback.service.ts`, the deployment arm)
    expect(deployment.checks.rules.filter((rule) => rule.id.startsWith('ci-')).map((rule) => [rule.id, rule.target]))
      .toEqual([['ci-test-step', CI], ['ci-web-step', CI], ['ci-build-step', CI]]);
  });

  it('the Testing brief keeps US-3/AC-2 and US-5/AC-2 and names no mutant', () => {
    const testing = project.phases.find((p) => p.key === 'testing')!;
    if (testing.checks.kind !== 'tests') throw new Error('expected tests checks');
    expect(testing.taskPanel).toContain('US-3/AC-2');
    expect(testing.taskPanel).toContain('US-5/AC-2');
    for (const mutant of testing.checks.mutants) expect(testing.taskPanel).not.toContain(mutant.name);
  });

  it('every phase still says what good looks like and how to use the mentor', () => {
    for (const phase of project.phases) {
      expect(phase.taskPanel).toMatch(/what good looks like/i);
      expect(phase.taskPanel).toMatch(/mentor/i);
    }
  });

  it('shelf-three holds Requirements, Design and Implementation, orders 1 to 3', () => {
    const three = path.join(UPLOAD_PACKS, 'shelf-three');
    expect(phaseDirsOf(three).map((dir) => path.basename(dir))).toEqual(['01-requirements', '02-design', '03-implementation']);
    const meta = readJson(path.join(three, 'project.json'));
    expect(meta).not.toHaveProperty('phases');
    const loaded = new ContentService().loadProject(new DirectoryPackSource(three));
    expect(loaded.phases.map((p) => [p.key, p.order])).toEqual([['requirements', 1], ['design', 2], ['implementation', 3]]);
  });
});
