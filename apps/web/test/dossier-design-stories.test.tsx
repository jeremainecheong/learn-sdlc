// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DESIGN_FLOOR, DESIGN_JSON, EMPTY_DESIGN, serialiseDesign,
  type DesignStory, type EnrollmentView, type LearnerDossier, type PhaseDetail, type SubmissionView,
} from '@learnsdlc/shared';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import type { PhaseRecords } from '@/lib/records';

/*
 * The contradictions at merge read the contract against the stories the
 * Design phase lists. The learner's copy and the teacher's copy carry those
 * stories from the same place, the phase spec of the version the enrolment
 * holds (the API's `learnerDossier` fills them from `phase.checks`, the
 * learner's from `PhaseDetail.design`, which is that spec's own view), so
 * both audiences print the same contradictions.
 */

const STORIES: DesignStory[] = [
  { id: 'US-3', title: 'Filter, search and order a list', line: 'As a busy learner, I want to narrow a list by status, tag and keyword and read it with high priority tasks before medium, so that I can see the right work first.' },
];
// the contract orders the other way: a contradiction only the phase's stories can show
const record = serialiseDesign({
  ...EMPTY_DESIGN,
  operations: [{ id: 'O1', name: 'listTasks(listId, filters)', inputs: ['listId'], returns: 'Task[]', errors: [], satisfies: ['US-3'], note: 'ordering: tasks in ascending priority, lowest first.' }],
});
const designPhase = { id: 'phase-design', key: 'design', order: 2, title: 'Design', status: 'in_progress', attempts: 1, bestScore: null, passedAt: null };
const enrollment = {
  phases: [designPhase], projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [], startedAt: '2026-10-10T00:00:00Z', completedAt: null,
} as unknown as EnrollmentView;
const detail = (design: PhaseDetail['design']) => ({
  'phase-design': { ...designPhase, files: [{ path: DESIGN_JSON, content: record, editable: true, language: 'json' }], links: [], rubric: { passThreshold: 70, criteria: [] }, drill: null, design },
}) as unknown as Record<string, PhaseDetail>;
const revision = { id: 'review', status: 'completed', passed: false, score: 0, report: null, createdAt: '2026-10-11T00:00:00Z' } as SubmissionView;
const records: Record<string, PhaseRecords> = { 'phase-design': { submissions: [revision], runs: [], chat: [] } };
const snapshots = { review: { [DESIGN_JSON]: record } };
const spec = { contracts: { api: false, screens: false }, sequence: false, stories: STORIES, floor: DEFAULT_DESIGN_FLOOR };

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const contradictions = async (dossier: LearnerDossier) => {
  await act(async () => root.render(<Dossier dossier={dossier} />));
  return host.querySelector('[data-testid="dossier-contradictions"]')?.textContent ?? '';
};

describe("the dossier's contradictions read the Design phase's stories", () => {
  it("the learner's copy carries the design phase's stories and reads the contract against them", async () => {
    const mine = buildDossier(enrollment, detail(spec), records, snapshots, null);
    expect(mine.phases[0].designStories).toEqual(STORIES);
    const text = await contradictions(mine);
    expect(text).toContain('listTasks orders low priority first');
    expect(text).not.toContain('The stories of this project were not kept');
  });

  it("the teacher's copy, with the stories the API fills from the phase spec, prints the same contradictions", async () => {
    const mine = buildDossier(enrollment, detail(spec), records, snapshots, null);
    const learnerText = await contradictions(mine);
    // the instructor's shape: the same phases, the stories from the spec, as `learnerDossier` sends them
    const teacher: LearnerDossier = { ...mine, audience: 'instructor', phases: mine.phases.map((phase) => ({ ...phase, designStories: STORIES.map((story) => ({ ...story })) })) };
    expect(await contradictions(teacher)).toBe(learnerText);
  });

  it('draws a contract\'s table only while the teacher\'s switch is on, whatever the files hold (Task 11)', async () => {
    const api = JSON.stringify({ operations: [{ id: 'a', method: 'GET', path: '/api/a' }], errors: {} });
    const withApi = { review: { [DESIGN_JSON]: record, 'shared/contract/api.json': api } };
    const off = buildDossier(enrollment, detail(spec), records, withApi, null);
    expect(off.phases[0].designContracts).toEqual({ api: false, screens: false });
    await act(async () => root.render(<Dossier dossier={off} />));
    expect(host.querySelector('[data-testid="dossier-api"]')).toBeNull();
    const on = buildDossier(enrollment, detail({ ...spec, contracts: { api: true, screens: false } }), records, withApi, null);
    await act(async () => root.render(<Dossier dossier={on} />));
    expect(host.querySelector('[data-testid="dossier-api"]')).not.toBeNull();
  });

  it('a phase that is not of the design kind carries no stories', () => {
    expect(buildDossier(enrollment, detail(undefined), records, snapshots, null).phases[0].designStories).toBeUndefined();
  });
});
