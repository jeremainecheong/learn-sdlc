import { parseAssessment, parseStrictReview } from './strict-assessment';
import { strictEvidencePassed } from '../feedback/feedback.service';
const phase = { checks: { kind: 'config' }, rubric: { criteria: [{ key: 'contract' }] } } as any;
const review = () => ({ summary: 'Evidence covers the contract.', strengths: ['Specific boundary.'], improvements: [], processNote: 'Reviewed actual submitted source.', provider: 'local-ai:test-double', verdict: 'pass' as const, criteriaEvidence: [{ key: 'contract', met: true, evidence: 'requirements.md specifies due < today.', issue: '', nextStep: '' }] });

describe('Strict binary review policy', () => {
  it('accepts complete, internally consistent criterion evidence', () => {
    expect(parseStrictReview(review(), phase).verdict).toBe('pass');
    expect(strictEvidencePassed(phase, { checks: [{ id: 'contract', label: 'Contract', status: 'passed', detail: 'verified' }] }, review())).toBe(true);
  });
  it.each([
    { verdict: undefined }, { verdict: 'pass', criteriaEvidence: [] },
    { criteriaEvidence: [{ ...review().criteriaEvidence[0], key: 'invented' }] },
    { criteriaEvidence: [{ ...review().criteriaEvidence[0], met: false }] },
    { criteriaEvidence: [{ ...review().criteriaEvidence[0], evidence: '' }] },
    { criteriaEvidence: [{ ...review().criteriaEvidence[0], issue: 'This is wrong' }] },
    { strengths: 'good' }, { processNote: null },
  ])('refuses malformed or contradictory reviews %j', patch => {
    expect(() => parseStrictReview({ ...review(), ...patch }, phase)).toThrow();
  });
  it('a favorable AI verdict cannot override failed checks', () => {
    expect(strictEvidencePassed(phase, { checks: [{ id: 'contract', label: 'Missing', status: 'failed', detail: 'missing' }] }, review())).toBe(false);
    expect(strictEvidencePassed(phase, { checks: [] }, review())).toBe(false);
  });
  it('missing execution evidence cannot pass code even if every reported check is green', () => {
    const code = { ...phase, checks: { kind: 'code' } };
    const report = { checks: [{ id: 'suite', label: 'Tests', status: 'passed' as const, detail: 'green' }] };
    expect(strictEvidencePassed(code, report, review())).toBe(false);
    expect(strictEvidencePassed(code, { ...report, tests: { total: 0, passed: 0, failed: 0, errored: 0, cases: [] } }, review())).toBe(false);
  });
  it('provider errors cannot pass', () => {
    expect(strictEvidencePassed(phase, { checks: [] }, { ...review(), assessmentError: 'timeout' })).toBe(false);
  });
  it('does not equate superficial agreement or textual true with understanding', () => {
    expect(() => parseAssessment({ adequate: 'true', feedback: 'I agree', questions: [] })).toThrow();
    expect(parseAssessment({ adequate: false, feedback: 'No explanation of the diff.', questions: ['Why does due today remain excluded?'] }).adequate).toBe(false);
  });
});
