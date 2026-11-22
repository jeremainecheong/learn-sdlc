import { CHANGE_REQUEST_JSON, RUBRIC_CRITERION_DESCRIPTION_MAX, RUNBOOK_JSON, validateChangeRequestRecord, validateRunbookRecord } from '@learnsdlc/shared';
import { legacyPhaseInput } from '../../test/legacy-phase';
import { changeChecksFromLegacy, ticketFromBrief } from './change-legacy';
import { runbookChecksFromLegacy } from './runbook-legacy';

describe('runbookChecksFromLegacy on TaskTrackr 4.0.0', () => {
  const out = runbookChecksFromLegacy(legacyPhaseInput('deployment'));
  it('drops the six runbook rules, keeps the ten file rules and mounts the starting runbook', () => {
    expect(out.checks.rules.map((r) => r.id).some((id) => id.startsWith('runbook-'))).toBe(false);
    expect(out.checks.rules).toHaveLength(10);
    expect(out.files.some((f) => f.path === 'RUNBOOK.md')).toBe(false);
    expect(validateRunbookRecord(out.files.find((f) => f.path === RUNBOOK_JSON)!.content).error).toBeNull();
  });
  it('keeps every graded section\'s minimum and turns the incident on (the phase drills)', () => {
    expect(out.checks.runbook!.floor).toEqual({ minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: true });
  });
  it('keeps runbook_quality, its description carrying the dropped rules\' labels', () => {
    const runbook = out.rubric!.criteria.find((c) => c.key === 'runbook_quality')!;
    expect(runbook.weight).toBe(0.25);
    expect(runbook.description).toContain('Runbook documents TASKTRACKR_DB and API_URL.');
  });
  it('refuses another markdown mount by name', () => {
    const input = legacyPhaseInput('deployment');
    input.files.push({ path: 'docs/ops.md', content: '# ops', editable: false, language: 'markdown' });
    expect(() => runbookChecksFromLegacy(input)).toThrow('A Deployment phase mounts no markdown file: docs/ops.md.');
  });
  it('adds runbook_quality when the runbook rules graded another criterion', () => {
    const input = legacyPhaseInput('deployment');
    (input.checks as { rules: { id: string; criterion: string }[] }).rules.forEach((r) => { if (r.id.startsWith('runbook-')) r.criterion = 'config_completeness'; });
    input.rubric = { passThreshold: 70, criteria: [{ key: 'config_completeness', title: 'c', description: '', weight: 0.6 }, { key: 'build_smoke', title: 'b', description: '', weight: 0.4 }] };
    const rubric = runbookChecksFromLegacy(input).rubric!;
    expect(rubric.criteria.map((c) => [c.key, c.weight])).toEqual([['config_completeness', 0.51], ['build_smoke', 0.34], ['runbook_quality', 0.15]]);
  });
  it('names the rule sentences that did not fit their criterion, as the Design conversion does', () => {
    const input = legacyPhaseInput('deployment');
    input.teacherWorded = new Set(['runbook_quality']);
    input.rubric = { ...input.rubric!, criteria: input.rubric!.criteria.map((c) => (c.key === 'runbook_quality' ? { ...c, description: 'w'.repeat(RUBRIC_CRITERION_DESCRIPTION_MAX - 10) } : c)) };
    const out = runbookChecksFromLegacy(input);
    expect(out.note).toMatch(/rule sentences did not fit their criteria and were left out: /);
    expect(out.note).toContain('6 runbook rules became criterion sentences');
    // the left-out sentences close the note with their own stop, and the note keeps one
    expect(out.note.endsWith('No TODOs left in the runbook.')).toBe(true);
    expect(out.note.endsWith('..')).toBe(false);
  });
  it('refuses a RUNBOOK.md whose words would not fit the record, never cutting them', () => {
    const input = legacyPhaseInput('deployment');
    const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the on-call notes, written out at length so the notes pass their cap.`).join('\n');
    input.files = input.files.map((f) => (f.path === 'RUNBOOK.md' ? { ...f, content: `## On call\n\n${long}\n` } : f));
    expect(() => runbookChecksFromLegacy(input)).toThrow('The words in RUNBOOK.md would not fit in the runbook record.');
  });
});

describe('changeChecksFromLegacy on TaskTrackr 4.0.0', () => {
  const out = changeChecksFromLegacy(legacyPhaseInput('maintenance'));
  it('builds CR-2 from the brief and the six objectives', () => {
    expect(out.checks.ticket).toMatchObject({ id: 'CR-2', title: 'Comments on a task' });
    expect(out.checks.ticket!.summary.startsWith('A task says what to do and never says what happened.')).toBe(true);
    expect(out.checks.ticket!.acceptance.map((a) => a.id)).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6']);
  });
  it('switches the contract on (the phase mounts design/contracts.json) and turns CHANGELOG.md into the starting record', () => {
    expect(out.checks.change!.contract).toBe(true);
    const record = validateChangeRequestRecord(out.files.find((f) => f.path === CHANGE_REQUEST_JSON)!.content, null).change!;
    expect(record.release.changes).toEqual([]);
    expect(out.files.some((f) => f.path === 'CHANGELOG.md')).toBe(false);
  });
  it('adds change_request with the other weights scaled by 0.85', () => {
    expect(out.rubric!.criteria.map((c) => [c.key, c.weight])).toEqual([['correctness_hidden', 0.425], ['visible_tests', 0.1275], ['code_quality', 0.17], ['process', 0.1275], ['change_request', 0.15]]);
  });
  it('holds each criterion\'s wording to 400 characters, cut at the last sentence end, and names the cut', () => {
    const input = legacyPhaseInput('maintenance');
    const long = Array.from({ length: 11 }, () => 'Every behaviour the earlier phases shipped still passes.').join(' ');
    input.rubric = { ...input.rubric!, criteria: input.rubric!.criteria.map((c) => (c.key === 'correctness_hidden' ? { ...c, description: long } : c)) };
    const converted = changeChecksFromLegacy(input);
    expect(long.length).toBeGreaterThan(600);
    expect(converted.rubric!.criteria.find((c) => c.key === 'correctness_hidden')!.description).toBe(Array.from({ length: 7 }, () => 'Every behaviour the earlier phases shipped still passes.').join(' '));
    expect(converted.note).toContain('the description of "Change and regression (hidden tests)" cut to 400 characters');
  });
  it('adds change_request only when no criterion beside the four fixed keys is there', () => {
    const input = legacyPhaseInput('maintenance');
    input.rubric = { ...input.rubric!, criteria: [...input.rubric!.criteria.map((c) => ({ ...c, weight: c.weight * 0.8 })), { key: 'change_request', title: 'Change request', description: 'The record.', weight: 0.2 }] };
    const converted = changeChecksFromLegacy(input);
    expect(converted.rubric!.criteria.filter((c) => c.key === 'change_request')).toHaveLength(1);
    expect(converted.rubric!.criteria.map((c) => c.weight)).toEqual(input.rubric.criteria.map((c) => c.weight));
    expect(converted.note).not.toContain('change_request added');
  });
  it('reads a read-only CHANGELOG.md as it reads an editable one, and refuses one whose words would not fit', () => {
    const input = legacyPhaseInput('maintenance');
    input.files = input.files.map((f) => (f.path === 'CHANGELOG.md' ? { ...f, editable: false } : f));
    const converted = changeChecksFromLegacy(input);
    expect(validateChangeRequestRecord(converted.files.find((f) => f.path === CHANGE_REQUEST_JSON)!.content, null).change!.release.version).toBe('2.1.0');
    expect(converted.note).toContain('CHANGELOG.md became the starting change request');
    const long = Array.from({ length: 30 }, (_, i) => `- Line ${i + 1} of an older release, written out at length so the notes pass their cap.`).join('\n');
    input.files = input.files.map((f) => (f.path === 'CHANGELOG.md' ? { ...f, content: `## 2.1.0\n\n## 2.0.0\n\n${long}\n` } : f));
    expect(() => changeChecksFromLegacy(input)).toThrow('The words in CHANGELOG.md would not fit in the change request record.');
  });
  it('cuts the ticket\'s words at a sentence end or a word within their caps and names every cut', () => {
    const objectives = Array.from({ length: 13 }, (_, i) => `Objective ${i + 1}`);
    objectives[0] = `${'Keep the row as small as it was. '.repeat(14)}Then add the count.`;
    const { ticket, cuts } = ticketFromBrief({ taskPanel: '', title: `${'Comments '.repeat(50)}on a task`, intro: 'Add comments.', objectives });
    expect(ticket.title.length).toBeLessThanOrEqual(400);
    expect(ticket.title.endsWith('Comments')).toBe(true);
    expect(ticket.acceptance).toHaveLength(12);
    expect(ticket.acceptance[0].line.length).toBeLessThanOrEqual(400);
    expect(ticket.acceptance[0].line.endsWith('Keep the row as small as it was.')).toBe(true);
    expect(cuts).toEqual(['the ticket title cut to 400 characters', 'acceptance AC-1 cut to 400 characters', '1 objective past the first 12 left out of the ticket']);
  });
  it('falls back to CR-1, the title and the Background', () => {
    expect(ticketFromBrief({ taskPanel: 'Do the change.', title: 'Badges', intro: 'Add badges. They help.', objectives: ['One'] }).ticket).toEqual({ id: 'CR-1', title: 'Badges', summary: 'Add badges. They help.', acceptance: [{ id: 'AC-1', line: 'One' }] });
  });
});
