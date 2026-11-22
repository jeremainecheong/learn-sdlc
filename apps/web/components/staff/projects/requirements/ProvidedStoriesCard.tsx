'use client';

/**
 * Step 3: the stories the backlog already holds when a learner arrives.
 *
 * They are drawn with the learner's own backlog rows (`.jira-issue-row`), so
 * the teacher sees them as the learner will, with the learner's story as the
 * last row. A row opens in place: as an editor while the draft is the
 * teacher's, and as the read-only card the learner reads otherwise.
 *
 * The card saves the provided stories alone. The learner's story and the
 * floor ride along as the server holds them, because the story body is
 * replaced whole and what step 4 holds unsaved is step 4's to save.
 */
import { useState } from 'react';
import type {
  AcceptanceCriterion,
  CriterionTag,
  ProvidedStory,
  StoryChecksBody,
  TaskMutationResult,
} from '@learnsdlc/shared';
import { CRITERION_TAGS, LEARNER_PICKS, STORY_CAPS, newCriterion, renumber } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui';
import { StoryCard } from '@/components/workspace/panels/requirements/StoryCard';
import { BuilderCard, SaveLine, useCardSave, useServerRedraw, type CardState } from './BuilderCard';
import {
  blankCriterionProblem,
  bodyStory,
  defaultStoryBody,
  nextStoryId,
  providedStoriesProblem,
} from './builder-model';
import type { TaskWrite } from './RequirementsBuilder';

/** The id, title and sentence caps the door holds a provided story to. */
const ID_MAX = 16;
const TITLE_MAX = 160;
const PART_MAX = 400;

function ProvidedStoryEditor({
  story,
  onChange,
}: {
  story: ProvidedStory;
  onChange: (next: ProvidedStory) => void;
}) {
  const name = story.id.trim() || 'This story';
  const criteria = story.criteria ?? [];
  const setCriterion = (at: number, patch: Partial<AcceptanceCriterion>) =>
    onChange({ ...story, criteria: criteria.map((one, i) => (i === at ? { ...one, ...patch } : one)) });
  const part = (label: string, value: string, key: 'persona' | 'capability' | 'benefit') => (
    <label className="tre-labelled">
      <span className="label-sm">{label}</span>
      <input
        className="field tre-in"
        aria-label={`${name} ${label}`}
        value={value}
        maxLength={PART_MAX}
        onChange={(event) => onChange({ ...story, [key]: event.target.value })}
      />
    </label>
  );
  return (
    <div className="tre-story tre-story-edit" data-testid={`tre-provided-editor-${story.id}`}>
      <div className="tre-story-head">
        <input
          className="field tre-in tre-id"
          aria-label={`${name} id`}
          value={story.id}
          maxLength={ID_MAX}
          onChange={(event) => onChange({ ...story, id: event.target.value.trim() })}
        />
        <input
          className="field tre-in tre-in-wide"
          aria-label={`${name} title`}
          placeholder="Title"
          value={story.title}
          maxLength={TITLE_MAX}
          onChange={(event) => onChange({ ...story, title: event.target.value })}
        />
      </div>
      <div className="tre-sentence">
        {part('As a', story.persona, 'persona')}
        {part('I want', story.capability, 'capability')}
        {part('So that', story.benefit, 'benefit')}
      </div>
      {criteria.length > 0 && (
        <ol className="tre-criteria" aria-label={`${name} acceptance criteria`}>
          {criteria.map((one, at) => (
            <li key={at} className="tre-criterion">
              <code className="mono">{one.id}</code>
              {(['given', 'when', 'then'] as const).map((clause) => (
                <input
                  key={clause}
                  className="field tre-in"
                  aria-label={`${name} ${one.id} ${clause[0].toUpperCase()}${clause.slice(1)}`}
                  placeholder={`${clause[0].toUpperCase()}${clause.slice(1)}`}
                  value={one[clause]}
                  maxLength={STORY_CAPS.criterionSentence}
                  onChange={(event) => setCriterion(at, { [clause]: event.target.value })}
                />
              ))}
              <select
                className="field tre-in"
                aria-label={`${name} ${one.id} case`}
                value={one.tag}
                onChange={(event) => setCriterion(at, { tag: event.target.value as CriterionTag })}
              >
                {CRITERION_TAGS.map((tag) => (
                  <option key={tag.value} value={tag.value}>
                    {tag.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-ghost btn-sm"
                aria-label={`Remove ${one.id} from ${name}`}
                onClick={() => onChange({ ...story, criteria: renumber(criteria.filter((_, i) => i !== at)) })}
              >
                <Icon name="cross" size={13} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <div>
        <button
          type="button"
          className="btn-ghost btn-sm"
          aria-label={`Add a criterion to ${name}`}
          disabled={criteria.length >= STORY_CAPS.listItems}
          title={criteria.length >= STORY_CAPS.listItems ? `A story holds at most ${STORY_CAPS.listItems} criteria.` : undefined}
          onClick={() => onChange({ ...story, criteria: [...criteria, newCriterion(criteria.length)] })}
        >
          <Icon name="plus" size={13} /> Add a criterion
        </button>
        <span className="label-sm"> Optional. Learners read them as worked examples.</span>
      </div>
    </div>
  );
}

export function ProvidedStoriesCard({
  saved,
  writeTask,
  currentStory,
  learnerTitle,
  editable,
  state,
  onFocusCard,
  onSaved,
}: {
  /** The story body as the server held it at the last render (defaults on a task in the older format). */
  saved: StoryChecksBody;
  /** The builder's one queue for task saves. */
  writeTask: TaskWrite;
  /** The story body the server holds now, from the last save's answer; null in the older format. */
  currentStory: () => StoryChecksBody | null;
  /** The learner story's title, for its row. */
  learnerTitle: string;
  editable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
}) {
  const [stories, setStories] = useState<ProvidedStory[]>(() => saved.providedStories.map((one) => ({ ...one })));
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const learnerId = saved.learnerStory.id;
  const blank = blankCriterionProblem(stories);
  const save = useCardSave({
    label: 'Provided stories',
    saveButton: 'Save the provided stories',
    validate: () => providedStoriesProblem(stories, (currentStory() ?? defaultStoryBody()).learnerStory.id),
    send: () => {
      const sent = stories.map(bodyStory);
      // The learner's story and the floor as the server holds them when this
      // save's turn comes, so a step 4 save just before it is never undone.
      return writeTask((story) => {
        const held = story ?? defaultStoryBody();
        return { story: { providedStories: sent, learnerStory: held.learnerStory, floor: held.floor } };
      });
    },
    onSaved,
  });
  // Each new answer redraws the stories with the server's words while nothing is typed here.
  useServerRedraw(saved, save.clean, (next) => setStories(next.providedStories.map((one) => ({ ...one }))));

  const edit = (next: ProvidedStory[]) => {
    setStories(next);
    save.changed();
  };
  const toggle = (at: number) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(at)) next.delete(at);
      else next.add(at);
      return next;
    });
  const full = stories.length >= STORY_CAPS.providedStories;

  return (
    <BuilderCard
      n={3}
      title="Provided stories"
      purpose="What the backlog already holds when a learner arrives. Shown exactly as they will see it."
      state={state}
      art="/artwork/requirements-backlog-kit-3d.webp"
      testId="tre-provided"
      onFocusCard={onFocusCard}
      onLeave={editable ? save.saveSoon : undefined}
    >
      <div className="tre-backlog issue-desk jira-issue-desk">
        <div className="tre-backlog-head">
          <strong>Backlog</strong>
          <span className="label-sm">As the learner sees it</span>
        </div>
        <div className="jira-backlog-body">
          <div className="jira-issue-list">
            {stories.map((story, at) => (
              <div className="tre-row-wrap" key={at}>
                <button
                  type="button"
                  className="jira-issue-row"
                  aria-expanded={open.has(at)}
                  onClick={() => toggle(at)}
                >
                  <span className="jira-type-story">
                    <Icon name="check" size={12} />
                  </span>
                  <code>{story.id}</code>
                  <span>{story.title || 'Untitled story'}</span>
                  <small>Provided</small>
                  <Icon name="lock" size={12} />
                </button>
                {editable && (
                  <span className="tre-row-actions">
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      aria-label={`Edit ${story.id || `provided story ${at + 1}`}`}
                      aria-expanded={open.has(at)}
                      onClick={() => toggle(at)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      aria-label={`Remove ${story.id || `provided story ${at + 1}`}`}
                      onClick={() => {
                        edit(stories.filter((_, i) => i !== at));
                        setOpen(new Set());
                      }}
                    >
                      Remove
                    </button>
                  </span>
                )}
                {open.has(at) && (
                  <div className="tre-row-open">
                    {editable ? (
                      <ProvidedStoryEditor
                        story={story}
                        onChange={(next) => edit(stories.map((one, i) => (i === at ? next : one)))}
                      />
                    ) : (
                      <StoryCard story={story} heading={false} testId={`tre-provided-card-${story.id}`} />
                    )}
                  </div>
                )}
              </div>
            ))}
            <div className="tre-row-wrap tre-row-learner">
              <div className="jira-issue-row">
                <span className="jira-type-story">
                  <Icon name="check" size={12} />
                </span>
                <code>{learnerId === LEARNER_PICKS ? 'Learner picks' : learnerId}</code>
                <span>{learnerTitle || "The learner's story"}</span>
                <small>The learner writes this</small>
              </div>
            </div>
          </div>
        </div>
        {editable && (
          <button
            type="button"
            className="tre-add-row"
            disabled={full}
            title={full ? `A backlog holds at most ${STORY_CAPS.providedStories} provided stories.` : undefined}
            onClick={() => {
              const next = [
                ...stories,
                { id: nextStoryId(stories, learnerId), title: '', persona: '', capability: '', benefit: '' },
              ];
              edit(next);
              setOpen(new Set([next.length - 1]));
            }}
          >
            <span aria-hidden="true">+</span> Add a provided story
          </button>
        )}
      </div>
      {editable && blank && save.message !== blank && (
        <p className="label-sm wrap text-fail" data-testid="tre-provided-blank">
          {blank}
        </p>
      )}
      {editable && (
        <div className="tre-save-row">
          <SaveLine
            save={save}
            testId="tre-provided-status"
            idle={`${stories.length === 1 ? '1 provided story' : `${stories.length} provided stories`}, up to ${STORY_CAPS.providedStories}. Edits save when you leave the card.`}
          />
          <Button
            size="sm"
            variant="secondary"
            busy={save.status === 'saving'}
            busyLabel="Saving…"
            disabled={Boolean(blank)}
            reason={blank || undefined}
            testId="tre-provided-save"
            onClick={() => void save.saveNow()}
          >
            Save the provided stories
          </Button>
        </div>
      )}
    </BuilderCard>
  );
}
