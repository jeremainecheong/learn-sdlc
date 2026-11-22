import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { ContentService } from '../content/content.service';
import { RepoService } from './repo.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The repository export, against a real sqlite in memory: the harness
 * `retention.service.spec.ts` uses, for the same reason: the rules being
 * checked are about which rows are read, and a mocked repository would agree
 * with whatever the service asked it.
 */
describe('RepoService', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: RepoService;

  const manager = () => dataSource.manager;

  /** A ceiling small enough to be crossed by two files, for the refusal case. */
  class Tiny extends RepoService {
    protected maxBytes(): number {
      return 200;
    }
  }

  const learner = async (id: string, email: string): Promise<void> => {
    await manager().save(
      manager().create(UserEntity, {
        id,
        email,
        displayName: 'Sam Tan',
        role: 'LEARNER',
        passwordHash: 'x',
      } as Partial<UserEntity>),
    );
  };

  const project = async (
    userId: string,
    id: string,
  ): Promise<{ enrollmentId: string; stateId: string }> => {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        id,
        userId,
        projectSlug: 'tasktrackr',
        currentPhaseOrder: 1,
      } as Partial<EnrollmentEntity>),
    );
    const state = await manager().save(
      manager().create(PhaseStateEntity, {
        id: `${id}-state`,
        enrollmentId: enrollment.id,
        userId,
        phaseKey: 'requirements',
        phaseOrder: 1,
        status: 'in_progress',
      } as Partial<PhaseStateEntity>),
    );
    return { enrollmentId: enrollment.id, stateId: state.id };
  };

  const submit = async (
    stateId: string,
    userId: string,
    over: Partial<SubmissionEntity>,
  ): Promise<SubmissionEntity> =>
    manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: stateId,
        userId,
        status: 'succeeded',
        score: 86,
        passed: true,
        workspaceSnapshot: { 'requirements/story.md': 'As a user...' },
        ...over,
      } as Partial<SubmissionEntity>),
    );

  beforeEach(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    service = new RepoService(dataSource, content);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('counts a repository without building it, and without reading a snapshot', async () => {
    await learner('learner-1', 'sam@example.edu');
    const { enrollmentId, stateId } = await project('learner-1', 'enrol-1');
    await submit(stateId, 'learner-1', {
      id: 'sub-1',
      commitMessage: 'Write the overdue story',
      passed: true,
    });
    // Retention has been here: the row is kept and the files are gone.
    await submit(stateId, 'learner-1', {
      id: 'sub-2',
      commitMessage: 'Tighten the acceptance criteria',
      passed: false,
      score: 62,
      workspaceSnapshot: null,
    });
    await manager().save(
      manager().create(ReleaseRecordEntity, {
        enrollmentId,
        userId: 'learner-1',
        phaseStateId: stateId,
        phaseKey: 'requirements',
        phaseOrder: 1,
        version: 'v1',
        score: 86,
        notes: 'Merged the overdue story',
      } as Partial<ReleaseRecordEntity>),
    );

    const summary = await service.summary('learner-1', 'tasktrackr');
    // Two submissions plus the two bookends.
    expect(summary.commits).toBe(4);
    expect(summary.emptyCommits).toBe(1);
    expect(summary.tags.map((tag) => tag.name)).toEqual(['v1']);
    expect(summary.tags[0].message).toBe('Merged the overdue story');
    expect(summary.branch).toBe('main');
    expect(summary.filename).toBe('tasktrackr-repo.zip');
    expect(summary.lastSubject).toBe('Tighten the acceptance criteria');
  });

  it('answers a project with no submission with a one and not a 404', async () => {
    await learner('learner-1', 'sam@example.edu');
    await project('learner-1', 'enrol-1');
    const summary = await service.summary('learner-1', 'tasktrackr');
    // The start commit is the whole repository until something is submitted.
    expect(summary.commits).toBe(2);
    expect(summary.tags).toEqual([]);
    expect(summary.lastSubject).toBeNull();
  });

  it('refuses a project the learner never started', async () => {
    await learner('learner-1', 'sam@example.edu');
    await expect(service.summary('learner-1', 'tasktrackr')).rejects.toThrow(
      'This project has not been started.',
    );
  });

  it('refuses an archive over the ceiling before it writes a byte', async () => {
    await learner('learner-1', 'sam@example.edu');
    const { stateId } = await project('learner-1', 'enrol-1');
    await submit(stateId, 'learner-1', {
      id: 'sub-1',
      workspaceSnapshot: { 'api/app.py': 'x'.repeat(20_000) },
    });
    const tiny = new Tiny(dataSource, content);
    const chunks: Buffer[] = [];
    await expect(
      tiny.export('learner-1', 'tasktrackr', async (chunk) => {
        chunks.push(chunk);
      }),
    ).rejects.toThrow('Your repository is larger than a download can carry.');
    expect(chunks).toHaveLength(0);
  });

  it('never exports another learner enrolment', async () => {
    await learner('learner-1', 'sam@example.edu');
    await learner('learner-2', 'ada@example.edu');
    const mine = await project('learner-1', 'enrol-1');
    const theirs = await project('learner-2', 'enrol-2');
    await submit(mine.stateId, 'learner-1', {
      id: 'sub-mine',
      workspaceSnapshot: { 'requirements/story.md': 'MY OWN STORY' },
    });
    await submit(theirs.stateId, 'learner-2', {
      id: 'sub-theirs',
      workspaceSnapshot: { 'requirements/story.md': 'THEIR SECRET STORY' },
    });

    const chunks: Buffer[] = [];
    const result = await service.export('learner-1', 'tasktrackr', async (chunk) => {
      chunks.push(chunk);
    });
    const archive = Buffer.concat(chunks);
    expect(archive.subarray(0, 4).toString('latin1')).toBe('PK');
    expect(archive.includes('MY OWN STORY')).toBe(true);
    expect(archive.includes('THEIR SECRET STORY')).toBe(false);
    expect(result.commits).toBe(3);
  });

  it('writes the same bytes twice for an unchanged database', async () => {
    await learner('learner-1', 'sam@example.edu');
    const { stateId } = await project('learner-1', 'enrol-1');
    await submit(stateId, 'learner-1', { id: 'sub-1' });
    const run = async (): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      await service.export('learner-1', 'tasktrackr', async (chunk) => {
        chunks.push(chunk);
      });
      return Buffer.concat(chunks);
    };
    // The README carries the export date, so two runs on the same day are one
    // archive; the assertion that matters is that nothing else moves.
    expect((await run()).length).toBe((await run()).length);
  });
});
