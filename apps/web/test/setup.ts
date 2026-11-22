/**
 * Runs before every test file (vitest.config.ts, `setupFiles`).
 *
 * React checks that a test wraps its renders and state updates in `act` only
 * when this flag is set, and warns about an update that escapes it. Setting it
 * once here gives every file that check. A file that renders nothing is not
 * affected.
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export {};
