'use client';

/**
 * Step 4: the change request's floor, and the starting record learners open on.
 *
 * The contract switch says what the learner will and will not see; switching
 * it off over a starting record that declares amendments asks first, since
 * the door deletes them. Three steppers and two toggles set the floor, each
 * change saved at once as `{ change: { contract, floor } }` through the
 * builder's one queue, and under them the floor in one plain line,
 * `changeFloorSentence`, the one the learner's change room reads.
 *
 * The starting record is drawn with the change room's own forms (Request,
 * Contract when the switch is on, Tests, Release), each edit saved as the
 * record's bytes through the files door. "Start empty" sends the empty change
 * request, and "Reset to the pack's" puts back the record of the version this
 * draft came from; each asks first, as the Design builder's starting point
 * does, and a refusal is said in the door's own words with the forms back on
 * the server's record. Reset is drawn on a draft opened from no other version
 * too, so the door's own sentence says there is nothing to reset to. The
 * sign-off mark stays here. No required toggle is drawn: the phase's one
 * graded task is always required.
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  CHANGE_CAPS,
  CHANGE_REQUEST_JSON,
  EMPTY_CHANGE_REQUEST,
  changeFloorSentence,
  serialiseChangeRequest,
  startingChangeRequestError,
  type AuthoringFileView,
  type ChangeFloor,
  type ChangeRequest,
  type DraftPhaseView,
  type DraftTaskView,
  type ReplaceFileBody,
  type TaskMutationResult,
} from '@learnsdlc/shared';
import { Button } from '@/components/ui';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { isRoomRecordPath } from '@/components/workspace/records';
import { AmendmentsForm, ReleaseForm, RequestForm, TestsForm } from '@/components/workspace/panels/maintenance/ChangeForms';
import { readChangeText } from '@/components/workspace/panels/maintenance/change-edit';
import { SignOffHelp, SignOffToggle, signOffHelpIds } from '../TaskEditor';
import { BuilderCard, SaveLine, Stepper, useCardSave, type CardState } from '../requirements/BuilderCard';
import { useEditorSaveReport } from '../save-status';
import { changeBodyOf, contractOffConfirm, withoutAmendments, type MaintenanceTaskWrite } from './maintenance-builder-model';

type Minimum = 'minImpact' | 'minContract' | 'minTests';
const MINIMUMS: { field: Minimum; words: string }[] = [
  { field: 'minImpact', words: 'operations, screens or files in the impact' },
  { field: 'minContract', words: 'contract amendments' },
  { field: 'minTests', words: 'tests' },
];
type Toggle = 'requireRelease' | 'traceEveryAcceptance';
const TOGGLES: { field: Toggle; label: string; sentence: string }[] = [
  {
    field: 'requireRelease',
    label: 'Require the release',
    sentence: "The release: the learner's change request names a version and at least one change line. Off, the floor does not ask for it.",
  },
  {
    field: 'traceEveryAcceptance',
    label: 'Require every acceptance line covered',
    sentence: 'Every acceptance line is covered by a test or a change line. Off, the floor does not ask for it.',
  },
];
const CONTRACT_SENTENCE = 'On, the learner declares contract amendments and the Contract tab is shown; off, neither.';

type FloorSave = { status: 'idle' | 'saving' | 'saved' | 'failed'; message: string };

export function ChangeRequestCard({
  projectId,
  versionId,
  phase,
  task,
  writeTask,
  starting,
  rows,
  onStartingSaved,
  onReload,
  editable,
  busy,
  state,
  onFocusCard,
  onSaved,
  onChangeSaved,
  onSignOff,
}: {
  projectId: string;
  versionId: string;
  phase: DraftPhaseView;
  task: DraftTaskView;
  writeTask: MaintenanceTaskWrite;
  /** The starting record's bytes as the server holds them ('' when none is mounted), or null while they are read. */
  starting: string | null;
  /** The draft's file rows, or null while they are read: the Request form offers the phase's editable files. */
  rows: readonly AuthoringFileView[] | null;
  /** An edit of the record was saved with these bytes. */
  onStartingSaved: (content: string) => void;
  /** Read the files again, after the record was written over whole. */
  onReload: () => Promise<void>;
  editable: boolean;
  busy: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
  /** A change request save (the switch, the floor or the record) was answered: the step is done. */
  onChangeSaved: () => void;
  /** The editor's save of the sign-off mark; absent, the card saves it itself. */
  onSignOff?: (signOff: boolean) => void | Promise<void>;
}) {
  const base = useId().replace(/:/g, '');
  const older = task.recordOlderFormat === true;
  const writable = editable && !older;
  const ticket = task.change!.ticket;
  const [contract, setContract] = useState(() => changeBodyOf(task).contract);
  const [floor, setFloor] = useState<ChangeFloor>(() => changeBodyOf(task).floor);
  const [floorSave, setFloorSave] = useState<FloorSave>({ status: 'idle', message: '' });
  // The floor saves at once on each change; the editor's one status line says it too.
  const reportSave = useEditorSaveReport();
  const floorReportId = useId();
  useEffect(() => {
    reportSave(floorReportId, { label: 'The change floor', state: floorSave.status, message: floorSave.message });
  }, [reportSave, floorReportId, floorSave.status, floorSave.message]);
  useEffect(() => () => reportSave(floorReportId, null), [reportSave, floorReportId]);
  const [confirmOff, setConfirmOff] = useState<string | null>(null);
  // The switch as it stands, for a record save that answers after it was flipped.
  const contractNow = useRef(contract);
  contractNow.current = contract;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The switch and floor the server last answered with, and the latest save's round: the latest save, refused, puts
  // them back on screen, so the plain floor line never states a floor the server does not hold.
  const held = useRef({ contract, floor });
  const floorRound = useRef(0);
  const saveFloor = (nextContract: boolean, nextFloor: ChangeFloor, rewritesRecord = false) => {
    setContract(nextContract);
    contractNow.current = nextContract;
    setFloor(nextFloor);
    setFloorSave({ status: 'saving', message: '' });
    const sent = { contract: nextContract, floor: { ...nextFloor } };
    const round = ++floorRound.current;
    // A starting-record edit still waiting goes first, as typed, while the server's switch is still the one it was
    // typed under: switched off, the door's own rewrite then drops its amendments, and a refused switch leaves it whole.
    save
      .flush()
      .then(() => writeTask(() => ({ change: sent })))
      .then(async (result) => {
        held.current = sent;
        onSaved(result);
        onChangeSaved();
        if (alive.current) setFloorSave({ status: 'saved', message: '' });
        // The door deleted the starting record's amendments with the switch: read the record it now holds.
        if (rewritesRecord) await onReload();
      })
      .catch((err) => {
        if (alive.current) {
          if (round === floorRound.current) {
            setContract(held.current.contract);
            contractNow.current = held.current.contract;
            setFloor(held.current.floor);
          }
          setFloorSave({ status: 'failed', message: describeError(err, 'The change request floor could not be saved. Try again in a moment.') });
        }
      });
  };
  const flipContract = () => {
    if (!contract) {
      saveFloor(true, floor);
      return;
    }
    // The forms' bytes, so an amendment not yet saved is counted too.
    const ask = contractOffConfirm(text ?? starting);
    if (ask) setConfirmOff(ask);
    else saveFloor(false, floor);
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
    label: 'Change request',
    validate: () => '',
    send: async () => {
      const content = buffer.current;
      // A run that found nothing left to send (its edit went out with the run before it) answers nothing.
      if (content === null) return null;
      const result = await projectsApi.replaceFile(projectId, versionId, phase.key, { path: CHANGE_REQUEST_JSON, content });
      // An edit made while this one was out stays waiting for the next run.
      if (buffer.current === content) buffer.current = null;
      // The door stores no amendments while the switch it holds is off, so neither does the copy kept here.
      onStartingSaved(held.current.contract ? content : withoutAmendments(content));
      onChangeSaved();
      return result;
    },
    onSaved,
  });
  const edit = (next: ChangeRequest) => {
    const content = serialiseChangeRequest(contractNow.current ? next : { ...next, contract: [] });
    buffer.current = content;
    setText(content);
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
      onChangeSaved();
      await onReload();
    } catch (err) {
      if (alive.current) {
        // Refused: the server still holds the record it had, so the forms show it again.
        setText(starting);
        setActionError(describeError(err, 'The starting change request could not be changed. Try again in a moment.'));
      }
    } finally {
      if (alive.current) setWorking(false);
    }
  };

  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState('');
  const signOffHelp = 'task-signoff-help-maintenance';

  // A draft that mounts no record opens on the empty one, as the change room does.
  const read =
    text === null
      ? null
      : text.trim() === ''
        ? { change: EMPTY_CHANGE_REQUEST, error: null }
        : readChangeText(text, ticket.acceptance.map((one) => one.id));
  const formsEditable = writable && !working;
  const offered = (rows ?? [])
    .filter((one) => one.phaseKey === phase.key && one.editable && !isRoomRecordPath(one.path))
    .map((one) => one.path);

  return (
    <BuilderCard
      n={4}
      title="Change request"
      purpose="The minimums the learner's change request is checked against, and the record their change room opens on."
      state={state}
      testId="tdm-change"
      onFocusCard={onFocusCard}
    >
      <div className="tre-floor">
        <div className={`tde-switch-row ${contract ? 'tde-switch-row-on' : ''}`}>
          <button
            type="button"
            role="switch"
            aria-checked={contract}
            aria-label="Contract amendments"
            aria-describedby={`${base}-contract`}
            className={`tde-switch ${contract ? 'tde-switch-on' : ''}`}
            disabled={!editable || confirmOff !== null}
            data-testid="tdm-contract"
            onClick={flipContract}
          >
            <span className="tde-switch-knob" aria-hidden="true" />
          </button>
          <span id={`${base}-contract`} className="tde-switch-text wrap">
            {CONTRACT_SENTENCE}
          </span>
        </div>
        {editable && confirmOff && (
          <div className="tde-confirm" role="group" aria-label="Switch the contract off">
            <p className="label-sm wrap" data-testid="tdm-contract-confirm">
              {confirmOff}
            </p>
            <span className="tde-actions">
              <Button
                size="sm"
                variant="danger"
                testId="tdm-contract-confirm-yes"
                onClick={() => {
                  setConfirmOff(null);
                  saveFloor(false, floor, true);
                }}
              >
                Switch it off
              </Button>
              <Button size="sm" variant="ghost" testId="tdm-contract-keep" onClick={() => setConfirmOff(null)}>
                Keep it
              </Button>
            </span>
          </div>
        )}
        <div className="tre-floor-grid">
          {MINIMUMS.map(({ field, words }) => (
            <div key={field} className="tre-floor-item">
              {editable ? (
                <Stepper
                  value={floor[field]}
                  min={CHANGE_CAPS[field][0]}
                  max={CHANGE_CAPS[field][1]}
                  label={`Minimum ${words}`}
                  less={`Fewer ${words}`}
                  more={`More ${words}`}
                  disabled={field === 'minContract' && !contract}
                  testId={`tdm-floor-${field}`}
                  onChange={(held) => {
                    if (held !== floor[field]) saveFloor(contract, { ...floor, [field]: held });
                  }}
                />
              ) : (
                <strong data-testid={`tdm-floor-${field}`}>{floor[field]}</strong>
              )}
              <span>{field === 'minContract' && !contract ? `${words} at least (not read while the contract is off)` : `${words} at least`}</span>
            </div>
          ))}
        </div>
        {TOGGLES.map(({ field, label, sentence }) => (
          <div key={field} className={`tde-switch-row ${floor[field] ? 'tde-switch-row-on' : ''}`}>
            <button
              type="button"
              role="switch"
              aria-checked={floor[field]}
              aria-label={label}
              aria-describedby={`${base}-${field}`}
              className={`tde-switch ${floor[field] ? 'tde-switch-on' : ''}`}
              disabled={!editable}
              data-testid={`tdm-floor-${field}`}
              onClick={() => saveFloor(contract, { ...floor, [field]: !floor[field] })}
            >
              <span className="tde-switch-knob" aria-hidden="true" />
            </button>
            <span id={`${base}-${field}`} className="tde-switch-text wrap">
              {sentence}
            </span>
          </div>
        ))}
        <p className="tre-floor-sentence" data-testid="tdm-floor-sentence">
          {`The learner's change request needs ${changeFloorSentence(floor, contract)}.`}
        </p>
        {floorSave.status === 'failed' ? (
          <p role="alert" className="label-sm wrap text-fail" data-testid="tdm-floor-status">
            {floorSave.message}
          </p>
        ) : (
          editable && (
            <p role="status" className="tre-inline-note wrap" data-testid="tdm-floor-status">
              {floorSave.status === 'saving' ? 'Saving…' : floorSave.status === 'saved' ? 'Saved' : 'Each change saves at once.'}
            </p>
          )
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="label-sm">The starting change request</span>
        {older ? (
          <p className="tre-legacy label-sm wrap" data-testid="tdm-change-older">
            {editable
              ? 'The starting change request opens here once the task is converted. Saving the brief, the ticket, the change request floor or the criteria converts it.'
              : 'The starting change request opens here once the task is converted.'}
          </p>
        ) : read === null ? (
          <p className="purpose" data-testid="tdm-change-reading">
            Reading the starting change request.
          </p>
        ) : read.error ? (
          <p role="alert" className="label-sm wrap text-fail" data-testid="tdm-change-unreadable">
            {startingChangeRequestError(read.error)}
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-4" data-testid="tdm-change-forms">
            <RequestForm ticket={ticket} change={read.change} files={offered} editable={formsEditable} onChange={edit} />
            {contract && <AmendmentsForm change={read.change} editable={formsEditable} onChange={edit} />}
            <TestsForm ticket={ticket} change={read.change} editable={formsEditable} onChange={edit} />
            <ReleaseForm ticket={ticket} change={read.change} editable={formsEditable} onChange={edit} />
          </div>
        )}
        {writable && asking && (
          <div className="tde-confirm" role="group" aria-label={asking === 'empty' ? 'Start empty' : "Reset to the pack's"}>
            <p className="label-sm wrap" data-testid="tdm-start-confirm-line">
              {asking === 'empty'
                ? 'This replaces the starting change request with an empty one: no impact, contract amendments, tests or release. Learners in a version you publish from now on start from nothing.'
                : 'If this draft was opened from a version, this puts back that version\'s starting change request, and your changes to it are lost.'}
            </p>
            <span className="tde-actions">
              <Button
                size="sm"
                variant="danger"
                testId="tdm-start-confirm"
                onClick={() =>
                  void writeOver(
                    asking === 'empty'
                      ? { path: CHANGE_REQUEST_JSON, content: serialiseChangeRequest(EMPTY_CHANGE_REQUEST) }
                      : { path: CHANGE_REQUEST_JSON, reset: 'source' },
                  )
                }
              >
                {asking === 'empty' ? 'Start empty' : 'Reset it'}
              </Button>
              <Button size="sm" variant="ghost" testId="tdm-start-keep" onClick={() => setAsking(null)}>
                Keep it
              </Button>
            </span>
          </div>
        )}
        {actionError && (
          <p role="alert" className="label-sm wrap text-fail" data-testid="tdm-change-error">
            {actionError}
          </p>
        )}
        {writable && (
          <div className="tre-save-row">
            <SaveLine save={save} testId="tdm-change-status" idle="Edits save as you make them." />
            <span className="tde-actions">
              <Button
                size="sm"
                variant="ghost"
                disabled={working || save.status === 'saving'}
                testId="tdm-start-empty"
                onClick={() => setAsking('empty')}
              >
                Start empty
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="refresh"
                disabled={working || save.status === 'saving'}
                testId="tdm-reset-source"
                onClick={() => setAsking('reset')}
              >
                Reset to the pack&rsquo;s
              </Button>
            </span>
          </div>
        )}
      </div>

      {!editable && task.signOff === true && (
        <p className="label-sm wrap" data-testid="tdm-signoff-read">
          Needs your sign-off.
        </p>
      )}
      {editable && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="tdm-signoff">
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
            <p role="alert" className="label-sm wrap text-fail" data-testid="tdm-signoff-error">
              {signError}
            </p>
          )}
        </div>
      )}
    </BuilderCard>
  );
}
