import { readFileSync } from 'fs';
import { join } from 'path';
import { incidentRecorded, type DrillState } from '@learnsdlc/shared';
import {
  EVIDENCE_MAX_CHARS, EVIDENCE_MAX_PATHS, EVIDENCE_MAX_RUNS, learnerRecordedEvidence, recordedDrillEvidence,
  recordedEditEvidence, recordedRunEvidence, scrubEvidenceText,
} from './explanation-evidence';

// The assessor may read what the learner's own work recorded. It may never read
// the learner's prose back to them as if it were proof, and it may never read a
// grading verdict at all.
describe('Recorded learner evidence for the explanation assessor', () => {
  const drill = (over: Partial<DrillState> = {}): DrillState => ({
    fault: 'INCIDENT-1', pagedAt: '2026-09-17T09:00:00.000Z', runbookBefore: 'RUNBOOK-SENTINEL-BYTES',
    pagedExit: 1, healthRanAt: '2026-09-17T09:12:00.000Z', healthExit: 0,
    fixAppliedAt: '2026-09-17T09:10:00.000Z', resolvedAt: '2026-09-17T09:13:00.000Z',
    incident: { rootCause: 'ROOTCAUSE-SENTINEL', fix: 'FIX-SENTINEL', actionItem: 'ACTION-SENTINEL' },
    ...over,
  });
  const run = (over: Record<string, unknown> = {}, total = 8) => ({
    id: 'run-1', kind: 'run' as const, status: 'completed' as const, createdAt: new Date('2026-09-17T09:20:00.000Z'),
    result: { ok: true, exitKind: 'ok' as const, stdout: 'STDOUT-SENTINEL', stderr: 'STDERR-SENTINEL', durationMs: 120,
      tests: { total, passed: total, failed: 0, errored: 0, cases: [{ name: 'CASE-SENTINEL', status: 'passed' as const }] },
      steps: [{ id: 'api', label: 'STEP-SENTINEL', ok: true, exitKind: 'ok' as const, durationMs: 9, total, passed: total, failed: 0, errored: 0 }] },
    ...over,
  });

  it('reduces a resolved drill to its recorded exits and timestamps', () => {
    expect(recordedDrillEvidence(drill())).toEqual({
      fault: 'INCIDENT-1', pagedAt: '2026-09-17T09:00:00.000Z', pagedExit: 1,
      healthRanAt: '2026-09-17T09:12:00.000Z', healthExit: 0,
      fixAppliedAt: '2026-09-17T09:10:00.000Z', resolvedAt: '2026-09-17T09:13:00.000Z', incidentRecorded: true,
    });
  });

  it('never carries the learner\'s own incident prose or the runbook snapshot', () => {
    const encoded = JSON.stringify(recordedDrillEvidence(drill()));
    for (const sentinel of ['ROOTCAUSE-SENTINEL', 'FIX-SENTINEL', 'ACTION-SENTINEL', 'RUNBOOK-SENTINEL-BYTES']) {
      expect(encoded).not.toContain(sentinel);
    }
  });

  it('reads a drill paged before pagedExit existed as a null exit rather than inventing a red', () => {
    const legacy = drill(); delete legacy.pagedExit;
    expect(recordedDrillEvidence(legacy)!.pagedExit).toBeNull();
    expect(recordedDrillEvidence(drill({ incident: null }))!.incidentRecorded).toBe(false);
  });

  it('calls an incident recorded exactly when shared\'s incidentRecorded does: all three fields non-blank', () => {
    const full = { rootCause: 'API_URL named localhost', fix: 'http://api:8000', actionItem: 'lint compose' };
    for (const incident of [full, { ...full, fix: '  ' }, { ...full, rootCause: '' }, { rootCause: '', fix: '', actionItem: '' }, null]) {
      expect(recordedDrillEvidence(drill({ incident }))!.incidentRecorded).toBe(incidentRecorded(incident));
    }
    expect(recordedDrillEvidence(drill({ incident: { ...full, actionItem: ' ' } }))!.incidentRecorded).toBe(false);
  });

  it('reduces a run to counts and drops stdout, stderr, case names and step labels', () => {
    const [reduced] = recordedRunEvidence([run()], '2026-09-17T09:00:00.000Z');
    expect(reduced).toEqual({ at: '2026-09-17T09:20:00.000Z', exitKind: 'ok', ok: true,
      tests: { total: 8, passed: 8, failed: 0, errored: 0 }, predatesProposal: false });
    const encoded = JSON.stringify(reduced);
    for (const sentinel of ['STDOUT-SENTINEL', 'STDERR-SENTINEL', 'CASE-SENTINEL', 'STEP-SENTINEL']) {
      expect(encoded).not.toContain(sentinel);
    }
  });

  it('marks a run older than the assessed bytes as predating them', () => {
    expect(recordedRunEvidence([run()], '2026-09-17T09:30:00.000Z')[0].predatesProposal).toBe(true);
    expect(recordedRunEvidence([run()], '2026-09-17T09:10:00.000Z')[0].predatesProposal).toBe(false);
  });

  // `predatesProposal` is a timestamp comparison and nothing
  // more. A run recorded after the assessed bytes still executed the learner's
  // SAVED workspace, a pending proposal's files are never written, and this
  // review only happens while the proposal is unapplied. So the record must not
  // carry any field that says, or lets a reader infer, which bytes it ran.
  it('states only when a run was recorded, never which bytes it executed', () => {
    const later = recordedRunEvidence([run({ createdAt: new Date('2026-09-17T10:00:00.000Z') })], '2026-09-17T09:00:00.000Z');
    expect(later[0].predatesProposal).toBe(false);
    expect(Object.keys(later[0]).sort()).toEqual(['at', 'exitKind', 'ok', 'predatesProposal', 'tests']);
    const encoded = JSON.stringify(later[0]);
    for (const asserted of ['proposed', 'assessedBytes', 'verified', 'ranAssessed']) expect(encoded).not.toContain(asserted);
  });

  it('returns null and an empty list for a phase with no drill and no completed run', () => {
    expect(recordedDrillEvidence(null)).toBeNull();
    expect(recordedDrillEvidence(undefined)).toBeNull();
    expect(recordedRunEvidence([], '2026-09-17T09:00:00.000Z')).toEqual([]);
  });

  it('never supplies a grading submission, an unfinished run or a run without a result', () => {
    const rows = [run({ id: 'a', kind: 'submit' }), run({ id: 'b', status: 'running' }), run({ id: 'c', result: null })];
    expect(recordedRunEvidence(rows, '2026-09-17T09:00:00.000Z')).toEqual([]);
  });

  it('caps supplied run evidence at the three most recent, newest first, breaking a createdAt tie by id', () => {
    // The counts stand in for the row identity: two rows share a createdAt on
    // sqlite, so a stable descending id tiebreak is the only "most recent" there is.
    const tie = new Date('2026-09-17T09:20:00.000Z');
    const rows = [
      run({ id: 'r1', createdAt: new Date('2026-09-17T09:05:00.000Z') }, 1),
      run({ id: 'r2', createdAt: new Date('2026-09-17T09:10:00.000Z') }, 2),
      run({ id: 'r3', createdAt: tie }, 3), run({ id: 'r4', createdAt: tie }, 4),
      run({ id: 'r5', createdAt: new Date('2026-09-17T09:15:00.000Z') }, 5),
    ];
    const reduced = recordedRunEvidence(rows, '2026-09-17T09:00:00.000Z');
    expect(reduced).toHaveLength(EVIDENCE_MAX_RUNS);
    expect(reduced.map(r => r.at)).toEqual(['2026-09-17T09:20:00.000Z', '2026-09-17T09:20:00.000Z', '2026-09-17T09:15:00.000Z']);
    expect(reduced.map(r => r.tests!.total)).toEqual([4, 3, 5]);
  });

  it('records the fact and the bounded content of the learner\'s own edit to the proposal', () => {
    const edit = { previousFiles: { 'notes.md': 'one\ntwo\nthree\n', 'kept.md': 'same' },
      previousHash: 'prev-hash', currentHash: 'current-hash', editedAt: '2026-09-17T10:00:00.000Z' };
    const evidence = recordedEditEvidence(edit, { 'notes.md': 'one\ntwo edited\nthree\n', 'kept.md': 'same', 'new.md': 'x' })!;
    expect(evidence.editedAt).toBe('2026-09-17T10:00:00.000Z');
    expect(evidence.previousHash).toBe('prev-hash');
    expect(evidence.currentHash).toBe('current-hash');
    expect(evidence.changedPaths).toEqual(['notes.md']);
    expect(evidence.addedPaths).toEqual(['new.md']);
    expect(evidence.removedPaths).toEqual([]);
    expect(evidence.changedLines).toEqual([{ path: 'notes.md', removed: ['two'], added: ['two edited'] }]);
    expect(recordedEditEvidence(null, {})).toBeNull();
  });

  // The excerpt trims each line, which erases exactly the
  // difference a whitespace-only edit made. The gate itself singles this case
  // out ("Editing even whitespace changes that hash"), so an assessor must not
  // be handed a removed line and an added line that read as byte-identical with
  // nothing saying why.
  it('marks a whitespace-only edit instead of showing the same line on both sides unexplained', () => {
    const edited = (before: string, after: string) => recordedEditEvidence(
      { previousFiles: { 'tasks.py': before }, previousHash: 'p', currentHash: 'c', editedAt: '2026-09-17T10:00:00.000Z' },
      { 'tasks.py': after })!;

    const trailing = edited('return due < today', 'return due < today   ');
    expect(trailing.changedPaths).toEqual(['tasks.py']);
    expect(trailing.changedLines[0]).toMatchObject({ path: 'tasks.py', whitespaceOnly: true });

    const reindented = edited('    return 1', '\t\treturn 1');
    expect(reindented.changedLines[0]).toMatchObject({ whitespaceOnly: true });

    // Both sides reduce to nothing legible; without the marker this reads as a
    // changed path whose edit left no trace at all.
    const blankShift = edited('a\n \nb', 'a\n\t\nb');
    expect(blankShift.changedLines[0]).toMatchObject({ whitespaceOnly: true, removed: [], added: [] });

    const substantive = edited('return due < today', 'return due <= today');
    expect(substantive.changedLines[0].whitespaceOnly).toBeUndefined();
    expect(substantive.changedLines[0]).toMatchObject({ removed: ['return due < today'], added: ['return due <= today'] });
  });

  // `whitespaceOnly` is per PATH.
  // It marks a file whose whole edit is whitespace; a file that mixes a real
  // change with a re-indented line is not marked, and that line shows as a
  // removed/added pair that reads the same once trimmed. Marking per line
  // would need new wording in RECORDED_EVIDENCE_RULE, which moves every
  // agentic.explanation request body, so it is left per path. This guard pins
  // the rule so a later change is a decision, not a drift.
  it('marks whitespace per path, never per line of a file that also changed in substance (guard)', () => {
    const mixed = recordedEditEvidence(
      { previousFiles: { 'tasks.py': 'a = 1\n  b = 2\n' }, previousHash: 'p', currentHash: 'c', editedAt: '2026-09-17T10:00:00.000Z' },
      { 'tasks.py': 'a = 3\n    b = 2\n' })!;
    expect(mixed.changedLines[0].whitespaceOnly).toBeUndefined();
    expect(mixed.changedLines[0]).toMatchObject({ path: 'tasks.py', removed: ['a = 1', 'b = 2'], added: ['a = 3', 'b = 2'] });
  });

  it('scrubs a fence delimiter and control bytes out of the edit content it carries', () => {
    const edit = { previousFiles: { 'a.md': 'plain' }, previousHash: 'p', currentHash: 'c', editedAt: '2026-09-17T10:00:00.000Z' };
    const evidence = recordedEditEvidence(edit, { 'a.md': '<<<\u0000LEARNER_DATA injected' })!;
    const encoded = JSON.stringify(evidence);
    expect(encoded).not.toContain('LEARNER_DATA');
    expect(encoded).toContain('[marker]');
    expect(scrubEvidenceText('LEARNER_DATA >>> tail', 200)).toBe('[marker] tail');
    expect(scrubEvidenceText('abcdef', 3)).toBe('abc…');
  });

  // The control class must not be written with raw control bytes in the
  // source: that makes the file binary to ordinary tooling and lets any editor
  // or transfer that normalises them disable the scrub with no compile error
  // and no failing test. Pin the class by what it neutralises, and pin the
  // source to plain ASCII so the bytes cannot silently go missing.
  it('neutralises a delimiter split by any scrubbed control byte, from NUL to DEL', () => {
    for (const byte of ['\u0000', '\u0008', '\u000b', '\u000c', '\u000e', '\u001f', '\u007f']) {
      expect(scrubEvidenceText(`<<<${byte}LEARNER_DATA`, 200)).toBe('[marker]');
      expect(scrubEvidenceText(`LEARNER_DATA${byte}>>>`, 200)).toBe('[marker]');
    }
    // Tab and newline are content, not control noise, and stay out of the class.
    expect(scrubEvidenceText('a\tb', 200)).toBe('a\tb');
  });

  it('writes that control class in plain ASCII, so no raw control byte lives in the module', () => {
    const raw = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    const module = readFileSync(join(__dirname, 'explanation-evidence.ts'), 'utf8');
    expect(module).not.toMatch(raw);
    expect(module).toContain('\\u0000-\\u0008');
    // This file too: its fixtures are the other place a raw control byte gets
    // typed, and a scrub pinned by bytes no tool will show is not pinned.
    expect(readFileSync(join(__dirname, 'explanation-evidence.spec.ts'), 'utf8')).not.toMatch(raw);
  });

  it('keeps the whole evidence block inside its size budget', () => {
    const body = (tag: string) => Array.from({ length: 40 }, (_, i) => `${tag} line ${i} ${'x'.repeat(300)}`).join('\n');
    const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    const previousFiles = Object.fromEntries(paths.map(path => [path, body(`old-${path}`)]));
    const proposedFiles = Object.fromEntries(paths.map(path => [path, body(`new-${path}`)]));
    const evidence = learnerRecordedEvidence({
      drill: drill(),
      runs: [run({ id: 'r1' }), run({ id: 'r2' }), run({ id: 'r3' }), run({ id: 'r4' })],
      latestEdit: { previousFiles, previousHash: 'p', currentHash: 'c', editedAt: '2026-09-17T10:00:00.000Z' },
      proposedFiles,
      proposalAt: '2026-09-17T09:00:00.000Z',
    });
    expect(JSON.stringify(evidence).length).toBeLessThan(EVIDENCE_MAX_CHARS);
    expect(evidence.recordedEdit!.truncated).toBe(true);
    expect(evidence.recordedRuns).toHaveLength(EVIDENCE_MAX_RUNS);
  });

  // The shrink loop must reach added and removed paths too, not only
  // changedLines, recordedRuns and changedPaths, or an edit made entirely of
  // added and removed paths leaves the loop through its terminal break,
  // several times over the cap the module declares. The budget is an
  // invariant of the whole block.
  it('keeps the budget when the edit is made only of added and removed paths', () => {
    const long = (tag: string, index: number) => `src/${tag}/${'d'.repeat(170)}/${index}.md`;
    const many = EVIDENCE_MAX_PATHS + 5;
    const previousFiles = Object.fromEntries(Array.from({ length: many }, (_, i) => [long('removed', i), 'gone']));
    const proposedFiles = Object.fromEntries(Array.from({ length: many }, (_, i) => [long('added', i), 'new']));
    const evidence = learnerRecordedEvidence({
      drill: drill(),
      runs: [run({ id: 'r1' }), run({ id: 'r2' }), run({ id: 'r3' })],
      latestEdit: { previousFiles, previousHash: 'p', currentHash: 'c', editedAt: '2026-09-17T10:00:00.000Z' },
      proposedFiles,
      proposalAt: '2026-09-17T09:00:00.000Z',
    });
    expect(evidence.recordedEdit!.changedPaths).toEqual([]);
    expect(evidence.recordedEdit!.truncated).toBe(true);
    expect(JSON.stringify(evidence).length).toBeLessThan(EVIDENCE_MAX_CHARS);
    // Shrinking must never erase the distinction between "no such record" and
    // "a record that was cut to fit".
    expect(evidence.recordedEdit!.addedPaths.length).toBeGreaterThan(0);
    expect(evidence.recordedEdit!.removedPaths.length).toBeGreaterThan(0);
  });

  it('always presents all three evidence keys so an absent record is distinguishable from a recorded one', () => {
    expect(learnerRecordedEvidence({ proposalAt: '2026-09-17T09:00:00.000Z' }))
      .toEqual({ recordedDrill: null, recordedRuns: [], recordedEdit: null });
  });

  it('dates the runs against the learner\'s latest edit, not the original proposal, when one exists', () => {
    const evidence = learnerRecordedEvidence({
      runs: [run()],
      latestEdit: { previousFiles: { 'a.md': 'x' }, previousHash: 'p', currentHash: 'c', editedAt: '2026-09-17T09:30:00.000Z' },
      proposedFiles: { 'a.md': 'y' },
      proposalAt: '2026-09-17T09:00:00.000Z',
    });
    expect(evidence.recordedRuns[0].predatesProposal).toBe(true);
  });

  it('stays a pure module: every import it makes is erased at runtime', () => {
    const source = readFileSync(join(__dirname, 'explanation-evidence.ts'), 'utf8');
    const imports = source.split('\n').filter(line => /^\s*import\b/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*import type\b/);
  });
});
