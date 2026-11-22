/**
 * What the API and the web app agree about an HTTP exchange beyond its body:
 * the response header names both sides spell, and the time an AI route may
 * take before the browser stops waiting. The class import's size header,
 * `COHORT_IMPORT_MAX_BYTES_HEADER`, is in ./cohort-export beside the import.
 */

/** The id the API logs a request under, set on every response and quoted by a learner on a 5xx. */
export const REQUEST_ID_HEADER = 'x-request-id' as const;

/** How many files a repository export left out, so the page can say what the archive withheld. */
export const EXPORT_WITHHELD_HEADER = 'x-export-withheld' as const;

/**
 * How long an AI route (the Agentic proposal, the customer interview) may run
 * before the API answers, so its answer reaches the browser before the browser
 * gives up at `AI_BROWSER_DEADLINE_MS`.
 */
export const AI_ROUTE_BUDGET_MS = 55_000;

/**
 * How long the browser waits for a reviewed AI reply before it stops waiting.
 * Always above `AI_ROUTE_BUDGET_MS`, which leaves the API time to answer.
 */
export const AI_BROWSER_DEADLINE_MS = 60_000;
