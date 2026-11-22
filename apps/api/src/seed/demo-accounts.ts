/**
 * The demo staff accounts the seed creates when SEED_DEMO_ACCOUNTS asks for
 * them, and the passwords they get when SEED_PASSWORD is unset.
 *
 * Those passwords are printed in the README, so they are passwords in name
 * only. The seed creates the accounts only on a loopback bind outside
 * production (seed.service.ts), and sign-in refuses an account that still has
 * one whenever the API is reachable from the network (auth.service.ts): a
 * database first used by `npm run demo` keeps its demo accounts when the same
 * data is later served to a room.
 *
 * The scripts hold the same values in scripts/lib/demo-accounts.mjs and
 * scripts/lib/common.sh, which the API cannot import; they are kept out of
 * packages/shared because the web bundle imports that package, and these
 * passwords must never ship to a browser. This module imports nothing.
 */
export const DEMO_INSTRUCTOR_EMAIL = 'instructor@learnsdlc.test';
export const DEMO_ADMIN_EMAIL = 'admin@learnsdlc.test';
export const DEMO_INSTRUCTOR_PASSWORD = 'Instructor123!';
export const DEMO_ADMIN_PASSWORD = 'Admin123!';

/**
 * Every password this repository publishes for the demo staff accounts. The
 * seeded class's learner password (`CLASS_PASSWORD` in demo/class-plan.ts) is
 * published too and is not in this set.
 */
export const PUBLISHED_DEFAULT_PASSWORDS: ReadonlySet<string> = new Set([
  DEMO_INSTRUCTOR_PASSWORD,
  DEMO_ADMIN_PASSWORD,
]);
