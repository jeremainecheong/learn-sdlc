import 'reflect-metadata';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { DataSource } from 'typeorm';
import type { AssistantService } from '../assistant/assistant.service';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import type { PhaseContent } from '../content/content.types';
import { COMPILER_IDENTITY, soleTaskFor, type CompiledTask } from '../content/pack-compiler';
import { fixtureQuizChecks } from '../../test/quiz-fixture';
import type { JobsService } from '../jobs/jobs.service';
import { DependencyStatus, HealthService, ReadinessReport } from './health.service';

/**
 * Readiness is the one endpoint the runbook tells an operator to curl, and the
 * runbook's most common symptom is the runner being unreachable. So the
 * property under test is not "the probe exists" but "the report names the
 * runner", and that a runner outage is told apart from a database one: the
 * first is a degraded instance that still serves reading and typing, the
 * second cannot serve at all.
 */
describe('HealthService readiness', () => {
  const runnerMode = config.runnerMode;
  const runnerSocket = config.runnerSocket;
  const lambdaFunction = config.lambdaFunction;
  let sockets: string[] = [];
  let servers: http.Server[] = [];

  const dataSource = (ok = true) =>
    ({
      options: { type: 'better-sqlite3' },
      query: jest.fn(async () => {
        if (!ok) throw new Error('connection refused');
        return [{ '1': 1 }];
      }),
    }) as unknown as DataSource;

  const jobs = (ok = true) =>
    ({
      backendName: 'in-process',
      durable: false,
      ping: jest.fn(async () => {
        if (!ok) throw new Error('redis is gone');
      }),
    }) as unknown as JobsService;

  const assistant = { activeProviderName: () => 'local' } as unknown as AssistantService;

  const build = (opts: { db?: boolean; queue?: boolean } = {}) =>
    new HealthService(dataSource(opts.db ?? true), jobs(opts.queue ?? true), assistant);

  const dependency = (report: ReadinessReport, name: string): DependencyStatus | undefined =>
    report.dependencies.find((d) => d.name === name);

  /** A stand-in for runner/serve.py: the same route, the same body. */
  const startRunner = async (answer: () => { status: number; body: string }): Promise<string> => {
    const socketPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'health-spec-')),
      'runner.sock',
    );
    const server = http.createServer((_req, res) => {
      const { status, body } = answer();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    servers.push(server);
    sockets.push(socketPath);
    return socketPath;
  };

  afterEach(async () => {
    config.runnerMode = runnerMode;
    config.runnerSocket = runnerSocket;
    config.lambdaFunction = lambdaFunction;
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) fs.rmSync(path.dirname(socket), { recursive: true, force: true });
    servers = [];
    sockets = [];
  });

  it('names the runner as the failing dependency when its socket is not there', async () => {
    config.runnerMode = 'socket';
    config.runnerSocket = path.join(os.tmpdir(), `absent-${Date.now()}.sock`);

    const report = await build().readiness();

    const runner = dependency(report, 'runner');
    expect(runner).toBeDefined();
    expect(runner!.ok).toBe(false);
    // The path is the whole diagnosis: a stale socket file, a runner that never
    // started and a container mounted on the wrong volume look identical without it.
    expect(runner!.detail).toContain(config.runnerSocket);
    expect(dependency(report, 'database')!.ok).toBe(true);
    expect(dependency(report, 'queue')!.ok).toBe(true);
  });

  it('calls a runner-only outage degraded, and a database outage down', async () => {
    config.runnerMode = 'socket';
    config.runnerSocket = path.join(os.tmpdir(), `absent-${Date.now()}.sock`);

    // Serving, with grading refused: a learner still reads their phase and
    // keeps their typing saved, so this instance is not out of service.
    expect((await build().readiness()).status).toBe('degraded');

    // Nothing works without the database, and readiness has to say so with the
    // status that takes the instance out of rotation.
    expect((await build({ db: false }).readiness()).status).toBe('down');
    expect((await build({ queue: false }).readiness()).status).toBe('down');
  });

  it('is ok when the runner answers on its socket', async () => {
    config.runnerMode = 'socket';
    config.runnerSocket = await startRunner(() => ({ status: 200, body: '{"ok": true,"isolation":{"status":"ok","mechanism":"landlock"}}' }));

    const report = await build().readiness();
    expect(report.status).toBe('ok');
    expect(dependency(report, 'runner')).toMatchObject({ ok: true, required: false });
  });

  it('refuses a runner that answers without ok, or with a body that is not a result', async () => {
    config.runnerMode = 'socket';
    config.runnerSocket = await startRunner(() => ({ status: 503, body: '{"ok": false}' }));
    expect(dependency(await build().readiness(), 'runner')!.ok).toBe(false);

    config.runnerSocket = await startRunner(() => ({ status: 200, body: 'not json' }));
    expect(dependency(await build().readiness(), 'runner')!.ok).toBe(false);

    config.runnerSocket = await startRunner(() => ({ status: 200, body: '{"ok": "yes"}' }));
    expect(dependency(await build().readiness(), 'runner')!.ok).toBe(false);
  });

  it('reads the configuration in lambda mode instead of invoking the function', async () => {
    config.runnerMode = 'lambda';
    config.lambdaFunction = 'learnsdlc-code-runner';
    const ok = await build().readiness();
    expect(dependency(ok, 'runner')).toMatchObject({ ok: true });
    expect(dependency(ok, 'runner')!.detail).toContain('learnsdlc-code-runner');

    config.lambdaFunction = '';
    const missing = await build().readiness();
    expect(dependency(missing, 'runner')!.ok).toBe(false);
    expect(missing.status).toBe('degraded');
  });

  describe('who may read where the runner is', () => {
    const TOKEN = 'health-spec-metrics-token';
    const heldToken = process.env.METRICS_TOKEN;
    beforeEach(() => {
      process.env.METRICS_TOKEN = TOKEN;
    });
    afterEach(() => {
      if (heldToken === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = heldToken;
    });

    it('names the socket path only to a caller with the metrics token, whether the runner answers or not', async () => {
      config.runnerMode = 'socket';
      config.runnerSocket = await startRunner(() => ({ status: 200, body: '{"ok": true,"isolation":{"status":"ok","mechanism":"landlock"}}' }));
      const open = dependency(await build().readiness(), 'runner')!;
      expect(open).toMatchObject({ ok: true, detail: 'socket runner' });
      expect(dependency(await build().readiness(`Bearer ${TOKEN}`), 'runner')!.detail).toContain(config.runnerSocket);

      for (const answer of [{ status: 503, body: '{"ok": false}' }, { status: 200, body: 'not json' }, { status: 200, body: '{"ok": "yes"}' }]) {
        config.runnerSocket = await startRunner(() => answer);
        const failed = dependency(await build().readiness(), 'runner')!;
        expect(failed.ok).toBe(false);
        expect(failed.detail).not.toContain(config.runnerSocket);
        expect(failed.detail).not.toContain(path.dirname(config.runnerSocket));
      }

      config.runnerSocket = path.join(os.tmpdir(), `absent-${Date.now()}.sock`);
      const absent = dependency(await build().readiness(), 'runner')!;
      expect(absent.ok).toBe(false);
      expect(absent.detail).not.toContain(config.runnerSocket);
      expect(dependency(await build().readiness(`Bearer ${TOKEN}`), 'runner')!.detail).toContain(config.runnerSocket);
    });

    it('names the Lambda function and region only to a caller with the metrics token', async () => {
      config.runnerMode = 'lambda';
      config.lambdaFunction = 'learnsdlc-code-runner';
      const open = dependency(await build().readiness(), 'runner')!;
      expect(open).toMatchObject({ ok: true, detail: 'lambda runner' });
      expect(open.detail).not.toContain(config.awsRegion);
      expect(dependency(await build().readiness(`Bearer ${TOKEN}`), 'runner')!.detail).toBe(
        `lambda learnsdlc-code-runner (${config.awsRegion})`,
      );
    });
  });

  it('reports local isolation unverified until the trusted boot probe answers', async () => {
    config.runnerMode = 'local';
    const report = await build().readiness();
    expect(dependency(report, 'runner')).toBeUndefined();
    expect(report.status).toBe('degraded');
    expect(dependency(report, 'isolation')).toMatchObject({ ok: false, required: false });
  });

  it('reports unsupported isolation independently of dependency availability', async () => {
    config.runnerMode = 'socket';
    config.runnerSocket = await startRunner(() => ({ status: 200,
      body: '{"ok":false,"isolation":{"status":"unsupported","mechanism":"none"}}' }));
    const report = await build().readiness();
    expect(report.status).toBe('degraded');
    expect(dependency(report, 'isolation')).toMatchObject({ ok: false, detail: 'kernel isolation is unsupported; execution is refused' });
    expect(dependency(report, 'prebake')?.detail).not.toContain('missing');
  });

  it('identifies microVM isolation and refuses a legacy or malformed capability claim', async () => {
    config.runnerMode = 'socket';
    for (const [isolation, supported] of [[{ status: 'ok', mechanism: 'single-job-microvm' }, true],
      [{ status: 'ok', mechanism: 'language-policy' }, false], [undefined, false]] as const) {
      config.runnerSocket = await startRunner(() => ({ status: 200, body: JSON.stringify({ ok: true, isolation }) }));
      const report = await build().readiness();
      expect(dependency(report, 'isolation')?.ok).toBe(supported);
      if (supported) expect(dependency(report, 'isolation')?.detail).toContain('single-job-microvm');
    }
  });

  it('is ok with a stored older Requirements of two written tasks and a quiz installed', async () => {
    // Stored versions can be shaped like this and this build serves them, so
    // the compiler line reads ok and readiness answers ok rather than degraded.
    config.runnerMode = 'socket';
    config.runnerSocket = await startRunner(() => ({ status: 200, body: '{"ok": true,"isolation":{"status":"ok","mechanism":"landlock"}}' }));
    const loader = new ContentService();
    loader.loadAll();
    const head = loader.getProject('tasktrackr');
    const phases = head.phases.map((phase) =>
      phase.key === 'requirements'
        ? ({ ...phase, artifactKind: 'markdown', checks: { kind: 'markdown', targets: ['requirements/my-story.md'], rules: [] } } as unknown as PhaseContent)
        : phase,
    );
    const quiz = fixtureQuizChecks();
    const tasksOf = (phase: PhaseContent): CompiledTask[] =>
      phase.key !== 'requirements'
        ? [soleTaskFor(phase)]
        : [
            { ...soleTaskFor(phase), taskKey: 'story', order: 1, checkKind: 'markdown' as never },
            { ...soleTaskFor(phase), taskKey: 'criteria', order: 2, checkKind: 'markdown' as never },
            { ...soleTaskFor(phase), taskKey: 'concepts', order: 3, checkKind: 'quiz', artefactType: 'quiz', artefactPath: null, owns: [],
              gradedUnits: quiz.questions.map((one) => ({ kind: 'question' as const, id: one.id })), checks: quiz },
          ];
    const content = new ContentService();
    content.installVersions([{
      versionId: 'v-older-written',
      content: { ...head, version: '2.0.1', phases },
      compiler: COMPILER_IDENTITY,
      phases: phases.map((phase) => ({ key: phase.key, tasks: tasksOf(phase) })),
    }]);

    const report = await new HealthService(dataSource(), jobs(), assistant, content).readiness();
    expect(dependency(report, 'content')).toMatchObject({ ok: true, required: true });
    expect(dependency(report, 'content-compiler')).toMatchObject({ ok: true, required: false });
    expect(report.status).toBe('ok');
  });
});
