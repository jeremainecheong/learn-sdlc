'use client';

/**
 * Step 1 of the Implementation, Testing, Deployment and Maintenance builders:
 * the background learners read first and the task's title, brief and
 * objectives, plain text.
 *
 * The card holds a flush handle (`BriefCardHandle`): a builder calls it before
 * another step's own save goes out, so an edit still waiting here reaches the
 * server first and no other step's answer redraws the card over it.
 *
 * Each save's answer redraws the fields nobody has typed in since and no save
 * still out carries, with the server's words: the server stores a text plain,
 * so the card shows what is stored, not what was typed.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import {
  PHASE_INTRO_MAX,
  TASK_BRIEF_MAX,
  TASK_OBJECTIVES_MAX,
  TASK_OBJECTIVE_MAX,
  TASK_TITLE_MAX,
  type DraftPhaseView,
  type DraftTaskView,
  type TaskMutationResult,
  type UpdateTaskBody,
} from '@learnsdlc/shared';
import { Button } from '@/components/ui';
import { PlainText } from '@/components/PlainText';
import { projectsApi } from '@/lib/api-projects';
import { ProvenanceChip } from './PhaseScenario';
import { BuilderCard, SaveLine, useCardSave, type CardState } from './requirements/BuilderCard';
import { briefNamesOldFile } from './deployment/deployment-builder-model';
import { PlainTextHint } from './PlainTextHint';
import { GrowBox } from './GrowBox';

/** What a builder holds of its Brief card. */
export interface BriefCardHandle {
  /** Sends a waiting words or intro save now, and resolves when it is answered (at once when nothing waits). */
  flush(): Promise<void>;
}

interface BriefCardProps {
  projectId: string;
  versionId: string;
  phase: DraftPhaseView;
  task: DraftTaskView;
  /** The builder's one task queue: given what the server holds of the task's record (null while it is in the older format), the body to send. */
  writeTask: (build: (held: unknown) => UpdateTaskBody) => Promise<TaskMutationResult>;
  /** The phase's intro can be written. */
  editable: boolean;
  /** The task's words can be written. */
  taskEditable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
  /** The file this phase no longer has, named in a warning when the brief still mentions it; null names none. */
  oldFile?: 'RUNBOOK.md' | 'CHANGELOG.md' | null;
  testId?: string;
  /** The card's picture: the phase's own artwork (Maintenance passes its own). */
  art?: string;
  /**
   * The body that converts a task still in the older format, sent with the
   * words while the server holds no record (Deployment's runbook floor: the
   * API refuses the words alone on an unconverted config task). Maintenance
   * passes its change body too, so the first words save converts either
   * phase. Absent, the words go alone.
   */
  olderFormatBody?: () => UpdateTaskBody;
}

/** The objectives as typed, one per line, as the door takes them. */
const objectivesOf = (text: string) =>
  text
    .split('\n')
    .map((one) => one.trim())
    .filter(Boolean);

/**
 * A row of the card: a `<label>` around the field the teacher edits, or, read
 * only, a `<div>` around the text's paragraphs, since a label holds phrasing
 * content and labels a control.
 */
function ReadableRow({ editable, children }: { editable: boolean; children: ReactNode }) {
  return editable ? <label className="tre-labelled">{children}</label> : <div className="tre-labelled">{children}</div>;
}

/** The task's words step 1 writes, each sent only when it changed. */
type WordsField = 'title' | 'brief' | 'objectives';
/** Every field the card holds: the task's words and the phase's intro. */
type CardField = WordsField | 'intro';

/**
 * Step 1: the background learners read first (the phase's intro, through
 * `phases.update`, as the other builders' Background step), and the task's
 * title, brief and objectives (through `tasks.update`). Under them, a line
 * when the brief still names the file this phase no longer has.
 *
 * A words save sends only the fields the teacher changed here since the last
 * one went out, never the card's whole copy, so a save still waiting here
 * never writes back an older brief or title over one saved meanwhile. No
 * other step edits the words; a step that saves the task calls `flush` first,
 * so what waits here goes out before it.
 */
export const BriefCard = forwardRef<BriefCardHandle, BriefCardProps>(function BriefCard(
  {
    projectId,
    versionId,
    phase,
    task,
    writeTask,
    editable,
    taskEditable,
    state,
    onFocusCard,
    onSaved,
    oldFile = 'RUNBOOK.md',
    testId = 'tdp-brief',
    art = '/artwork/dashboard-deployment-3d.webp',
    olderFormatBody,
  },
  ref,
) {
  const [intro, setIntro] = useState(phase.intro);
  const [title, setTitle] = useState(task.title);
  const [brief, setBrief] = useState(task.brief);
  const [objectives, setObjectives] = useState(task.objectives.join('\n'));
  // The words changed here and not yet sent. A save that is refused puts its fields back.
  const touched = useRef(new Set<WordsField>());
  // The intro changed here and not yet sent, and the fields a save still out carries.
  const introTouched = useRef(false);
  const inFlight = useRef(new Set<CardField>());
  const out = (fields: readonly CardField[]) => {
    for (const field of fields) inFlight.current.add(field);
    return () => {
      for (const field of fields) inFlight.current.delete(field);
    };
  };

  const introSave = useCardSave({
    label: 'Brief',
    saveButton: 'Save the brief',
    validate: () => (intro.trim() ? '' : 'Write the intro before you save it. A phase always has one.'),
    send: () => {
      introTouched.current = false;
      const back = out(['intro']);
      return projectsApi.updatePhase(projectId, versionId, phase.key, { intro }).then(
        (result) => {
          back();
          return result;
        },
        (err: unknown) => {
          back();
          introTouched.current = true;
          throw err;
        },
      );
    },
    onSaved,
  });
  const wordsSave = useCardSave({
    label: 'Brief',
    saveButton: 'Save the brief',
    validate: () => {
      if (!title.trim()) return 'Give the task a title before you save it.';
      const list = objectivesOf(objectives);
      if (list.length > TASK_OBJECTIVES_MAX) return `A task holds at most ${TASK_OBJECTIVES_MAX} objectives.`;
      if (list.some((one) => one.length > TASK_OBJECTIVE_MAX)) return `An objective is at most ${TASK_OBJECTIVE_MAX} characters.`;
      return '';
    },
    send: () => {
      const sending = [...touched.current];
      touched.current.clear();
      const words: UpdateTaskBody = {
        ...(sending.includes('title') ? { title } : {}),
        ...(sending.includes('brief') ? { brief } : {}),
        ...(sending.includes('objectives') ? { objectives: objectivesOf(objectives) } : {}),
      };
      const back = out(sending);
      return writeTask((held) => (held || !olderFormatBody ? words : { ...words, ...olderFormatBody() })).then(
        (result) => {
          back();
          return result;
        },
        (err: unknown) => {
          back();
          for (const field of sending) touched.current.add(field);
          throw err;
        },
      );
    },
    onSaved,
  });
  const touch = (field: WordsField) => {
    touched.current.add(field);
    wordsSave.changed();
  };

  // A new answer for the phase or the task (any step's save): each field that is clean takes the server's words.
  const seen = useRef({ phase, task });
  useEffect(() => {
    if (seen.current.phase === phase && seen.current.task === task) return;
    seen.current = { phase, task };
    const clean = (field: CardField) => !inFlight.current.has(field) && (field === 'intro' ? !introTouched.current : !touched.current.has(field));
    if (clean('intro')) setIntro(phase.intro);
    if (clean('title')) setTitle(task.title);
    if (clean('brief')) setBrief(task.brief);
    if (clean('objectives')) setObjectives(task.objectives.join('\n'));
  }, [phase, task]);
  const oldFileLine = oldFile ? briefNamesOldFile({ ...task, brief, objectives: objectivesOf(objectives) }, oldFile) : null;
  useImperativeHandle(
    ref,
    () => ({
      flush: async () => {
        if (editable) await introSave.flush();
        if (taskEditable) await wordsSave.flush();
      },
    }),
    [editable, taskEditable, introSave.flush, wordsSave.flush],
  );

  return (
    <BuilderCard
      n={1}
      title="Brief"
      purpose="Learners read this first: the background, then the task's title, brief and what they aim for."
      state={state}
      art={art}
      testId={testId}
      whose={
        phase.provenance && (
          <ProvenanceChip
            state={phase.provenance.intro}
            referenceName={phase.provenance.referenceName ?? ''}
            testId={`phase-intro-provenance-${phase.key}`}
          />
        )
      }
      onFocusCard={onFocusCard}
      onLeave={() => {
        if (editable) introSave.saveSoon();
        if (taskEditable) wordsSave.saveSoon();
      }}
    >
      <ReadableRow editable={editable}>
        <span className="label-sm">Background</span>
        {editable ? (
          <GrowBox
            className="field tre-ta"
            rows={3}
            aria-label="What learners read first"
            value={intro}
            maxLength={PHASE_INTRO_MAX}
            data-testid={`${testId}-background`}
            onChange={(event) => {
              setIntro(event.target.value);
              introTouched.current = true;
              introSave.changed();
            }}
          />
        ) : (
          <PlainText className="tre-value" text={phase.intro} />
        )}
      </ReadableRow>
      {editable && (
        <SaveLine
          save={introSave}
          testId={`${testId}-background-status`}
          idle={`Edits save when you leave the card. ${intro.length} of ${PHASE_INTRO_MAX} characters.`}
        />
      )}
      <div className="tre-story">
        <label className="tre-labelled">
          <span className="label-sm">Title</span>
          {taskEditable ? (
            <input
              className="field tre-in tre-in-wide"
              aria-label="Title"
              value={title}
              maxLength={TASK_TITLE_MAX}
              data-testid={`${testId}-title`}
              onChange={(event) => {
                setTitle(event.target.value);
                touch('title');
              }}
            />
          ) : (
            <span className="tre-value">{task.title}</span>
          )}
        </label>
        <ReadableRow editable={taskEditable}>
          <span className="label-sm">Brief</span>
          {taskEditable ? (
            <>
              <GrowBox
                className="field tre-ta"
                rows={3}
                aria-label="Brief"
                aria-describedby={`${testId}-plain-hint`}
                value={brief}
                maxLength={TASK_BRIEF_MAX}
                data-testid={`${testId}-text`}
                onChange={(event) => {
                  setBrief(event.target.value);
                  touch('brief');
                }}
              />
              <PlainTextHint id={`${testId}-plain-hint`} />
            </>
          ) : (
            <PlainText className="tre-value" text={task.brief} />
          )}
        </ReadableRow>
        <label className="tre-labelled">
          <span className="label-sm">What learners aim for, one per line</span>
          {taskEditable ? (
            <GrowBox
              className="field tre-ta"
              rows={3}
              aria-label="Objectives, one per line"
              value={objectives}
              data-testid={`${testId}-objectives`}
              onChange={(event) => {
                setObjectives(event.target.value);
                touch('objectives');
              }}
            />
          ) : (
            <span className="tre-value">{task.objectives.length ? task.objectives.join('; ') : 'None'}</span>
          )}
        </label>
      </div>
      {oldFileLine && (
        <p className="tre-legacy label-sm wrap" role="note" data-testid={`${testId}-old-file`}>
          {oldFileLine}
        </p>
      )}
      {taskEditable && (
        <div className="tre-save-row">
          <SaveLine save={wordsSave} testId={`${testId}-status`} idle="Edits save when you leave the card." />
          <Button
            size="sm"
            variant="secondary"
            busy={introSave.status === 'saving' || wordsSave.status === 'saving'}
            busyLabel="Saving…"
            testId={`${testId}-save`}
            onClick={() => {
              if (editable) void introSave.saveNow();
              // Nothing changed here, nothing to send.
              if (touched.current.size) void wordsSave.saveNow();
            }}
          >
            Save the brief
          </Button>
        </div>
      )}
    </BuilderCard>
  );
});
