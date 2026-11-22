'use client';

/**
 * Step 4: the story the learner writes, and the floor it is held to.
 *
 * The task's title and brief, the story id (fixed, or the learner's to pick),
 * the three hints the learner's form shows greyed, and the four floor
 * controls. Each control maps onto one of the four floor checks the learner's
 * room runs, with the same `StoryFloor`, so what is set here is exactly what
 * the learner is checked against. The floor is summed up in one plain
 * sentence, `floorSentence`, the one the learner's room reads; nothing here is
 * a score.
 *
 * The card saves the title, the brief and the story body. The provided
 * stories ride along as the server holds them: what step 3 holds unsaved is
 * step 3's to save. On a task still in the older format the first save of
 * any story step (3, 4 or 5) converts it, so the notice says so.
 */
import { useState } from 'react';
import type {
  ElementProvenance,
  DraftTaskView,
  LearnerStorySpec,
  StoryChecksBody,
  StoryFloor,
  TaskMutationResult,
} from '@learnsdlc/shared';
import { LEARNER_PICKS, TASK_BRIEF_MAX, TASK_TITLE_MAX } from '@learnsdlc/shared';
import { Button, Chip } from '@/components/ui';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { ProvenanceChip } from '../PhaseScenario';
import { SignOffHelp, SignOffToggle, signOffHelpIds } from '../TaskEditor';
import { BuilderCard, SaveLine, useCardSave, useServerRedraw, type CardState } from './BuilderCard';
import { OLDER_FORMAT_NOTICE, OLDER_FORMAT_NOTICE_READONLY, defaultStoryBody, learnerIdClash } from './builder-model';
import { FloorBox } from './FloorBox';
import { PlainTextHint } from '../PlainTextHint';
import { GrowBox } from '../GrowBox';
import type { TaskWrite } from './RequirementsBuilder';

const ID_MAX = 16;
const TITLE_MAX = TASK_TITLE_MAX;
const BRIEF_MAX = TASK_BRIEF_MAX;
const HINT_MAX = 400;

type HintKey = 'persona' | 'capability' | 'benefit';
const HINTS: { key: HintKey; label: string }[] = [
  { key: 'persona', label: 'As a' },
  { key: 'capability', label: 'I want' },
  { key: 'benefit', label: 'So that' },
];

/** The hints as the body sends them: an empty one is left out, so the learner finds it in the interview. */
function hintsOf(hints: Record<HintKey, string>): LearnerStorySpec['hints'] {
  const out: LearnerStorySpec['hints'] = {};
  for (const { key } of HINTS) if (hints[key].trim()) out[key] = hints[key];
  return out;
}

export function LearnerStoryCard({
  projectId,
  versionId,
  task,
  saved,
  writeTask,
  currentStory,
  legacy,
  editable,
  state,
  onFocusCard,
  onSaved,
  onSignOff,
  onTitle,
  whose,
  referenceName,
}: {
  projectId: string;
  versionId: string;
  task: DraftTaskView;
  /** The story body as the server held it at the last render (defaults on a task in the older format). */
  saved: StoryChecksBody;
  /** The builder's one queue for task saves. */
  writeTask: TaskWrite;
  /** The story body the server holds now, from the last save's answer; null in the older format. */
  currentStory: () => StoryChecksBody | null;
  /** The task has no story yet: its first save converts it. */
  legacy: boolean;
  editable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
  /** The editor's save of the sign-off mark; absent, the card saves it itself. */
  onSignOff?: (signOff: boolean) => Promise<void>;
  /** The title as typed, for the learner's row in step 3. */
  onTitle: (title: string) => void;
  /** Whose the task is, on a copied project, or null. */
  whose: ElementProvenance | null;
  referenceName: string;
}) {
  const [title, setTitle] = useState(task.title);
  const [brief, setBrief] = useState(task.brief);
  const savedId = saved.learnerStory.id;
  const [picks, setPicks] = useState(savedId === LEARNER_PICKS);
  const [id, setId] = useState(savedId === LEARNER_PICKS ? '' : savedId);
  const [hints, setHints] = useState<Record<HintKey, string>>({
    persona: saved.learnerStory.hints.persona ?? '',
    capability: saved.learnerStory.hints.capability ?? '',
    benefit: saved.learnerStory.hints.benefit ?? '',
  });
  const [floor, setFloor] = useState<StoryFloor>({ ...saved.floor, requiredTags: [...saved.floor.requiredTags] });
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState('');

  const learnerId = picks ? LEARNER_PICKS : id;
  const save = useCardSave({
    label: "The learner's story",
    saveButton: "Save the learner's story",
    validate: () => {
      if (!title.trim()) return 'Give the task a title before you save it.';
      if (!brief.trim()) return 'Write the brief before you save it. It is what the learner reads first.';
      if (!picks && !id.trim()) return 'Give the story an id, or let the learner pick it.';
      const provided = (currentStory() ?? defaultStoryBody()).providedStories;
      if (provided.some((one) => one.id === learnerId)) return learnerIdClash(learnerId);
      return '';
    },
    send: () => {
      const learnerStory = { id: learnerId, hints: hintsOf(hints) };
      const sentFloor = floor;
      const words = { title, brief, objectives: task.objectives, artefactType: 'user-story' as const };
      // The provided stories as the server holds them when this save's turn
      // comes, so a step 3 save just before it is never undone.
      return writeTask((story) => ({
        ...words,
        story: { providedStories: (story ?? defaultStoryBody()).providedStories, learnerStory, floor: sentFloor },
      }));
    },
    onSaved,
  });
  // Each new answer redraws the words and the hints with the server's while nothing is typed here.
  // `saved` is the builder's reading of this same task, so it is the answer's too.
  useServerRedraw(task, save.clean, (next) => {
    setTitle(next.title);
    onTitle(next.title);
    setBrief(next.brief);
    setHints({
      persona: saved.learnerStory.hints.persona ?? '',
      capability: saved.learnerStory.hints.capability ?? '',
      benefit: saved.learnerStory.hints.benefit ?? '',
    });
  });

  const change = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    save.changed();
  };
  const signOffHelp = 'task-signoff-help-requirements';

  return (
    <BuilderCard
      n={4}
      title="The learner's story"
      purpose="The one they write themselves. Set the brief, then the floor: the minimums checked before the review."
      state={state}
      art="/artwork/requirements-boundaries-3d.webp"
      testId="tre-learner-story"
      whose={whose && <ProvenanceChip state={whose} referenceName={referenceName} testId={`task-provenance-${task.taskKey}`} />}
      onFocusCard={onFocusCard}
      onLeave={editable ? save.saveSoon : undefined}
    >
      {legacy && (
        <p className="tre-legacy label-sm wrap" data-testid="tre-legacy">
          {editable ? OLDER_FORMAT_NOTICE : OLDER_FORMAT_NOTICE_READONLY}
        </p>
      )}
      <div className="tre-story">
        <div className="tre-story-head">
          {editable ? (
            <>
              {picks ? (
                <code className="mono">Learner picks</code>
              ) : (
                <input
                  className="field tre-in tre-id"
                  aria-label="Story id"
                  value={id}
                  maxLength={ID_MAX}
                  data-testid="tre-learner-id"
                  onChange={(event) => change(setId)(event.target.value.trim())}
                />
              )}
              <input
                className="field tre-in tre-in-wide"
                aria-label="Title"
                value={title}
                maxLength={TITLE_MAX}
                data-testid="tre-learner-title"
                onChange={(event) => {
                  change(setTitle)(event.target.value);
                  onTitle(event.target.value);
                }}
              />
            </>
          ) : (
            <>
              <code className="mono">{savedId === LEARNER_PICKS ? 'Learner picks' : savedId}</code>
              <span className="tre-value tre-in-wide">{task.title}</span>
            </>
          )}
          <Chip tone={task.required ? 'accent' : 'neutral'}>{task.required ? 'Required' : 'Optional'}</Chip>
        </div>
        {editable && (
          <label className="tre-check">
            <input
              type="checkbox"
              checked={picks}
              data-testid="tre-learner-picks"
              onChange={(event) => change(setPicks)(event.target.checked)}
            />
            <span>The learner picks the id</span>
          </label>
        )}
        {editable ? (
          <>
            <GrowBox
              className="field tre-ta"
              rows={2}
              aria-label="Brief"
              aria-describedby="tre-learner-brief-plain-hint"
              value={brief}
              maxLength={BRIEF_MAX}
              data-testid="tre-learner-brief"
              onChange={(event) => change(setBrief)(event.target.value)}
            />
            <PlainTextHint id="tre-learner-brief-plain-hint" />
          </>
        ) : (
          <p className="purpose wrap" data-testid="tre-learner-brief-text">
            {task.brief}
          </p>
        )}
        <div className="tre-sentence">
          {HINTS.map(({ key, label }) => (
            <div key={key}>
              <span className="label-sm">{label}</span>
              {editable ? (
                <input
                  className="field tre-in"
                  aria-label={`${label} hint`}
                  placeholder="Optional hint"
                  value={hints[key]}
                  maxLength={HINT_MAX}
                  onChange={(event) => change(setHints)({ ...hints, [key]: event.target.value })}
                />
              ) : (
                <span className="tre-value">{saved.learnerStory.hints[key] || 'No hint'}</span>
              )}
            </div>
          ))}
        </div>
        <p className="label-sm wrap">
          Hints appear greyed inside the learner's form. Leave one empty to make them find it in the interview.
        </p>
      </div>

      <FloorBox floor={floor} editable={editable} onChange={change(setFloor)} />

      {!editable && task.signOff === true && (
        <p className="label-sm wrap" data-testid="tre-signoff-read">
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
                onSaved(await projectsApi.updateTask(projectId, versionId, 'requirements', task.taskKey, { signOff }));
              } catch (err) {
                setSignError(describeError(err, 'The mark could not be saved. Try again in a moment.'));
              } finally {
                setSigning(false);
              }
            }}
          />
          {signError && (
            <p role="alert" className="label-sm wrap text-fail" data-testid="tre-signoff-error">
              {signError}
            </p>
          )}
          <div className="tre-save-row">
            <SaveLine save={save} testId="tre-learner-status" idle="Edits save when you leave the card." />
            <Button
              size="sm"
              variant="secondary"
              busy={save.status === 'saving'}
              busyLabel="Saving…"
              testId="tre-learner-save"
              onClick={() => void save.saveNow()}
            >
              Save the learner's story
            </Button>
          </div>
        </>
      )}
    </BuilderCard>
  );
}
