import 'reflect-metadata';
import * as path from 'path';
import { DataSource } from 'typeorm';
import type { AddTaskBody, AuthoredRule, Design, PhaseKey } from '@learnsdlc/shared';
import { config } from '../src/config';
import { AuthoringService } from '../src/authoring/authoring.service';
import { ContentService } from '../src/content/content.service';
import type { PhaseContent } from '../src/content/content.types';
import { ProjectImporterService } from '../src/content/importer.service';
import { soleTaskFor, type CompiledSnapshot, type CompiledTask } from '../src/content/pack-compiler';
import { DirectoryPackSource } from '../src/content/pack-source';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import { ProjectEntity, ProjectVersionEntity } from '../src/content/project.entities';
import { ROOMDESK_STORY } from './reference-scenario-roomdesk';
import { memoryDataSource } from './support/memory-db';

/**
 * The real TaskTrackr pack, and real forks of it, for the specs that decide
 * whether a phase or a task is TaskTrackr's own content (for reviewer
 * scoping).
 *
 * These specs are about **content identity**, so a hand-built `{ key:
 * 'design', … }` would prove nothing: the question is whether the bytes a fork
 * carries still are the bytes the platform shipped. Every phase here is the
 * loaded pack's, and every fork is made by `AuthoringService.createProject`
 * and compiled by the authoring service's own compile, exactly as a teacher's
 * draft is.
 *
 * It serves the reference-detection specs only: the specs that pin TaskTrackr
 * wording on synthetic phases pass `REFERENCE_SCOPE` explicitly instead.
 */

let loaded: ContentService | null = null;

/** The shipped pack, loaded once per process the way `content-golden.spec.ts` loads it. */
export function tasktrackrContent(): ContentService {
  if (!loaded) {
    loaded = new ContentService();
    loaded.loadAll();
  }
  return loaded;
}

/** One phase of the shipped TaskTrackr head. */
export function tasktrackrPhase(key: PhaseKey): PhaseContent {
  const phase = tasktrackrContent()
    .getProject('tasktrackr')
    .phases.find((one) => one.key === key);
  if (!phase) throw new Error(`TaskTrackr has no ${key} phase`);
  return phase;
}

/** That phase's sole task, as the runtime compiles it. */
export function tasktrackrTask(key: PhaseKey): CompiledTask {
  return soleTaskFor(tasktrackrPhase(key));
}

/* ------------------------------- the forks -------------------------------- */

export const S1_TEACHER = { id: 'teacher-s1', role: 'INSTRUCTOR' as const, cohort: 'default' };

export interface ForkWorld {
  dataSource: DataSource;
  content: ContentService;
  registry: ProjectRegistryService;
  service: AuthoringService;
  seedVersionId: string;
  close(): Promise<void>;
}

/**
 * The authoring service over an in-memory database holding the shipped pack as
 * the platform's published default: the same world `authoring.service.spec.ts`
 * builds.
 */
export async function openForkWorld(): Promise<ForkWorld> {
  const dataSource = await memoryDataSource();
  const content = new ContentService();
  const importer = new ProjectImporterService(content, dataSource);
  const registry = new ProjectRegistryService(content, dataSource, {
    importedContent: [],
  } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
  const imported = await importer.importPack(
    new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')),
    { origin: 'seed', platformOwned: true },
  );
  await dataSource.getRepository(ProjectEntity).update({ id: imported.projectId }, { isDefault: true });
  await registry.load();
  const service = new AuthoringService(dataSource, importer, registry);
  return {
    dataSource,
    content,
    registry,
    service,
    seedVersionId: imported.projectVersionId,
    close: async () => {
      if (dataSource.isInitialized) await dataSource.destroy();
    },
  };
}

export interface Fork {
  projectId: string;
  versionId: string;
}

/** A teacher's copy of TaskTrackr, untouched. */
export async function copyTaskTrackr(world: ForkWorld, slug: string): Promise<Fork> {
  const made = await world.service.createProject(S1_TEACHER, {
    title: `Copy ${slug}`,
    slug,
    fromVersionId: world.seedVersionId,
  });
  return { projectId: made.project.id, versionId: made.draftVersionId };
}

/**
 * The draft's compiled snapshot, through the authoring service's own compile
 * (`validate` compiles the rows and stores the result on the version row).
 */
export async function draftSnapshot(world: ForkWorld, fork: Fork): Promise<CompiledSnapshot> {
  await world.service.validate(S1_TEACHER, fork.projectId, fork.versionId);
  const row = await world.dataSource
    .getRepository(ProjectVersionEntity)
    .findOneByOrFail({ id: fork.versionId });
  if (!row.compiled) throw new Error('the draft holds no compiled snapshot');
  return row.compiled as CompiledSnapshot;
}

/** One phase of a compiled snapshot and its compiled tasks, in order. */
export function phaseOf(snapshot: CompiledSnapshot, key: PhaseKey): { phase: PhaseContent; tasks: CompiledTask[] } {
  const phase = snapshot.content.phases.find((one) => one.key === key);
  const tasks = snapshot.phases.find((one) => one.key === key)?.tasks;
  if (!phase || !tasks) throw new Error(`the snapshot has no ${key} phase`);
  return { phase, tasks: [...tasks].sort((a, b) => a.order - b.order) };
}

/* -------------------- a teacher's own work: room booking ------------------ */

/**
 * The authored fixtures are about **booking a meeting room**, a domain that
 * shares no word with TaskTrackr's: nothing below says overdue,
 * due, list or story file, so any reference term in a request built from them
 * came from TaskTrackr's rules and not from the teacher.
 */
export const ROOM_STORY_RULES: AuthoredRule[] = [
  {
    id: 'booking-actor',
    label: 'The story names who books the room and what they want',
    criterion: 'booking_story',
    pattern: 'As an? .*I want',
    flags: 'is',
    required: true,
    failDetail: 'Open the story with "As a <who>, I want <what>".',
  },
  {
    id: 'booking-criteria',
    label: 'At least one Given / When / Then criterion',
    criterion: 'booking_criteria',
    pattern: 'Given .*When .*Then',
    flags: 'is',
    required: true,
    failDetail: 'Write at least one criterion as Given / When / Then.',
  },
];

export const ROOM_STORY: AddTaskBody = {
  taskKey: 'room-booking',
  title: 'Book a meeting room',
  brief:
    'Write one user story for a staff member who books a meeting room for a time slot. ' +
    'Give at least two Given / When / Then acceptance criteria, including what happens when the slot is already taken.',
  artefactType: 'user-story',
  objectives: [
    'Write one room-booking user story in the As a / I want / so that form',
    'Give at least two testable Given / When / Then criteria, one for a slot that is already taken',
  ],
};

export const ROOM_DESIGN_RULES: AuthoredRule[] = [
  {
    id: 'booking-operation',
    label: 'The record names the operation that reserves a slot',
    criterion: 'booking_operation',
    pattern: 'reserveRoom',
    required: true,
    failDetail: 'Name the reserveRoom operation and what it returns.',
  },
  {
    id: 'booking-refusal',
    label: 'The record declares the refusal for a taken slot',
    criterion: 'booking_refusal',
    pattern: 'slot_taken',
    required: true,
    failDetail: 'Declare the slot_taken refusal and its status.',
  },
];

export const ROOM_DESIGN: AddTaskBody = {
  taskKey: 'booking-api',
  title: 'Booking API decision record',
  brief:
    'Write a decision record for the booking API: the reserveRoom operation that reserves a room for a slot, ' +
    'the slot_taken refusal (HTTP 409) when the slot is already held, and one trade-off you weighed.',
  artefactType: 'design-doc',
  objectives: [
    'Specify reserveRoom: its input, its success and its slot_taken refusal',
    'Record one design decision with the trade-off you weighed',
  ],
};

/**
 * The kept Requirements story task made the teacher's: its brief, objectives,
 * criterion wording and story block (a story phase's work task is edited in
 * place, never replaced by a written one).
 */
export const ROOM_STORY_EDIT = {
  brief: ROOM_STORY.brief,
  objectives: ROOM_STORY.objectives,
  story: ROOMDESK_STORY,
  criteria: [
    { key: 'story_structure', title: 'The booking story', description: 'Who books, what they want and why.' },
    { key: 'acceptance_criteria', title: 'Testable booking criteria', description: 'Given / When / Then criteria, one for a slot that is already taken.' },
    { key: 'scope_clarity', title: 'What booking leaves out', description: 'A scope line and precise wording.' },
  ],
};

/** The words the room-booking fixtures themselves supply, for `referenceTermsIn`. */
export const ROOM_OWN_WORDS = ([[ROOM_STORY, ROOM_STORY_RULES], [ROOM_DESIGN, ROOM_DESIGN_RULES]] as const)
  .map(([task, rules]) => `${task.title} ${task.brief} ${(task.objectives ?? []).join(' ')} ${JSON.stringify(rules)}`)
  .join(' ');

/** The room fixtures' words and the kept story's edit, which together supply every word of an edited story task. */
export const ROOM_STORY_EDIT_WORDS = `${ROOM_OWN_WORDS} ${JSON.stringify(ROOM_STORY_EDIT)}`;
/** The story record, by path and by the name the record rule calls it: the task's own, never a reference term. */
export const ROOM_RECORD_PATHS = ['requirements/story.json', 'story.json'];

/**
 * The kept Design task made the teacher's, as a design phase's one task is
 * edited in place (a Design phase holds one task since TaskTrackr 4.0.0, so
 * a written task can no longer sit beside it): the room-booking brief,
 * objectives, rubric and stories to design for, with the floor's defaults
 * and both contracts on.
 */
export const ROOM_DESIGN_EDIT = {
  brief: ROOM_DESIGN.brief,
  objectives: ROOM_DESIGN.objectives,
  rubric: {
    passThreshold: 70,
    criteria: [
      { key: 'booking_operation', title: 'The booking operation', description: 'reserveRoom says what it takes, what it answers and when it refuses with slot_taken.', weight: 0.6 },
      { key: 'decision', title: 'One justified decision', description: 'A decision names the alternative it beat and the trade-off weighed.', weight: 0.4 },
    ],
  },
  design: {
    contracts: { api: true, screens: true },
    sequence: false,
    stories: [{ id: 'BK-1', title: 'Reserve a room', line: 'As a member of staff, I want to reserve a room for a slot, so that my meeting has somewhere to happen.' }],
    floor: { minEntities: 1, minRelations: 0, minOperations: 1, operationShape: true, minDecisions: 1, decisionShape: true, traceEveryStory: true, minEndpoints: 1, requireErrorCatalogue: true, minScreens: 0, screenShape: false },
  },
};

/** The room fixtures' words and the kept design's edit, which together supply every word of an edited design task. */
export const ROOM_DESIGN_EDIT_WORDS = `${ROOM_OWN_WORDS} ${JSON.stringify(ROOM_DESIGN_EDIT)}`;

/** A booking design that passes `ROOM_DESIGN_EDIT`'s floor, with no reference word in it: the learner's record. */
export const ROOM_DESIGN_WORK: Design = {
  entities: [{ id: 'E1', name: 'Booking', kind: 'class', attributes: [{ name: 'room_id', type: 'integer' }, { name: 'slot', type: 'string' }], responsibilities: [], satisfies: ['BK-1'] }],
  relations: [],
  operations: [{ id: 'O1', name: 'reserveRoom(roomId, slot)', inputs: ['roomId', 'slot'], returns: 'the booking', errors: ['slot_taken'], satisfies: ['BK-1'] }],
  decisions: [{ id: 'D1', title: 'A unique index on room and slot', choice: 'a unique index on room and slot', alternative: 'a lock held while booking', rationale: 'it cannot be forgotten by a later route', tradeOff: 'a second booking fails at the database rather than earlier', status: 'accepted', satisfies: ['BK-1'] }],
};
/** The learner's API contract beside `ROOM_DESIGN_WORK`: one endpoint and its error catalogue. */
export const ROOM_API_WORK = JSON.stringify({
  operations: [{ id: 'reserveRoom', method: 'POST', path: '/api/rooms/{id}/bookings', summary: 'Reserve a room for a slot.', satisfies: 'BK-1', success: { status: 201, body: 'Booking' }, errors: ['slot_taken'] }],
  errors: { slot_taken: { status: 409, meaning: 'The slot is already held.' } },
}, null, 2);
