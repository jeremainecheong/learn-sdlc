import * as path from 'path';
import { type ChangeFloor, type ChangeTicket, type RunbookFloor } from '@learnsdlc/shared';
import type { ContentService } from '../src/content/content.service';
import type { ProjectContent } from '../src/content/content.types';
import { MemoryPackSource } from '../src/content/memory-pack-source';
import { DirectoryPackSource, type PackSource } from '../src/content/pack-source';
import { entriesOf } from './fixtures/upload-packs/archive';

const TASKTRACKR = path.join(__dirname, '..', '..', '..', 'content', 'tasktrackr');

/** TaskTrackr's CR-2 ticket, as its Maintenance ships it (unchanged from 5.0.0 to 6.0.0). */
export const RECORD_TICKET: ChangeTicket = {
  id: 'CR-2',
  title: 'Comments on a task',
  summary: 'A task says what to do and never says what happened. Let people leave a comment on a task, read a task\'s comments newest first, and see on the task row how many a task carries.',
  acceptance: [
    { id: 'AC-1', line: 'add_comment stores one comment and returns it with id, task_id, author, body and created_at.' },
    { id: 'AC-2', line: 'An unknown task answers 404 task_not_found, when adding a comment and when listing them.' },
    { id: 'AC-3', line: 'An empty or whitespace-only author or body answers 400 invalid_comment.' },
    { id: 'AC-4', line: 'list_comments returns a task\'s comments newest first.' },
    { id: 'AC-5', line: 'Every task the API returns carries comment_count, and the task query returns the same rows as before.' },
    { id: 'AC-6', line: 'The task row shows "1 comment" or "4 comments", and nothing for a task with none.' },
    { id: 'AC-7', line: 'listComments and addComment are published in the API contract, with the error code addComment answers with.' },
  ],
};
/** TaskTrackr's two floors, as its Deployment and Maintenance ship them (unchanged from 5.0.0 to 6.0.0). */
export const RECORD_RUNBOOK_FLOOR: RunbookFloor = { minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: true };
export const RECORD_CHANGE_FLOOR: ChangeFloor = { minImpact: 3, minContract: 2, minTests: 2, requireRelease: true, traceEveryAcceptance: true };

/**
 * TaskTrackr with its Deployment and Maintenance in the record shape: the
 * real pack, 6.0.0 in the folder layout, read from the tree. With an `edit`, the pack is built in
 * memory from the same tree so a spec can change the Implementation's, the
 * Deployment's or the Maintenance's phase.json before it is read, or add
 * `extra` entries (one at a path the pack holds replaces it), or `drop` the entries it names (a
 * folder the edit leaves undeclared, such as `phases/05-deployment/drill/`). The in-memory copy has no warm-up: the
 * warm-up loader reads `source.location` as a disk path and a
 * MemoryPackSource's location is a label, so the warm-up folder and
 * project.json's `warmup` key are left out.
 */
export function recordPack(edit: { implementation?: (spec: any) => void; deployment?: (spec: any) => void; maintenance?: (spec: any) => void; extra?: Record<string, string>; drop?: (name: string) => boolean } = {}): PackSource {
  if (!edit.implementation && !edit.deployment && !edit.maintenance && !edit.extra && !edit.drop) return new DirectoryPackSource(TASKTRACKR);
  const extra = Object.entries(edit.extra ?? {}).map(([name, text]) => ({ name, bytes: Buffer.from(text) }));
  // an `extra` entry at a path the pack already holds replaces that file
  const replaced = new Set(extra.map((one) => one.name));
  const entries = entriesOf(TASKTRACKR).flatMap((entry) => {
    if (replaced.has(entry.name) || edit.drop?.(entry.name)) return [];
    // no warm-up in memory: the warm-up loader reads source.location as a disk path
    if (entry.name.startsWith('warmup/')) return [];
    if (entry.name === 'project.json') {
      const meta = JSON.parse(entry.data.toString('utf8'));
      delete meta.warmup;
      return [{ name: entry.name, bytes: Buffer.from(JSON.stringify(meta, null, 2)) }];
    }
    const phaseEdit = entry.name === 'phases/03-implementation/phase.json' ? edit.implementation
      : entry.name === 'phases/05-deployment/phase.json' ? edit.deployment
        : entry.name === 'phases/06-maintenance/phase.json' ? edit.maintenance : undefined;
    if (phaseEdit) {
      const spec = JSON.parse(entry.data.toString('utf8'));
      phaseEdit(spec);
      return [{ name: entry.name, bytes: Buffer.from(JSON.stringify(spec, null, 2)) }];
    }
    return [{ name: entry.name, bytes: entry.data }];
  });
  return new MemoryPackSource([...entries, ...extra], 'tasktrackr');
}

/**
 * Loads every shipped pack, then serves the record pack as TaskTrackr, so a
 * service spec enrols a learner on Deployment and Maintenance with records.
 * It writes the loader's own map, which only `loadAll` fills: test-only.
 * The record pack is the real TaskTrackr pack, so this is the TaskTrackr
 * `loadAll` loaded, read again.
 */
export function useRecordPack(content: ContentService): ProjectContent {
  content.loadAll();
  const project = content.loadProject(recordPack());
  (content as unknown as { projects: Map<string, ProjectContent> }).projects.set('tasktrackr', project);
  return project;
}
