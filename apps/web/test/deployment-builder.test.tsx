// @vitest-environment jsdom
/**
 * The four-step Deployment builder in the teacher's editor, and the Runbook
 * tab of Preview as a learner.
 *
 * The model's readings (the builder's task, the steps done, the locked keys,
 * the publish warning and the old file in the brief) are pure; the builder is
 * rendered with the projects API mocked, so every assertion reads what the
 * teacher sees and what a save sends.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  EMPTY_RUNBOOK,
  RUNBOOK_JSON,
  noSourceRecordRefusal,
  serialiseRunbook,
  type DraftPhaseView,
  type DraftTaskView,
  type LearnerPreviewPhase,
} from '@learnsdlc/shared';

const updateTask = vi.fn();
const updatePhase = vi.fn();
const replaceFile = vi.fn();
const files = vi.fn();
vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    updateTask: (...a: unknown[]) => updateTask(...a),
    updatePhase: (...a: unknown[]) => updatePhase(...a),
    replaceFile: (...a: unknown[]) => replaceFile(...a),
    files: (...a: unknown[]) => files(...a),
  },
}));

import {
  DEPLOYMENT_STEP_LABELS,
  briefNamesOldFile,
  deploymentBuilderTask,
  deploymentStepsDone,
  lockedDeploymentKeys,
  startingRunbookWarning,
} from '@/components/staff/projects/deployment/deployment-builder-model';
import { DeploymentBuilder } from '@/components/staff/projects/deployment/DeploymentBuilder';
import { forgetTaskSaves } from '@/components/staff/projects/requirements/builder-model';
import { SAVE_DELAY_MS } from '@/components/staff/projects/requirements/BuilderCard';
import { PreviewRunbook } from '@/components/staff/preview/LearnerPreview';
import { PublishPanel } from '@/components/staff/projects/PublishPanel';
import { ApiError } from '@/lib/api';
import { expectSignOffJumpLands } from './support/signoff-jump';
import { expectStepLinksLand } from './support/step-links';

const floor = { minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: true };
const task = {
  taskKey: 'main', title: 'Ship it', brief: 'Ship the two services.', checkKind: 'config', artefactType: 'runbook', authorable: false, required: true, objectives: [],
  config: {
    fileRules: [{ id: 'docker-workdir', label: 'WORKDIR', criterion: 'config_completeness', target: 'api/Dockerfile' }],
    smoke: { dockerfile: 'api/Dockerfile', commands: [['python3', 'api/main.py', '--selfcheck']], expectInOutput: 'selfcheck: web reaches api' },
    drill: { fault: 'web-points-at-localhost', description: "The web service's API_URL is http://localhost:8000.", faultedFiles: ['docker-compose.yml'] },
  },
  rubric: { passThreshold: 70, criteria: [{ key: 'config_completeness', title: 'c', weight: 0.4 }, { key: 'build_smoke', title: 'b', weight: 0.35 }, { key: 'runbook_quality', title: 'r', weight: 0.25 }] },
  runbook: { record: RUNBOOK_JSON, floor, drill: true },
} as unknown as DraftTaskView;
const phase = { key: 'deployment', title: 'Deployment', intro: 'Two services.', tasks: [task], files: [] } as unknown as DraftPhaseView;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetTaskSaves();
  updateTask.mockReset();
  updatePhase.mockReset();
  replaceFile.mockReset();
  files.mockReset();
  files.mockResolvedValue([]);
  updateTask.mockImplementation(() => new Promise(() => undefined));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
}
function byTestId(id: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element ${id}`);
  return el;
}
const queryTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('the Deployment builder model', () => {
  test("takes Deployment's config task with a runbook view, and no other", () => {
    expect(deploymentBuilderTask(phase, true)).toBe(task);
    expect(deploymentBuilderTask({ ...phase, key: 'testing' } as DraftPhaseView, true)).toBeNull();
    expect(deploymentBuilderTask({ ...phase, tasks: [{ ...task, runbook: undefined }] } as DraftPhaseView, true)).toBeNull();
  });
  test('has four steps: a structured task counts its Runbook step done, an older one only once saved', () => {
    expect(DEPLOYMENT_STEP_LABELS).toEqual(['Brief', 'Files and checks', 'Runbook', 'Criteria']);
    expect(deploymentStepsDone(phase, task, { runbook: false })).toEqual([true, true, true, true]);
    expect(deploymentStepsDone(phase, { ...task, recordOlderFormat: true } as DraftTaskView, { runbook: false })[2]).toBe(false);
    expect(deploymentStepsDone(phase, { ...task, recordOlderFormat: true } as DraftTaskView, { runbook: true })[2]).toBe(true);
  });
  test("locks the file rules' criteria and build_smoke, read from the config view", () => {
    expect(lockedDeploymentKeys(task)).toEqual(['config_completeness', 'build_smoke']);
  });
  test('warns when the starting runbook already meets the floor, and names an old file in the brief', () => {
    const met = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'A', purpose: 'a', kind: 'config' }, { id: 'E2', name: 'B', purpose: 'b', kind: 'config' }], health: [{ id: 'H1', name: 'h', how: 'x', expected: 'y' }], rollback: [{ id: 'R1', step: 's', verify: 'v' }, { id: 'R2', step: 's', verify: 'v' }], data: [{ id: 'D1', what: 'w', how: 'h', where: 'w' }], incident: { rootCause: 'r', fix: 'f', actionItem: 'a' } });
    expect(startingRunbookWarning(met, floor)).toBe('The starting runbook already meets the floor, so a learner who changes nothing passes it. Raise the floor or empty the starting record.');
    expect(startingRunbookWarning(serialiseRunbook(EMPTY_RUNBOOK), floor)).toBeNull();
    expect(briefNamesOldFile({ ...task, brief: 'Fill RUNBOOK.md.' }, 'RUNBOOK.md')).toBe('The brief still names RUNBOOK.md, which this phase no longer has.');
    expect(briefNamesOldFile(task, 'RUNBOOK.md')).toBeNull();
  });
});

describe('DeploymentBuilder', () => {
  const props = { projectId: 'p', versionId: 'v', draft: { phases: [phase] } as never, phase, task, editable: true, onSaved: () => {}, onSignOff: () => {} };
  const startingRow = (content: string) => [{ path: RUNBOOK_JSON, content, editable: true, ownerKind: 'phase', phaseKey: 'deployment' }];
  test('draws four steps: the brief, the files and checks read-only, the runbook and the criteria with the locked rows', async () => {
    files.mockResolvedValue(startingRow(serialiseRunbook(EMPTY_RUNBOOK)));
    await act(async () => root.render(<DeploymentBuilder {...props} />));
    for (const id of ['tdp-brief', 'tdp-files', 'tdp-runbook', 'tdp-criteria']) expect(queryTestId(id), id).not.toBeNull();
    const filesCard = byTestId('tdp-files').textContent ?? '';
    for (const said of ['WORKDIR', 'api/Dockerfile', 'config_completeness', 'python3 api/main.py --selfcheck', 'web-points-at-localhost', 'docker-compose.yml']) expect(filesCard).toContain(said);
    expect(byTestId('tdp-files').querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(byTestId('tdp-floor-sentence').textContent).toContain('at least 2 environment entries');
    expect(byTestId('tdp-readiness').textContent).toBe('4 of 4 steps done');
    const removes = [...byTestId('tdp-criteria').querySelectorAll('button')].filter((b) => /Remove/.test(`${b.textContent} ${b.getAttribute('aria-label') ?? ''}`)) as HTMLButtonElement[];
    expect(removes.map((b) => b.disabled)).toEqual([true, true, false]);
    // Deployment is scored by the weighted sum: the line gives what its pass needs.
    expect(byTestId('tdp-criteria-passmark').textContent).toContain(
      'The runbook and the files pass only when every check passes and the review finds more than half of the criteria met; the pass mark does not decide that.',
    );
    // A locked row says why in words beside its Remove, tied to it, not only in a tooltip.
    for (const n of [1, 2]) {
      const why = byTestId(`tre-criterion-${n}-locked`);
      expect(why.textContent).toMatch(/ is graded by the phase's own checks, so it stays in the rubric\.$/);
      expect(removes[n - 1].getAttribute('aria-describedby')).toBe(why.id);
    }
    expect(queryTestId('tre-criterion-3-locked')).toBeNull();
    expect(queryTestId('tdp-required')).toBeNull();
  });
  test('each minimum is the builders\' stepper, and a refused floor save puts the server\'s floor back on screen', async () => {
    files.mockResolvedValue(startingRow(serialiseRunbook(EMPTY_RUNBOOK)));
    await act(async () => root.render(<DeploymentBuilder {...props} />));
    const card = byTestId('tdp-runbook');
    const more = card.querySelector<HTMLButtonElement>('button[aria-label="More health checks"]')!;
    expect(card.querySelector('button[aria-label="Fewer health checks"]')).not.toBeNull();
    updateTask.mockRejectedValueOnce(new Error('refused'));
    await act(async () => { fireEvent.click(more); });
    expect(updateTask).toHaveBeenLastCalledWith('p', 'v', 'deployment', 'main', { runbook: { floor: { ...floor, minHealth: 2 } } });
    expect((byTestId('tdp-floor-minHealth') as HTMLInputElement).value).toBe('1');
    expect(byTestId('tdp-floor-sentence').textContent).toContain('at least 1 health check');
    updateTask.mockResolvedValueOnce({ phase, validation: {} });
    await act(async () => { fireEvent.click(more); });
    expect((byTestId('tdp-floor-minHealth') as HTMLInputElement).value).toBe('2');
  });
  test('a stepper sends the runbook floor, and Start empty asks first, then sends the empty record', async () => {
    replaceFile.mockResolvedValue({});
    files.mockResolvedValue(startingRow(serialiseRunbook(EMPTY_RUNBOOK)));
    await act(async () => root.render(<DeploymentBuilder {...props} />));
    await act(async () => { fireEvent.change(byTestId('tdp-floor-minHealth'), { target: { value: '2' } }); });
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'deployment', 'main', { runbook: { floor: { ...floor, minHealth: 2 } } });
    await act(async () => { fireEvent.click(byTestId('tdp-start-empty')); });
    expect(replaceFile).not.toHaveBeenCalled();
    expect(byTestId('tdp-start-confirm-line').textContent).toContain('replaces the starting runbook with an empty one');
    await act(async () => { fireEvent.click(byTestId('tdp-start-keep')); });
    expect(queryTestId('tdp-start-confirm')).toBeNull();
    await act(async () => { fireEvent.click(byTestId('tdp-start-empty')); });
    await act(async () => { fireEvent.click(byTestId('tdp-start-confirm')); });
    expect(replaceFile).toHaveBeenCalledWith('p', 'v', 'deployment', { path: RUNBOOK_JSON, content: serialiseRunbook(EMPTY_RUNBOOK) });
    expect(queryTestId('tdp-start-confirm')).toBeNull();
  });
  test('a refused Start empty puts the forms back on the record the server holds', async () => {
    files.mockResolvedValue(startingRow(serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'p', kind: 'config' }] })));
    replaceFile.mockRejectedValue(new ApiError(400, 'The starting runbook could not be written.'));
    await act(async () => root.render(<DeploymentBuilder {...props} />));
    await act(async () => { fireEvent.click(byTestId('tdp-start-empty')); });
    await act(async () => { fireEvent.click(byTestId('tdp-start-confirm')); });
    expect(byTestId('tdp-runbook-error').textContent).toBe('The starting runbook could not be written.');
    expect((byTestId('runbook-environment-0-name') as HTMLTextAreaElement).value).toBe('API_URL');
  });
  test("Reset to the pack's asks first, and says the refusal in its own words when the source has no starting runbook", async () => {
    files.mockResolvedValue(startingRow(serialiseRunbook(EMPTY_RUNBOOK)));
    replaceFile.mockRejectedValue(new ApiError(400, noSourceRecordRefusal(RUNBOOK_JSON)));
    await act(async () => root.render(<DeploymentBuilder {...props} />));
    await act(async () => { fireEvent.click(byTestId('tdp-reset-source')); });
    expect(byTestId('tdp-start-confirm-line').textContent).toBe("If this draft was opened from a version, this puts back that version's starting runbook, and your changes to it are lost.");
    expect(replaceFile).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(byTestId('tdp-start-confirm')); });
    expect(replaceFile).toHaveBeenCalledWith('p', 'v', 'deployment', { path: RUNBOOK_JSON, reset: 'source' });
    expect(byTestId('tdp-runbook-error').textContent).toBe(noSourceRecordRefusal(RUNBOOK_JSON));
  });
  test("an older task's Brief save carries the runbook floor, so the first words save converts it", async () => {
    const older = { ...task, recordOlderFormat: true } as DraftTaskView;
    await act(async () => root.render(<DeploymentBuilder {...props} phase={{ ...phase, tasks: [older] } as DraftPhaseView} task={older} />));
    expect(byTestId('tdp-older-format').textContent).toBe('This task is in the older format. Saving the brief, the runbook floor or the criteria converts it.');
    await act(async () => { fireEvent.change(byTestId('tdp-brief-title'), { target: { value: 'Ship it now' } }); });
    await act(async () => { fireEvent.click(byTestId('tdp-brief-save')); });
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'deployment', 'main', { title: 'Ship it now', runbook: { floor } });
  });
  test("reads the files again once the converting save lands, so step 3 opens on the converted record and the first edit builds on it", async () => {
    const older = { ...task, recordOlderFormat: true } as DraftTaskView;
    const converted = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'Where the web app finds the API', kind: 'config' }] });
    files.mockResolvedValueOnce([]).mockResolvedValue(startingRow(converted));
    replaceFile.mockResolvedValue({});
    await act(async () => root.render(<DeploymentBuilder {...props} phase={{ ...phase, tasks: [older] } as DraftPhaseView} task={older} />));
    expect(queryTestId('tdp-runbook-older')).not.toBeNull();
    // every node committed on the way, so a notice drawn for one frame and gone by the end is still seen
    const drawn: Node[] = [];
    const watch = new MutationObserver((records) => { for (const record of records) drawn.push(...record.addedNodes); });
    watch.observe(host, { childList: true, subtree: true });
    await act(async () => root.render(<DeploymentBuilder {...props} />));
    watch.disconnect();
    expect(files).toHaveBeenCalledTimes(2);
    expect(queryTestId('runbook-unreadable')).toBeNull();
    expect(drawn.some((node) => node instanceof HTMLElement && (node.matches('[data-testid="runbook-unreadable"]') || node.querySelector('[data-testid="runbook-unreadable"]') !== null))).toBe(false);
    expect((byTestId('runbook-environment-0-name') as HTMLTextAreaElement).value).toBe('API_URL');
    await act(async () => { fireEvent.change(byTestId('runbook-environment-0-name'), { target: { value: 'API_BASE' } }); });
    // the edit saves itself after the card's delay
    await act(async () => { await new Promise((done) => setTimeout(done, SAVE_DELAY_MS + 100)); });
    const sent = replaceFile.mock.calls.at(-1)?.[3] as { path: string; content: string };
    expect(sent.path).toBe(RUNBOOK_JSON);
    expect(JSON.parse(sent.content).environment).toEqual([{ id: 'E1', name: 'API_BASE', purpose: 'Where the web app finds the API', kind: 'config' }]);
  });
  test('the builder draws no refused-conversion line: the editor says it above the generic panels', async () => {
    await act(async () => root.render(<DeploymentBuilder {...props} task={{ ...task, recordConversionRefused: 'This Deployment task cannot be converted.' } as DraftTaskView} />));
    expect(queryTestId('tdp-conversion-refused')).toBeNull();
    expect(host.textContent).not.toContain('This Deployment task cannot be converted.');
  });
  test("Start empty and Reset to the pack's are off while a record save is out", async () => {
    let answer: (result: unknown) => void = () => undefined;
    files.mockResolvedValue(startingRow(serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'p', kind: 'config' }] })));
    replaceFile.mockReturnValueOnce(new Promise((done) => (answer = done)));
    await act(async () => root.render(<DeploymentBuilder {...props} />));
    expect((byTestId('tdp-start-empty') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.change(byTestId('runbook-environment-0-name'), { target: { value: 'API_BASE' } }); });
    await act(async () => { await new Promise((done) => setTimeout(done, SAVE_DELAY_MS + 100)); });
    expect(replaceFile).toHaveBeenCalledTimes(1);
    expect((byTestId('tdp-start-empty') as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId('tdp-reset-source') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer({}));
    expect((byTestId('tdp-start-empty') as HTMLButtonElement).disabled).toBe(false);
    expect((byTestId('tdp-reset-source') as HTMLButtonElement).disabled).toBe(false);
  });
  test('Preview as a learner draws the Runbook tab over the starting record, and the empty runbook when the phase ships none', () => {
    const shipped = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'p', kind: 'config' }] });
    const preview = { key: 'deployment', files: [{ path: RUNBOOK_JSON, content: shipped, editable: true }], runbook: { floor, drill: true } } as unknown as LearnerPreviewPhase;
    render(<PreviewRunbook phase={preview} />);
    expect((byTestId('runbook-environment-0-name') as HTMLTextAreaElement).value).toBe('API_URL');
    expect((byTestId('runbook-environment-0-name') as HTMLTextAreaElement).readOnly).toBe(true);
    render(<PreviewRunbook phase={{ ...preview, files: [] } as LearnerPreviewPhase} />);
    expect(queryTestId('runbook-section-environment')).not.toBeNull();
    expect(queryTestId('runbook-environment-0-name')).toBeNull();
  });
  // Each link of the row of steps goes to its own card.
  test('each step link of the row names its own card, in the order of the cards', async () => {
    await act(async () => root.render(<DeploymentBuilder {...props} />));
    expect(expectStepLinksLand(host)).toEqual(['Brief', 'Files and checks', 'Runbook', 'Criteria']);
  });
  // The Runbook card's box sits under the runbook; the row's Sign-off entry goes to it.
  test('the Sign-off entry after the four steps brings the Runbook box into view and focuses it, never ticking it', async () => {
    await act(async () => root.render(<DeploymentBuilder {...props} />));
    await expectSignOffJumpLands(host, 'main', 'tdp-runbook');
    expect(updateTask).not.toHaveBeenCalled();
  });
  test('a version that cannot change draws no box, so no Sign-off entry', async () => {
    await act(async () => root.render(<DeploymentBuilder {...props} editable={false} />));
    expect(queryTestId('tre-steps')).not.toBeNull();
    expect(queryTestId('tre-signoff-jump')).toBeNull();
    expect(document.getElementById('task-signoff-main')).toBeNull();
  });
});

describe('the publish warning', () => {
  test('a starting runbook that meets the floor is said above Publish, and Publish stays enabled', () => {
    const met = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'A', purpose: 'a', kind: 'config' }, { id: 'E2', name: 'B', purpose: 'b', kind: 'config' }], health: [{ id: 'H1', name: 'h', how: 'x', expected: 'y' }], rollback: [{ id: 'R1', step: 's', verify: 'v' }, { id: 'R2', step: 's', verify: 'v' }], data: [{ id: 'D1', what: 'w', how: 'h', where: 'w' }], incident: { rootCause: 'r', fix: 'f', actionItem: 'a' } });
    const warning = startingRunbookWarning(met, floor);
    expect(warning).not.toBeNull();
    render(
      <PublishPanel
        draftVersion="1.0.0"
        report={{ publishable: true, failed: 0, blocking: [] } as never}
        editable
        readOnlyReason={null}
        publishing={false}
        error=""
        published={null}
        onPublish={() => {}}
        warnings={[warning as string]}
      />,
    );
    const warnings = byTestId('project-publish-warnings');
    const publish = byTestId('project-publish') as HTMLButtonElement;
    expect(warnings.textContent).toContain(warning as string);
    expect(warnings.compareDocumentPosition(publish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(publish.disabled).toBe(false);
  });
});
