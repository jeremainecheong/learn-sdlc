import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { load } from 'js-yaml';
import * as path from 'path';
import { PLACEHOLDER_JWT_SECRETS, jwtSecretProblem } from '../src/config';
import * as demo from '../src/seed/demo-accounts';

/**
 * The session secrets of everything that starts the API without a person
 * choosing one: the browser suite, the CI jobs and the local-run scripts.
 *
 * The API starts only with a JWT_SECRET. The test harnesses pass a fixed one,
 * printed in their own files, so it has to be on the list of secrets the API
 * refuses wherever a real one is required; the scripts generate one and refuse
 * the same published values the API refuses, from a list of their own in
 * scripts/lib/common.sh that has to stay the API's list.
 */
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** What `published_jwt_secret` in scripts/lib/common.sh answers for a value. */
function shellSaysPublished(value: string): boolean {
  const result = spawnSync(
    'bash',
    ['-c', '. "$1"; published_jwt_secret "$2"', 'bash', path.join(ROOT, 'scripts/lib/common.sh'), value],
    { encoding: 'utf8' },
  );
  return result.status === 0;
}

/** The values the shell function's case pattern lists. */
function shellList(): string[] {
  const source = read('scripts/lib/common.sh');
  const body = source.slice(source.indexOf('published_jwt_secret() {'));
  const match = /case "\$value" in\s*\n\s*([^)\n]+)\)/.exec(body);
  if (!match) throw new Error('scripts/lib/common.sh no longer lists the published JWT secrets in published_jwt_secret');
  return match[1].split('|').map((entry) => entry.trim());
}

describe('the published JWT secrets', () => {
  it('are the same list in the API and in the local-run scripts', () => {
    expect(new Set(shellList())).toEqual(new Set(PLACEHOLDER_JWT_SECRETS));
    for (const value of PLACEHOLDER_JWT_SECRETS) {
      expect([value, shellSaysPublished(value)]).toEqual([value, true]);
      // Compared as the API compares them: edges trimmed, any case.
      expect(shellSaysPublished(`  ${value.toUpperCase()} `)).toBe(true);
    }
    expect(shellSaysPublished('a'.repeat(96))).toBe(false);
    expect(shellSaysPublished('')).toBe(false);
  });
});

describe('an API started without a JWT_SECRET', () => {
  it('refuses to start on a loopback bind outside production, naming the variable and the command that creates one', () => {
    const api = path.join(ROOT, 'apps/api');
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register', 'src/main.ts'], {
      cwd: api,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TS_NODE_TRANSPILE_ONLY: 'true',
        DB_PATH: ':memory:',
        API_PORT: '0',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'BOOT FAILED: refusing to start: JWT_SECRET is not set, and every session is signed with it; run bash scripts/setup.sh',
    );
  }, 90_000);
});

describe('the secret the browser suite starts the API with', () => {
  /** The value e2e/support/session-secret.ts gives every API the suite starts. */
  const suiteSecret = /export const E2E_JWT_SECRET = '([^']+)';/.exec(read('e2e/support/session-secret.ts'))?.[1];

  it('is a published test-only value the API refuses wherever a real secret is required', () => {
    expect(suiteSecret).toBeDefined();
    expect(PLACEHOLDER_JWT_SECRETS.has(suiteSecret as string)).toBe(true);
    expect(jwtSecretProblem(suiteSecret)).toMatch(/placeholders this repository ships/);
  });

  it('is given to every API the suite starts: the config\'s own and each one a spec spawns', () => {
    const files = [
      'playwright.config.ts',
      ...(fs.readdirSync(path.join(ROOT, 'e2e'), { recursive: true }) as string[])
        .filter((file) => /\.(ts|mjs|cjs|js)$/.test(file))
        .map((file) => path.join('e2e', file)),
    ];
    const starts: string[] = [];
    for (const file of files) {
      const lines = read(file).split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('apps/api/dist/main.js') || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
        starts.push(file);
        // The start's options are written in the lines that follow it.
        const options = lines.slice(index, index + 40).join('\n');
        const given = /JWT_SECRET: (E2E_JWT_SECRET|'([^']+)')/.exec(options);
        const value = given?.[2] ?? (given ? suiteSecret : undefined);
        expect([file, index + 1, PLACEHOLDER_JWT_SECRETS.has(value as string)]).toEqual([file, index + 1, true]);
      });
    }
    expect(starts).toEqual(expect.arrayContaining(['playwright.config.ts', path.join('e2e', 'google.spec.ts')]));
  });
});

describe('the CI jobs that start the API', () => {
  type Step = { run?: string; env?: Record<string, string> };
  type Job = { env?: Record<string, string>; steps?: Step[] };
  const jobs = (load(read('.github/workflows/ci.yml')) as { jobs: Record<string, Job> }).jobs;

  const startsTheApi = (step: Step): boolean => /node apps\/api\/dist\/main\.js/.test(step.run ?? '');

  /** A step that writes a random JWT_SECRET for the rest of the job, so the file publishes none. */
  const generatesItsSecret = (job: Job): boolean =>
    (job.steps ?? []).some((step) => /JWT_SECRET=\$jwt|JWT_SECRET=\$\(openssl rand/.test(step.run ?? '') && /GITHUB_ENV/.test(step.run ?? ''));

  it('each give it a JWT_SECRET: a published test-only one, or one generated for the run when the step runs in production', () => {
    const starting = Object.entries(jobs).filter(([, job]) => (job.steps ?? []).some(startsTheApi));
    expect(starting.length).toBeGreaterThanOrEqual(5);
    for (const [name, job] of starting) {
      for (const step of (job.steps ?? []).filter(startsTheApi)) {
        const env = { ...job.env, ...step.env };
        if (env.NODE_ENV === 'production') {
          // A literal here would be a published secret that a production boot accepts.
          expect([name, env.JWT_SECRET ?? null, generatesItsSecret(job)]).toEqual([name, null, true]);
        } else {
          expect([name, Boolean(env.JWT_SECRET)]).toEqual([name, true]);
          expect([name, PLACEHOLDER_JWT_SECRETS.has(env.JWT_SECRET as string)]).toEqual([name, true]);
        }
      }
    }
  });
});

describe('the demo staff accounts', () => {
  /** `NAME = 'value'` assignments in a script, as a map. */
  const assignments = (relative: string, pattern: RegExp): Record<string, string> =>
    Object.fromEntries([...read(relative).matchAll(pattern)].map((m) => [m[1], m[2]]));

  it('are the same addresses and published passwords in the API, the Node scripts and the shell scripts', () => {
    const node = assignments('scripts/lib/demo-accounts.mjs', /^export const ([A-Z_]+) = '([^']+)';$/gm);
    const shell = assignments('scripts/lib/common.sh', /^([A-Z_]+)='([^']+)'$/gm);
    const api = {
      DEMO_INSTRUCTOR_EMAIL: demo.DEMO_INSTRUCTOR_EMAIL,
      DEMO_ADMIN_EMAIL: demo.DEMO_ADMIN_EMAIL,
      DEMO_INSTRUCTOR_DEFAULT_PASSWORD: demo.DEMO_INSTRUCTOR_PASSWORD,
      DEMO_ADMIN_DEFAULT_PASSWORD: demo.DEMO_ADMIN_PASSWORD,
    };
    for (const [name, value] of Object.entries(api)) {
      expect([name, node[name], shell[name]]).toEqual([name, value, value]);
    }
    expect(new Set(demo.PUBLISHED_DEFAULT_PASSWORDS)).toEqual(
      new Set([api.DEMO_INSTRUCTOR_DEFAULT_PASSWORD, api.DEMO_ADMIN_DEFAULT_PASSWORD]),
    );
  });
});

describe('.env.example', () => {
  it('names QUIZ_SEED_SECRET, commented out, beside JWT_SECRET, with what it keys and what changing it does', () => {
    const lines = read('.env.example').split('\n');
    const jwt = lines.findIndex((line) => line.startsWith('JWT_SECRET='));
    const quiz = lines.findIndex((line) => /^#\s*QUIZ_SEED_SECRET=/.test(line));
    expect(jwt).toBeGreaterThan(-1);
    expect(quiz).toBeGreaterThan(jwt);
    expect(quiz - jwt).toBeLessThanOrEqual(5);
    const meaning = lines.slice(jwt + 1, quiz).join(' ');
    expect(meaning).toMatch(/quiz papers/);
    expect(meaning).toMatch(/JWT_SECRET when\s+#?\s*unset/);
    expect(meaning).toMatch(/redraws every open paper/);
    // Commented: an active empty line would read as "set" to a reader of the file.
    expect(lines.some((line) => /^QUIZ_SEED_SECRET=/.test(line))).toBe(false);
  });
});
