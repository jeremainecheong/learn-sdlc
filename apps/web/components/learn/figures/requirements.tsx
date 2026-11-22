'use client';
import { useEffect, useRef, useState } from 'react';
import { ScrollRegion } from '@/components/experience/ScrollRegion';
import { GATE_RULE } from '../phase-map';
import type { PhaseFigures } from './types';
import { Figure, FigureSvg } from './Figure';
import { StatusMark } from './StatusMark';
import { ToggleSet } from './ToggleSet';
import './requirements-design.css';

/* The Requirements guide's figures. Each teaches one
 * thing in about ten seconds; each is a teaching model and says so. */

/* ----------------------- chapter 1: fact or assumption ----------------------- */

export type NoteKind = 'fact' | 'assumption' | 'solution';
export const NOTE_KINDS = [
  { value: 'fact', label: 'Fact' },
  { value: 'assumption', label: 'Assumption' },
  { value: 'solution', label: 'Solution idea' },
] as const;
const KIND_WORD: Record<NoteKind, string> = { fact: 'Fact', assumption: 'Assumption', solution: 'Solution idea' };

/** Six illustrative interview notes about TaskTrackr's overdue work. */
export const INTERVIEW_NOTES: readonly { id: string; note: string; kind: NoteKind; reason: string }[] = [
  { id: 'rent', note: 'Last Tuesday I missed paying the rent. It was in my list, with a date.', kind: 'fact', reason: 'A recent event the stakeholder reports. Start from notes like this one.' },
  { id: 'chart', note: 'A red chart of late tasks would help.', kind: 'solution', reason: 'It names a picture before anyone knows what went wrong.' },
  { id: 'weekend', note: 'She probably never opens the app at weekends.', kind: 'assumption', reason: 'Your guess. Nobody said it, so ask before you rely on it.' },
  { id: 'late-done', note: 'I tick a task done when I finish it, even if that is late.', kind: 'fact', reason: 'Reported behaviour. It tells you a completed task must not stay overdue.' },
  { id: 'email', note: 'Email me every time I add a task.', kind: 'solution', reason: 'A feature request, and notifications are out of scope for this release. Ask what it would prevent.' },
  { id: 'undated', note: 'Tasks without a date are probably never urgent.', kind: 'assumption', reason: 'An interpretation. Ask how a task with no due date should behave.' },
];

/** The words drawn on each bin, under its name. */
export const BIN_HINTS: Record<NoteKind, string> = {
  fact: 'Reported or observed',
  assumption: 'Your own explanation or guess',
  solution: 'A feature, named before the need',
};

/** One note waits above three bins; pressing a bin drops it in, and the next
 * note takes its place. Show the answer marks every sorted note in its bin. */
function FactSorter() {
  const [placed, setPlaced] = useState<Record<string, NoteKind>>({});
  const [shown, setShown] = useState(false);
  const [moved, setMoved] = useState<string>('');
  // A pressed control that leaves the page (the last bin press, Start again)
  // hands focus on, so the keyboard never drops to the page body.
  const [focusTo, setFocusTo] = useState<'answer' | 'bins' | null>(null);
  const answerButton = useRef<HTMLButtonElement>(null);
  const bins = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusTo === 'answer') answerButton.current?.focus();
    if (focusTo === 'bins') bins.current?.querySelector('button')?.focus();
    if (focusTo) setFocusTo(null);
  }, [focusTo]);
  const total = INTERVIEW_NOTES.length;
  const at = INTERVIEW_NOTES.findIndex((n) => !placed[n.id]);
  const waiting = at >= 0 ? INTERVIEW_NOTES[at] : null;
  const sorted = INTERVIEW_NOTES.filter((n) => placed[n.id]);
  const right = sorted.filter((n) => placed[n.id] === n.kind).length;
  const drop = (kind: NoteKind) => {
    if (!waiting) return;
    setPlaced((all) => ({ ...all, [waiting.id]: kind }));
    setMoved(`Put in ${KIND_WORD[kind]}.`);
    if (INTERVIEW_NOTES.every((n) => n === waiting || placed[n.id])) setFocusTo('answer');
  };
  const restart = () => { setPlaced({}); setShown(false); setMoved(''); setFocusTo('bins'); };
  const next = waiting ? `Note ${at + 1} of ${total} is waiting: “${waiting.note}” Choose its bin.` : `All ${total} notes are in the bins. Press Show the answer to check them.`;
  const live = shown
    ? `${right} of ${sorted.length} sorted notes are in the right bin.${sorted.length < total ? ` ${total - sorted.length} not sorted yet.` : ''}`
    : `${moved ? `${moved} ` : ''}${next}`;
  return (
    <Figure
      title="Fact, assumption or solution idea"
      howTo="Press the bin each note belongs in. Then press Show the answer."
      model="A teaching model with illustrative notes. Your real interview is in the Requirements room."
      description="A fact is something the person reports or you can observe. An assumption is your own explanation or guess. A solution idea names a feature before the need is clear."
    >
      <div className="fig-rq-sorter">
        {/* A running count above the note and the bins. */}
        <p className="fig-rq-count" data-testid="sorter-count">
          <span><strong>{sorted.length}</strong> of {total} sorted</span>
          {shown && <span><strong>{right}</strong> of {total} in the right bin</span>}
        </p>
        <div className="fig-rq-waiting">
          {waiting ? (
            <p className="fig-rq-note" data-note-waiting={waiting.id}>
              <span className="fig-rq-note-count">Note {at + 1} of {total}</span>
              <span className="fig-card-quote">“{waiting.note}”</span>
            </p>
          ) : (
            <p className="fig-rq-note" data-note-waiting="">
              <span className="fig-rq-note-count">All {total} sorted</span>
              <span>Every note is in a bin.</span>
            </p>
          )}
          {/* The fork and its gap stay in every state, the last note sorted
              too, so the card never sits on the bins. */}
          <svg className="fig-rq-fork" viewBox="0 0 300 36" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <path d="M150 0 V12 M50 12 H250 M50 12 V36 M150 12 V36 M250 12 V36" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
        <div className="fig-rq-bins" role="group" aria-label="Bins" ref={bins}>
          {NOTE_KINDS.map((k) => {
            const inBin = INTERVIEW_NOTES.filter((n) => placed[n.id] === k.value);
            return (
              <div key={k.value} className="fig-rq-bin" data-bin={k.value}>
                {waiting ? (
                  <button type="button" className="fig-rq-bin-mouth" onClick={() => drop(k.value)}>
                    <strong>{k.label}</strong>
                    <span>{BIN_HINTS[k.value]}</span>
                  </button>
                ) : (
                  <div className="fig-rq-bin-mouth" data-closed="true">
                    <strong>{k.label}</strong>
                    <span>{BIN_HINTS[k.value]}</span>
                  </div>
                )}
                <ul className="fig-rq-bin-tray" aria-label={`In the ${k.label} bin`}>
                  {inBin.length === 0 && <li className="fig-rq-bin-empty">Empty</li>}
                  {inBin.map((n) => {
                    const verdict = !shown ? undefined : n.kind === k.value ? 'pass' : 'fail';
                    return (
                      <li key={n.id} className="fig-rq-slip" data-note={n.id} data-tone={verdict}>
                        <span className="fig-card-quote">“{n.note}”</span>
                        {verdict === 'pass' && <StatusMark status="passed" label="Right bin" />}
                        {verdict === 'fail' && <StatusMark status="failed" label={`Belongs in ${KIND_WORD[n.kind]}`} />}
                        {verdict && <span className="fig-card-reason">{KIND_WORD[n.kind]}. {n.reason}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
      <div className="fig-row" style={{ marginTop: 12 }}>
        <button type="button" className="fig-button" ref={answerButton} onClick={() => setShown((v) => !v)}>
          {shown ? 'Hide the answer' : 'Show the answer'}
        </button>
        {sorted.length > 0 && (
          <button type="button" className="fig-button" onClick={restart}>Start again</button>
        )}
      </div>
      <p className="fig-live" aria-live="polite" data-testid="sorter-live">{live}</p>
    </Figure>
  );
}

/* --------------------- chapter 2: parent versus dependency --------------------- */

type Level = 'epic' | 'story' | 'subtask';
export const HIERARCHY_LEVELS = [
  { value: 'epic', label: 'Epic' },
  { value: 'story', label: 'Story' },
  { value: 'subtask', label: 'Subtasks' },
] as const;
/** What completes each level: user outcome above, technical work below. */
export const COMPLETES: Record<Level, string> = {
  epic: 'Done when people can capture and organise their work: every story under it has delivered its part. It is a user outcome.',
  story: 'Done when a learner can add a titled task to a list, shown by US-1’s acceptance criteria. It is a slice of the outcome a user can see.',
  subtask: 'Done when the technical work is finished. The form can be connected while the user outcome is still missing, so a subtask needs its own evidence.',
};
const TREE_DESC =
  'An illustrative capture-and-organise epic parents supplied US-1. Interface and verification tasks support that story; this picture does not create backlog records.';

function PurposeTree() {
  const [level, setLevel] = useState<Level>('story');
  const [dependency, setDependency] = useState(false);
  const lit = (l: Level) => (level === l ? 'true' : undefined);
  const description = `${TREE_DESC} ${
    dependency
      ? 'A dashed depends-on line now runs from the verification subtask to the interface subtask. It is wrong here: the empty-title refusal can be checked at the API without the form, so neither subtask waits for the other.'
      : 'Solid lines are parent links only. Sharing a parent does not mean one subtask waits for the other.'
  }`;
  return (
    <Figure
      title="A purpose hierarchy for the supplied US-1 story"
      howTo="Choose a level to see what completes it. Then add a dependency line."
      model
      scroll
      description={description}
    >
      <div className="fig-rd-side">
        <div className="fig-rd-side-in">
          <div className="fig-rd-side-controls">
            <div>
              <span className="fig-label">Level</span>
              <ToggleSet label="Level" options={HIERARCHY_LEVELS} value={level} onChange={setLevel} />
            </div>
            <div>
              <button type="button" className="fig-button" onClick={() => setDependency((v) => !v)}>
                {dependency ? 'Remove the dependency line' : 'Add a dependency line'}
              </button>
            </div>
            <p className="fig-live" aria-live="polite" data-testid="tree-live">
              <strong>What completes it:</strong> {COMPLETES[level]}
              {dependency && ' A depends-on line must name a real prerequisite; this one does not.'}
            </p>
          </div>
          <FigureSvg className="fig-rd-svg" title="A purpose hierarchy for the supplied US-1 story" description={description} viewBox="0 0 720 258" minWidth={610}>
            <defs>
              <marker id="req-tree-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path className="fig-arrowhead" d="M0,0 L8,4 L0,8 z" /></marker>
              <marker id="req-tree-arrow-fail" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path className="fig-arrowhead-fail" d="M0,0 L8,4 L0,8 z" /></marker>
            </defs>
            <line className="fig-edge" x1="360" y1="62" x2="360" y2="95" markerEnd="url(#req-tree-arrow)" />
            <text x="372" y="84" className="fig-small">parent</text>
            <line className="fig-edge" x1="320" y1="152" x2="178" y2="195" markerEnd="url(#req-tree-arrow)" />
            <line className="fig-edge" x1="400" y1="152" x2="542" y2="195" markerEnd="url(#req-tree-arrow)" />
            {dependency && (
              <g data-testid="dependency-line">
                <line className="fig-edge" data-tone="fail" x1="420" y1="236" x2="302" y2="236" strokeDasharray="6 4" markerEnd="url(#req-tree-arrow-fail)" />
                <text x="360" y="224" textAnchor="middle" className="fig-fail-text">depends on?</text>
              </g>
            )}
            <rect className="fig-node" data-lit={lit('epic')} x="220" y="6" width="280" height="56" rx="8" />
            <text x="360" y="28" textAnchor="middle" className="fig-small">Illustrative epic</text>
            <text x="360" y="50" textAnchor="middle" className="fig-strong">Capture and organise work</text>
            <rect className="fig-node" data-lit={lit('story')} x="220" y="96" width="280" height="56" rx="8" />
            <text x="360" y="118" textAnchor="middle" className="fig-small">Supplied US-1 story</text>
            <text x="360" y="140" textAnchor="middle" className="fig-strong">Add a task to a list</text>
            <rect className="fig-node" data-lit={lit('subtask')} x="40" y="196" width="260" height="56" rx="8" />
            <text x="170" y="218" textAnchor="middle" className="fig-small">Interface subtask</text>
            <text x="170" y="240" textAnchor="middle" className="fig-strong">Connect the task form</text>
            <rect className="fig-node" data-lit={lit('subtask')} x="420" y="196" width="260" height="56" rx="8" />
            <text x="550" y="218" textAnchor="middle" className="fig-small">Verification subtask</text>
            <text x="550" y="240" textAnchor="middle" className="fig-strong">Check empty-title refusal</text>
          </FigureSvg>
        </div>
      </div>
    </Figure>
  );
}

/* ------------------- chapter 3: criteria that catch bad code ------------------- */

type CriterionKind = 'weak' | 'full';
export const CRITERIA = [
  { value: 'weak', label: 'Then: the request returns an error' },
  { value: 'full', label: 'Then: 400 and invalid_title, and no task stored' },
] as const;
/** Three ways code could answer US-1/AC-2's empty-title request. */
export const IMPLEMENTATIONS: readonly { id: string; name: string; does: string; correct: boolean; caughtBy: readonly CriterionKind[] }[] = [
  { id: 'refuses', name: 'Refuses and stores nothing', does: '400, invalid_title. The list still has its tasks and no more.', correct: true, caughtBy: [] },
  { id: 'stores-then-refuses', name: 'Stores the task, then refuses', does: '400, invalid_title. A task with an empty title is now in the list.', correct: false, caughtBy: ['full'] },
  { id: 'accepts', name: 'Accepts the empty title', does: 'A success status. A task with an empty title is now in the list.', correct: false, caughtBy: ['weak', 'full'] },
];

function CriterionTester() {
  const [criterion, setCriterion] = useState<CriterionKind>('weak');
  const wrong = IMPLEMENTATIONS.filter((i) => !i.correct);
  const caught = wrong.filter((i) => i.caughtBy.includes(criterion)).length;
  return (
    <Figure
      title="Which wrong code does the criterion catch?"
      howTo="Switch between the two criteria and watch the last column."
      model
      description="Given an existing list with known tasks, when a task is submitted with an empty title. A criterion that checks only for an error cannot tell the second version from the first: both return 400 and invalid_title."
    >
      <div className="fig-controls">
        <div>
          <span className="fig-label">US-1/AC-2 criterion</span>
          <ToggleSet label="US-1/AC-2 criterion" options={CRITERIA} value={criterion} onChange={setCriterion} />
        </div>
      </div>
      <ScrollRegion label="Three versions of the code" hint="Scroll sideways to see every column.">
        <table className="fig-table">
          <caption>Three versions of the code, one empty-title request</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">What it does</th>
              <th scope="col">Under this criterion</th>
            </tr>
          </thead>
          <tbody>
            {IMPLEMENTATIONS.map((i) => (
              <tr key={i.id} data-implementation={i.id}>
                <th scope="row">{i.name}</th>
                <td>{i.does}</td>
                <td>
                  {i.correct ? (
                    <StatusMark status="passed" label="Passes, as it should" />
                  ) : i.caughtBy.includes(criterion) ? (
                    <StatusMark status="killed" label="Caught" />
                  ) : (
                    <StatusMark status="survived" label="Slips through" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <p className="fig-live" aria-live="polite" data-testid="criterion-live">
        {criterion === 'weak'
          ? `The weak criterion catches ${caught} of ${wrong.length} wrong versions. Code that stores the bad task and then refuses still passes.`
          : `The full criterion catches ${caught} of ${wrong.length} wrong versions, because it also checks what was stored.`}
      </p>
    </Figure>
  );
}

/* ---------------------- chapter 4: review the whole promise ---------------------- */

/** An illustrative one-line draft of the overdue report, never a story to
 * copy: it decides three of the five cases (one against the brief) and leaves
 * two open. The brief (01-requirements phase.json, taskPanel) states the
 * first three outcomes: a task whose due date has passed appears, a task due
 * today is not in it yet, a completed task is not in it however late it was.
 * The other two are Dana's to decide in the interview, so the figure never
 * says what she decided. */
export const OVERDUE_DRAFT = 'The report lists every task whose due date is before today.';
type CaseVerdict = 'agrees' | 'against' | 'gap';
type CaseSpot = 'three-days' | 'yesterday' | 'today' | 'no-date' | 'order';
export const OVERDUE_CASES: readonly { id: string; name: string; spot: CaseSpot; decides: boolean; draft: string; verdict: CaseVerdict; why: string }[] = [
  { id: 'yesterday', name: 'An open task due yesterday', spot: 'yesterday', decides: true, draft: 'Listed', verdict: 'agrees', why: '“Before today” takes in yesterday, so the draft lists it. The brief agrees: a task whose due date has passed appears in the report.' },
  { id: 'today', name: 'An open task due today', spot: 'today', decides: true, draft: 'Not listed', verdict: 'agrees', why: '“Before today” leaves today out, so the draft decides the boundary. The brief agrees: a task due today is not in the report yet.' },
  { id: 'done', name: 'A completed task, due 3 days ago', spot: 'three-days', decides: true, draft: 'Listed', verdict: 'against', why: '“Every task” takes in finished ones too, so the draft lists it. The brief says a task you have completed is not in the report, however late it was. Decided, and decided wrong.' },
  { id: 'no-date', name: 'An open task with no due date', spot: 'no-date', decides: false, draft: 'Not said', verdict: 'gap', why: 'The draft never mentions a task with no date. In SQL, comparing no date with today is never true, so one build leaves it out; in the browser, new Date(null) is 1 January 1970, before today, so another lists it. Both follow the draft. Ask Dana.' },
  { id: 'order', name: 'The order of the listed tasks', spot: 'order', decides: false, draft: 'Not said', verdict: 'gap', why: 'Nothing in the draft says which listed task comes first, so two builds that sort differently both follow it. Ask Dana.' },
];
export const CASE_ANSWERS = [
  { value: 'decides', label: 'It decides it' },
  { value: 'open', label: 'It leaves it open' },
] as const;
type CaseAnswer = (typeof CASE_ANSWERS)[number]['value'];
const VERDICT_MARK: Record<CaseVerdict, { status: 'passed' | 'failed' | 'survived'; label: string; tone: 'pass' | 'fail' | 'warn' }> = {
  agrees: { status: 'passed', label: 'Decided, as the brief says', tone: 'pass' },
  against: { status: 'failed', label: 'Decided against the brief', tone: 'fail' },
  gap: { status: 'survived', label: 'Gap: a tester must guess', tone: 'warn' },
};
const DAYS: readonly { spot: CaseSpot; day: string; before: boolean }[] = [
  { spot: 'three-days', day: '3 days ago', before: true },
  { spot: 'yesterday', day: 'Yesterday', before: true },
  { spot: 'today', day: 'Today', before: false },
];

/** The words of the overdue figure after `answers` (judged in OVERDUE_CASES order). */
export function overdueCasesText(answers: Readonly<Record<string, CaseAnswer>>): { said: string; next: string } {
  const judged = OVERDUE_CASES.filter((c) => answers[c.id]);
  const current = OVERDUE_CASES.find((c) => !answers[c.id]);
  const last = judged[judged.length - 1];
  const matched = (c: (typeof OVERDUE_CASES)[number]) => (answers[c.id] === 'decides') === c.decides;
  const said = last ? `${matched(last) ? 'Right' : 'Look again'}: ${last.why}` : '';
  if (current) {
    return { said, next: `Case ${judged.length + 1} of ${OVERDUE_CASES.length}: ${current.name.charAt(0).toLowerCase()}${current.name.slice(1)}. Does the draft decide what the report does with it?` };
  }
  const right = judged.filter(matched).length;
  return {
    said,
    next: `You judged ${right} of ${OVERDUE_CASES.length} as a tester would. The draft decides 3 cases, one of them against the brief, and leaves 2 open. Mend the wrong one and close both gaps before you submit: the review records a Pass only when ${GATE_RULE}, and a Pass opens Design.`,
  };
}

function OverdueCase({ c, answer, current }: { c: (typeof OVERDUE_CASES)[number]; answer?: CaseAnswer; current: boolean }) {
  const mark = answer ? VERDICT_MARK[c.verdict] : null;
  return (
    <div className="fig-rq-case" data-case={c.id} data-state={mark ? mark.tone : current ? 'current' : 'waiting'}>
      <strong>{c.name}</strong>
      {mark ? (
        <>
          <span className="fig-rq-case-draft">The draft: {c.draft.toLowerCase()}</span>
          <StatusMark status={mark.status} label={mark.label} />
          <span className="fig-rq-case-call">{(answer === 'decides') === c.decides ? 'Your call matched' : 'Your call differed'}</span>
        </>
      ) : current ? (
        <StatusMark status="current" label="Judging now" />
      ) : (
        <StatusMark status="not-run" label="Not judged yet" />
      )}
    </div>
  );
}

/** A date line with the five cases a tester asks about. Each case is judged
 * in turn (does the draft decide it?), then marked by what the brief says. */
/** How many judged cases carry each verdict: the tally beside the date line.
 * A case counts only once it is judged, so the tally never gives an answer
 * away before the learner has made the call. */
export function overdueTally(answers: Readonly<Record<string, CaseAnswer>>): { judged: number } & Record<CaseVerdict, number> {
  const judged = OVERDUE_CASES.filter((c) => answers[c.id]);
  const count = (v: CaseVerdict) => judged.filter((c) => c.verdict === v).length;
  return { judged: judged.length, agrees: count('agrees'), against: count('against'), gap: count('gap') };
}
const TALLY_ORDER: readonly CaseVerdict[] = ['agrees', 'against', 'gap'];

function PromiseChecklist() {
  const [answers, setAnswers] = useState<Record<string, CaseAnswer>>({});
  const [focusTo, setFocusTo] = useState(false);
  const judge = useRef<HTMLDivElement>(null);
  const current = OVERDUE_CASES.find((c) => !answers[c.id]);
  const { said, next } = overdueCasesText(answers);
  const tally = overdueTally(answers);
  // The last answer swaps the two answer buttons for Start again, and Start
  // again swaps them back: the first button of the new pair takes the focus.
  useEffect(() => {
    if (focusTo) { judge.current?.querySelector('button')?.focus(); setFocusTo(false); }
  }, [focusTo]);
  const answer = (value: CaseAnswer) => {
    if (!current) return;
    setAnswers((all) => ({ ...all, [current.id]: value }));
    if (OVERDUE_CASES.filter((c) => !answers[c.id]).length === 1) setFocusTo(true);
  };
  const byId = (spot: CaseSpot) => OVERDUE_CASES.find((c) => c.spot === spot)!;
  const caseAt = (spot: CaseSpot) => {
    const c = byId(spot);
    return <OverdueCase c={c} answer={answers[c.id]} current={current?.id === c.id} />;
  };
  return (
    <Figure
      title="Read a draft as a tester would"
      howTo="For each case on the line, say whether the draft decides it. The figure then marks it against the brief."
      model="A teaching model on an illustrative draft, not a story to copy. The review in the Requirements room is what records a result."
    >
      <p className="fig-rq-draft"><span className="fig-label">Illustrative draft</span> “{OVERDUE_DRAFT}”</p>
      <div className="fig-rq-dateline-box">
        <ol className="fig-rq-dateline" aria-label="Five cases on a date line, and the tally so far">
          {DAYS.map((d) => (
            <li key={d.spot} className="fig-rq-day" data-before={d.before ? 'true' : undefined}>
              {caseAt(d.spot)}
              <span className="fig-rq-rail" data-end={d.spot === 'today' ? 'true' : undefined} aria-hidden="true"><span /></span>
              <span className="fig-rq-date">{d.day}</span>
            </li>
          ))}
          <li className="fig-rq-off">
            {caseAt('no-date')}
            <span className="fig-rq-date">No due date: no place on the line</span>
          </li>
          <li className="fig-rq-order">
            <span className="fig-rq-bracket" aria-hidden="true" />
            <span className="fig-rq-date">Before today: what the draft lists</span>
            {caseAt('order')}
          </li>
          {/* The right half under Today and No due date: what the judged
              cases add up to, so the one decided against the brief shows at
              a glance. */}
          <li className="fig-rq-tally" data-testid="checklist-tally">
            <span className="fig-label">Judged so far: {tally.judged} of {OVERDUE_CASES.length}</span>
            <ul>
              {TALLY_ORDER.map((v) => (
                <li key={v} data-tally={v}>
                  <span className="fig-rq-tally-n">{tally[v]}</span>
                  <StatusMark status={VERDICT_MARK[v].status} label={VERDICT_MARK[v].label} />
                </li>
              ))}
            </ul>
          </li>
        </ol>
      </div>
      <div className="fig-live" aria-live="polite" data-testid="checklist-live">
        {said && <p data-testid="checklist-said">{said}</p>}
        <p data-testid="checklist-next">{next}</p>
      </div>
      <div className="fig-row fig-rq-judge" ref={judge} role="group" aria-label={current ? 'Does the draft decide this case?' : 'All five cases judged'}>
        {current ? (
          CASE_ANSWERS.map((a) => (
            <button key={a.value} type="button" className="fig-button" onClick={() => answer(a.value)}>{a.label}</button>
          ))
        ) : (
          <button type="button" className="fig-button" onClick={() => { setAnswers({}); setFocusTo(true); }}>Start again</button>
        )}
      </div>
    </Figure>
  );
}

/** One line per figure. Chapters are numbered as the reader shows them (1 to 4). */
export const REQUIREMENTS_FIGURES: PhaseFigures = {
  'requirements-fact-sorter': { chapter: 1, component: FactSorter },
  'requirements-purpose-hierarchy': { chapter: 2, component: PurposeTree },
  'requirements-criterion-tester': { chapter: 3, component: CriterionTester },
  'requirements-promise-checklist': { chapter: 4, component: PromiseChecklist },
};
