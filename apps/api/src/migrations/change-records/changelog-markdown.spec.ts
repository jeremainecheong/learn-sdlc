import * as fs from 'fs';
import * as path from 'path';
import { changeFromChangelog } from './changelog-markdown';

const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../../test/fixtures/legacy-maintenance/files/CHANGELOG.md'), 'utf8');

describe('changeFromChangelog', () => {
  it('reads the untouched template as nothing of the learner\'s', () => {
    expect(changeFromChangelog(TEMPLATE, { template: TEMPLATE }).learnerLines).toBe(0);
  });
  it('takes the newest entry as the release, a subheading prefixing its lines, and mints ids', () => {
    const md = TEMPLATE.replace('## 2.1.0', '## 2.1.0 Comments on a task\n\n### Added\n- Comments on a task, newest first.\n- A comment count on the task row.\n\n### Notes\n- No schema change: the table was there.');
    const out = changeFromChangelog(md, { template: TEMPLATE });
    expect(out.change.release.version).toBe('2.1.0');
    expect(out.change.release.summary).toBe('Comments on a task');
    expect(out.change.release.changes).toEqual([
      { id: 'L1', line: 'Added: Comments on a task, newest first.', covers: [] },
      { id: 'L2', line: 'Added: A comment count on the task row.', covers: [] },
      { id: 'L3', line: 'Notes: No schema change: the table was there.', covers: [] },
    ]);
    expect(out.notes).toEqual([]);
  });
  it('keeps what is outside the newest entry in notes, the template\'s own lines dropped wherever they are', () => {
    const md = TEMPLATE.replace('The first release anybody else can run.', 'The first release anybody else can run.\nI also fixed a typo here.');
    // a line outside the newest entry keeps the release it was written under
    expect(changeFromChangelog(md, { template: TEMPLATE }).notes).toEqual(['Kept from CHANGELOG.md:\n2.0.0: I also fixed a typo here.']);
  });
  it('keeps a title line of the learner\'s own, an empty level-three heading with its entry, and a comment of their own', () => {
    expect(changeFromChangelog(TEMPLATE.replace('# Changelog', '# Changelog by me'), { template: TEMPLATE }).notes).toEqual(['Kept from CHANGELOG.md:\n# Changelog by me']);
    expect(changeFromChangelog(TEMPLATE.replace('## 2.0.0', '### Removed\n\n## 2.0.0'), { template: TEMPLATE }).notes).toEqual(['Kept from CHANGELOG.md:\n### Removed']);
    const commented = changeFromChangelog(TEMPLATE.replace('## 2.0.0', '<!-- ask Sam about the migration -->\n\n## 2.0.0'), { template: TEMPLATE });
    expect(commented.notes).toEqual(['Kept from CHANGELOG.md:\nask Sam about the migration']);
    expect(commented.change.release.changes).toEqual([]);
  });
  it('keeps a level-three heading the template\'s entry does not hold when every line under it was the template\'s', () => {
    // the learner's empty subheading sits above the template's TODO comment, which is dropped
    const empty = changeFromChangelog(TEMPLATE.replace('## 2.1.0', '## 2.1.0 Comments on tasks\n\n### Added\n- add_comment\n\n### Empty sub'), { template: TEMPLATE });
    expect(empty.change.release.changes).toEqual([{ id: 'L1', line: 'Added: add_comment', covers: [] }]);
    expect(empty.notes).toEqual(['Kept from CHANGELOG.md:\n### Empty sub']);
    // a reworded subheading over the template's own lines under 2.0.0
    const reworded = changeFromChangelog(TEMPLATE.replace('### Added\n- Lists', '### Added in the first release\n- Lists'), { template: TEMPLATE });
    expect(reworded.notes).toEqual(['Kept from CHANGELOG.md:\n2.0.0: ### Added in the first release']);
    expect(reworded.learnerLines).toBe(1);
  });
  it('keeps an older heading the learner reworded, its template body still dropped', () => {
    const out = changeFromChangelog(TEMPLATE.replace('## 2.0.0', '## 2.0.0 First release'), { template: TEMPLATE });
    expect(out.notes).toEqual(['Kept from CHANGELOG.md:\n## 2.0.0 First release']);
    expect(out.learnerLines).toBe(1);
  });
  it('reads a newest heading the learner reworded as the release, though only the template\'s comment sits under it', () => {
    const out = changeFromChangelog(TEMPLATE.replace('## 2.1.0', '## 2.1.0 Comments on a task'), { template: TEMPLATE });
    expect(out.change.release.version).toBe('2.1.0');
    expect(out.change.release.summary).toBe('Comments on a task');
    expect(out.change.release.changes).toEqual([]);
    expect(out.notes).toEqual([]);
    expect(out.learnerLines).toBe(1);
  });
  it('sends a newest-entry line past the cap of 20, and one over 2000 characters, to notes', () => {
    const lines = Array.from({ length: 21 }, (_, i) => `- Change ${i + 1}`).join('\n');
    const out = changeFromChangelog(`## 2.1.0\n\n${lines}\n- ${'x'.repeat(2001)}\n`, {});
    expect(out.change.release.changes).toHaveLength(20);
    expect(out.change.release.changes[19].line).toBe('Change 20');
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0].startsWith('Kept from CHANGELOG.md:\nChange 21\nxxx')).toBe(true);
  });
});
