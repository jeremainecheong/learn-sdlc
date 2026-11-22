'use client';

/**
 * The change request as forms, one per tab: the ticket read-only
 * beside the impact chips; the declared contract amendments; the tests, each
 * with a covers picker over the ticket's acceptance ids; the release with its
 * change lines, rollback, risks and notes. Every field and list stops at its
 * cap. No file name of the record is shown.
 */
import { useState } from 'react';
import {
  CHANGE_CAPS, CHANGE_TEST_RESULTS, CONTRACT_CHANGE_KINDS, IMPACT_LISTS, changeFloorSentence, evaluateChangeFloor,
  type ChangeFloorSpec, type ChangeRequest, type ChangeTestResult, type ChangeTicket, type ImpactList, type PhaseDetail,
} from '@learnsdlc/shared';
import { Button, Chip, Notice, Panel, SectionHead, type Tone } from '@/components/ui';
import { olderRecordSentence } from '../../records';
import { AutoText, CELL, Line, TextLine } from '../design/cells';
import { addAmendment, addChangeLine, addImpact, addTest, removeImpact, removeItem, setItemField, setRelease, setRisks, toggleCover } from './change-edit';
import { FloorResults } from '../floor-checks';

const IMPACT_TITLE: Record<ImpactList, string> = { operations: 'Operations', screens: 'Screens', files: 'Files' };
/**
 * The box every form on this page sits in: the inner padding and the spacing
 * between its rows that the design room's record forms and its floor panel
 * use (`p-3.5`, `gap-3`). `Panel` draws the border and no padding, so a form
 * that passes no class here has its words against the rounded border and its
 * Add button on the box's bottom edge.
 */
export const FORM_PANEL = 'flex flex-col gap-3 p-3.5';
/**
 * "changed by the assistant" beside a field an applied proposal wrote, while it still holds that text (`liveChangeMarks`).
 * A chip the width of its words: in a column of rows it would otherwise stretch into a bar across the form.
 */
const Mark = ({ assisted, at }: { assisted?: Set<string>; at: string }) =>
  (assisted?.has(at) ? <Chip tone="accent" className="self-start" testId={`change-assisted-${at}`}>changed by the assistant</Chip> : null);
/**
 * A list item's name on the form: "Test 1", "Change line 1", "Amendment 1", by its place in the list. The record's
 * key (T1, L1, C1) is a handle, not a name, so it is the label's title, not its text.
 */
const ItemName = ({ noun, at, id }: { noun: string; at: number; id: string }) => (
  <span className="text-[12.5px] font-semibold text-ink" title={id}>{`${noun} ${at + 1}`}</span>
);

/**
 * A Maintenance of the code kind whose detail carries no change request (an
 * older-format version): its sentence, with Check and Submit drawn
 * off and the sentence as their reason, since the API refuses both. Drawn by
 * the change room, which then has no Contract tab, so no claim about an
 * operation the Request tab adds is made; its Checks tab stays, read-only, with
 * Submit off. Nothing for any other detail.
 */
export function ChangeRoomOlderNotice({ detail }: { detail: Pick<PhaseDetail, 'key' | 'artifactKind' | 'runbook' | 'change'> }) {
  const sentence = olderRecordSentence(detail);
  if (!sentence) return null;
  return (
    <Notice tone="info" testId="change-older-format">
      <div className="flex flex-col gap-2">
        <span className="wrap">{sentence}</span>
        <span className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" testId="change-older-check" disabled reason={sentence}>Run regression tests</Button>
          <Button size="sm" testId="change-older-submit" disabled reason={sentence}>Submit</Button>
        </span>
      </div>
    </Notice>
  );
}

/**
 * A stored change request that cannot be read: the forms are read-only, so no
 * keystroke writes over it, and "Start empty" replaces it with the empty record
 * after a confirm line, as the builders' "Start empty" does. Offered only where
 * the record is mounted editable, the one place a save can write it.
 */
export function ChangeRecordUnreadable({ error, canStartEmpty, onStartEmpty }: { error: string; canStartEmpty: boolean; onStartEmpty: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <Notice tone="fail" testId="change-record-unreadable">
      <div className="flex flex-col gap-2">
        <span className="wrap">{/* The validator's sentence reads inside the parentheses, so it starts in lower case there. */}{`The change request cannot be read (${error.charAt(0).toLowerCase()}${error.slice(1)}). The forms are read-only until it can be read again${canStartEmpty ? ', or until you start it empty' : ''}.`}</span>
        {canStartEmpty && !asking && (
          <span><Button size="sm" variant="secondary" testId="change-start-empty" onClick={() => setAsking(true)}>Start empty</Button></span>
        )}
        {canStartEmpty && asking && (
          <div role="group" aria-label="Start empty" className="flex flex-col gap-1.5">
            <p className="label-sm wrap" data-testid="change-start-empty-line">This replaces the change request with an empty one: no impact, no amendments, no tests and no release. What it holds now is lost.</p>
            <span className="flex flex-wrap gap-2">
              <Button size="sm" variant="danger" testId="change-start-empty-confirm" onClick={() => { setAsking(false); onStartEmpty(); }}>Start empty</Button>
              <Button size="sm" variant="ghost" testId="change-start-empty-keep" onClick={() => setAsking(false)}>Keep it</Button>
            </span>
          </div>
        )}
      </div>
    </Notice>
  );
}

/**
 * What the change request needs to pass, and "Check the change request" listing every rule with its sentence (spec
 * 10: the checks panels in words), each row ticked when it passes and brought into view on each press.
 * "The floor" is the teacher's word for it; the learner reads what it asks.
 */
export function ChangeFloorCheck({ text, spec }: { text: string; spec: ChangeFloorSpec }) {
  const [round, setRound] = useState(0);
  return (
    <Panel className={FORM_PANEL} testId="change-floor">
      <p className="wrap text-[13px] leading-[1.5] text-ink2" data-testid="change-floor-sentence">{`To pass, the change request needs ${changeFloorSentence(spec.floor, spec.contract)}.`}</p>
      <Button size="sm" className="self-start" testId="change-check" onClick={() => setRound((n) => n + 1)}>Check the change request</Button>
      {round > 0 && (
        <FloorResults results={evaluateChangeFloor(text, spec)} listTestId="change-checks" rowTestId={(id) => `change-check-${id}`} round={round} />
      )}
    </Panel>
  );
}

function Covers({ ticket, covers, onToggle, editable, testId }: { ticket: ChangeTicket; covers: string[]; onToggle: (id: string) => void; editable: boolean; testId: string }) {
  return (
    <span className="flex flex-wrap gap-2" data-testid={testId}>
      {ticket.acceptance.map((a) => (
        <label key={a.id} className="label-sm">
          <input type="checkbox" aria-label={`Covers ${a.id}`} disabled={!editable || (!covers.includes(a.id) && covers.length >= CHANGE_CAPS.covers)} checked={covers.includes(a.id)} onChange={() => onToggle(a.id)} /> {a.id}
        </label>
      ))}
    </span>
  );
}

export function RequestForm({ ticket, change, files, editable, onChange, assisted }: { ticket: ChangeTicket; change: ChangeRequest; files: string[]; editable: boolean; onChange: (next: ChangeRequest) => void; assisted?: Set<string> }) {
  const [typed, setTyped] = useState<Record<ImpactList, string>>({ operations: '', screens: '', files: '' });
  // The phase's editable files the saved record does not list yet: offers to add, never entries of the record.
  const offers = files.filter((path) => !change.impact.files.includes(path));
  return (
    <div className="flex flex-col gap-4">
      <Panel className={FORM_PANEL} testId="change-ticket">
        <SectionHead title={`${ticket.id}: ${ticket.title}`} />
        <p className="wrap">{ticket.summary}</p>
        <ul className="flex flex-col gap-1">{ticket.acceptance.map((a) => <li key={a.id}>{`${a.id} ${a.line}`}</li>)}</ul>
      </Panel>
      {IMPACT_LISTS.map((list) => (
        <Panel key={list} className={FORM_PANEL} testId={`change-impact-${list}`}>
          <SectionHead title={IMPACT_TITLE[list]} />
          <Mark assisted={assisted} at={`impact:${list}`} />
          {/* What the saved change request lists, and only that: an empty list says so in words. */}
          <span className="flex flex-wrap gap-2" data-testid={`change-impact-${list}-listed`}>
            {change.impact[list].length === 0
              // "yet" only where an entry can still come: a record that can no longer be edited lists none, full stop.
              ? <span className="label-sm">{editable ? 'None listed yet.' : 'None listed.'}</span>
              : change.impact[list].map((entry, at) => (
                <Chip key={entry} tone="neutral">{entry}{editable && <button type="button" aria-label={`Remove ${entry}`} onClick={() => onChange(removeImpact(change, list, at))}>x</button>}</Chip>
              ))}
          </span>
          {editable && list === 'files' && offers.length > 0 && (
            <div role="group" aria-label="Files this phase can change" className="flex flex-col gap-1.5" data-testid="change-impact-files-offers">
              <span className="label-sm">Files this phase can change. Press one to list it.</span>
              <span className="flex flex-wrap gap-2">
                {offers.map((path) => (
                  <Button key={path} size="sm" variant="ghost" icon="plus" testId={`change-impact-files-offer-${path}`} onClick={() => onChange(addImpact(change, 'files', path))}>{path}</Button>
                ))}
              </span>
            </div>
          )}
          {editable && (
            <form className="flex flex-wrap items-start gap-2" onSubmit={(e) => { e.preventDefault(); onChange(addImpact(change, list, typed[list])); setTyped({ ...typed, [list]: '' }); }}>
              <input className={`${CELL} min-w-[160px] flex-1`} aria-label={`Add to ${IMPACT_TITLE[list]}`} maxLength={CHANGE_CAPS.fieldChars} value={typed[list]} data-testid={`change-impact-${list}-input`}
                disabled={change.impact[list].length >= CHANGE_CAPS.listItems} onChange={(e) => setTyped({ ...typed, [list]: e.target.value })} />
              {/* a submit button: `Button`'s type defaults to "button" (`Button` in `components/ui/index.tsx`), which would submit nothing */}
              <Button size="sm" variant="secondary" type="submit" testId={`change-impact-${list}-add`} disabled={change.impact[list].length >= CHANGE_CAPS.listItems}>Add</Button>
            </form>
          )}
        </Panel>
      ))}
    </div>
  );
}

export function AmendmentsForm({ change, editable, onChange, assisted }: { change: ChangeRequest; editable: boolean; onChange: (next: ChangeRequest) => void; assisted?: Set<string> }) {
  return (
    <Panel className={FORM_PANEL} testId="change-amendments">
      <SectionHead title="Contract amendments" />
      {change.contract.map((c, at) => (
        <div key={c.id} data-testid={`change-amendment-${at}`} className="flex flex-col gap-1.5">
          <ItemName noun="Amendment" at={at} id={c.id} />
          <Line label="Method" htmlFor={`change-amendment-${at}-method`}><input id={`change-amendment-${at}-method`} className={CELL} maxLength={CHANGE_CAPS.method} readOnly={!editable} value={c.method} onChange={(e) => onChange(setItemField(change, 'contract', at, 'method', e.target.value))} /></Line>
          <Line label="Path" htmlFor={`change-amendment-${at}-path`}><input id={`change-amendment-${at}-path`} className={CELL} maxLength={CHANGE_CAPS.fieldChars} readOnly={!editable} value={c.path} data-testid={`change-amendment-${at}-path`} onChange={(e) => onChange(setItemField(change, 'contract', at, 'path', e.target.value))} /></Line>
          <Line label="Change" htmlFor={`change-amendment-${at}-change`}>
            <select id={`change-amendment-${at}-change`} className={CELL} disabled={!editable} value={c.change} onChange={(e) => onChange(setItemField(change, 'contract', at, 'change', e.target.value))}>
              {CONTRACT_CHANGE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
          </Line>
          <Mark assisted={assisted} at={`contract:${c.id}:path`} />
          <Line label="Why" htmlFor={`change-amendment-${at}-why`}><AutoText id={`change-amendment-${at}-why`} className={CELL} maxLength={CHANGE_CAPS.fieldChars} readOnly={!editable} value={c.why} onChange={(e) => onChange(setItemField(change, 'contract', at, 'why', e.target.value))} /><Mark assisted={assisted} at={`contract:${c.id}:why`} /></Line>
          {editable && <Button size="sm" variant="ghost" className="self-start" onClick={() => onChange(removeItem(change, 'contract', at))}>{`Remove amendment ${at + 1}`}</Button>}
        </div>
      ))}
      {editable && <Button size="sm" variant="secondary" className="self-start" testId="change-amendment-add" disabled={change.contract.length >= CHANGE_CAPS.listItems} onClick={() => onChange(addAmendment(change))}>Add an amendment</Button>}
    </Panel>
  );
}

/** A test's result in the room's words, and its chip's tone where the form is read-only. */
const RESULT_WORD: Record<ChangeTestResult, string> = { 'not-run': 'Not run', pass: 'Passes', fail: 'Fails' };
const RESULT_TONE: Record<ChangeTestResult, Tone> = { 'not-run': 'neutral', pass: 'pass', fail: 'fail' };

export function TestsForm({ ticket, change, editable, onChange, assisted }: { ticket: ChangeTicket; change: ChangeRequest; editable: boolean; onChange: (next: ChangeRequest) => void; assisted?: Set<string> }) {
  return (
    <Panel className={FORM_PANEL} testId="change-tests">
      <SectionHead title="Tests" />
      {change.tests.map((t, at) => (
        <div key={t.id} data-testid={`change-test-${at}`} className="flex flex-col gap-1.5">
          <ItemName noun="Test" at={at} id={t.id} />
          <Line label="Suite" htmlFor={`change-test-${at}-suite`}><input id={`change-test-${at}-suite`} className={CELL} maxLength={CHANGE_CAPS.fieldChars} readOnly={!editable} value={t.suite} data-testid={`change-test-${at}-suite`} onChange={(e) => onChange(setItemField(change, 'tests', at, 'suite', e.target.value))} /></Line>
          <Mark assisted={assisted} at={`tests:${t.id}:suite`} />
          <Covers ticket={ticket} covers={t.covers} editable={editable} testId={`change-test-${at}-covers`} onToggle={(id) => onChange(toggleCover(change, 'tests', at, id))} />
          <Mark assisted={assisted} at={`tests:${t.id}:covers`} />
          {editable ? (
            <Line label="Result" htmlFor={`change-test-${at}-result`}>
              <select id={`change-test-${at}-result`} className={CELL} value={t.result} onChange={(e) => onChange(setItemField(change, 'tests', at, 'result', e.target.value))}>
                {CHANGE_TEST_RESULTS.map((r) => <option key={r} value={r}>{RESULT_WORD[r]}</option>)}
              </select>
            </Line>
          ) : (
            // Read-only, the result is text in the room's words, not a disabled select.
            <TextLine label="Result"><Chip tone={RESULT_TONE[t.result]} testId={`change-test-${at}-result`}>{RESULT_WORD[t.result]}</Chip></TextLine>
          )}
          {editable && <Button size="sm" variant="ghost" className="self-start" onClick={() => onChange(removeItem(change, 'tests', at))}>{`Remove test ${at + 1}`}</Button>}
        </div>
      ))}
      {editable && <Button size="sm" variant="secondary" className="self-start" testId="change-test-add" disabled={change.tests.length >= CHANGE_CAPS.listItems} onClick={() => onChange(addTest(change))}>Add a test</Button>}
    </Panel>
  );
}

export function ReleaseForm({ ticket, change, editable, onChange, assisted }: { ticket: ChangeTicket; change: ChangeRequest; editable: boolean; onChange: (next: ChangeRequest) => void; assisted?: Set<string> }) {
  const r = change.release;
  return (
    <Panel className={FORM_PANEL} testId="change-release">
      <SectionHead title="Release" />
      <Line label="Version" htmlFor="change-release-version"><input id="change-release-version" className={CELL} maxLength={CHANGE_CAPS.version} readOnly={!editable} value={r.version} data-testid="change-release-version" onChange={(e) => onChange(setRelease(change, 'version', e.target.value))} /><Mark assisted={assisted} at="release:version" /></Line>
      <Line label="Summary" htmlFor="change-release-summary"><AutoText id="change-release-summary" className={CELL} maxLength={CHANGE_CAPS.fieldChars} readOnly={!editable} value={r.summary} data-testid="change-release-summary" onChange={(e) => onChange(setRelease(change, 'summary', e.target.value))} /><Mark assisted={assisted} at="release:summary" /></Line>
      {r.changes.map((l, at) => (
        <div key={l.id} data-testid={`change-line-${at}`} className="flex flex-col gap-1.5">
          <ItemName noun="Change line" at={at} id={l.id} />
          <AutoText className={CELL} aria-label={`Change line ${at + 1}`} maxLength={CHANGE_CAPS.fieldChars} readOnly={!editable} value={l.line} data-testid={`change-line-${at}-line`} onChange={(e) => onChange(setItemField(change, 'changes', at, 'line', e.target.value))} />
          <Mark assisted={assisted} at={`changes:${l.id}:line`} />
          <Covers ticket={ticket} covers={l.covers} editable={editable} testId={`change-line-${at}-covers`} onToggle={(id) => onChange(toggleCover(change, 'changes', at, id))} />
          <Mark assisted={assisted} at={`changes:${l.id}:covers`} />
          {editable && <Button size="sm" variant="ghost" className="self-start" onClick={() => onChange(removeItem(change, 'changes', at))}>{`Remove change line ${at + 1}`}</Button>}
        </div>
      ))}
      {editable && <Button size="sm" variant="secondary" className="self-start" testId="change-line-add" disabled={r.changes.length >= CHANGE_CAPS.listItems} onClick={() => onChange(addChangeLine(change))}>Add a change line</Button>}
      <Line label="Rollback" htmlFor="change-release-rollback"><AutoText id="change-release-rollback" className={CELL} maxLength={CHANGE_CAPS.fieldChars} readOnly={!editable} value={r.rollback} data-testid="change-release-rollback" onChange={(e) => onChange(setRelease(change, 'rollback', e.target.value))} /><Mark assisted={assisted} at="release:rollback" /></Line>
      <Line label="Risks, one per line" htmlFor="change-release-risks"><AutoText id="change-release-risks" className={CELL} readOnly={!editable} value={(r.risks ?? []).join('\n')} onChange={(e) => onChange(setRisks(change, e.target.value))} /><Mark assisted={assisted} at="release:risks" /></Line>
      <Line label="Notes" htmlFor="change-notes"><AutoText id="change-notes" className={CELL} maxLength={CHANGE_CAPS.fieldChars} readOnly={!editable} value={change.notes ?? ''} data-testid="change-notes" onChange={(e) => onChange({ ...change, notes: e.target.value.slice(0, CHANGE_CAPS.fieldChars) })} /><Mark assisted={assisted} at="notes" /></Line>
    </Panel>
  );
}
