import {
  cohenKappa,
  interviewRegexGuardrails,
  macroF1,
  mentorShapeGuardrails,
  percentile,
  verdictAgreement,
} from './metrics';

/*
 * The scorer's arithmetic on fixed fixtures. Every number here is
 * worked by hand in the comment beside it, so a change to the maths is a
 * change to a written expectation, not to a snapshot.
 */
describe('verdictAgreement', () => {
  it('counts accuracy, false passes, no-verdicts and needs-revision precision/recall/F1', () => {
    const rows = [
      { expected: 'needs_revision', got: 'needs_revision' }, // TP
      { expected: 'needs_revision', got: 'pass' }, // FN, and a false pass
      { expected: 'pass', got: 'pass' }, // TN
      { expected: 'pass', got: 'needs_revision' }, // FP
      { expected: 'needs_revision', got: null }, // no verdict: fails closed, counts as needs_revision
    ] as const;
    const out = verdictAgreement(rows as never);
    expect(out.n).toBe(5);
    // correct: TP, TN and the fail-closed no-verdict on a needs_revision case = 3/5
    expect(out.accuracy).toBeCloseTo(0.6, 6);
    expect(out.falsePass).toBe(1);
    expect(out.noVerdict).toBe(1);
    // needs_revision: TP = 2 (incl. the closed no-verdict), FP = 1, FN = 1
    expect(out.needsRevision.precision).toBeCloseTo(2 / 3, 6);
    expect(out.needsRevision.recall).toBeCloseTo(2 / 3, 6);
    expect(out.needsRevision.f1).toBeCloseTo(2 / 3, 6);
    // false-pass rate is over the expected needs_revision cases: 1 of 3
    expect(out.falsePassRate).toBeCloseTo(1 / 3, 6);
  });

  it('returns nulls, never NaN, on an empty set', () => {
    const out = verdictAgreement([]);
    expect(out.n).toBe(0);
    expect(out.accuracy).toBeNull();
    expect(out.needsRevision.f1).toBeNull();
  });
});

describe('macroF1', () => {
  it('averages the per-criterion F1 of "met"', () => {
    const pairs = [
      // criterion a: TP, TN, FP  -> P = 1/2, R = 1, F1 = 2/3
      { key: 'a', expected: true, got: true },
      { key: 'a', expected: false, got: false },
      { key: 'a', expected: false, got: true },
      // criterion b: TP, TP -> F1 = 1
      { key: 'b', expected: true, got: true },
      { key: 'b', expected: true, got: true },
    ];
    const out = macroF1(pairs);
    expect(out.perKey.a).toBeCloseTo(2 / 3, 6);
    expect(out.perKey.b).toBeCloseTo(1, 6);
    expect(out.macro).toBeCloseTo((2 / 3 + 1) / 2, 6);
  });

  it('scores a criterion with no positive anywhere as agreement (F1 = 1 when all negatives agree)', () => {
    const out = macroF1([{ key: 'c', expected: false, got: false }]);
    expect(out.perKey.c).toBe(1);
  });
});

describe('cohenKappa (1-5 scores binned 1-2 / 3 / 4-5)', () => {
  it('is 1 for identical bins and 0-ish for chance', () => {
    expect(cohenKappa([1, 3, 5, 4], [2, 3, 4, 5])).toBeCloseTo(1, 6);
  });
  it('matches a worked example', () => {
    // bins a: L L M H H ; b: L M M H L
    // agreement po = 3/5; pa: L .4 M .2 H .4 ; pb: L .4 M .4 H .2
    // pe = .16 + .08 + .08 = .32 ; kappa = (.6 - .32) / .68
    expect(cohenKappa([1, 2, 3, 4, 5], [1, 3, 3, 4, 2])).toBeCloseTo((0.6 - 0.32) / 0.68, 6);
  });
  it('returns null for fewer than two pairs', () => {
    expect(cohenKappa([3], [3])).toBeNull();
  });
});

describe('percentile (nearest rank)', () => {
  it('p50 and p95', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('interviewRegexGuardrails', () => {
  it('flags Given/When/Then lines, a written story, code fences, out-of-character tokens and length', () => {
    expect(interviewRegexGuardrails('Given a book on loan\nWhen I lend it\nThen it fails').gwt).toBe(true);
    expect(interviewRegexGuardrails('As a librarian I want to lend books so that readers can borrow.').story).toBe(true);
    expect(interviewRegexGuardrails('As a <role> I want <goal> so that <reason>').story).toBe(false);
    expect(interviewRegexGuardrails('```\ncode\n```').codeFence).toBe(true);
    expect(interviewRegexGuardrails('As an AI language model, I cannot.').outOfCharacter).toBe(true);
    expect(interviewRegexGuardrails(Array(95).fill('word').join(' ')).overLength).toBe(true);
    const clean = interviewRegexGuardrails('A book is free to borrow when it is on the shelf.');
    expect(clean.ok).toBe(true);
  });
});

describe('mentorShapeGuardrails', () => {
  it('requires at most 120 words, a closing question and no fenced block over two lines', () => {
    expect(mentorShapeGuardrails('Which line decides the boundary?').ok).toBe(true);
    expect(mentorShapeGuardrails('Look at the boundary.').endsWithQuestion).toBe(false);
    expect(mentorShapeGuardrails('Try this:\n```\na\nb\nc\n```\nWhat changes?').longFence).toBe(true);
    expect(mentorShapeGuardrails(`${Array(121).fill('w').join(' ')}?`).overLength).toBe(true);
  });
});
