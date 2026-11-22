import 'reflect-metadata';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { config } from '../config';
import { blobShaFor, canonicalJson } from '../content/blob.store';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectRegistryService } from '../content/project-registry.service';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../content/project.entities';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from '../../test/quiz-fixture';
import { ROOM_STORY } from '../../test/tasktrackr-phase';
import { HOST_ARCHITECTURE, HOST_PHASE, HOST_RUNBOOK, copyHost, importHostPack } from '../../test/written-phase-pack';
import {
  CRITERION_DESCRIPTION_MAX,
  CRITERION_TITLE_MAX,
  PHASE_INTRO_MAX,
  REPLACE_FILE_CONTENT_MAX,
  applicationFileRefusal,
  applicationPhasesSentence,
  draftOnlyRefusal,
  fileNotMountedRefusal,
  projectNotYoursRefusal,
  withheldFileReplaceRefusal,
} from '@learnsdlc/shared';
import type { PhaseKey, ValidationReport } from '@learnsdlc/shared';
import { AuditEventEntity } from '../db/entities';
import { validateInterviewBrief } from '../content/content.service';
import { isReferenceInterview } from '../content/reference-content';
import { interviewBriefChars } from '../assistant/openai.provider';
import {
  ROOMDESK_ARCHITECTURE,
  ROOMDESK_BACKLOG,
  ROOMDESK_DESIGN_INTRO,
  ROOMDESK_INTERVIEW,
  ROOMDESK_REQUIREMENTS_INTRO,
} from '../../test/reference-scenario-roomdesk';
import { AuthoringService } from './authoring.service';
import { memoryDataSource } from '../../test/support/memory-db';

const TEACHER = { id: 'teacher-bx', role: 'INSTRUCTOR' as const, cohort: 'default' };

/**
 * The copy becomes the teacher's own: every written element of
 * Requirements and Design, through a draft-only door, on the real shipped pack.
 *
 * Asked of the real TaskTrackr pack rather than a fixture, for the reason the
 * authoring service's own spec gives: the pack that matters is the one with
 * hidden suites, solutions, mutants and a customer interview in it.
 */
describe('the copy becomes the teacher\'s own', () => {
  let dataSource: DataSource;
  let importer: ProjectImporterService;
  let content: ContentService;
  let registry: ProjectRegistryService;
  let service: AuthoringService;
  let seedVersionId = '';
  /**
   * The story host (`test/written-phase-pack.ts`): Shelf's Requirements phase,
   * mounting the two read-only reference files the file door replaces.
   */
  let hostVersionId = '';

  const copyOfTheDefault = async (slug: string, title = 'RoomDesk') =>
    service.createProject(TEACHER, { title, slug, fromVersionId: seedVersionId });

  /** One phase's row of one version. */
  const phaseRowOf = async (versionId: string, phaseKey: string) =>
    dataSource
      .getRepository(ProjectPhaseEntity)
      .findOneByOrFail({ projectVersionId: versionId, key: phaseKey as never });

  /** A file row of one phase, by path. */
  const fileRowOf = async (versionId: string, phaseKey: string, at: string) => {
    const phase = await phaseRowOf(versionId, phaseKey);
    return dataSource
      .getRepository(ProjectFileEntity)
      .findOneByOrFail({ projectVersionId: versionId, ownerKind: 'phase', ownerId: phase.id, path: at });
  };

  /** The bytes a version's compiled content mounts for one phase at one path. */
  const compiledBytes = async (versionId: string, phaseKey: string, at: string) => {
    const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
    return version.compiled?.content.phases.find((one) => one.key === phaseKey)?.files.find((one) => one.path === at)
      ?.content;
  };

  /**
   * A file's bytes replaced beneath the service, the way the file door will
   * write them (a new blob, the same row, the same role), so the load and
   * compile path is asked about a replaced row before any door exists.
   */
  const replaceBeneath = async (versionId: string, phaseKey: string, at: string, bytes: string) => {
    const row = await fileRowOf(versionId, phaseKey, at);
    const sha = blobShaFor(bytes);
    const blobs = dataSource.getRepository(ContentBlobEntity);
    if (!(await blobs.findOneBy({ sha }))) {
      await blobs.insert({ sha, bytes, size: Buffer.byteLength(bytes, 'utf-8') });
    }
    await dataSource.getRepository(ProjectFileEntity).update({ id: row.id }, { blobSha: sha });
  };

  const ADMIN = { id: 'admin-bx', role: 'ADMIN' as const, cohort: 'default' };
  const OTHER_TEACHER = { id: 'teacher-bx-other', role: 'INSTRUCTOR' as const, cohort: 'default' };

  const rowsOfPhase = async (versionId: string, phaseKey: string) => {
    const phase = await phaseRowOf(versionId, phaseKey);
    return dataSource.getRepository(ProjectFileEntity).find({ where: { projectVersionId: versionId, ownerKind: 'phase', ownerId: phase.id } });
  };

  const taskRowOf = async (versionId: string, phaseKey: string, taskKey: string) =>
    dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: (await phaseRowOf(versionId, phaseKey)).id, taskKey });

  const auditRows = async (projectId: string, event?: string) =>
    (await dataSource.getRepository(AuditEventEntity).find({ where: { targetId: projectId }, order: { createdAt: 'ASC' } }))
      .filter((row) => event === undefined || row.event === event);

  const auditCount = async (projectId: string, event: string) => (await auditRows(projectId, event)).length;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    importer = new ProjectImporterService(content, dataSource);
    registry = new ProjectRegistryService(content, dataSource, {
      importedContent: [],
    } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);

    const imported = await importer.importPack(
      new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')),
      { origin: 'seed', platformOwned: true },
    );
    seedVersionId = imported.projectVersionId;
    await dataSource.getRepository(ProjectEntity).update({ id: imported.projectId }, { isDefault: true });
    await registry.load();

    service = new AuthoringService(dataSource, importer, registry);
    hostVersionId = await importHostPack({ content, dataSource, registry }, { slug: 'release-scenario' });
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  /* ------------------------ a replaced file's bytes ------------------------ */

  describe('the bytes of a file the copy brought', () => {
    const ROOMDESK_BACKLOG =
      '# RoomDesk backlog\n\n## US-1 — Book a room\n\n## US-2 — See free rooms\n\n## US-3 — Cancel a booking\n';

    it('an untouched copy compiles to a snapshot byte-identical to the source it copied', async () => {
      const made = await copyOfTheDefault('bx-untouched');
      const draft = await dataSource
        .getRepository(ProjectVersionEntity)
        .findOneByOrFail({ id: made.draftVersionId });
      const seed = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: seedVersionId });

      // The phases a teacher reads and a grader scores are the source's, byte
      // for byte; only the project's own name, address and version differ.
      expect(canonicalJson(draft.compiled?.content.phases)).toBe(canonicalJson(seed.compiled?.content.phases));
    });

    // A read-only document the copy brought: the story host's runbook (TaskTrackr 4.0.0 mounts no read-only
    // document in a structured phase: Requirements holds its record alone, and Design its three records).
    it('a replaced brought-path file reaches the compiled content, and survives a second save', async () => {
      const made = await copyHost({ service }, hostVersionId, 'bx-bytes', TEACHER);
      await replaceBeneath(made.versionId, HOST_PHASE, HOST_RUNBOOK, ROOMDESK_BACKLOG);

      await service.validate(TEACHER, made.projectId, made.versionId);
      expect(await compiledBytes(made.versionId, HOST_PHASE, HOST_RUNBOOK)).toBe(ROOMDESK_BACKLOG);

      // a second save reads the compiled content back as its base, and must not
      // put the source's bytes back over the row's
      await service.validate(TEACHER, made.projectId, made.versionId);
      expect(await compiledBytes(made.versionId, HOST_PHASE, HOST_RUNBOOK)).toBe(ROOMDESK_BACKLOG);
      expect((await fileRowOf(made.versionId, HOST_PHASE, HOST_RUNBOOK)).blobSha).toBe(
        blobShaFor(ROOMDESK_BACKLOG),
      );
    });

    it('carries the replaced bytes through a publish into the next draft', async () => {
      const made = await copyHost({ service }, hostVersionId, 'bx-k2', TEACHER);
      await replaceBeneath(made.versionId, HOST_PHASE, HOST_RUNBOOK, ROOMDESK_BACKLOG);

      await service.publish(TEACHER, made.projectId, made.versionId, { version: '1.0.0' });
      expect(await compiledBytes(made.versionId, HOST_PHASE, HOST_RUNBOOK)).toBe(ROOMDESK_BACKLOG);

      const next = await service.createDraftVersion(TEACHER, made.projectId, {
        fromVersionId: made.versionId,
      });
      expect(await compiledBytes(next.versionId, HOST_PHASE, HOST_RUNBOOK)).toBe(ROOMDESK_BACKLOG);
      await service.publish(TEACHER, made.projectId, next.versionId, { version: '1.1.0' });
      expect(await compiledBytes(next.versionId, HOST_PHASE, HOST_RUNBOOK)).toBe(ROOMDESK_BACKLOG);
    });

    it('reads a draft of a 2.0.1 copy without hashing the application (timing)', async () => {
      const made = await copyOfTheDefault('bx-timing');
      // warm once, then time three reads; the bound is generous on purpose:
      // it is a regression wall against hashing every file of every phase on
      // every call, not a benchmark
      await service.readDraft(TEACHER, made.project.id, made.draftVersionId);
      const times: number[] = [];
      for (let at = 0; at < 3; at += 1) {
        const started = process.hrtime.bigint();
        await service.readDraft(TEACHER, made.project.id, made.draftVersionId);
        times.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      times.sort((a, b) => a - b);
      // eslint-disable-next-line no-console
      console.log(`readDraft on a 2.0.1 copy: median ${times[1].toFixed(1)} ms`);
      expect(times[1]).toBeLessThan(2000);
    });
  });

  /* ---------------- the phase's objectives follow its work ---------------- */

  describe("a phase's objectives are its non-quiz tasks'", () => {
    const objectivesOf = async (versionId: string, phaseKey: string) => {
      const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
      return version.compiled?.content.phases.find((one) => one.key === phaseKey)?.objectives;
    };

    it('is the identity on an untouched copy', async () => {
      const made = await copyOfTheDefault('bx-objectives-untouched');
      const seed = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: seedVersionId });
      for (const phase of seed.compiled!.content.phases) {
        expect([phase.key, await objectivesOf(made.draftVersionId, phase.key)]).toEqual([phase.key, phase.objectives]);
      }
    });

    it("is the phase's one work task's, the teacher's once they edit it; a quiz's never join", async () => {
      const made = await copyOfTheDefault('bx-objectives-mixed');
      const seed = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: seedVersionId });
      const inherited = seed.compiled!.content.phases.find((one) => one.key === 'requirements')!.objectives;
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', {
        taskKey: 'concepts',
        title: 'Requirements concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        objectives: ['Recall what a quiz asks'],
        quiz: { questions: fixtureQuizQuestions(5), drawn: 3 },
      });
      expect(await objectivesOf(made.draftVersionId, 'requirements')).toEqual(inherited);

      await service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', 'main', { objectives: ROOM_STORY.objectives });
      expect(await objectivesOf(made.draftVersionId, 'requirements')).toEqual(ROOM_STORY.objectives);
    });
  });

  /* -------------------------- the authoring doors -------------------------- */

  describe('the phase intro door (phases.update)', () => {
    it('writes the intro as sent, on every phase, and leaves one project.phase row', async () => {
      const made = await copyOfTheDefault('bx-intro-door');
      const before = await auditCount(made.project.id, 'project.phase');
      const result = await service.updatePhase(TEACHER, made.project.id, made.draftVersionId, 'requirements', {
        intro: `${ROOMDESK_REQUIREMENTS_INTRO}\n`,
      });
      expect(result.phase.intro).toBe(`${ROOMDESK_REQUIREMENTS_INTRO}\n`);
      expect((await phaseRowOf(made.draftVersionId, 'requirements')).intro).toBe(`${ROOMDESK_REQUIREMENTS_INTRO}\n`);
      expect(result.validation.ranAt).toEqual(expect.any(String));
      // an application phase's intro is the teacher's too
      await service.updatePhase(TEACHER, made.project.id, made.draftVersionId, 'implementation', { intro: 'Build the booking service.' });
      expect((await phaseRowOf(made.draftVersionId, 'implementation')).intro).toBe('Build the booking service.');
      expect(await auditCount(made.project.id, 'project.phase')).toBe(before + 2);
      // the row names the phase and the length, never the words
      const rows = await auditRows(made.project.id, 'project.phase');
      expect(JSON.stringify(rows)).not.toContain('Build the booking service.');
      expect(rows[0].detail).toEqual(expect.objectContaining({ phaseKey: expect.any(String), length: expect.any(Number) }));
    });

    it('refuses a blank intro and one over the cap, and writes nothing', async () => {
      const made = await copyOfTheDefault('bx-intro-refused');
      const was = (await phaseRowOf(made.draftVersionId, 'design')).intro;
      await expect(service.updatePhase(TEACHER, made.project.id, made.draftVersionId, 'design', { intro: '  \n ' })).rejects.toThrow(/intro/);
      await expect(
        service.updatePhase(TEACHER, made.project.id, made.draftVersionId, 'design', { intro: 'x'.repeat(PHASE_INTRO_MAX + 1) }),
      ).rejects.toThrow(new RegExp(String(PHASE_INTRO_MAX)));
      expect((await phaseRowOf(made.draftVersionId, 'design')).intro).toBe(was);
    });
  });

  describe('the interview doors (interview.replace, .remove, .read)', () => {
    it('writes the interview whole, keeps the sealed row in step, and shows the draft no answer', async () => {
      const made = await copyOfTheDefault('bx-interview-door');
      const result = await service.putInterview(TEACHER, made.project.id, made.draftVersionId, ROOMDESK_INTERVIEW);
      expect((await phaseRowOf(made.draftVersionId, 'requirements')).interview).toEqual(ROOMDESK_INTERVIEW);
      const sealed = (await rowsOfPhase(made.draftVersionId, 'requirements')).filter((row) => row.role === 'interview');
      expect(sealed.map((row) => row.blobSha)).toEqual([blobShaFor(canonicalJson(ROOMDESK_INTERVIEW))]);
      expect(result.phase.interview).toEqual({
        persona: ROOMDESK_INTERVIEW.persona,
        opening: ROOMDESK_INTERVIEW.opening,
        maxTurns: ROOMDESK_INTERVIEW.maxTurns,
        factsExpected: ROOMDESK_INTERVIEW.factsExpected,
        facts: ROOMDESK_INTERVIEW.facts.map(({ id, topic }) => ({ id, topic })),
      });
      expect(await auditCount(made.project.id, 'project.interview')).toBe(1);
    });

    it('keeps the reference interview byte for byte when a teacher re-saves it unchanged', async () => {
      const made = await copyOfTheDefault('bx-interview-resave');
      const original = (await phaseRowOf(made.draftVersionId, 'requirements')).interview!;
      const read = await service.readInterview(TEACHER, made.project.id, made.draftVersionId);
      await service.putInterview(TEACHER, made.project.id, made.draftVersionId, read);
      expect(canonicalJson((await phaseRowOf(made.draftVersionId, 'requirements')).interview)).toBe(canonicalJson(original));
      expect(isReferenceInterview((await phaseRowOf(made.draftVersionId, 'requirements')).interview)).toBe(true);
    });

    it("refuses every brief the content loader refuses, in the loader's own words", async () => {
      const made = await copyOfTheDefault('bx-interview-parity');
      const broken: Array<[string, unknown]> = [
        ['no persona', { ...ROOMDESK_INTERVIEW, persona: { name: '', role: 'x' } }],
        ['no opening', { ...ROOMDESK_INTERVIEW, opening: '' }],
        ['no unknown reply', { ...ROOMDESK_INTERVIEW, unknownReply: ' ' }],
        ['no refusal', { ...ROOMDESK_INTERVIEW, refusal: '' }],
        ['too many turns', { ...ROOMDESK_INTERVIEW, maxTurns: 41 }],
        ['a fraction of a turn', { ...ROOMDESK_INTERVIEW, maxTurns: 2.5 }],
        ['more expected than held', { ...ROOMDESK_INTERVIEW, factsExpected: 7 }],
        ['no facts', { ...ROOMDESK_INTERVIEW, facts: [] }],
        ['a bad fact id', { ...ROOMDESK_INTERVIEW, facts: [{ ...ROOMDESK_INTERVIEW.facts[0], id: 'has space' }] }],
        ['a duplicate fact id', { ...ROOMDESK_INTERVIEW, factsExpected: 1, facts: [ROOMDESK_INTERVIEW.facts[0], ROOMDESK_INTERVIEW.facts[0]] }],
        ['a long topic', { ...ROOMDESK_INTERVIEW, factsExpected: 1, facts: [{ ...ROOMDESK_INTERVIEW.facts[0], topic: 't'.repeat(81) }] }],
        ['no keywords', { ...ROOMDESK_INTERVIEW, factsExpected: 1, facts: [{ ...ROOMDESK_INTERVIEW.facts[0], keywords: [] }] }],
        ['a long answer', { ...ROOMDESK_INTERVIEW, factsExpected: 1, facts: [{ ...ROOMDESK_INTERVIEW.facts[0], answer: 'a'.repeat(1201) }] }],
      ];
      for (const [what, brief] of broken) {
        let loader = '';
        try {
          validateInterviewBrief(brief);
        } catch (error) {
          loader = (error as Error).message;
        }
        expect([what, loader.length > 0]).toEqual([what, true]);
        await expect(service.putInterview(TEACHER, made.project.id, made.draftVersionId, brief as never)).rejects.toThrow(loader);
      }
      // and nothing was written by any of them
      expect(await auditCount(made.project.id, 'project.interview')).toBe(0);
    });

    it("refuses what only the door caps: a long persona, a long line, a blank or long keyword, too many keywords", async () => {
      const made = await copyOfTheDefault('bx-interview-caps');
      const fact = ROOMDESK_INTERVIEW.facts[0];
      for (const brief of [
        { ...ROOMDESK_INTERVIEW, persona: { name: 'n'.repeat(81), role: 'r' } },
        { ...ROOMDESK_INTERVIEW, persona: { name: 'n', role: 'r'.repeat(161) } },
        { ...ROOMDESK_INTERVIEW, opening: 'o'.repeat(1001) },
        { ...ROOMDESK_INTERVIEW, factsExpected: 1, facts: [{ ...fact, keywords: ['  '] }] },
        { ...ROOMDESK_INTERVIEW, factsExpected: 1, facts: [{ ...fact, keywords: ['k'.repeat(61)] }] },
        { ...ROOMDESK_INTERVIEW, factsExpected: 1, facts: [{ ...fact, keywords: Array.from({ length: 13 }, (_, at) => `k${at}`) }] },
      ]) {
        await expect(service.putInterview(TEACHER, made.project.id, made.draftVersionId, brief)).rejects.toThrow(/interview/);
      }
    });

    it('refuses a brief the stakeholder could not hold whole in one prompt, and admits a long one that fits', async () => {
      const made = await copyOfTheDefault('bx-interview-size');
      const factOf = (at: number, answer: number, keywords: number) => ({
        id: `F${at}`,
        topic: `Topic ${at}`,
        answer: `${at} `.padEnd(answer, 'a'),
        keywords: Array.from({ length: keywords }, (_, k) => `k${at}-${k}-`.padEnd(60, 'k')),
      });
      const tooBig = { ...ROOMDESK_INTERVIEW, factsExpected: 20, facts: Array.from({ length: 20 }, (_, at) => factOf(at, 1199, 12)) };
      // the refusal names how much to cut, which is
      // what a teacher can act on, not the length of the JSON the reviewer reads.
      await expect(service.putInterview(TEACHER, made.project.id, made.draftVersionId, tooBig)).rejects.toThrow(
        `The interview is ${interviewBriefChars(tooBig) - 24000} characters longer than one stakeholder can hold; shorten its answers or keywords by at least that much, or keep fewer facts.`,
      );
      const answersOnly = { ...ROOMDESK_INTERVIEW, factsExpected: 20, facts: Array.from({ length: 20 }, (_, at) => factOf(at, 1100, 1)) };
      await expect(service.putInterview(TEACHER, made.project.id, made.draftVersionId, answersOnly)).rejects.toThrow(/longer than one stakeholder can hold/);
      expect(await auditCount(made.project.id, 'project.interview')).toBe(0);
      const fits = { ...ROOMDESK_INTERVIEW, factsExpected: 20, facts: Array.from({ length: 20 }, (_, at) => factOf(at, 700, 3)) };
      await service.putInterview(TEACHER, made.project.id, made.draftVersionId, fits);
      expect((await phaseRowOf(made.draftVersionId, 'requirements')).interview).toEqual(fits);
    });

    it('admits a brief of exactly 24000 characters written out and refuses one of 24001', async () => {
      const made = await copyOfTheDefault('bx-interview-edge');
      const factOf = (at: number) => ({ id: `F${at}`, topic: `Topic ${at}`, answer: `${at} `.padEnd(900, 'a'), keywords: [`k${at}`] });
      // One more plain letter in an answer is one more character in both
      // prompts, so the brief is grown a letter at a time to the cap exactly.
      const grown = (target: number) => {
        const facts = Array.from({ length: 20 }, (_, at) => factOf(at));
        let short = target - interviewBriefChars({ ...ROOMDESK_INTERVIEW, factsExpected: 20, facts });
        for (const fact of facts) {
          const add = Math.min(short, 1200 - fact.answer.length);
          fact.answer += 'a'.repeat(Math.max(0, add));
          short -= Math.max(0, add);
        }
        const brief = { ...ROOMDESK_INTERVIEW, factsExpected: 20, facts };
        expect(interviewBriefChars(brief)).toBe(target);
        return brief;
      };
      const over = grown(24001);
      await expect(service.putInterview(TEACHER, made.project.id, made.draftVersionId, over)).rejects.toThrow(
        'The interview is 1 character longer than one stakeholder can hold; shorten its answers or keywords by at least that much, or keep fewer facts.',
      );
      expect(await auditCount(made.project.id, 'project.interview')).toBe(0);
      const edge = grown(24000);
      await service.putInterview(TEACHER, made.project.id, made.draftVersionId, edge);
      expect((await phaseRowOf(made.draftVersionId, 'requirements')).interview).toEqual(edge);
    });

    it('removes the interview and its sealed row, and refuses a second removal', async () => {
      const made = await copyOfTheDefault('bx-interview-remove');
      const result = await service.removeInterview(TEACHER, made.project.id, made.draftVersionId);
      expect(result.phase.interview).toBeUndefined();
      expect((await phaseRowOf(made.draftVersionId, 'requirements')).interview).toBeNull();
      expect((await rowsOfPhase(made.draftVersionId, 'requirements')).some((row) => row.role === 'interview')).toBe(false);
      await expect(service.removeInterview(TEACHER, made.project.id, made.draftVersionId)).rejects.toThrow(/no interview/);
      expect(await auditCount(made.project.id, 'project.interview')).toBe(1);
    });

    it('reads the answers to the owner alone, audited; an ADMIN is refused, another teacher sees nothing', async () => {
      const made = await copyOfTheDefault('bx-interview-read');
      const brief = await service.readInterview(TEACHER, made.project.id, made.draftVersionId);
      expect(brief.facts.every((fact) => typeof fact.answer === 'string' && fact.answer.length > 0)).toBe(true);
      const rows = await auditRows(made.project.id, 'project.interview-read');
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(brief.facts[0].answer);
      await expect(service.readInterview(ADMIN, made.project.id, made.draftVersionId)).rejects.toThrow(projectNotYoursRefusal());
      await expect(service.readInterview(OTHER_TEACHER, made.project.id, made.draftVersionId)).rejects.toThrow(/no project with that id/);
      expect(await auditCount(made.project.id, 'project.interview-read')).toBe(1);
    });

    it("never carries an answer in the draft's other payloads", async () => {
      const made = await copyOfTheDefault('bx-interview-seal');
      const reference = await service.readInterview(TEACHER, made.project.id, made.draftVersionId);
      const wire = JSON.stringify([
        await service.readDraft(TEACHER, made.project.id, made.draftVersionId),
        await service.listTasks(TEACHER, made.project.id, made.draftVersionId, 'requirements'),
        await service.listFiles(TEACHER, made.project.id, made.draftVersionId),
        await service.validate(TEACHER, made.project.id, made.draftVersionId),
        await service.putInterview(TEACHER, made.project.id, made.draftVersionId, ROOMDESK_INTERVIEW),
        await auditRows(made.project.id),
      ]);
      for (const fact of [...reference.facts, ...ROOMDESK_INTERVIEW.facts]) {
        expect([fact.id, wire.includes(fact.answer)]).toEqual([fact.id, false]);
      }
    });

    it('refuses a write to a published version', async () => {
      const made = await copyOfTheDefault('bx-interview-published');
      await service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' });
      await expect(service.putInterview(TEACHER, made.project.id, made.draftVersionId, ROOMDESK_INTERVIEW)).rejects.toThrow(
        draftOnlyRefusal('1.0.0', 'published'),
      );
      // the owner may still read what they shipped
      expect((await service.readInterview(TEACHER, made.project.id, made.draftVersionId)).facts.length).toBeGreaterThan(0);
    });
  });

  describe('the file door (files.replace)', () => {
    // On the story host: its Requirements phase mounts the two read-only reference files (`HOST_RUNBOOK`, `HOST_ARCHITECTURE`).
    it("replaces a provided document where the host's phase mounts it, and the compiled content carries it", async () => {
      const made = await copyHost({ service }, hostVersionId, 'bx-file-backlog', TEACHER);
      const result = await service.replaceFile(TEACHER, made.projectId, made.versionId, HOST_PHASE, {
        path: HOST_RUNBOOK,
        content: ROOMDESK_BACKLOG,
      });
      expect(result.alsoReplacedIn).toEqual([]);
      expect(await compiledBytes(made.versionId, HOST_PHASE, HOST_RUNBOOK)).toBe(ROOMDESK_BACKLOG);
      const rows = await auditRows(made.projectId, 'project.files');
      expect(rows).toHaveLength(1);
      expect(rows[0].detail).toEqual(expect.objectContaining({ path: HOST_RUNBOOK, bytes: Buffer.byteLength(ROOMDESK_BACKLOG) }));
      expect(JSON.stringify(rows)).not.toContain('Book a room');
    });

    it("replaces the phase's architecture document", async () => {
      const made = await copyHost({ service }, hostVersionId, 'bx-file-starter', TEACHER);
      const written = await service.replaceFile(TEACHER, made.projectId, made.versionId, HOST_PHASE, { path: HOST_ARCHITECTURE, content: ROOMDESK_ARCHITECTURE });
      expect(written.alsoReplacedIn).toEqual([]);
      expect(await compiledBytes(made.versionId, HOST_PHASE, HOST_ARCHITECTURE)).toBe(ROOMDESK_ARCHITECTURE);
    });

    it('refuses, each in one sentence: an application phase, a sealed row, a path not mounted, a room record', async () => {
      const made = await copyOfTheDefault('bx-file-refused');
      const replace = (phaseKey: PhaseKey, at: string) =>
        service.replaceFile(TEACHER, made.project.id, made.draftVersionId, phaseKey, { path: at, content: '# ours\n' });
      await expect(replace('implementation', 'api/app.py')).rejects.toThrow(applicationFileRefusal('TaskTrackr'));
      await expect(replace('requirements', 'interview/brief.json')).rejects.toThrow(withheldFileReplaceRefusal('interview/brief.json'));
      await expect(replace('requirements', 'requirements/nowhere.md')).rejects.toThrow(fileNotMountedRefusal('requirements/nowhere.md', 'Requirements'));
      await expect(replace('requirements', 'requirements/story.json')).rejects.toThrow(/record the room builds/);
      // a design task's starting records are replaceable, and held to their own shape (TaskTrackr 4.0.0)
      await expect(replace('design', 'shared/contract/screens.json')).rejects.toThrow('The starting screen contract is not valid: The screen contract is not valid JSON.');
      expect(await auditCount(made.project.id, 'project.files')).toBe(0);
    });

    it('refuses a blank file and one over the cap', async () => {
      const made = await copyHost({ service }, hostVersionId, 'bx-file-caps', TEACHER);
      await expect(
        service.replaceFile(TEACHER, made.projectId, made.versionId, HOST_PHASE, { path: HOST_ARCHITECTURE, content: '  ' }),
      ).rejects.toThrow(/empty/);
      await expect(
        service.replaceFile(TEACHER, made.projectId, made.versionId, HOST_PHASE, { path: HOST_ARCHITECTURE, content: 'x'.repeat(REPLACE_FILE_CONTENT_MAX + 1) }),
      ).rejects.toThrow(new RegExp(String(REPLACE_FILE_CONTENT_MAX)));
    });
  });

  describe("an inherited criterion's wording", () => {
    it('rewords a criterion by key and keeps its weight, and the task is then the teacher\'s', async () => {
      const made = await copyOfTheDefault('bx-criteria');
      const task = await taskRowOf(made.draftVersionId, 'requirements', 'main');
      const [first] = task.rubric.criteria;
      await service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', 'main', {
        criteria: [{ key: first.key, title: 'A booking story in the right shape', description: 'The story names who books, what they want and why.' }],
      });
      const after = await taskRowOf(made.draftVersionId, 'requirements', 'main');
      const reworded = after.rubric.criteria.find((one) => one.key === first.key)!;
      expect(reworded).toEqual({ key: first.key, title: 'A booking story in the right shape', weight: first.weight, description: 'The story names who books, what they want and why.' });
      expect(after.rubric.passThreshold).toBe(task.rubric.passThreshold);
      expect(after.rubric.criteria.slice(1)).toEqual(task.rubric.criteria.slice(1));
    });

    it('refuses a key the rubric does not hold, a repeated key, and wording over the caps', async () => {
      const made = await copyOfTheDefault('bx-criteria-refused');
      const task = await taskRowOf(made.draftVersionId, 'requirements', 'main');
      const key = task.rubric.criteria[0].key;
      const update = (criteria: unknown) =>
        service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', 'main', { criteria } as never);
      await expect(update([{ key: 'no-such-key', title: 't', description: 'd' }])).rejects.toThrow(/no-such-key/);
      await expect(update([{ key, title: 't', description: 'd' }, { key, title: 't', description: 'd' }])).rejects.toThrow(/twice/);
      await expect(update([{ key, title: 't'.repeat(CRITERION_TITLE_MAX + 1), description: 'd' }])).rejects.toThrow(String(CRITERION_TITLE_MAX));
      await expect(update([{ key, title: 't', description: 'd'.repeat(CRITERION_DESCRIPTION_MAX + 1) }])).rejects.toThrow(String(CRITERION_DESCRIPTION_MAX));
      expect((await taskRowOf(made.draftVersionId, 'requirements', 'main')).rubric).toEqual(task.rubric);
    });
  });

  describe('the validation rows a scenario adds', () => {
    const rowsOf = (report: ValidationReport, id: string) => report.checks.filter((check) => check.id === id);

    it('passes an untouched copy with the application row, and no warning', async () => {
      const made = await copyOfTheDefault('bx-validate-untouched');
      const report = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      expect(rowsOf(report, 'interview-well-formed').map((check) => check.status)).toEqual(['passed']);
      expect(rowsOf(report, 'interview-sealed-row-matches').map((check) => check.status)).toEqual(['passed']);
      // only Design mounts the backlog, so there is no twin to hold to one document
      expect(rowsOf(report, 'provided-backlog-one-document')).toEqual([]);
      expect(rowsOf(report, 'application-is-the-reference')).toEqual([
        expect.objectContaining({ status: 'passed', sentence: applicationPhasesSentence('TaskTrackr') }),
      ]);
      for (const warning of ['provided-backlog-shape', 'brief-names-the-stakeholder', 'brief-names-a-removed-stakeholder', 'scenario-is-one-project', 'inherited-task-matches-scenario']) {
        expect([warning, rowsOf(report, warning)]).toEqual([warning, []]);
      }
      expect(report.publishable).toBe(true);
    });

    it('fails a sealed interview row that no longer matches the brief, and two backlogs that differ', async () => {
      const made = await copyOfTheDefault('bx-validate-drift');
      // written beneath the doors, which never produce either shape
      await dataSource.getRepository(ProjectPhaseEntity).update({ id: (await phaseRowOf(made.draftVersionId, 'requirements')).id }, { interview: ROOMDESK_INTERVIEW as never });
      // two backlog documents, one mounted in Requirements and one in Design, differing (TaskTrackr 4.0.0 mounts neither)
      const requirements = await phaseRowOf(made.draftVersionId, 'requirements');
      const design = await phaseRowOf(made.draftVersionId, 'design');
      await importer.insertFiles(dataSource.manager, made.draftVersionId, [
        { ownerKind: 'phase', ownerId: requirements.id, path: 'requirements/provided-stories.md', role: 'workspace', editable: false, language: 'markdown', bytes: ROOMDESK_BACKLOG },
        { ownerKind: 'phase', ownerId: design.id, path: 'requirements/provided-stories.md', role: 'workspace', editable: false, language: 'markdown', bytes: '# Backlog\n\nAnother backlog.\n' },
      ]);
      const report = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      expect(rowsOf(report, 'interview-sealed-row-matches').map((check) => check.status)).toEqual(['failed']);
      expect(rowsOf(report, 'provided-backlog-one-document').map((check) => check.status)).toEqual(['failed']);
      expect(report.publishable).toBe(false);
    });

    it('warns, as passed rows with sentences, on a scenario half rewritten', async () => {
      const made = await copyOfTheDefault('bx-validate-warn');
      await service.putInterview(TEACHER, made.project.id, made.draftVersionId, ROOMDESK_INTERVIEW);
      // Design's half of the scenario is its Background (TaskTrackr 4.0.0 mounts no backlog document)
      await service.updatePhase(TEACHER, made.project.id, made.draftVersionId, 'design', { intro: ROOMDESK_DESIGN_INTRO });
      const report = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      const warned = (id: string) => rowsOf(report, id).map((check) => [check.status, check.sentence.length > 0]);
      // Requirements' backlog is its story task's provided stories, not a document, so the
      // shape warning about a markdown backlog has nothing to read
      expect(warned('provided-backlog-shape')).toEqual([]);
      // neither task's brief names Priya Nair in full, so the reviewer gives neither the facts;
      // the inherited one is no longer the reference's once the interview is the teacher's
      expect(rowsOf(report, 'brief-names-the-stakeholder').map((check) => check.taskKey)).toEqual(['main']);
      // the inherited brief still names the reference stakeholder the version no longer has
      expect(warned('brief-names-a-removed-stakeholder').length).toBeGreaterThan(0);
      // Requirements is the teacher's scenario while its inherited task still grades the reference's work;
      // so is Design's, whose Background the teacher rewrote
      expect(rowsOf(report, 'inherited-task-matches-scenario').map((check) => [check.status, check.phaseKey])).toEqual([
        ['passed', 'requirements'],
        ['passed', 'design'],
      ]);
      // and Requirements and Design no longer describe one project: one row for the pair
      expect(warned('scenario-is-one-project')).toEqual([['passed', true]]);
      expect(report.publishable).toBe(true);
    });
  });
});
