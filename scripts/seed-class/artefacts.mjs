// The files a seeded learner had in their workspace at each attempt.
//
// Everything that has a right answer is read off disk (phase 3's and phase 6's
// solutions, the pack's own acceptance suites, the mutants, the deployment
// scaffolds) because a copy here is a copy that drifts, and this script's
// whole claim is that the class it seeds is the class the graders actually
// grade. The prose artefacts (a user story, a design record) come from
// `scripts/golden-artefacts.mjs`, which `scripts/journey.mjs` reads too, and
// the variants below take pieces away from them: a class where everyone scored
// 100 is not a class map worth looking at.
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  DEPLOYMENT_ARTEFACT,
  IMPLEMENTATION_ARTEFACT,
  MAINTENANCE_ARTEFACT,
  MY_API_CONTRACT,
  MY_CI,
  MY_COMPOSE,
  MY_DESIGN_RECORD,
  MY_DOCKERFILE,
  MY_SCREEN_CONTRACT,
  MY_STORY,
  MY_TESTS,
  MY_WEB_TESTS,
  RUNBOOK_RECORD,
  SCAFFOLD_REPOSITORY,
  SOLUTION_REPOSITORY,
} from '../golden-artefacts.mjs';

const {
  DESIGN_JSON, EMPTY_RUNBOOK, RUNBOOK_JSON, STORY_JSON, serialiseDesign, serialiseRunbook, serialiseStory,
} = createRequire(import.meta.url)('@learnsdlc/shared');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACK = path.join(ROOT, 'content', 'tasktrackr');

const read = (...parts) => fs.readFileSync(path.join(PACK, ...parts), 'utf8');

/* ------------------------------- code ----------------------------------- */

/**
 * Half-written work: `list_tasks` done, `overdue_tasks` still the scaffold's
 * TODO. Spliced from the two real files at the gap the pack itself marks, so
 * it is a state a learner is genuinely in rather than a broken file invented for a
 * score. Only the repository is spliced; the other three files are the answer,
 * because a learner who left all five gaps open is `implementation-scaffold`.
 */
const spliceAt = (marker) => {
  const done = SOLUTION_REPOSITORY.indexOf(marker);
  const todo = SCAFFOLD_REPOSITORY.indexOf(marker);
  if (done === -1 || todo === -1) return SCAFFOLD_REPOSITORY;
  return SOLUTION_REPOSITORY.slice(0, done) + SCAFFOLD_REPOSITORY.slice(todo);
};

const withRepository = (source) => ({ ...IMPLEMENTATION_ARTEFACT, 'api/repository/tasks.py': source });

const HALF_WRITTEN = withRepository(spliceAt('\ndef overdue_tasks('));
/** Earlier still: the filter and the report both TODO. */
const EARLY = withRepository(spliceAt('\ndef list_tasks('));

const SCAFFOLD_IMPLEMENTATION = {
  'api/repository/tasks.py': read('phases', '03-implementation', 'files', 'api', 'repository', 'tasks.py'),
  'api/routes/tasks.py': read('phases', '03-implementation', 'files', 'api', 'routes', 'tasks.py'),
  'web/src/lib/overdue.ts': read('phases', '03-implementation', 'files', 'web', 'src', 'lib', 'overdue.ts'),
  'web/src/hooks/useTasks.ts': read('phases', '03-implementation', 'files', 'web', 'src', 'hooks', 'useTasks.ts'),
};

const SCAFFOLD_MAINTENANCE = {
  'api/repository/tasks.py': read('phases', '06-maintenance', 'files', 'api', 'repository', 'tasks.py'),
  'api/repository/comments.py': read('phases', '06-maintenance', 'files', 'api', 'repository', 'comments.py'),
  'api/routes/comments.py': read('phases', '06-maintenance', 'files', 'api', 'routes', 'comments.py'),
  'web/src/components/TaskRow.tsx': read('phases', '06-maintenance', 'files', 'web', 'src', 'components', 'TaskRow.tsx'),
};

/**
 * A learner who is nearly there: the finished implementation with one of the
 * pack's own planted bugs in it. The mutants exist to be a suite's target, and
 * they are exactly the right shape for "passes most of the hidden tests and
 * fails a couple", which is what a stuck learner's score has to look like for
 * the console to be worth reading. Each mutant directory now nests by workspace
 * path (one mutant is a front-end file), so a mutant is a map, not a file.
 */
const MUTANTS_DIR = path.join(PACK, 'phases', '04-testing', 'mutants');

const MUTANT_NAMES = fs
  .readdirSync(MUTANTS_DIR)
  .filter((name) => fs.statSync(path.join(MUTANTS_DIR, name)).isDirectory())
  .sort();

/** Every file a mutant overlays, keyed by its workspace path. */
function mutantFiles(name) {
  const root = path.join(MUTANTS_DIR, name);
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name !== 'meta.json') out[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    }
  };
  walk(root, '');
  return out;
}

/* ------------------------------- tests ---------------------------------- */

/**
 * The reference suites, split into the cases they declare, so a learner's
 * partial suite is a subset of the pack's own rather than a second suite that
 * happens to look like it. Anything the pack changes about a test (a sharper
 * assertion, a renamed case) arrives here on the next run.
 *
 * The API suite is pytest now: module-level `def test_…` functions with a
 * preamble of fixtures and helpers, and section comments that belong to the
 * case below them rather than the one above.
 */
export function splitReferenceSuite(source = MY_TESTS) {
  const lines = source.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (!/^def\s+test_\w+\s*\(/.test(line)) return;
    // A run of comment lines above a test is that test's section heading.
    let start = i;
    while (start > 0 && (lines[start - 1].startsWith('#') || lines[start - 1].trim() === '')) start -= 1;
    while (start < i && lines[start].trim() === '') start += 1;
    starts.push(start);
  });
  const preamble = lines.slice(0, starts[0]).join('\n').replace(/\s+$/, '');
  const cases = new Map();
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const block = lines.slice(start, end);
    while (block.length && block[block.length - 1].trim() === '') block.pop();
    const name = /^def\s+(test_\w+)/m.exec(block.join('\n'))[1];
    cases.set(name, block.join('\n'));
  });
  return { preamble, cases };
}

/** A front-end case is addressed by a slug of its title: the title has commas in it. */
export const webCaseId = (title) =>
  `web:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

/** The same split over the DOM suite: top-level `test('…', …)` blocks. */
export function splitWebSuite(source = MY_WEB_TESTS) {
  const lines = source.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (!/^test\(/.test(line)) return;
    let start = i;
    while (start > 0 && (lines[start - 1].startsWith('/*') || lines[start - 1].trim() === '')) start -= 1;
    while (start < i && lines[start].trim() === '') start += 1;
    starts.push(start);
  });
  const preamble = lines.slice(0, starts[0]).join('\n').replace(/\s+$/, '');
  const cases = new Map();
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const block = lines.slice(start, end);
    while (block.length && block[block.length - 1].trim() === '') block.pop();
    const title = /^test\('(.*?)',/m.exec(block.join('\n'))[1];
    cases.set(webCaseId(title), block.join('\n'));
  });
  return { preamble, cases };
}

/**
 * Two front-end cases that touch neither planted front-end bug: one asserts an
 * empty search box sends no `q` (which the mutant that drops `q` also does) and
 * one asserts a failed request becomes an error. They ride along when a suite
 * names no front-end case at all, so the DOM run has something to report and
 * the pooled test count is not one short of `minTests` for a reason nobody can
 * see.
 */
const HARMLESS_WEB_CASES = [
  webCaseId('a search box with nothing in it is not a search'),
  webCaseId('a failed request becomes an error, not an empty list'),
];

/**
 * A workspace holding exactly these cases, in the pack's own order, across both
 * suites. `names` mixes `test_…` (the API suite) and `web:…` (the DOM suite).
 */
export function partialSuite(names) {
  const wanted = new Set(names);
  const api = splitReferenceSuite();
  const web = splitWebSuite();

  const apiKept = [...api.cases.entries()].filter(([name]) => wanted.has(name));
  const webWanted = [...web.cases.keys()].filter((id) => wanted.has(id));
  const webIds = new Set(webWanted.length ? webWanted : HARMLESS_WEB_CASES);
  const webKept = [...web.cases.entries()].filter(([id]) => webIds.has(id));

  return {
    'tests/test_acceptance.py': `${api.preamble}\n\n\n${apiKept.map(([, body]) => body).join('\n\n\n')}\n`,
    'web/src/acceptance.test.tsx': `${web.preamble}\n\n${webKept.map(([, body]) => body).join('\n\n')}\n`,
  };
}

/* ------------------------------- prose ---------------------------------- */

/**
 * The Requirements variants are story records, each a whole record the room
 * could have saved. The worked answer is what a strong first submission looks
 * like: three criteria and two out-of-scope lines.
 */
const STORY_STRONG = MY_STORY;

/** A benefit that says nothing testable, and a single criterion. */
const STORY_VAGUE = {
  ...MY_STORY,
  benefit: 'the app is more user-friendly and better for me',
  criteria: [MY_STORY.criteria[0]],
};

/**
 * Two criteria, both about the ordinary case: the boundary rule never gets
 * decided, which is the criterion the class map turns red on.
 */
const STORY_NO_BOUNDARY = {
  ...MY_STORY,
  criteria: [
    { id: 'AC-1', given: 'a list holding a task due before today', when: 'I open the overdue page', then: 'that task is on it with its title and the list it came from', tag: 'happy' },
    { id: 'AC-2', given: 'two lists that each hold a task due before today', when: 'I open the overdue page', then: 'both tasks are on it', tag: 'happy' },
  ],
  scopeExclusions: ['reminders and emails', 'any change to how tasks are ordered on the screens that already exist'],
};

/** A first draft: the story sentence and nothing else. Below the gate on purpose. */
const STORY_THIN = {
  id: 'US-4',
  title: 'Overdue report',
  persona: 'busy learner',
  capability: 'an overdue report',
  benefit: 'I know what I have missed',
  criteria: [],
  scopeExclusions: [],
  notes: '',
};

const storyFiles = (story) => ({ [STORY_JSON]: serialiseStory(story) });

const SCAFFOLD_API_CONTRACT = read('phases', '02-design', 'files', 'shared', 'contract', 'api.json');
const SCAFFOLD_SCREEN_CONTRACT = read('phases', '02-design', 'files', 'shared', 'contract', 'screens.json');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Design is its record and the two contracts, each variant a map of all
 * three. The floor sees every one of its thirteen lines pass; the review reads
 * a complete design and passes it.
 */
const DESIGN_STRONG = {
  [DESIGN_JSON]: MY_DESIGN_RECORD,
  'shared/contract/api.json': MY_API_CONTRACT,
  'shared/contract/screens.json': MY_SCREEN_CONTRACT,
};

/**
 * Everything but the overdue operation in the HTTP contract: `getOverdue` is
 * the row the scaffold ships (a method and a path, a blank summary and no
 * success), while the error catalogue stays filled. The floor counts the row
 * and passes, since the record's sequence names getOverdue; the review is what
 * turns the contract back, and it is the node the class map turns red.
 */
const scaffoldOverdue = JSON.parse(SCAFFOLD_API_CONTRACT).operations.find((op) => op.id === 'getOverdue');
const noOverdue = JSON.parse(MY_API_CONTRACT);
noOverdue.operations = noOverdue.operations.map((op) => (op.id === 'getOverdue' ? scaffoldOverdue : op));
const DESIGN_NO_OVERDUE = {
  [DESIGN_JSON]: MY_DESIGN_RECORD,
  'shared/contract/api.json': json(noOverdue),
  'shared/contract/screens.json': MY_SCREEN_CONTRACT,
};

/**
 * A first pass: a valid record holding one class with two attributes and
 * nothing else, no sequence, and the contracts as the scaffold ships them. The
 * floor fails most of its lines (the entities, one of two; relations,
 * operations, decisions, the trace, the error catalogue, the overdue screen,
 * the sequence): below the gate.
 */
const DESIGN_THIN = {
  [DESIGN_JSON]: serialiseDesign({
    entities: [{
      id: 'E1', name: 'Task', kind: 'class',
      attributes: [{ name: 'id', type: 'integer', note: 'assigned by the database' }, { name: 'due_date', type: 'date', note: 'optional calendar date' }],
      responsibilities: [],
      satisfies: [],
    }],
    relations: [],
    operations: [],
    decisions: [],
  }),
  'shared/contract/api.json': SCAFFOLD_API_CONTRACT,
  'shared/contract/screens.json': SCAFFOLD_SCREEN_CONTRACT,
};

/* ----------------------------- deployment -------------------------------- */

/** The config files and the passing runbook record; the incident comes from the drill (replay.mjs). */
const DEPLOYMENT_FULL = DEPLOYMENT_ARTEFACT;

/**
 * The config files and a runbook record holding only its four environment
 * entries: no health check, rollback step or data entry, and no incident.
 * The runbook floor fails, so the gate stays shut.
 */
const DEPLOYMENT_NO_RUNBOOK = {
  'api/Dockerfile': MY_DOCKERFILE,
  'docker-compose.yml': MY_COMPOSE,
  '.github/workflows/ci.yml': MY_CI,
  [RUNBOOK_JSON]: serialiseRunbook({ ...EMPTY_RUNBOOK, environment: JSON.parse(RUNBOOK_RECORD).environment }),
};

/** The three scaffold config files and no record: the version's starting runbook serves. */
const DEPLOYMENT_THIN = {
  'api/Dockerfile': read('phases', '05-deployment', 'files', 'api', 'Dockerfile'),
  'docker-compose.yml': read('phases', '05-deployment', 'files', 'docker-compose.yml'),
  '.github/workflows/ci.yml': read('phases', '05-deployment', 'files', '.github', 'workflows', 'ci.yml'),
};

/* ------------------------------ the map ---------------------------------- */

/**
 * The workspace a variant means, as a `{ path: contents }` map the workspace
 * route accepts. `testing-partial:<case>,<case>` names the acceptance cases the
 * learner had written at that point; everything else is a fixed variant from
 * the lists above.
 */
export function filesFor(variant) {
  if (variant.startsWith('testing-partial:')) {
    return partialSuite(variant.slice('testing-partial:'.length).split(',').filter(Boolean));
  }
  if (variant.startsWith('implementation-mutant:')) {
    // The finished implementation with one of the pack's own planted bugs in
    // it, standing in for the bug a learner has actually written.
    return { ...IMPLEMENTATION_ARTEFACT, ...mutantFiles(variant.slice('implementation-mutant:'.length)) };
  }
  switch (variant) {
    case 'requirements-strong':
      return storyFiles(STORY_STRONG);
    case 'requirements-vague':
      return storyFiles(STORY_VAGUE);
    case 'requirements-no-boundary':
      return storyFiles(STORY_NO_BOUNDARY);
    case 'requirements-thin':
      return storyFiles(STORY_THIN);
    case 'design-strong':
      return { ...DESIGN_STRONG };
    case 'design-no-overdue-contract':
      return { ...DESIGN_NO_OVERDUE };
    case 'design-thin':
      return { ...DESIGN_THIN };
    case 'implementation-solution':
      return { ...IMPLEMENTATION_ARTEFACT };
    case 'implementation-half-written':
      return { ...HALF_WRITTEN };
    case 'implementation-early':
      return { ...EARLY };
    case 'implementation-scaffold':
      return { ...SCAFFOLD_IMPLEMENTATION };
    case 'maintenance-solution':
      return { ...MAINTENANCE_ARTEFACT };
    case 'maintenance-scaffold':
      // The pack's own starting files: the comment repository declared, its
      // bodies still a TODO, and no change request record (the version's
      // starting one serves). The change request has not been done yet.
      return { ...SCAFFOLD_MAINTENANCE };
    case 'testing-reference':
      return { 'tests/test_acceptance.py': MY_TESTS, 'web/src/acceptance.test.tsx': MY_WEB_TESTS };
    case 'deployment-full':
      return { ...DEPLOYMENT_FULL };
    case 'deployment-no-runbook':
      return { ...DEPLOYMENT_NO_RUNBOOK };
    case 'deployment-thin':
      return { ...DEPLOYMENT_THIN };
    default:
      break;
  }
  throw new Error(`no artefact for variant "${variant}"`);
}

/**
 * The learner's own artefact with a passage of the mentor's reply pasted into
 * it: how `mentorPasteFlag` is earned (`feedback.service.ts`, detectMentorPaste
 * matches an eight-word shingle). Never fabricated: the reply is whatever the
 * mentor actually answered this learner, read back off the chat response.
 */
export function withMentorPaste(files, reply) {
  const words = String(reply || '').split(/\s+/).filter(Boolean).slice(0, 45);
  if (words.length < 12) return files;
  const [target] = Object.keys(files);
  if (target === STORY_JSON) {
    // The record takes no free text outside its fields: the paste lands in the
    // notes, where a learner pasting into the form would put it.
    const story = JSON.parse(files[target]);
    const notes = [story.notes, words.join(' ')].filter(Boolean).join(' ');
    return { ...files, [target]: serialiseStory({ ...story, notes }) };
  }
  return { ...files, [target]: `${files[target]}\n\n${words.join(' ')}\n` };
}

export const MUTANTS = MUTANT_NAMES;

/** Every case the pack's reference suites declare, API first, in their own order. */
export const TEST_CASE_NAMES = [...splitReferenceSuite().cases.keys(), ...splitWebSuite().cases.keys()];

/**
 * The assembled suite is a subset of the pack's own, so choosing every case has
 * to give the pack's own files back. If it does not, the pack has grown a test
 * this file's parser cannot see and every seeded learner would be graded
 * against a suite nobody wrote: worth two string comparisons at the top of a
 * ten-minute run.
 */
export function packDrift() {
  const assembled = partialSuite(TEST_CASE_NAMES);
  const flat = (text) => text.replace(/\s+/g, ' ').trim();
  const mismatched = [
    ['tests/test_acceptance.py', MY_TESTS],
    ['web/src/acceptance.test.tsx', MY_WEB_TESTS],
  ].filter(([key, source]) => flat(assembled[key]) !== flat(source));
  if (!mismatched.length) return null;
  return (
    `content/tasktrackr/phases/04-testing/reference has changed shape: assembling every case of ` +
    `${mismatched.map(([key]) => key).join(' and ')} no longer reproduces it. ` +
    `Fix splitReferenceSuite in scripts/seed-class/artefacts.mjs before seeding a class against it.`
  );
}
