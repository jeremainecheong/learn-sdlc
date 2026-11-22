import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import * as express from 'express';
import helmet from 'helmet';
import { COHORT_IMPORT_MAX_BYTES_HEADER, EXPORT_WITHHELD_HEADER, REQUEST_ID_HEADER } from '@learnsdlc/shared';
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';
// The upload path's body parser
import { UPLOAD_PATH, uploadBodyLimit, uploadJsonOnly, uploadParseRefusal } from './authoring/upload.service';
import {
  aiMaxConcurrency,
  API_PREFIX,
  assertBindSafety,
  assertGradingFanout,
  assertJwtSecretSet,
  assertProductionSecrets,
  config,
  resolveImportMaxBytes,
  webOriginList,
} from './config';
import { importGate, type ImportGateOptions } from './instructor/import-gate';
import { UnhandledErrorFilter, initErrorReporting } from './observability/errors';
import { buildLogger, requestLogging } from './observability/logger';
import { metricsAccess } from './observability/metrics';
import { aiReviewShare } from './assistant/openai.provider';
// The live preview door's own CORS preflight
import { previewDoorCors } from './preview/preview-proxy.controller';
import { COGNITO_MIGRATION_PATH } from './identity-migration/identity-migration.service';

/**
 * The body limit for every route without its own parser. A workspace PUT
 * carries several files, each valid up to about 200 KB, so the limit sits
 * above the default 100 KB and the DTO layer enforces the per-file size.
 */
const JSON_BODY_LIMIT = '4mb';

/** The identity migration trigger's body: one signed user record, never more. */
const IDENTITY_MIGRATION_BODY_LIMIT = '4kb';

/* --------------------------------- class imports ------------------------- */

/** The one route that carries a whole class, and so the one with its own ceiling. */
const IMPORT_PATH = `${API_PREFIX}/instructor/cohorts/import`;

/** Bytes as a person would write them, for a sentence rather than a log line. */
export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/**
 * body-parser's refusal, said the way the rest of the product says things.
 * Left to itself it answers `request entity too large`, which tells an
 * instructor neither how big their file is nor what to do about it. Mounted on
 * the import path immediately after its parser, so it sees that parser's
 * errors and nothing else's; anything that is not a size refusal is passed on
 * untouched to the global filter.
 */
export function importTooLarge(
  maxBytes: number,
): (error: unknown, req: express.Request, res: express.Response, next: (error?: unknown) => void) => void {
  return (error, _req, res, next) => {
    const failure = error as { type?: string; length?: number } | null;
    if (!failure || failure.type !== 'entity.too.large') return next(error);
    const size = typeof failure.length === 'number' && failure.length > 0 ? failure.length : 0;
    res.status(413).json({
      statusCode: 413,
      message:
        (size ? `That file is ${describeBytes(size)}. ` : 'That file is too large. ') +
        `An import accepts up to ${describeBytes(maxBytes)}. ` +
        'Export the class without the revision files.',
      error: 'Payload Too Large',
    });
  };
}

/**
 * Everything the HTTP layer is wrapped in, in the order it wraps. Exported so
 * a spec can mount it on a throwaway app and assert what a browser actually
 * receives, rather than having to run the whole server to notice a missing
 * middleware.
 */
export function configureApp(
  app: INestApplication,
  logger: LoggerService,
  /**
   * The token check the import gate runs before the 32 MB parser. `bootstrap`
   * hands it AuthService's; a spec mounting this layer on a throwaway app
   * leaves it null, and then no import body is ever read.
   */
  authenticate: ImportGateOptions['authenticate'] = null,
): void {
  // /metrics stays at the root so a Prometheus scraper's default path works.
  app.setGlobalPrefix(API_PREFIX.slice(1), { exclude: ['metrics'] });

  // Behind a load balancer or CDN every request arrives from the proxy, so
  // req.ip is the proxy's address and the whole internet shares one
  // rate-limit bucket. Trusting the hop count named by TRUSTED_PROXIES makes
  // req.ip the real client again. It stays 0 by default: trusting
  // X-Forwarded-For when nothing strips it lets a caller forge any IP and
  // walk straight past the limiter.
  app.getHttpAdapter().getInstance().set('trust proxy', config.trustedProxies);

  // First, so it wraps every response below it. These payloads are JSON and
  // CSV, which is to say they are mostly repeated key names: the submissions
  // list measured 51.1 KB uncompressed and 1.4 KB gzipped, the instructor
  // overview 17.2 KB and 1.9 KB, a learner's detail 40.6 KB and 4.3 KB. A
  // class of thirty opening the app moved 10.2 MB over a shared classroom
  // network, which is a second of everyone's first minute spent on whitespace.
  // The compose deployment has Caddy in front and Caddy compresses; the
  // single-laptop deployment this product is actually for has no edge at all,
  // so it has to happen here.
  app.use(compression());

  // Security headers. contentSecurityPolicy is disabled here because this
  // process serves only JSON APIs (the Next.js app sets its own CSP); COEP is
  // off so the browser client can call the API cross-origin.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  // The live preview door answers its own preflight, before
  // the allow list below refuses it. The preview frame is opaque-origin
  // (sandbox without allow-same-origin), so the learner's own application
  // calls their own API with `Origin: null`; the rule below is an allow list
  // of the web origins and would answer that preflight 204 with no
  // Access-Control-Allow-Origin, which a browser reads as a refusal. It has to
  // be registered here, in front of enableCors, because the CORS middleware
  // ends a preflight rather than passing it on. See preview-proxy.controller.ts.
  app.use(previewDoorCors());

  // Only the configured web origins may call the API with credentials.
  app.enableCors({
    origin: webOriginList(config.webOrigin),
    credentials: true,
    // Without this the browser hides the correlation id from scripts, and the
    // web app cannot show a learner the reference the log line carries.
    // And the import ceiling, so the class portability panel can
    // warn that an export is too large to bring in before anyone tries.
    exposedHeaders: [REQUEST_ID_HEADER, COHORT_IMPORT_MAX_BYTES_HEADER, EXPORT_WITHHELD_HEADER],
  });

  // A class export is one document and a class is bigger than a
  // workspace PUT, so this one route gets its own ceiling. Scoped to the path,
  // and declared before the 4 MB parser below because express uses the first
  // parser that matches: nothing else gains a 32 MB body limit.
  //
  // The limit is read here rather than taken off the frozen `config` object so
  // that a spec can mount this same HTTP layer with a small ceiling instead of
  // pushing 32 MB through a test client. In the running app the two are the
  // same value read from the same variable.
  const importMaxBytes = resolveImportMaxBytes();
  // Express middleware runs before every Nest guard, so on its own this parser
  // would read and hold up to the ceiling for anyone at all (no token, a
  // learner, a GET) before the guard's 401. The gate reads the token first, with the
  // same check the guard makes, and hands the parser only a staff POST
  // See instructor/import-gate.ts.
  app.use(
    IMPORT_PATH,
    importGate({
      authenticate,
      parse: express.json({
        limit: importMaxBytes,
        // The exact bytes, kept for the sha256 that makes "you have already
        // imported this file" a fact about the file rather than about a
        // re-serialisation of it.
        // Held by reference rather than copied: a copy would double the peak
        // for the largest body this process ever accepts.
        verify: (req, _res, buf) => {
          (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    }),
  );
  app.use(IMPORT_PATH, importTooLarge(importMaxBytes));

  // A teacher's project archive, base64 in JSON, on its own
  // path and behind the same staff gate (the cohort import's precedent). The
  // body limit is 4/3 of the archive cap plus 4 KiB (base64 overhead); the archive
  // cap itself is applied after decoding by UploadService, so a one-byte-over
  // archive is refused by sentence, and every parser error here is answered as
  // an upload refusal in JSON rather than an HTML page. A body of any
  // other type is refused there too (415), before a byte of it is read, so it
  // never reaches the global urlencoded parser below.
  app.use(
    UPLOAD_PATH,
    importGate({
      authenticate,
      parse: uploadJsonOnly(express.json({ limit: uploadBodyLimit(importMaxBytes) })),
    }),
  );
  app.use(UPLOAD_PATH, uploadParseRefusal(importMaxBytes));

  // Trusted Cognito migration signs the exact body. Keep its parser narrow and
  // bounded; passwords are never copied into general request diagnostics.
  app.use(COGNITO_MIGRATION_PATH, express.json({
    limit: IDENTITY_MIGRATION_BODY_LIMIT,
    verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; },
  }));
  app.use(COGNITO_MIGRATION_PATH, (
    error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction,
  ) => {
    // Parser errors can embed submitted bytes. Do not send those to diagnostics.
    const status = (error as { type?: string })?.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({ statusCode: status, message: 'identity migration request refused' });
  });

  // A workspace PUT carries several files, each valid up to ~200KB; raise the
  // body limit so legitimate workspaces are validated by the DTO layer (which
  // enforces per-file size), not rejected as 413 by the default 100KB parser.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ limit: JSON_BODY_LIMIT, extended: true }));

  app.use(requestLogging(logger));

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
  );

  // Every 5xx is logged with rid= and reported before the response leaves.
  app.useGlobalFilters(new UnhandledErrorFilter(app.getHttpAdapter()));

  // Lets Nest run onApplicationShutdown hooks (drain the job queue, close the
  // database) when the orchestrator sends SIGTERM.
  app.enableShutdownHooks();
}

async function bootstrap(): Promise<void> {
  // Fail fast before anything binds a port or touches data. The second check
  // is the one that matters off production: it asks who can reach this
  // process rather than what NODE_ENV says, and refuses the combinations that
  // hand a learner a shell or a forged admin token.
  assertProductionSecrets();
  assertBindSafety();
  // On a loopback bind outside production the two above let an unset secret
  // through; nothing can be signed without one, so it is refused here too.
  assertJwtSecretSet();
  // A grading fan-out above the runner's slots, or speculative mutants with
  // no fan-out, is refused here rather than discovered by a learner's review.
  assertGradingFanout();

  // Attached before the app exists so module-init failures are reported too.
  const errorsTo = initErrorReporting() ? 'sentry+log' : 'log';

  const logger = buildLogger(config.logFormat);
  const app = await NestFactory.create(AppModule, { logger });

  const auth = app.get(AuthService);
  configureApp(app, logger, (token) => auth.authenticate(token));

  // Loopback unless API_BIND says otherwise: a zero-configuration start is
  // reachable from this machine and nowhere else, and opening it to the
  // network is a decision someone made rather than a default they inherited.
  await app.listen(config.port, config.bindAddress);
  if (!config.bindIsLoopback) {
    logger.warn(
      `API_BIND=${config.bindAddress}: this API is reachable from the network. Learner code runs ` +
        `via RUNNER_MODE=${config.runnerMode}, the demo staff accounts are ` +
        `${config.seedDemoAccounts ? 'requested but refused on this bind' : 'not seeded'}, and ` +
        'JWT_SECRET is set. Put it behind TLS (docker-compose.yml) before a class uses it.',
      'Bootstrap',
    );
  }
  const metricsMode = { ok: 'open', 'bad-token': 'token', disabled: 'disabled' }[metricsAccess(undefined)];
  logger.log(
    `LearnSDLC API listening on ${config.bindAddress}:${config.port} (env=${config.nodeEnv}, db=${
      config.databaseUrl ? 'postgres' : 'sqlite'
    }, queue=${config.redisUrl ? 'redis' : 'in-process'}, runner=${config.runnerMode}, jobs=${
      config.jobConcurrency
    }, runnerSlots=${config.runnerSlots}, fanout=${config.gradingRunFanout ?? 'off'}, speculativeMutants=${
      config.gradingSpeculativeMutants ? 'on' : 'off'
    }, errors=${errorsTo}, metrics=${metricsMode})`,
    'Bootstrap',
  );
  // Once per boot: whether reviews (one model call per job) stay inside a third of the AI slots.
  const share = aiReviewShare(config.jobConcurrency, aiMaxConcurrency());
  if (share.within) logger.log(share.line, 'Bootstrap');
  else logger.warn(share.line, 'Bootstrap');
}

// Only when this file is the program. `node dist/main.js` and
// `ts-node src/main.ts` both are; a spec that imports `configureApp` is not,
// and must not find a server listening on :4000 as a side effect.
//
// The catch is the difference between a refusal and a crash dump. The boot
// imports the content directory, and every way that can refuse (a version
// already published from different bytes, a pack the loader will not take, a
// database the migration has not reached) arrives here as a rejected promise
// out of `onApplicationBootstrap`. Uncaught, an operator would meet an
// UnhandledPromiseRejection trace with the sentence somewhere inside it, and
// the exit code would be the runtime's rather than this process's.
if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`BOOT FAILED: ${message}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  });
}
