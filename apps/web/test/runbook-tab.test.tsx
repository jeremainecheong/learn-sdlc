// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, screen } from '@testing-library/dom';
import { afterEach, describe, expect, test } from 'vitest';
import { EMPTY_RUNBOOK, RUNBOOK_INCIDENT_FROM_DRILL, RUNBOOK_JSON, RUNBOOK_OLDER_FORMAT_ROOM, serialiseRunbook, validateRunbookRecord, type PhaseDetail, type Runbook } from '@learnsdlc/shared';
import { addRunbookItem, changedRunbookFields, listFull, liveRunbookMarks, moveRollback, readRunbookText, setRunbookField, touchedRunbook } from '@/components/workspace/panels/deployment/runbook-edit';
import { RUNBOOK_INCIDENT_WRITTEN, RunbookTab } from '@/components/workspace/panels/deployment/RunbookTab';
import { resolveAndReload, resolvedSentence } from '@/components/workspace/panels/deployment/drill';
import { isRoomRecordPath, olderRecordSentence } from '@/components/workspace/records';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(node: ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(node)); }
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null; });

const floor = { minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: true };
const detail = (over: Partial<PhaseDetail> = {}) => ({ key: 'deployment', artifactKind: 'config', runbook: { floor, drill: true }, files: [], ...over }) as unknown as PhaseDetail;
const one: Runbook = { ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'where /api goes', kind: 'config' }], rollback: [{ id: 'R1', step: 'a', verify: 'x' }, { id: 'R2', step: 'b', verify: 'y' }] };

/** The tab over a held record, as the IDE holds it in its buffers. */
function Held({ start, drill = true }: { start: string; drill?: boolean }) {
  const [text, setText] = useState(start);
  return <><RunbookTab detail={detail({ runbook: { floor, drill } })} text={text} onChange={setText} editable drillHref="/workspace/p/drill" /><output data-testid="held">{text}</output></>;
}

describe('runbook-edit', () => {
  test('adds with the next free id and stops at the cap', () => {
    expect(addRunbookItem(one, 'environment').environment[1]).toEqual({ id: 'E2', name: '', purpose: '', kind: 'config' });
    let full = EMPTY_RUNBOOK;
    for (let i = 0; i < 20; i += 1) full = addRunbookItem(full, 'health');
    expect(listFull(full, 'health')).toBe(true);
    expect(addRunbookItem(full, 'health')).toBe(full);
  });
  test('moves a rollback step and holds a field to 2000 characters', () => {
    expect(moveRollback(one, 1, -1).rollback.map((s) => s.id)).toEqual(['R2', 'R1']);
    expect(moveRollback(one, 0, -1)).toBe(one);
    expect(setRunbookField(one, 'environment', 0, 'purpose', 'p'.repeat(2500)).environment[0].purpose).toHaveLength(2000);
  });
  test('reads an unreadable record as the empty one, with its error', () => {
    expect(readRunbookText('{ torn')).toEqual({ runbook: EMPTY_RUNBOOK, error: 'The runbook record is not valid JSON' });
  });
  test('marks the fields a change set touched, by item id', () => {
    const after = serialiseRunbook({ ...one, environment: [...one.environment, { id: 'E2', name: 'PORT', purpose: 'p', kind: 'config' }] });
    const changes = [{ path: 'runbook/env-2/name', after: 'E2: PORT' }, { path: 'runbook/env-2/purpose', after: 'p' }];
    expect([...changedRunbookFields(serialiseRunbook(one), changes)]).toEqual(['environment:E2:name', 'environment:E2:purpose']);
    expect(validateRunbookRecord(after).error).toBeNull();
  });
  test('keeps a mark only while the field still holds the text the assistant applied', () => {
    const applied = serialiseRunbook({ ...one, environment: [{ ...one.environment[0], purpose: 'where web sends /api' }] });
    const touched = touchedRunbook(serialiseRunbook(one), [{ path: 'runbook/env-1/purpose', before: 'where /api goes', after: 'where web sends /api' }], applied);
    expect(touched).toEqual({ 'environment:E1:purpose': 'where web sends /api' });
    expect([...liveRunbookMarks(touched, applied)]).toEqual(['environment:E1:purpose']);
    const edited = serialiseRunbook({ ...one, environment: [{ ...one.environment[0], purpose: 'mine now' }] });
    expect([...liveRunbookMarks(touched, edited)]).toEqual([]);
  });
  test('marks the kind, the incident, its timeline and Notes too', () => {
    const applied = serialiseRunbook({ ...one, environment: [{ ...one.environment[0], kind: 'secret' }], incident: { rootCause: 'disk full', fix: 'f', actionItem: 'a', timeline: [{ at: '01:00', event: 'paged' }] }, notes: 'see the wiki' });
    const changes = [
      { path: 'runbook/env-1/kind', before: 'config', after: 'secret' }, { path: 'runbook/incident/root-cause', before: '', after: 'disk full' },
      { path: 'runbook/incident/timeline', before: '', after: '01:00 paged' }, { path: 'runbook/notes', before: '', after: 'see the wiki' },
    ];
    const touched = touchedRunbook(serialiseRunbook(one), changes, applied);
    expect(touched).toEqual({ 'environment:E1:kind': 'secret', 'incident:rootCause': 'disk full', 'incident:timeline': '01:00 paged', notes: 'see the wiki' });
    render(<RunbookTab detail={detail({ runbook: { floor, drill: false } })} text={applied} onChange={() => undefined} editable assisted={liveRunbookMarks(touched, applied)} />);
    for (const id of ['runbook-environment-0-kind-assisted', 'runbook-incident-rootCause-assisted', 'runbook-timeline-assisted', 'runbook-notes-assisted']) {
      expect(screen.getByTestId(id).textContent).toBe('changed by the assistant');
    }
    expect(screen.queryByTestId('runbook-incident-fix-assisted')).toBeNull();
  });
  test('marks a rollback the assistant only reordered, until the learner moves a step again', () => {
    const applied = serialiseRunbook(moveRollback(one, 1, -1));
    const touched = touchedRunbook(serialiseRunbook(one), [{ path: 'runbook/rollback/order', before: 'R1, R2', after: 'R2, R1' }], applied);
    expect(touched).toEqual({ 'rollback:order': 'R2, R1' });
    render(<RunbookTab detail={detail({ runbook: { floor, drill: false } })} text={applied} onChange={() => undefined} editable assisted={liveRunbookMarks(touched, applied)} />);
    expect(screen.getByTestId('runbook-rollback-order-assisted').textContent).toBe('changed by the assistant');
    expect(screen.queryByTestId('runbook-rollback-0-step-assisted')).toBeNull();
    expect([...liveRunbookMarks(touched, serialiseRunbook(one))]).toEqual([]);
  });
});

describe('the IDE\'s drill resolve', () => {
  test('reloads after the drill answers, so the IDE adopts the new save stamp and the record\'s incident', async () => {
    const order: string[] = [];
    const state = await resolveAndReload(async () => { order.push('resolve'); return { workspaceUpdatedAt: 't2' }; }, async () => { order.push('reload'); });
    expect(order).toEqual(['resolve', 'reload']);
    expect(state).toEqual({ workspaceUpdatedAt: 't2' });
  });
  test('says what the drill page says once the incident is closed', () => {
    expect(resolvedSentence(true)).toBe('Closed. The incident is in your runbook.');
    expect(resolvedSentence(false)).toBe('INCIDENT-1 resolved.');
  });
});

describe('the older format', () => {
  test('draws the older-format notice for a Deployment of the config kind with no runbook', () => {
    render(<RunbookTab detail={detail({ runbook: undefined })} text="" onChange={() => undefined} editable />);
    expect(screen.getByTestId('runbook-older-format').textContent).toBe(RUNBOOK_OLDER_FORMAT_ROOM);
    expect(screen.queryByTestId('runbook-tab')).toBeNull();
  });
});

describe('records', () => {
  test('names the two record paths and the older-format sentences', () => {
    expect(isRoomRecordPath(RUNBOOK_JSON)).toBe(true);
    expect(isRoomRecordPath('api/Dockerfile')).toBe(false);
    expect(olderRecordSentence(detail({ runbook: undefined }))).toBe(RUNBOOK_OLDER_FORMAT_ROOM);
    expect(olderRecordSentence(detail())).toBeNull();
    expect(olderRecordSentence({ key: 'deployment', artifactKind: 'tests' } as never)).toBeNull();
  });
});

describe('RunbookTab', () => {
  test('draws the five sections and Notes, and writes the record through the forms', () => {
    render(<Held start={serialiseRunbook(one)} />);
    for (const id of ['environment', 'health', 'rollback', 'data', 'incident', 'notes']) expect(screen.getByTestId(`runbook-section-${id}`)).toBeTruthy();
    act(() => { fireEvent.click(screen.getByTestId('runbook-add-health')); });
    act(() => { fireEvent.input(screen.getByTestId('runbook-health-0-how'), { target: { value: 'python3 api/main.py --selfcheck' } }); });
    expect(validateRunbookRecord(screen.getByTestId('held').textContent!).runbook!.health[0]).toMatchObject({ id: 'H1', how: 'python3 api/main.py --selfcheck' });
  });
  test('holds every field and list at its cap', () => {
    render(<Held start={serialiseRunbook(one)} />);
    expect((screen.getByTestId('runbook-environment-0-purpose') as HTMLTextAreaElement).maxLength).toBe(2000);
    let full = EMPTY_RUNBOOK;
    for (let i = 0; i < 20; i += 1) full = addRunbookItem(full, 'data');
    // A new key: Held keeps its text in state, so the full record is a fresh mount, not a new prop.
    act(() => root!.render(<Held key="full" start={serialiseRunbook(full)} />));
    expect((screen.getByTestId('runbook-add-data') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('runbook-full-data').textContent).toBe('Data holds its 20 entries. Remove one to add another.');
  });
  test('shows the drill phase\'s incident read-only, with the line and the link', () => {
    render(<Held start={serialiseRunbook({ ...one, incident: { rootCause: 'API_URL', fix: 'f', actionItem: 'a' } })} />);
    // The incident is written when the drill is resolved, from the workspace's Pipeline tab or the drill
    // page alike, so the line names neither; the link looks like a link.
    expect(screen.getByTestId('runbook-incident-from-drill').textContent).toContain(RUNBOOK_INCIDENT_WRITTEN);
    expect(screen.getByTestId('runbook-incident-from-drill').textContent).not.toContain(RUNBOOK_INCIDENT_FROM_DRILL);
    expect((screen.getByTestId('runbook-incident-rootCause') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByTestId('runbook-open-drill').getAttribute('href')).toBe('/workspace/p/drill');
    expect(screen.getByTestId('runbook-open-drill').textContent).toBe('Open the incident drill');
    expect(screen.getByTestId('runbook-open-drill').className).toContain('underline');
  });
  test('lets a phase with no drill write the incident', () => {
    render(<Held start={serialiseRunbook(one)} drill={false} />);
    act(() => { fireEvent.input(screen.getByTestId('runbook-incident-rootCause'), { target: { value: 'disk full' } }); });
    expect(validateRunbookRecord(screen.getByTestId('held').textContent!).runbook!.incident.rootCause).toBe('disk full');
  });
  test('a phase with no drill: each timeline line has its own labels and a Remove that drops only that line', () => {
    const lines = serialiseRunbook({ ...one, incident: { ...one.incident, timeline: [{ at: '01:00', event: 'paged' }, { at: '01:10', event: 'rolled back' }] } });
    render(<Held start={lines} drill={false} />);
    expect(screen.getByLabelText('When, line 1')).toBeTruthy();
    expect(screen.getByLabelText('What happened, line 2')).toBeTruthy();
    const labels = Array.from(host!.querySelectorAll('[data-testid^="runbook-incident-timeline-"] input')).map((input) => input.getAttribute('aria-label'));
    expect(new Set(labels).size).toBe(labels.length);
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Remove timeline line 1' })); });
    expect(validateRunbookRecord(screen.getByTestId('held').textContent!).runbook!.incident.timeline).toEqual([{ at: '01:10', event: 'rolled back' }]);
    expect(screen.queryByTestId('runbook-incident-timeline-1')).toBeNull();
  });
  test('opens an unreadable stored runbook on read-only empty forms, and only a confirmed Start empty replaces it', () => {
    const stored = '{ torn';
    render(<Held start={stored} drill={false} />);
    expect(screen.getByTestId('runbook-unreadable').textContent).toContain('The runbook cannot be read (the runbook record ');
    // typing never silently replaces the stored record: every form is read-only and nothing adds
    expect((screen.getByTestId('runbook-notes') as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByTestId('runbook-incident-rootCause') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByTestId('runbook-add-environment')).toBeNull();
    expect(screen.queryByTestId('runbook-add-timeline')).toBeNull();
    act(() => { fireEvent.input(screen.getByTestId('runbook-notes'), { target: { value: 'typed over' } }); });
    expect(screen.getByTestId('held').textContent).toBe(stored);
    // Start empty asks first, and Keep it leaves the stored record alone
    act(() => { fireEvent.click(screen.getByTestId('runbook-start-empty')); });
    expect(screen.getByTestId('runbook-start-empty-line').textContent).toContain('This replaces the stored runbook with an empty one');
    expect(screen.getByTestId('held').textContent).toBe(stored);
    act(() => { fireEvent.click(screen.getByTestId('runbook-start-empty-keep')); });
    expect(screen.queryByTestId('runbook-start-empty-line')).toBeNull();
    expect(screen.getByTestId('held').textContent).toBe(stored);
    act(() => { fireEvent.click(screen.getByTestId('runbook-start-empty')); });
    act(() => { fireEvent.click(screen.getByTestId('runbook-start-empty-confirm')); });
    expect(screen.getByTestId('held').textContent).toBe(serialiseRunbook(EMPTY_RUNBOOK));
    // the empty record reads, so the forms are writable again
    expect(screen.queryByTestId('runbook-unreadable')).toBeNull();
    expect((screen.getByTestId('runbook-notes') as HTMLTextAreaElement).readOnly).toBe(false);
  });
  test('a read-only tab over an unreadable record offers no Start empty', () => {
    render(<RunbookTab detail={detail()} text="{ torn" onChange={() => undefined} editable={false} />);
    expect(screen.getByTestId('runbook-unreadable')).toBeTruthy();
    expect(screen.queryByTestId('runbook-start-empty')).toBeNull();
  });
  test('lists the floor in words', () => {
    render(<Held start={serialiseRunbook(one)} />);
    act(() => { fireEvent.click(screen.getByTestId('runbook-check')); });
    expect(screen.getByTestId('runbook-check-runbook.health.min').textContent).toContain('Fewer than 1 health check');
  });
  test('a marked field loses its "changed by the assistant" chip once the learner types in it', () => {
    const touched = { 'environment:E1:purpose': 'where /api goes' };
    function Marked() {
      const [text, setText] = useState(serialiseRunbook(one));
      return <RunbookTab detail={detail()} text={text} onChange={setText} editable assisted={liveRunbookMarks(touched, text)} drillHref="/workspace/p/drill" />;
    }
    render(<Marked />);
    expect(screen.getByTestId('runbook-environment-0-purpose-assisted').textContent).toBe('changed by the assistant');
    act(() => { fireEvent.input(screen.getByTestId('runbook-environment-0-purpose'), { target: { value: 'where web sends /api' } }); });
    expect(screen.queryByTestId('runbook-environment-0-purpose-assisted')).toBeNull();
  });
  test('a read-only tab draws no button at all, Check the runbook included', () => {
    render(<RunbookTab detail={detail()} text={serialiseRunbook(one)} onChange={() => undefined} editable={false} />);
    expect(screen.queryByTestId('runbook-check')).toBeNull();
    expect(screen.queryByTestId('runbook-checks')).toBeNull();
    expect(screen.getByTestId('runbook-tab').querySelector('button')).toBeNull();
  });
  test('names Notes for a reader on the empty record, and the rollback field asks how to verify', () => {
    render(<RunbookTab detail={detail()} text={serialiseRunbook(EMPTY_RUNBOOK)} onChange={() => undefined} editable />);
    const notes = screen.getByTestId('runbook-notes');
    expect(notes.getAttribute('aria-label')).toBe('Notes');
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBe(notes);
    act(() => root!.render(<RunbookTab detail={detail()} text={serialiseRunbook(one)} onChange={() => undefined} editable />));
    expect(screen.getAllByRole('textbox', { name: 'How to verify' })).toHaveLength(2);
    expect(screen.queryAllByRole('textbox', { name: /^check\b/i })).toHaveLength(0);
  });
  test('draws the drill line without a link when no drill page is given (the builder)', () => {
    render(<RunbookTab detail={detail()} text={serialiseRunbook(one)} onChange={() => undefined} editable />);
    expect(screen.getByTestId('runbook-incident-from-drill').textContent).toBe(`${RUNBOOK_INCIDENT_WRITTEN} `);
    expect(screen.queryByTestId('runbook-open-drill')).toBeNull();
  });
});
