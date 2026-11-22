import * as fs from 'fs';
import * as path from 'path';
import { runbookFromMarkdown, runbookSectionOf } from './runbook-markdown';

const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../../test/fixtures/legacy-deployment/files/RUNBOOK.md'), 'utf8');

describe('runbookSectionOf', () => {
  it.each([
    ['Environment variables', 'environment'], ['Env', 'environment'], ['Runtime settings', 'environment'], ['Health check', 'health'],
    ['Rollback', 'rollback'], ['How to roll back', 'rollback'], ['Data', 'data'], ['Backups', 'data'], ['Volumes and storage', 'data'],
    ['Incident', 'incident'], ['Post-mortem', 'incident'], ['Outage notes', 'incident'], ['Deploying', 'notes'],
  ])('reads "%s" as %s', (heading, section) => expect(runbookSectionOf(heading)).toBe(section));
});

describe('runbookFromMarkdown', () => {
  it('reads the untouched template as nothing of the learner\'s', () => {
    const out = runbookFromMarkdown(TEMPLATE, { template: TEMPLATE });
    expect(out.learnerLines).toBe(0);
    expect(out.notes).toEqual([]);
  });
  it('reads a line with an inline comment as one item, the comment kept in notes', () => {
    const out = runbookFromMarkdown(TEMPLATE.replace('## Health check', '- API_URL <!-- default --> where web sends /api\n\n## Health check'), { template: TEMPLATE });
    expect(out.runbook.environment).toEqual([{ id: 'E1', name: 'API_URL where web sends /api', purpose: '', kind: 'config' }]);
    expect(out.notes).toEqual(['Kept from RUNBOOK.md, Environment variables:\ndefault']);
  });
  it('fills each list in file order, splits an environment line at its colon, and mints ids', () => {
    const md = `${TEMPLATE}`.replace('## Health check', '- TASKTRACKR_DB: where the database file lives\n- API_URL - where web sends /api\n- PORT\n\n## Health check')
      .replace('## Rollback', '```\npython3 api/main.py --selfcheck\n```\n\n## Rollback')
      .replace('## Data', '1. docker compose up -d with the previous tag\n\n## Data');
    const out = runbookFromMarkdown(md, { template: TEMPLATE });
    expect(out.runbook.environment).toEqual([
      { id: 'E1', name: 'TASKTRACKR_DB', purpose: 'where the database file lives', kind: 'config' },
      { id: 'E2', name: 'API_URL', purpose: 'where web sends /api', kind: 'config' },
      { id: 'E3', name: 'PORT', purpose: '', kind: 'config' },
    ]);
    expect(out.runbook.health).toEqual([{ id: 'H1', name: '', how: 'python3 api/main.py --selfcheck', expected: '' }]);
    expect(out.runbook.rollback).toEqual([{ id: 'R1', step: 'docker compose up -d with the previous tag', verify: '' }]);
  });
  it('fills the incident from Root cause, Fix and Action item lines and keeps the rest in notes', () => {
    const md = TEMPLATE.replace('- Root cause:', '- **Root cause:** API_URL named localhost').replace('- Fix:', '- Fix: http://api:8000').replace('- Proof:', '- Proof: the selfcheck passes\n- action item: lint compose in CI');
    const out = runbookFromMarkdown(md, { template: TEMPLATE });
    expect(out.runbook.incident).toEqual({ rootCause: 'API_URL named localhost', fix: 'http://api:8000', actionItem: 'lint compose in CI' });
    expect(out.notes).toEqual(['Kept from RUNBOOK.md, Incident:\nProof: the selfcheck passes']);
  });
  it('lets the drill\'s incident win and keeps every incident line in notes', () => {
    const md = TEMPLATE.replace('- Root cause:', '- Root cause: mine');
    const out = runbookFromMarkdown(md, { template: TEMPLATE, drillIncident: { rootCause: 'drill', fix: 'f', actionItem: 'a' } });
    expect(out.runbook.incident).toEqual({ rootCause: 'drill', fix: 'f', actionItem: 'a' });
    expect(out.notes).toEqual(['Kept from RUNBOOK.md, Incident:\nRoot cause: mine']);
  });
  it('keeps an unknown section and the text above the first heading under headers naming the file and section', () => {
    const out = runbookFromMarkdown('Intro line.\n\n## On call\n\nPage Sam first.\n', {});
    expect(out.notes).toEqual(['Kept from RUNBOOK.md:\nIntro line.', 'Kept from RUNBOOK.md, On call:\nPage Sam first.']);
  });
  it('sends items past the cap of 20 and lines over 2000 characters to notes', () => {
    const many = Array.from({ length: 22 }, (_, i) => `- VAR_${i + 1}: purpose ${i + 1}`).join('\n');
    const out = runbookFromMarkdown(`## Environment\n\n${many}\n\n## Data\n\n- ${'x'.repeat(2001)}\n`, {});
    expect(out.runbook.environment).toHaveLength(20);
    expect(out.notes[0]).toBe('Kept from RUNBOOK.md, Environment:\nVAR_21: purpose 21\nVAR_22: purpose 22');
    expect(out.notes[1].startsWith('Kept from RUNBOOK.md, Data:\nxxx')).toBe(true);
  });
  it('keeps a title line of the learner\'s own, an empty heading that picks no list, and a comment of their own; the template\'s are dropped', () => {
    const titled = runbookFromMarkdown(TEMPLATE.replace('# TaskTrackr runbook', '# My own title'), { template: TEMPLATE });
    expect(titled.notes).toEqual(['Kept from RUNBOOK.md:\n# My own title']);
    expect(titled.learnerLines).toBe(1);
    expect(runbookFromMarkdown(`${TEMPLATE}\n## Paging\n`, { template: TEMPLATE }).notes).toEqual(['Kept from RUNBOOK.md, Paging:']);
    const commented = runbookFromMarkdown(TEMPLATE.replace('## Rollback', '## Rollback\n\n<!-- check the previous tag\n     first -->'), { template: TEMPLATE });
    expect(commented.notes).toEqual(['Kept from RUNBOOK.md, Rollback:\ncheck the previous tag first']);
    expect(commented.learnerLines).toBe(1);
  });
  it('keeps the words of a list or incident heading the learner reworded as a notes header, and adds nothing for the template\'s own', () => {
    const md = TEMPLATE.replace('## Health check', '## Health checks (staging and prod)\n\n- curl -fsS http://api:8000/api/health')
      .replace('## Incident', '## Incident report for the API_URL outage');
    const out = runbookFromMarkdown(md, { template: TEMPLATE });
    expect(out.runbook.health).toEqual([{ id: 'H1', name: '', how: 'curl -fsS http://api:8000/api/health', expected: '' }]);
    expect(out.notes).toEqual(['Kept from RUNBOOK.md, Health checks (staging and prod):', 'Kept from RUNBOOK.md, Incident report for the API_URL outage:']);
    expect(out.learnerLines).toBe(3);
    const same = runbookFromMarkdown(TEMPLATE.replace('## Health check\n', '## Health check\n\n- curl /health\n'), { template: TEMPLATE });
    expect(same.notes).toEqual([]);
    expect(same.learnerLines).toBe(1);
    // an empty template (a file the version gave none): every heading is the learner's; no template (a draft): none is kept
    expect(runbookFromMarkdown('## Environment\n\n- PORT\n', { template: '' }).notes).toEqual(['Kept from RUNBOOK.md, Environment:']);
    expect(runbookFromMarkdown('## Environment\n\n- PORT\n', {}).notes).toEqual([]);
  });
  it('drops TODO(learner) lines for a draft, and moves a starting incident to notes in a drill phase', () => {
    const out = runbookFromMarkdown('## Health\n\nTODO(learner)\n- curl /health\n\n## Incident\n\n- Root cause: example\n', { dropTodo: true, incidentToNotes: true });
    expect(out.runbook.health).toEqual([{ id: 'H1', name: '', how: 'curl /health', expected: '' }]);
    expect(out.runbook.incident).toEqual({ rootCause: '', fix: '', actionItem: '' });
    expect(out.notes).toEqual(['Kept from RUNBOOK.md, Incident:\nRoot cause: example']);
  });
});
