// @vitest-environment jsdom
/**
 * The five-step Maintenance builder in the teacher's editor, and the change
 * room of Preview as a learner.
 *
 * The model's readings (the steps, the locked keys, the contract switch's
 * confirm line, the ticket edit the starting record refuses, the minted
 * acceptance id and the publish warning) are pure; the builder is rendered
 * with the projects API mocked, so every assertion reads what the teacher sees
 * and what a save sends.
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CHANGE_REQUEST_JSON,
  EMPTY_CHANGE_REQUEST,
  noSourceRecordRefusal,
  serialiseChangeRequest,
  type ChangeTicket,
  type DraftPhaseView,
  type DraftTaskView,
  type ExecutableTaskView,
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
  LOCKED_MAINTENANCE_KEYS,
  MAINTENANCE_STEP_LABELS,
  contractOffConfirm,
  withoutAmendments,
  maintenanceBuilderTask,
  maintenanceStepsDone,
  nextAcceptanceId,
  startingChangeWarning,
  ticketEditProblem,
} from '@/components/staff/projects/maintenance/maintenance-builder-model';
import { MaintenanceBuilder } from '@/components/staff/projects/maintenance/MaintenanceBuilder';
import { forgetTaskSaves } from '@/components/staff/projects/requirements/builder-model';
import { PreviewChangeRoom } from '@/components/staff/preview/LearnerPreview';
import { PublishPanel } from '@/components/staff/projects/PublishPanel';
import { ApiError } from '@/lib/api';
import { expectSignOffJumpLands } from './support/signoff-jump';
import { expectStepLinksLand } from './support/step-links';

/** The ExecutableTaskView `executable-editor.test.tsx` names CODE, copied here. */
const CODE: ExecutableTaskView = {
  taskKey: 'main',
  checkKind: 'code',
  artefactType: 'code',
  owns: ['api/app.py', 'api/db.py'],
  profile: 'baked',
  runs: [
    {
      id: 'api',
      shape: 'run-python-hidden',
      label: 'API tests',
      testPaths: ['tests/'],
      visibleTests: ['tests/test_api.py'],
      learnerTestFiles: [],
      hidden: [{ path: 'test_hidden_api.py', sha256: 'b'.repeat(64), bytes: 120 }],
    },
  ],
  minTests: null,
  coverageKeywords: [],
  solution: [{ path: 'api/app.py', sha256: 'c'.repeat(64), bytes: 300 }],
  mutants: [],
  sandboxBudget: 2,
};

const ticket: ChangeTicket = { id: 'CHG-1', title: 'Shelve by surname', summary: 's', acceptance: [{ id: 'AC-1', line: 'a' }, { id: 'AC-2', line: 'b' }] };

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
const click = async (id: string) => {
  await act(async () => {
    fireEvent.click(byTestId(id));
  });
};

describe('the Maintenance builder model', () => {
  test('has five steps and locks the four fixed keys', () => {
    expect(MAINTENANCE_STEP_LABELS).toEqual(['Brief', 'Ticket', 'Code and runs', 'Change request', 'Criteria']);
    expect(LOCKED_MAINTENANCE_KEYS).toEqual(['correctness_hidden', 'visible_tests', 'code_quality', 'process']);
  });
  test('asks before switching the contract off over a non-empty starting list', () => {
    const two = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, contract: [{ id: 'C1', method: 'GET', path: '/a', change: 'added', why: 'w' }, { id: 'C2', method: 'GET', path: '/b', change: 'added', why: 'w' }] });
    expect(contractOffConfirm(two)).toBe('Switching this off deletes the 2 contract amendments in the starting change request.');
    expect(contractOffConfirm(serialiseChangeRequest(EMPTY_CHANGE_REQUEST))).toBeNull();
    expect(withoutAmendments(two)).toBe(serialiseChangeRequest(EMPTY_CHANGE_REQUEST));
    expect(withoutAmendments('not a record')).toBe('not a record');
  });
  test('refuses a ticket edit that drops an id the starting record covers', () => {
    const covering = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, release: { ...EMPTY_CHANGE_REQUEST.release, changes: [{ id: 'L1', line: 'x', covers: ['AC-2'] }] } });
    expect(ticketEditProblem({ ...ticket, acceptance: [ticket.acceptance[0]] }, covering)).toBe('AC-2 is covered in the starting change request. Remove it there first.');
    expect(ticketEditProblem(ticket, covering)).toBeNull();
  });
  test('mints acceptance ids and warns on a starting record that meets the floor', () => {
    expect(nextAcceptanceId(ticket)).toBe('AC-3');
    expect(nextAcceptanceId({ ...ticket, acceptance: [] })).toBe('AC-1');
    expect(startingChangeWarning(serialiseChangeRequest(EMPTY_CHANGE_REQUEST), { contract: false, ticket, floor: { minImpact: 0, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false } }))
      .toBe('The starting change request already meets the floor, so a learner who changes nothing passes it. Raise the floor or empty the starting record.');
    expect(startingChangeWarning(serialiseChangeRequest(EMPTY_CHANGE_REQUEST), { contract: false, ticket, floor: { minImpact: 1, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false } })).toBeNull();
  });
});

describe('MaintenanceBuilder', () => {
  const floor = { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true };
  const task = {
    taskKey: 'main', title: 'Shelve by surname', brief: 'Make the change.', checkKind: 'code', artefactType: 'code', authorable: false, required: true, objectives: [],
    executable: CODE,
    change: { ticket, contract: true, floor },
    rubric: { passThreshold: 70, criteria: [
      { key: 'correctness_hidden', title: 'h', weight: 0.4 }, { key: 'visible_tests', title: 'v', weight: 0.15 }, { key: 'code_quality', title: 'q', weight: 0.15 },
      { key: 'process', title: 'p', weight: 0.15 }, { key: 'change_request', title: 'c', weight: 0.15 },
    ] },
  } as unknown as DraftTaskView;
  const phase = { key: 'maintenance', title: 'Maintenance', intro: 'One change.', tasks: [task], files: [] } as unknown as DraftPhaseView;
  const props = { projectId: 'p', versionId: 'v', draft: { phases: [phase] } as never, phase, task, editable: true, onSaved: () => {}, onSignOff: () => {} };
  const twoAmendments = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, contract: [{ id: 'C1', method: 'GET', path: '/a', change: 'added', why: 'w' }, { id: 'C2', method: 'GET', path: '/b', change: 'added', why: 'w' }] });
  const startingRow = (content: string) => [{ path: CHANGE_REQUEST_JSON, content, editable: true, ownerKind: 'phase', phaseKey: 'maintenance' }];

  test("takes Maintenance's code task with a change view, and no other", () => {
    expect(maintenanceBuilderTask(phase, true)).toBe(task);
    expect(maintenanceBuilderTask({ ...phase, key: 'implementation' } as DraftPhaseView, true)).toBeNull();
    expect(maintenanceBuilderTask({ ...phase, tasks: [{ ...task, change: undefined }] } as DraftPhaseView, true)).toBeNull();
  });
  test('draws five steps, three steppers and two toggles, and four locked rows', async () => {
    files.mockResolvedValue(startingRow(serialiseChangeRequest(EMPTY_CHANGE_REQUEST)));
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    for (const id of ['tdm-brief', 'tdm-ticket', 'tdm-code', 'tdm-change', 'tdm-criteria']) expect(queryTestId(id), id).not.toBeNull();
    expect(byTestId('tdm-ticket').textContent).toContain('CHG-1');
    for (const id of ['tdm-floor-minImpact', 'tdm-floor-minContract', 'tdm-floor-minTests', 'tdm-floor-requireRelease', 'tdm-floor-traceEveryAcceptance']) expect(queryTestId(id), id).not.toBeNull();
    expect(byTestId('tdm-floor-sentence').textContent).toContain('at least 1 contract amendment');
    expect(byTestId('tdm-readiness').textContent).toBe('5 of 5 steps done');
    expect(maintenanceStepsDone(phase, task, { change: false })).toEqual([true, true, true, true, true]);
    expect(byTestId('tdm-code').textContent).toContain('API tests');
    const removes = [...byTestId('tdm-criteria').querySelectorAll('button')].filter((b) => /Remove/.test(`${b.textContent} ${b.getAttribute('aria-label') ?? ''}`)) as HTMLButtonElement[];
    expect(removes.map((b) => b.disabled)).toEqual([true, true, true, true, false]);
    // Maintenance is scored by the weighted sum: the line gives what its pass needs; a required task's mark is written by the phase's Pass.
    expect(byTestId('tdm-criteria-passmark').textContent).toBe(
      'The change passes only when every check passes and the review finds more than half of the criteria met; the pass mark does not decide that. Passing this phase by hand gives a learner at least the pass mark.',
    );
    expect(queryTestId('change-check')).toBeNull();
  });
  test('switching the contract off over two starting amendments says so before it saves, and the contract stepper greys', async () => {
    files.mockResolvedValue(startingRow(twoAmendments));
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    expect((byTestId('change-amendment-0-path') as HTMLInputElement).value).toBe('/a');
    await click('tdm-contract');
    expect(byTestId('tdm-contract-confirm').textContent).toBe('Switching this off deletes the 2 contract amendments in the starting change request.');
    expect(updateTask).not.toHaveBeenCalled();
    await click('tdm-contract-confirm-yes');
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'maintenance', 'main', { change: { contract: false, floor } });
    expect((byTestId('tdm-floor-minContract') as HTMLInputElement).disabled).toBe(true);
  });
  test('each minimum is the builders\' stepper, and a refused save puts the server\'s switch and floor back on screen', async () => {
    files.mockResolvedValue(startingRow(serialiseChangeRequest(EMPTY_CHANGE_REQUEST)));
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    const card = byTestId('tdm-change');
    expect(card.querySelector('button[aria-label="Fewer tests"]')).not.toBeNull();
    updateTask.mockRejectedValueOnce(new Error('refused'));
    await act(async () => { fireEvent.click(card.querySelector<HTMLButtonElement>('button[aria-label="More tests"]')!); });
    expect(updateTask).toHaveBeenLastCalledWith('p', 'v', 'maintenance', 'main', { change: { contract: true, floor: { ...floor, minTests: 2 } } });
    expect((byTestId('tdm-floor-minTests') as HTMLInputElement).value).toBe('1');
    updateTask.mockRejectedValueOnce(new Error('refused'));
    await click('tdm-contract');
    expect(updateTask).toHaveBeenLastCalledWith('p', 'v', 'maintenance', 'main', { change: { contract: false, floor } });
    expect(byTestId('tdm-contract').getAttribute('aria-checked')).toBe('true');
    expect((byTestId('tdm-floor-minContract') as HTMLInputElement).disabled).toBe(false);
  });
  test('a stepper and a toggle send the floor with the switch as it stands', async () => {
    files.mockResolvedValue(startingRow(serialiseChangeRequest(EMPTY_CHANGE_REQUEST)));
    updateTask.mockResolvedValue({ phase, validation: {} });
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    await act(async () => { fireEvent.change(byTestId('tdm-floor-minTests'), { target: { value: '3' } }); });
    expect(updateTask).toHaveBeenLastCalledWith('p', 'v', 'maintenance', 'main', { change: { contract: true, floor: { ...floor, minTests: 3 } } });
    await click('tdm-floor-requireRelease');
    expect(updateTask).toHaveBeenLastCalledWith('p', 'v', 'maintenance', 'main', { change: { contract: true, floor: { ...floor, minTests: 3, requireRelease: false } } });
  });
  test('a ticket edit that drops a covered acceptance id is refused in words, and nothing is sent', async () => {
    const covering = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, release: { ...EMPTY_CHANGE_REQUEST.release, changes: [{ id: 'L1', line: 'x', covers: ['AC-2'] }] } });
    files.mockResolvedValue(startingRow(covering));
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    await click('tdm-ticket-line-1-remove');
    await click('tdm-ticket-save');
    expect(byTestId('tdm-ticket-status').textContent).toBe('AC-2 is covered in the starting change request. Remove it there first.');
    expect(updateTask).not.toHaveBeenCalled();
  });
  test('"Add a line" mints the next acceptance id, and the ticket save sends the ticket alone', async () => {
    files.mockResolvedValue(startingRow(serialiseChangeRequest(EMPTY_CHANGE_REQUEST)));
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    await click('tdm-ticket-add-line');
    await act(async () => { fireEvent.change(byTestId('tdm-ticket-line-2-text'), { target: { value: 'c' } }); });
    await click('tdm-ticket-save');
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'maintenance', 'main', { ticket: { ...ticket, acceptance: [...ticket.acceptance, { id: 'AC-3', line: 'c' }] } });
  });
  test("an older task's ticket and brief saves carry the change request, so the first save converts it", async () => {
    const older = { ...task, recordOlderFormat: true } as DraftTaskView;
    await act(async () => root.render(<MaintenanceBuilder {...props} phase={{ ...phase, tasks: [older] } as DraftPhaseView} task={older} />));
    expect(byTestId('tdm-older-format').textContent).toBe('This task is in the older format. Saving the brief, the ticket, the change request floor or the criteria converts it.');
    expect(queryTestId('tdm-change-older')).not.toBeNull();
    await act(async () => { fireEvent.change(byTestId('tdm-brief-title'), { target: { value: 'Shelve it' } }); });
    await click('tdm-brief-save');
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'maintenance', 'main', { title: 'Shelve it', change: { contract: true, floor } });
  });
  test("an older task's ticket save carries the change request too, so it converts the task", async () => {
    const older = { ...task, recordOlderFormat: true } as DraftTaskView;
    await act(async () => root.render(<MaintenanceBuilder {...props} phase={{ ...phase, tasks: [older] } as DraftPhaseView} task={older} />));
    await act(async () => { fireEvent.change(byTestId('tdm-ticket-title'), { target: { value: 'Shelve by family name' } }); });
    await click('tdm-ticket-save');
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'maintenance', 'main', { ticket: { ...ticket, title: 'Shelve by family name' }, change: { contract: true, floor } });
  });
  test("the Ticket card takes the server's plain ticket from the save's answer (Task 12)", async () => {
    // The editor's part: the server's answer handed down.
    function Live() {
      const [held, setHeld] = useState<DraftTaskView>(task);
      return (
        <MaintenanceBuilder
          {...props}
          phase={{ ...phase, tasks: [held] } as DraftPhaseView}
          task={held}
          onSaved={(result) => {
            const next = result?.phase?.tasks[0];
            if (next) setHeld(next as DraftTaskView);
          }}
        />
      );
    }
    const plain: ChangeTicket = { ...ticket, title: 'Shelve by surname', acceptance: [{ id: 'AC-1', line: 'Sorted by surname' }, ticket.acceptance[1]] };
    updateTask.mockResolvedValueOnce({ phase: { ...phase, tasks: [{ ...task, change: { ...task.change!, ticket: plain } }] }, validation: {} });
    await act(async () => root.render(<Live />));
    const field = (id: string) => byTestId(id) as HTMLInputElement | HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(field('tdm-ticket-title'), { target: { value: '**Shelve** by surname' } });
      fireEvent.change(field('tdm-ticket-line-0-text'), { target: { value: 'Sorted by _surname_' } });
    });
    await click('tdm-ticket-save');
    expect(updateTask.mock.calls[0][4]).toMatchObject({ ticket: { title: '**Shelve** by surname', acceptance: [{ id: 'AC-1', line: 'Sorted by _surname_' }, ticket.acceptance[1]] } });
    expect(field('tdm-ticket-title').value).toBe('Shelve by surname');
    expect(field('tdm-ticket-line-0-text').value).toBe('Sorted by surname');
  });
  test('"Add a line" stops at 12 acceptance lines', async () => {
    const eleven = { ...ticket, acceptance: Array.from({ length: 11 }, (_, at) => ({ id: `AC-${at + 1}`, line: `line ${at + 1}` })) };
    const full = { ...task, change: { ticket: eleven, contract: true, floor } } as unknown as DraftTaskView;
    await act(async () => root.render(<MaintenanceBuilder {...props} phase={{ ...phase, tasks: [full] } as DraftPhaseView} task={full} />));
    expect((byTestId('tdm-ticket-add-line') as HTMLButtonElement).disabled).toBe(false);
    await click('tdm-ticket-add-line');
    expect((byTestId('tdm-ticket-line-11-text') as HTMLInputElement).value).toBe('');
    expect(byTestId('tdm-ticket-line-11').textContent).toContain('AC-12');
    expect((byTestId('tdm-ticket-add-line') as HTMLButtonElement).disabled).toBe(true);
  });
  test('the ticket heading reads a plain sentence while the id or the title is blank', async () => {
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    expect(byTestId('tdm-ticket-heading').textContent).toBe('Learners read it as CHG-1: Shelve by surname');
    await act(async () => { fireEvent.change(byTestId('tdm-ticket-id'), { target: { value: '' } }); });
    expect(byTestId('tdm-ticket-heading').textContent).toBe('Learners read the ticket by its id and title once both are written.');
    await act(async () => { fireEvent.change(byTestId('tdm-ticket-id'), { target: { value: 'CHG-2' } }); });
    await act(async () => { fireEvent.change(byTestId('tdm-ticket-title'), { target: { value: '  ' } }); });
    expect(byTestId('tdm-ticket-heading').textContent).toBe('Learners read the ticket by its id and title once both are written.');
  });
  test('switching the contract off counts an amendment not yet saved, and the waiting edit goes first, as typed', async () => {
    const told = vi.fn();
    files.mockResolvedValue(startingRow(serialiseChangeRequest(EMPTY_CHANGE_REQUEST)));
    updateTask.mockResolvedValue({ phase, validation: {} });
    replaceFile.mockResolvedValue({ phase, validation: {} });
    await act(async () => root.render(<MaintenanceBuilder {...props} onStartingText={told} />));
    await click('change-amendment-add');
    await click('tdm-contract');
    expect(byTestId('tdm-contract-confirm').textContent).toBe('Switching this off deletes the 1 contract amendment in the starting change request.');
    expect(updateTask).not.toHaveBeenCalled();
    await click('tdm-contract-confirm-yes');
    // The record's edit goes before the switch, with its amendment, while the server's switch is still on; the
    // door's contract-off rewrite then drops it, and the record is read again.
    expect(replaceFile).toHaveBeenCalledTimes(1);
    expect((replaceFile.mock.calls[0][3] as { content: string }).content).toContain('"C1"');
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'maintenance', 'main', { change: { contract: false, floor } });
    expect(replaceFile.mock.invocationCallOrder[0]).toBeLessThan(updateTask.mock.invocationCallOrder[0]);
    expect(files).toHaveBeenCalledTimes(2);
    await act(async () => { await new Promise((done) => setTimeout(done, 700)); });
    expect(replaceFile).toHaveBeenCalledTimes(1);
    expect(String(told.mock.calls.at(-1)?.[0])).not.toContain('"C1"');
  });
  test('a record save in flight when the contract is switched off is answered before the switch goes, and the editor then reads the record the switch leaves', async () => {
    const told = vi.fn();
    let answer: (result: unknown) => void = () => undefined;
    files.mockResolvedValue(startingRow(serialiseChangeRequest(EMPTY_CHANGE_REQUEST)));
    updateTask.mockResolvedValue({ phase, validation: {} });
    replaceFile.mockReturnValueOnce(new Promise((done) => (answer = done)));
    await act(async () => root.render(<MaintenanceBuilder {...props} onStartingText={told} />));
    await click('change-amendment-add');
    // The edit waits out its delay and goes, with its amendment; the answer is held.
    await act(async () => { await new Promise((done) => setTimeout(done, 700)); });
    expect(replaceFile).toHaveBeenCalledTimes(1);
    expect((replaceFile.mock.calls[0][3] as { content: string }).content).toContain('"C1"');
    await click('tdm-contract');
    await click('tdm-contract-confirm-yes');
    expect(updateTask).not.toHaveBeenCalled();
    await act(async () => answer({ phase, validation: {} }));
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'maintenance', 'main', { change: { contract: false, floor } });
    expect(files).toHaveBeenCalledTimes(2);
    expect(String(told.mock.calls.at(-1)?.[0])).not.toContain('"C1"');
  });
  test('a starting-record edit waiting in its debounce when the contract is switched off is sent first, as typed, and a refused switch save leaves the server and the card with that edit and the switch on', async () => {
    let record = serialiseChangeRequest(EMPTY_CHANGE_REQUEST);
    files.mockImplementation(async () => startingRow(record));
    replaceFile.mockImplementation(async (_p: string, _v: string, _k: string, body: { content: string }) => {
      record = body.content;
      return { phase, validation: {} };
    });
    updateTask.mockRejectedValue(new ApiError(400, 'The switch could not be saved.'));
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    await click('change-amendment-add');
    await act(async () => { fireEvent.change(byTestId('change-amendment-0-path'), { target: { value: '/shelves' } }); });
    await click('tdm-contract');
    await click('tdm-contract-confirm-yes');
    await act(async () => { await new Promise((done) => setTimeout(done, 700)); });
    // sent once, before the switch, as typed
    expect(replaceFile).toHaveBeenCalledTimes(1);
    expect(replaceFile.mock.invocationCallOrder[0]).toBeLessThan(updateTask.mock.invocationCallOrder[0]);
    expect(record).toContain('/shelves');
    expect(byTestId('tdm-floor-status').textContent).toBe('The switch could not be saved.');
    // the switch is back on, and the card still shows the edit the server holds
    expect(byTestId('tdm-contract').getAttribute('aria-checked')).toBe('true');
    expect((byTestId('change-amendment-0-path') as HTMLInputElement).value).toBe('/shelves');
  });
  describe('the brief, step 1 alone (the flush handle, no redraw)', () => {
    /** The editor's part: the server's answer handed down, as `applyScenario` does. */
    function Live() {
      const [held, setHeld] = useState<DraftTaskView>(task);
      return (
        <MaintenanceBuilder
          {...props}
          phase={{ ...phase, tasks: [held] } as DraftPhaseView}
          task={held}
          onSaved={(result) => {
            const next = result?.phase?.tasks[0];
            if (next) setHeld(next as DraftTaskView);
          }}
        />
      );
    }
    let server: DraftTaskView;
    /** Holds the answer to the save whose body passes `when`, until `release` is called. */
    let held: { when: (body: Record<string, unknown>) => boolean; release: () => void } | null;
    beforeEach(() => {
      server = task;
      held = null;
      updateTask.mockImplementation(async (_p: string, _v: string, _k: string, _t: string, body: Record<string, unknown>) => {
        if (held?.when(body)) {
          const hold = held;
          held = null;
          await new Promise<void>((done) => (hold.release = done));
        }
        server = {
          ...server,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(typeof body.brief === 'string' ? { brief: body.brief } : {}),
          ...(Array.isArray(body.objectives) ? { objectives: body.objectives } : {}),
        } as DraftTaskView;
        return { phase: { ...phase, tasks: [server] }, validation: {} };
      });
    });
    const sent = (at: number) => updateTask.mock.calls[at][4] as Record<string, unknown>;
    const wait = (ms: number) => act(async () => { await new Promise((done) => setTimeout(done, ms)); });
    /** Step 3 edits everything its editor offers. */
    const editStepThree = async () => {
      await click('tdm-code-edit');
      for (const field of [...byTestId('exec-editor').querySelectorAll('textarea')] as HTMLTextAreaElement[]) {
        await act(async () => { fireEvent.change(field, { target: { value: `${field.value}\nedited/` } }); });
      }
    };

    test('a brief saved from step 1 is not reverted by a later save of step 3', async () => {
      await act(async () => root.render(<Live />));
      await act(async () => { fireEvent.change(byTestId('tdm-brief-text'), { target: { value: 'Brief from step 1.' } }); });
      await click('tdm-brief-save');
      expect(sent(0)).toEqual({ brief: 'Brief from step 1.' });
      await editStepThree();
      await click('exec-save');
      await wait(0);
      expect(sent(1)).toHaveProperty('runs');
      expect(sent(1)).not.toHaveProperty('brief');
      expect(server.brief).toBe('Brief from step 1.');
      expect((byTestId('tdm-brief-text') as HTMLTextAreaElement).value).toBe('Brief from step 1.');
    });
    test('a step-1 title edit still waiting when step 3 saves goes first, and both are kept, on the server and in the card', async () => {
      await act(async () => root.render(<Live />));
      await editStepThree();
      await act(async () => { fireEvent.change(byTestId('tdm-brief-title'), { target: { value: 'Shelve it' } }); });
      // Pressing step 3's Save is what takes focus out of step 1, so step 1's save is still waiting out its delay.
      await act(async () => { fireEvent.focusOut(byTestId('tdm-brief-title'), { relatedTarget: byTestId('exec-save') }); });
      await click('exec-save');
      await wait(700);
      expect(updateTask.mock.calls.map(([, , , , body]) => Object.keys(body))).toEqual([['title'], ['runs']]);
      expect(server.title).toBe('Shelve it');
      expect((byTestId('tdm-brief-title') as HTMLInputElement).value).toBe('Shelve it');
    });
    test('a step-1 objectives edit waiting while step 1\'s save is out is sent before step 3\'s save, and the card shows the server\'s objectives at step 3\'s answer', async () => {
      await act(async () => root.render(<Live />));
      held = { when: (body) => 'title' in body, release: () => undefined };
      const hold = held;
      await act(async () => { fireEvent.change(byTestId('tdm-brief-title'), { target: { value: 'Shelve it' } }); });
      await click('tdm-brief-save');
      expect(sent(0)).toEqual({ title: 'Shelve it' });
      await act(async () => { fireEvent.change(byTestId('tdm-brief-objectives'), { target: { value: 'Learn the probe' } }); });
      await editStepThree();
      await click('exec-save');
      await act(async () => hold.release());
      await wait(0);
      expect(updateTask.mock.calls.map(([, , , , body]) => Object.keys(body))).toEqual([['title'], ['objectives'], ['runs']]);
      expect(server.objectives).toEqual(['Learn the probe']);
      expect((byTestId('tdm-brief-objectives') as HTMLTextAreaElement).value).toBe('Learn the probe');
      expect((byTestId('tdm-brief-title') as HTMLInputElement).value).toBe('Shelve it');
    });
    test('a step-1 title typed while step 3\'s save is out stays on the card and is sent once step 3 is answered', async () => {
      await act(async () => root.render(<Live />));
      held = { when: (body) => 'runs' in body, release: () => undefined };
      const hold = held;
      await editStepThree();
      await click('exec-save');
      expect(updateTask).toHaveBeenCalledTimes(1);
      await act(async () => { fireEvent.change(byTestId('tdm-brief-title'), { target: { value: 'Shelve it' } }); });
      await click('tdm-brief-save');
      // the words wait in the one queue behind step 3
      expect(updateTask).toHaveBeenCalledTimes(1);
      // The title save's answer is held too, so the card is read at step 3's answer alone: a redraw would show the old title.
      held = { when: (body) => 'title' in body, release: () => undefined };
      const second = held;
      await act(async () => hold.release());
      await wait(0);
      expect((byTestId('tdm-brief-title') as HTMLInputElement).value).toBe('Shelve it');
      await act(async () => second.release());
      await wait(0);
      expect(updateTask.mock.calls.map(([, , , , body]) => Object.keys(body))).toEqual([['runs'], ['title']]);
      expect(server.title).toBe('Shelve it');
      expect((byTestId('tdm-brief-title') as HTMLInputElement).value).toBe('Shelve it');
    });
    test('a step-1 edit the card\'s own check stops stays on the card with its sentence when step 3 saves', async () => {
      await act(async () => root.render(<Live />));
      await act(async () => { fireEvent.change(byTestId('tdm-brief-title'), { target: { value: '' } }); });
      await act(async () => { fireEvent.change(byTestId('tdm-brief-objectives'), { target: { value: 'Learn the probe' } }); });
      await editStepThree();
      await click('exec-save');
      await wait(0);
      expect(updateTask.mock.calls.map(([, , , , body]) => Object.keys(body))).toEqual([['runs']]);
      expect(byTestId('tdm-brief-status').textContent).toBe('Give the task a title before you save it.');
      expect((byTestId('tdm-brief-title') as HTMLInputElement).value).toBe('');
      expect((byTestId('tdm-brief-objectives') as HTMLTextAreaElement).value).toBe('Learn the probe');
    });
    test('a refused title save is sent again on the next Save press, so the card and the server agree', async () => {
      updateTask.mockImplementationOnce(async () => { throw new Error('refused'); });
      await act(async () => root.render(<Live />));
      await act(async () => { fireEvent.change(byTestId('tdm-brief-title'), { target: { value: 'Shelve it' } }); });
      await click('tdm-brief-save');
      expect(sent(0)).toEqual({ title: 'Shelve it' });
      expect(server.title).toBe(task.title);
      await click('tdm-brief-save');
      expect(sent(1)).toEqual({ title: 'Shelve it' });
      expect(server.title).toBe('Shelve it');
    });
    test('a step-1 title edit still waiting when step 3\'s save is refused is saved first, and the card keeps it and says the refusal', async () => {
      const saving = updateTask.getMockImplementation()!;
      updateTask.mockImplementation(async (...args: Parameters<typeof saving>) => {
        if ('runs' in args[4]) throw new Error('The runs could not be saved.');
        return saving(...args);
      });
      await act(async () => root.render(<Live />));
      await editStepThree();
      await act(async () => { fireEvent.change(byTestId('tdm-brief-title'), { target: { value: 'Shelve it' } }); });
      await act(async () => { fireEvent.focusOut(byTestId('tdm-brief-title'), { relatedTarget: byTestId('exec-save') }); });
      await click('exec-save');
      await wait(700);
      expect(updateTask.mock.calls.map(([, , , , body]) => Object.keys(body))).toEqual([['title'], ['runs']]);
      expect(server.title).toBe('Shelve it');
      expect(server.brief).toBe(task.brief);
      expect(queryTestId('exec-editor')?.textContent).toContain('That change could not be saved.');
      expect((byTestId('tdm-brief-title') as HTMLInputElement).value).toBe('Shelve it');
      expect((byTestId('tdm-brief-text') as HTMLTextAreaElement).value).toBe(task.brief);
    });
  });
  test('the builder draws no refused-conversion line: the editor says it above the generic panels', async () => {
    await act(async () => root.render(<MaintenanceBuilder {...props} task={{ ...task, recordConversionRefused: 'This Maintenance task cannot be converted.' } as DraftTaskView} />));
    expect(queryTestId('tdm-conversion-refused')).toBeNull();
    expect(host.textContent).not.toContain('This Maintenance task cannot be converted.');
  });
  test("Start empty and Reset to the pack's are off while a record save is out", async () => {
    let answer: (result: unknown) => void = () => undefined;
    files.mockResolvedValue(startingRow(serialiseChangeRequest(EMPTY_CHANGE_REQUEST)));
    replaceFile.mockReturnValueOnce(new Promise((done) => (answer = done)));
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    expect((byTestId('tdm-start-empty') as HTMLButtonElement).disabled).toBe(false);
    await click('change-amendment-add');
    await act(async () => { await new Promise((done) => setTimeout(done, 700)); });
    expect(replaceFile).toHaveBeenCalledTimes(1);
    expect((byTestId('tdm-start-empty') as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId('tdm-reset-source') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer({ phase, validation: {} }));
    expect((byTestId('tdm-start-empty') as HTMLButtonElement).disabled).toBe(false);
    expect((byTestId('tdm-reset-source') as HTMLButtonElement).disabled).toBe(false);
  });
  test("Start empty and Reset to the pack's ask first; a refusal is said in the door's words and the forms stay on the server's record", async () => {
    files.mockResolvedValue(startingRow(twoAmendments));
    replaceFile.mockRejectedValue(new ApiError(400, noSourceRecordRefusal(CHANGE_REQUEST_JSON)));
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    await click('tdm-start-empty');
    expect(replaceFile).not.toHaveBeenCalled();
    expect(byTestId('tdm-start-confirm-line').textContent).toContain('replaces the starting change request with an empty one');
    await click('tdm-start-keep');
    expect(queryTestId('tdm-start-confirm')).toBeNull();
    await click('tdm-start-empty');
    await click('tdm-start-confirm');
    expect(replaceFile).toHaveBeenCalledWith('p', 'v', 'maintenance', { path: CHANGE_REQUEST_JSON, content: serialiseChangeRequest(EMPTY_CHANGE_REQUEST) });
    expect((byTestId('change-amendment-0-path') as HTMLInputElement).value).toBe('/a');
    await click('tdm-reset-source');
    expect(byTestId('tdm-start-confirm-line').textContent).toBe("If this draft was opened from a version, this puts back that version's starting change request, and your changes to it are lost.");
    await click('tdm-start-confirm');
    expect(replaceFile).toHaveBeenLastCalledWith('p', 'v', 'maintenance', { path: CHANGE_REQUEST_JSON, reset: 'source' });
    expect(byTestId('tdm-change-error').textContent).toBe(noSourceRecordRefusal(CHANGE_REQUEST_JSON));
  });
  test('reads the files again once the converting save lands, with a reading line until the converted record arrives', async () => {
    const older = { ...task, recordOlderFormat: true } as DraftTaskView;
    let arrive: (rows: unknown) => void = () => undefined;
    files.mockResolvedValueOnce([]).mockReturnValueOnce(new Promise((done) => (arrive = done)));
    await act(async () => root.render(<MaintenanceBuilder {...props} phase={{ ...phase, tasks: [older] } as DraftPhaseView} task={older} />));
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    expect(files).toHaveBeenCalledTimes(2);
    expect(byTestId('tdm-change-reading').textContent).toBe('Reading the starting change request.');
    await act(async () => arrive(startingRow(twoAmendments)));
    expect((byTestId('change-amendment-1-path') as HTMLInputElement).value).toBe('/b');
  });
  test('Preview as a learner draws the ticket and the forms read-only over the starting record, and the empty one when none ships', () => {
    const preview = { key: 'maintenance', files: [{ path: CHANGE_REQUEST_JSON, content: twoAmendments, editable: true }], change: { ticket, contract: true, floor } } as unknown as LearnerPreviewPhase;
    render(<PreviewChangeRoom phase={preview} />);
    expect(byTestId('change-ticket').textContent).toContain('CHG-1');
    expect((byTestId('change-amendment-0-path') as HTMLInputElement).value).toBe('/a');
    expect((byTestId('change-amendment-0-path') as HTMLInputElement).readOnly).toBe(true);
    expect(host.querySelectorAll('button, form').length).toBe(0);
    render(<PreviewChangeRoom phase={{ ...preview, files: [] } as LearnerPreviewPhase} />);
    expect(queryTestId('change-amendment-0-path')).toBeNull();
    expect(queryTestId('change-release')).not.toBeNull();
  });
  // Each link of the row of steps goes to its own card.
  test('each step link of the row names its own card, in the order of the cards', async () => {
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    expect(expectStepLinksLand(host)).toEqual(['Brief', 'Ticket', 'Code and runs', 'Change request', 'Criteria']);
  });
  // The Change request card's box is at the very end of a long card; the row's Sign-off entry goes to it.
  test('the Sign-off entry after the five steps brings the Change request box into view and focuses it, never ticking it', async () => {
    await act(async () => root.render(<MaintenanceBuilder {...props} />));
    await expectSignOffJumpLands(host, 'main', 'tdm-change');
    expect(updateTask).not.toHaveBeenCalled();
    await act(async () => root.render(<MaintenanceBuilder {...props} task={{ ...task, signOff: true } as DraftTaskView} />));
    await expectSignOffJumpLands(host, 'main', 'tdm-change');
    expect((document.getElementById('task-signoff-main') as HTMLInputElement).checked).toBe(true);
    expect(updateTask).not.toHaveBeenCalled();
  });
  test('a version that cannot change draws no box, so no Sign-off entry', async () => {
    await act(async () => root.render(<MaintenanceBuilder {...props} editable={false} />));
    expect(queryTestId('tre-steps')).not.toBeNull();
    expect(queryTestId('tre-signoff-jump')).toBeNull();
    expect(document.getElementById('task-signoff-main')).toBeNull();
  });
});

describe('the publish warning', () => {
  test('a starting change request that meets the floor is said above Publish beside the runbook warning, and Publish stays enabled', () => {
    const warning = startingChangeWarning(serialiseChangeRequest(EMPTY_CHANGE_REQUEST), { contract: false, ticket, floor: { minImpact: 0, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false } });
    const runbook = 'The starting runbook already meets the floor, so a learner who changes nothing passes it. Raise the floor or empty the starting record.';
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
        warnings={[runbook, warning as string]}
      />,
    );
    const warnings = byTestId('project-publish-warnings');
    const publish = byTestId('project-publish') as HTMLButtonElement;
    expect(warnings.textContent).toContain(runbook);
    expect(warnings.textContent).toContain(warning as string);
    expect(warnings.compareDocumentPosition(publish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(publish.disabled).toBe(false);
  });
});
