import * as path from 'path';
import { resolveCognitoConfig, resolveAllowedEmailDomains, resolveGoogleRedirectUrl, resolveJwtExpiresIn, resolvePasswordWork, resolveSignInMaxPerAddress } from './config/auth';
import { agenticEditListAtLoad, agenticPayloadAtLoad, type AgenticEditListMode, type AgenticPayloadMode } from './config/ai';
import { resolveImportMaxBytes } from './config/class-import';
import { DEFAULT_DB_PATH, resolveRunMigrations, resolveSchemaSync } from './config/database';
import { gradingFanoutAtLoad, resolveSubmitInFlightPerLearner } from './config/grading';
import { DEFAULT_API_PORT } from './config/http';
import { DEFAULT_PREVIEW_MEMORY_MB, resolvePreviewEnabled, resolvePreviewSessions, resolvePreviewSocket } from './config/preview';
import { contentDir, resolveDefaultProject, resolveNamedProject } from './config/project';
import { DEFAULT_RUN_MEMORY_MB } from './config/runner-budget';
import {
  resolveJobConcurrency,
  resolveRunnerMode,
  resolveRunnerSlots,
  resolveRunnerTransportAllowance,
  resolveRunnerWait,
} from './config/runner';
import { nonNegativeInt, positiveInt } from './config/parse';
import { isLoopbackAddress, resolveBindAddress, resolveJwtSecret, resolveQuizSeedSecret } from './config/safety';
import { DEFAULT_WEB_ORIGIN } from './config/web-origin';

/*
 * The API's configuration. The settings the API's modules read are resolved
 * in this file or in one of the modules under config/, each a set of
 * `resolveX(env = process.env)` functions grouped by area, all re-exported
 * here so `from './config'` reaches every one of them. Three readers take the
 * environment as a parameter of their own instead: the seed's account
 * variables (ADMIN_EMAIL, ADMIN_PASSWORD, SEED_DEMO_ACCOUNTS, SEED_PASSWORD in
 * seed/seed.service.ts), the lab's WEB_ORIGIN (classroom/lab.ts) and the
 * metrics' NODE_ENV (observability/metrics.ts).
 *
 * `config` below is built once, when this module loads. A setting that must
 * be read at call time instead (so a spec can change it while the process
 * runs, or so a value refused at boot does not refuse the module's load) is
 * exported as a resolver and called where it is used.
 *
 * A number read through `positiveInt` or `nonNegativeInt` that is absent or
 * malformed (`abc`, `15s`, `-3`, `2.5`) loads as its default rather than as
 * NaN or as the digits it happens to start with. SMTP_PORT, OPENAI_TIMEOUT_MS
 * and AI_CACHE_TTL_HOURS keep parsers of their own (`parseInt` and
 * `parseFloat`), so a value such as `15s` still loads as 15 there.
 */
export * from './config/ai';
export * from './config/auth';
export * from './config/class-import';
export * from './config/database';
export * from './config/demo';
export * from './config/execution';
export * from './config/grading';
export * from './config/http';
export * from './config/locale';
export * from './config/mail';
export * from './config/observability';
export * from './config/paths';
export * from './config/preview';
export * from './config/project';
export * from './config/retention';
export * from './config/runner';
export * from './config/runner-budget';
export * from './config/safety';
export * from './config/web-origin';

const bindAddress = resolveBindAddress();
const gradingFanout = gradingFanoutAtLoad();
const runnerWait = resolveRunnerWait();

export const config = {
  ...resolveCognitoConfig(),
  port: nonNegativeInt(process.env.API_PORT) ?? DEFAULT_API_PORT,
  /** The address the API listens on: loopback unless API_BIND says otherwise. */
  bindAddress,
  /** True while only this machine can reach the API. See assertBindSafety. */
  bindIsLoopback: isLoopbackAddress(bindAddress),
  webOrigin: process.env.WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
  /** JWT_SECRET; empty when unset, which assertJwtSecretSet refuses at boot. */
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: resolveJwtExpiresIn(),
  /**
   * The key quiz papers are drawn and option tokens minted with. Empty, the
   * default, means the JWT secret, so leaving it unset changes no paper.
   * Setting it lets the session secret be rotated without redrawing every
   * open paper; changing it redraws them. A value of only spaces counts as
   * unset. Off loopback and in production a set value must pass the same
   * strength rule as JWT_SECRET (assertBindSafety, assertProductionSecrets).
   * See quizSeedKey in quiz/quiz-attempts.service.ts.
   */
  quizSeedSecret: resolveQuizSeedSecret(),
  ...resolvePasswordWork(),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  dbPath: process.env.DB_PATH || DEFAULT_DB_PATH,
  databaseUrl: process.env.DATABASE_URL || '',
  /** Set to enable the durable Redis/BullMQ queue; empty = in-process queue. */
  redisUrl: process.env.REDIS_URL || '',
  /** Grading/run jobs one API process works on at once; see resolveJobConcurrency. */
  jobConcurrency: resolveJobConcurrency(),
  /** Concurrent sandbox children, jobs and request-path drill calls alike. */
  runnerSlots: resolveRunnerSlots(),
  /** The most sandbox runs one review holds at once; null runs them as they always ran. Mutable in specs. See resolveGradingRunFanout. */
  gradingRunFanout: gradingFanout.runFanout as number | null,
  /** Start a Testing review's mutant runs beside its reference runs. Mutable in specs. See resolveGradingSpeculativeMutants. */
  gradingSpeculativeMutants: gradingFanout.speculativeMutants as boolean,
  /** Longest a caller waits for a sandbox slot before the runner is called busy. */
  runnerMaxWaitMs: runnerWait.maxWaitMs,
  /** Callers allowed to wait for a sandbox slot at once; past it the answer is immediate. */
  runnerMaxWaiting: runnerWait.maxWaiting,
  /**
   * Queued-or-running submissions one learner may hold across every phase and
   * task. **Advisory**: a bare count with no lock behind it; the database's
   * only bound is `UQ_submissions_in_flight`. See resolveSubmitInFlightPerLearner.
   */
  submitInFlightPerLearner: resolveSubmitInFlightPerLearner(),
  jobAttempts: positiveInt(process.env.JOB_ATTEMPTS) ?? 3,
  /** Run DB migrations on boot (the production default; RUN_MIGRATIONS=false opts a replica out). */
  runMigrations: resolveRunMigrations(),
  /** Let TypeORM auto-sync the schema: development without migrations only, never production. */
  schemaSync: resolveSchemaSync(),
  logFormat: process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty'),
  contentDir,
  runnerDir: path.resolve(__dirname, '..', 'runner'),
  pythonBin: process.env.PYTHON_BIN || 'python3',
  // Number of proxy hops in front of this process. 0 = directly exposed.
  trustedProxies: nonNegativeInt(process.env.TRUSTED_PROXIES) ?? 0,
  /**
   * 'local' spawns the sandbox subprocess (development only); 'socket' POSTs
   * jobs to the runner service over a UNIX socket (runner/serve.py, the
   * compose production path); 'lambda' invokes the runner Lambda.
   */
  runnerMode: resolveRunnerMode(),
  runnerSocket: process.env.RUNNER_SOCKET || '/run/learnsdlc/runner.sock',
  lambdaFunction: process.env.RUNNER_LAMBDA_FUNCTION || 'learnsdlc-code-runner',
  awsEndpointUrl: process.env.AWS_ENDPOINT_URL || '',
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
  openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'none',
  /**
   * Create the demo staff accounts (instructor@ / admin@learnsdlc.test) with
   * their published passwords. Off unless asked for by name: NODE_ENV is not
   * the question, "can anyone else reach this" is, and the laptop that hosts a
   * section sets neither. The seed refuses it anyway unless the bind is
   * loopback and NODE_ENV is not production.
   */
  seedDemoAccounts: process.env.SEED_DEMO_ACCOUNTS === 'true',
  /** Password for the demo staff accounts above, when they are seeded at all. */
  seedPassword: process.env.SEED_PASSWORD || '',
  /** The first administrator, created once on the first boot with no ADMIN account. */
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  /**
   * Google sign-in, off until both halves of an OAuth client are present.
   * The pair is checked together everywhere rather than the id alone: an id
   * without a secret cannot complete the code exchange, so a deployment that
   * set one and forgot the other should show no button at all.
   */
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUrl: resolveGoogleRedirectUrl(),
  /** Addresses Google sign-in accepts; empty = any verified Google address. */
  allowedEmailDomains: resolveAllowedEmailDomains(),
  /** Sign-in attempts one address may make per minute across all accounts. */
  signInMaxPerAddress: resolveSignInMaxPerAddress(),
  /** The ceiling on a class import, in bytes. See resolveImportMaxBytes. */
  importMaxBytes: resolveImportMaxBytes(),
  runTimeoutSeconds: positiveInt(process.env.RUN_TIMEOUT_SECONDS) ?? 15,
  /** Cloud VM startup allowance; never extends the learner process time limit. */
  runnerTransportAllowanceSeconds: resolveRunnerTransportAllowance(),
  runMemoryMb: positiveInt(process.env.RUN_MEMORY_MB) ?? DEFAULT_RUN_MEMORY_MB,
  /** The pack this content directory ships; a slug fallback, not a learner's project. See resolveDefaultProject. */
  defaultProject: resolveDefaultProject(),
  /** The slug an operator named, if any. See resolveNamedProject. */
  namedProject: resolveNamedProject(),
  /* ---------------------------- live preview ---------------------------- */
  /** Whether "Run app" exists on this deployment at all. See resolvePreviewEnabled. */
  previewEnabled: resolvePreviewEnabled(),
  /** Live preview sessions this API process holds at once. See resolvePreviewSessions. */
  previewSessions: resolvePreviewSessions(),
  /** Memory one preview session's app may use, in MB. */
  previewMemoryMb: positiveInt(process.env.PREVIEW_MEMORY_MB) ?? DEFAULT_PREVIEW_MEMORY_MB,
  /** Seconds with no request and no status poll before a session is stopped. */
  previewIdleSeconds: positiveInt(process.env.PREVIEW_IDLE_SECONDS) ?? 300,
  /** Seconds a session may live whatever happens. */
  previewMaxSeconds: positiveInt(process.env.PREVIEW_MAX_SECONDS) ?? 600,
  /** Seconds the learner's API has to answer its health route before the start fails. */
  previewBootSeconds: positiveInt(process.env.PREVIEW_BOOT_SECONDS) ?? 45,
  /** Seconds the front end's esbuild bundle may take. */
  previewBuildSeconds: positiveInt(process.env.PREVIEW_BUILD_SECONDS) ?? 30,
  /** Bytes one session may serve through the door before it is stopped. */
  previewMaxBytes: positiveInt(process.env.PREVIEW_MAX_BYTES) ?? 33554432,
  /** One proxied request's ceiling, in milliseconds. */
  previewRequestTimeoutMs: positiveInt(process.env.PREVIEW_REQUEST_TIMEOUT_MS) ?? 20000,
  /** Where the preview transport listens. See resolvePreviewSocket. */
  previewSocket: resolvePreviewSocket(),
  /** The Agentic edit-list experiment, off unless named. Mutable in specs. See resolveAgenticEditList. */
  agenticEditList: agenticEditListAtLoad() as AgenticEditListMode,
  /** The Agentic generation payload, full unless named. Mutable in specs. See resolveAgenticPayload. */
  agenticPayload: agenticPayloadAtLoad() as AgenticPayloadMode,
};

/**
 * The public origin links point at. SITE_URL when set; otherwise the first
 * WEB_ORIGIN, which under compose is the same host the web image is built for.
 * The first entry is taken as written and trimmed only at the end, so an entry
 * of spaces gives an empty origin rather than the default.
 */
export function siteUrl(env = process.env): string {
  const raw = env.SITE_URL || config.webOrigin.split(',')[0] || DEFAULT_WEB_ORIGIN;
  return raw.trim().replace(/\/$/, '');
}
