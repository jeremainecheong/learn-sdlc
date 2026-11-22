import { describe, expect, it } from 'vitest';
import type { PhaseKey } from '@learnsdlc/shared';
import { PHASE_ROOM_ARTEFACT_PATHS } from '@learnsdlc/shared';
import { PHASE_ROOM_ARTEFACT } from '@/components/shell/routes';
import { phaseRoomTaskKey } from '@/components/workspace/TaskPanel';
import { taskView } from './fixtures';

/**
 * One list of room artefacts, read by both halves (web routing and the API's
 * reviewer scoping).
 *
 * The web routes a task to its phase's own room when the task declares (or,
 * where nobody declares it, owns) the file that room is built around
 * (`routes.ts` `PHASE_ROOM_ARTEFACT`, `components/workspace/task-model.ts` `phaseRoomTaskKey`), and
 * every other written task to the workspace editor. The API now tells its
 * reviewer and mentor which of the two a task is worked in by asking the same
 * question of `PHASE_ROOM_ARTEFACT_PATHS` (`apps/api/src/assistant/project-scope.ts`
 * `phaseRoomTaskKeyOf`). If the two lists drifted, a learner would be sent to
 * one room while the reviewer was told they worked in the other, and advice
 * to use a control that is not there fails the Guided reviewer's `grounded`
 * check. The web runtime keeps its own constant; this is what holds them to one
 * another.
 */
describe('the room each phase is built around', () => {
  it('is the same four paths on the web and in the shared contract', () => {
    expect(PHASE_ROOM_ARTEFACT).toEqual(PHASE_ROOM_ARTEFACT_PATHS);
    expect(PHASE_ROOM_ARTEFACT_PATHS).toEqual({
      requirements: 'requirements/story.json',
      design: 'design/design.json',
      deployment: 'deployment/runbook.json',
      maintenance: 'maintenance/change-request.json',
    });
  });

  const task = taskView;

  it('names the room task by the shared path, the declarer before an earlier owner', () => {
    // The rule the API's mirror copies: across the whole list the task that
    // DECLARES the path first, and only where nobody declares it, the first
    // task that owns it.
    for (const [key, path] of Object.entries(PHASE_ROOM_ARTEFACT_PATHS) as [PhaseKey, string][]) {
      const tasks = [
        task({ key: 'owner', order: 1, files: [path, 'notes.md'] }),
        task({ key: 'declarer', order: 2, artefactPath: path, files: [path] }),
      ];
      expect(phaseRoomTaskKey(key, tasks)).toBe('declarer');
      expect(phaseRoomTaskKey(key, [tasks[0]])).toBe('owner');
      expect(phaseRoomTaskKey(key, [task({ key: 'elsewhere', order: 1, artefactPath: 'docs/other.md' })])).toBeUndefined();
    }
  });

  it('gives the two workspace phases no room task at all', () => {
    for (const key of ['implementation', 'testing'] as PhaseKey[]) {
      expect(PHASE_ROOM_ARTEFACT_PATHS[key]).toBeUndefined();
      expect(PHASE_ROOM_ARTEFACT[key]).toBeUndefined();
      expect(phaseRoomTaskKey(key, [task({ key: 'main', order: 1, artefactPath: 'requirements/story.json' })])).toBeUndefined();
    }
  });
});
