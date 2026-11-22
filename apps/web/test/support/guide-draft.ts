/**
 * The draft the teacher guide tests open: one Requirements phase with one
 * required task, no validation yet. teacher-guide-archive-names, guide-preview-mark-timing and
 * guide-marks-storage each carried this same builder; it lives here so the three
 * cannot drift apart.
 */
import type { DraftVersionView } from '@learnsdlc/shared';
import { DEFAULT_PASS_THRESHOLD, SUPPORTED_STACKS_SENTENCE } from '@learnsdlc/shared';
import { phaseSetFor } from './phase-set';

export function draftView(versionId = 'v-gm'): DraftVersionView {
  return {
    projectId: 'p-gm',
    versionId,
    version: '0.1.0',
    status: 'draft',
    slug: 'books-on-a-shelf',
    title: 'Books on a shelf',
    tagline: '',
    description: '',
    platformOwned: false,
    editable: true,
    phases: [
      {
        key: 'requirements',
        order: 0,
        title: 'Requirements',
        intro: 'Ask.',
        artifactKind: 'doc',
        checkKind: 'doc',
        tasks: [
          {
            taskKey: 'main',
            order: 1,
            required: true,
            title: 'Write the stories',
            brief: 'Write them.',
            artefactType: 'user-stories',
            artefactPath: null,
            checkKind: 'doc',
            rubric: { passThreshold: DEFAULT_PASS_THRESHOLD, criteria: [] },
            objectives: [],
            owns: [],
            authorable: true,
            notice: null,
          },
        ],
        blocksPublish: false,
      },
    ],
    validation: null,
    supportedStacks: { python: ['flask'], node: ['react'], tools: ['esbuild'], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-10-01T00:00:00.000Z',
    phaseSet: phaseSetFor(['requirements'], true),
  } as unknown as DraftVersionView;
}
