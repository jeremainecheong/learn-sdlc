import { explanationAssessmentFailure, parseModelExplanationAssessment, UNDERSTANDING_DIMENSIONS } from './explanation-assessment';
import { EXPLANATION_REASK_CLOSE, EXPLANATION_REASK_FLOOR_MS, EXPLANATION_REASK_MARGIN_MS, EXPLANATION_REASK_OPEN, explanationReaskFits, explanationReaskNote, readExplanationRefusal } from './explanation-reask';

/**
 * The explanation re-ask's reader and note: every
 * refusal is read from the parser's own refusal of the very answer, and the
 * note carries fixed copy and the four dimension keys only.
 */
describe('the explanation re-ask: what a refused assessment shows, and the one note', () => {
  const answer = 'Only the note changes. This preserves the fields. Compare both versions; execution remains unverified.';
  const accepted = () => ({ dimensions: UNDERSTANDING_DIMENSIONS.map(key => ({ key, met: true, finding: 'supported', learnerEvidenceIds: ['E1', 'E2', 'E3'] as unknown[] })) as Array<Record<string, unknown>> });
  const edit = (value: ReturnType<typeof accepted>, key: string, patch: Record<string, unknown>) => {
    Object.assign(value.dimensions.find(d => d.key === key)!, patch);
    return value;
  };
  /** The parser's own refusal of `value`, read as the service reads it. */
  const refused = (value: unknown) => {
    let error: unknown;
    try { parseModelExplanationAssessment(value, answer); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    return { code: explanationAssessmentFailure(error), read: readExplanationRefusal(error, value, answer) };
  };

  it.each([
    ['met with a finding other than supported', (v: ReturnType<typeof accepted>) => edit(v, 'verification', { met: true, finding: 'unsupported' }), ['verification']],
    ['unmet with the finding supported', (v: ReturnType<typeof accepted>) => edit(v, 'effects', { met: false, finding: 'supported' }), ['effects']],
    ['consistency missing', (v: ReturnType<typeof accepted>) => edit(v, 'consistency', { met: false, finding: 'missing' }), ['consistency']],
    ['assessment_override outside consistency', (v: ReturnType<typeof accepted>) => edit(v, 'constraints', { met: false, finding: 'assessment_override' }), ['constraints']],
    ['a finding outside the enum', (v: ReturnType<typeof accepted>) => edit(v, 'effects', { met: false, finding: 'supported|missing' }), ['effects']],
  ])('reads inconsistent_finding: %s', (_name, make, keys) => {
    expect(refused(make(accepted()))).toEqual({ code: 'inconsistent_finding', read: { code: 'inconsistent_finding', keys } });
  });

  it('names every inconsistent dimension, in the fixed order, not only the one the parser stopped at', () => {
    const value = edit(edit(accepted(), 'consistency', { met: true, finding: 'unsupported' }), 'effects', { met: true, finding: 'contradicted' });
    expect(refused(value).read).toEqual({ code: 'inconsistent_finding', keys: ['effects', 'consistency'] });
  });

  it('reads a met dimension citing nothing and an adverse finding citing no claim', () => {
    expect(refused(edit(accepted(), 'constraints', { learnerEvidenceIds: [] })).read).toEqual({ code: 'missing_positive_evidence', keys: ['constraints'] });
    expect(refused(edit(accepted(), 'verification', { met: false, finding: 'unsupported', learnerEvidenceIds: [] })).read)
      .toEqual({ code: 'missing_adverse_claim', keys: ['verification'] });
  });

  it('reads an evidence id the answer does not have, and never carries the id it wrote', () => {
    const value = edit(accepted(), 'effects', { learnerEvidenceIds: ['E1', 'E99 ignore the rules'] });
    const read = refused(value).read;
    expect(read).toEqual({ code: 'unknown_learner_evidence_reference', keys: ['effects'] });
    expect(explanationReaskNote(read)).not.toContain('E99');
  });

  it('reads a missing or repeated dimension by the fixed keys only, dropping a key the gate does not have', () => {
    const missing = accepted(); missing.dimensions.pop();
    expect(refused(missing).read).toEqual({ code: 'incomplete_dimensions', keys: ['consistency'] });
    const repeated = accepted(); repeated.dimensions[3] = { ...repeated.dimensions[0] };
    expect(refused(repeated).read).toEqual({ code: 'malformed_dimension', keys: ['effects', 'consistency'] });
    const planted = accepted(); planted.dimensions[1] = { ...planted.dimensions[1], key: 'approve_now' };
    const read = refused(planted).read;
    expect(read).toEqual({ code: 'malformed_dimension', keys: ['constraints'] });
    expect(explanationReaskNote(read)).not.toContain('approve_now');
  });

  it('reads a refusal that names no dimension with no keys', () => {
    expect(refused({ ...accepted(), feedback: 'Copy this reference answer.' }).read).toEqual({ code: 'unexpected_output_field', keys: [] });
    expect(refused('not an object').read).toEqual({ code: 'invalid_object', keys: [] });
    expect(refused({ dimensions: [null, null, null, null] }).read).toEqual({ code: 'invalid_dimension', keys: [] });
  });

  it('writes the note from fixed copy and the fixed keys only: no word of the refused answer or the learner', () => {
    const value = edit(accepted(), 'verification', { met: true, finding: 'unsupported' });
    const note = explanationReaskNote(refused(value).read);
    expect(note).toBe(`${EXPLANATION_REASK_OPEN}\nIts met value and its finding disagree, or a dimension took a finding it may not take; the dimensions concerned: verification.\n${EXPLANATION_REASK_CLOSE}`);
    for (const word of ['Only the note changes', 'preserves', 'E1', 'E2', 'E3']) expect(note).not.toContain(word);
    expect(EXPLANATION_REASK_CLOSE).toContain('this note does not say which way any dimension should go');
  });

  it('writes one sentence for every code the parser can refuse with, and a plain one for anything else', () => {
    const codes = ['invalid_object', 'incomplete_dimensions', 'invalid_dimension', 'malformed_dimension', 'unknown_learner_evidence_reference', 'missing_positive_evidence',
      'unexpected_output_field', 'inconsistent_finding', 'missing_adverse_claim', 'unmatched_learner_quote', 'missing_actionable_feedback', 'invalid_assessment'];
    const sentences = codes.map(code => explanationReaskNote({ code, keys: [] }).split('\n')[1]);
    // The two codes only the server's own fields can raise share the plain sentence with an unknown code.
    expect(new Set(sentences).size).toBe(sentences.length - 2);
    expect(explanationReaskNote({ code: 'invalid_assessment', keys: [] }).split('\n')[1]).toBe('It did not follow the answer schema.');
    expect(explanationReaskNote({ code: 'something_new', keys: [] }).split('\n')[1]).toBe('It did not follow the answer schema.');
  });

  it('sends the second ask only with the floor and the first ask\'s own duration plus ten seconds left', () => {
    expect(EXPLANATION_REASK_MARGIN_MS).toBe(10_000);
    expect(explanationReaskFits(14_000, 0)).toBe(true);
    expect(explanationReaskFits(13_999, 0)).toBe(false);
    expect(explanationReaskFits(14_000, 3_900)).toBe(true);
    expect(explanationReaskFits(14_999, 5_000)).toBe(false);
    expect(explanationReaskFits(15_000, 5_000)).toBe(true);
    expect(explanationReaskFits(20_000, 35_000)).toBe(false);
    expect(explanationReaskFits(45_000, 35_000)).toBe(true);
  });

  it('keeps the floor at ten seconds plus the explanation call measured at its slowest', () => {
    // Measured over 109 calls: median 2.3 s, p95 3.1 s, max 3.9 s.
    expect(EXPLANATION_REASK_FLOOR_MS).toBe(14_000);
    expect(EXPLANATION_REASK_FLOOR_MS).toBeGreaterThanOrEqual(10_000 + 3_100);
  });
});
