// The demo staff accounts, for the Node scripts that sign in as them.
//
// The native demo seeds both (SEED_DEMO_ACCOUNTS, and only while the API is
// bound to loopback), on passwords published in the README; the API refuses
// those passwords at sign-in whenever the network can reach it. The local
// Compose stack, whose API binds every interface inside its container,
// creates the instructor through scripts/stack-seed.mjs on a password
// generated for this machine and kept in .env.verify.
//
// The same values live in scripts/lib/common.sh for the shell scripts and in
// apps/api/src/seed/demo-accounts.ts for the API. They are deliberately not in
// packages/shared: the web bundle imports that package, and these passwords
// must never ship to a browser.

export const DEMO_INSTRUCTOR_EMAIL = 'instructor@learnsdlc.test';
export const DEMO_ADMIN_EMAIL = 'admin@learnsdlc.test';
export const DEMO_INSTRUCTOR_DEFAULT_PASSWORD = 'Instructor123!';
export const DEMO_ADMIN_DEFAULT_PASSWORD = 'Admin123!';

/** The native demo's instructor. SEED_PASSWORD, when set, is both accounts' password. */
export const DEMO_INSTRUCTOR = Object.freeze({
  email: DEMO_INSTRUCTOR_EMAIL,
  password: process.env.SEED_PASSWORD || DEMO_INSTRUCTOR_DEFAULT_PASSWORD,
});

/** The native demo's administrator, on the same SEED_PASSWORD rule. */
export const DEMO_ADMIN = Object.freeze({
  email: DEMO_ADMIN_EMAIL,
  password: process.env.SEED_PASSWORD || DEMO_ADMIN_DEFAULT_PASSWORD,
});

/** The .env.verify key that holds the local Compose stack's instructor password (scripts/stack.sh writes it). */
export const STACK_INSTRUCTOR_PASSWORD_KEY = 'STACK_INSTRUCTOR_PASSWORD';

/**
 * The local Compose stack's instructor, as scripts/stack-seed.mjs registers it:
 * the demo instructor's address, on the password generated for this machine.
 * `env` is .env.verify, read (readEnvFile in scripts/stack-seed.mjs).
 */
export function stackInstructor(env) {
  const password = env[STACK_INSTRUCTOR_PASSWORD_KEY];
  if (!password) {
    throw new Error(`.env.verify has no ${STACK_INSTRUCTOR_PASSWORD_KEY}; bash scripts/stack.sh up writes one.`);
  }
  return Object.freeze({ email: DEMO_INSTRUCTOR_EMAIL, password, displayName: 'Dana Instructor' });
}
