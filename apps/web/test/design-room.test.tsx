// @vitest-environment jsdom
/*
 * The Design room reads the learner's design as the shared record and the
 * contracts that are switched on, and grades it with the shared floor. The
 * cases are the brief's, in this suite's tooling: the web suite has no
 * @testing-library/react or jest-dom, so it renders with `createRoot` under
 * `act` and asserts with plain matchers.
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, screen } from '@testing-library/dom';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_DESIGN_FLOOR, EMPTY_API_CONTRACT, EMPTY_DESIGN, apiEndpoints, serialiseDesign, validateDesignRecord, type Design } from '@learnsdlc/shared';
import { designView, useDesign } from '@/components/workspace/panels/design/useDesign';
import { EntitiesCard, NotesCard, RelationsCard } from '@/components/workspace/panels/design/BoardCards';
import { OperationsCard } from '@/components/workspace/panels/design/OperationsCard';
import { DecisionsCard } from '@/components/workspace/panels/design/DecisionsCard';
import { designTabs } from '@/components/workspace/panels/design/model';
import { ScreensForm } from '@/components/workspace/panels/design/ScreensForm';
import { ChecksPanel } from '@/components/workspace/panels/design/ChecksPanel';
import { ApiWorkbench } from '@/components/workspace/panels/design/ApiWorkbench';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(node: ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const spec = { contracts: { api: true, screens: true }, sequence: false, stories: [{ id: 'US-4', title: 'Overdue', line: 'x' }], floor: DEFAULT_DESIGN_FLOOR };
const record: Design = { ...EMPTY_DESIGN, entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: ['knows when it is overdue'], satisfies: ['US-4'] }] };

describe('designView', () => {
  test('reads the record and evaluates the floor with the phase spec', () => {
    const v = designView({ 'design/design.json': serialiseDesign(record) }, [], spec);
    expect(v.broken).toBeNull();
    expect(v.doc.entities[0].name).toBe('Task');
    expect(v.results.find((r) => r.id === 'design.entities.min')!.detail).toBe('Fewer than 2 entities in the data model');
    expect(v.olderFormat).toBe(false);
  });
  test('a record that does not validate is broken, never overwritten', () => {
    const v = designView({ 'design/design.json': '{"fields":[]}' }, [], spec);
    expect(v.broken).toBe('entities is not a list');
    expect(v.doc).toEqual(EMPTY_DESIGN);
  });
  test('a phase without a design spec is in the older format', () => {
    expect(designView({}, [], undefined).olderFormat).toBe(true);
  });
});

describe('the sequence diagram switch', () => {
  test('the Sequence diagram tab is there only when the sequence diagram is on', () => {
    expect(designTabs({ contracts: { api: true, screens: false }, sequence: false }).map((t) => t.key)).toEqual(['model', 'api', 'decisions', 'review']);
    expect(designTabs({ contracts: { api: true, screens: true }, sequence: true }).map((t) => t.key)).toEqual(['model', 'api', 'screens', 'sequence', 'decisions', 'review']);
  });
  test('the checks carry the sequence rule only when it is on, and pass it when the diagram names an operation', () => {
    const named = serialiseDesign({ ...record, operations: [{ id: 'O1', name: 'getOverdue(today)', inputs: ['today'], returns: 'Task[]', errors: [], satisfies: ['US-4'] }], sequence: 'Browser -> Api: getOverdue' });
    expect(designView({ 'design/design.json': named }, [], { ...spec, sequence: true }).results.find((r) => r.id === 'design.sequence')!.passed).toBe(true);
    expect(designView({ 'design/design.json': serialiseDesign(record) }, [], { ...spec, sequence: true }).results.find((r) => r.id === 'design.sequence')!.detail)
      .toBe('The sequence diagram is missing or names none of the operations');
    expect(designView({ 'design/design.json': serialiseDesign(record) }, [], spec).results.some((r) => r.id === 'design.sequence')).toBe(false);
  });
});

describe('ScreensForm', () => {
  test('keeps a new screen in the form until it has a route, then writes it and keeps the keys it does not edit', () => {
    const written: string[] = [];
    const text = JSON.stringify({ $comment: 'kept', router: 'hash', screens: [{ route: '#/', component: 'ListsPage', shows: 'every list', writes: ['createList'] }] });
    render(<ScreensForm text={text} onChange={(next) => { written.push(next); }} editable />);
    act(() => { fireEvent.click(screen.getByTestId('design-screen-add')); });
    // a screen with no route would be refused by the contract and hold back the whole save
    expect(written).toEqual([]);
    expect(screen.getByTestId('design-screen-1-route-missing').textContent).toBe('A screen needs a route. This screen is kept here, unsaved, until it has one.');
    // the hint is the route field's description, read with it
    const hint = screen.getByTestId('design-screen-1-route-missing');
    expect(screen.getByTestId('design-screen-1-route').getAttribute('aria-describedby')).toBe(hint.id);
    expect(screen.getByTestId('design-screen-1-empty').getAttribute('aria-describedby')).toBeTruthy();
    act(() => { fireEvent.change(screen.getByTestId('design-screen-1-title'), { target: { value: 'Overdue' } }); });
    expect(written).toEqual([]);
    act(() => { fireEvent.change(screen.getByTestId('design-screen-1-route'), { target: { value: '#/overdue' } }); });
    const doc = JSON.parse(written[0]);
    expect(doc.$comment).toBe('kept');
    expect(doc.screens).toHaveLength(2);
    expect(doc.screens[0].shows).toBe('every list');
    expect(doc.screens[1]).toEqual({ route: '#/overdue', title: 'Overdue', component: '', reads: [], shows: '', components: [], empty: '' });
  });
  test("a saved screen's cleared route keeps the saved one until a new one is typed", () => {
    const written: string[] = [];
    const text = JSON.stringify({ screens: [{ route: '#/', component: 'ListsPage' }] });
    render(<ScreensForm text={text} onChange={(next) => { written.push(next); }} editable />);
    act(() => { fireEvent.change(screen.getByTestId('design-screen-0-route'), { target: { value: '' } }); });
    expect(written).toEqual([]);
    expect(screen.getByTestId<HTMLInputElement>('design-screen-0-route').value).toBe('');
    expect(screen.getByTestId('design-screen-0-route-missing').textContent).toBe('A screen needs a route. Your saved route #/ is kept until you type a new one.');
    act(() => { fireEvent.change(screen.getByTestId('design-screen-0-route'), { target: { value: '#/lists' } }); });
    expect(JSON.parse(written[0]).screens[0]).toEqual({ route: '#/lists', component: 'ListsPage' });
  });
  test('a route being typed survives a screen added from outside (an applied proposal)', () => {
    const one = JSON.stringify({ screens: [{ route: '#/', component: 'ListsPage' }] });
    const two = JSON.stringify({ screens: [{ route: '#/', component: 'ListsPage' }, { route: '#/overdue', component: 'OverduePage' }] });
    const written: string[] = [];
    render(<ScreensForm text={one} onChange={(next) => { written.push(next); }} editable />);
    act(() => { fireEvent.change(screen.getByTestId('design-screen-0-route'), { target: { value: '' } }); });
    // the same form, its text moved from outside
    act(() => root!.render(<ScreensForm text={two} onChange={(next) => { written.push(next); }} editable />));
    expect(screen.getByTestId<HTMLInputElement>('design-screen-0-route').value).toBe('');
    expect(screen.getByTestId('design-screen-0-route-missing')).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>('design-screen-1-route').value).toBe('#/overdue');
  });
  test('removing a screen still being typed writes nothing', () => {
    const written: string[] = [];
    render(<ScreensForm text={JSON.stringify({ screens: [] })} onChange={(next) => { written.push(next); }} editable />);
    act(() => { fireEvent.click(screen.getByTestId('design-screen-add')); });
    act(() => { fireEvent.click(screen.getByTestId('design-screen-0-remove')); });
    expect(written).toEqual([]);
    expect(screen.queryByTestId('design-screen-0')).toBeNull();
  });
  test('splits reads and components on commas', () => {
    let written = '';
    render(<ScreensForm text={JSON.stringify({ screens: [{ route: '#/overdue' }] })} onChange={(next) => { written = next; }} editable />);
    fireEvent.change(screen.getByTestId('design-screen-0-reads'), { target: { value: 'getOverdue, listLists' } });
    expect(JSON.parse(written).screens[0].reads).toEqual(['getOverdue', 'listLists']);
  });
  /** The form over a contract it writes back to, as the room holds it. */
  function Stateful({ initial, onPending }: { initial: string; onPending?: (pending: boolean) => void }) {
    const [text, setText] = useState(initial);
    return <ScreensForm text={text} onChange={setText} editable onPendingDraftChange={onPending} />;
  }
  test('reports a screen without a route, and a cleared route, as an unsaved edit until each has a route', () => {
    const reports: boolean[] = [];
    render(<Stateful initial={JSON.stringify({ screens: [{ route: '#/', component: 'ListsPage' }] })} onPending={(p) => { reports.push(p); }} />);
    expect(reports.at(-1)).toBe(false);
    act(() => { fireEvent.click(screen.getByTestId('design-screen-add')); });
    expect(reports.at(-1)).toBe(true);
    act(() => { fireEvent.change(screen.getByTestId('design-screen-1-route'), { target: { value: '#/overdue' } }); });
    expect(reports.at(-1)).toBe(false);
    act(() => { fireEvent.change(screen.getByTestId('design-screen-0-route'), { target: { value: '' } }); });
    expect(reports.at(-1)).toBe(true);
    act(() => { fireEvent.change(screen.getByTestId('design-screen-0-route'), { target: { value: '#/lists' } }); });
    expect(reports.at(-1)).toBe(false);
  });
  test('a screen that gets its route keeps its own row: typing into the second new screen never moves the first', () => {
    render(<Stateful initial={JSON.stringify({ screens: [] })} />);
    act(() => { fireEvent.click(screen.getByTestId('design-screen-add')); });
    act(() => { fireEvent.click(screen.getByTestId('design-screen-add')); });
    act(() => { fireEvent.change(screen.getByTestId('design-screen-0-title'), { target: { value: 'First' } }); });
    const route = screen.getByTestId<HTMLInputElement>('design-screen-1-route');
    route.focus();
    act(() => { fireEvent.change(route, { target: { value: '#/second' } }); });
    // the second joins the contract ahead of the first, and the field typed into is still its own
    expect(route.isConnected).toBe(true);
    expect(document.activeElement).toBe(route);
    expect(route.value).toBe('#/second');
    expect(screen.getByTestId<HTMLInputElement>('design-screen-1-title').value).toBe('First');
  });
  test("editing another field of a saved screen keeps its cleared route's draft", () => {
    const written: string[] = [];
    render(<ScreensForm text={JSON.stringify({ screens: [{ route: '#/', component: 'ListsPage' }] })} onChange={(next) => { written.push(next); }} editable />);
    act(() => { fireEvent.change(screen.getByTestId('design-screen-0-route'), { target: { value: '' } }); });
    act(() => { fireEvent.change(screen.getByTestId('design-screen-0-title'), { target: { value: 'Lists' } }); });
    expect(JSON.parse(written[0]).screens[0]).toEqual({ route: '#/', component: 'ListsPage', title: 'Lists' });
    expect(screen.getByTestId<HTMLInputElement>('design-screen-0-route').value).toBe('');
    expect(screen.getByTestId('design-screen-0-route-missing')).toBeTruthy();
  });
  test('says so and writes nothing over a contract it cannot read', () => {
    render(<ScreensForm text="{" onChange={() => { throw new Error('must not write'); }} editable />);
    expect(screen.getByRole('status').textContent).toContain('The screen contract cannot be opened.');
  });
});

describe('ChecksPanel', () => {
  test('lists every rule in words with its state, and the floor sentence, with no file name', () => {
    const v = designView({ 'design/design.json': serialiseDesign(record), 'shared/contract/api.json': '{"operations":[],"errors":{}}', 'shared/contract/screens.json': '{"screens":[]}' }, [], spec);
    render(<ChecksPanel results={v.results} floor={spec.floor} contracts={spec.contracts} sequence={spec.sequence} />);
    expect(screen.getByTestId('phase-design-check-design.entities.min').textContent).toContain('Fewer than 2 entities in the data model');
    expect(screen.getByTestId('phase-design-floor-sentence').textContent).toContain('at least 2 entities and 1 relation');
    expect(screen.getByTestId('phase-design-floor-sentence').textContent).not.toContain('sequence diagram');
    expect(document.body.textContent).not.toMatch(/\.json|\.md/);
  });
});

/* ------------------------------- the forms ------------------------------- */

/** The room's forms over one saved record, with every write the forms make. */
function Room({ doc, writes, children, phaseId }: { doc: Design; writes: string[]; children: (design: ReturnType<typeof useDesign>) => ReactNode; phaseId?: string }) {
  // the live buffer, as the room's save keeps it: each write is what the forms read next
  const [files, setFiles] = useState<Record<string, string>>({});
  const design = useDesign({
    serverFiles: [{ path: 'design/design.json', content: serialiseDesign(doc) }],
    files,
    setFile: (path, content) => {
      writes.push(content);
      setFiles((was) => ({ ...was, [path]: content }));
    },
    spec,
    flushSave: async () => undefined,
    setNotice: () => undefined,
    setError: () => undefined,
    phaseId,
  });
  return <>{children(design)}</>;
}
const last = (writes: string[]): Design => {
  const text = writes[writes.length - 1];
  // never a null: the save would refuse it
  expect(text).not.toContain('null');
  const out = validateDesignRecord(text);
  expect(out.error).toBeNull();
  return out.design!;
};
const two: Design = {
  ...record,
  entities: [...record.entities, { id: 'E2', name: 'List', kind: 'component', attributes: [{ name: 'title', type: 'string' }], responsibilities: [], satisfies: [] }],
  relations: [{ id: 'R1', from: 'E2', to: 'E1', kind: 'aggregation', fromCard: '1', toCard: '*', label: 'holds' }],
};

describe('the forms write the record', () => {
  test('an entity keeps its kind select and responsibilities, and its stories are toggles', () => {
    const writes: string[] = [];
    render(<Room doc={two} writes={writes}>{(d) => <EntitiesCard design={d} />}</Room>);
    expect(screen.getByTestId('design-board-entity-1-kind').tagName).toBe('SELECT');
    const toggle = screen.getByTestId('design-board-entity-0-story-US-4');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(last(writes).entities[0].satisfies).toEqual([]);
    fireEvent.change(screen.getByTestId('design-board-entity-1-attr-0-type'), { target: { value: '' } });
    expect(last(writes).entities[1].attributes[0]).toEqual({ name: 'title' });
    fireEvent.change(screen.getByTestId('design-board-entity-0-resp'), { target: { value: 'knows its due date\n' } });
    expect(last(writes).entities[0].responsibilities).toEqual(['knows its due date', '']);
    // a pasted line longer than the record's field cap is cut there, never refused
    fireEvent.change(screen.getByTestId('design-board-entity-0-resp'), { target: { value: 'r'.repeat(4500) } });
    expect(last(writes).entities[0].responsibilities).toEqual(['r'.repeat(4000)]);
  });

  test('a relation offers the five kinds, and a blank cardinality or label writes no key', () => {
    const writes: string[] = [];
    render(<Room doc={two} writes={writes}>{(d) => <RelationsCard design={d} />}</Room>);
    const kinds = [...(screen.getByTestId('design-board-relation-0-kind') as HTMLSelectElement).options].map((o) => o.value);
    expect(kinds).toEqual(['association', 'aggregation', 'composition', 'inheritance', 'dependency']);
    fireEvent.change(screen.getByTestId('design-board-relation-0-from-card'), { target: { value: '' } });
    expect('fromCard' in last(writes).relations[0]).toBe(false);
    fireEvent.change(screen.getByTestId('design-board-relation-0-label'), { target: { value: '' } });
    expect('label' in last(writes).relations[0]).toBe(false);
  });

  test('an operation keeps its inputs and errors as lists, one per line, and its note only when written', () => {
    const writes: string[] = [];
    render(<Room doc={record} writes={writes}>{(d) => <OperationsCard design={d} />}</Room>);
    fireEvent.click(screen.getByTestId('design-operation-add'));
    expect(last(writes).operations[0]).toEqual({ id: 'O1', name: '', inputs: [], returns: '', errors: [], satisfies: [] });
  });

  test('an operation\'s inputs and errors are typed one per line, blanks dropped, and a cleared note writes no key', () => {
    const writes: string[] = [];
    const doc: Design = { ...record, operations: [{ id: 'O1', name: 'getOverdue(today)', inputs: [], returns: 'Task[]', errors: [], satisfies: [], note: 'due today is not overdue' }] };
    render(<Room doc={doc} writes={writes}>{(d) => <OperationsCard design={d} />}</Room>);
    fireEvent.change(screen.getByTestId('design-operation-0-inputs'), { target: { value: 'today\n\nlimit' } });
    expect(last(writes).operations[0].inputs).toEqual(['today', 'limit']);
    expect((screen.getByTestId('design-operation-0-inputs') as HTMLTextAreaElement).value).toBe('today\n\nlimit');
    fireEvent.change(screen.getByTestId('design-operation-0-errors'), { target: { value: '400 bad date' } });
    expect(last(writes).operations[0].errors).toEqual(['400 bad date']);
    fireEvent.change(screen.getByTestId('design-operation-0-note'), { target: { value: '' } });
    expect('note' in last(writes).operations[0]).toBe(false);
    fireEvent.click(screen.getByTestId('design-operation-0-story-US-4'));
    expect(last(writes).operations[0].satisfies).toEqual(['US-4']);
  });

  test('a decision names what superseded it only while superseded, and a cleared context writes no key', () => {
    const writes: string[] = [];
    const doc: Design = {
      ...record,
      decisions: [
        { id: 'D1', title: 'Storage', choice: 'one file', alternative: 'a server', rationale: 'small', tradeOff: 'a lock', context: 'no server', status: 'superseded', satisfies: [] },
        { id: 'D2', title: 'Storage again', choice: 'SQLite', alternative: 'one file', rationale: 'queries', tradeOff: 'a schema', status: 'proposed', satisfies: [] },
      ],
    };
    render(<Room doc={doc} writes={writes}>{(d) => <DecisionsCard design={d} />}</Room>);
    expect(screen.queryByTestId('design-decision-1-superseded-by')).toBeNull();
    fireEvent.change(screen.getByTestId('design-decision-0-superseded-by'), { target: { value: 'D2' } });
    expect(last(writes).decisions[0].supersededBy).toBe('D2');
    fireEvent.change(screen.getByTestId('design-decision-0-context'), { target: { value: '' } });
    expect('context' in last(writes).decisions[0]).toBe(false);
    fireEvent.change(screen.getByTestId('design-decision-0-consequences'), { target: { value: 'a lock\n' } });
    expect(last(writes).decisions[0].consequences).toEqual(['a lock', '']);
  });

  test('cleared notes leave the record without notes', () => {
    const writes: string[] = [];
    render(<Room doc={{ ...record, notes: 'kept' }} writes={writes}>{(d) => <NotesCard design={d} />}</Room>);
    fireEvent.change(screen.getByTestId('design-board-notes'), { target: { value: '' } });
    expect('notes' in last(writes)).toBe(false);
  });
});

/** The room's API workbench over its live buffer, with every write the room's contract save is handed. */
function Contract({ writes, start = EMPTY_API_CONTRACT, pending }: { writes: string[]; start?: string; pending?: (on: boolean) => void }) {
  const [files, setFiles] = useState<Record<string, string>>({ 'shared/contract/api.json': start });
  return (
    <ApiWorkbench
      files={files}
      onPendingDraftChange={pending}
      setFile={(path, content) => {
        writes.push(content);
        setFiles((was) => ({ ...was, [path]: content }));
      }}
    />
  );
}
const press = (name: string) => act(() => { fireEvent.click(screen.getByRole('button', { name })); });

describe('the API workbench over an empty contract', () => {
  test('says what to do, adds a first endpoint with the fields it edits, and removing the last returns to the empty state', () => {
    const writes: string[] = [];
    render(<Contract writes={writes} />);
    expect(host!.textContent).toContain('The contract has no endpoints yet. Add an endpoint to describe its first request.');
    press('Add an endpoint');
    expect(JSON.parse(writes[writes.length - 1])).toEqual({
      operations: [{ id: 'endpoint1', method: 'GET', path: '', summary: '', query: [], body: {}, success: {}, errors: [], 'x-example': {} }],
      errors: {},
    });
    // it counts towards the floor's endpoints, and opens in the form
    expect(apiEndpoints(writes[writes.length - 1])).toHaveLength(1);
    act(() => { fireEvent.change(screen.getByPlaceholderText('/api/resource/{id}'), { target: { value: '/api/tasks' } }); });
    expect(JSON.parse(writes[writes.length - 1]).operations[0].path).toBe('/api/tasks');
    press('Remove this endpoint');
    expect(JSON.parse(writes[writes.length - 1])).toEqual({ operations: [], errors: {} });
    expect(host!.textContent).toContain('The contract has no endpoints yet.');
    expect(screen.getByRole('button', { name: 'Add an endpoint' })).toBeTruthy();
  });

  test("the learner's room says the contract is saved with the design, and links the contract guide", () => {
    render(<Contract writes={[]} />);
    expect(host!.textContent).toContain('Your project: Saved with your design');
    expect(host!.querySelector('a[href="/learn/design"]')?.textContent).toBe('Contract guide ↗');
  });

  test('a new endpoint is numbered past the highest one the contract holds (Task 12b)', () => {
    const writes: string[] = [];
    render(<Contract writes={writes} start={JSON.stringify({ operations: [{ id: 'endpoint1', method: 'GET', path: '/a' }, { id: 'endpoint5', method: 'GET', path: '/b' }], errors: {} })} />);
    press('Add an endpoint');
    expect(JSON.parse(writes[writes.length - 1]).operations.map((o: { id: string }) => o.id)).toEqual(['endpoint1', 'endpoint5', 'endpoint6']);
  });

  test('a second endpoint takes an id no other holds, and a waiting draft goes with the endpoint removed', () => {
    const writes: string[] = [];
    const pending: boolean[] = [];
    render(<Contract writes={writes} pending={(on) => pending.push(on)} start={JSON.stringify({ operations: [{ id: 'endpoint2', method: 'GET', path: '/a' }], errors: {} })} />);
    press('Add an endpoint');
    expect(JSON.parse(writes[writes.length - 1]).operations.map((o: { id: string }) => o.id)).toEqual(['endpoint2', 'endpoint3']);
    press('Body');
    const body = screen.getByLabelText('Request body contract (JSON)');
    act(() => { fireEvent.change(body, { target: { value: '{' } }); });
    act(() => { fireEvent.focusOut(body); });
    expect(screen.getByRole('alert').textContent).toContain('Enter valid JSON');
    expect(pending[pending.length - 1]).toBe(true);
    press('Remove this endpoint');
    expect(pending[pending.length - 1]).toBe(false);
    expect(JSON.parse(writes[writes.length - 1]).operations.map((o: { id: string }) => o.id)).toEqual(['endpoint2']);
  });
});

describe("the assistant's marks", () => {
  test('a mark follows its item when the learner removes an earlier one through the form (Task 11 fix 1)', () => {
    const op = (id: string, name: string) => ({ id, name, inputs: ['x'], returns: 'y', errors: [], satisfies: [] });
    const doc = { ...EMPTY_DESIGN, operations: [op('O1', 'first(x)'), op('O2', 'second(x)')] };
    sessionStorage.setItem('learnsdlc:touched:phase-o', JSON.stringify({ 'design/operation-2/name': 'O2: second(x)' }));
    const writes: string[] = [];
    render(<Room doc={doc} writes={writes} phaseId="phase-o">{(d) => <OperationsCard design={d} />}</Room>);
    expect(screen.getByTestId('design-operation-1-touched').textContent).toBe('Changed by the assistant: name');
    act(() => { fireEvent.click(screen.getByTestId('design-operation-0-remove')); });
    expect(JSON.parse(sessionStorage.getItem('learnsdlc:touched:phase-o')!)).toEqual({ 'design/operation-1/name': 'O2: second(x)' });
    expect(screen.getByTestId('design-operation-0-touched').textContent).toBe('Changed by the assistant: name');
  });
  test('an item the assistant wrote says so while its fields still hold the text, and loses the mark once rewritten', () => {
    sessionStorage.setItem('learnsdlc:touched:phase-m', JSON.stringify({
      'design/entity-1/name': 'Task (E1)',
      'design/entity-1/responsibilities': 'knows when it is overdue',
      'design/entity-2/name': 'Board (E2)',
      'design/notes': 'Assumptions written by the assistant.',
    }));
    const writes: string[] = [];
    render(<Room doc={{ ...two, notes: 'Assumptions written by the assistant.' }} writes={writes} phaseId="phase-m">{(d) => <><EntitiesCard design={d} /><NotesCard design={d} /></>}</Room>);
    expect(screen.getByTestId('design-board-entity-0-touched').textContent).toBe('Changed by the assistant: name, responsibilities');
    // the second entity's name is not what the assistant wrote there
    expect(screen.queryByTestId('design-board-entity-1-touched')).toBeNull();
    expect(screen.getByTestId('design-board-notes-touched').textContent).toBe('Changed by the assistant');
    act(() => { fireEvent.change(screen.getByTestId('design-board-entity-0-name'), { target: { value: 'Job' } }); });
    expect(screen.getByTestId('design-board-entity-0-touched').textContent).toBe('Changed by the assistant: responsibilities');
    sessionStorage.clear();
  });
  test('without a phase, or with no marks, nothing is marked', () => {
    render(<Room doc={two} writes={[]}>{(d) => <EntitiesCard design={d} />}</Room>);
    expect(document.querySelector('[data-testid$="-touched"]')).toBeNull();
  });
});
