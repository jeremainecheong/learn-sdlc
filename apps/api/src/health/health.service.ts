import { Inject, Injectable, Optional } from '@nestjs/common';
import * as http from 'http';
import { DataSource } from 'typeorm';
import { AssistantService } from '../assistant/assistant.service';
import { config } from '../config';
import { resolveAppVersion } from '../config/observability';
import {
  ContentService,
  describeCompilerDrift,
  describeUnservableVersion,
} from '../content/content.service';
import { JobsService } from '../jobs/jobs.service';
import { metricsAccess, withTimeout } from '../observability/metrics';
import { prebakeStatus, runnerIsolationStatus, parseRunnerIsolation, noteRunnerIsolation, RunnerIsolationStatus } from '../execution/sandbox.service';

const PROBE_TIMEOUT_MS = 2000;

export interface DependencyStatus {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * False for a dependency the API can serve traffic without. The runner is
   * the only one: with it down a learner still signs in, reads their phase and
   * keeps their typing saved, and only grading and runs are refused. Taking
   * the whole instance out of rotation for that costs more than it buys.
   */
  required: boolean;
}

export interface ReadinessReport {
  /**
   * `down` means this instance cannot serve traffic and is what answers 503;
   * `degraded` means it is serving with something missing: currently, only the runner.
   */
  status: 'ok' | 'degraded' | 'down';
  dependencies: DependencyStatus[];
  queue: { backend: string; durable: boolean };
  aiProvider: string;
  version: string;
  uptimeSeconds: number;
}

/**
 * Liveness vs readiness, as an orchestrator expects them:
 *
 * - **liveness** answers "is this process wedged?": cheap and dependency-free,
 *   so a blip in Postgres never causes Kubernetes to kill healthy pods.
 * - **readiness** actually probes the dependencies the app needs to serve
 *   traffic, so a pod that cannot reach its database is pulled from the load
 *   balancer instead of serving errors.
 */
@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();
  private socketIsolation: RunnerIsolationStatus = { status: 'unknown', mechanism: 'unknown' };

  constructor(
    private readonly dataSource: DataSource,
    private readonly jobs: JobsService,
    private readonly assistant: AssistantService,
    /**
     * Optional so that the specs which build this service by hand to ask one
     * question about the runner keep constructing it with three arguments. In
     * the application it is always injected, and the two probes below are the
     * only place readiness says anything about content.
     *
     * The token is explicit because the type cannot carry it: a parameter typed
     * `ContentService | null` emits `Object` as its design type, so with
     * `@Optional()` alone the container injected nothing and both probes were
     * missing from the mounted application (`app.e2e-spec.ts` holds this).
     */
    @Optional() @Inject(ContentService) private readonly content: ContentService | null = null,
  ) {}

  liveness(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  /**
   * Every probe is bounded: a readiness endpoint that hangs teaches the
   * orchestrator nothing until its own timeout fires, and ties up a connection
   * meanwhile. Failing fast is strictly better than hanging.
   */
  private async probe(
    name: string,
    detail: string,
    check: () => Promise<unknown>,
    required = true,
  ): Promise<DependencyStatus> {
    // withTimeout clears its timer whichever side wins: a timer left running
    // per dependency would keep the event loop busy for two seconds after each
    // readiness poll, which is exactly the window a SIGTERM drain waits out.
    try {
      await withTimeout(check(), PROBE_TIMEOUT_MS);
      return { name, ok: true, detail, required };
    } catch (err) {
      return { name, ok: false, detail: (err as Error).message, required };
    }
  }

  /**
   * The runner's own liveness route, over the same UNIX socket the API sends
   * jobs to: the probe `runner/serve.py --check` makes and `docker-compose.yml`
   * runs as the container's HEALTHCHECK. A socket file that is missing, stale
   * or unaccepted is the runbook's most common symptom, so the endpoint
   * operators are told to curl has to say something about it.
   *
   * `named` is who is asking, as in `contentProbes`: the socket path is an
   * operator's diagnosis, so a failure names it only to a caller
   * `metricsAccess` lets in, and says what failed without it to anyone else.
   */
  private pingRunnerSocket(named: boolean): Promise<void> {
    this.socketIsolation = { status: 'unknown', mechanism: 'unknown' };
    const on = named ? ` on ${config.runnerSocket}` : '';
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: config.runnerSocket,
          path: '/health',
          method: 'GET',
          timeout: PROBE_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode !== 200) {
              reject(new Error(`runner answered ${res.statusCode}${on}`));
              return;
            }
            try {
              const body: unknown = JSON.parse(text);
              this.socketIsolation = parseRunnerIsolation((body as { isolation?: unknown } | null)?.isolation);
              // The same report, for the Preview tab.
              noteRunnerIsolation('socket', this.socketIsolation);
              if (!body || (body as { ok?: unknown }).ok !== true) {
                reject(new Error(`runner is not ok${on}`));
                return;
              }
            } catch {
              reject(new Error(`runner returned no health body${on}`));
              return;
            }
            resolve();
          });
          res.on('error', reject);
        },
      );
      // 'timeout' only fires the event; the request has to be torn down by hand.
      req.on('timeout', () => req.destroy(new Error(`runner timed out${on}`)));
      req.on('error', (err: NodeJS.ErrnoException) =>
        // The driver's own message repeats the path, so an unnamed caller gets its code alone.
        reject(new Error(named ? `${config.runnerSocket}: ${err.message}` : `runner socket unreachable (${err.code ?? 'error'})`)),
      );
      req.end();
    });
  }

  /**
   * Null in local mode: the runner is this process, so there is nothing to
   * reach and a probe could only ever answer yes. `named` decides whether the
   * detail carries the socket path, or the Lambda function and region, or
   * only which transport this is (see `contentProbes`).
   */
  private runnerProbe(named: boolean): Promise<DependencyStatus> | null {
    if (config.runnerMode === 'socket') {
      return this.probe('runner', named ? `socket ${config.runnerSocket}` : 'socket runner', () => this.pingRunnerSocket(named), false);
    }
    if (config.runnerMode === 'lambda') {
      // Deliberately a configuration read and not an invoke: readiness is
      // polled every 30 seconds by the container and by whatever watches the
      // deployment, and a runner invoke costs a cold start and real money.
      // What this catches is the misconfiguration (an empty function name)
      // that would otherwise surface as every learner's first submission.
      return this.probe(
        'runner',
        named ? `lambda ${config.lambdaFunction} (${config.awsRegion})` : 'lambda runner',
        async () => {
          if (!config.lambdaFunction) throw new Error('RUNNER_LAMBDA_FUNCTION is not set');
          if (!config.awsRegion) throw new Error('AWS_REGION is not set');
        },
        false,
      );
    }
    return null;
  }

  /**
   * What this instance is teaching, and whether this build compiled it.
   *
   * Two entries rather than one, because they are two different days for an
   * operator. **`content`** is required: a project reaches the process
   * through `project_versions`, and an instance that
   * registered nothing answers `unknown project` to everybody while every
   * other probe reads green: exactly the silent failure the boot refusal
   * exists to prevent, restated for an instance that got past it.
   * **`content-compiler`** is not required, and is the honest home of the
   * compiler drift: a published version keeps the snapshot it was published
   * with, so a deployment whose code has moved on is serving correctly and the
   * only thing owed is a version bump. Saying it here, by version, is what
   * makes that detectable without a lone log line.
   *
   * `named` is who is asking. `GET /health/ready` is `@Public()` and answers
   * the whole report, so without this the slugs and the build's compiler
   * identity would be published to anyone who asked: every teacher-authored
   * project's slug included. The runner probe follows the same rule for the
   * socket path and the Lambda function and region. The
   * counts are what a load balancer's probe needs and stay public; the names
   * are an operator's and sit behind the credential `metricsAccess` already
   * defines for the same kind of detail: open on a laptop, closed in
   * production unless METRICS_TOKEN is set and presented. The boot log still
   * carries both in full, for an operator who is reading the process rather
   * than probing it.
   */
  private contentProbes(named: boolean): DependencyStatus[] {
    if (!this.content) return [];
    const projects = this.content.listProjects();
    const drift = this.content.compilerDrift();
    // Teacher-authored projects: a stored version this build cannot
    // grade. It is refused at the learner's seam rather than served, so no
    // learner meets it, which is precisely why an operator has to be told
    // here as well as in the boot log: the failure is a class whose enrolments
    // stop resolving, and nothing they do produces an error anyone else sees.
    const unservable = this.content.unservableVersions();
    return [
      {
        name: 'content',
        required: true,
        ok: projects.length > 0,
        detail: !projects.length
          ? 'no project is registered; this instance cannot answer a learner'
          : named
            ? projects.map((project) => `${project.slug} ${project.version}`).join(', ')
            : `${projects.length} project${projects.length === 1 ? '' : 's'} registered`,
      },
      {
        name: 'content-compiler',
        required: false,
        // An unservable version is the harder half of the same fact (a
        // snapshot this build did not compile AND cannot grade) so it reads
        // on the same line rather than on one an operator has to know to look
        // for, and it is what decides the line.
        ok: drift.length === 0 && unservable.length === 0,
        detail: !drift.length && !unservable.length
          ? 'every registered version was compiled by this build'
          : named
            ? [...unservable.map(describeUnservableVersion), ...drift.map(describeCompilerDrift)]
                .join(' ')
            : [
                unservable.length
                  ? `${unservable.length} registered version${unservable.length === 1 ? '' : 's'} ` +
                    'this build cannot grade and refuses to serve'
                  : '',
                drift.length
                  ? `${drift.length} registered version${drift.length === 1 ? '' : 's'} ` +
                    'compiled by another build'
                  : '',
              ]
                .filter(Boolean)
                .join('; ') + '; the boot log names them',
      },
    ];
  }

  async readiness(authorization?: string): Promise<ReadinessReport> {
    const named = metricsAccess(authorization) === 'ok';
    const runner = this.runnerProbe(named);
    const dependencies = await Promise.all([
      this.probe('database', String(this.dataSource.options.type), () =>
        this.dataSource.query('SELECT 1'),
      ),
      this.probe(
        'queue',
        config.redisUrl
          ? this.jobs.backendName
          : `${this.jobs.backendName} (not durable — set REDIS_URL in production)`,
        () => this.jobs.ping(),
      ),
      ...(runner ? [runner] : []),
      // The pre-baked dependency layer.
      // required: false, like the runner, because a machine with no layer still serves
      // every page that is not a run, and taking the instance out of rotation
      // for it would cost more than it buys.
      this.probe(
        'prebake',
        prebakeStatus().detail,
        async () => {
          const { status, detail } = prebakeStatus();
          if (status === 'missing' || status === 'stale') throw new Error(detail);
        },
        false,
      ),
    ]);

    dependencies.push(...this.contentProbes(named));

    if (config.runnerMode === 'local' || config.runnerMode === 'socket') {
      const isolation = config.runnerMode === 'local' ? runnerIsolationStatus() : this.socketIsolation;
      dependencies.push({ name: 'isolation', required: false, ok: isolation.status === 'ok',
        detail: isolation.status === 'ok' ? `kernel boundary: ${isolation.mechanism}`
          : isolation.status === 'unsupported' ? 'kernel isolation is unsupported; execution is refused'
            : 'kernel isolation has not been verified by this runner' });
    }

    const failed = dependencies.filter((d) => !d.ok);
    const status: ReadinessReport['status'] = !failed.length
      ? 'ok'
      : failed.some((d) => d.required)
        ? 'down'
        : 'degraded';

    return {
      status,
      dependencies,
      queue: { backend: this.jobs.backendName, durable: this.jobs.durable },
      aiProvider: this.assistant.activeProviderName(),
      version: resolveAppVersion() ?? 'dev',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}
