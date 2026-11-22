import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { configureApp } from '../../src/main';
import type { HttpTarget } from './http';

/** A logger that drops everything, for `configureApp`'s logger argument. */
export const silentLogger = { log() {}, error() {}, warn() {}, debug() {}, verbose() {} };

export interface BootOptions {
  /**
   * Providers replaced before the module compiles, as `[token, value]` pairs:
   * most specs replace the AI provider with a test double.
   */
  overrides?: ReadonlyArray<readonly [unknown, unknown]>;
  /**
   * `bootstrap` (the default) mounts the request pipeline `configureApp`
   * builds for the real server: the global prefix, the validation pipe, the
   * guards and the upload gate, with the gate checking tokens through
   * AuthService. `prefix` mounts only the `api/v1` prefix and a
   * `ValidationPipe({ whitelist: true, transform: true })`.
   */
  pipeline?: 'bootstrap' | 'prefix';
  /** With `pipeline: 'prefix'`, routes left outside the prefix (for example `metrics`). */
  excludeFromPrefix?: string[];
  /** Read the client address from `X-Forwarded-For`, so a spec can send each request from its own address. */
  trustProxy?: boolean;
  /**
   * Listen on an ephemeral loopback port (closed by `app.close()`). supertest
   * then reuses that one server instead of binding a port per request, which
   * keeps specs that make hundreds of requests from flaking on port churn.
   */
  listen?: boolean;
}

export interface BootedApi {
  app: INestApplication;
  http: HttpTarget;
  moduleRef: TestingModule;
}

/**
 * Boot the whole `AppModule` for an end-to-end spec, with Nest's own logging
 * off. The caller closes `app` in its `afterAll`.
 */
export async function bootApi(options: BootOptions = {}): Promise<BootedApi> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const [token, value] of options.overrides ?? []) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  if ((options.pipeline ?? 'bootstrap') === 'bootstrap') {
    configureApp(app, silentLogger, (token) => app.get(AuthService).authenticate(token));
  } else {
    const exclude = options.excludeFromPrefix;
    if (exclude) app.setGlobalPrefix('api/v1', { exclude });
    else app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  }
  if (options.trustProxy) app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.init();
  if (options.listen) await app.listen(0, '127.0.0.1');
  return { app, http: app.getHttpServer(), moduleRef };
}
