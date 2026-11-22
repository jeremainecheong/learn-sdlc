'use client';

/**
 * The runbook as forms: Environment, Health checks, Rollback,
 * Data, the Incident and Notes, each list with Add and Remove and the
 * rollback with Move up and Move down. In a phase that drills, the incident
 * is written from the drill page and shown read-only here. "Check the
 * runbook" lists the floor in words, in an editable tab only. Every field
 * and list stops at its cap, so the save it feeds is never refused. No file
 * name is shown. A stored record that cannot be read is drawn as empty,
 * read-only forms, and only a confirmed "Start empty" replaces it, through
 * the same save as every edit.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  RUNBOOK_CAPS, RUNBOOK_LISTS, EMPTY_RUNBOOK, evaluateRunbookFloor, runbookFloorSentence, serialiseRunbook,
  type PhaseDetail, type Runbook, type RunbookList,
} from '@learnsdlc/shared';
import { Button, Chip, Notice, Panel, SectionHead } from '@/components/ui';
import { AutoText, CELL, Line } from '../design/cells';
import { addRunbookItem, addTimeline, clockToSecond, isInstant, listFull, moveRollback, readRunbookText, removeRunbookItem, removeTimeline, setIncident, setRunbookField, setTimeline } from './runbook-edit';
import { olderRecordSentence } from '../../records';
import { FloorResults } from '../floor-checks';

/**
 * The box each section sits in: the inner padding and row spacing of the change
 * request's forms and the design room's record forms (`FORM_PANEL`). `Panel`
 * draws the border and no padding.
 */
const SECTION_PANEL = 'flex flex-col gap-3 p-3.5';
const TITLE: Record<RunbookList, string> = { environment: 'Environment', health: 'Health checks', rollback: 'Rollback', data: 'Data' };
/** An entry's name on the form by its place in its list; its key (E1, H1, R1, D1) is the name's title. */
const ITEM: Record<RunbookList, string> = { environment: 'Environment entry', health: 'Health check', rollback: 'Rollback step', data: 'Data entry' };
/**
 * Where the incident comes from in a phase that drills: the incident is written when the drill is resolved, from the
 * workspace's Pipeline tab or from the drill page alike, so the sentence names neither.
 */
export const RUNBOOK_INCIDENT_WRITTEN = 'Written when you resolve INCIDENT-1 in the drill.';
const FULL: Record<RunbookList, string> = { environment: 'Environment holds its 20 entries.', health: 'Health checks holds its 20 checks.', rollback: 'Rollback holds its 20 steps.', data: 'Data holds its 20 entries.' };
const FIELDS: Record<RunbookList, { key: string; label: string }[]> = {
  environment: [{ key: 'name', label: 'Name' }, { key: 'purpose', label: 'What it controls' }, { key: 'example', label: 'Example' }],
  health: [{ key: 'name', label: 'Name' }, { key: 'how', label: 'Command' }, { key: 'expected', label: 'Expected output' }],
  rollback: [{ key: 'step', label: 'Step' }, { key: 'verify', label: 'How to verify' }],
  data: [{ key: 'what', label: 'What is kept' }, { key: 'how', label: 'How' }, { key: 'where', label: 'Where' }, { key: 'retention', label: 'Kept for' }],
};

export function RunbookTab({ detail, text, onChange, editable, assisted, drillHref }: {
  /** Only the key, the kind and the runbook spec are read, so the builder passes its own object. */
  detail: Pick<PhaseDetail, 'key' | 'artifactKind' | 'runbook'>; text: string; onChange: (text: string) => void; editable: boolean; assisted?: Set<string>; drillHref?: string;
}) {
  const [round, setRound] = useState(0);
  const [asking, setAsking] = useState(false);
  const read = useMemo(() => readRunbookText(text), [text]);
  const runbook = read.runbook;
  // Over a stored record that cannot be read the forms are read-only, so a
  // keystroke never writes over it; only the confirmed Start empty replaces it.
  const writable = editable && !read.error;
  const spec = detail.runbook;
  // A Deployment of the config kind with no runbook is an older-format version: its sentence in place of the forms.
  if (!spec) {
    const older = olderRecordSentence(detail);
    return older ? <Notice tone="info" testId="runbook-older-format">{older}</Notice> : null;
  }
  // A form's write is refused unless the tab is writable, whatever event reaches it.
  const write = (next: Runbook) => { if (writable) onChange(serialiseRunbook(next)); };
  const drill = spec.drill;
  const chip = (key: string, testId: string) => (assisted?.has(key) ? <Chip tone="accent" testId={testId}>changed by the assistant</Chip> : null);
  const mark = (list: string, at: number, id: string, key: string) => chip(`${list}:${id}:${key}`, `runbook-${list}-${at}-${key}-assisted`);
  const results = evaluateRunbookFloor(text, spec.floor);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="runbook-tab">
      <p className="wrap text-[13px] leading-[1.5] text-ink2" data-testid="runbook-floor-sentence">{`To pass, the runbook needs ${runbookFloorSentence(spec.floor)}.`}</p>
      {read.error && (
        <Notice tone="warn" testId="runbook-unreadable">
          {`The runbook cannot be read (${read.error.charAt(0).toLowerCase()}${read.error.slice(1)}). The forms show an empty runbook and are read-only, so nothing is written over what is stored.`}
          {editable && !asking && <Button size="sm" variant="secondary" testId="runbook-start-empty" onClick={() => setAsking(true)}>Start empty</Button>}
        </Notice>
      )}
      {read.error && editable && asking && (
        <div className="flex flex-col gap-2" role="group" aria-label="Start empty">
          <p className="label-sm wrap" data-testid="runbook-start-empty-line">
            This replaces the stored runbook with an empty one: no environment entries, health checks, rollback steps or data entries, and no incident.
          </p>
          <span className="flex gap-2">
            <Button size="sm" variant="danger" testId="runbook-start-empty-confirm" onClick={() => { setAsking(false); onChange(serialiseRunbook(EMPTY_RUNBOOK)); }}>Start empty</Button>
            <Button size="sm" variant="ghost" testId="runbook-start-empty-keep" onClick={() => setAsking(false)}>Keep it</Button>
          </span>
        </div>
      )}
      {RUNBOOK_LISTS.map((list) => (
        <Panel key={list} className={SECTION_PANEL} testId={`runbook-section-${list}`}>
          <SectionHead title={TITLE[list]} />
          {runbook[list].map((item, at) => (
            <div key={item.id} className="flex flex-col gap-1.5 border-b-1.5 border-edge pb-2" data-testid={`runbook-${list}-${at}`}>
              <span className="text-[12.5px] font-semibold text-ink" title={item.id}>{`${ITEM[list]} ${at + 1}`}</span>
              {list === 'environment' && (
                <Line label="Kind" htmlFor={`runbook-${list}-${at}-kind`}>
                  <select id={`runbook-${list}-${at}-kind`} className={CELL} disabled={!writable} value={(item as { kind: string }).kind}
                    data-testid={`runbook-${list}-${at}-kind`} onChange={(e) => write(setRunbookField(runbook, list, at, 'kind', e.target.value))}>
                    <option value="config">Configuration</option>
                    <option value="secret">Secret</option>
                  </select>
                  {mark(list, at, item.id, 'kind')}
                </Line>
              )}
              {FIELDS[list].map(({ key, label }) => (
                <Line key={key} label={label} htmlFor={`runbook-${list}-${at}-${key}`}>
                  <AutoText id={`runbook-${list}-${at}-${key}`} className={CELL} maxLength={RUNBOOK_CAPS.fieldChars} readOnly={!writable}
                    data-testid={`runbook-${list}-${at}-${key}`} value={String((item as unknown as Record<string, unknown>)[key] ?? '')}
                    onChange={(e) => write(setRunbookField(runbook, list, at, key, e.currentTarget.value))} />
                  {mark(list, at, item.id, key)}
                </Line>
              ))}
              {writable && (
                <span className="flex gap-2">
                  {list === 'rollback' && <Button size="sm" variant="ghost" testId={`runbook-rollback-${at}-up`} disabled={at === 0} onClick={() => write(moveRollback(runbook, at, -1))}>Move up</Button>}
                  {list === 'rollback' && <Button size="sm" variant="ghost" testId={`runbook-rollback-${at}-down`} disabled={at === runbook.rollback.length - 1} onClick={() => write(moveRollback(runbook, at, 1))}>Move down</Button>}
                  <Button size="sm" variant="ghost" testId={`runbook-${list}-${at}-remove`} onClick={() => write(removeRunbookItem(runbook, list, at))}>{`Remove ${ITEM[list].toLowerCase()} ${at + 1}`}</Button>
                </span>
              )}
            </div>
          ))}
          {list === 'rollback' && chip('rollback:order', 'runbook-rollback-order-assisted')}
          {writable && <Button size="sm" variant="secondary" className="self-start" testId={`runbook-add-${list}`} disabled={listFull(runbook, list)} onClick={() => write(addRunbookItem(runbook, list))}>Add</Button>}
          {listFull(runbook, list) && <p className="label-sm" data-testid={`runbook-full-${list}`}>{`${FULL[list]} Remove one to add another.`}</p>}
        </Panel>
      ))}
      <Panel className={SECTION_PANEL} testId="runbook-section-incident">
        <SectionHead title="Incident" />
        {drill && (
          <p className="label-sm wrap" data-testid="runbook-incident-from-drill">
            {RUNBOOK_INCIDENT_WRITTEN} {drillHref && <Link href={drillHref} className="text-accent underline" data-testid="runbook-open-drill">Open the incident drill</Link>}
          </p>
        )}
        {(['rootCause', 'fix', 'actionItem'] as const).map((key) => (
          <Line key={key} label={key === 'rootCause' ? 'Root cause' : key === 'fix' ? 'Fix' : 'Action item'} htmlFor={`runbook-incident-${key}`}>
            <AutoText id={`runbook-incident-${key}`} className={CELL} maxLength={RUNBOOK_CAPS.fieldChars} readOnly={drill || !writable}
              data-testid={`runbook-incident-${key}`} value={runbook.incident[key]} onChange={(e) => write(setIncident(runbook, key, e.currentTarget.value))} />
            {chip(`incident:${key}`, `runbook-incident-${key}-assisted`)}
          </Line>
        ))}
        {(runbook.incident.timeline ?? []).map((entry, at) => (drill || !writable
          // A stored instant reads on the local clock, as the drill page says its times; the machine value stays in `dateTime`.
          ? <p key={at} className="label-sm" data-testid={`runbook-incident-timeline-${at}`}>{isInstant(entry.at) ? <time dateTime={entry.at}>{clockToSecond(entry.at)}</time> : entry.at}{` ${entry.event}`}</p>
          : (
            <span key={at} className="flex gap-2" data-testid={`runbook-incident-timeline-${at}`}>
              {/* Each row's inputs and Remove name their line, so no two controls share a label. */}
              <input className={CELL} aria-label={`When, line ${at + 1}`} maxLength={RUNBOOK_CAPS.timelineAt} value={entry.at} onChange={(e) => write(setTimeline(runbook, at, 'at', e.currentTarget.value))} />
              <input className={CELL} aria-label={`What happened, line ${at + 1}`} maxLength={RUNBOOK_CAPS.fieldChars} value={entry.event} onChange={(e) => write(setTimeline(runbook, at, 'event', e.currentTarget.value))} />
              <Button size="sm" variant="ghost" testId={`runbook-incident-timeline-${at}-remove`} ariaLabel={`Remove timeline line ${at + 1}`} onClick={() => write(removeTimeline(runbook, at))}>Remove</Button>
            </span>
          )))}
        {chip('incident:timeline', 'runbook-timeline-assisted')}
        {!drill && writable && (
          <Button size="sm" variant="secondary" className="self-start" testId="runbook-add-timeline" disabled={(runbook.incident.timeline ?? []).length >= RUNBOOK_CAPS.timeline} onClick={() => write(addTimeline(runbook))}>Add a timeline line</Button>
        )}
      </Panel>
      <Panel className={SECTION_PANEL} testId="runbook-section-notes">
        <SectionHead title="Notes" />
        <AutoText id="runbook-notes" aria-label="Notes" className={CELL} maxLength={RUNBOOK_CAPS.fieldChars} readOnly={!writable} data-testid="runbook-notes" value={runbook.notes ?? ''}
          onChange={(e) => write({ ...runbook, notes: e.currentTarget.value.slice(0, RUNBOOK_CAPS.fieldChars) })} />
        {chip('notes', 'runbook-notes-assisted')}
      </Panel>
      {/* A read-only tab (the learner preview) draws no button: checking is the learner's own step. */}
      {editable && <Button size="sm" className="self-start" testId="runbook-check" onClick={() => setRound((n) => n + 1)}>Check the runbook</Button>}
      {/* Each rule ticked when it passes, in view after each press: the change request's check draws the same rows. */}
      {editable && round > 0 && (
        <FloorResults results={results} listTestId="runbook-checks" rowTestId={(id) => `runbook-check-${id}`} round={round} />
      )}
    </div>
  );
}
