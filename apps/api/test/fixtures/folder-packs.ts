import * as fs from 'fs';
import * as path from 'path';
import { layoutFromManifest } from '../../src/content/legacy-layout';
import { MemoryPackSource } from '../../src/content/memory-pack-source';
import type { PackSource } from '../../src/content/pack-source';

/**
 * In-memory packs in the folder layout (docs/authoring-format.md,
 * "The archive layout"): no phase list in
 * `project.json`, no file, folder or source names in a `phase.json`. Each
 * builder is the smallest phase of its kind the loader accepts, as a
 * `Record<path, text>` under `phases/<NN>-<key>/`, so a spec spreads the
 * phases it needs, then adds, replaces or deletes the paths its case is about.
 */

export type PackFiles = Record<string, string>;

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const assistant = (key: string) => ({ systemPrompt: `${key} mentor`, topics: [], progressive: [] });

/** A `phase.json` edit a builder applies before it writes the file. */
export type PhaseEdit = (spec: Record<string, any>) => void;

/** The pack around the phases: what `project.json` holds once the folders are the phase list. */
export function projectJson(edit: (meta: Record<string, any>) => void = () => undefined): PackFiles {
  const meta: Record<string, any> = {
    slug: 'folders',
    version: '1.0.0',
    title: 'Folders',
    tagline: 'A pack whose folders are its manifest.',
    description: 'The smallest pack of each kind, in the folder layout.',
    language: 'python',
  };
  edit(meta);
  return { 'project.json': json(meta) };
}

/** The archive's entries, at its root, as a teacher's upload holds them. */
export function folderPack(files: PackFiles, name = 'upload'): MemoryPackSource {
  return new MemoryPackSource(
    Object.entries(files).map(([at, text]) => ({ name: at, bytes: Buffer.from(text, 'utf-8') })),
    name,
    '',
  );
}

function phase(folder: string, spec: Record<string, any>, files: PackFiles, edit: PhaseEdit): PackFiles {
  edit(spec);
  const out: PackFiles = { [`phases/${folder}/phase.json`]: json(spec) };
  for (const [at, text] of Object.entries(files)) out[`phases/${folder}/${at}`] = text;
  return out;
}

/** Requirements of the story kind: the record is seeded, nothing is mounted. */
export function storyFolder(folder = '01-requirements', edit: PhaseEdit = () => undefined): PackFiles {
  return phase(folder, {
    title: 'Requirements',
    intro: 'Write the missing story.',
    artifactKind: 'story',
    canRun: false,
    taskPanel: 'Write story FP-1 with two acceptance criteria.',
    objectives: ['Write the story'],
    rubric: { passThreshold: 70, criteria: [{ key: 'story', title: 'Story', weight: 1 }] },
    checks: { kind: 'story', learnerStory: { id: 'FP-1', hints: {} } },
    assistant: assistant('requirements'),
  }, {}, edit);
}

/** Design of the design kind: one mounted JSON file, and the design record seeded. */
export function designFolder(folder = '02-design', edit: PhaseEdit = () => undefined): PackFiles {
  return phase(folder, {
    title: 'Design',
    intro: 'Sketch what the application answers.',
    artifactKind: 'design',
    canRun: false,
    taskPanel: 'Record one entity and one decision.',
    objectives: ['Record the design'],
    rubric: { passThreshold: 70, criteria: [{ key: 'design', title: 'Design', weight: 1 }] },
    checks: { kind: 'design', contracts: { api: false, screens: false }, sequence: false },
    assistant: assistant('design'),
  }, { 'files/assets/legend.json': '{ "shapes": [] }\n' }, edit);
}

/** Implementation of the code kind: the flat shape, so its one run is `main`. */
export function codeFolder(folder = '03-implementation', edit: PhaseEdit = () => undefined): PackFiles {
  return phase(folder, {
    title: 'Implementation',
    intro: 'Fill in the marked gap.',
    artifactKind: 'code',
    canRun: true,
    runLabel: 'Run tests',
    taskPanel: 'Make add return the sum of its two arguments.',
    objectives: ['Fill the gap', 'Run the tests'],
    rubric: {
      passThreshold: 70,
      criteria: [
        { key: 'correctness_hidden', title: 'Hidden tests', weight: 0.4 },
        { key: 'visible_tests', title: 'Visible tests', weight: 0.2 },
        { key: 'code_quality', title: 'Code quality', weight: 0.2 },
        { key: 'process', title: 'Process', weight: 0.2 },
      ],
    },
    checks: { kind: 'code', editableTargets: ['app/main.py'], visibleTests: ['tests/test_main.py'] },
    assistant: assistant('implementation'),
  }, {
    'files/app/main.py': 'def add(a, b):\n    raise NotImplementedError  # TODO(learner)\n',
    'readonly/tests/test_main.py': 'from app.main import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n',
    'hidden_tests/main/tests/test_hidden.py': 'from app.main import add\n\n\ndef test_negative():\n    assert add(-1, -2) == -3\n',
    'solution/app/main.py': 'def add(a, b):\n    return a + b\n',
  }, edit);
}

/** Testing of the tests kind: a reference suite, the implementation it grades against, one mutant. */
export function testsFolder(folder = '04-testing', edit: PhaseEdit = () => undefined): PackFiles {
  return phase(folder, {
    title: 'Testing',
    intro: 'Write the suite that proves add.',
    artifactKind: 'tests',
    canRun: true,
    runLabel: 'Run tests',
    taskPanel: 'Write a suite that kills the mutant.',
    objectives: ['Write the suite'],
    rubric: {
      passThreshold: 70,
      criteria: [
        { key: 'tests_pass', title: 'The suite passes', weight: 0.4 },
        { key: 'mutants_killed', title: 'Mutants killed', weight: 0.4 },
        { key: 'coverage_mapping', title: 'Coverage mapping', weight: 0.2 },
      ],
    },
    checks: {
      kind: 'tests',
      learnerTestFiles: ['tests/test_app.py'],
      minTests: 1,
      coverageKeywords: [{ criterion: 'adds two numbers', keywords: ['add'] }],
    },
    assistant: assistant('testing'),
  }, {
    'files/tests/test_app.py': 'def test_add():\n    pass  # TODO(learner)\n',
    'readonly/app/core.py': 'def add(a, b):\n    return a + b\n',
    'reference/tests/test_app.py': 'from app.core import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n',
    'impl/app/core.py': 'def add(a, b):\n    return a + b\n',
    'mutants/off_by_one/meta.json': json({ name: 'off_by_one', description: 'add is one more than the sum.' }),
    'mutants/off_by_one/app/core.py': 'def add(a, b):\n    return a + b + 1\n',
  }, edit);
}

/** Deployment of the config kind: one rule, the build check, a smoke script and a drill. */
export function configFolder(folder = '05-deployment', edit: PhaseEdit = () => undefined): PackFiles {
  return phase(folder, {
    title: 'Deployment',
    intro: 'Containerise the application.',
    artifactKind: 'config',
    canRun: true,
    runLabel: 'Run the build check',
    taskPanel: 'Write the Dockerfile that starts the application.',
    objectives: ['Write the Dockerfile'],
    rubric: {
      passThreshold: 70,
      criteria: [
        { key: 'base_image', title: 'Base image', weight: 0.5 },
        { key: 'build_smoke', title: 'The container starts', weight: 0.5 },
      ],
    },
    checks: {
      kind: 'config',
      rules: [{ id: 'from', label: 'Base image', criterion: 'base_image', target: 'Dockerfile', pattern: '^FROM ', flags: 'm', failDetail: 'The Dockerfile names no base image.' }],
      smoke: { dockerfile: 'Dockerfile', commands: [['python3', 'app/main.py']], expect: 'selfcheck ok' },
      drill: { fault: 'entrypoint', description: 'The entry point names a file that is not there.' },
    },
    assistant: assistant('deployment'),
  }, {
    'files/Dockerfile': 'FROM python:3.11-slim\nCOPY app /app\nENTRYPOINT ["python3", "app/main.py"]\n',
    'smoke/app/main.py': 'print("selfcheck ok")\n',
    'drill/Dockerfile': 'FROM python:3.11-slim\nCOPY app /app\nENTRYPOINT ["python3", "app/missing.py"]\n',
  }, edit);
}

/** Requirements, Design and Implementation: a subset of three, in LearnSDLC's order. */
export function threePhasePack(): PackFiles {
  return { ...projectJson(), ...storyFolder(), ...designFolder(), ...codeFolder() };
}

/** Implementation alone, at `phases/01-implementation`. */
export function onePhasePack(): PackFiles {
  return { ...projectJson(), ...codeFolder('01-implementation') };
}

/**
 * An older pack (a `phases` list in `project.json`, pointers in each
 * `phase.json`) in the folder layout, converted once by the door's own
 * `layoutFromManifest`: every path the converted pack holds, to its text.
 * The loader reads only the folder layout, so a spec
 * that authors a pack in the older layout hands the loader this.
 */
export function convertedFiles(older: PackSource): PackFiles {
  const { source } = layoutFromManifest(older);
  return Object.fromEntries(source.walkForDigest('').map((at) => [at, source.read(at)]));
}

/** `convertedFiles`, written under `dir` (made if absent), as a pack on disk the boot loader reads. */
export function writeConverted(older: PackSource, dir: string): void {
  for (const [at, text] of Object.entries(convertedFiles(older))) {
    fs.mkdirSync(path.dirname(path.join(dir, at)), { recursive: true });
    fs.writeFileSync(path.join(dir, at), text, 'utf-8');
  }
}
