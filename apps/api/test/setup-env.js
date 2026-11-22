// Jest runs the API against an in-memory database and a quiet logger.
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';
process.env.API_PORT = '4100';

// Learner code runs in-process under jest; nothing resolves to the local
// runner on its own, so the suite asks for it (config.ts).
process.env.RUNNER_MODE = 'local';
// The end-to-end specs sign in as the seeded demo instructor, and the seed
// creates the demo accounts only when asked to.
process.env.SEED_DEMO_ACCOUNTS = 'true';
// Those specs sign in with the published default demo passwords, so a
// SEED_PASSWORD exported in the developer's shell must not reach the seed.
delete process.env.SEED_PASSWORD;
