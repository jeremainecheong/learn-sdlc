'use client';

/**
 * Step 5: the floor, the minimums the learner's design is checked against
 * before the review reads it.
 *
 * One row per floor field: a stepper for each minimum (bounded by
 * `DESIGN_CAPS`) and a toggle for each shape rule. A contract's rows are
 * greyed while its switch in step 3 is off, as the floor never reads them
 * then, and the sequence rule has a row of its own with no control: the
 * step 3 switch is the rule. Why a row is greyed, or has no control, is a
 * note on the row itself, which the row is described by. Under them, the floor in one plain sentence,
 * `designFloorSentence`, the one the learner's room reads; it follows the
 * switches as they are flipped. The sign-off mark stays here, as it does on
 * the Requirements builder's learner step.
 */
import { useId, useState } from 'react';
import type { DesignFloor, DesignSwitches, DraftTaskView, TaskMutationResult } from '@learnsdlc/shared';
import { DESIGN_CAPS, designFloorSentence } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Button, Chip } from '@/components/ui';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { SignOffHelp, SignOffToggle, signOffHelpIds } from '../TaskEditor';
import { BuilderCard, SaveLine, Stepper, useCardSave, type CardState } from '../requirements/BuilderCard';
import { designBodyOf, type DesignTaskWrite } from './design-builder-model';

type Minimum = 'minEntities' | 'minRelations' | 'minOperations' | 'minDecisions' | 'minEndpoints' | 'minScreens';
type Shape = 'operationShape' | 'decisionShape' | 'traceEveryStory' | 'requireErrorCatalogue' | 'screenShape';
type Needs = 'api' | 'screens' | null;

type FloorRow =
  | { kind: 'min'; field: Minimum; words: string; needs: Needs }
  | { kind: 'shape'; field: Shape; words: string; needs: Needs };

/** The floor's rows, in the order the learner's checks panel lists them. */
const ROWS: FloorRow[] = [
  { kind: 'min', field: 'minEntities', words: 'entities at least', needs: null },
  { kind: 'min', field: 'minRelations', words: 'relations at least', needs: null },
  { kind: 'min', field: 'minOperations', words: 'operations at least', needs: null },
  { kind: 'shape', field: 'operationShape', words: 'Every operation names an input and a return', needs: null },
  { kind: 'min', field: 'minDecisions', words: 'decisions at least', needs: null },
  { kind: 'shape', field: 'decisionShape', words: 'Every decision has a rationale and a trade-off', needs: null },
  { kind: 'shape', field: 'traceEveryStory', words: 'Every story is traced to an operation or an entity', needs: null },
  { kind: 'min', field: 'minEndpoints', words: 'endpoints in the API contract at least', needs: 'api' },
  { kind: 'shape', field: 'requireErrorCatalogue', words: 'The API contract has an error catalogue', needs: 'api' },
  { kind: 'min', field: 'minScreens', words: 'screens in the screen contract at least', needs: 'screens' },
  {
    kind: 'shape',
    field: 'screenShape',
    words: 'Every screen has a component, reads, components and an empty-state sentence',
    needs: 'screens',
  },
];

const OFF_NOTE: Record<'api' | 'screens' | 'sequence', string> = {
  api: 'Read only while the API contract is on.',
  screens: 'Read only while the screen contract is on.',
  sequence: 'Set by the sequence diagram switch in step 3.',
};

export function DesignFloorCard({
  projectId,
  versionId,
  task,
  switches,
  writeTask,
  editable,
  state,
  onFocusCard,
  onSaved,
  onSignOff,
}: {
  projectId: string;
  versionId: string;
  task: DraftTaskView;
  /** The switches as the builder holds them, saved or not. */
  switches: DesignSwitches;
  writeTask: DesignTaskWrite;
  editable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
  /** The editor's save of the sign-off mark; absent, the card saves it itself. */
  onSignOff?: (signOff: boolean) => void | Promise<void>;
}) {
  const [floor, setFloor] = useState<DesignFloor>(() => ({ ...designBodyOf(task).floor }));
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState('');

  const save = useCardSave({
    label: 'The floor',
    saveButton: 'Save the floor',
    validate: () => '',
    send: () => {
      const sent = { ...floor };
      return writeTask((server) => ({ design: { ...(server ?? designBodyOf(task)), floor: sent } }));
    },
    onSaved,
  });
  const setPart = (patch: Partial<DesignFloor>) => {
    setFloor((was) => ({ ...was, ...patch }));
    save.changed();
  };
  const off = (needs: Needs) => (needs === 'api' ? !switches.contracts.api : needs === 'screens' ? !switches.contracts.screens : false);
  const signOffHelp = 'task-signoff-help-design';
  const noteId = `${useId().replace(/:/g, '')}-floor-note`;

  return (
    <BuilderCard
      n={5}
      title="The floor"
      purpose="The minimums checked before the review reads the design. Counts and presence only, never a grade."
      state={state}
      testId="tde-floor"
      onFocusCard={onFocusCard}
      onLeave={editable ? save.saveSoon : undefined}
    >
      <div className="tre-floor tde-floor">
        <div className="tre-floor-grid">
          {ROWS.map((row) => {
            const greyed = off(row.needs);
            const note = greyed && row.needs ? OFF_NOTE[row.needs] : null;
            return (
              <div
                key={row.field}
                className={`tre-floor-item ${greyed ? 'tde-row-off' : ''}`}
                aria-disabled={greyed ? 'true' : undefined}
                aria-describedby={note ? `${noteId}-${row.field}` : undefined}
                data-testid={`tde-floor-${row.field}`}
              >
                {row.kind === 'min' ? (
                  <>
                    {editable && !greyed ? (
                      <Stepper
                        value={floor[row.field]}
                        min={DESIGN_CAPS[row.field][0]}
                        max={DESIGN_CAPS[row.field][1]}
                        label={`Minimum ${row.words.replace(/ at least$/, '')}`}
                        less={`Fewer ${row.words.replace(/ at least$/, '')}`}
                        more={`More ${row.words.replace(/ at least$/, '')}`}
                        onChange={(next) => setPart({ [row.field]: next } as Partial<DesignFloor>)}
                      />
                    ) : (
                      <strong>{floor[row.field]}</strong>
                    )}
                    <span>{row.words}</span>
                  </>
                ) : editable && !greyed ? (
                  <button
                    type="button"
                    className={`tre-pill ${floor[row.field] ? 'tre-pill-on' : ''}`}
                    aria-pressed={floor[row.field]}
                    onClick={() => setPart({ [row.field]: !floor[row.field] } as Partial<DesignFloor>)}
                  >
                    {floor[row.field] && <Icon name="check" size={12} />}
                    <span>{row.words}</span>
                  </button>
                ) : (
                  <span>{`${row.words}: ${floor[row.field] ? 'on' : 'off'}`}</span>
                )}
                {note && (
                  <span id={`${noteId}-${row.field}`} className="tde-row-note">
                    {note}
                  </span>
                )}
              </div>
            );
          })}
          <div
            className={`tre-floor-item ${switches.sequence ? '' : 'tde-row-off'}`}
            aria-disabled={switches.sequence ? undefined : 'true'}
            aria-describedby={`${noteId}-sequence`}
            data-testid="tde-floor-sequence"
          >
            <span>The sequence diagram names at least one of the learner&rsquo;s operations</span>
            <span id={`${noteId}-sequence`} className="tde-row-note">
              {OFF_NOTE.sequence}
            </span>
          </div>
        </div>
        <p className="tre-floor-sentence" data-testid="tde-floor-sentence">
          The learner&rsquo;s design needs {designFloorSentence(floor, switches)}.
        </p>
      </div>

      <p className="label-sm wrap">
        <Chip tone={task.required ? 'accent' : 'neutral'}>{task.required ? 'Required' : 'Optional'}</Chip>{' '}
        {task.required ? 'The phase waits on this task.' : 'The phase does not wait on this task.'}
      </p>
      {!editable && task.signOff === true && (
        <p className="label-sm wrap" data-testid="tde-signoff-read">
          Needs your sign-off.
        </p>
      )}
      {editable && (
        <>
          <SignOffHelp id={signOffHelp} readOnlyReason={null} />
          <SignOffToggle
            task={task}
            off={false}
            describedBy={signOffHelpIds(signOffHelp, null)}
            busy={signing}
            onChange={async (signOff) => {
              if (onSignOff) {
                await onSignOff(signOff);
                return;
              }
              setSigning(true);
              setSignError('');
              try {
                onSaved(await projectsApi.updateTask(projectId, versionId, 'design', task.taskKey, { signOff }));
              } catch (err) {
                setSignError(describeError(err, 'The mark could not be saved. Try again in a moment.'));
              } finally {
                setSigning(false);
              }
            }}
          />
          {signError && (
            <p role="alert" className="label-sm wrap text-fail" data-testid="tde-signoff-error">
              {signError}
            </p>
          )}
          <div className="tre-save-row">
            {/* The one card whose changes wait for a press or for leaving it: said beside its button. */}
            <SaveLine save={save} testId="tde-floor-status" idle="Saves when you press Save the floor, or when you leave the card." />
            <Button
              size="sm"
              variant="secondary"
              busy={save.status === 'saving'}
              busyLabel="Saving…"
              testId="tde-floor-save"
              onClick={() => void save.saveNow()}
            >
              Save the floor
            </Button>
          </div>
        </>
      )}
    </BuilderCard>
  );
}
