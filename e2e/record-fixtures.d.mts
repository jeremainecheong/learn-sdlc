// The types of e2e/record-fixtures.mjs, for the TypeScript that imports it
// (e2e/fixtures.ts, which the API's own specs reach as well).

/** TaskTrackr's passing runbook record, serialised, its incident empty. */
export declare const RUNBOOK_RECORD: string;
/** CR-2's passing change request record, serialised. */
export declare const CHANGE_REQUEST_RECORD: string;
/** The write-up that closes the incident drill. */
export declare const PASSING_INCIDENT: { rootCause: string; fix: string; actionItem: string };
