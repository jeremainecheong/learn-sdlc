import { describe, expect, it } from 'vitest';
import { fileDiff } from '@/components/pr/diff';
import {
  CHURN_MIN_LINES,
  CHURN_RATIO,
  MAX_LEAVES,
  analyseChange,
  narrowRequestSentence,
  proposalChurn,
  structuralDiff,
  tokenBagDelta,
} from '@/components/workspace/mentor/proposalChange';

/** The real line diff the comparison already draws, so the two never disagree. */
const churnOf = (path: string, saved: string | undefined, proposed: string) => {
  const diff = fileDiff(path, saved, proposed);
  return { adds: diff.adds, dels: diff.dels };
};
const analyse = (path: string, saved: string | undefined, proposed: string) =>
  analyseChange(path, saved, proposed, churnOf(path, saved, proposed));
const paths = (changes: Array<{ path: string }>) => changes.map(change => change.path);

/** A contract of the shape the Maintenance phase ships: many identified operations. */
const contract = (operations: number) => ({
  version: 1,
  operations: Array.from({ length: operations }, (_, index) => ({
    name: `operation${index}`,
    method: 'GET',
    path: `/thing/${index}`,
  })),
});

describe('what a proposal changed, measured in fields rather than lines', () => {
  it('reports one added field for a reflowed JSON file and flags the churn', () => {
    const saved = contract(110);
    const proposed = { ...contract(110), tags: { created_at: '2026-09-17T00:00:00Z' } };
    const analysis = analyse('shared/contract/api.json', JSON.stringify(saved, null, 2), JSON.stringify(proposed));
    expect(analysis.meaningKind).toBe('json-fields');
    expect(analysis.meaning).toBe(1);
    expect(paths(analysis.structural!.added)).toEqual(['tags.created_at']);
    expect(analysis.structural!.removed).toEqual([]);
    expect(analysis.structural!.changed).toEqual([]);
    expect(analysis.structural!.moved).toEqual([]);
    expect(analysis.lineChurn).toBeGreaterThan(400);
    expect(analysis.churnFlag).toBe(true);
  });

  it('reports no field change at all when keys are reordered and the file is reindented', () => {
    const saved = JSON.stringify({ alpha: 1, beta: { two: 2, one: 1 } }, null, 4);
    const proposed = JSON.stringify({ beta: { one: 1, two: 2 }, alpha: 1 });
    const analysis = analyse('design/design.json', saved, proposed);
    expect(analysis.meaning).toBe(0);
    expect(analysis.structural!.count).toBe(0);
  });

  it('matches array elements by a unique name key instead of by index', () => {
    const saved = { operations: [{ name: 'a' }, { name: 'b' }] };
    const proposed = { operations: [{ name: 'b' }, { name: 'a' }, { name: 'c' }] };
    const diff = structuralDiff(saved, proposed);
    expect(paths(diff.added)).toEqual(['operations[name=c].name']);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  // The identity match must never turn a reordering into silence: order is
  // meaning, and an acceptance criterion is addressed by its position.
  it('reports an identified element that kept its identity and lost its place', () => {
    const saved = { operations: [{ name: 'a' }, { name: 'b' }] };
    const proposed = { operations: [{ name: 'b' }, { name: 'a' }, { name: 'c' }] };
    const diff = structuralDiff(saved, proposed);
    expect(paths(diff.moved).sort()).toEqual(['operations[name=a]', 'operations[name=b]']);
    expect(diff.moved.find(change => change.path === 'operations[name=a]')).toMatchObject({ before: '1', after: '2' });
    expect(diff.count).toBe(3);
  });

  // A removal before an element and an insertion after it cancel out in the
  // absolute index, so a move published as an absolute position could read
  // "1 → 1". The numbers are ranks among the entries present in both copies,
  // which the emitting rule has already established differ.
  it('never reports a move between one position and itself', () => {
    const diff = structuralDiff({ r: [{ id: 'x' }, { id: 'a' }, { id: 'b' }] }, { r: [{ id: 'b' }, { id: 'a' }, { id: 'y' }] });
    expect(diff.moved.length).toBeGreaterThan(0);
    expect(diff.moved.every(change => change.before !== change.after)).toBe(true);
    expect(diff.moved.find(change => change.path === 'r[id=a]')).toMatchObject({ before: '1', after: '2' });
    expect(diff.moved.find(change => change.path === 'r[id=b]')).toMatchObject({ before: '2', after: '1' });
  });

  it('does not call a pure insertion a move', () => {
    const diff = structuralDiff({ rows: [{ id: 'a' }, { id: 'b' }] }, { rows: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] });
    expect(paths(diff.added)).toEqual(['rows[id=c].id']);
    expect(diff.moved).toEqual([]);
  });

  it('falls back to index matching when an array has no unique identity key', () => {
    const diff = structuralDiff([1, 2, 3], [1, 9, 3]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({ path: '[1]', before: '2', after: '9' });
  });

  // The acceptance-criteria case: criteria carry no identity key, so a reordering
  // of them is reported as the field changes it is, never as nothing.
  it('reports a reordering of an index-matched array as changed fields', () => {
    const diff = structuralDiff({ criteria: [{ then: 'X' }, { then: 'Y' }] }, { criteria: [{ then: 'Y' }, { then: 'X' }] });
    expect(paths(diff.changed).sort()).toEqual(['criteria[0].then', 'criteria[1].then']);
  });

  it('reports an object that became empty rather than saying nothing', () => {
    const diff = structuralDiff({ contracts: { a: 1 } }, { contracts: {} });
    expect(paths(diff.removed)).toEqual(['contracts.a']);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({ path: 'contracts', before: '{…}', after: '{}' });
  });

  // A document that was emptied was not added, and a document that gained its
  // first field was not removed. Either would print a row naming the whole
  // document as the thing added or removed, and inflate the count with it.
  it('calls a container that was emptied or filled changed, in both directions', () => {
    const emptied = structuralDiff({ a: 1 }, {});
    expect(emptied.added).toEqual([]);
    expect(paths(emptied.removed)).toEqual(['a']);
    expect(emptied.changed).toHaveLength(1);
    expect(emptied.changed[0]).toMatchObject({ path: '', before: '{…}', after: '{}' });
    expect(emptied.count).toBe(2);

    const filled = structuralDiff({ rows: [] }, { rows: [{ id: 'a' }] });
    expect(filled.removed).toEqual([]);
    expect(paths(filled.added)).toEqual(['rows[0].id']);
    expect(filled.changed[0]).toMatchObject({ path: 'rows', before: '[]', after: '[…]' });
  });

  it('escapes a dot inside a key so a field path is unambiguous', () => {
    const flat = structuralDiff({ 'a.b': { c: 1 } }, { 'a.b': { c: 2 } });
    const nested = structuralDiff({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
    expect(paths(flat.changed)).toEqual(['a\\.b.c']);
    expect(paths(nested.changed)).toEqual(['a.b.c']);
    expect(paths(flat.changed)).not.toEqual(paths(nested.changed));
  });

  it('treats a json file that stops parsing as a line-diff-only comparison', () => {
    const saved = JSON.stringify({ a: 1, b: 2 }, null, 2);
    const analysis = analyse('story.json', saved, saved.slice(0, saved.length - 3));
    expect(analysis.jsonParse).toBe('saved-only');
    expect(analysis.meaningKind).toBe('word-occurrences');
    expect(analysis.structural).toBeNull();
  });

  it('names the side that stopped parsing in both directions', () => {
    const valid = JSON.stringify({ a: 1 });
    expect(analyse('a.json', '{oops', valid).jsonParse).toBe('proposed-only');
    expect(analyse('a.json', '{oops', '{oops too').jsonParse).toBe('neither');
    expect(analyse('a.md', valid, valid).jsonParse).toBe('not-json');
  });

  it('counts word occurrences, not lines, and ignores rewrapping entirely', () => {
    const words = Array.from({ length: 120 }, (_, index) => `word${index}`);
    const saved = words.join('\n');
    const proposed = `  ${words.join('  ')}  `;
    expect(tokenBagDelta(saved, proposed)).toBe(0);
    const analysis = analyse('notes.md', saved, proposed);
    expect(analysis.meaning).toBe(0);
    expect(analysis.lineChurn).toBeGreaterThanOrEqual(CHURN_MIN_LINES);
    expect(analysis.churnFlag).toBe(true);
  });

  it('counts the two dropped tokens on each of twenty-five lines and does not flag them', () => {
    const saved = Array.from({ length: 25 }, (_, index) => `    assert True or check_${index}()`).join('\n');
    const proposed = Array.from({ length: 25 }, (_, index) => `    assert check_${index}()`).join('\n');
    const analysis = analyse('tests/test_acceptance.py', saved, proposed);
    expect(analysis.meaning).toBe(50);
    expect(analysis.lineChurn).toBe(50);
    expect(analysis.churnFlag).toBe(false);
  });

  it('does not flag a proposal of eighty-odd churned lines that adds real prose', () => {
    const saved = Array.from({ length: 10 }, (_, index) => `Existing runbook step ${index} for the deployment drill.`).join('\n');
    const added = Array.from({ length: 85 }, (_, index) => `New step ${index}: page the rota, read metric ${index}, record outcome ${index}.`).join('\n');
    const proposed = `${saved.split('\n').slice(0, 8).join('\n')}\n${added}`;
    const analysis = analyse('notes.md', saved, proposed);
    expect(analysis.lineChurn).toBe(87);
    expect(analysis.meaning).toBeGreaterThan(200);
    expect(analysis.churnFlag).toBe(false);
  });

  // The flag fires at max(CHURN_MIN_LINES, CHURN_RATIO * max(meaning, 1)), so a
  // ratio-driven boundary only exists once that product clears the floor.
  it.each([0, 18, 30])('pins the threshold boundary at %i measured differences', meaning => {
    const proposed = Array.from({ length: meaning }, (_, index) => `w${index}`).join(' ');
    const edge = Math.max(CHURN_MIN_LINES, CHURN_RATIO * Math.max(meaning, 1));
    const at = (lineChurn: number) => analyseChange('notes.md', '', proposed, { adds: lineChurn, dels: 0 });
    expect(at(edge - 1).churnFlag).toBe(false);
    expect(at(edge).churnFlag).toBe(true);
    expect(at(edge).meaning).toBe(meaning);
  });

  it('never flags an unmeasured comparison', () => {
    const wide = Object.fromEntries(Array.from({ length: MAX_LEAVES + 1 }, (_, index) => [`k${index}`, index]));
    const huge = analyseChange('wide.json', JSON.stringify(wide, null, 2), JSON.stringify({ ...wide, k0: 'changed' }), { adds: 900, dels: 900 });
    expect(huge.structural!.truncated).toBe(true);
    expect(huge.meaningKind).toBe('unmeasured');
    expect(huge.churnFlag).toBe(false);

    const fresh = analyseChange('new.json', undefined, JSON.stringify(contract(3)), { adds: 500, dels: 0 });
    expect(fresh.meaningKind).toBe('unmeasured');
    expect(fresh.churnFlag).toBe(false);
  });

  // A smoke guard against an accidental quadratic, not a benchmark: no wall
  // time is asserted, only that a real-sized contract completes and measures.
  it('measures a four-hundred-line contract without reporting itself unmeasured', () => {
    const saved = JSON.stringify(contract(100), null, 2);
    const proposed = JSON.stringify(contract(102), null, 2);
    const analysis = analyse('shared/contract/api.json', saved, proposed);
    expect(analysis.structural!.truncated).toBe(false);
    expect(analysis.meaning).toBe(6);
  });

  it('returns the learner’s own narrowing sentence verbatim, or null', () => {
    expect(narrowRequestSentence('Correct AC-2 only, change nothing else.')).toBe('Correct AC-2 only, change nothing else.');
    expect(narrowRequestSentence('Fix AC-2 and Change Nothing Else please.')).toBe('Fix AC-2 and Change Nothing Else please.');
    expect(narrowRequestSentence('Please improve the runbook.')).toBeNull();
    expect(narrowRequestSentence('')).toBeNull();
    expect(narrowRequestSentence(null)).toBeNull();
  });

  // A bare substring lifted out of a sentence can drop the learner's scope or
  // the negation that governs it, and the screen then attributes a constraint
  // they never stated. Whatever is quoted is a whole sentence they wrote.
  it('never quotes a fragment that drops the scope or flips the learner’s meaning', () => {
    const scoped = 'Add a 409 to completeTask and don\'t change anything else';
    expect(narrowRequestSentence(scoped)).toBe(scoped);
    const inverse = 'I don’t change my approach lightly, but rewrite the whole module.';
    expect(narrowRequestSentence(inverse)).toBe(inverse);
    expect(narrowRequestSentence('First fix the handler. Then change nothing else. Ship it.')).toBe('Then change nothing else.');
  });

  it('says nothing rather than quoting a sentence too long to read in a notice', () => {
    const long = `Rewrite ${'the whole module and '.repeat(20)}change nothing else.`;
    expect(long.length).toBeGreaterThan(200);
    expect(narrowRequestSentence(long)).toBeNull();
  });

  it('refuses to quote a stored context envelope as the learner’s request', () => {
    const envelope = JSON.stringify({ selectedProposalOriginalRequest: 'Correct AC-2 only, change nothing else.', currentLearnerMessage: 'Now add the notes.' });
    expect(narrowRequestSentence(envelope)).toBeNull();
  });

  it('ignores unmeasured files when rolling the proposal up', () => {
    const measured = analyseChange('a.md', 'one two', 'one three', { adds: 1, dels: 1 });
    const unmeasured = analyseChange('b.md', undefined, 'brand new file', { adds: 900, dels: 0 });
    const rollup = proposalChurn([measured, unmeasured]);
    expect(rollup.lineChurn).toBe(2);
    expect(rollup.files).toBe(1);
    expect(rollup.flag).toBe(false);
  });

  it('flags a proposal whose files are each small but together dwarf what they change', () => {
    const files = Array.from({ length: 6 }, (_, index) =>
      analyseChange(`part${index}.md`, 'same words here', 'same words here', { adds: 20, dels: 19 }));
    expect(files.every(file => file.churnFlag === false)).toBe(true);
    const rollup = proposalChurn(files);
    expect(rollup.lineChurn).toBe(234);
    expect(rollup.meaning).toBe(0);
    expect(rollup.flag).toBe(true);
  });
});
