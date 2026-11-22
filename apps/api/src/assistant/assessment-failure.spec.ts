import { AI_REVIEW_BUSY_MESSAGE } from '@learnsdlc/shared';
import { AiBusyError } from '../execution/run-gate';
import { assessmentFailure } from './assessment-failure';
describe('safe assessment diagnostics', () => {
  it.each([
    ['openai api timed out after 180000ms','provider_timeout'],
    ['openai api returned HTTP 429','provider_http_error'],
    ['AI provider stopped before completing its response','incomplete_response'],
    ['AI review was not JSON','invalid_json'],
    ['Every rubric criterion needs explicit evidence','invalid_evidence'],
    ['Verdict contradicts criterion evidence','invalid_evidence'],
    ['Passing assessment did not ground every criterion in submitted evidence','ungrounded_pass'],
  ])('distinguishes %s without recording response content', (message, code) => {
    const result=assessmentFailure(new Error(message));
    expect(result.code).toBe(code);
    expect(result.learnerMessage.length).toBeGreaterThan(0);
  });
  it('does not leak arbitrary provider bodies, source, or credentials',()=>{
    const secret='Bearer should-never-be-logged';
    const result=assessmentFailure(new Error(`fetch failed: ${secret}; learner-source`));
    expect(result.code).toBe('provider_failure');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('learner-source');
  });
  // A review the AI gate refused after its queue wait is the class's load, not the provider's fault.
  it.each([['queue-full', 0], ['deadline', 120000]] as const)('files a gate refusal (%s) as provider_busy with the busy sentence', (reason, waited) => {
    const result = assessmentFailure(new AiBusyError(reason, waited));
    expect(result).toEqual({ code: 'provider_busy', detail: `gate=${reason} waitedMs=${waited}`, learnerMessage: AI_REVIEW_BUSY_MESSAGE });
  });
  it('says the reviewer is busy with the class, that no Pass was awarded and the work is saved', () => {
    expect(AI_REVIEW_BUSY_MESSAGE).toBe('The AI reviewer is busy with the rest of the class, so this review did not run. No Pass was awarded and your work is saved. Resubmit in a minute.');
    expect(AI_REVIEW_BUSY_MESSAGE).not.toMatch(/provider|runner/i);
  });
});
