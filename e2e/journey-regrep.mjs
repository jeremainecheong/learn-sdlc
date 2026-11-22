#!/usr/bin/env node
/**
 * Re-run the teacher-upload journey's greps
 * offline, over the bodies the journey saved.
 *
 *   node e2e/journey-regrep.mjs [<epoch folder>]
 *
 * With no folder it reads the newest epoch under test-results/journey-bodies/
 * (or E2E_JOURNEY_BODIES_DIR, when set), where the
 * journey saves them (e2e/upload-helpers.ts, journeyBodiesRoot). For every saved body it checks the file against
 * manifest.json (sha256 and bytes), counts the same needles the journey
 * counted (the TaskTrackr words and the shelf fixture's sealed markers, read again from
 * their sources, and the run's seal marker from the manifest), and compares
 * each count with the live one. Then it scans every saved file for a token,
 * an email address, a host name, an id and a join-code shape.
 *
 * Exit 0 only when the folder holds bodies of a journey that finished green
 * (manifest.completion.complete, and at least 32 learner page bodies), every file matches, every recount
 * equals the live count, no uploaded-project learner page and no learner
 * response holds a sealed marker, no learner page holds a TaskTrackr word, and
 * the scan finds nothing. It prints counts, never a body.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const fail = (why) => {
  console.error(`journey-regrep: FAIL ${why}`);
  process.exit(1);
};

/* ---------------------------- the needle sources --------------------------- */

function shelfMarkers() {
  const src = readFileSync(join(repo, 'apps/api/test/fixtures/upload-packs/markers.ts'), 'utf8');
  const block = /export const SHELF_MARKERS = \{([\s\S]*?)\} as const;/.exec(src);
  if (!block) fail('SHELF_MARKERS not found in markers.ts');
  return [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
}

function tasktrackrSentinels() {
  const src = readFileSync(join(repo, 'apps/api/test/fixtures/upload-packs/markers.ts'), 'utf8');
  const block = /export const TASKTRACKR_SENTINELS: readonly string\[\] = \[([\s\S]*?)\];/.exec(src);
  if (!block) fail('TASKTRACKR_SENTINELS not found in markers.ts');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function tasktrackrWords() {
  const src = readFileSync(join(repo, 'e2e/upload-helpers.ts'), 'utf8');
  const line = /export const TASKTRACKR_WORDS: readonly string\[\] = \[([^\]]*)\]/.exec(src);
  if (!line) fail('TASKTRACKR_WORDS not found in e2e/upload-helpers.ts');
  return [...line[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/* ------------------------------- the folder -------------------------------- */

function bodiesRoot() {
  const fromEnv = process.env.E2E_JOURNEY_BODIES_DIR;
  return fromEnv ? resolve(fromEnv) : join(repo, 'test-results', 'journey-bodies');
}

function pickEpoch() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const root = bodiesRoot();
  if (!existsSync(root)) fail(`no bodies saved (no folder ${root.replace(repo + '/', '')})`);
  const epochs = readdirSync(root)
    .filter((name) => /^\d+$/.test(name) && statSync(join(root, name)).isDirectory())
    .sort((a, b) => Number(b) - Number(a));
  if (epochs.length === 0) fail(`no bodies saved (no epoch under ${root.replace(repo + '/', '')})`);
  return join(root, epochs[0]);
}

const dir = pickEpoch();
const where = dir.startsWith(repo) ? dir.slice(repo.length + 1) : dir;
if (!existsSync(dir)) fail(`no bodies saved (no folder ${where})`);
const manifestFile = join(dir, 'manifest.json');
if (!existsSync(manifestFile)) fail(`no bodies saved (no manifest.json in ${where})`);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
if (entries.length === 0) fail(`no bodies saved (the manifest in ${where} lists none)`);

/* ------------------------------- the needles ------------------------------- */

const NEEDLES = {
  TASKTRACKR_WORDS: tasktrackrWords(),
  SHELF_MARKER_VALUES: shelfMarkers(),
  SEAL_MARKER: Array.isArray(manifest.needles?.SEAL_MARKER) ? manifest.needles.SEAL_MARKER : [],
};
for (const name of ['TASKTRACKR_WORDS', 'SHELF_MARKER_VALUES']) {
  const recorded = JSON.stringify(manifest.needles?.[name] ?? []);
  if (recorded !== JSON.stringify(NEEDLES[name])) fail(`${name}: the manifest's list differs from its source`);
}
if (NEEDLES.SEAL_MARKER.some((one) => !/^SEAL-MARK-[0-9A-F]{8}$/.test(one))) fail('SEAL_MARKER: not the journey seal-marker shape');

const count = (text, needles) => needles.filter((one) => text.includes(one)).length;
// The API fixtures' wider list (markers.ts TASKTRACKR_SENTINELS, which adds the lower-case name), counted on learner pages too.
const SENTINELS = tasktrackrSentinels();
let learnerPageSentinelHits = 0;

/* ------------------------------- the shapes -------------------------------- */

const SHAPES = {
  token: /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  host: /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|sg|edu|cloud|app|ai|amazonaws)\b/gi,
  id: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  joinCode: /\b[A-Z2-9]{4}-[A-Z2-9]{4}\b/g,
  // the API's own undashed form (cohorts.service.ts JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH 8): under a code key, or a
  // quoted 8-symbol value of that alphabet that mixes letters and digits
  joinCodeBare: /"(?:joinCode|code|inviteCode|invitationCode)"\s*:\s*"[A-HJ-NP-Z2-9]{8}"|"(?=[^"]{0,7}[2-9])(?=[^"]{0,7}[A-HJ-NP-Z])[A-HJ-NP-Z2-9]{8}"/g,
};

// A complete green journey saves 16 learner room views, each as innerText and content() (step 10 and the rooms
// before it); fewer means the epoch is partial, whatever its manifest says.
const MIN_LEARNER_PAGES = 32;

/* --------------------------------- the run --------------------------------- */

const problems = [];
const shapeHits = Object.fromEntries(Object.keys(SHAPES).map((k) => [k, 0]));
const totals = {
  learnerPages: { bodies: 0, bytes: 0, TASKTRACKR_WORDS: 0, markers: 0 },
  otherPages: { bodies: 0, bytes: 0, TASKTRACKR_WORDS: 0, markers: 0 },
  learnerResponses: { bodies: 0, bytes: 0, TASKTRACKR_WORDS: 0, markers: 0 },
  downloads: { bodies: 0, bytes: 0, TASKTRACKR_WORDS: 0, markers: 0 },
};
const responsesWithTaskTrackr = new Map();

for (const entry of entries) {
  const file = join(dir, entry.path);
  if (!existsSync(file)) {
    problems.push(`${entry.path}: missing`);
    continue;
  }
  const bytes = readFileSync(file);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== entry.sha256 || bytes.length !== entry.bytes) problems.push(`${entry.path}: sha256/bytes differ from the manifest`);
  const text = bytes.toString('utf8');
  for (const [name, re] of Object.entries(SHAPES)) shapeHits[name] += (text.match(re) ?? []).length;
  const recount = {};
  for (const name of entry.grep ?? []) {
    recount[name] = count(text, NEEDLES[name] ?? []);
    if (recount[name] !== (entry.liveHits?.[name] ?? 0)) problems.push(`${entry.path}: ${name} recount ${recount[name]} != live ${entry.liveHits?.[name] ?? 0}`);
  }
  const tt = count(text, NEEDLES.TASKTRACKR_WORDS);
  const mk = count(text, [...NEEDLES.SHELF_MARKER_VALUES, ...NEEDLES.SEAL_MARKER]);
  const bucket =
    entry.source === 'response'
      ? totals.learnerResponses
      : entry.source === 'download'
        ? totals.downloads
        : entry.learnerFacing
          ? totals.learnerPages
          : totals.otherPages;
  bucket.bodies += 1;
  bucket.bytes += bytes.length;
  bucket.TASKTRACKR_WORDS += tt;
  bucket.markers += mk;
  if (bucket === totals.learnerPages) learnerPageSentinelHits += count(text, SENTINELS);
  if (entry.source === 'response' && tt > 0) {
    const key = String(entry.label).replace(/^\S+ \S+ /, '').replace(/ \d{3} /, ' ');
    responsesWithTaskTrackr.set(key, (responsesWithTaskTrackr.get(key) ?? 0) + 1);
  }
}

// Frames: present and matching (they are pictures, so they are not grepped).
let frames = 0;
for (const frame of manifest.frames ?? []) {
  const file = join(dir, frame.path);
  if (!existsSync(file)) {
    problems.push(`${frame.path}: missing`);
    continue;
  }
  const bytes = readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== frame.sha256) problems.push(`${frame.path}: sha256 differs`);
  frames += 1;
}

// A failed or cut-short run leaves a newest epoch too: it proves nothing, so it never passes.
const completion = manifest.completion;
if (!completion || completion.complete !== true) {
  problems.push(
    `incomplete epoch: the journey did not finish green (${completion ? `${completion.testsPassed} passed, ${(completion.testsNotPassed ?? []).length} not passed, last test reached ${completion.reachedLastTest === true}` : 'no completion record'})`,
  );
}
if (totals.learnerPages.bodies < MIN_LEARNER_PAGES) problems.push(`only ${totals.learnerPages.bodies} learner page bodies (a complete journey saves at least ${MIN_LEARNER_PAGES})`);
if (totals.learnerPages.TASKTRACKR_WORDS > 0) problems.push(`learner pages hold ${totals.learnerPages.TASKTRACKR_WORDS} TaskTrackr word hit(s)`);
if (learnerPageSentinelHits > 0) problems.push(`learner pages hold ${learnerPageSentinelHits} TASKTRACKR_SENTINELS hit(s)`);
if (totals.learnerPages.markers > 0) problems.push(`learner pages hold ${totals.learnerPages.markers} sealed marker hit(s)`);
if (totals.learnerResponses.markers > 0) problems.push(`learner responses hold ${totals.learnerResponses.markers} sealed marker hit(s)`);
if (totals.downloads.markers > 0) problems.push(`downloads hold ${totals.downloads.markers} sealed marker hit(s)`);
for (const [name, hits] of Object.entries(shapeHits)) if (hits > 0) problems.push(`saved bodies hold ${hits} ${name} shape(s)`);

console.log(`journey-regrep: epoch ${manifest.epoch} (${where})`);
console.log(`  needles: TASKTRACKR_WORDS ${NEEDLES.TASKTRACKR_WORDS.length}, SHELF_MARKER_VALUES ${NEEDLES.SHELF_MARKER_VALUES.length}, SEAL_MARKER ${NEEDLES.SEAL_MARKER.length}`);
for (const [name, t] of Object.entries(totals)) {
  console.log(`  ${name}: ${t.bodies} bodies, ${t.bytes} bytes, TaskTrackr hits ${t.TASKTRACKR_WORDS}, sealed-marker hits ${t.markers}`);
}
console.log(`  learner pages, TASKTRACKR_SENTINELS (${SENTINELS.length} words, markers.ts): ${learnerPageSentinelHits} hits`);
for (const [route, n] of responsesWithTaskTrackr) console.log(`  learner response with a TaskTrackr word (reported, not a page): ${route} x${n}`);
console.log(`  exclusions: ${(manifest.exclusions ?? []).length} (${[...new Set((manifest.exclusions ?? []).map((one) => one.reason))].join('; ') || 'none'})`);
console.log(`  frames: ${frames}`);
console.log(`  completion: ${completion ? `complete ${completion.complete === true}, ${completion.testsPassed} passed, ${(completion.testsNotPassed ?? []).length} not passed` : 'none recorded'}; learner page bodies ${totals.learnerPages.bodies} (min ${MIN_LEARNER_PAGES})`);
console.log(`  shapes in saved bodies: ${Object.entries(shapeHits).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (problems.length) fail(`${problems.length} problem(s): ${problems.slice(0, 12).join(' | ')}`);
console.log('journey-regrep: PASS');
