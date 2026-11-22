'use client';

/**
 * Step 3: the design the learner writes.
 *
 * The task's title, brief and objectives, and the three switches that say
 * what the design is made of: the API contract, the screen contract and the
 * sequence diagram. Each switch says, in one sentence, what the learner will
 * and will not see. The switches are held by the builder, so the floor in
 * step 5 follows them as they are flipped, before they are saved.
 *
 * The card saves the words and the switches with the stories and the floor
 * as the server holds them, and each new answer redraws the words with the
 * server's while nothing is typed here (`useServerRedraw`). A contract switched on is seeded by the server
 * and one switched off loses its document; the sequence switch touches no
 * document, as the diagram lives in the record. So a contract whose starting
 * document holds more than the empty seed is switched off only after a
 * confirm line that says what goes with it; "Keep it" leaves the switch on
 * and sends nothing.
 */
import { useId, useState } from 'react';
import { API_CONTRACT_JSON, SCREEN_CONTRACT_JSON, TASK_BRIEF_MAX as BRIEF_MAX, TASK_OBJECTIVES_MAX as OBJECTIVES_MAX, TASK_OBJECTIVE_MAX as OBJECTIVE_MAX, TASK_TITLE_MAX as TITLE_MAX } from '@learnsdlc/shared';
import type { DesignSwitches, DraftTaskView, ElementProvenance, TaskMutationResult } from '@learnsdlc/shared';
import { Button, Chip } from '@/components/ui';
import { ProvenanceChip } from '../PhaseScenario';
import { BuilderCard, SaveLine, useCardSave, useServerRedraw, type CardState } from '../requirements/BuilderCard';
import { designBodyOf, switchOffConfirm, type DesignTaskWrite } from './design-builder-model';
import { PlainTextHint } from '../PlainTextHint';
import { GrowBox } from '../GrowBox';


type SwitchKey = 'api' | 'screens' | 'sequence';

/** The three switches, each with the sentence that says what the learner will and will not see. */
const DESIGN_SWITCHES: { key: SwitchKey; testId: string; name: string; sentence: string }[] = [
  {
    key: 'api',
    testId: 'tde-contract-api',
    name: 'API contract',
    sentence: 'API contract: the learner writes the endpoints and the error catalogue. Off, they never see it.',
  },
  {
    key: 'screens',
    testId: 'tde-contract-screens',
    name: 'Screen contract',
    sentence:
      'Screen contract: the learner writes each screen: its route, component, the operations it reads, what it shows, its components and its empty-state sentence. Off, they never see it.',
  },
  {
    key: 'sequence',
    testId: 'tde-sequence-diagram',
    name: 'Sequence diagram',
    sentence:
      'Sequence diagram: the learner writes the request path, one message per line, and it must name at least one of their operations. Off, they never see it and nothing is graded for it.',
  },
];

const CONTRACT_PATH = { api: API_CONTRACT_JSON, screens: SCREEN_CONTRACT_JSON } as const;

const isOn = (switches: DesignSwitches, key: SwitchKey) => (key === 'sequence' ? switches.sequence : switches.contracts[key]);
const flipped = (switches: DesignSwitches, key: SwitchKey): DesignSwitches =>
  key === 'sequence'
    ? { ...switches, sequence: !switches.sequence }
    : { ...switches, contracts: { ...switches.contracts, [key]: !switches.contracts[key] } };

/** The objectives as typed, one per line, as the door takes them. */
const objectivesOf = (text: string) =>
  text
    .split('\n')
    .map((one) => one.trim())
    .filter(Boolean);

export function LearnerDesignCard({
  task,
  switches,
  onSwitches,
  writeTask,
  editable,
  state,
  onFocusCard,
  onSaved,
  whose,
  referenceName,
  documents,
}: {
  task: DraftTaskView;
  /** The switches as the builder holds them: saved, or flipped and not saved yet. */
  switches: DesignSwitches;
  onSwitches: (next: DesignSwitches) => void;
  writeTask: DesignTaskWrite;
  editable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
  /** Whose the task is, on a copied project, or null. */
  whose: ElementProvenance | null;
  referenceName: string;
  /** The starting documents step 4 holds, by path: what a contract switched off would lose; null until step 4 has read them. */
  documents: Readonly<Record<string, string>> | null;
}) {
  const base = useId().replace(/:/g, '');
  const [title, setTitle] = useState(task.title);
  const [brief, setBrief] = useState(task.brief);
  const [objectives, setObjectives] = useState(task.objectives.join('\n'));
  // The contract whose switch-off waits on the confirm line, and that line.
  const [asking, setAsking] = useState<{ key: 'api' | 'screens'; line: string } | null>(null);

  const save = useCardSave({
    label: "The learner's design",
    saveButton: "Save the learner's design",
    validate: () => {
      if (!title.trim()) return 'Give the task a title before you save it.';
      if (!brief.trim()) return 'Write the brief before you save it. It is what the learner reads first.';
      const list = objectivesOf(objectives);
      if (list.length > OBJECTIVES_MAX) return `A task holds at most ${OBJECTIVES_MAX} objectives.`;
      if (list.some((one) => one.length > OBJECTIVE_MAX)) return `An objective is at most ${OBJECTIVE_MAX} characters.`;
      return '';
    },
    send: () => {
      const words = { title, brief, objectives: objectivesOf(objectives) };
      const { contracts, sequence } = switches;
      // The stories and the floor as the server holds them when this save's
      // turn comes, so a step 2 or step 5 save just before it is never undone.
      return writeTask((server) => ({
        ...words,
        design: { ...(server ?? designBodyOf(task)), contracts: { ...contracts }, sequence },
      }));
    },
    onSaved,
  });
  // Each new answer redraws the words with the server's while nothing is typed here.
  useServerRedraw(task, save.clean, (next) => {
    setTitle(next.title);
    setBrief(next.brief);
    setObjectives(next.objectives.join('\n'));
  });

  const change = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    save.changed();
  };

  const flip = (key: SwitchKey) => {
    setAsking(null);
    onSwitches(flipped(switches, key));
    save.changed();
  };
  const press = (key: SwitchKey) => {
    const line = key !== 'sequence' && isOn(switches, key) ? switchOffConfirm(key, documents === null ? null : documents[CONTRACT_PATH[key]]) : null;
    if (key !== 'sequence' && line) setAsking({ key, line });
    else flip(key);
  };

  return (
    <BuilderCard
      n={3}
      title="The learner's design"
      purpose="What they are asked to design, and what it is made of. The record is always part of it; the contracts and the sequence diagram are yours to switch on."
      state={state}
      art="/artwork/dashboard-design-3d.webp"
      testId="tde-learner-design"
      whose={whose && <ProvenanceChip state={whose} referenceName={referenceName} testId={`task-provenance-${task.taskKey}`} />}
      onFocusCard={onFocusCard}
      onLeave={editable ? save.saveSoon : undefined}
    >
      <div className="tre-story">
        <div className="tre-story-head">
          {editable ? (
            <input
              className="field tre-in tre-in-wide"
              aria-label="Title"
              value={title}
              maxLength={TITLE_MAX}
              data-testid="tde-learner-title"
              onChange={(event) => change(setTitle)(event.target.value)}
            />
          ) : (
            <span className="tre-value tre-in-wide">{task.title}</span>
          )}
          <Chip tone={task.required ? 'accent' : 'neutral'}>{task.required ? 'Required' : 'Optional'}</Chip>
        </div>
        {editable ? (
          <>
            <GrowBox
              className="field tre-ta"
              rows={3}
              aria-label="Brief"
              aria-describedby="tde-learner-brief-plain-hint"
              value={brief}
              maxLength={BRIEF_MAX}
              data-testid="tde-learner-brief"
              onChange={(event) => change(setBrief)(event.target.value)}
            />
            <PlainTextHint id="tde-learner-brief-plain-hint" />
          </>
        ) : (
          <p className="purpose wrap" data-testid="tde-learner-brief-text">
            {task.brief}
          </p>
        )}
        <label className="tre-labelled">
          <span className="label-sm">What learners aim for, one per line</span>
          {editable ? (
            <GrowBox
              className="field tre-ta"
              rows={3}
              aria-label="Objectives, one per line"
              value={objectives}
              data-testid="tde-learner-objectives"
              onChange={(event) => change(setObjectives)(event.target.value)}
            />
          ) : (
            <span className="tre-value" data-testid="tde-learner-objectives-text">
              {task.objectives.length ? task.objectives.join('; ') : 'None'}
            </span>
          )}
        </label>
      </div>

      <ul className="tde-switches" aria-label="What the design is made of">
        {DESIGN_SWITCHES.map((one) => {
          const on = isOn(switches, one.key);
          return (
            <li key={one.key} className={`tde-switch-row ${on ? 'tde-switch-row-on' : ''}`}>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={one.name}
                aria-describedby={`${base}-${one.key}`}
                className={`tde-switch ${on ? 'tde-switch-on' : ''}`}
                disabled={!editable}
                data-testid={one.testId}
                onClick={() => press(one.key)}
              >
                <span className="tde-switch-knob" aria-hidden="true" />
              </button>
              <span id={`${base}-${one.key}`} className="tde-switch-text wrap">
                {one.sentence}
              </span>
            </li>
          );
        })}
      </ul>
      {editable && asking && (
        <div className="tde-confirm" role="group" aria-label={`Switch the ${asking.key === 'api' ? 'API' : 'screen'} contract off`}>
          <p className="label-sm wrap" role="status" data-testid="tde-switch-confirm-line">
            {asking.line}
          </p>
          <span className="tde-actions">
            <Button size="sm" variant="danger" testId="tde-switch-confirm" onClick={() => flip(asking.key)}>
              Switch it off
            </Button>
            <Button size="sm" variant="ghost" testId="tde-switch-keep" onClick={() => setAsking(null)}>
              Keep it
            </Button>
          </span>
        </div>
      )}

      {editable && (
        <div className="tre-save-row">
          <SaveLine save={save} testId="tde-learner-status" idle="Edits save when you leave the card." />
          <Button
            size="sm"
            variant="secondary"
            busy={save.status === 'saving'}
            busyLabel="Saving…"
            testId="tde-learner-save"
            onClick={() => void save.saveNow()}
          >
            Save the learner's design
          </Button>
        </div>
      )}
    </BuilderCard>
  );
}
