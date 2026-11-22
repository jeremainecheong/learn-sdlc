'use client';

/**
 * Step 2: the stories the learner designs for.
 *
 * One row per story: its id, its title and the one line the learner reads.
 * The list is the design task's own (`checks.stories`), at most 12, each id
 * once. "Copy from Requirements" fills it from the draft's Requirements
 * phase, after a confirm line, replacing what is listed here; what it copies
 * is held to the same caps, so the save it starts is never one the door
 * refuses. The card saves its list with the rest of the design body as the
 * server holds it.
 */
import { useRef, useState } from 'react';
import type { DesignStory, DraftPhaseView, DraftTaskView, TaskMutationResult } from '@learnsdlc/shared';
import { DESIGN_CAPS, pluralWord } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui';
import { BuilderCard, SaveLine, useCardSave, type CardState } from '../requirements/BuilderCard';
import { copyFromRequirements, designBodyOf, storiesProblem, type DesignTaskWrite } from './design-builder-model';

interface Row extends DesignStory {
  /** Which row this is, for as long as the card is open; never sent. */
  uid: number;
}

let rowCount = 0;
const nextUid = () => (rowCount += 1);
const rowsOf = (stories: readonly DesignStory[]): Row[] => stories.map((one) => ({ ...one, uid: nextUid() }));
const storiesOf = (rows: readonly Row[]): DesignStory[] => rows.map(({ id, title, line }) => ({ id, title, line }));

/** The next free id in the list's own style: its prefix, and the smallest number no row holds. */
function nextId(rows: readonly Row[]): string {
  const prefix = rows.map((one) => /^(.*?)\d+$/.exec(one.id)?.[1]).find((one) => one !== undefined) ?? 'US-';
  const taken = new Set(rows.map((one) => one.id));
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function StoriesCard({
  draft,
  task,
  writeTask,
  editable,
  state,
  onFocusCard,
  onSaved,
}: {
  /** The whole draft, for Copy from Requirements. */
  draft: { phases: DraftPhaseView[] };
  task: DraftTaskView;
  writeTask: DesignTaskWrite;
  editable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => rowsOf(task.design?.stories ?? []));
  // The rows a save sends, read when its turn comes: a copy saves straight
  // after it replaces the rows, before React has drawn them.
  const held = useRef(rows);
  const [asking, setAsking] = useState(false);
  const copy = copyFromRequirements(draft);

  const save = useCardSave({
    label: 'Stories to design for',
    saveButton: 'Save the stories',
    validate: () => storiesProblem(held.current),
    send: () => {
      const stories = storiesOf(held.current);
      return writeTask((server) => ({ design: { ...(server ?? designBodyOf(task)), stories } }));
    },
    onSaved,
  });

  const edit = (next: Row[]) => {
    held.current = next;
    setRows(next);
    save.changed();
  };
  const setRow = (at: number, patch: Partial<DesignStory>) => edit(rows.map((one, i) => (i === at ? { ...one, ...patch } : one)));
  const full = rows.length >= DESIGN_CAPS.stories;

  return (
    <BuilderCard
      n={2}
      title="Stories to design for"
      purpose="The stories the learner's design has to serve. Each one is listed in their room, and the floor can ask that every one is traced."
      state={state}
      testId="tde-stories"
      onFocusCard={onFocusCard}
      onLeave={editable ? save.saveSoon : undefined}
    >
      {rows.length === 0 && (
        <p className="purpose wrap" data-testid="tde-stories-none">
          No stories yet. Add one, or copy them from Requirements.
        </p>
      )}
      <ol className="tde-stories" aria-label="Stories to design for">
        {rows.map((row, at) => (
          <li key={row.uid} className="tde-story" data-testid={`tde-story-${at}`}>
            {editable ? (
              <>
                <input
                  className="field tre-in tre-id"
                  aria-label={`Story ${at + 1} id`}
                  value={row.id}
                  maxLength={DESIGN_CAPS.storyId}
                  data-testid={`tde-story-${at}-id`}
                  onChange={(event) => setRow(at, { id: event.target.value.trim() })}
                />
                <input
                  className="field tre-in tre-in-wide"
                  aria-label={`Story ${at + 1} title`}
                  value={row.title}
                  maxLength={DESIGN_CAPS.storyText}
                  data-testid={`tde-story-${at}-title`}
                  onChange={(event) => setRow(at, { title: event.target.value })}
                />
                <input
                  className="field tre-in tde-story-line"
                  aria-label={`Story ${at + 1} line`}
                  value={row.line}
                  maxLength={DESIGN_CAPS.storyText}
                  data-testid={`tde-story-${at}-line`}
                  onChange={(event) => setRow(at, { line: event.target.value })}
                />
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  aria-label={`Remove story ${at + 1}`}
                  data-testid={`tde-story-${at}-remove`}
                  onClick={() => edit(rows.filter((_, i) => i !== at))}
                >
                  <Icon name="trash" size={13} /> Remove
                </button>
              </>
            ) : (
              <>
                <code className="mono">{row.id}</code>
                <span className="tre-value">{row.title}</span>
                <span className="purpose wrap tde-story-line">{row.line}</span>
              </>
            )}
          </li>
        ))}
      </ol>
      {editable && (
        <div className="tde-actions">
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            disabled={full}
            reason={full ? `At most ${DESIGN_CAPS.stories} stories.` : undefined}
            testId="tde-story-add"
            onClick={() => edit([...rows, { uid: nextUid(), id: nextId(rows), title: '', line: '' }])}
          >
            Add a story
          </Button>
          {copy && (
            <Button size="sm" variant="ghost" icon="file" testId="tde-copy-requirements" onClick={() => setAsking(true)}>
              Copy from Requirements
            </Button>
          )}
        </div>
      )}
      {editable && copy && asking && (
        <div className="tde-confirm" role="group" aria-label="Copy from Requirements" data-testid="tde-copy-confirm-line">
          {/* announced when it appears: the question a screen reader must hear before the two buttons */}
          <p className="label-sm wrap" role="status">
            {`This replaces the ${rows.length} ${pluralWord(rows.length, 'story', 'stories')} listed here with ${copy.stories.length} from Requirements.`}
            {copy.left.length > 0 && ` ${copy.left.length === 1 ? 'One story' : `${copy.left.length} stories`} did not fit and ${copy.left.length === 1 ? 'was' : 'were'} left out: ${copy.left.join(', ')}.`}
          </p>
          <span className="tde-actions">
            <Button
              size="sm"
              variant="secondary"
              testId="tde-copy-confirm"
              onClick={() => {
                setAsking(false);
                edit(rowsOf(copy.stories));
                void save.saveNow();
              }}
            >
              Copy them
            </Button>
            <Button size="sm" variant="ghost" testId="tde-copy-keep" onClick={() => setAsking(false)}>
              Keep mine
            </Button>
          </span>
        </div>
      )}
      {editable && (
        <div className="tre-save-row">
          <SaveLine
            save={save}
            testId="tde-stories-status"
            idle={`Edits save when you leave the card. ${rows.length} of ${DESIGN_CAPS.stories} stories.`}
          />
          <Button
            size="sm"
            variant="secondary"
            busy={save.status === 'saving'}
            busyLabel="Saving…"
            testId="tde-stories-save"
            onClick={() => void save.saveNow()}
          >
            Save the stories
          </Button>
        </div>
      )}
    </BuilderCard>
  );
}
