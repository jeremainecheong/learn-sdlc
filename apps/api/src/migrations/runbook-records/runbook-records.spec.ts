import { EMPTY_RUNBOOK, RUNBOOK_JSON, serialiseRunbook, validateRunbookRecord } from '@learnsdlc/shared';
import { convertRunbookWorkspace, drillIncidentOf, templateOnlyFiles } from './runbook-records';
import { TASKTRACKR_RUNBOOK_TEMPLATE as T } from './tasktrackr-runbook-template';

const MD = 'RUNBOOK.md';
const filled = T.replace('## Health check', '- TASKTRACKR_DB: where the database lives\n\n## Health check').replace('- Root cause:', '- Root cause: API_URL named localhost');
const drill = { rootCause: 'API_URL named localhost', fix: 'http://api:8000', actionItem: 'Lint compose in CI' };
const head = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'TASKTRACKR_DB', purpose: '', kind: 'config' }] });

test('converts the learner\'s words, removes RUNBOOK.md and nothing else', () => {
  const out = convertRunbookWorkspace({ [MD]: filled, 'api/Dockerfile': 'FROM x' }, { template: T });
  expect(out.outcome).toBe('converted');
  // sorted: 'api/Dockerfile' comes before 'deployment/runbook.json'
  expect(Object.keys(out.workspace).sort()).toEqual(['api/Dockerfile', RUNBOOK_JSON]);
  const runbook = validateRunbookRecord(out.workspace[RUNBOOK_JSON]).runbook!;
  expect(runbook.environment[0]).toMatchObject({ id: 'E1', name: 'TASKTRACKR_DB', purpose: 'where the database lives' });
  expect(runbook.incident.rootCause).toBe('API_URL named localhost');
});
test('lets a drill\'s incident win and keeps the learner\'s incident lines in notes', () => {
  const out = convertRunbookWorkspace({ [MD]: filled }, { template: T, drillIncident: { ...drill, rootCause: 'from the drill' } });
  const runbook = validateRunbookRecord(out.workspace[RUNBOOK_JSON]).runbook!;
  expect(runbook.incident.rootCause).toBe('from the drill');
  expect(runbook.notes).toContain('Kept from RUNBOOK.md, Incident:\nRoot cause: API_URL named localhost');
  expect(out.incidentCopied).toBe(true);
});
test('an untouched template is untouched, unless the drill holds an incident: then the head\'s record is seeded with it', () => {
  expect(convertRunbookWorkspace({ [MD]: T }, { template: T }).outcome).toBe('untouched');
  const seeded = convertRunbookWorkspace({ [MD]: T }, { template: T, drillIncident: drill, headStarting: head });
  expect(seeded.outcome).toBe('seeded');
  expect(validateRunbookRecord(seeded.workspace[RUNBOOK_JSON]).runbook).toMatchObject({ environment: [{ id: 'E1' }], incident: drill });
  expect(seeded.workspace[MD]).toBeUndefined();
});
test('a workspace with no RUNBOOK.md and a drill holding an incident is seeded with the head\'s record and the incident', () => {
  // The one exception: a learner who closed INCIDENT-1 without ever saving RUNBOOK.md keeps the incident in view
  const out = convertRunbookWorkspace({ 'docker-compose.yml': 'x' }, { template: T, drillIncident: drill, headStarting: head });
  expect(out.outcome).toBe('seeded');
  expect(validateRunbookRecord(out.workspace[RUNBOOK_JSON]).runbook!.incident).toEqual(drill);
  expect(out.workspace['docker-compose.yml']).toBe('x');
  expect(convertRunbookWorkspace({ 'docker-compose.yml': 'x' }, { template: T }).outcome).toBe('untouched');
});
test('keeps another learner-written markdown file in notes under its own header', () => {
  const out = convertRunbookWorkspace({ [MD]: filled, 'docs/ops.md': 'Page Sam first.\n' }, { template: T, written: [{ path: MD, template: T }, { path: 'docs/ops.md' }], readOnly: [] });
  expect(validateRunbookRecord(out.workspace[RUNBOOK_JSON]).runbook!.notes).toContain('Kept from docs/ops.md:\nPage Sam first.');
  expect(out.workspace['docs/ops.md']).toBeUndefined();
});
test('refuses, unchanged, words that would not fit, a record it cannot read, and a file that is not text', () => {
  const huge = { [MD]: `## Deploying\n\n${'Keep this line of the learner\'s.\n'.repeat(80)}` };
  const out = convertRunbookWorkspace(huge, { template: T });
  expect(out).toEqual({ workspace: huge, outcome: 'refused', reason: 'the words in RUNBOOK.md would not fit in the runbook record, so it was not changed' });
  const torn = { [RUNBOOK_JSON]: '{', [MD]: filled };
  expect(convertRunbookWorkspace(torn, { template: T })).toEqual({ workspace: torn, outcome: 'refused', reason: 'the runbook record could not be read, so it was not changed' });
  const binary = { [MD]: 7 as unknown as string };
  expect(convertRunbookWorkspace(binary, { template: T }).reason).toBe('RUNBOOK.md is not text, so it was not changed');
});
test('a workspace already holding a valid record and no older file is untouched', () => {
  expect(convertRunbookWorkspace({ [RUNBOOK_JSON]: head }).outcome).toBe('untouched');
});
test('a kept record keeps its lists, and the older file\'s list items go to notes', () => {
  const out = convertRunbookWorkspace({ [RUNBOOK_JSON]: head, [MD]: filled }, { template: T });
  expect(out.outcome).toBe('kept-record');
  const runbook = validateRunbookRecord(out.workspace[RUNBOOK_JSON]).runbook!;
  expect(runbook.environment).toEqual([{ id: 'E1', name: 'TASKTRACKR_DB', purpose: '', kind: 'config' }]);
  expect(runbook.notes).toContain('Kept from RUNBOOK.md, Environment:\nTASKTRACKR_DB: where the database lives');
  expect(runbook.notes).toContain('Kept from RUNBOOK.md, Incident:\nRoot cause: API_URL named localhost');
  expect(out.workspace[MD]).toBeUndefined();
});
test('keeps the words of a list or incident heading the learner reworded, so none vanishes from the converted record', () => {
  const md = T.replace('## Health check', '## Health checks (staging and prod)\n\n- curl -fsS http://api:8000/api/health').replace('## Incident', '## Incident report for the API_URL outage');
  const out = convertRunbookWorkspace({ [MD]: md }, { template: T });
  expect(out.outcome).toBe('converted');
  const runbook = validateRunbookRecord(out.workspace[RUNBOOK_JSON]).runbook!;
  expect(runbook.health).toEqual([{ id: 'H1', name: '', how: 'curl -fsS http://api:8000/api/health', expected: '' }]);
  expect(runbook.notes).toBe('Kept from RUNBOOK.md, Health checks (staging and prod):\n\nKept from RUNBOOK.md, Incident report for the API_URL outage:');
  expect(out.reason).toBe('RUNBOOK.md moved into the record (environment 0, health 1, rollback 0, data 0, 2 group(s) in notes)');
});
test('never reads a RUNBOOK.md the version mounts read-only, and gives TaskTrackr\'s template only to RUNBOOK.md', () => {
  const teacher = '# Ops guide\n\n## Environment\n\n- SECRET_KEY: set by the operator\n\n## Notes\n\nCall the on-call lead.\n';
  expect(convertRunbookWorkspace({ [MD]: teacher }, { written: [], readOnly: [MD] })).toEqual({ workspace: { [MD]: teacher }, outcome: 'untouched' });
  // a version-named file with no mount has no template: the TaskTrackr lines in it are the learner's
  const own = convertRunbookWorkspace({ 'ops/runbook.md': '## Deploying\n\n```\ndocker compose up -d --build\n```\n' }, { written: [{ path: 'ops/runbook.md' }], readOnly: [] });
  expect(own.outcome).toBe('converted');
  expect(validateRunbookRecord(own.workspace[RUNBOOK_JSON]).runbook!.notes).toBe('Kept from ops/runbook.md, Deploying:\ndocker compose up -d --build');
  // RUNBOOK.md named by a task with no mount is still read against TaskTrackr's template
  expect(convertRunbookWorkspace({ [MD]: T }, { written: [{ path: MD }], readOnly: [] }).outcome).toBe('untouched');
});
describe('a record already there keeps its own incident', () => {
  const ownIncident = { rootCause: 'newer root cause from the record', fix: 'newer fix', actionItem: 'newer action', timeline: [{ at: '2026-10-20T00:00:00Z', event: 'Incident closed.' }] };
  const record = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'X', purpose: 'y', kind: 'config' }], incident: ownIncident });
  const stale = { rootCause: 'stale drill root cause', fix: 'stale fix', actionItem: 'stale action' };
  test('over a template-only RUNBOOK.md: kept-record, the file removed, the record as it was', () => {
    const out = convertRunbookWorkspace({ [MD]: T, [RUNBOOK_JSON]: record }, { template: T, drillIncident: stale });
    expect(out).toEqual({ workspace: { [RUNBOOK_JSON]: record }, outcome: 'kept-record', reason: 'RUNBOOK.md held nothing of the learner\'s and was removed, and the record was kept' });
  });
  test('over the learner\'s words: kept-record, the record\'s incident and timeline kept, nothing copied', () => {
    const out = convertRunbookWorkspace({ [MD]: filled, [RUNBOOK_JSON]: record }, { template: T, drillIncident: stale });
    expect(out.outcome).toBe('kept-record');
    expect(out.incidentCopied).toBeUndefined();
    expect(validateRunbookRecord(out.workspace[RUNBOOK_JSON]).runbook!.incident).toEqual(ownIncident);
  });
  test('a record whose incident is empty takes the drill\'s, and says so', () => {
    const empty = serialiseRunbook(EMPTY_RUNBOOK);
    const out = convertRunbookWorkspace({ [MD]: T, [RUNBOOK_JSON]: empty }, { template: T, drillIncident: drill });
    expect(out.outcome).toBe('kept-record');
    expect(out.incidentCopied).toBe(true);
    expect(out.reason).toBe('RUNBOOK.md held nothing of the learner\'s and was removed, and the record was kept with the drill\'s incident');
    expect(validateRunbookRecord(out.workspace[RUNBOOK_JSON]).runbook!.incident).toEqual(drill);
  });
});
test('reads another learner-written file against its own template: untouched adds nothing, a comment of the learner\'s is kept', () => {
  const pm = '# Postmortem\n\n<!-- TODO(learner): the timeline -->\nWrite the postmortem here.\n';
  const written = [{ path: MD, template: T }, { path: 'docs/pm.md', template: pm }];
  expect(convertRunbookWorkspace({ [MD]: T, 'docs/pm.md': pm }, { written, readOnly: [] }).outcome).toBe('untouched');
  const out = convertRunbookWorkspace({ [MD]: T, 'docs/pm.md': `${pm}<!-- my own note: page Sam -->\n` }, { written, readOnly: [] });
  expect(out.outcome).toBe('converted');
  expect(validateRunbookRecord(out.workspace[RUNBOOK_JSON]).runbook!.notes).toBe('Kept from docs/pm.md:\n# Postmortem\n\n\nWrite the postmortem here.\nmy own note: page Sam');
  expect(Object.keys(out.workspace)).toEqual([RUNBOOK_JSON]);
});
test('reads a stored drill\'s incident as text or parsed, and a malformed one as none or as empty fields, never throwing', () => {
  expect(drillIncidentOf(JSON.stringify({ incident: drill }))).toEqual(drill);
  expect(drillIncidentOf({ fault: 'api-url', incident: drill })).toEqual(drill);
  for (const none of [null, undefined, '', '{ broken', 'null', '"text"', 42, { incident: null }, { incident: 'not an incident' }, { incident: ['a'] }, { fault: 'api-url' }]) {
    expect(drillIncidentOf(none)).toBeNull();
  }
  expect(drillIncidentOf({ incident: { rootCause: null, fix: 7, actionItem: 'Lint compose in CI' } })).toEqual({ rootCause: '', fix: '', actionItem: 'Lint compose in CI' });
  // a malformed incident handed through it is never trimmed as text it is not
  expect(convertRunbookWorkspace({}, { template: T, drillIncident: drillIncidentOf({ incident: { rootCause: null, fix: null, actionItem: null } }) }).outcome).toBe('untouched');
});
test('lists only the learner-written files equal to their version\'s own template', () => {
  const pm = '# Postmortem\n\n<!-- TODO(learner): the timeline -->\n';
  const sources = { written: [{ path: MD, template: T }, { path: 'docs/pm.md', template: pm }, { path: 'docs/free.md' }], readOnly: [] };
  // whitespace collapsed is still the template; a line deleted, a comment of the learner's, or no mount text is not
  expect(templateOnlyFiles({ [MD]: `${T}\n\n`, 'docs/pm.md': pm, 'docs/free.md': '' }, sources, MD)).toEqual([MD, 'docs/pm.md']);
  expect(templateOnlyFiles({ [MD]: T.replace('## Data\n', ''), 'docs/pm.md': `${pm}<!-- mine -->` }, sources, MD)).toEqual([]);
  // with no version to read, the default file has no template of the version's own and is never listed
  expect(templateOnlyFiles({ [MD]: T }, null, MD)).toEqual([]);
});
