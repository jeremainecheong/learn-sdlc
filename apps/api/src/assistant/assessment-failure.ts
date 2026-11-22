import { AI_REVIEW_BUSY_MESSAGE } from '@learnsdlc/shared';
import { AiBusyError } from '../execution/run-gate';
import { EVIDENCE_OVER_CONTEXT_LIMIT, PROVIDER_EMPTY_RESPONSE, PROVIDER_HTTP_ERROR, PROVIDER_STOPPED_EARLY, PROVIDER_TIMED_OUT, REVIEW_NOT_JSON } from './provider-errors';

/** Provider diagnostics are selected from an allowlist. Never return or log an
 * upstream body, learner source, bearer credential, or arbitrary error text. */
export function assessmentFailure(error: unknown): { code: string; detail: string; learnerMessage: string } {
  // The AI gate refused the review after its queue wait (or its line was
  // full): the class's load, never the provider's failure. The detail is the
  // gate's fixed reason and the wait in ms, nothing else.
  if (error instanceof AiBusyError) return {
    code: 'provider_busy', detail: `gate=${error.reason} waitedMs=${error.waitedMs}`, learnerMessage: AI_REVIEW_BUSY_MESSAGE,
  };
  const message = error instanceof Error ? error.message : '';
  if (PROVIDER_TIMED_OUT.test(message)) return {
    code: 'provider_timeout', detail: message,
    learnerMessage: 'The AI assessment timed out. Your submitted evidence is saved; resubmit to request a new review.',
  };
  const http = PROVIDER_HTTP_ERROR.exec(message);
  if (http) return { code: 'provider_http_error', detail: `HTTP ${http[1]}`, learnerMessage: 'The AI provider could not complete the assessment. Your submitted evidence is saved; retry when the provider is available.' };
  const known: Record<string, [string, string]> = {
    [PROVIDER_STOPPED_EARLY]: ['incomplete_response', 'The AI response ended before the assessment was complete. Your work has not received a verdict; resubmit for another review.'],
    [PROVIDER_EMPTY_RESPONSE]: ['empty_response', 'The AI provider returned no assessment. Your evidence is saved; resubmit for another review.'],
    [REVIEW_NOT_JSON]: ['invalid_json', 'The AI provider returned an unreadable assessment. No approval was granted; resubmit for another review.'],
    'Passing assessment did not ground every criterion in submitted evidence': ['ungrounded_pass', 'The AI review did not connect every approved criterion to submitted evidence. No approval was granted; resubmit for an evidence-based review.'],
    [EVIDENCE_OVER_CONTEXT_LIMIT]: ['context_limit', 'The submitted evidence exceeds the configured assessment capacity. Ask your teacher or administrator to review the assessment configuration.'],
  };
  const schema = new Set(['Invalid review object', 'Missing binary verdict', 'Missing summary', 'Missing processNote', 'Invalid strengths', 'Invalid improvements', 'Every rubric criterion needs explicit evidence', 'Malformed criterion evidence', 'Unmet evidence requires an issue and next step', 'Contradictory criterion evidence', 'Verdict contradicts criterion evidence', 'Revision requires actionable feedback']);
  if (schema.has(message)) return { code: 'invalid_evidence', detail: message, learnerMessage: 'The AI provider returned incomplete or contradictory assessment evidence. No approval was granted; resubmit for another review.' };
  const matched = known[message];
  if (matched) return { code: matched[0], detail: message, learnerMessage: matched[1] };
  return { code: 'provider_failure', detail: 'Unclassified provider failure', learnerMessage: 'The AI provider failed or returned incomplete assessment evidence. Please resubmit.' };
}
