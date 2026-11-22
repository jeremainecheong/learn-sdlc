'use client';

/**
 * Step 3: the runbook floor, and the starting record learners open on.
 *
 * Four steppers and the incident switch set the floor, each change saved at
 * once as `{ runbook: { floor } }` through the builder's one queue; under
 * them, the floor in one plain line, `runbookFloorSentence`, the one the
 * learner's Runbook tab reads. The starting record is drawn with the room's
 * own Runbook forms (`RunbookTab`), each edit saved as the record's bytes
 * through the files door. "Start empty" sends the empty runbook, and "Reset to
 * the pack's" puts back the record of the version this draft came from; each
 * asks first, as the Design builder's starting point does, and a refusal is
 * said in the door's own words with the forms back on the server's record.
 * Reset is drawn on a draft opened from no other version too, so the door's
 * own sentence says there is nothing to reset to. The sign-off mark stays here. No
 * required toggle is drawn: the phase's one graded task is always required.
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  EMPTY_RUNBOOK,
  RUNBOOK_CAPS,
  RUNBOOK_JSON,
  runbookFloorSentence,
  serialiseRunbook,
  type DraftPhaseView,
  type DraftTaskView,
  type ReplaceFileBody,
  type RunbookFloor,
  type TaskMutationResult,
} from '@learnsdlc/shared';
import { Button } from '@/components/ui';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { RunbookRecordEditor } from './RunbookRecordEditor';
import { SignOffHelp, SignOffToggle, signOffHelpIds } from '../TaskEditor';
import { BuilderCard, SaveLine, Stepper, useCardSave, type CardState } from '../requirements/BuilderCard';
import { useEditorSaveReport } from '../save-status';
import { runbookBodyOf, type DeploymentTaskWrite } from './deployment-builder-model';

type Minimum = 'minEnvironment' | 'minHealth' | 'minRollback' | 'minData';
const MINIMUMS: { field: Minimum; words: string }[] = [
  { field: 'minEnvironment', words: 'environment entries' },
  { field: 'minHealth', words: 'health checks' },
  { field: 'minRollback', words: 'rollback steps' },
  { field: 'minData', words: 'data entries' },
];
const INCIDENT_SENTENCE = "The incident: the learner's runbook records its root cause, fix and action item. Off, the floor does not ask for it.";

type FloorSave = { status: 'idle' | 'saving' | 'saved' | 'failed'; message: string };

export function RunbookCard({
  projectId,
  versionId,
  phase,
  task,
  writeTask,
  starting,
  onStartingSaved,
  onReload,
  editable,
  busy,
  state,
  onFocusCard,
  onSaved,
  onRunbookSaved,
  onSignOff,
}: {
  projectId: string;
  versionId: string;
  phase: DraftPhaseView;
  task: DraftTaskView;
  writeTask: DeploymentTaskWrite;
  /** The starting record's bytes as the server holds them ('' when none is mounted), or null while they are read. */
  starting: string | null;
  /** An edit of the record was saved with these bytes. */
  onStartingSaved: (content: string) => void;
  /** Read the files again, after the record was written over whole. */
  onReload: () => Promise<void>;
  editable: boolean;
  busy: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
  /** A runbook save (the floor or the record) was answered: the step is done. */
  onRunbookSaved: () => void;
  /** The editor's save of the sign-off mark; absent, the card saves it itself. */
  onSignOff?: (signOff: boolean) => void | Promise<void>;
}) {
  const base = useId().replace(/:/g, '');
  const older = task.recordOlderFormat === true;
  const writable = editable && !older;
  const [floor, setFloor] = useState<RunbookFloor>(() => runbookBodyOf(task).floor);
  const [floorSave, setFloorSave] = useState<FloorSave>({ status: 'idle', message: '' });
  // The floor saves at once on each change; the editor's one status line says it too.
  const reportSave = useEditorSaveReport();
  const floorReportId = useId();
  useEffect(() => {
    reportSave(floorReportId, { label: 'The runbook floor', state: floorSave.status, message: floorSave.message });
  }, [reportSave, floorReportId, floorSave.status, floorSave.message]);
  useEffect(() => () => reportSave(floorReportId, null), [reportSave, floorReportId]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The floor the server last answered with, and the latest save's round: the latest save, refused, puts that floor
  // back on screen, so the plain floor line never states a floor the server does not hold.
  const heldFloor = useRef(floor);
  const floorRound = useRef(0);
  const saveFloor = (next: RunbookFloor) => {
    setFloor(next);
    setFloorSave({ status: 'saving', message: '' });
    const sent = { ...next };
    const round = ++floorRound.current;
    writeTask(() => ({ runbook: { floor: sent } }))
      .then((result) => {
        heldFloor.current = sent;
        onSaved(result);
        onRunbookSaved();
        if (alive.current) setFloorSave({ status: 'saved', message: '' });
      })
      .catch((err) => {
        if (alive.current) {
          if (round === floorRound.current) setFloor(heldFloor.current);
          setFloorSave({ status: 'failed', message: describeError(err, 'The floor could not be saved. Try again in a moment.') });
        }
      });
  };

  // The record as the forms hold it, and the edit not yet saved (null when none is waiting).
  const [text, setText] = useState<string | null>(starting);
  const buffer = useRef<string | null>(null);
  useEffect(() => {
    if (buffer.current === null) setText(starting);
  }, [starting]);
  // The render on which the task stops being older-format reads as "reading" at once, so the
  // forms never draw over the empty bytes for a frame before the builder reads the converted record.
  const [wasOlder, setWasOlder] = useState(older);
  if (wasOlder !== older) {
    setWasOlder(older);
    if (wasOlder) setText(null);
  }

  const save = useCardSave({
    label: 'The starting runbook',
    validate: () => '',
    send: async () => {
      const content = buffer.current;
      // A run that found nothing left to send (its edit went out with the run before it) answers nothing.
      if (content === null) return null;
      const result = await projectsApi.replaceFile(projectId, versionId, phase.key, { path: RUNBOOK_JSON, content });
      // An edit made while this one was out stays waiting for the next run.
      if (buffer.current === content) buffer.current = null;
      onStartingSaved(content);
      onRunbookSaved();
      return result;
    },
    onSaved,
  });
  const edit = (next: string) => {
    buffer.current = next;
    setText(next);
    save.changed();
    save.saveSoon();
  };

  // The whole-record actions: Start empty and Reset to the pack's, each asked first.
  const [asking, setAsking] = useState<'empty' | 'reset' | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState('');
  const writeOver = async (body: ReplaceFileBody) => {
    // The whole record is written over: an edit still waiting is dropped with it.
    buffer.current = null;
    setAsking(null);
    if (body.content !== undefined) setText(body.content);
    setWorking(true);
    setActionError('');
    try {
      const result = await projectsApi.replaceFile(projectId, versionId, phase.key, body);
      onSaved(result);
      onRunbookSaved();
      await onReload();
    } catch (err) {
      if (alive.current) {
        // Refused: the server still holds the record it had, so the forms show it again.
        setText(starting);
        setActionError(describeError(err, 'The starting runbook could not be changed. Try again in a moment.'));
      }
    } finally {
      if (alive.current) setWorking(false);
    }
  };

  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState('');
  const signOffHelp = 'task-signoff-help-deployment';

  return (
    <BuilderCard
      n={3}
      title="Runbook"
      purpose="The minimums the learner's runbook is checked against, and the record their Runbook tab opens on."
      state={state}
      testId="tdp-runbook"
      onFocusCard={onFocusCard}
    >
      <div className="tre-floor">
        <div className="tre-floor-grid">
          {MINIMUMS.map(({ field, words }) => (
            <div key={field} className="tre-floor-item">
              {editable ? (
                <Stepper
                  value={floor[field]}
                  min={RUNBOOK_CAPS[field][0]}
                  max={RUNBOOK_CAPS[field][1]}
                  label={`Minimum ${words}`}
                  less={`Fewer ${words}`}
                  more={`More ${words}`}
                  testId={`tdp-floor-${field}`}
                  onChange={(held) => {
                    if (held !== floor[field]) saveFloor({ ...floor, [field]: held });
                  }}
                />
              ) : (
                <strong data-testid={`tdp-floor-${field}`}>{floor[field]}</strong>
              )}
              <span>{`${words} at least`}</span>
            </div>
          ))}
        </div>
        <div className={`tde-switch-row ${floor.requireIncident ? 'tde-switch-row-on' : ''}`}>
          <button
            type="button"
            role="switch"
            aria-checked={floor.requireIncident}
            aria-label="Require the incident"
            aria-describedby={`${base}-incident`}
            className={`tde-switch ${floor.requireIncident ? 'tde-switch-on' : ''}`}
            disabled={!editable}
            data-testid="tdp-floor-requireIncident"
            onClick={() => saveFloor({ ...floor, requireIncident: !floor.requireIncident })}
          >
            <span className="tde-switch-knob" aria-hidden="true" />
          </button>
          <span id={`${base}-incident`} className="tde-switch-text wrap">
            {INCIDENT_SENTENCE}
          </span>
        </div>
        <p className="tre-floor-sentence" data-testid="tdp-floor-sentence">
          {`The learner's runbook needs ${runbookFloorSentence(floor)}.`}
        </p>
        {floorSave.status === 'failed' ? (
          <p role="alert" className="label-sm wrap text-fail" data-testid="tdp-floor-status">
            {floorSave.message}
          </p>
        ) : (
          editable && (
            <p role="status" className="tre-inline-note wrap" data-testid="tdp-floor-status">
              {floorSave.status === 'saving' ? 'Saving…' : floorSave.status === 'saved' ? 'Saved' : 'Each change saves at once.'}
            </p>
          )
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="label-sm">The starting runbook</span>
        {older ? (
          <p className="tre-legacy label-sm wrap" data-testid="tdp-runbook-older">
            {editable
              ? 'The starting runbook opens here once the task is converted. Saving the brief, the runbook floor or the criteria converts it.'
              : 'The starting runbook opens here once the task is converted.'}
          </p>
        ) : text === null ? (
          <p className="purpose">Reading the starting runbook.</p>
        ) : (
          // The teacher's own layout of the record: named, folding entries; the learner's tab is drawn its own way.
          <RunbookRecordEditor
            floor={floor}
            drill={task.runbook?.drill ?? false}
            text={text}
            onChange={edit}
            editable={writable && !working}
          />
        )}
        {writable && asking && (
          <div className="tde-confirm" role="group" aria-label={asking === 'empty' ? 'Start empty' : "Reset to the pack's"}>
            <p className="label-sm wrap" data-testid="tdp-start-confirm-line">
              {asking === 'empty'
                ? 'This replaces the starting runbook with an empty one: no environment entries, health checks, rollback steps or data entries, and no incident. Learners in a version you publish from now on start from nothing.'
                : 'If this draft was opened from a version, this puts back that version\'s starting runbook, and your changes to it are lost.'}
            </p>
            <span className="tde-actions">
              <Button
                size="sm"
                variant="danger"
                testId="tdp-start-confirm"
                onClick={() =>
                  void writeOver(
                    asking === 'empty'
                      ? { path: RUNBOOK_JSON, content: serialiseRunbook(EMPTY_RUNBOOK) }
                      : { path: RUNBOOK_JSON, reset: 'source' },
                  )
                }
              >
                {asking === 'empty' ? 'Start empty' : 'Reset it'}
              </Button>
              <Button size="sm" variant="ghost" testId="tdp-start-keep" onClick={() => setAsking(null)}>
                Keep it
              </Button>
            </span>
          </div>
        )}
        {actionError && (
          <p role="alert" className="label-sm wrap text-fail" data-testid="tdp-runbook-error">
            {actionError}
          </p>
        )}
        {writable && (
          <div className="tre-save-row">
            <SaveLine save={save} testId="tdp-runbook-status" idle="Edits save as you make them." />
            <span className="tde-actions">
              <Button
                size="sm"
                variant="ghost"
                disabled={working || save.status === 'saving'}
                testId="tdp-start-empty"
                onClick={() => setAsking('empty')}
              >
                Start empty
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="refresh"
                disabled={working || save.status === 'saving'}
                testId="tdp-reset-source"
                onClick={() => setAsking('reset')}
              >
                Reset to the pack&rsquo;s
              </Button>
            </span>
          </div>
        )}
      </div>

      {!editable && task.signOff === true && (
        <p className="label-sm wrap" data-testid="tdp-signoff-read">
          Needs your sign-off.
        </p>
      )}
      {editable && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="tdp-signoff">
          <SignOffHelp id={signOffHelp} readOnlyReason={null} />
          <SignOffToggle
            task={task}
            off={false}
            describedBy={signOffHelpIds(signOffHelp, null)}
            busy={signing || busy}
            onChange={async (signOff) => {
              if (onSignOff) {
                await onSignOff(signOff);
                return;
              }
              setSigning(true);
              setSignError('');
              try {
                onSaved(await projectsApi.updateTask(projectId, versionId, phase.key, task.taskKey, { signOff }));
              } catch (err) {
                setSignError(describeError(err, 'The mark could not be saved. Try again in a moment.'));
              } finally {
                setSigning(false);
              }
            }}
          />
          {signError && (
            <p role="alert" className="label-sm wrap text-fail" data-testid="tdp-signoff-error">
              {signError}
            </p>
          )}
        </div>
      )}
    </BuilderCard>
  );
}
