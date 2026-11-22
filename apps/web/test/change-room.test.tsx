// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, screen } from '@testing-library/dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CHANGE_OLDER_FORMAT_ROOM, EMPTY_CHANGE_REQUEST, serialiseChangeRequest, type ChangeRequest, type PhaseDetail } from '@learnsdlc/shared';
import {
  addAmendment, addImpact, addTest, changeOperation, changeSignature, changeTarget, changedChangeFields, liveChangeMarks, readChangeText, setItemField, toggleCover, touchedChange,
} from '@/components/workspace/panels/maintenance/change-edit';
import { ChangeFloorCheck, ChangeRoomOlderNotice, RequestForm, TestsForm } from '@/components/workspace/panels/maintenance/ChangeForms';
import { phaseDocHref, roomHref } from '@/components/shell/routes';
import { olderRecordSentence } from '@/components/workspace/records';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(node: ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(node)); }
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null; });

const ticket = { id: 'CHG-1', title: 'Shelve by surname', summary: 'The library has asked for the shelf to follow surname order.', acceptance: [{ id: 'AC-1', line: 'Order by surname' }, { id: 'AC-2', line: 'The page agrees' }, { id: 'AC-3', line: 'Lending unchanged' }] };

describe('change-edit', () => {
  test('adds impact chips once each, trimmed, and stops at 20', () => {
    let change: ChangeRequest = EMPTY_CHANGE_REQUEST;
    change = addImpact(change, 'files', ' api/shelf.py ');
    expect(addImpact(change, 'files', 'api/shelf.py')).toBe(change);
    expect(change.impact.files).toEqual(['api/shelf.py']);
    for (let i = 0; i < 25; i += 1) change = addImpact(change, 'operations', `op${i}`);
    expect(change.impact.operations).toHaveLength(20);
  });
  test('covers at most 12 ids, toggled', () => {
    let change = addTest(EMPTY_CHANGE_REQUEST);
    change = toggleCover(change, 'tests', 0, 'AC-2');
    expect(change.tests[0]).toEqual({ id: 'T1', suite: '', covers: ['AC-2'], result: 'not-run' });
    expect(toggleCover(change, 'tests', 0, 'AC-2').tests[0].covers).toEqual([]);
    // the edit does not check ids against a ticket: thirteen toggled on hold twelve
    let many = addTest(EMPTY_CHANGE_REQUEST);
    for (let i = 1; i <= 13; i += 1) many = toggleCover(many, 'tests', 0, `AC-${i}`);
    expect(many.tests[0].covers).toHaveLength(12);
  });
  test('holds a field at 2000 characters and a method at 16', () => {
    const one = addAmendment(EMPTY_CHANGE_REQUEST);
    expect(setItemField(one, 'contract', 0, 'why', 'x'.repeat(2100)).contract[0].why).toHaveLength(2000);
    expect(setItemField(one, 'contract', 0, 'method', 'M'.repeat(20)).contract[0].method).toHaveLength(16);
  });
  test('marks the fields a change set touched, by item id, and keeps a mark only while the field holds the applied text', () => {
    const before = serialiseChangeRequest(toggleCover(addTest(EMPTY_CHANGE_REQUEST), 'tests', 0, 'AC-1'));
    const changes = [{ path: 'change/test-1/covers', before: 'AC-1', after: 'AC-1, AC-2' }, { path: 'change/release/version', after: '2.1.0' }, { path: 'change/impact/files', after: 'api/x.py' }];
    expect([...changedChangeFields(before, changes)]).toEqual(['tests:T1:covers', 'release:version', 'impact:files']);
    const applied = serialiseChangeRequest({ ...toggleCover(toggleCover(addTest(EMPTY_CHANGE_REQUEST), 'tests', 0, 'AC-1'), 'tests', 0, 'AC-2'), impact: { operations: [], screens: [], files: ['api/x.py'] }, release: { ...EMPTY_CHANGE_REQUEST.release, version: '2.1.0' } });
    const touched = touchedChange(before, changes, applied);
    expect([...liveChangeMarks(touched, applied)].sort()).toEqual(['impact:files', 'release:version', 'tests:T1:covers']);
    const edited = JSON.parse(applied);
    edited.release.version = '2.2.0';
    expect([...liveChangeMarks(touched, JSON.stringify(edited))].sort()).toEqual(['impact:files', 'tests:T1:covers']);
  });
  test('names the signature and the target as spec 5.3 reads them', () => {
    const change: ChangeRequest = { ...EMPTY_CHANGE_REQUEST, impact: { operations: ['shelfOrder'], screens: [], files: ['README', 'api/shelf.py'] }, contract: [{ id: 'C1', method: 'GET', path: '/api/books', change: 'changed', why: 'w' }, { id: 'C2', method: 'GET', path: '/api/shelf', change: 'added', why: 'w' }] };
    expect(changeSignature(change)).toBe('/api/shelf');
    expect(changeSignature({ ...change, contract: [] })).toBe('shelfOrder');
    expect(changeSignature(EMPTY_CHANGE_REQUEST)).toBeNull();
    // The operation the Contract card claims and adds is the impact's first operation, never the amendment path.
    expect(changeOperation(change)).toBe('shelfOrder');
    expect(changeOperation(EMPTY_CHANGE_REQUEST)).toBeNull();
    expect(changeTarget(change, ['api/shelf.py', 'web/src/lib/shelf.ts'])).toBe('api/shelf.py');
  });
  test('reads an unreadable record as the empty one, with its error', () => {
    expect(readChangeText('{', ['AC-1']).error).toBe('The change request record is not valid JSON');
  });
});

describe('the change room is every code Maintenance\'s', () => {
  const phase = (over: object) => ({ id: 'p6', key: 'maintenance', status: 'in_progress', artifactKind: 'code', provenance: { application: null }, ...over }) as never;
  test('routes order 6 to /change for a code Maintenance with a change request, a teacher\'s own application included', () => {
    const change = { ticket, contract: false, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true } };
    expect(roomHref(phase({ change }))).toBe('/workspace/p6/change');
    expect(phaseDocHref(phase({ change }))).toBe('/workspace/p6/change');
    expect(roomHref(phase({ change, artifactKind: 'tests' }))).toBe('/workspace/p6');
    // In the older format (no change request) an own application keeps the workspace, and the reference application the change room.
    expect(roomHref(phase({}))).toBe('/workspace/p6');
    expect(roomHref(phase({ provenance: { application: 'TaskTrackr' } }))).toBe('/workspace/p6/change');
  });
  test('says the older-format sentence for a code Maintenance with no change request', () => {
    expect(olderRecordSentence({ key: 'maintenance', artifactKind: 'code' } as PhaseDetail)).toBe(CHANGE_OLDER_FORMAT_ROOM);
  });
  test('the change room draws the older-format notice, Check and Submit disabled, for a code Maintenance with no change request', () => {
    render(<ChangeRoomOlderNotice detail={{ key: 'maintenance', artifactKind: 'code' } as PhaseDetail} />);
    expect(screen.getByTestId('change-older-format').textContent).toContain(CHANGE_OLDER_FORMAT_ROOM);
    expect((screen.getByTestId('change-older-check') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('change-older-submit') as HTMLButtonElement).disabled).toBe(true);
  });
  test('the Request tab shows the ticket read-only and offers the editable paths as file chips', () => {
    render(<RequestForm ticket={ticket} change={EMPTY_CHANGE_REQUEST} files={['api/shelf.py', 'web/src/lib/shelf.ts']} editable onChange={() => undefined} />);
    expect(screen.getByTestId('change-ticket').textContent).toContain('CHG-1');
    expect(screen.getByTestId('change-ticket').textContent).toContain('AC-3 Lending unchanged');
    expect(screen.getByTestId('change-impact-files-offer-api/shelf.py')).toBeTruthy();
  });
  test('the Checks tab\'s covers picker offers the ticket\'s ids and nothing else', () => {
    render(<TestsForm ticket={ticket} change={addTest(EMPTY_CHANGE_REQUEST)} editable onChange={() => undefined} />);
    expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual(['Covers AC-1', 'Covers AC-2', 'Covers AC-3']);
  });
  test('a read-only Checks tab draws each test\'s result as text in the room\'s words, never a disabled control', () => {
    const three = addTest(addTest(addTest(EMPTY_CHANGE_REQUEST)));
    const results: ChangeRequest = { ...three, tests: three.tests.map((t, at) => ({ ...t, result: (['pass', 'fail', 'not-run'] as const)[at] })) };
    render(<TestsForm ticket={ticket} change={results} editable={false} onChange={() => undefined} />);
    expect([0, 1, 2].map((at) => screen.getByTestId(`change-test-${at}-result`).textContent)).toEqual(['Passes', 'Fails', 'Not run']);
    expect(host!.querySelector('select')).toBeNull();
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    // the "Result" words stay, with no label pointing at a missing control
    expect(screen.getAllByText('Result')).toHaveLength(3);
    expect([...host!.querySelectorAll('label[for]')].filter((label) => !document.getElementById(label.getAttribute('for')!))).toEqual([]);
  });
  test('an editable Checks tab offers the result as a select in the same words', () => {
    render(<TestsForm ticket={ticket} change={addTest(EMPTY_CHANGE_REQUEST)} editable onChange={() => undefined} />);
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Result' });
    expect([...select.options].map((option) => option.textContent)).toEqual(['Passes', 'Fails', 'Not run']);
    expect(select.disabled).toBe(false);
  });
  test('Add takes the typed entry into the impact', () => {
    const onChange = vi.fn();
    render(<RequestForm ticket={ticket} change={EMPTY_CHANGE_REQUEST} files={[]} editable onChange={onChange} />);
    act(() => { fireEvent.change(screen.getByTestId('change-impact-files-input'), { target: { value: 'api/x.py' } }); });
    act(() => { fireEvent.click(screen.getByTestId('change-impact-files-add')); });
    expect(onChange.mock.calls.at(-1)![0].impact.files).toEqual(['api/x.py']);
  });
  test('draws "changed by the assistant" beside a marked field', () => {
    render(<TestsForm ticket={ticket} change={addTest(EMPTY_CHANGE_REQUEST)} editable onChange={() => undefined} assisted={new Set(['tests:T1:covers'])} />);
    expect(screen.getByTestId('change-assisted-tests:T1:covers').textContent).toBe('changed by the assistant');
  });
  test('lists the floor in words, the trace naming the uncovered acceptance ids', () => {
    const spec = { contract: false, ticket, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true } };
    render(<ChangeFloorCheck text={serialiseChangeRequest(EMPTY_CHANGE_REQUEST)} spec={spec} />);
    act(() => { fireEvent.click(screen.getByTestId('change-check')); });
    expect(screen.getByTestId('change-check-change.trace').textContent).toContain('Acceptance items not covered by any change line or test: AC-1, AC-2, AC-3');
  });
});
