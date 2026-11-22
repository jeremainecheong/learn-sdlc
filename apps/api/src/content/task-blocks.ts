import { BadRequestException } from '@nestjs/common';
// The task block's as-sent caps count characters as UpdateTaskDto's
// @MaxLength does (a surrogate pair is one character).
import { maxLength } from 'class-validator';
import {
  INHERITED_TASK_KEY,
  TASK_BRIEF_MAX,
  TASK_OBJECTIVES_MAX,
  TASK_OBJECTIVE_MAX,
  TASK_TITLE_MAX,
  UPLOAD_REFUSALS,
  UPLOAD_REFUSAL_DETAIL_MAX,
  isAuthoredTaskKey,
} from '@learnsdlc/shared';
// The shared door rule for storable text
import { storableText } from '../authoring/door-rules';
// A phase.json task block goes through the editor's own words overlay.
import { overCapRefusal, taskWordsPatch } from '../authoring/draft';
import { derivePack } from './folder-layout';
import { isQuizTask, type CompiledTask } from './pack-compiler';
import type { PackSource } from './pack-source';
import type { ProjectTaskEntity } from './project.entities';

/* ------------------------- a phase.json `task` block ------------------------ */

/**
 * The members a phase.json `task` block may hold, named as the editor's
 * `UpdateTaskBody` names them. `key` names the task (it is the key the editor
 * addresses the phase's task by, `main` for a phase's sole task) and never
 * renames it: the editor has no rename.
 */
export const PHASE_TASK_BLOCK_KEYS = ['key', 'title', 'brief', 'objectives', 'signOff'] as const;

/** A phase.json `task` block, as checked. */
export interface PhaseTaskBlock {
  key?: string;
  title?: string;
  brief?: string;
  objectives?: string[];
  /**
   * Whether a learner's pass of the task waits
   * for the teacher's countersignature (`UpdateTaskBody.signOff`). Absent
   * means the phase's own sole task's, which is false.
   */
  signOff?: boolean;
}

/**
 * The upload's NOT_A_PACK refusal for a task block, in the body
 * `upload.service.ts` answers with: the fixed sentence, and a `detail` naming
 * the phase folder the pack declared and the reason. Never a byte of a file.
 * An `HttpException`, so it answers 400 wherever the import is called from.
 */
export function taskBlockRefusal(where: string, reason: string): BadRequestException {
  return packRefusal(`${where}'s phase.json task block: ${reason}`);
}

/** The upload's NOT_A_PACK refusal with `said` as its `detail`, as the door answers one (`taskBlockRefusal`'s body). */
export function packRefusal(said: string): BadRequestException {
  const sentence = UPLOAD_REFUSALS.NOT_A_PACK;
  const detail = wireDetail(said);
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: sentence,
    code: 'NOT_A_PACK',
    sentence,
    findings: [],
    detail,
  });
}

/**
 * A detail as the upload's wire carries one (loader-sentences.ts
 * `refusalDetail` over upload-limits.ts `printable`, copied here because
 * upload-limits.ts imports the importer, which imports this file): printable characters only (no control
 * or bidi character from a folder name the pack chose), trimmed, ended with
 * exactly one full stop, at most UPLOAD_REFUSAL_DETAIL_MAX characters.
 */
function wireDetail(text: string): string {
  const said = text
    .replace(/[^\x20-\x7e -ɏ‘-”—]/g, '')
    .slice(0, 400)
    .replace(/[.\s]+$/, '')
    .trim();
  return `${said.slice(0, UPLOAD_REFUSAL_DETAIL_MAX - 1).trimEnd()}.`;
}

function hasTaskWords(block: PhaseTaskBlock): boolean {
  return block.title !== undefined || block.brief !== undefined || block.objectives !== undefined;
}

/**
 * Whether a block moves its task at all (its words, or the
 * sign-off mark), so the draft is compiled the way the editor compiles the
 * same edit. A key-only block moves nothing.
 */
export function taskBlockMovesTask(block: PhaseTaskBlock): boolean {
  return hasTaskWords(block) || block.signOff !== undefined;
}

/**
 * What a block writes on its task's row: the editor's words
 * overlay (`taskWordsPatch`) and the sign-off mark, as the editor's
 * `tasks.update` writes them. The pack-compiler is not asked: it compiles a
 * row's mark from `authored.signOff === true`.
 */
export function taskBlockPatch(
  block: PhaseTaskBlock,
): Partial<Pick<ProjectTaskEntity, 'title' | 'brief' | 'objectives' | 'signOff'>> {
  return { ...taskWordsPatch(block).patch, ...(block.signOff !== undefined ? { signOff: block.signOff } : {}) };
}

/**
 * Which archive a block was written in: an older archive's (the pointer
 * layout, `project.json` listing its phases), whose block may carry the
 * task's `brief`, which the door's conversion moves into the phase's
 * `taskPanel`; or the folder layout's, whose block has no `brief`, because the
 * phase's `taskPanel` is its one task's brief.
 */
export type TaskBlockLayout = 'older' | 'folder';

/** The members a block of each layout may hold, as its sentences name them. */
function blockMembersOf(layout: TaskBlockLayout): readonly string[] {
  return layout === 'folder' ? PHASE_TASK_BLOCK_KEYS.filter((one) => one !== 'brief') : PHASE_TASK_BLOCK_KEYS;
}

/** "key, title, objectives and signOff" (or "... or signOff"). */
function memberSentence(members: readonly string[], last: 'and' | 'or'): string {
  return `${members.slice(0, -1).join(', ')} ${last} ${members[members.length - 1]}`;
}

/**
 * One phase.json `task` block, held to the editor's own wall: the members
 * its layout's block may hold (`PHASE_TASK_BLOCK_KEYS`, less `brief` in the
 * folder layout) and no other, text where the editor takes text,
 * `UpdateTaskDto`'s caps on the bytes as sent, and then the editor's own
 * overlay (`taskWordsPatch`), whose trimmed-and-capped refusal is the reason.
 * A folder-layout block holding `brief` is refused naming the member, in the
 * sentence the loader's own `blockBrief` says too. A refusal
 * names the member and the cap, never its value.
 */
export function checkedTaskBlock(where: string, raw: unknown, layout: TaskBlockLayout): PhaseTaskBlock {
  const members = blockMembersOf(layout);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw taskBlockRefusal(where, `it must be an object holding ${memberSentence(members, 'or')}`);
  }
  const record = raw as Record<string, unknown>;
  if (layout === 'folder' && Object.prototype.hasOwnProperty.call(record, 'brief')) {
    throw taskBlockRefusal(where, "the brief is the phase's taskPanel now; move it there");
  }
  const allowed = new Set<string>(members);
  const unknown = Object.keys(record).filter((one) => !allowed.has(one));
  if (unknown.length) {
    throw taskBlockRefusal(
      where,
      `it holds ${unknown.length === 1 ? 'a member' : `${unknown.length} members`} the editor does not have; a task block holds only ${memberSentence(members, 'and')} (its sign-off)`,
    );
  }
  const block: PhaseTaskBlock = {};
  if (record.key !== undefined) {
    if (typeof record.key !== 'string') throw taskBlockRefusal(where, 'its key must be text');
    block.key = record.key;
  }
  // Text a row can store, from any PackSource: the upload door already
  // refuses these (`escapedTextRefusals` in upload.service.ts); this holds for a
  // folder or a MemoryPackSource too. The reason, never the value.
  const storable = (value: string, member: string, verb: 'holds' | 'hold'): void => {
    const why = storableText(value);
    if (why !== null) {
      throw taskBlockRefusal(where, `its ${member} ${verb} ${why === 'nul' ? 'a null character' : 'half of a surrogate pair'}, which stored text never holds`);
    }
  };
  const text = (member: 'title' | 'brief', what: string, max: number): void => {
    const value = record[member];
    if (value === undefined) return;
    if (typeof value !== 'string') throw taskBlockRefusal(where, `its ${member} must be text`);
    storable(value, member, 'holds');
    if (!maxLength(value, max)) {
      throw taskBlockRefusal(where, overCapRefusal(what, max, value.length));
    }
    block[member] = value;
  };
  text('title', 'title', TASK_TITLE_MAX);
  text('brief', 'brief', TASK_BRIEF_MAX);
  if (record.objectives !== undefined) {
    const list = record.objectives;
    if (!Array.isArray(list) || list.some((one) => typeof one !== 'string')) {
      throw taskBlockRefusal(where, 'its objectives must be a list of text');
    }
    for (const one of list as string[]) storable(one, 'objectives', 'hold');
    if (list.length > TASK_OBJECTIVES_MAX) {
      throw taskBlockRefusal(
        where,
        `it holds ${list.length} objectives, and a task holds at most ${TASK_OBJECTIVES_MAX} objectives`,
      );
    }
    const long = (list as string[]).find((one) => !maxLength(one, TASK_OBJECTIVE_MAX));
    if (long !== undefined) {
      throw taskBlockRefusal(where, overCapRefusal('objective', TASK_OBJECTIVE_MAX, long.length));
    }
    block.objectives = [...(list as string[])];
  }
  // The editor's `@IsBoolean()`; the member, never its value.
  if (record.signOff !== undefined) {
    if (typeof record.signOff !== 'boolean') throw taskBlockRefusal(where, 'its signOff must be true or false');
    block.signOff = record.signOff;
  }
  try {
    taskWordsPatch(block);
  } catch (error) {
    if (error instanceof BadRequestException) throw taskBlockRefusal(where, error.message);
    throw error;
  }
  return block;
}

/**
 * The task a block applies to: the phase's compiled list must hold exactly one
 * non-quiz task, and a `key` must be the key the editor addresses it by.
 */
export function soleTaskForBlock(where: string, tasks: readonly CompiledTask[], block: PhaseTaskBlock): CompiledTask {
  const work = tasks.filter((one) => !isQuizTask(one));
  if (work.length !== 1) {
    throw taskBlockRefusal(
      where,
      `a task block applies to a phase that compiles to exactly one task a learner works (quizzes aside), and this phase compiles to ${work.length}`,
    );
  }
  const [task] = work;
  const editorKey = isAuthoredTaskKey(task.taskKey) ? task.taskKey : INHERITED_TASK_KEY;
  if (block.key !== undefined && block.key !== editorKey) {
    throw taskBlockRefusal(where, `its key names no task of this phase; the phase's task is "${editorKey}"`);
  }
  return task;
}

/**
 * Every phase's `task` block, by phase key, read through the pack's own
 * source and checked: each phase folder's `phase.json` (`derivePack`),
 * `where` the folder (`phases/03-implementation`). Both callers hand it the
 * folder layout, after the loader has read the same files (the importer's
 * `importTeacherDraft` after `loadProject`, which reads only the folder
 * layout; the export's read-back over the archive it wrote), so the JSON
 * parses. An older archive reaches it converted (`layoutFromManifest`).
 */
export function phaseTaskBlocksOf(source: PackSource): Map<string, { where: string; block: PhaseTaskBlock }> {
  const blocks = new Map<string, { where: string; block: PhaseTaskBlock }>();
  for (const phase of derivePack(source, { origin: 'upload' }).phases) {
    if (!Object.prototype.hasOwnProperty.call(phase.spec, 'task')) continue;
    blocks.set(phase.key, { where: phase.folder, block: checkedTaskBlock(phase.folder, phase.spec.task, 'folder') });
  }
  return blocks;
}
