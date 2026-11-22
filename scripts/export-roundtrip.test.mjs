import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { packFiles, zipFiles, crc32 } from './pack-archive.mjs';
import {
  ADDED_QUIZ,
  EDITED_CRITERION,
  SHELF_DIR,
  canonical,
  comparableTaskLists,
  editedRubric,
  exportLayoutFaults,
  packRootOf,
  proveRoundTrip,
  quizTaskBody,
  readZip,
  shelfArchive,
  taskListDifferences,
} from './export-roundtrip.mjs';

const require = createRequire(import.meta.url);
const { TASK_KEY_PATTERN, plainTextOf } = require('@learnsdlc/shared');

/** The frozen older Shelf (project.json lists its phases, canonical/ kept), which Task 22 left in the older layout. */
const OLDER_SHELF_DIR = path.join(path.dirname(SHELF_DIR), '..', 'older-shelf');

const SHELF_PHASES = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

/* ------------------------------------------------------------ the archive */

test('readZip reads back every entry of the Shelf archive the proof uploads, byte for byte', () => {
  const entries = readZip(shelfArchive());
  const files = packFiles(SHELF_DIR);
  assert.deepEqual([...entries.keys()], files.map((one) => one.name));
  for (const file of files) assert.ok(entries.get(file.name).equals(file.data), file.name);
});

/** One stored (method 0) entry as a zip archive, the shape an archive writer that does not deflate leaves. */
function storedZip(name, text) {
  const data = Buffer.from(text);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const directory = Buffer.concat([central, nameBytes]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + data.length, 16);
  return Buffer.concat([local, nameBytes, data, directory, end]);
}

test('readZip reads a stored entry and refuses bytes that are not an archive', () => {
  assert.equal(readZip(storedZip('project.json', '{"slug":"shelf"}')).get('project.json').toString(), '{"slug":"shelf"}');
  assert.throws(() => readZip(Buffer.from('not an archive at all, just text')), { message: 'the archive has no end-of-directory record' });
});

/**
 * Shelf as the export writes it, for the layout check: project.json with no
 * phase list, the phase folders, the added quiz as its own file, no canonical/.
 */
function shelfAsExported() {
  const files = packFiles(SHELF_DIR)
    .filter((one) => !one.name.startsWith('canonical/'))
    .map((one) => {
      if (one.name !== 'project.json') return one;
      const { phases: _phases, ...meta } = JSON.parse(one.data.toString('utf8'));
      return { name: one.name, data: Buffer.from(`${JSON.stringify(meta, null, 2)}\n`) };
    });
  files.push({ name: `phases/01-requirements/quizzes/${ADDED_QUIZ.taskKey}.json`, data: Buffer.from('{}\n') });
  return zipFiles(files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

test('the export layout check passes an archive in the folder layout with the quiz as its own file', () => {
  assert.deepEqual(exportLayoutFaults(readZip(shelfAsExported()), { phases: SHELF_PHASES, quiz: ADDED_QUIZ }), []);
});

test('the export layout check reads an archive whose entries sit under the project slug, as the export writes them', () => {
  const underSlug = (buffer) => new Map([...readZip(buffer)].map(([name, data]) => [`shelf/${name}`, data]));
  assert.deepEqual(exportLayoutFaults(underSlug(shelfAsExported()), { phases: SHELF_PHASES, quiz: ADDED_QUIZ }), []);
  assert.deepEqual(exportLayoutFaults(underSlug(shelfArchive(OLDER_SHELF_DIR)), { phases: SHELF_PHASES, quiz: ADDED_QUIZ }), [
    "the export's project.json still lists its phases",
    `the export holds no phases/01-requirements/quizzes/${ADDED_QUIZ.taskKey}.json`,
    'the export holds a canonical/ folder',
  ]);
  assert.equal(packRootOf(['project.json', 'phases/01-requirements/phase.json']), '');
  assert.equal(packRootOf(['shelf/project.json', 'shelf/phases/01-requirements/phase.json', '__MACOSX/shelf/._project.json']), 'shelf');
  assert.equal(packRootOf(['a/project.json', 'b/phase.json']), '');
  assert.deepEqual(exportLayoutFaults(new Map([['shelf/phases/01-requirements/phase.json', Buffer.from('{}')]]), { phases: ['requirements'], quiz: null }), [
    'the export holds no project.json',
    "the export's phase folders are none, not 01-requirements",
  ]);
});

test('the export layout check names each way the older Shelf archive is not the folder layout', () => {
  assert.deepEqual(exportLayoutFaults(readZip(shelfArchive(OLDER_SHELF_DIR)), { phases: SHELF_PHASES, quiz: ADDED_QUIZ }), [
    "the export's project.json still lists its phases",
    `the export holds no phases/01-requirements/quizzes/${ADDED_QUIZ.taskKey}.json`,
    'the export holds a canonical/ folder',
  ]);
  assert.deepEqual(exportLayoutFaults(readZip(shelfAsExported()), { phases: ['requirements', 'design', 'implementation'], quiz: null }), [
    "the export's phase folders are 01-requirements, 02-design, 03-implementation, 04-testing, 05-deployment, 06-maintenance, not 01-requirements, 02-design, 03-implementation",
  ]);
});

/* --------------------------------------------------------- the comparison */

/** Every file under `dir`, as paths relative to it in path order; none when it is absent. */
function filesUnder(dir, rel = '') {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((entry) => {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filesUnder(dir, child) : entry.name === '.DS_Store' ? [] : [child];
    })
    .sort();
}

/**
 * Shelf's phases as the editor's tasks route serves a version of them: each
 * phase's sole task with the fixture's title, brief (its `taskPanel`, as plain
 * text, as the door stores it), objectives, rubric and owned paths (the
 * phase folder's editable mounts, its `files/`, in path order).
 */
function shelfViews() {
  return SHELF_PHASES.map((key, i) => {
    const folder = path.join(SHELF_DIR, 'phases', `${String(i + 1).padStart(2, '0')}-${key}`);
    const spec = JSON.parse(fs.readFileSync(path.join(folder, 'phase.json'), 'utf8'));
    return {
      key, order: i + 1, title: spec.title, intro: spec.intro, blocksPublish: false,
      tasks: [{
        taskKey: '', order: 1, required: true, title: spec.title, brief: plainTextOf(spec.taskPanel), artefactType: spec.artifactKind,
        objectives: spec.objectives, rubric: spec.rubric, owns: filesUnder(path.join(folder, 'files')),
      }],
    };
  });
}
const clone = (value) => JSON.parse(JSON.stringify(value));

test('two reads of one version compare equal, whatever order their members and owned paths come in', () => {
  const first = shelfViews();
  // the owned-path half holds real lists: Implementation owns its two files/ mounts, reversed below
  assert.deepEqual(first.find((phase) => phase.key === 'implementation').tasks[0].owns, ['api/shelf.py', 'web/src/lib/shelf.ts']);
  assert.ok(first.some((phase) => phase.tasks[0].owns.length > 1));
  const second = clone(first).map((phase) => ({
    ...phase,
    tasks: phase.tasks.map((task) => Object.fromEntries(Object.entries({ ...task, owns: [...task.owns].reverse(), signOff: false }).reverse())),
  }));
  assert.deepEqual(taskListDifferences(first, second), []);
  assert.deepEqual(comparableTaskLists(first), comparableTaskLists(second));
});

test('a task out of place, a changed intro, a changed Criteria weight, a missing task and a missing phase are each named', () => {
  const quiz = { taskKey: ADDED_QUIZ.taskKey, order: 2, required: false, title: 'Shelf story concepts', brief: 'Four questions.', artefactType: 'quiz', objectives: [], rubric: { passThreshold: 70, criteria: [] }, owns: [] };
  const first = shelfViews();
  first[0].tasks.push(quiz);
  const second = clone(first);
  second[0].tasks.reverse();
  second[1].intro = 'Another intro.';
  second[2].tasks[0].rubric.criteria[0].weight = 0.4;
  second[3].tasks = [];
  assert.deepEqual(taskListDifferences(first, second), [
    'requirements: task main is in place 1 on one side and 2 on the other',
    `requirements: task ${ADDED_QUIZ.taskKey} is in place 2 on one side and 1 on the other`,
    'design: its intro differs',
    "implementation: task main's rubric differs",
    'testing: task main is missing from the second version',
  ]);
  assert.deepEqual(taskListDifferences(first, first.slice(0, 3)), [
    'the phases are requirements, design, implementation, testing, deployment, maintenance on one side and requirements, design, implementation on the other',
  ]);
});

test('canonical keeps the order of a list that is not a set of paths', () => {
  assert.deepEqual(canonical({ b: [2, 1], owns: ['b/x', 'a/y'], solution: [{ path: 'z' }, { path: 'a' }], a: undefined }), {
    b: [2, 1], owns: ['a/y', 'b/x'], solution: [{ path: 'a' }, { path: 'z' }],
  });
});

/* ------------------------------------------------------------ the edits */

test("the Criteria edit rewords code quality and moves five hundredths of weight to it, keeping the fixed keys and a sum of 1", () => {
  const rubric = shelfViews()[2].tasks[0].rubric;
  const edited = editedRubric(rubric);
  assert.deepEqual(edited.criteria.map((one) => one.key), rubric.criteria.map((one) => one.key));
  assert.ok(Math.abs(edited.criteria.reduce((n, one) => n + one.weight, 0) - 1) < 1e-9);
  const before = Object.fromEntries(rubric.criteria.map((one) => [one.key, one]));
  for (const one of edited.criteria) {
    if (one.key === EDITED_CRITERION.key) assert.deepEqual([one.description, one.weight], [EDITED_CRITERION.description, 0.3]);
    else if (one.key === 'correctness_hidden') assert.equal(one.weight, 0.4);
    else assert.deepEqual(one, before[one.key]);
  }
  assert.throws(() => editedRubric({ passThreshold: 70, criteria: [{ key: 'tests_pass', title: 'T', description: 'D', weight: 1 }] }), {
    message: "Implementation's rubric has no code-quality and hidden-test criteria to edit",
  });
});

test('the added quiz is optional, keyed as the editor keys a task, its texts plain, and draws fewer questions than it holds', () => {
  const body = quizTaskBody();
  assert.equal(body.taskKey, ADDED_QUIZ.taskKey);
  assert.match(body.taskKey, TASK_KEY_PATTERN);
  assert.equal(body.required, false);
  assert.equal(body.artefactType, 'quiz');
  assert.ok(body.quiz.drawn < body.quiz.questions.length);
  const texts = [body.title, body.brief, ...body.quiz.questions.flatMap((q) => [q.stem, q.explanation, ...q.options.map((o) => o.text)])];
  for (const text of texts) {
    assert.equal(plainTextOf(text), text);
    assert.doesNotMatch(text, /[\u00b7\u2014]/);
  }
  for (const q of body.quiz.questions) assert.ok(q.correct.every((id) => q.options.some((o) => o.id === id)));
});

/* ------------------------------------------------- the step over a stubbed API */

/**
 * A fetch that answers from `answer(key, route, body)` (`key` is `METHOD
 * route` with ids replaced by :id; `route` keeps them), records the calls,
 * and answers an export as zip bytes with its withheld header.
 */
function stubFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const route = String(url).replace('http://api.test', '');
    const key = `${init.method ?? 'GET'} ${route.replace(/\/(p[12]|v[12]|u1)(?=\/|$)/g, '/:id')}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([key, body, route]);
    const data = answer(key, route, body) ?? {};
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'x-export-withheld' ? String(data.withheld ?? 0) : null) },
      json: async () => data,
      arrayBuffer: async () => data.archive,
    };
  };
  return calls;
}

/** The quiz task as the editor serves it once the quiz door has added it. */
const QUIZ_VIEW = { taskKey: ADDED_QUIZ.taskKey, order: 2, required: false, title: 'Shelf story concepts', brief: 'Four questions.', artefactType: 'quiz', checkKind: 'quiz', objectives: [], rubric: { passThreshold: 70, criteria: [] }, owns: [] };

/**
 * A stubbed API on which the round trip holds: the first version is Shelf
 * until the quiz door and the Criteria save change it, the second is what the
 * export uploads to. `change` overrides an answer.
 */
function roundTripApi(change = {}) {
  const views = { v1: shelfViews(), v2: shelfViews() };
  views.v2[0].tasks.push(clone(QUIZ_VIEW));
  views.v2[2].tasks[0].rubric = editedRubric(views.v2[2].tasks[0].rubric);
  let deep = 0;
  return (key, route, body) => {
    if (key in change) return typeof change[key] === 'function' ? change[key](route, views) : change[key];
    if (key === 'POST /instructor/projects/:id/versions/:id/phases/requirements/tasks') {
      views.v1[0].tasks.push(clone(QUIZ_VIEW));
      return {};
    }
    if (key === 'PATCH /instructor/projects/:id/versions/:id/phases/implementation/tasks/main') {
      views.v1[2].tasks[0].rubric = clone(body.rubric);
      return {};
    }
    const version = /\/versions\/(v[12])/.exec(route)?.[1];
    switch (key) {
      case 'POST /auth/register': return { token: 'r', user: { id: 'u1' } };
      case 'POST /auth/login': return { token: 't', user: { role: 'INSTRUCTOR' } };
      case 'GET /instructor/projects/:id/versions/:id/deep-validation': return (deep += 1) === 1 ? { status: 'idle' } : { status: 'passed' };
      case 'GET /instructor/projects/:id/versions/:id': return { phases: views[version].map(({ key: k, order }) => ({ key: k, order })) };
      case 'GET /instructor/projects/:id/versions/:id/export': return { archive: shelfAsExported(), withheld: 0 };
      default: {
        const phase = /\/phases\/([a-z]+)\/tasks$/.exec(route);
        if (key.startsWith('GET ') && phase) return views[version].find((one) => one.key === phase[1]);
        return {};
      }
    }
  };
}

/** The second upload answers the second project; every other answer is the first's. */
function twoUploads(api) {
  let uploads = 0;
  return (key, route, body) => {
    if (key === 'POST /instructor/projects/upload') {
      uploads += 1;
      return uploads === 1 ? { projectId: 'p1', versionId: 'v1' } : { projectId: 'p2', versionId: 'v2' };
    }
    if (key === 'POST /instructor/projects/:id/versions/:id/publish') return { versionId: /\/versions\/(v[12])/.exec(route)[1] };
    return api(key, route, body);
  };
}
const noSleep = async () => {};

test('proveRoundTrip makes the teacher, uploads, adds the quiz, edits the Criteria, publishes, exports, uploads the export, publishes it and compares, in that order', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const calls = stubFetch(twoUploads(roundTripApi()));
  const line = await proveRoundTrip({ api: 'http://api.test', adminToken: 'a', title: 'T', sleep: noSleep });
  assert.match(line, /the two versions hold the same 7 tasks over 6 phases$/);
  const keys = calls.map(([key]) => key);
  const tasksOf = keys.filter((key) => /^GET .*\/phases\/[a-z]+\/tasks$/.test(key));
  assert.deepEqual(keys.slice(0, 16), [
    'POST /auth/register',
    'PATCH /admin/users/:id',
    'POST /auth/login',
    'POST /instructor/projects/upload',
    'POST /instructor/projects/:id/versions/:id/phases/requirements/tasks',
    'GET /instructor/projects/:id/versions/:id/phases/implementation/tasks',
    'PATCH /instructor/projects/:id/versions/:id/phases/implementation/tasks/main',
    'GET /instructor/projects/:id/versions/:id/phases/implementation/tasks',
    'GET /instructor/projects/:id/versions/:id/deep-validation',
    'POST /instructor/projects/:id/versions/:id/deep-validation',
    'GET /instructor/projects/:id/versions/:id/deep-validation',
    'POST /instructor/projects/:id/versions/:id/publish',
    'GET /instructor/projects/:id/versions/:id/export',
    'GET /instructor/projects/:id/versions/:id',
    ...SHELF_PHASES.map((key) => `GET /instructor/projects/:id/versions/:id/phases/${key}/tasks`).slice(0, 2),
  ]);
  assert.equal(tasksOf.length, 2 + 6 + 6);
  assert.deepEqual(calls[1][1], { role: 'INSTRUCTOR' });
  assert.deepEqual(calls[4][1], quizTaskBody());
  assert.equal(calls[6][1].rubric.criteria.find((one) => one.key === EDITED_CRITERION.key).description, EDITED_CRITERION.description);
  const uploads = calls.filter(([key]) => key === 'POST /instructor/projects/upload');
  assert.equal(uploads.length, 2);
  assert.ok(readZip(Buffer.from(uploads[1][1].archiveBase64, 'base64')).has(`phases/01-requirements/quizzes/${ADDED_QUIZ.taskKey}.json`));
  // the comparison reads both published versions
  assert.ok(calls.some(([, , route]) => route.endsWith('/versions/v2/phases/maintenance/tasks')));
});

for (const [name, change, refusal] of [
  ['a version that differs after the round trip', {
    'GET /instructor/projects/:id/versions/:id/phases/implementation/tasks': (route, views) => {
      const phase = clone(views[/\/versions\/(v[12])/.exec(route)[1]][2]);
      if (route.includes('/v2/')) phase.tasks[0].rubric.passThreshold = 60;
      return phase;
    },
  }, "the two versions' task lists differ: implementation: task main's rubric differs"],
  ['an export that withholds sealed files', { 'GET /instructor/projects/:id/versions/:id/export': { archive: Buffer.alloc(0), withheld: 2 } }, 'the export withheld 2 sealed file(s) of a project the teacher owns whole'],
  ['an export in the older layout', { 'GET /instructor/projects/:id/versions/:id/export': { archive: shelfArchive(OLDER_SHELF_DIR), withheld: 0 } }, `the export's project.json still lists its phases; the export holds no phases/01-requirements/quizzes/${ADDED_QUIZ.taskKey}.json; the export holds a canonical/ folder`],
  ['Criteria that did not save', {
    'GET /instructor/projects/:id/versions/:id/phases/implementation/tasks': (route, views) => (route.includes('/v1/') ? shelfViews()[2] : views.v2[2]),
  }, "Implementation's Criteria did not come back as the teacher saved them"],
]) {
  test(`proveRoundTrip refuses ${name}`, async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    stubFetch(twoUploads(roundTripApi(change)));
    await assert.rejects(proveRoundTrip({ api: 'http://api.test', adminToken: 'a', title: 'T', sleep: noSleep }), { message: refusal });
  });
}

test('proveRoundTrip refuses a second upload that warns', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const api = twoUploads(roundTripApi());
  let uploads = 0;
  stubFetch((key, route, body) => {
    const data = api(key, route, body);
    if (key === 'POST /instructor/projects/upload' && (uploads += 1) === 2) return { ...data, warnings: ['left out: a desktop file'] };
    return data;
  });
  await assert.rejects(proveRoundTrip({ api: 'http://api.test', adminToken: 'a', title: 'T', sleep: noSleep }), { message: 'uploading the export again warned: left out: a desktop file' });
});
