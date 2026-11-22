#!/usr/bin/env node
// An exported project uploads again to the same tasks, through the API: a
// fresh teacher account uploads Shelf (its own project, owned whole, so the
// export withholds nothing), adds a concept quiz beside Requirements' work
// task, rewords and reweighs Implementation's Criteria, runs deep validation
// and publishes; exports that version, uploads the archive the export wrote
// as a second project, runs deep validation and publishes it; and compares
// the two published versions' compiled task lists as the editor's routes
// serve them (`GET .../versions/:id`, then `GET .../phases/:key/tasks` for
// each phase).
//
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/export-roundtrip.mjs [--api http://localhost:4080/api/v1] [--title "Shelf round trip"]
//
// scripts/prove-local.mjs imports `proveRoundTrip` for the proof's "Teacher
// exports a project and uploads it again, and the versions match" step.
//
// The export writes the folder layout (one `phases/<place>-<key>/` per phase,
// each quiz as `quizzes/<task key>.json`, no phase list in project.json and no
// `canonical/`), and the upload door reads either layout, so the first upload
// (Shelf as the fixture holds it) and the second (the export) both pass
// through the door. Every text the editor serves is the stored plain text on
// both sides (the door stores plain text; the export writes it), so the texts
// are compared as served, with no conversion here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { call } from './author-common.mjs';
import { deepValidate, freshTeacher, runAsAdminWhenMain, uploadAndPublish, versionRoute } from './author-subset.mjs';
import { zipPackDirectory } from './pack-archive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The Shelf fixture the proof's other upload step uses too. */
export const SHELF_DIR = path.join(ROOT, 'apps/api/test/fixtures/upload-packs/shelf');

/** The archive the teacher uploads first: the Shelf fixture, pack root at the archive root. */
export function shelfArchive(dir = SHELF_DIR) {
  if (!fs.existsSync(path.join(dir, 'project.json'))) throw new Error(`${path.relative(ROOT, dir)} holds no project.json`);
  return zipPackDirectory(dir);
}

/* ------------------------------------------------------------ the archive */

/**
 * Every entry of a zip archive, by name, with its bytes: the central
 * directory read from the end record, each entry stored (0) or deflated (8).
 * Enough for the archives this repository writes (pack-archive.mjs) and the
 * export answers; anything else throws by name.
 * @returns {Map<string, Buffer>}
 */
export function readZip(archive) {
  const buf = Buffer.isBuffer(archive) ? archive : Buffer.from(archive);
  let end = -1;
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at--) {
    if (buf.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('the archive has no end-of-directory record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('the archive directory is not where its end record says');
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name} has no local header where the directory says`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + packed);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    else throw new Error(`${name} is compressed with method ${method}, which this reader does not read`);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/**
 * The folder inside an archive its pack starts at, read as the upload door's
 * `packRootOf` reads it: none when project.json is at the top, else the one
 * top folder (a macOS `__MACOSX/` beside it set aside) that holds a
 * project.json. The export writes every entry under the project's slug, so
 * its pack starts one folder down. An archive the door would refuse for
 * want of a project.json reads as starting at the top, where the layout
 * check then names the missing file.
 */
export function packRootOf(names) {
  if (names.includes('project.json')) return '';
  const tops = new Set(names.map((name) => name.split('/')[0]));
  tops.delete('__MACOSX');
  if (tops.size === 1) {
    const [top] = [...tops];
    if (names.includes(`${top}/project.json`)) return top;
  }
  return '';
}

/**
 * What the proof checks of the archive the export wrote, as sentences (none
 * when it holds): the folder layout (a project.json with no phase list, one
 * folder per phase numbered by place), the quiz as its own file under its
 * phase, and no `canonical/`. Every path is read from the pack's root
 * (`packRootOf`), as the upload door reads the archive.
 */
export function exportLayoutFaults(entries, { phases, quiz }) {
  const faults = [];
  const root = packRootOf([...entries.keys()]);
  const prefix = root ? `${root}/` : '';
  const names = [...entries.keys()].filter((name) => !name.endsWith('/') && name.startsWith(prefix)).map((name) => name.slice(prefix.length));
  const meta = entries.get(`${prefix}project.json`);
  if (!meta) faults.push('the export holds no project.json');
  else {
    let parsed = null;
    try {
      parsed = JSON.parse(meta.toString('utf8'));
    } catch {
      faults.push('the export\'s project.json is not JSON');
    }
    if (parsed && 'phases' in parsed) faults.push('the export\'s project.json still lists its phases');
  }
  const folders = [...new Set(names.filter((name) => name.startsWith('phases/')).map((name) => name.split('/')[1]))].sort();
  const wanted = phases.map((key, i) => `${String(i + 1).padStart(2, '0')}-${key}`);
  if (folders.join(',') !== wanted.join(',')) faults.push(`the export's phase folders are ${folders.join(', ') || 'none'}, not ${wanted.join(', ')}`);
  if (quiz) {
    const folder = wanted[phases.indexOf(quiz.phase)];
    const at = `phases/${folder}/quizzes/${quiz.taskKey}.json`;
    if (!names.includes(at)) faults.push(`the export holds no ${at}`);
  }
  if (names.some((name) => name.startsWith('canonical/'))) faults.push('the export holds a canonical/ folder');
  return faults;
}

/* --------------------------------------------------------- the comparison */

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A value as the comparison reads it: object members in name order, absent
 * members left out, and two kinds of list read in path order (spec 7.2's
 * mount order, as the export's own read-back compares, N3): a task's `owns`,
 * and a list of objects that each carry a `path` (the sealed files of an
 * executable task). Every other list keeps its order, which is meaning.
 */
export function canonical(value, name = '') {
  if (Array.isArray(value)) {
    let list = value;
    if (name === 'owns' && list.every((one) => typeof one === 'string')) list = [...list].sort(byCodeUnits);
    else if (list.length && list.every((one) => one && typeof one === 'object' && typeof one.path === 'string')) list = [...list].sort((a, b) => byCodeUnits(a.path, b.path));
    return list.map((one) => canonical(one));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort(byCodeUnits)) if (value[key] !== undefined) out[key] = canonical(value[key], key);
    return out;
  }
  return value;
}

/**
 * One version's compiled task lists as the comparison reads them: each phase
 * by key, order, title and intro, with its tasks whole (an absent sign-off
 * mark reads false, as the editor reads it).
 */
export function comparableTaskLists(phases) {
  return phases.map((phase) => ({
    key: phase.key,
    order: phase.order,
    title: phase.title,
    intro: phase.intro,
    tasks: (phase.tasks ?? []).map((task) => canonical({ ...task, signOff: task.signOff === true })),
  }));
}

/**
 * Where two versions' task lists differ, one sentence each (none when they
 * match): a phase missing or out of place, a phase field, a task missing or
 * extra, a task out of place, or a task member, named by phase key, task key
 * (`main` for a phase's sole task) and member.
 */
export function taskListDifferences(first, second) {
  const a = comparableTaskLists(first);
  const b = comparableTaskLists(second);
  const out = [];
  const keys = (list) => list.map((one) => one.key).join(', ');
  if (keys(a) !== keys(b)) return [`the phases are ${keys(a) || 'none'} on one side and ${keys(b) || 'none'} on the other`];
  a.forEach((phase, i) => {
    const other = b[i];
    for (const field of ['order', 'title', 'intro']) if (phase[field] !== other[field]) out.push(`${phase.key}: its ${field} differs`);
    const taskKeys = (list) => list.map((task) => task.taskKey || 'main');
    const mine = taskKeys(phase.tasks);
    const theirs = taskKeys(other.tasks);
    for (const key of mine) if (!theirs.includes(key)) out.push(`${phase.key}: task ${key} is missing from the second version`);
    for (const key of theirs) if (!mine.includes(key)) out.push(`${phase.key}: task ${key} is only in the second version`);
    phase.tasks.forEach((task, n) => {
      const key = task.taskKey || 'main';
      const at = theirs.indexOf(key);
      if (at < 0) return;
      if (at !== n) out.push(`${phase.key}: task ${key} is in place ${n + 1} on one side and ${at + 1} on the other`);
      const twin = other.tasks[at];
      for (const member of [...new Set([...Object.keys(task), ...Object.keys(twin)])].sort(byCodeUnits)) {
        if (JSON.stringify(task[member]) !== JSON.stringify(twin[member])) out.push(`${phase.key}: task ${key}'s ${member} differs`);
      }
    });
  });
  return out;
}

/* ------------------------------------------------------------ the edits */

/** The concept quiz the teacher adds beside Requirements' work task: optional, four questions, three drawn. */
export const ADDED_QUIZ = Object.freeze({ phase: 'requirements', taskKey: 'shelf-concepts' });

/** `POST .../phases/requirements/tasks`: the quiz as the editor's quiz form sends it (`AddTaskBody`), every text plain. */
export function quizTaskBody() {
  const questions = [
    ['story-who', 'Which part of a user story names who wants it?', 'The persona', 'The acceptance criterion'],
    ['story-boundary', 'Which criterion tag covers a book that is already on loan?', 'boundary', 'happy'],
    ['scope-line', 'What does an out-of-scope line say?', 'What the story leaves out', 'How the story is tested'],
    ['criteria-form', 'Which form does an acceptance criterion take?', 'Given, When, Then', 'As a, I want, so that'],
  ].map(([id, stem, right, wrong]) => ({
    id,
    stem,
    options: [{ id: 'a', text: right }, { id: 'b', text: wrong }],
    correct: ['a'],
    explanation: `${right} is the answer the shelf's Requirements phase asks for.`,
  }));
  return {
    taskKey: ADDED_QUIZ.taskKey,
    title: 'Shelf story concepts',
    brief: 'Four short questions on how a story is written before you write SH-5.',
    artefactType: 'quiz',
    required: false,
    quiz: { questions, drawn: 3, shuffleOptions: true, passMark: 70, attempts: { max: 3, cooldownSeconds: null } },
  };
}

/** The new sentence the teacher gives Implementation's code-quality criterion. */
export const EDITED_CRITERION = Object.freeze({
  key: 'code_quality',
  description: 'Each gap is filled with the smallest change that makes the rule true, and no TODO is left behind.',
});

/**
 * Implementation's rubric as the Criteria card saves it: the fixed criteria
 * kept by key, the code-quality sentence replaced and five hundredths of
 * weight moved to it from the hidden-test criterion, so the weights still sum
 * to 1. Throws when the rubric is not one it can edit that way.
 */
export function editedRubric(rubric) {
  const criteria = (rubric?.criteria ?? []).map((one) => ({ ...one }));
  const quality = criteria.find((one) => one.key === EDITED_CRITERION.key);
  const hidden = criteria.find((one) => one.key === 'correctness_hidden');
  if (!quality || !hidden || hidden.weight < 0.1) throw new Error("Implementation's rubric has no code-quality and hidden-test criteria to edit");
  quality.description = EDITED_CRITERION.description;
  quality.weight = Math.round((quality.weight + 0.05) * 100) / 100;
  hidden.weight = Math.round((hidden.weight - 0.05) * 100) / 100;
  return editedRubricShape({ passThreshold: rubric.passThreshold, criteria });
}

/** A rubric by the members the Criteria card saves: the pass threshold and each criterion's key, title, description and weight. */
export function editedRubricShape(rubric) {
  return {
    passThreshold: rubric?.passThreshold,
    criteria: (rubric?.criteria ?? []).map(({ key, title, description, weight }) => ({ key, title, description, weight })),
  };
}

/** A phase's work task (its one task that is not a quiz) and the key its route takes (`main` for the sole task). */
function workTaskOf(phaseView) {
  const task = (phaseView.tasks ?? []).find((one) => one.artefactType !== 'quiz' && one.checkKind !== 'quiz');
  if (!task) throw new Error(`${phaseView.key} holds no work task`);
  return { task, routeKey: task.taskKey || 'main' };
}

/** One version's phases with their task lists, read through the editor's routes. */
export async function editorTaskLists({ api, token, projectId, versionId }) {
  const at = versionRoute(projectId, versionId);
  const view = await call(api, token, 'GET', at);
  const phases = [];
  for (const phase of view.phases ?? []) phases.push(await call(api, token, 'GET', `${at}/phases/${phase.key}/tasks`));
  return { version: view, phases };
}

/** The export of one version, as its bytes and the count of sealed files it withheld. */
async function exportArchive({ api, token, projectId, versionId }) {
  const res = await fetch(`${api}${versionRoute(projectId, versionId)}/export`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`GET ${versionRoute(':id', ':id')}/export answered ${res.status}: ${String(data?.message ?? JSON.stringify(data)).slice(0, 240)}`);
  }
  return { archive: Buffer.from(await res.arrayBuffer()), withheld: Number(res.headers.get('x-export-withheld') ?? '0') };
}

/**
 * The whole step: a fresh teacher uploads Shelf, adds the quiz, edits the
 * Criteria, publishes, exports, uploads the export, publishes it, and the two
 * versions' task lists are compared. Returns the line the proof prints.
 */
export async function proveRoundTrip({ api, adminToken, title, dir = SHELF_DIR, sleep }) {
  const { token } = await freshTeacher({ api, adminToken, tag: 'roundtrip-teacher' });

  const made = await call(api, token, 'POST', '/instructor/projects/upload', { title, archiveBase64: shelfArchive(dir).toString('base64') });
  if (!made.projectId || !made.versionId) throw new Error('the upload answered without a project');
  const at = versionRoute(made.projectId, made.versionId);
  await call(api, token, 'POST', `${at}/phases/${ADDED_QUIZ.phase}/tasks`, quizTaskBody());
  const implementation = await call(api, token, 'GET', `${at}/phases/implementation/tasks`);
  const { task, routeKey } = workTaskOf(implementation);
  const rubric = editedRubric(task.rubric);
  await call(api, token, 'PATCH', `${at}/phases/implementation/tasks/${routeKey}`, { rubric });
  // what the Criteria card sent, read back by the members it sent
  const saved = editedRubricShape(workTaskOf(await call(api, token, 'GET', `${at}/phases/implementation/tasks`)).task.rubric);
  if (JSON.stringify(canonical(saved)) !== JSON.stringify(canonical(rubric))) throw new Error("Implementation's Criteria did not come back as the teacher saved them");
  await deepValidate({ api, token, at, sleep });
  const published = await call(api, token, 'POST', `${at}/publish`, { version: '1.0.0', notes: 'Shelf with a concept quiz and reworded Implementation criteria.' });
  const first = { projectId: made.projectId, versionId: published.versionId ?? made.versionId };

  const { archive, withheld } = await exportArchive({ api, token, ...first });
  if (withheld !== 0) throw new Error(`the export withheld ${withheld} sealed file(s) of a project the teacher owns whole`);
  const before = await editorTaskLists({ api, token, ...first });
  const faults = exportLayoutFaults(readZip(archive), { phases: before.phases.map((one) => one.key), quiz: ADDED_QUIZ });
  if (faults.length) throw new Error(faults.join('; '));

  const second = await uploadAndPublish({ api, token, title: `${title} again`, archive, notes: 'The exported Shelf, uploaded again.', sleep });
  const warnings = second.upload.warnings ?? [];
  if (warnings.length) throw new Error(`uploading the export again warned: ${warnings.map((one) => (typeof one === 'string' ? one : one?.sentence ?? JSON.stringify(one))).join(' | ').slice(0, 400)}`);
  const after = await editorTaskLists({ api, token, projectId: second.projectId, versionId: second.versionId });
  const differences = taskListDifferences(before.phases, after.phases);
  if (differences.length) throw new Error(`the two versions' task lists differ: ${differences.slice(0, 8).join('; ')}${differences.length > 8 ? `; and ${differences.length - 8} more` : ''}`);
  const tasks = before.phases.reduce((n, phase) => n + (phase.tasks ?? []).length, 0);
  return `a fresh teacher uploaded Shelf, added a concept quiz to Requirements, reworded and reweighed Implementation's Criteria, and published; the export (${archive.length} bytes, ${before.phases.length} phase folders, the quiz as its own file, nothing withheld) uploaded again with no warning and published, and the two versions hold the same ${tasks} tasks over ${before.phases.length} phases`;
}

runAsAdminWhenMain(import.meta.url, proveRoundTrip, 'Shelf round trip');
