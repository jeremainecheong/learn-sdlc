import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ContentService } from '../content/content.service';
import type { ProjectContent } from '../content/content.types';
import {
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { PreviewService } from '../preview/preview.service';
import { RepoService } from './repo.service';
import { memoryDataSource } from '../../test/support/memory-db';

/*
 * The four content resolutions an enrolment owns in the repository and
 * preview services: the repository card, the archive the learner downloads,
 * the dossier journal and the live preview.
 *
 * A file of its own rather than an assertion bolted onto
 * `repo.service.spec.ts`, because the journal (`journalFor`) and the archive
 * (`export`) are separate resolutions in `repo.service.ts`: a test of the
 * journal alone would go green over the archive still answering from the
 * published head.
 *
 * Two halves. **Which project** each of the four resolves is asserted below,
 * against a catalogue holding a second project with a different title and a
 * different phase count, so a reader that reached for anything but the
 * learner's own enrolment fails. **Which version** is the other half, and it
 * goes through `ContentService.getForEnrollment`: the catalogue holds two
 * published versions of the enrolment's own project,
 * differing in title, in phase titles, in phase count and in whether there is
 * an app to run, and each row below is a learner pinned to the older one while
 * the newer one is published.
 */

/** The project the enrolment names, at its published head: two phases, and a preview to start. */
const PINNED = {
  slug: 'ledger',
  title: 'Ledger',
  version: '2.0.0',
  build: { tool: 'esbuild', entry: 'web/src/main.tsx', outfile: 'web/dist/app.js', jsx: 'automatic' },
  preview: {
    service: { command: ['python3', 'api/main.py'], portEnv: 'PORT', health: '/api/health' },
    web: { root: 'web/dist', html: 'web/index.html' },
    env: {},
  },
  phases: [
    { key: 'requirements', order: 1, title: 'Write the first story' },
    { key: 'implementation', order: 3, title: 'Build the endpoint' },
  ],
} as unknown as ProjectContent;

/**
 * The same project at the version a learner started on, superseded but still
 * published: version immutability read from the learner's end.
 *
 * Every field the four sites read differs from the head's: the title the README
 * and the journal print, the phase title the card and the journal print, the
 * phase count the README counts, and whether `preview` exists at all. A reader
 * that takes the head answers the head's string for each of them, so no row
 * below can go green over a resolution that ignored the pin.
 */
const STARTED_ON = {
  slug: 'ledger',
  title: 'Ledger (the version they started)',
  version: '1.0.0',
  build: { tool: 'esbuild', entry: 'web/src/main.tsx', outfile: 'web/dist/app.js', jsx: 'automatic' },
  // No app to run at 1.0.0: the live preview arrived with 2.0.0.
  preview: null,
  phases: [
    { key: 'requirements', order: 1, title: 'Write the first story (1.0.0)' },
    { key: 'design', order: 2, title: 'Draw it first (1.0.0)' },
    { key: 'implementation', order: 3, title: 'Build the endpoint (1.0.0)' },
  ],
} as unknown as ProjectContent;

/** `project_versions.id` → the snapshot that row carries, as the registry holds them. */
const VERSIONS: Record<string, ProjectContent> = {
  'ledger-v1': STARTED_ON,
  'ledger-v2': PINNED,
};

/**
 * Another project in the same catalogue: three phases, a title that shares no
 * substring with the first, and no app to preview. Nothing the learner below
 * is enrolled in, so every appearance of it in an answer is a defect.
 */
const OTHER = {
  slug: 'ledger-next',
  title: 'Quite Another Pack',
  phases: [
    { key: 'requirements', order: 1, title: 'A story for somebody else' },
    { key: 'design', order: 2, title: 'A design for somebody else' },
    { key: 'implementation', order: 3, title: 'An endpoint for somebody else' },
  ],
} as unknown as ProjectContent;

describe('the pin, for the services nobody owned', () => {
  let dataSource: DataSource;
  let asked: string[];
  let pins: (string | null)[];
  let content: ContentService;

  const manager = () => dataSource.manager;

  /**
   * Every slug the service resolved, in order, every pin it resolved it with,
   * and the 404 an unknown slug gets.
   *
   * `getForEnrollment` mirrors the real one: a null pin, and a pin this
   * catalogue holds no row for, both answer the published head, so a spec that
   * enrols without a version behaves exactly as it did before the pin existed.
   */
  const catalogue = (): ContentService => {
    const head = (slug: string): ProjectContent => {
      for (const project of [PINNED, OTHER]) if (project.slug === slug) return project;
      throw new NotFoundException(`unknown project: ${slug}`);
    };
    return {
      getProject: (slug: string) => {
        asked.push(slug);
        return head(slug);
      },
      getForEnrollment: ({
        projectSlug,
        projectVersionId,
      }: {
        projectSlug: string;
        projectVersionId: string | null;
      }) => {
        asked.push(projectSlug);
        pins.push(projectVersionId);
        const published = head(projectSlug);
        if (!projectVersionId) return published;
        const version = VERSIONS[projectVersionId];
        return version && version.slug === projectSlug ? version : published;
      },
      executionFiles: () => ({ 'api/main.py': 'print(1)\n' }),
    } as unknown as ContentService;
  };

  const learner = (id: string, tokenVersion = 0): Promise<UserEntity> =>
    manager().save(
      manager().create(UserEntity, {
        id,
        email: `${id}@example.invalid`,
        displayName: 'Sam Tan',
        role: 'LEARNER',
        passwordHash: 'x',
        tokenVersion,
      } as Partial<UserEntity>),
    );

  /**
   * An enrolment on one project, with the board and one submission behind it.
   *
   * `projectVersionId` defaults to null: a row made before the model had
   * versions, and what every spec that never mentions a version writes, so the
   * three "which project" rows below are unchanged by the pin landing.
   */
  const enrol = async (
    userId: string,
    projectSlug: string,
    projectVersionId: string | null = null,
  ): Promise<{ enrollmentId: string; stateId: string }> => {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId,
        projectSlug,
        projectVersionId,
        currentPhaseOrder: 1,
        packVersion: '1.0.0',
      } as Partial<EnrollmentEntity>),
    );
    const state = await manager().save(
      manager().create(PhaseStateEntity, {
        enrollmentId: enrollment.id,
        userId,
        phaseKey: 'requirements',
        phaseOrder: 1,
        status: 'passed',
        bestScore: 86,
        passedAt: new Date().toISOString(),
      } as Partial<PhaseStateEntity>),
    );
    await manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: state.id,
        userId,
        status: 'completed',
        score: 86,
        passed: true,
        commitMessage: 'Write the overdue story',
        workspaceSnapshot: { 'requirements/story.md': 'As a user...' },
      } as Partial<SubmissionEntity>),
    );
    await manager().save(
      manager().create(ReleaseRecordEntity, {
        enrollmentId: enrollment.id,
        userId,
        phaseStateId: state.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        version: 'v1',
        score: 86,
        notes: 'Merged the overdue story',
      } as Partial<ReleaseRecordEntity>),
    );
    return { enrollmentId: enrollment.id, stateId: state.id };
  };

  beforeEach(async () => {
    dataSource = await memoryDataSource();
    asked = [];
    pins = [];
    content = catalogue();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe('the repository the learner keeps', () => {
    it('the repository card names the project the enrolment names', async () => {
      // `summary` holds the enrolment and the request's slug beside it. They
      // are the same string (`enrollmentOf` filters on it) so
      // what this pins is that the card is built from the enrolment's project
      // and never from another the catalogue happens to hold.
      await learner('learner-1');
      await enrol('learner-1', PINNED.slug);
      const service = new RepoService(dataSource, content);

      const summary = await service.summary('learner-1', PINNED.slug);

      expect(summary.projectSlug).toBe(PINNED.slug);
      expect(summary.projectTitle).toBe('Ledger');
      expect(summary.lastPhaseTitle).toBe('Write the first story');
      expect(summary.filename).toBe('ledger-repo.zip');
      expect(summary.tags.map((tag) => tag.phaseTitle)).toEqual(['Write the first story']);
      expect(asked).toEqual([PINNED.slug]);
    });

    it('the archive a learner downloads is cut from the project their enrolment names', async () => {
      // The README carries the project title and the phase count and the
      // journal carries the title again, so an
      // archive built from the wrong project is a document the learner keeps.
      await learner('learner-1');
      await enrol('learner-1', PINNED.slug);
      const service = new RepoService(dataSource, content);
      const chunks: Buffer[] = [];

      const result = await service.export('learner-1', PINNED.slug, async (chunk) => {
        chunks.push(chunk);
      });
      const archive = Buffer.concat(chunks).toString('latin1');

      expect(result.commits).toBeGreaterThan(0);
      expect(archive).toContain('# Ledger');
      // Two, from PINNED's phases: OTHER has three, and the number is the
      // count of the project the archive is of, not of whatever is published.
      expect(archive).toContain('Two phases, one recorded as passed.');
      expect(archive).toContain("Sam Tan's project for Ledger");
      expect(archive).toContain('summaries on Ledger, oldest first');
      // Not one byte of anybody else's project.
      expect(archive).not.toContain('Quite Another Pack');
      expect(archive).not.toContain('for somebody else');
      // Twice (the archive and the journal) and both
      // times the enrolment's own project.
      expect(asked).toEqual([PINNED.slug, PINNED.slug]);
    });

    it('refuses a project the learner never started before resolving any content', async () => {
      // Regression guard, and the reason the seam is safe: `enrollmentOf`
      // throws first, so an enrolment-shaped resolution never has to answer
      // for a learner who holds no enrolment at all.
      await learner('learner-1');
      await enrol('learner-1', PINNED.slug);
      const service = new RepoService(dataSource, content);

      await expect(service.summary('learner-1', OTHER.slug)).rejects.toThrow(
        'This project has not been started.',
      );
      expect(asked).toEqual([]);
    });

    /*
     * The version half. Each enrols the learner on `ledger-v1` while `ledger-v2`
     * is the published head, and each asserts a string the head would have
     * spelled differently.
     */

    it('the archive a learner downloads is cut from the pinned version', async () => {
      // The version half. The README carries the project title and the phase
      // count, and a learner keeps
      // this file: an archive cut from the head would tell them their term had
      // three phases when the version that graded them had two, or the other
      // way about, for ever and with nothing on the page to say so.
      await learner('learner-1');
      await enrol('learner-1', PINNED.slug, 'ledger-v1');
      const service = new RepoService(dataSource, content);
      const chunks: Buffer[] = [];

      await service.export('learner-1', PINNED.slug, async (chunk) => {
        chunks.push(chunk);
      });
      const archive = Buffer.concat(chunks).toString('latin1');

      expect(archive).toContain('# Ledger (the version they started)');
      expect(archive).toContain("Sam Tan's project for Ledger (the version they started)");
      // Three at 1.0.0, two at 2.0.0: the count is of the version the learner
      // holds, never of whatever is published the day they press the button.
      expect(archive).toContain('Three phases, one recorded as passed.');
      expect(archive).not.toContain('Two phases, one recorded as passed.');
      // Both reads (the archive and the journal) took the
      // pin, rather than one of them taking it and the other the head.
      expect(asked).toEqual([PINNED.slug, PINNED.slug]);
      expect(pins).toEqual(['ledger-v1', 'ledger-v1']);
    });

    it("the repository card counts the pinned version's phases", async () => {
      // `summary`. The card is the page the archive is downloaded from, so a card
      // naming the head's phases beside an archive cut from 1.0.0 would be the
      // two halves of one screen disagreeing.
      await learner('learner-1');
      await enrol('learner-1', PINNED.slug, 'ledger-v1');
      const service = new RepoService(dataSource, content);

      const summary = await service.summary('learner-1', PINNED.slug);

      expect(summary.projectTitle).toBe('Ledger (the version they started)');
      expect(summary.lastPhaseTitle).toBe('Write the first story (1.0.0)');
      expect(summary.tags.map((tag) => tag.phaseTitle)).toEqual([
        'Write the first story (1.0.0)',
      ]);
      // The row key does not move: the archive is still named for the project.
      expect(summary.projectSlug).toBe(PINNED.slug);
      expect(summary.filename).toBe('ledger-repo.zip');
      expect(pins).toEqual(['ledger-v1']);
    });

    it('the dossier journal reads the pinned version', async () => {
      // `journalFor`: asserted on its own because it is reached through
      // `export` and would otherwise be carried
      // by the README's assertions rather than stated.
      await learner('learner-1');
      await enrol('learner-1', PINNED.slug, 'ledger-v1');
      const service = new RepoService(dataSource, content);
      const chunks: Buffer[] = [];

      await service.export('learner-1', PINNED.slug, async (chunk) => {
        chunks.push(chunk);
      });
      const archive = Buffer.concat(chunks).toString('latin1');

      expect(archive).toContain(
        'summaries on Ledger (the version they started), oldest first',
      );
      // The phase each journal row names is the pinned version's phase, which
      // is the one the learner's board was built from.
      expect(archive).toContain('Write the first story (1.0.0)');
      expect(archive).not.toContain('— Write the first story —');
    });

    it('a pin the catalogue does not hold still answers the published head', async () => {
      // The null-pin fallback, asserted here rather than assumed: a
      // restored row naming a version this deployment never published keeps its
      // archive, at the head, rather than losing the download button.
      await learner('learner-1');
      await enrol('learner-1', PINNED.slug, 'ledger-v9');
      const service = new RepoService(dataSource, content);

      const summary = await service.summary('learner-1', PINNED.slug);

      expect(summary.projectTitle).toBe('Ledger');
      expect(summary.lastPhaseTitle).toBe('Write the first story');
    });
  });

  describe('the live preview', () => {
    it('decides from the project the enrolment names whether there is an app to run', async () => {
      // `preview.service.ts` reads `enrollment.projectSlug`, so what is
      // assertable is that it reads *that* and nothing else: a learner
      // enrolled in a project with no preview is refused even though another
      // project in the same catalogue has one. The happy path, and every rule
      // about capacity and capability, is `preview.service.spec.ts`'.
      await learner('learner-1');
      const workflow = {
        loadOwnedState: async () => ({
          state: { id: 'state-1', workspace: null },
          phase: { key: 'implementation', canPreview: true, files: [] },
          enrollment: { projectSlug: OTHER.slug, projectVersionId: null },
        }),
      };
      const sandbox = { startApp: jest.fn(), statusApp: jest.fn(), stopApp: jest.fn() };
      const service = new PreviewService(
        workflow as never,
        content,
        sandbox as never,
        dataSource,
      );

      await expect(service.start('learner-1', 'state-1')).rejects.toThrow(
        'this phase has no app to run',
      );
      expect(asked).toEqual([OTHER.slug]);
      expect(sandbox.startApp).not.toHaveBeenCalled();
    });

    it("decides from the pinned version's project whether there is an app to run", async () => {
      // `preview.service.ts`. The preview arrived with 2.0.0, so a learner
      // still working 1.0.0 has no app, and the refusal is what the version
      // they hold says, not what the newest publication says. Read the other
      // way round, this is the rule that stops a published change reaching into
      // an attempt in flight and starting a service the learner's own files
      // were never written against.
      await learner('learner-1');
      const workflow = {
        loadOwnedState: async () => ({
          state: { id: 'state-1', workspace: null },
          phase: { key: 'implementation', canPreview: true, files: [] },
          enrollment: { projectSlug: PINNED.slug, projectVersionId: 'ledger-v1' },
        }),
      };
      const sandbox = { startApp: jest.fn(), statusApp: jest.fn(), stopApp: jest.fn() };
      const service = new PreviewService(
        workflow as never,
        content,
        sandbox as never,
        dataSource,
      );

      await expect(service.start('learner-1', 'state-1')).rejects.toThrow(
        'this phase has no app to run',
      );
      expect(asked).toEqual([PINNED.slug]);
      expect(pins).toEqual(['ledger-v1']);
      expect(sandbox.startApp).not.toHaveBeenCalled();
    });
  });
});
