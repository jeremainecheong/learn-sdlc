/**
 * The decision records on the design record.
 *
 * A decision keeps the day it was first accepted for ever after, its
 * consequences stay a list (blank lines kept while the learner types), and
 * every record the card writes is one the shared validator accepts, with no
 * null and no cleared optional key.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DESIGN_FLOOR, EMPTY_DESIGN, decidedOn, serialiseDesign, validateDesignRecord, type Design, type DesignDecision } from '@learnsdlc/shared';
import { emptyDecision } from '../components/workspace/panels/design/model';
import { withConsequences, withoutDecision } from '../components/workspace/panels/design/DecisionsCard';
import { useDesign, type DesignState } from '../components/workspace/panels/design/useDesign';

const SPEC = { contracts: { api: false, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR };

function probe(doc: Design): { state: DesignState; writes: string[] } {
  const writes: string[] = [];
  let state!: DesignState;
  function Probe() {
    state = useDesign({
      serverFiles: [{ path: 'design/design.json', content: serialiseDesign(doc) }],
      files: {},
      setFile: (_path, content) => writes.push(content),
      spec: SPEC,
      flushSave: async () => undefined,
      setNotice: () => undefined,
      setError: () => undefined,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return { state, writes };
}

const decision = (over: Partial<DesignDecision> = {}): DesignDecision => ({ ...emptyDecision([]), title: 'Storage', ...over });
const written = (text: string): Design => {
  const out = validateDesignRecord(text);
  if (out.error) throw new Error(out.error);
  return out.design!;
};

describe('a new decision', () => {
  it('starts proposed on the next free id, never a reused one', () => {
    expect(emptyDecision([{ ...decision(), id: 'D1' }, { ...decision(), id: 'D2' }]).id).toBe('D3');
    expect(emptyDecision([{ ...decision(), id: 'D2' }]).id).toBe('D3');
    expect(emptyDecision([]).status).toBe('proposed');
  });

  it('is a record the shared validator accepts', () => {
    expect(validateDesignRecord(serialiseDesign({ ...EMPTY_DESIGN, decisions: [emptyDecision([])] })).error).toBeNull();
  });

  it('writes no context and no consequences until the learner does', () => {
    expect(emptyDecision([])).not.toHaveProperty('context');
    expect(emptyDecision([])).not.toHaveProperty('consequences');
  });

  it('cuts a pasted consequence at the record\'s 4000-character field cap', () => {
    const pasted = withConsequences(decision(), `${'c'.repeat(5000)}\nshort`);
    expect(pasted.consequences).toEqual(['c'.repeat(4000), 'short']);
  });
});

describe('setDecisionStatus stamps the day it was first accepted', () => {
  it('stamps decidedAt on the first accept', () => {
    const { state, writes } = probe({ ...EMPTY_DESIGN, decisions: [decision()] });
    state.setDecisionStatus(0, 'accepted');
    const d = written(writes[0]).decisions[0];
    expect(d.status).toBe('accepted');
    expect(Number.isNaN(Date.parse(d.decidedAt ?? ''))).toBe(false);
  });

  it('never moves the stamp: accepting again, or superseding and accepting again, keeps it', () => {
    const stamp = '2026-03-04T09:15:00.000Z';
    const { state, writes } = probe({ ...EMPTY_DESIGN, decisions: [decision({ status: 'accepted', decidedAt: stamp })] });
    state.setDecisionStatus(0, 'superseded');
    state.setDecisionStatus(0, 'accepted');
    expect(written(writes[0]).decisions[0].decidedAt).toBe(stamp);
    expect(written(writes[1]).decisions[0].decidedAt).toBe(stamp);
  });

  it('a proposal is not stamped', () => {
    const { state, writes } = probe({ ...EMPTY_DESIGN, decisions: [decision({ status: 'accepted' })] });
    state.setDecisionStatus(0, 'proposed');
    expect(written(writes[0]).decisions[0].decidedAt).toBeUndefined();
  });
});

describe('the consequences stay a list', () => {
  it('keeps a blank line, because it is the line about to be typed into', () => {
    expect(withConsequences(decision(), 'one\n').consequences).toEqual(['one', '']);
  });

  it('keeps at most six lines', () => {
    const text = Array.from({ length: 12 }, (_, i) => `c${i}`).join('\n');
    expect(withConsequences(decision(), text).consequences).toHaveLength(6);
  });

  it('leaves the key out once the box is empty, and the record still validates', () => {
    const d = withConsequences(decision({ consequences: ['one'] }), '');
    expect('consequences' in d).toBe(false);
    expect(validateDesignRecord(serialiseDesign({ ...EMPTY_DESIGN, decisions: [d] })).error).toBeNull();
  });
});

describe('the day a decision was accepted', () => {
  it('reads in one shape wherever it is read', () => {
    expect(decidedOn('2026-03-04T23:50:00.000Z')).toBe('4 March 2026');
    expect(decidedOn(null)).toBe('');
    expect(decidedOn('not a date')).toBe('');
  });
});

describe('removing a decision', () => {
  it('clears every superseded-by link that named it, and only those', () => {
    const d1 = { ...emptyDecision([]), id: 'D1', title: 'Store in SQLite', status: 'superseded' as const, supersededBy: 'D2' };
    const d2 = { ...emptyDecision([]), id: 'D2', title: 'Store in Postgres', status: 'superseded' as const, supersededBy: 'D3' };
    const d3 = { ...emptyDecision([]), id: 'D3', title: 'Store in a file', status: 'accepted' as const };
    const left = withoutDecision([d1, d2, d3], 1);
    expect(left.map((d) => d.id)).toEqual(['D1', 'D3']);
    expect('supersededBy' in left[0]).toBe(false);
    expect(left[1]).toBe(d3);
    expect(withoutDecision([d1, d2, d3], 2)[1].supersededBy).toBeUndefined();
    expect(withoutDecision([d1, d2, d3], 2)[0].supersededBy).toBe('D2');
    const record: Design = { ...EMPTY_DESIGN, decisions: left };
    expect(validateDesignRecord(serialiseDesign(record)).error).toBeNull();
  });
});
