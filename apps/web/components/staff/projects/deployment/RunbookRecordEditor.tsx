'use client';

/**
 * The starting runbook as the teacher edits it in the Deployment builder.
 *
 * The learner's Runbook tab (`RunbookTab`) draws every entry as a long flat
 * form whose repeated Add and Remove say nothing of the entry they act on, and
 * whose Data fields are called "How" and "Where". This editor writes the same
 * record through the same pure edits (`runbook-edit`) and the same save, with
 * the teacher's layout: each environment variable, health check, rollback step
 * and data entry is a named card that folds ("Environment E2 · API_URL"), its
 * Add and Remove say which entry ("Remove API_URL", "Add an environment
 * variable"), and each field says what it expects with a short example. The
 * field ids and test ids are the tab's, so a
 * record reads the same on both.
 */
import { useMemo, useState } from 'react';
import {
  EMPTY_RUNBOOK,
  RUNBOOK_CAPS,
  RUNBOOK_INCIDENT_FROM_DRILL,
  RUNBOOK_LISTS,
  evaluateRunbookFloor,
  runbookFloorSentence,
  serialiseRunbook,
  type Runbook,
  type RunbookFloor,
  type RunbookList,
} from '@learnsdlc/shared';
import { Button, Notice, Panel, SectionHead } from '@/components/ui';
import { AutoText, CELL, Line } from '@/components/workspace/panels/design/cells';
import {
  addRunbookItem,
  addTimeline,
  listFull,
  moveRollback,
  readRunbookText,
  removeRunbookItem,
  removeTimeline,
  setIncident,
  setRunbookField,
  setTimeline,
} from '@/components/workspace/panels/deployment/runbook-edit';

const TITLE: Record<RunbookList, string> = {
  environment: 'Environment',
  health: 'Health checks',
  rollback: 'Rollback',
  data: 'Data',
};
/** What one entry of the list is called, for its Add and its empty name. */
const ONE: Record<RunbookList, string> = {
  environment: 'environment variable',
  health: 'health check',
  rollback: 'rollback step',
  data: 'data entry',
};
const ADD: Record<RunbookList, string> = {
  environment: 'Add an environment variable',
  health: 'Add a health check',
  rollback: 'Add a rollback step',
  data: 'Add a data entry',
};
const FULL: Record<RunbookList, string> = {
  environment: 'Environment holds its 20 entries.',
  health: 'Health checks holds its 20 checks.',
  rollback: 'Rollback holds its 20 steps.',
  data: 'Data holds its 20 entries.',
};
/** Each field with what it expects, in the teacher's words, and one short example. */
const RUNBOOK_FIELDS: Record<RunbookList, { key: string; label: string; example: string }[]> = {
  environment: [
    { key: 'name', label: 'Variable name', example: 'For example API_URL' },
    { key: 'purpose', label: 'What it controls', example: 'For example where the web app finds the API' },
    { key: 'example', label: 'Example value', example: 'For example http://api:8000' },
  ],
  health: [
    { key: 'name', label: 'Check name', example: 'For example API health check' },
    { key: 'how', label: 'Command to run', example: 'For example curl -f http://localhost:8000/api/health' },
    { key: 'expected', label: 'Expected output', example: 'For example {"status": "ok"} and exit code 0' },
  ],
  rollback: [
    { key: 'step', label: 'Step', example: 'For example redeploy the previous image tag' },
    { key: 'verify', label: 'How to verify it worked', example: 'For example the health check passes again' },
  ],
  data: [
    { key: 'what', label: 'What is kept', example: 'For example the SQLite database file' },
    { key: 'how', label: 'How the backup is made', example: 'For example a nightly copy of the file' },
    { key: 'where', label: 'Where it is kept', example: 'For example a separate storage volume' },
    { key: 'retention', label: 'How long copies are kept', example: 'For example 14 days' },
  ],
};

/** "API_URL", or "health check H2" while the entry has no name yet. */
export function runbookItemName(list: RunbookList, item: Record<string, unknown>): string {
  const named = String((list === 'rollback' ? item.step : list === 'data' ? item.what : item.name) ?? '').trim();
  const short = named.length > 40 ? `${named.slice(0, 39)}…` : named;
  return short || `${ONE[list]} ${String(item.id ?? '')}`.trim();
}

export function RunbookRecordEditor({
  floor,
  drill = false,
  text,
  onChange,
  editable,
}: {
  floor: RunbookFloor;
  /** A phase that drills: the incident is the learner's, written from the drill page, so it is read-only here. */
  drill?: boolean;
  text: string;
  onChange: (text: string) => void;
  editable: boolean;
}) {
  const read = useMemo(() => readRunbookText(text), [text]);
  const runbook = read.runbook;
  const writable = editable && !read.error;
  const [asking, setAsking] = useState(false);
  // The teacher's own check of the starting runbook against the floor, as the
  // learner's tab offers it: pass or not yet, per floor row, on the record as
  // it now stands.
  const [checked, setChecked] = useState(false);
  const results = evaluateRunbookFloor(text, floor);
  const write = (next: Runbook) => {
    if (writable) onChange(serialiseRunbook(next));
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="runbook-tab">
      <p className="label-sm wrap">{`The floor asks for ${runbookFloorSentence(floor)}.`}</p>
      {read.error && (
        <Notice tone="warn" testId="runbook-unreadable">
          {`The runbook cannot be read (${read.error.charAt(0).toLowerCase()}${read.error.slice(1)}). The forms show an empty runbook and are read-only, so nothing is written over what is stored.`}
          {editable && !asking && (
            <Button size="sm" variant="secondary" testId="runbook-start-empty" onClick={() => setAsking(true)}>
              Start empty
            </Button>
          )}
        </Notice>
      )}
      {read.error && editable && asking && (
        <div className="flex flex-col gap-2" role="group" aria-label="Start empty">
          <p className="label-sm wrap" data-testid="runbook-start-empty-line">
            This replaces the stored runbook with an empty one: no environment entries, health checks, rollback steps or
            data entries, and no incident.
          </p>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              testId="runbook-start-empty-confirm"
              onClick={() => {
                setAsking(false);
                onChange(serialiseRunbook(EMPTY_RUNBOOK));
              }}
            >
              Start empty
            </Button>
            <Button size="sm" variant="ghost" testId="runbook-start-empty-keep" onClick={() => setAsking(false)}>
              Keep it
            </Button>
          </span>
        </div>
      )}
      {RUNBOOK_LISTS.map((list) => (
        <Panel key={list} testId={`runbook-section-${list}`}>
          <SectionHead title={TITLE[list]} />
          {runbook[list].length === 0 && <p className="label-sm">{`No ${ONE[list]} yet.`}</p>}
          {runbook[list].map((item, at) => {
            const name = runbookItemName(list, item as unknown as Record<string, unknown>);
            return (
              <details
                key={item.id}
                open
                className="min-w-0 rounded-ctl border-1.5 border-edge px-3 py-2"
                data-testid={`runbook-${list}-${at}`}
              >
                <summary className="cursor-pointer text-[13px] font-semibold text-ink" data-testid={`runbook-${list}-${at}-summary`}>
                  {`${TITLE[list]} ${item.id} · ${name}`}
                </summary>
                <div className="mt-2 flex min-w-0 flex-col gap-1.5">
                  {list === 'environment' && (
                    <Line label="Kind" htmlFor={`runbook-${list}-${at}-kind`}>
                      <select
                        id={`runbook-${list}-${at}-kind`}
                        className={CELL}
                        disabled={!writable}
                        value={(item as { kind: string }).kind}
                        data-testid={`runbook-${list}-${at}-kind`}
                        onChange={(e) => write(setRunbookField(runbook, list, at, 'kind', e.target.value))}
                      >
                        <option value="config">Configuration</option>
                        <option value="secret">Secret</option>
                      </select>
                    </Line>
                  )}
                  {RUNBOOK_FIELDS[list].map(({ key, label, example }) => (
                    <Line key={key} label={label} htmlFor={`runbook-${list}-${at}-${key}`}>
                      <AutoText
                        id={`runbook-${list}-${at}-${key}`}
                        className={CELL}
                        maxLength={RUNBOOK_CAPS.fieldChars}
                        readOnly={!writable}
                        placeholder={example}
                        aria-describedby={`runbook-${list}-${at}-${key}-example`}
                        data-testid={`runbook-${list}-${at}-${key}`}
                        value={String((item as unknown as Record<string, unknown>)[key] ?? '')}
                        onChange={(e) => write(setRunbookField(runbook, list, at, key, e.currentTarget.value))}
                      />
                      <span id={`runbook-${list}-${at}-${key}-example`} className="label-sm">
                        {example}
                      </span>
                    </Line>
                  ))}
                  {writable && (
                    <span className="flex flex-wrap gap-2">
                      {list === 'rollback' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          testId={`runbook-rollback-${at}-up`}
                          ariaLabel={`Move ${name} up`}
                          disabled={at === 0}
                          onClick={() => write(moveRollback(runbook, at, -1))}
                        >
                          Move up
                        </Button>
                      )}
                      {list === 'rollback' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          testId={`runbook-rollback-${at}-down`}
                          ariaLabel={`Move ${name} down`}
                          disabled={at === runbook.rollback.length - 1}
                          onClick={() => write(moveRollback(runbook, at, 1))}
                        >
                          Move down
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        testId={`runbook-${list}-${at}-remove`}
                        onClick={() => write(removeRunbookItem(runbook, list, at))}
                      >
                        {`Remove ${name}`}
                      </Button>
                    </span>
                  )}
                </div>
              </details>
            );
          })}
          {writable && (
            <Button
              size="sm"
              variant="secondary"
              testId={`runbook-add-${list}`}
              disabled={listFull(runbook, list)}
              onClick={() => write(addRunbookItem(runbook, list))}
            >
              {ADD[list]}
            </Button>
          )}
          {listFull(runbook, list) && (
            <p className="label-sm" data-testid={`runbook-full-${list}`}>{`${FULL[list]} Remove one to add another.`}</p>
          )}
        </Panel>
      ))}
      <Panel testId="runbook-section-incident">
        <SectionHead title="Incident" />
        {drill && (
          <p className="label-sm wrap" data-testid="runbook-incident-from-drill">
            {RUNBOOK_INCIDENT_FROM_DRILL}
          </p>
        )}
        {(['rootCause', 'fix', 'actionItem'] as const).map((key) => (
          <Line
            key={key}
            label={key === 'rootCause' ? 'Root cause' : key === 'fix' ? 'Fix' : 'Action item'}
            htmlFor={`runbook-incident-${key}`}
          >
            <AutoText
              id={`runbook-incident-${key}`}
              className={CELL}
              maxLength={RUNBOOK_CAPS.fieldChars}
              readOnly={drill || !writable}
              data-testid={`runbook-incident-${key}`}
              value={runbook.incident[key]}
              onChange={(e) => write(setIncident(runbook, key, e.currentTarget.value))}
            />
          </Line>
        ))}
        {(runbook.incident.timeline ?? []).map((entry, at) =>
          drill || !writable ? (
            <p key={at} className="label-sm" data-testid={`runbook-incident-timeline-${at}`}>{`${entry.at} ${entry.event}`}</p>
          ) : (
            <span key={at} className="flex gap-2" data-testid={`runbook-incident-timeline-${at}`}>
              <input
                className={CELL}
                aria-label={`When, line ${at + 1}`}
                maxLength={RUNBOOK_CAPS.timelineAt}
                value={entry.at}
                onChange={(e) => write(setTimeline(runbook, at, 'at', e.currentTarget.value))}
              />
              <input
                className={CELL}
                aria-label={`What happened, line ${at + 1}`}
                maxLength={RUNBOOK_CAPS.fieldChars}
                value={entry.event}
                onChange={(e) => write(setTimeline(runbook, at, 'event', e.currentTarget.value))}
              />
              <Button
                size="sm"
                variant="ghost"
                testId={`runbook-incident-timeline-${at}-remove`}
                ariaLabel={`Remove timeline line ${at + 1}`}
                onClick={() => write(removeTimeline(runbook, at))}
              >
                Remove
              </Button>
            </span>
          ),
        )}
        {!drill && writable && (
          <Button
            size="sm"
            variant="secondary"
            testId="runbook-add-timeline"
            disabled={(runbook.incident.timeline ?? []).length >= RUNBOOK_CAPS.timeline}
            onClick={() => write(addTimeline(runbook))}
          >
            Add a timeline line
          </Button>
        )}
      </Panel>
      <Panel testId="runbook-section-notes">
        <SectionHead title="Notes" />
        <AutoText
          id="runbook-notes"
          aria-label="Notes"
          className={CELL}
          maxLength={RUNBOOK_CAPS.fieldChars}
          readOnly={!writable}
          data-testid="runbook-notes"
          value={runbook.notes ?? ''}
          onChange={(e) => write({ ...runbook, notes: e.currentTarget.value.slice(0, RUNBOOK_CAPS.fieldChars) })}
        />
      </Panel>
      {/* A read-only record (a published version) draws no button, as the learner's tab does not. */}
      {editable && (
        <Button size="sm" testId="runbook-check" onClick={() => setChecked(true)}>
          Check the runbook
        </Button>
      )}
      {editable && checked && (
        <ul data-testid="runbook-checks">
          {results.map((r) => (
            <li key={r.id} data-testid={`runbook-check-${r.id}`}>{`${r.passed ? 'Passed' : 'Not yet'}: ${r.label}. ${r.detail}.`}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
