import * as path from 'path';

/**
 * Where the suite's servers are, and the stamp that names this run's data.
 *
 * playwright.config.ts resolves each address once and writes it into the
 * environment before any worker loads a spec (workers re-read the config, so
 * they see the same values). Specs take them from here, so a port, an origin
 * or a default is decided in the config and nowhere else.
 */

function fromConfig(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is set by playwright.config.ts: run the browser tests through npx playwright test`);
  return value;
}

/** The API's origin, with no trailing slash and no /api/v1 prefix. */
export const API_ORIGIN = fromConfig('E2E_API_URL');

/** The versioned base every API route the specs call sits under. */
export const API = `${API_ORIGIN}/api/v1`;

/** The web app's origin: the config's baseURL. */
export const WEB_ORIGIN = fromConfig('E2E_WEB_URL');

/** The loopback AI stub (e2e/ai-stub.cjs) the API grades against during a run. */
export const AI_STUB_URL = `http://127.0.0.1:${fromConfig('PW_AI_PORT')}`;

/**
 * One stamp for the whole run, set by the runner and inherited by every worker.
 * A retry keeps it, so a spec whose later tests sign in to an account its first
 * test made still finds that account after a failure restarts the worker.
 */
export const RUN_ID = fromConfig('E2E_RUN_ID');

/** The last eight characters of RUN_ID, for names and slugs with a length cap. */
export const RUN = RUN_ID.slice(-8);

/**
 * The domain testEmail puts a made-up address under. Every address the suite
 * makes up, through testEmail or written out in a spec, is under a domain RFC
 * 2606 reserves (`.test`, and `.example` in the Google sign-in spec), so
 * nothing can ever be delivered there even if a run's mail settings point at a
 * real server. The seeded staff accounts keep the product seed's own addresses.
 */
export const TEST_EMAIL_DOMAIN = 'example.test';

/** A made-up address for a learner or teacher the suite creates. */
export function testEmail(localPart: string): string {
  return `${localPart}@${TEST_EMAIL_DOMAIN}`;
}

/**
 * Stops a spec that creates accounts, uploads projects or reads the database
 * file from running against anything but an API on this machine.
 */
export function assertLoopbackApi(specFile: string): void {
  if (!['localhost', '127.0.0.1'].includes(new URL(API_ORIGIN).hostname)) {
    throw new Error(`${path.relative(process.cwd(), specFile)} runs against a loopback API only`);
  }
}
