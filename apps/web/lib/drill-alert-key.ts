/**
 * The start of every session-storage key that keeps an incident drill's alert
 * text for this browser tab (`components/workspace/panels/deployment/alert-text.ts`).
 * A module of its own, so the sign-out in `lib/session.ts` removes those keys
 * without loading the drill's code, and the two read one constant.
 */
export const DRILL_ALERT_PREFIX = 'learnsdlc:drill-alert:';
