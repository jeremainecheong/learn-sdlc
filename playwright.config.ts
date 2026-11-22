import { defineConfig } from '@playwright/test';
import * as fs from 'fs';
import { DEFAULT_PORT as AI_STUB_DEFAULT_PORT, KEY as AI_STUB_KEY } from './e2e/ai-stub.cjs';
import { MAIL_CAPTURE_FILE } from './e2e/mail';
import { E2E_DATA_DIR } from './e2e/support/paths';
import { E2E_JWT_SECRET } from './e2e/support/session-secret';

// A preinstalled Chromium (remote dev environments, CI images) is used when
// present; otherwise Playwright falls back to its own managed browser.
// PW_CHROMIUM_PATH names a different preinstalled one.
const PREINSTALLED_CHROMIUM = process.env.PW_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const executablePath = fs.existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;

/**
 * Ports, so a suite can run beside a stack that already holds 3000/4000:
 *
 *   PW_WEB_PORT=3100 PW_API_PORT=4100 NEXT_PUBLIC_API_URL=http://localhost:4100 \
 *     npm run build -w @learnsdlc/web
 *   PW_WEB_PORT=3100 PW_API_PORT=4100 npx playwright test
 *
 * The build is a separate step because next build inlines NEXT_PUBLIC_API_URL
 * into the client bundle: a suite on non-default ports needs a web build that
 * was told the same API port, or the browser calls 4000 and every request
 * fails CORS. E2E_API_URL overrides the derived URL when the API is somewhere
 * else entirely.
 */
const webPort = Number(process.env.PW_WEB_PORT || 3000);
const apiPort = Number(process.env.PW_API_PORT || 4000);
/**
 * The canned AI the API talks to during a run (e2e/ai-stub.cjs): loopback
 * only, never a model, never packaged. A written phase passes its gate only on
 * an assessed verdict, so without it every spec past phase one would need a
 * real provider. The key is a literal the stub requires, not a secret.
 */
const aiPort = Number(process.env.PW_AI_PORT || AI_STUB_DEFAULT_PORT);
const webUrl = `http://localhost:${webPort}`;
// E2E_API_URL names the API's origin: the specs and the health probe below
// append /api/v1 themselves, so a value that already carries the prefix is
// trimmed rather than doubled into /api/v1/api/v1.
const apiUrl = (process.env.E2E_API_URL || `http://localhost:${apiPort}`)
  .replace(/\/+$/, '')
  .replace(/\/api\/v1$/, '');
// Workers re-evaluate this file before they load a spec, so putting the
// resolved addresses back into the environment gives the specs one source of
// truth instead of a second copy of each default (e2e/support/env.ts reads
// them).
process.env.E2E_API_URL = apiUrl;
process.env.E2E_WEB_URL = webUrl;
process.env.PW_AI_PORT = String(aiPort);
// One stamp for the whole run, set by the runner and inherited by every
// worker: a spec whose tests share an account made in its first test still
// finds it after a failure restarts the worker (a fresh Date.now() would not).
process.env.E2E_RUN_ID ||= String(Date.now());

// The API appends every message it would have sent to this file (a test hook;
// see e2e/mail.ts), removed here so a run reads only its own mail. Workers
// re-evaluate this config, and one starting mid-run must not wipe it, so only
// the runner process (the one without a worker index) does the clearing.
if (!process.env.TEST_WORKER_INDEX) fs.rmSync(MAIL_CAPTURE_FILE, { force: true });

/**
 * Tools, not suite cases. Each needs something the default stack does not
 * have, and says what in its own header; rather than skip themselves inside
 * `app`, they sit in a project of their own that exists only when the
 * switch they need is set. The skips a default run can report, each with
 * its sentence:
 *   - room-waiting-states.spec.ts, "Run app says it is starting…", where the
 *     phase detail says the runner cannot provide kernel isolation
 *     (previewUnsupported === 'isolation');
 *   - preview-unsupported.spec.ts, in the preview-off project, whenever its
 *     API has the preview switched on (anything but an API started with
 *     PREVIEW_ENABLED=false or a Lambda runner);
 *   - cases of a serial group (dossier.spec.ts, slices.spec.ts's six-phase
 *     walk, and the other files that set mode 'serial') left unrun behind a
 *     failed case of the same group.
 *
 *   screenshots.spec.ts         records the walkthrough            SCREENSHOTS=1
 *   @budget (workspace-shell)   the render budget, advisory        PW_BUDGET=1 … -g @budget
 */
const OPT_IN = [/screenshots\.spec\.ts/];
const OPT_IN_TAG = /@budget/;
const OPT_IN_SET = ['SCREENSHOTS', 'PW_BUDGET'].some((name) => Boolean(process.env[name]));
const NOT_APP = [/preview-unsupported\.spec\.ts/, /ai-stub\.test\.mjs$/, ...OPT_IN];

export default defineConfig({
  testDir: './e2e',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  /**
   * Two projects, and a bare `npx playwright test` (`npm run e2e`) runs both;
   * `--project=app` runs the first alone.
   *
   * `preview-off` holds the one spec in the suite that needs the API started
   * differently (`PREVIEW_ENABLED=false`, or a Lambda runner), and it is a
   * project rather than a case because `NEXT_PUBLIC_API_URL` is inlined into
   * the client bundle at build time: one web build talks to exactly one API,
   * so two APIs in one run would need two builds. It reads the same
   * `E2E_API_URL` every other spec does and skips itself with a sentence when
   * that API has the preview switched on.
   *
   *   PREVIEW_ENABLED=false npx playwright test --project=preview-off
   */
  projects: [
    {
      name: 'app',
      testIgnore: NOT_APP,
      grepInvert: OPT_IN_TAG,
    },
    { name: 'preview-off', testMatch: /preview-unsupported\.spec\.ts/ },
    ...(OPT_IN_SET
      ? [
          { name: 'opt-in', testMatch: OPT_IN },
          { name: 'budget', testMatch: /workspace-shell\.spec\.ts/, grep: OPT_IN_TAG },
        ]
      : []),
  ],
  use: {
    baseURL: webUrl,
    // A step that cannot succeed fails in under a minute instead of holding
    // the run until the test's own (up to 30 minute) budget runs out. What is
    // asserted is unchanged; only how long a stuck click or page load waits.
    actionTimeout: 45_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    // PW_VIDEO=1 records every run (for a walkthrough video)
    video: process.env.PW_VIDEO ? 'on' : 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: [
    {
      command: 'node e2e/ai-stub.cjs',
      env: { PW_AI_PORT: String(aiPort) },
      url: `http://127.0.0.1:${aiPort}/__stub/counts`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `rm -rf ${E2E_DATA_DIR} && node apps/api/dist/main.js`,
      // WEB_ORIGIN is the API's CORS allow-list, and several specs call the
      // API from the page's own origin; on non-default ports the default
      // http://localhost:3000 would reject them.
      env: {
        DB_PATH: `${E2E_DATA_DIR}/e2e.sqlite`,
        MAIL_CAPTURE_FILE,
        API_PORT: String(apiPort),
        WEB_ORIGIN: webUrl,
        // The API refuses to start without a session secret; this one is for
        // the suite only (e2e/support/session-secret.ts).
        JWT_SECRET: E2E_JWT_SECRET,
        // Nothing resolves to the in-process runner by default
        // (config.ts, resolveRunnerMode): the suite has to ask for it, and it
        // is allowed because the harness binds loopback.
        RUNNER_MODE: 'local',
        // instructor@ / admin@learnsdlc.test are not implied by
        // NODE_ENV != production; a dozen specs sign in as them.
        SEED_DEMO_ACCOUNTS: 'true',
        // Every AI request goes to the loopback stub above, one at a time.
        OPENAI_BASE_URL: `http://127.0.0.1:${aiPort}/v1`,
        OPENAI_API_KEY: AI_STUB_KEY,
        AI_MAX_CONCURRENCY: '1',
      },
      url: `${apiUrl}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The standalone server.js takes its port from PORT; the web package's
      // start script does not pin one.
      command: 'npm run start -w @learnsdlc/web',
      env: { PORT: String(webPort) },
      url: `${webUrl}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
