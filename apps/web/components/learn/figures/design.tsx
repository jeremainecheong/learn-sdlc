'use client';
import { useState } from 'react';
import type { PhaseFigures } from './types';
import { Figure, FigureSvg } from './Figure';
import { StatusMark } from './StatusMark';
import { StepThrough } from './StepThrough';
import { ToggleSet } from './ToggleSet';
import './requirements-design.css';

/* The Design guide's figures. */

/* ------------------------- chapter 1: the contract builder ------------------------- */

/** The five promises a caller needs, filled from TaskTrackr's supplied
 * contract (shared/contract/api.json, operation listLists), copied exactly.
 * `guess` is what the caller has to guess while the slot is empty; `part` is
 * where the slot is drawn: on the request, on the response, or as the tag the
 * operation carries. */
export const CONTRACT_SLOTS = [
  { value: 'request', label: 'Request', filled: 'GET /api/lists, no body and no query parameters', guess: 'What do I send?', part: 'request' },
  { value: 'success', label: 'Success', filled: 'success: { status: 200, body: TaskList[] }', guess: 'What comes back when it works?', part: 'response' },
  { value: 'ordering', label: 'Ordering', filled: 'Every list, oldest first, each with how many of its tasks are still open.', guess: 'In what order, with which counts?', part: 'response' },
  { value: 'errors', label: 'Errors', filled: 'errors: [] (reading lists publishes no refusal)', guess: 'Can it be refused, and how?', part: 'response' },
  { value: 'story', label: 'Story', filled: 'satisfies: US-1', guess: 'Which story needs this?', part: 'story' },
] as const;
type Slot = (typeof CONTRACT_SLOTS)[number]['value'];
type SlotDef = (typeof CONTRACT_SLOTS)[number];

/** The live line of the contract figure for the slots filled so far. */
export function contractText(filled: readonly Slot[]): string {
  const open = CONTRACT_SLOTS.filter((slot) => !filled.includes(slot.value));
  if (open.length === 0) return 'All five promised. Nothing is left to guess: a caller can build against this row without reading the server code.';
  return `${filled.length} of ${CONTRACT_SLOTS.length} promised. The caller still has to guess ${open.length === 1 ? 'one thing' : `${open.length} things`}: ${open.map((slot) => slot.guess.charAt(0).toLowerCase() + slot.guess.slice(1, -1)).join('; ')}.`;
}

/** One slot, a button whose own words say its state ("Promised" or "Not
 * promised yet"), so it carries no aria-pressed as well: a screen reader
 * would hear the state twice. data-filled draws the ink outline. */
function ContractSlot({ slot, filled, onPress }: { slot: SlotDef; filled: boolean; onPress: () => void }) {
  return (
    <button type="button" className="fig-ds-slot" data-slot={slot.value} data-filled={filled} onClick={onPress}>
      <span className="fig-ds-slot-head">
        <span className="fig-ds-slot-name">{slot.label}</span>
        {filled ? <StatusMark status="passed" label="Promised" /> : <StatusMark status="not-run" label="Not promised yet" />}
      </span>
      {filled && <code>{slot.filled}</code>}
    </button>
  );
}

/** A caller and the API, the request and the response drawn as two
 * envelopes. Each empty slot is a hole a caller must guess; pressing it fills
 * it from the supplied contract and takes that question off the caller. */
function ContractBuilder() {
  const [filled, setFilled] = useState<Slot[]>([]);
  const press = (value: Slot) =>
    setFilled((was) => CONTRACT_SLOTS.map((slot) => slot.value).filter((v) => (v === value ? !was.includes(v) : was.includes(v))));
  const slot = (part: SlotDef['part']) =>
    CONTRACT_SLOTS.filter((one) => one.part === part).map((one) => (
      <ContractSlot key={one.value} slot={one} filled={filled.includes(one.value)} onPress={() => press(one.value)} />
    ));
  const guesses = CONTRACT_SLOTS.filter((one) => !filled.includes(one.value));
  return (
    <Figure
      title="From a vague promise to a contract row"
      howTo="Press each empty slot to fill it from TaskTrackr’s supplied contract, and watch what the caller has to guess."
      model="A teaching model. The real contract is in the Design room, and an authored example is not a live response."
      description="A caller cannot build on GET /api/lists returns lists until the request, the success status and shape, the order, the errors and the story are promised."
    >
      <p className="fig-ds-vague"><span className="fig-label">Vague promise</span> GET /api/lists returns lists</p>
      <div className="fig-ds-exchange-box">
        <div className="fig-ds-exchange">
          <div className="fig-ds-party" data-party="caller">
            <span className="fig-label">Caller</span>
            <strong>ListsPage</strong>
            <span>Route #/, reads listLists</span>
          </div>
          <div className="fig-ds-envelope" data-part="request">
            <span className="fig-ds-wire" data-side="left" aria-hidden="true" /><span className="fig-ds-wire" data-side="right" data-head="true" aria-hidden="true" />
            <span className="fig-ds-envelope-head">
              <svg className="fig-ds-flap" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 0 L50 12 L100 0" vectorEffect="non-scaling-stroke" /></svg>
              <span className="fig-label">Request, caller to API</span>
            </span>
            {slot('request')}
          </div>
          <div className="fig-ds-envelope" data-part="response">
            <span className="fig-ds-wire" data-side="left" data-head="true" aria-hidden="true" /><span className="fig-ds-wire" data-side="right" aria-hidden="true" />
            <span className="fig-ds-envelope-head">
              <svg className="fig-ds-flap" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 0 L50 12 L100 0" vectorEffect="non-scaling-stroke" /></svg>
              <span className="fig-label">Response, API to caller</span>
            </span>
            {slot('response')}
          </div>
          <div className="fig-ds-party" data-party="api">
            <span className="fig-label">TaskTrackr API</span>
            <strong>listLists</strong>
            <span>An operation in api.json</span>
          </div>
          <div className="fig-ds-story">
            <span className="fig-label">The row’s tag</span>
            {slot('story')}
          </div>
          <div className="fig-ds-guess" data-testid="contract-guesses" data-tone={guesses.length ? 'warn' : 'pass'}>
            <span className="fig-ds-guess-dots" aria-hidden="true"><span /><span /></span>
            {/* The count as a large number beside its words;
                the words say it for a screen reader. */}
            <span className="fig-ds-guess-head">
              <span className="fig-ds-guess-n" aria-hidden="true">{guesses.length}</span>
              {guesses.length ? (
                <StatusMark status="survived" label={`The caller has to guess ${guesses.length === 1 ? 'one thing' : `${guesses.length} things`}`} />
              ) : (
                <StatusMark status="passed" label="Nothing left to guess" />
              )}
            </span>
            {guesses.length > 0 && (
              <ul>
                {guesses.map((one) => <li key={one.value} data-guess={one.value}>{one.guess}</li>)}
              </ul>
            )}
          </div>
      </div>
      </div>
      <p className="fig-source">From the supplied contract file shared/contract/api.json, operation listLists (beside it, createList publishes invalid_name and duplicate_list), and screens.json, where ListsPage reads listLists.</p>
      <p className="fig-live" aria-live="polite" data-testid="contract-live">{contractText(filled)}</p>
    </Figure>
  );
}

/* --------------------------- chapter 2: cardinality --------------------------- */

export const TASK_COUNTS = [
  { value: '0', label: '0 tasks' },
  { value: '1', label: '1 task' },
  { value: '3', label: '3 tasks' },
] as const;
export const MODELS = [
  { value: 'right', label: 'One list, 0..* tasks' },
  { value: 'wrong', label: 'Every list has exactly one task' },
] as const;
type Count = (typeof TASK_COUNTS)[number]['value'];
type Model = (typeof MODELS)[number]['value'];
const TASK_TITLES = ['Review notes', 'Write summary', 'Return books'];

/** The cardinality figure's words for one state (the SVG's description and the live line). */
export function cardinalityText(count: Count, model: Model): { verdict: string; ok: boolean; description: string } {
  const n = Number(count);
  const ok = model === 'right' || n === 1;
  const holds = n === 0 ? 'List 7 holds no tasks yet, as a new list does (task_count 0).' : `List 7 holds ${n} task${n > 1 ? 's' : ''}, each naming list_id 7.`;
  const verdict =
    model === 'right'
      ? 'Allowed: a list can be empty or hold many tasks.'
      : ok
        ? 'Allowed here, but only by luck: this model still rejects an empty list and a list of three.'
        : `Rejected: the wrong model says every list has exactly one task, so it refuses ${n === 0 ? 'the empty list createList returns' : 'a list of three tasks'}.`;
  return { ok, verdict, description: `The example list has id 7. Each task refers to that identity through list_id, and every task requires one parent list. ${holds} ${verdict}` };
}

/** The cardinality drawing's height: the rows it holds, never the three-task
 * height with an empty band above a smaller state. */
export function cardinalityHeight(n: number): number {
  return n > 1 ? 8 + n * 64 : 112;
}

function ListCardinality() {
  const [count, setCount] = useState<Count>('0');
  const [model, setModel] = useState<Model>('right');
  const n = Number(count);
  const { ok, verdict, description } = cardinalityText(count, model);
  const height = cardinalityHeight(n);
  const mid = height / 2;
  const taskY = (i: number) => (n > 1 ? 8 + i * 64 : mid - 28);
  return (
    <Figure title="One list can contain zero or more tasks" howTo="Change how many tasks list 7 holds, then try the wrong model." model scroll>
      <div className="fig-rd-side">
        <div className="fig-rd-side-in">
          <div className="fig-rd-side-controls">
            <div>
              <span className="fig-label">Tasks in list 7</span>
              <ToggleSet label="Tasks in list 7" options={TASK_COUNTS} value={count} onChange={setCount} />
            </div>
            <div>
              <span className="fig-label">Model</span>
              <ToggleSet label="Model" options={MODELS} value={model} onChange={setModel} />
            </div>
            <p className="fig-verdict" data-tone={!ok ? 'fail' : model === 'wrong' ? 'warn' : 'pass'} aria-live="polite" data-testid="cardinality-live">
              {verdict}
            </p>
          </div>
          <FigureSvg className="fig-rd-svg" title="One list can contain zero or more tasks" description={description} viewBox={`0 0 720 ${height}`} minWidth={620}>
            <rect className="fig-node" data-tone={ok ? undefined : 'fail'} x="10" y={mid - 42} width="210" height="84" rx="8" />
            <text x="115" y={mid - 14} textAnchor="middle" className="fig-strong">List</text>
            <text x="115" y={mid + 8} textAnchor="middle">id: 7</text>
            <text x="115" y={mid + 30} textAnchor="middle">name: Reading</text>
            <line className="fig-edge" data-tone={ok ? undefined : 'fail'} x1="220" y1={mid} x2={n > 1 ? 330 : 340} y2={mid} />
            <text x="275" y={mid - 10} textAnchor="middle" className="fig-strong">{model === 'right' ? '1 → 0..*' : '1 → 1'}</text>
            {!ok && <text x="275" y={mid + 22} textAnchor="middle" className="fig-fail-text">Rejected</text>}
            {n > 1 && <path className="fig-edge" d={`M330 ${taskY(0) + 28} V${taskY(n - 1) + 28} M330 ${taskY(0) + 28} H340 M330 ${taskY(n - 1) + 28} H340 M330 ${mid} H340`} />}
            {n === 0 && (
              <g>
                <rect className="fig-node" x="340" y={mid - 28} width="370" height="56" rx="8" strokeDasharray="5 4" />
                <text x="525" y={mid + 5} textAnchor="middle" className="fig-small">No tasks yet: task_count 0</text>
              </g>
            )}
            {Array.from({ length: n }, (_, i) => (
              <g key={i}>
                <rect className="fig-node" x="340" y={taskY(i)} width="370" height="56" rx="8" />
                <text x="360" y={taskY(i) + 24} className="fig-strong">Task {20 + i}: {TASK_TITLES[i]}</text>
                <text x="360" y={taskY(i) + 44}>list_id: 7</text>
              </g>
            ))}
          </FigureSvg>
        </div>
      </div>
    </Figure>
  );
}

/* --------------------- chapter 3: trace the invalid-name request --------------------- */

const SEQUENCE_PARTICIPANTS = ['Direct API client', 'List route', 'Repository'];
const SEQUENCE_MESSAGES = [
  { x1: 120, x2: 365, y: 105, label: 'POST /api/lists', reply: false },
  { x1: 365, x2: 610, y: 165, label: 'create_list(name)', reply: false },
  { x1: 610, x2: 365, y: 225, label: 'ValueError', reply: true },
  { x1: 365, x2: 120, y: 285, label: '400 + invalid_name', reply: true },
];
/** One frame per message: who decides at that step. */
export const SEQUENCE_STEPS = [
  { title: 'The client sends an empty name', text: 'A direct API client sends POST /api/lists with an empty name. The supplied form would refuse it locally, so this call goes around the form to test the server.' },
  { title: 'The route calls the repository', text: 'The list route parses the JSON and calls create_list(name). The route owns HTTP; it does not judge the name.' },
  { title: 'The repository refuses', text: 'The repository trims the name, finds nothing left and raises ValueError. It owns the rule and builds no HTTP response. No list is inserted.' },
  { title: 'The route translates the refusal', text: 'The route catches the outcome and returns 400 with invalid_name to the client. The error is found in one layer and translated in another.' },
] as const;
const SEQUENCE_DESC =
  'Read downward: a direct API client sends an empty name, bypassing the supplied form’s local validation. The route calls the repository, which reports invalid input; the route returns 400 with invalid_name to the API client.';

function SequenceFrame({ lit }: { lit: number }) {
  return (
    <FigureSvg
      title="A direct invalid-name request returns through the server layers"
      description={`${SEQUENCE_DESC} Message ${lit + 1} of 4 is marked: ${SEQUENCE_MESSAGES[lit].label}.`}
      viewBox="0 0 730 320"
      minWidth={620}
      className="fig-rd-svg"
    >
      <defs>
        <marker id={`design-seq-arrow-${lit}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path className="fig-arrowhead" d="M0,0 L8,4 L0,8 z" /></marker>
        <marker id={`design-seq-arrow-lit-${lit}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path className="fig-arrowhead-lit" d="M0,0 L8,4 L0,8 z" /></marker>
      </defs>
      {SEQUENCE_PARTICIPANTS.map((label, i) => (
        <g key={label}>
          <rect className="fig-node" x={30 + i * 245} y="12" width="180" height="52" rx="8" />
          <text x={120 + i * 245} y="43" textAnchor="middle" className="fig-strong">{label}</text>
          <path className="fig-edge" d={`M${120 + i * 245} 65 V315`} strokeDasharray="5 5" />
        </g>
      ))}
      {SEQUENCE_MESSAGES.map((m, i) => (
        <g key={m.y} data-message={i + 1} data-lit={i === lit ? 'true' : undefined}>
          <line
            className="fig-edge"
            data-lit={i === lit ? 'true' : undefined}
            x1={m.x1}
            x2={m.x2}
            y1={m.y}
            y2={m.y}
            markerEnd={`url(#design-seq-arrow${i === lit ? '-lit' : ''}-${lit})`}
            strokeDasharray={m.reply ? '5 4' : undefined}
          />
          <text x={(m.x1 + m.x2) / 2} y={m.y - 10} textAnchor="middle" className={i === lit ? 'fig-strong' : undefined}>
            {i + 1}. {m.label}{m.reply ? ' (reply)' : ''}
          </text>
        </g>
      ))}
    </FigureSvg>
  );
}

function InvalidNameSequence() {
  return (
    <Figure
      title="A direct invalid-name request returns through the server layers"
      howTo="Press Next, or use the arrow keys, to send one message at a time."
      model
      scroll
      description="Solid arrows are calls; dashed arrows are replies. Each step names the layer that decides."
    >
      <StepThrough
        label="Trace the invalid-name request"
        steps={SEQUENCE_STEPS.map((step, i) => ({ ...step, content: <SequenceFrame lit={i} /> }))}
      />
    </Figure>
  );
}

/* ------------------------- chapter 4: a decision record ------------------------- */

export const RECORD_VERSIONS = [
  { value: 'slogan', label: 'A slogan' },
  { value: 'record', label: 'A decision record' },
] as const;
type RecordVersion = (typeof RECORD_VERSIONS)[number]['value'];
/** The late-marker decision the supplied project already made (US-5: the
 * task row derives its marker in the browser, web/src/lib/overdue.ts). The
 * record shows what each part must hold and fills ONE part as an example,
 * so the figure teaches the shape of a decision without handing over a
 * record to paste into the Decisions tab. */
export const DECISION_FIELDS: readonly { field: string; slogan: string | null; asks: string; example?: string }[] = [
  { field: 'Context', slogan: null, asks: 'What forces the choice: the facts a reader needs first.' },
  { field: 'Decision', slogan: 'Compute the marker in the browser.', asks: 'What you chose, in one sentence.' },
  { field: 'Alternative', slogan: null, asks: 'The option you did not choose, named so it can be compared.' },
  { field: 'Why', slogan: 'It is best practice.', asks: 'Why this beat the alternative here, not in general.' },
  { field: 'Cost', slogan: null, asks: 'What the choice costs you, said plainly.', example: 'The overdue rule now lives in two places, so a consistency test must keep the row and the report in step.' },
  { field: 'Revisit when', slogan: null, asks: 'The change in facts that would reopen the decision.' },
];

/** A connector between the rows of the decision drawing: one box forking
 * into two, or two joining into one. Columns sit at a quarter and three
 * quarters of the width, so the lines meet the boxes' centres. */
function RecordLink({ shape }: { shape: 'fork' | 'join' }) {
  return (
    <svg className="fig-ds-link" data-shape={shape} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d={shape === 'fork' ? 'M50 0 V12 M25 12 H75 M25 12 V24 M75 12 V24' : 'M25 0 V12 M75 0 V12 M25 12 H75 M50 12 V24'} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** One part of the decision drawing in the chosen version. */
function RecordPart({ f, version }: { f: (typeof DECISION_FIELDS)[number]; version: RecordVersion }) {
  const slogan = version === 'slogan';
  const state = slogan ? (f.slogan ? (f.field === 'Why' ? 'weak' : 'stated') : 'missing') : f.example ? 'example' : 'asked';
  return (
    <div className="fig-ds-part" data-field={f.field} data-state={state}>
      <span className="fig-ds-part-head">
        <strong>{f.field}</strong>
        {state === 'stated' && <StatusMark status="passed" label="Stated" />}
        {state === 'weak' && <StatusMark status="survived" label="Stated, against no alternative" />}
        {state === 'missing' && <StatusMark status="failed" label="Missing" />}
        {state === 'example' && <StatusMark status="passed" label="Filled as an example" />}
        {state === 'asked' && <StatusMark status="not-run" label="Asked for" />}
      </span>
      {slogan ? <span>{f.slogan ?? 'Not in the slogan.'}</span> : <span>{f.example ?? f.asks}</span>}
    </div>
  );
}

/** A decision drawn as a fork: the context at the top splits into the choice
 * and the alternative it beat, the reason weighs one against the other, and
 * the reason leads to the cost and the condition that would reopen it. */
function DecisionRecord() {
  const [version, setVersion] = useState<RecordVersion>('slogan');
  const missing = DECISION_FIELDS.filter((f) => version === 'slogan' && !f.slogan).length;
  const part = (field: string) => <RecordPart f={DECISION_FIELDS.find((f) => f.field === field)!} version={version} />;
  return (
    <Figure
      title="Defend the late-marker decision"
      howTo="Switch from the slogan to the record and compare what each lets a reviewer question."
      model="A teaching model on a decision the supplied project already made. One part of the record is filled as an example; your own decision is yours to write."
    >
      <div className="fig-controls">
        <ToggleSet label="Version" options={RECORD_VERSIONS} value={version} onChange={setVersion} />
      </div>
      <div className="fig-ds-record-box">
        <div className="fig-ds-record" data-version={version}>
          <div className="fig-ds-record-one">{part('Context')}</div>
          <RecordLink shape="fork" />
          <div className="fig-ds-record-two">
            {part('Decision')}
            <span className="fig-ds-or" aria-hidden="true">or</span>
            {part('Alternative')}
          </div>
          <RecordLink shape="join" />
          <div className="fig-ds-record-one">{part('Why')}</div>
          <RecordLink shape="fork" />
          <div className="fig-ds-record-two">
            {part('Cost')}
            {part('Revisit when')}
          </div>
        </div>
      </div>
      <p className="fig-live" aria-live="polite" data-testid="decision-live">
        {version === 'slogan'
          ? `${missing} of ${DECISION_FIELDS.length} parts missing. Best practice names no alternative and no cost, so nobody can say when to change it.`
          : `All ${DECISION_FIELDS.length} parts asked for. The cost is filled as an example: a reviewer can argue with it, which a slogan never allows.`}
      </p>
    </Figure>
  );
}

/** One line per figure. Chapters are numbered as the reader shows them (1 to 4). */
export const DESIGN_FIGURES: PhaseFigures = {
  'design-contract-builder': { chapter: 1, component: ContractBuilder },
  'design-list-cardinality': { chapter: 2, component: ListCardinality },
  'design-invalid-name-sequence': { chapter: 3, component: InvalidNameSequence },
  'design-decision-record': { chapter: 4, component: DecisionRecord },
};
