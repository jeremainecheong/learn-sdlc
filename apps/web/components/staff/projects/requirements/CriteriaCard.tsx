'use client';

/**
 * Step 5: what the review judges the learner's story against.
 *
 * One card per criterion: a title, what meeting it looks like, and a weight.
 * Weights may be typed as decimals (0.3) or percentages (30%); the body
 * always sends decimals, and the save is held until they sum to 1, which is
 * the rule the door refuses by (`Weights must sum to 1.`). A criterion's key
 * is made from its title the first time it is saved and kept after that, so
 * a reworded title never moves the key a grade is stored under.
 *
 * A row whose key the phase's own checks grade (`locked`, Deployment's file
 * rules' criteria and `build_smoke`) keeps its key and cannot be removed;
 * its title, description and weight stay editable. The key itself is never
 * drawn: the teacher reads the criterion by its title, and the line that
 * says why Remove is off names the title in the key's place.
 *
 * The pass mark does not decide a pass on any phase that draws this card
 * (`strictTaskEvidencePassed`, `strict-evidence.ts`, never reads it), which is
 * what the learner's review says ("There is no numerical pass threshold"). The
 * line beside the stepper (`passMarkLine`) says what does, for this phase and
 * this task:
 * - Requirements and Design (`floorGraded`) score every criterion by the share
 *   of floor rules that pass (`floor-partial.ts`), so every check passing is a
 *   score of 100, and at 100 the review's verdict is advice once more than half
 *   of the criteria are met (`reviewerVerdictIsAdvice`). A weight moves no
 *   score there, so their purpose lines say nothing about weights.
 * - The four executable phases score the weighted sum (`overallScore`): the
 *   review's pass with every criterion met, or more than half met at 100. The
 *   line gives only what both ways need, every check passing and more than
 *   half of the criteria met (all of them on the review's pass), so it says
 *   "only when" there.
 * - A task marked for sign-off is not passed by the review: it waits for the
 *   teacher (`taskRollup`, `awaitingSignOff`), and only once the verdict passes.
 * A sign-off writes `Math.max(bestScore, passThreshold)` on the task's row
 * (`signoff.ts`, and `task-signoff` in `instructor.service.ts`, on any task of
 * a list that is not one sole task), and so does the phase's Pass, on a
 * required task that is not marked for sign-off only (the Pass skips the
 * others), so the learner has at least the pass mark. On a required, unmarked
 * task the line names the Pass alone: a class on a version compiled as one
 * sole task per phase (a platform pack) has no per-task sign-off
 * (`SOLE_TASK_LEVER_REFUSAL`), and the Pass writes the mark either way. An
 * optional or marked task is never a sole task, so its sign-off is drawn.
 *
 * A stored rubric that breaks the loader's caps (a version stored before they
 * bound the export read-back) has each breach named above the rows, in
 * `rubricCapBreaches`'s words, so the teacher fixes it here and exports.
 *
 * Where the grader scores every key itself (Implementation and Testing,
 * `allowAdd` false), no criterion can be added either, and the card says so.
 *
 * While nothing is typed here since the last save and no save of the card is
 * out, each answer for the task redraws every row's title and sentence with
 * the server's words, by key: the server stores them plain.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { DraftTaskView, RubricBody, TaskMutationResult, UpdateTaskBody } from '@learnsdlc/shared';
import { RUBRIC_CRITERION_DESCRIPTION_MAX, RUBRIC_CRITERION_TITLE_MAX, lockedCriterionRefusal, rubricCapBreaches } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui';
import { BuilderCard, SaveLine, Stepper, useCardSave, type CardState } from './BuilderCard';
import {
  KEYS_REFUSAL,
  NO_CRITERION_REFUSAL,
  WEIGHTS_REFUSAL,
  WEIGHT_TOLERANCE,
  defaultStoryBody,
  keysOf,
  parseWeight,
} from './builder-model';
import { GrowBox } from '../GrowBox';

/** The builder's door caps a criterion's description here, in every builder. */
const DESCRIPTION_MAX = RUBRIC_CRITERION_DESCRIPTION_MAX;
const CRITERIA_MAX = 40;

const shown = (n: number) => String(Math.round(n * 1000) / 1000);

interface Row {
  /** Which row this is, for as long as the card is open; never sent. */
  uid: number;
  /** The saved key, or '' for a criterion not saved yet (its key follows its title). */
  key: string;
  title: string;
  description: string;
  weightText: string;
}

/**
 * The line beside the pass mark: what passes this task's work on this phase,
 * and what the mark writes. Each clause is the API's rule (the header above
 * names the lines). With no criterion at all the save is refused and nothing
 * passes, so only the mark's sentence is said.
 */
function passMarkLine({
  work,
  floorGraded,
  criteria,
  required,
  signOff,
}: {
  work: { subject: string; verb: 'pass' | 'passes' };
  floorGraded: boolean;
  criteria: number;
  required: boolean;
  signOff: boolean;
}): string {
  const rule =
    criteria === 1
      ? 'every check passes and the review finds the criterion met'
      : 'every check passes and the review finds more than half of the criteria met';
  // Exact both ways on Requirements and Design; on the executable phases a
  // condition the pass needs, not all of it.
  const when = floorGraded ? 'when' : 'only when';
  const opens = signOff
    ? `${work.subject} ${work.verb === 'pass' ? 'are' : 'is'} ready for your sign-off ${when}`
    : `${work.subject} ${work.verb} ${when}`;
  const mark =
    required && !signOff
      ? 'Passing this phase by hand gives a learner at least the pass mark.'
      : 'Signing off this task gives a learner at least the pass mark.';
  if (criteria === 0) return mark;
  return `${opens} ${rule}; the pass mark does not decide that. ${mark}`;
}

let rowCount = 0;
const nextUid = () => (rowCount += 1);

export function CriteriaCard({
  task,
  writeTask,
  editable,
  state,
  onFocusCard,
  onSaved,
  olderFormatBody = () => ({ story: defaultStoryBody() }),
  n = 5,
  locked: lockedKeys = [],
  testId = 'tre-criteria',
  allowAdd = true,
  purpose = 'What the review judges the story against, in your words.',
  work = { subject: 'A story', verb: 'passes' },
  floorGraded = true,
}: {
  task: DraftTaskView;
  /**
   * The builder's one queue for task saves: given the checks body the server
   * holds when its turn comes (null on a task still in the older format), the
   * body to send.
   */
  writeTask: (build: (held: unknown | null) => UpdateTaskBody) => Promise<TaskMutationResult>;
  editable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
  /**
   * What goes with the rubric on a task still in the older format, which
   * converts it: the door takes a rubric only on a structured task. The
   * default story body on Requirements; the Design builder passes the
   * converted design body the server showed.
   */
  olderFormatBody?: () => Partial<UpdateTaskBody>;
  /** The step's number in its builder. */
  n?: number;
  /** The keys the phase's own checks grade: those rows' key and Remove are locked, and nothing else. */
  locked?: string[];
  testId?: string;
  /** False where every criterion is the grader's own: Add is not drawn, and the card says why. */
  allowAdd?: boolean;
  purpose?: string;
  /**
   * The phase's work as the pass mark's line opens with it, with its verb so
   * the two agree ("A story passes", "The tests pass").
   */
  work?: { subject: string; verb: 'pass' | 'passes' };
  /**
   * True on Requirements and Design, whose criteria are all scored by the
   * share of floor rules that pass; false on the four executable phases.
   */
  floorGraded?: boolean;
}) {
  const idBase = useId();
  const [rows, setRows] = useState<Row[]>(() =>
    (task.rubric?.criteria ?? []).map((one) => ({
      uid: nextUid(),
      key: one.key,
      title: one.title,
      description: one.description,
      weightText: shown(one.weight),
    })),
  );
  const [pass, setPass] = useState(task.rubric?.passThreshold ?? 70);

  const weights = rows.map((one) => parseWeight(one.weightText));
  const sum = weights.reduce((total, one) => total + (Number.isFinite(one) ? one : 0), 0);
  const weightsOk = rows.length > 0 && weights.every(Number.isFinite) && Math.abs(sum - 1) <= WEIGHT_TOLERANCE;
  // The keys a save's answer has fixed, by row. A ref and not only the rows'
  // state, because a save run again straight after an answer is built from
  // the render before that answer reached the rows.
  const locked = useRef(new Map<number, string>());
  const keysNow = () => keysOf(rows.map((row) => ({ ...row, key: row.key || locked.current.get(row.uid) || '' })));

  const rubric = (): RubricBody => {
    const sentKeys = keysNow();
    return {
      passThreshold: pass,
      criteria: rows.map((row, at) => ({
        key: sentKeys[at],
        title: row.title,
        description: row.description,
        weight: weights[at],
      })),
    };
  };

  // Typed here since the last save went out, and a save of the card still out: the rows are not the server's then.
  const typed = useRef(false);
  const out = useRef(false);

  const save = useCardSave({
    label: 'Criteria',
    saveButton: 'Save the criteria',
    validate: () => {
      if (rows.length === 0) return NO_CRITERION_REFUSAL;
      const untitled = rows.findIndex((one) => !one.title.trim());
      if (untitled >= 0) return `Give criterion ${untitled + 1} a title before you save it.`;
      if (!weightsOk) return WEIGHTS_REFUSAL;
      const now = keysNow();
      if (new Set(now).size !== now.length) return KEYS_REFUSAL;
      if (!Number.isInteger(pass) || pass < 1 || pass > 100) return 'The pass mark is a whole number from 1 to 100.';
      return '';
    },
    send: async () => {
      const sent = rubric();
      // The keys this save sent, by row, so the reply locks those and not
      // whatever the rows' titles have become while it was out.
      const sentKeys = new Map(rows.map((row, at) => [row.uid, sent.criteria[at].key]));
      typed.current = false;
      out.current = true;
      let result: TaskMutationResult;
      try {
        result = await writeTask((held) => (held ? { rubric: sent } : { rubric: sent, ...olderFormatBody() }));
      } catch (err) {
        typed.current = true;
        throw err;
      } finally {
        out.current = false;
      }
      for (const [uid, key] of sentKeys) if (!locked.current.has(uid)) locked.current.set(uid, key);
      setRows((was) => was.map((row) => ({ ...row, key: row.key || locked.current.get(row.uid) || '' })));
      return result;
    },
    onSaved,
  });

  const edit = (next: Row[]) => {
    setRows(next);
    typed.current = true;
    save.changed();
  };

  // A new answer for the task (this card's save or another step's): clean rows take the server's words, by key.
  const seen = useRef(task);
  useEffect(() => {
    if (seen.current === task) return;
    seen.current = task;
    const criteria = task.rubric?.criteria;
    if (typed.current || out.current || !criteria) return;
    setRows((was) =>
      was.map((row) => {
        const key = row.key || locked.current.get(row.uid) || '';
        const held = key ? criteria.find((one) => one.key === key) : undefined;
        return held && (held.title !== row.title || held.description !== row.description) ? { ...row, title: held.title, description: held.description } : row;
      }),
    );
  }, [task]);
  const setRow = (at: number, patch: Partial<Row>) => edit(rows.map((one, i) => (i === at ? { ...one, ...patch } : one)));

  return (
    <BuilderCard
      n={n}
      title="Criteria"
      purpose={purpose}
      state={state}
      testId={testId}
      onFocusCard={onFocusCard}
      onLeave={editable ? save.saveSoon : undefined}
    >
      {task.rubric && rubricCapBreaches(task.rubric).map((line) => <p key={line} role="alert" className="label-sm wrap text-fail" data-testid={`${testId}-cap`}>{line}</p>)}
      <ol className="tre-crits" aria-label="Criteria">
        {rows.map((row, at) => {
          const n = at + 1;
          const weight = weights[at];
          // A row the phase's own checks grade says why its Remove is off in words beside it, not only in a tooltip.
          // Named by the row's title, never its key: the shared sentence takes the key and the title and names the
          // criterion by the title; an untitled row is named by its place, so the key is never drawn.
          const lockedWhy = row.key && lockedKeys.includes(row.key) ? lockedCriterionRefusal(row.key, row.title.trim() || `Criterion ${n}`) : null;
          const lockedId = `${idBase}-locked-${n}`;
          return (
            <li key={row.uid} className="tre-crit" data-testid={`tre-criterion-${n}`}>
              <div className="tre-crit-head">
                {editable ? (
                  <input
                    className="field tre-in tre-in-wide tre-crit-title"
                    aria-label={`Criterion ${n} title`}
                    value={row.title}
                    maxLength={RUBRIC_CRITERION_TITLE_MAX}
                    onChange={(event) => setRow(at, { title: event.target.value })}
                  />
                ) : (
                  <span className="tre-crit-title">{row.title}</span>
                )}
              </div>
              {editable ? (
                <GrowBox
                  className="field tre-ta"
                  rows={3}
                  aria-label={`Criterion ${n} description`}
                  value={row.description}
                  maxLength={DESCRIPTION_MAX}
                  onChange={(event) => setRow(at, { description: event.target.value })}
                />
              ) : (
                <p className="purpose wrap">{row.description}</p>
              )}
              <div className="tre-weight">
                <span className="label-sm">Weight</span>
                <span className="tre-weight-bar" aria-hidden="true">
                  <span style={{ width: `${Number.isFinite(weight) ? Math.min(100, weight * 100) : 0}%` }} />
                </span>
                {editable ? (
                  <Stepper
                    value={weight}
                    min={0}
                    max={1}
                    step={0.1}
                    label={`Criterion ${n} weight`}
                    less={`Less weight for criterion ${n}`}
                    more={`More weight for criterion ${n}`}
                    inputText={row.weightText}
                    onText={(weightText) => setRow(at, { weightText })}
                    onChange={(next) => setRow(at, { weightText: shown(next) })}
                  />
                ) : (
                  <strong>{row.weightText}</strong>
                )}
              </div>
              {editable && (
                <div>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    aria-label={`Remove criterion ${n}`}
                    disabled={Boolean(lockedWhy)}
                    title={lockedWhy ?? undefined}
                    aria-describedby={lockedWhy ? lockedId : undefined}
                    onClick={() => edit(rows.filter((_, i) => i !== at))}
                  >
                    <Icon name="trash" size={13} /> Remove
                  </button>
                  {lockedWhy && <p id={lockedId} className="label-sm wrap" data-testid={`tre-criterion-${n}-locked`}>{lockedWhy}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!allowAdd && (
        <p className="label-sm wrap" data-testid={`${testId}-fixed`}>
          These criteria are fixed: the grader scores each one. Change their sentences and weights.
        </p>
      )}
      <div className="tre-crit-foot">
        {editable && allowAdd && (
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            disabled={rows.length >= CRITERIA_MAX}
            reason={rows.length >= CRITERIA_MAX ? `A rubric holds at most ${CRITERIA_MAX} criteria.` : undefined}
            testId="tre-criteria-add"
            onClick={() => edit([...rows, { uid: nextUid(), key: '', title: '', description: '', weightText: '0' }])}
          >
            Add a criterion
          </Button>
        )}
        {weightsOk ? (
          <span className="tre-sum" data-testid="tre-weights-sum">
            <Icon name="check" size={13} /> Weights sum to 1.0
          </span>
        ) : (
          <span className="tre-sum tre-sum-off" data-testid="tre-weights-sum">
            {`Weights sum to ${shown(sum)} now. They must sum to 1.`}
          </span>
        )}
        <span className="tre-passmark">
          <span className="label-sm">Pass mark</span>
          {editable ? (
            <Stepper
              value={pass}
              min={1}
              max={100}
              step={5}
              label="Pass mark"
              less="Lower pass mark"
              more="Higher pass mark"
              onChange={(next) => {
                setPass(next);
                save.changed();
              }}
            />
          ) : (
            <strong>{pass}</strong>
          )}
        </span>
      </div>
      <p className="label-sm wrap" data-testid={`${testId}-passmark`}>
        {passMarkLine({ work, floorGraded, criteria: rows.length, required: task.required, signOff: task.signOff === true })}
      </p>
      {editable && (
        <div className="tre-save-row">
          <SaveLine save={save} testId="tre-criteria-status" idle="Edits save when you leave the card." />
          <Button
            size="sm"
            variant="secondary"
            busy={save.status === 'saving'}
            busyLabel="Saving…"
            testId="tre-criteria-save"
            onClick={() => void save.saveNow()}
          >
            Save the criteria
          </Button>
        </div>
      )}
    </BuilderCard>
  );
}
