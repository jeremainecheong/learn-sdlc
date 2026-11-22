import { CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest, validateChangeRequestRecord } from '@learnsdlc/shared';
import { convertChangeWorkspace } from './change-records';
import { TASKTRACKR_CHANGELOG_TEMPLATE as T } from './tasktrackr-changelog-template';

const MD = 'CHANGELOG.md';
const starting = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, release: { ...EMPTY_CHANGE_REQUEST.release, version: '2.1.0' } });
test('takes the newest entry as the release on the version\'s starting record', () => {
  const md = T.replace('## 2.1.0', '## 2.1.0\n\n### Added\n- Comments on a task.');
  const out = convertChangeWorkspace({ [MD]: md, 'api/repository/comments.py': 'x' }, { template: T, starting });
  expect(out.outcome).toBe('converted');
  const change = validateChangeRequestRecord(out.workspace[CHANGE_REQUEST_JSON], null).change!;
  expect(change.release).toMatchObject({ version: '2.1.0', changes: [{ id: 'L1', line: 'Added: Comments on a task.', covers: [] }] });
  expect(Object.keys(out.workspace).sort()).toEqual(['api/repository/comments.py', CHANGE_REQUEST_JSON]);
});
test('an untouched changelog is untouched; overflowing words are refused unchanged', () => {
  expect(convertChangeWorkspace({ [MD]: T }, { template: T, starting }).outcome).toBe('untouched');
  const huge = { [MD]: `# Changelog\n\n${'A line the learner wrote above the entries.\n'.repeat(60)}` };
  expect(convertChangeWorkspace(huge, { template: T, starting })).toEqual({ workspace: huge, outcome: 'refused', reason: 'the words in CHANGELOG.md would not fit in the change request record, so it was not changed' });
});
test('a kept record keeps its release, and the older file\'s release lines go to notes; a record it cannot read is refused unchanged', () => {
  const md = T.replace('## 2.1.0', '## 2.1.0\n\n### Added\n- Comments on a task.');
  const out = convertChangeWorkspace({ [MD]: md, [CHANGE_REQUEST_JSON]: starting }, { template: T });
  expect(out.outcome).toBe('kept-record');
  const change = validateChangeRequestRecord(out.workspace[CHANGE_REQUEST_JSON], null).change!;
  expect(change.release.changes).toEqual([]);
  expect(change.notes).toBe('Kept from CHANGELOG.md, Release 2.1.0:\nAdded: Comments on a task.');
  expect(Object.keys(out.workspace)).toEqual([CHANGE_REQUEST_JSON]);
  const torn = { [CHANGE_REQUEST_JSON]: '{', [MD]: md };
  expect(convertChangeWorkspace(torn, { template: T })).toEqual({ workspace: torn, outcome: 'refused', reason: 'the change request record could not be read, so it was not changed' });
  expect(convertChangeWorkspace({ [CHANGE_REQUEST_JSON]: starting }).outcome).toBe('untouched');
});
test('keeps a subheading of the learner\'s whose only line was the template\'s comment, and one reworded over the template\'s lines', () => {
  const md = T.replace('## 2.1.0', '## 2.1.0 Comments on tasks\n\n### Added\n- add_comment\n\n### Empty sub').replace('### Added\n- Lists', '### Added in the first release\n- Lists');
  const out = convertChangeWorkspace({ [MD]: md }, { template: T, starting });
  expect(out.outcome).toBe('converted');
  const change = validateChangeRequestRecord(out.workspace[CHANGE_REQUEST_JSON], null).change!;
  expect(change.release.changes).toEqual([{ id: 'L1', line: 'Added: add_comment', covers: [] }]);
  expect(change.notes).toBe('Kept from CHANGELOG.md:\n### Empty sub\n2.0.0: ### Added in the first release');
});
test('never reads a CHANGELOG.md the version mounts read-only, and an untouched second file adds nothing', () => {
  expect(convertChangeWorkspace({ [MD]: '## 9.9.9\n\n- the teacher\'s line\n' }, { written: [], readOnly: [MD] }).outcome).toBe('untouched');
  const notes = '# Upgrade notes\n\nWrite them here.\n';
  expect(convertChangeWorkspace({ [MD]: T, 'docs/upgrade.md': notes }, { written: [{ path: MD, template: T }, { path: 'docs/upgrade.md', template: notes }], readOnly: [] }).outcome).toBe('untouched');
});
