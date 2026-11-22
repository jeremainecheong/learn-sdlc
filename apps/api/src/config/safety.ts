import { jwtSecretProblem, secretProblem } from './auth';
import { resolveRunnerMode } from './runner';

/**
 * Fail fast rather than run a production deployment on development defaults:
 * a known JWT secret lets anyone mint an admin token, and without ADMIN_EMAIL
 * / ADMIN_PASSWORD a fresh deployment has no account that can suspend anyone
 * or reset a password, and nothing else would say so before the first
 * incident. A QUIZ_SEED_SECRET that is set is held to the JWT_SECRET rule,
 * because it keys the quiz papers and option tokens in its place. SEED_PASSWORD is not checked: the demo accounts it protects are
 * seeded only when SEED_DEMO_ACCOUNTS asks for them (seed.service.ts).
 *
 * This is the NODE_ENV=production half of the answer. The other half is
 * assertBindSafety, which runs everywhere, because the laptop hosting a
 * section sets no NODE_ENV and is the deployment the learners use.
 */
export function assertProductionSecrets(env = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const missing: string[] = [];
  if (jwtSecretProblem(env.JWT_SECRET)) missing.push('JWT_SECRET');
  const quizSeedSecret = resolveQuizSeedSecret(env);
  if (quizSeedSecret && secretProblem('QUIZ_SEED_SECRET', quizSeedSecret)) missing.push('QUIZ_SEED_SECRET');
  if (!env.ADMIN_EMAIL) missing.push('ADMIN_EMAIL');
  if (!env.ADMIN_PASSWORD) missing.push('ADMIN_PASSWORD');
  if (missing.length) {
    throw new Error(
      `refusing to start in production with development defaults: set ${missing.join(', ')} ` +
        '(a known or short JWT secret allows forged admin tokens — openssl rand -base64 48; ' +
        'a known or short QUIZ_SEED_SECRET lets learners predict quiz papers, so unset it or ' +
        'generate it the same way; ' +
        'ADMIN_EMAIL / ADMIN_PASSWORD create the first administrator on the first boot and are ' +
        'inert afterwards)',
    );
  }
  if (env.RUNNER_MODE === 'local') {
    throw new Error(
      'refusing to start in production with RUNNER_MODE=local: the local runner executes learner ' +
        'code as a child of this process, with this uid, this network and /proc access to this ' +
        "environment (JWT_SECRET, DATABASE_URL). Set RUNNER_MODE=socket (the runner container, see " +
        'docker-compose.yml) or RUNNER_MODE=lambda (the isolated runner Lambda).',
    );
  }
}

/**
 * The address the API binds. Loopback by default, so the zero-configuration
 * start is reachable from the machine it runs on and from nowhere else: the
 * laptop path seeds demo accounts and may run the in-process runner, and both
 * are safe exactly as long as nobody else can open a socket to this process.
 * Hosting a class is an explicit act (API_BIND=0.0.0.0), and it drags the
 * checks in assertBindSafety along with it.
 */
export function resolveBindAddress(env = process.env): string {
  return (env.API_BIND || '').trim() || '127.0.0.1';
}

/**
 * The JWT secret `config` loads with: JWT_SECRET, or empty when it is unset.
 * There is no fallback. An empty secret signs nothing, and assertJwtSecretSet
 * refuses that boot with a sentence before the API listens.
 */
export function resolveJwtSecret(env = process.env): string {
  return env.JWT_SECRET || '';
}

/**
 * The key quiz papers and option tokens are keyed with, when one is set:
 * QUIZ_SEED_SECRET as written, or empty when it is unset or only spaces, so
 * the key falls back to the JWT secret.
 */
export function resolveQuizSeedSecret(env = process.env): string {
  const raw = env.QUIZ_SEED_SECRET || '';
  return raw.trim() ? raw : '';
}

/**
 * The sentence the API refuses to start with when it has no session secret.
 * Every session is signed with it, so there is nothing to start without one.
 * scripts/setup.sh writes a generated one into .env. npm run demo,
 * scripts/start.sh, npm run dev and npm start read that file; the Docker stack
 * and npm run host keep their own. Running the built API directly
 * (node apps/api/dist/main.js) reads no .env, so it needs JWT_SECRET exported.
 */
export const JWT_SECRET_MISSING =
  'refusing to start: JWT_SECRET is not set, and every session is signed with it; run ' +
  'bash scripts/setup.sh, which generates one into .env for npm run demo, scripts/start.sh, ' +
  'npm run dev and npm start, or set JWT_SECRET=$(openssl rand -base64 48) in the environment';

/** Refuses a boot with no session secret, in every environment and on every bind. */
export function assertJwtSecretSet(env = process.env): void {
  if (!(env.JWT_SECRET || '').trim()) throw new Error(JWT_SECRET_MISSING);
}

/** Whether an address only the local machine can reach. */
export function isLoopbackAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === '::1' || value === '::ffff:127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * The checks that depend on who can reach this process, applied in every
 * environment rather than only when NODE_ENV says production. The laptop that
 * hosts a section is not "production" by any variable it sets, and it is the
 * deployment the learners are actually pointed at.
 */
export function assertBindSafety(env = process.env): void {
  const bind = resolveBindAddress(env);
  if (isLoopbackAddress(bind)) return;

  if (resolveRunnerMode(env) === 'local') {
    throw new Error(
      `refusing to bind ${bind} with RUNNER_MODE=local: the local runner executes learner code as ` +
        'a child of this process, with this uid, this network and /proc access to this environment ' +
        '(JWT_SECRET, DATABASE_URL), so every learner who can reach this address has a shell on ' +
        'this machine. Run the runner on a UNIX socket (RUNNER_MODE=socket, scripts/start.sh or ' +
        'docker-compose.yml) or in the runner Lambda (RUNNER_MODE=lambda), or bind loopback.',
    );
  }

  const problem = jwtSecretProblem(env.JWT_SECRET);
  if (problem) {
    throw new Error(
      `refusing to bind ${bind}: ${problem}. Anyone who can reach this address can then mint an ` +
        'admin token. Set JWT_SECRET=$(openssl rand -base64 48), or bind loopback (unset API_BIND).',
    );
  }

  const quizSeedSecret = resolveQuizSeedSecret(env);
  const quizProblem = quizSeedSecret ? secretProblem('QUIZ_SEED_SECRET', quizSeedSecret) : null;
  if (quizProblem) {
    throw new Error(
      `refusing to bind ${bind}: ${quizProblem}. It keys the quiz papers and option tokens, so a ` +
        'guessable value lets learners predict papers and map option tokens. Unset it (the key then ' +
        'falls back to JWT_SECRET), set QUIZ_SEED_SECRET=$(openssl rand -base64 48), or bind loopback.',
    );
  }
}
