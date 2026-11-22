import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { configureApp } from '../src/main';
import {
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../src/db/entities';
import { bearer, HttpTarget } from './support/http';

/** The pack's own title, which the first commit's subject carries. */
const TITLE = 'TaskTrackr — a task manager you can run';

const silent: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
};

/** Walks a stored zip the way a zip reader does. */
function walkZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 8);
  const files = new Map<string, Buffer>();
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(at + 28);
    const size = zip.readUInt32LE(at + 24);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    files.set(name, zip.subarray(start, start + size));
    at += 46 + nameLength;
  }
  return files;
}

/**
 * Is there a git on this machine? The API must never need one (that is the
 * whole point of writing loose objects by hand) but CI has git because
 * `actions/checkout` requires it, and the case guarded by this is the one that
 * proves the format rather than proving our own reader agrees with itself.
 */
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The learner's project as a git repository, over HTTP.
 *
 * The service's own rules are in `repo.service.spec.ts` and the history's in
 * `history.spec.ts`. What is asserted here is everything those cannot see:
 * that the archive arrives as a download with the right headers, that a
 * project nobody started is a 404, that the fourth call in a minute is
 * refused, that one audit row is written per archive, and that real git reads
 * what we wrote.
 */
describe('Repository export (e2e)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  let learnerToken = '';
  let learnerId = '';
  let adminToken = '';
  let freshToken = '';

  const account = async (name: string, role: 'LEARNER' | 'ADMIN' = 'LEARNER') => {
    const email = `${name}-${stamp}@repo.test`;
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, displayName: 'Sam Tan' })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, email, token: registered.body.token as string };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app, silent);
    await app.init();
    http = app.getHttpServer();
    db = app.get(DataSource);

    const learner = await account('ada');
    learnerToken = learner.token;
    learnerId = learner.id;
    const admin = await account('root', 'ADMIN');
    adminToken = admin.token;

    await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(learnerToken))
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);

    // The attempts are written straight into the database rather than through
    // the grader: what is under test is the export, and a real submission
    // would put a sandbox run in the middle of it.
    const enrollment = await db.manager.findOneOrFail(EnrollmentEntity, {
      where: { userId: learnerId, projectSlug: 'tasktrackr' },
    });
    const state = await db.manager.findOneOrFail(PhaseStateEntity, {
      where: { enrollmentId: enrollment.id, phaseOrder: 1 },
    });
    const first = await db.manager.save(
      db.manager.create(SubmissionEntity, {
        phaseStateId: state.id,
        userId: learnerId,
        status: 'completed',
        score: 86,
        passed: true,
        commitMessage: 'Write the overdue story',
        workspaceSnapshot: { 'requirements/user-stories.md': '# As a user\n' },
      } as Partial<SubmissionEntity>),
    );
    const second = await db.manager.save(
      db.manager.create(SubmissionEntity, {
        phaseStateId: state.id,
        userId: learnerId,
        status: 'completed',
        score: 62,
        passed: false,
        commitMessage: 'Tighten the acceptance criteria',
        // Retention has been here: the row is kept, the files are gone.
        workspaceSnapshot: null,
      } as Partial<SubmissionEntity>),
    );
    // Two rows written in the same millisecond would be ordered by id, which
    // is right but not what this suite is about; the log order is pinned by
    // `history.spec.ts`.
    await db.manager.update(
      SubmissionEntity,
      { id: first.id },
      { createdAt: new Date('2026-03-01T09:00:00.000Z') },
    );
    await db.manager.update(
      SubmissionEntity,
      { id: second.id },
      { createdAt: new Date('2026-03-02T09:00:00.000Z') },
    );
    await db.manager.save(
      db.manager.create(ReleaseRecordEntity, {
        enrollmentId: enrollment.id,
        userId: learnerId,
        phaseStateId: state.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        version: 'v1',
        score: 86,
        notes: 'Merged the overdue story',
      } as Partial<ReleaseRecordEntity>),
    );

    const fresh = await account('lee');
    freshToken = fresh.token;
  });

  afterAll(async () => {
    await app?.close();
  });

  const download = async (token = learnerToken): Promise<Buffer> => {
    const res = await request(http)
      .get('/api/v1/repo/tasktrackr/export.zip')
      .set(bearer(token))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="tasktrackr-repo.zip"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    return res.body as Buffer;
  };

  it('hands a learner their own project as a zip', async () => {
    const zip = await download();
    const files = walkZip(zip);
    expect(files.get('.git/HEAD')?.toString('utf8')).toBe('ref: refs/heads/main\n');
    expect(files.get('.git/refs/heads/main')?.toString('utf8')).toMatch(/^[0-9a-f]{40}\n$/);
    expect(files.get('.git/refs/tags/v1')?.toString('utf8')).toMatch(/^[0-9a-f]{40}\n$/);
    // The working tree is readable without anyone touching git.
    expect(files.get('requirements/user-stories.md')?.toString('utf8')).toBe('# As a user\n');
    expect(files.get('README.md')?.toString('utf8')).toContain('# TaskTrackr');
    expect(files.get('docs/journal.md')?.toString('utf8')).toContain('# Journal');
    expect([...files.keys()].filter((name) => name.startsWith('.git/objects/')).length).toBeGreaterThan(
      5,
    );
    // The pack's reference answer is not the learner's work and is not here.
    expect(zip.includes('solutionFiles')).toBe(false);
  });

  it('is refused for a project the learner never started', async () => {
    const res = await request(http)
      .get('/api/v1/repo/tasktrackr/summary')
      .set(bearer(freshToken))
      .expect(404);
    expect(res.body.message).toBe('This project has not been started.');
  });

  it('answers a summary for a started project with counts and the tags', async () => {
    const res = await request(http)
      .get('/api/v1/repo/tasktrackr/summary')
      .set(bearer(learnerToken))
      .expect(200);
    // Two submissions plus the start and the record commits.
    expect(res.body.commits).toBe(4);
    expect(res.body.emptyCommits).toBe(1);
    expect(res.body.branch).toBe('main');
    expect(res.body.filename).toBe('tasktrackr-repo.zip');
    expect(res.body.tags).toHaveLength(1);
    expect(res.body.tags[0].name).toBe('v1');
    expect(res.body.tags[0].message).toBe('Merged the overdue story');
    expect(res.body.lastSubject).toBe('Tighten the acceptance criteria');
  });

  it('writes one audit row per archive', async () => {
    const before = await db.manager.count('audit_events' as never, {
      where: { event: 'repo.export', actorUserId: learnerId },
    } as never);
    await download();
    const rows = await request(http)
      .get(`/api/v1/instructor/audit?learnerId=${learnerId}`)
      .set(bearer(adminToken))
      .expect(200);
    const exports = rows.body.filter((row: any) => row.event === 'repo.export');
    expect(exports.length).toBeGreaterThan(Number(before));
    expect(exports[0].action).toBe('tasktrackr');
    expect(exports[0].detail.commits).toBe(4);
  });

  it('is refused after three archives in a minute', async () => {
    const fourth = await account(`rate-${Math.random().toString(36).slice(2, 8)}`);
    await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(fourth.token))
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    for (let i = 0; i < 3; i += 1) {
      await request(http)
        .get('/api/v1/repo/tasktrackr/export.zip')
        .set(bearer(fourth.token))
        .expect(200);
    }
    await request(http)
      .get('/api/v1/repo/tasktrackr/export.zip')
      .set(bearer(fourth.token))
      .expect(429);
  });

  (hasGit() ? it : it.skip)('git itself accepts what we wrote', async () => {
    const zip = await download();
    const files = walkZip(zip);
    const dir = mkdtempSync(path.join(tmpdir(), 'learnsdlc-repo-'));
    try {
      for (const [name, body] of files) {
        const at = path.join(dir, name);
        mkdirSync(path.dirname(at), { recursive: true });
        writeFileSync(at, body);
      }
      const git = (args: string[]): string =>
        execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

      const fsck = execFileSync('git', ['-C', dir, 'fsck', '--strict'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(fsck).not.toContain('error:');

      const log = git(['log', '--format=%s']).trim().split('\n');
      expect(log).toEqual([
        'Record the project',
        'Tighten the acceptance criteria',
        'Write the overdue story',
        `Start ${TITLE}`,
      ]);
      expect(git(['tag', '-n'])).toContain('Merged the overdue story');
      // The index we wrote is what makes this empty on the first try.
      expect(git(['status', '--porcelain']).trim()).toBe('');
      // An empty commit prints its message and no diff, which is the truth.
      expect(git(['show', '--stat', '--format=%s', 'HEAD~1']).trim()).toBe(
        'Tighten the acceptance criteria',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
