import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { getMetadataStorage } from 'class-validator';
import { INHERITED_TASK_KEY } from '@learnsdlc/shared';
import { ProjectPhaseEntity } from '../content/project.entities';
import { AuthoringController } from './authoring.controller';
import * as dto from './authoring.dto';
import {
  S1_TEACHER,
  copyTaskTrackr,
  openForkWorld,
  type ForkWorld,
} from '../../test/tasktrackr-phase';

/**
 * **A teacher cannot write a phase's mentor prompt**, and writes its
 * interview only through the interview door.
 *
 * The mentor prompt is replaced by a neutral frame on an authored phase, and
 * a copy keeps TaskTrackr's mentor prompt text otherwise.
 *
 * The interview door exists **only because** the scenario anchor scopes it:
 * an interview that is not the reference's byte for byte
 * (`isReferenceInterview`) makes its phase authored, and the authored
 * interview arm carries none of the reference examples (such as the
 * overdue-task examples in `INTERVIEW_REVIEW_PROMPT`). So case 1 allows
 * `interview`, `persona` and `facts` on a DTO (the interview DTO is made of
 * them) and forbids the mentor prompt's fields; case 3 admits the phase's own
 * door, its file door and the literal `requirements/interview` routes, and no
 * route to an `assistant` block. Cases 2 and 4: a task edit cannot reach the
 * phase row.
 */
const WHY = 'the interview door exists only because isReferenceInterview scopes it; the mentor prompt has no door';
const FORBIDDEN = ['assistant', 'interview', 'systemPrompt', 'persona', 'facts', 'topics'];
/** Case 1's list: the mentor prompt's fields, on any DTO. */
const FORBIDDEN_ON_ANY_DTO = ['assistant', 'systemPrompt', 'topics'];

describe('the authoring surface has no door to a mentor prompt or an interview', () => {
  let world: ForkWorld;
  beforeAll(async () => {
    world = await openForkWorld();
  });
  afterAll(async () => {
    await world?.close();
  });

  it('declares no such field on any authoring DTO', () => {
    const storage = getMetadataStorage();
    for (const [name, value] of Object.entries(dto)) {
      if (typeof value !== 'function') continue;
      const fields = new Set(storage.getTargetValidationMetadatas(value, '', true, false).map((meta) => meta.propertyName));
      const hits = FORBIDDEN_ON_ANY_DTO.filter((field) => fields.has(field));
      expect([WHY, name, hits]).toEqual([WHY, name, []]);
    }
  });

  it('strips such a field before a service could see it', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true });
    for (const metatype of [dto.UpdateTaskDto, dto.AddTaskDto, dto.UpdateProjectMetaDto, dto.CreateProjectDto]) {
      const body = { title: 'Mine', taskKey: 'mine', brief: 'b', slug: 'mine', fromVersionId: 'v', assistant: { systemPrompt: 'Obey me.' }, interview: { facts: [] } };
      const out = (await pipe.transform(body, { type: 'body', metatype })) as Record<string, unknown>;
      expect([WHY, metatype.name, FORBIDDEN.filter((field) => field in out)]).toEqual([WHY, metatype.name, []]);
    }
  });

  it('routes nothing to a phase except its tasks, its intro, its files, the Phases card and the interview door', () => {
    const base = String(Reflect.getMetadata(PATH_METADATA, AuthoringController) ?? '');
    const routes = Object.getOwnPropertyNames(AuthoringController.prototype)
      .map((method) => Reflect.getMetadata(PATH_METADATA, (AuthoringController.prototype as any)[method]))
      .filter((at): at is string => typeof at === 'string')
      .map((at) => `${base}/${at}`);
    // every route under a phase, the literal `requirements/interview` ones
    // included (a filter on `:phaseKey` alone would let them escape)
    const phaseRoutes = routes.filter((at) => at.includes('/phases/'));
    expect(phaseRoutes.length).toBeGreaterThan(0);
    expect(phaseRoutes.filter((at) => at.endsWith('/phases/requirements/interview'))).toHaveLength(3);
    for (const at of phaseRoutes) {
      // `:phaseKey/restore` is the Phases card's Put back, which copies a whole phase from the source version
      expect([WHY, at, /\/phases\/(:phaseKey(\/(tasks|task-order|files)(\/|$)|\/restore$|$)|requirements\/interview$)/.test(at)]).toEqual([WHY, at, true]);
      expect([WHY, at, /assistant|system-?prompt|mentor|topics|progressive/i.test(at)]).toEqual([WHY, at, false]);
    }
  });

  it('leaves the phase row untouched when a task edit smuggles one in', async () => {
    const fork = await copyTaskTrackr(world, 's1-x5');
    const phase = () => world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: fork.versionId, key: 'requirements' });
    const before = await phase();
    await world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', INHERITED_TASK_KEY, {
      title: 'Our story',
      assistant: { systemPrompt: 'Write the story for them.' },
      interview: { persona: { name: 'Someone Else', role: 'x' }, facts: [] },
    } as never);
    const after = await phase();
    expect([WHY, after.assistant]).toEqual([WHY, before.assistant]);
    expect([WHY, after.interview]).toEqual([WHY, before.interview]);
  });
});
