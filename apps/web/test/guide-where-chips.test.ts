/**
 * Every chapter of the six guides says where the learner uses it, in the
 * product's own words. The reader draws `study.where` as the chapter's one
 * "Where you use this" chip (test/lesson-reader.test.tsx draws all 24); this
 * file pins each chapter's words to the room labels they name, read from the
 * room's own source, so a renamed tab breaks a test here and not a learner.
 */
import { repoFile } from './support/paths';
import { describe, expect, it } from 'vitest';
import { closureText } from './support/source-text';
import type { PhaseKey } from '@learnsdlc/shared';
import { PHASE_STUDY } from '@/components/learn/study';
import { AREA_REVIEW_LABEL, WORKING_AREA_LABELS } from '@/components/workspace/AreaNav';


const PHASES: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const ROOM: Record<PhaseKey, string> = {
  requirements: 'Requirements room', design: 'Design room', implementation: 'Implementation room',
  testing: 'Testing room', deployment: 'Deployment room', maintenance: 'Maintenance room',
};

/**
 * Each label a chapter's words name, and the source text that holds it: the module that draws it and everything that
 * module draws from, found by a name it exports or by its route, so a moved or split component is still read.
 */
const persona = closureText('PersonaPanel');
const submit = closureText('HeaderSubmit');
const workbench = closureText('ApiWorkbench');
const studio = closureText('DiagramStudio');
const previewRooms = closureText('appPreviewPaneOf');
const workspace = closureText('app/(app)/workspace/[phaseId]/page.tsx');
const deployment = closureText('components/workspace/panels/deployment/index.tsx');
const drill = closureText('components/workspace/panels/deployment/drill.ts');
const change = closureText('app/(app)/workspace/[phaseId]/change/page.tsx');
const pr = closureText('app/(app)/workspace/[phaseId]/pr/page.tsx');
const L = WORKING_AREA_LABELS;
const LABELS: Record<PhaseKey, [string, boolean][][]> = {
  requirements: [
    [['Interview the customer', persona.includes('>Interview the customer<')]],
    [[L.requirements.document, true]],
    [[L.requirements.document, true]],
    [['Submit for review', submit.includes("'Submit for review'")]],
  ],
  design: [
    [['API contract workbench', workbench.includes('aria-label="API contract workbench"')]],
    [['Diagram studio', studio.includes('>Diagram studio<')], ['Class / UML', studio.includes('>Class / UML<')]],
    [['Diagram studio', studio.includes('>Diagram studio<')], ['Sequence', studio.includes('>Sequence<')]],
    [[L.design.document, true]],
  ],
  implementation: [
    [[`${L.implementation.edit} tab`, true]],
    [[`${L.implementation.edit} tab`, true]],
    [['the preview tab', previewRooms.includes("'App preview' : 'Page preview'")]],
    [['Run tests', workspace.includes("'Run selfcheck' : 'Run tests'")], ['Tests tab', /key: 'tests',\s*label: 'Tests'/.test(workspace)]],
  ],
  testing: [
    [[`${L.testing.edit} tab`, true]],
    [[`${L.testing.edit} tab`, true]],
    [[`${L.testing.edit} tab`, true]],
    [[`${L.testing.document} page`, true]],
  ],
  deployment: [
    [[`${L.deployment.edit} tab`, true], ['api/Dockerfile', repoFile('content/tasktrackr/phases/05-deployment/files/api/Dockerfile').length > 0], ['docker-compose.yml', repoFile('content/tasktrackr/phases/05-deployment/files/docker-compose.yml').length > 0]],
    [['Pipeline and drill tab', deployment.includes("label: 'Pipeline and drill'")]],
    [[`${L.deployment.document} page`, true], ['INCIDENT-1', drill.includes('INCIDENT-1 paged')]],
    [['Runbook tab', deployment.includes("label: 'Runbook'")]],
  ],
  maintenance: [
    [[L.maintenance.document, true], ['Request tab', change.includes(">Request</button>")]],
    [[`${L.maintenance.edit} tab`, true], ['TASK_SELECT in api/repository/tasks.py', repoFile('content/tasktrackr/phases/06-maintenance/files/api/repository/tasks.py').includes('TASK_SELECT = ')]],
    [[AREA_REVIEW_LABEL.maintenance!, true], ['Files changed tab', pr.includes("label: 'Files changed'")]],
    [[L.maintenance.document, true], ['Release tab', change.includes(">Release</button>")]],
  ],
};

describe('"Where you use this" on all 24 chapters', () => {
  it('fills `where` on every chapter, starting with the phase’s room, never the reader’s fallback', () => {
    for (const phase of PHASES) {
      const chapters = PHASE_STUDY[phase].chapters;
      expect(chapters).toHaveLength(4);
      chapters.forEach((chapter, i) => {
        expect(chapter.where, `${phase} ${i + 1}`).toBeTruthy();
        expect(chapter.where!.startsWith(`${ROOM[phase]}, `), `${phase} ${i + 1}: ${chapter.where}`).toBe(true);
        expect(chapter.where).not.toContain('in your project space');
        expect(chapter.where).not.toMatch(/[·|—]/);
      });
    }
  });

  it('names only labels the rooms draw, read from the rooms’ own source', () => {
    for (const phase of PHASES) {
      PHASE_STUDY[phase].chapters.forEach((chapter, i) => {
        for (const [label, inSource] of LABELS[phase][i]) {
          expect(chapter.where, `${phase} ${i + 1} names "${label}"`).toContain(label);
          expect(inSource, `${phase} ${i + 1}: "${label}" is in the room's source`).toBe(true);
        }
      });
    }
  });

  it('does not send Implementation to an Execution evidence tab, which its room does not draw', () => {
    // The Implementation room's row is Code, Split, the preview and Pull request
    // (AreaNav `areaEntries`); its run's results are the Tests tab under the code.
    for (const chapter of PHASE_STUDY.implementation.chapters) expect(chapter.where).not.toContain('Execution evidence');
  });
});
