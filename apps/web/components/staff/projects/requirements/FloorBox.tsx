'use client';

/**
 * The floor of the learner's story: the four minimums checked before the
 * review reads it, one control each, and the plain sentence that sums them
 * up. Each control maps onto one of the four floor checks the learner's room
 * runs with the same `StoryFloor`; nothing here is a score.
 */
import type { CriterionTag, StoryFloor } from '@learnsdlc/shared';
import { CRITERION_TAGS, STORY_CAPS } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Stepper } from './BuilderCard';
import { floorLine } from './builder-model';

export function FloorBox({
  floor,
  editable,
  onChange,
}: {
  floor: StoryFloor;
  editable: boolean;
  onChange: (next: StoryFloor) => void;
}) {
  const setFloorPart = (patch: Partial<StoryFloor>) => onChange({ ...floor, ...patch });
  const toggleTag = (tag: CriterionTag) =>
    setFloorPart({
      requiredTags: CRITERION_TAGS.map((one) => one.value).filter((one) =>
        one === tag ? !floor.requiredTags.includes(tag) : floor.requiredTags.includes(one),
      ),
    });
  const tagWords = CRITERION_TAGS.filter((one) => floor.requiredTags.includes(one.value)).map((one) => one.label);

  return (
    <div className="tre-floor" data-testid="tre-floor">
      <div className="tre-floor-head">
        <span className="text-[13px] font-semibold text-ink">The floor</span>
        <span className="label-sm">Counts and presence only. Checked before the review.</span>
      </div>
      <div className="tre-floor-grid">
        <div className="tre-floor-item">
          {editable ? (
            <Stepper
              value={floor.minCriteria}
              min={STORY_CAPS.minCriteria[0]}
              max={STORY_CAPS.minCriteria[1]}
              label="Minimum acceptance criteria"
              less="Fewer acceptance criteria"
              more="More acceptance criteria"
              onChange={(minCriteria) => setFloorPart({ minCriteria })}
            />
          ) : (
            <strong>{floor.minCriteria}</strong>
          )}
          <span>acceptance criteria at least</span>
        </div>
        <div className="tre-floor-item">
          {editable ? (
            <Stepper
              value={floor.minExclusions}
              min={STORY_CAPS.minExclusions[0]}
              max={STORY_CAPS.minExclusions[1]}
              label="Minimum out-of-scope lines"
              less="Fewer out-of-scope lines"
              more="More out-of-scope lines"
              onChange={(minExclusions) => setFloorPart({ minExclusions })}
            />
          ) : (
            <strong>{floor.minExclusions}</strong>
          )}
          <span>out-of-scope lines at least</span>
        </div>
        <div className="tre-floor-item tre-floor-pills">
          <span>Cases that must appear</span>
          {editable ? (
            <span className="tre-pills">
              {CRITERION_TAGS.map((tag) => {
                const on = floor.requiredTags.includes(tag.value);
                return (
                  <button
                    key={tag.value}
                    type="button"
                    className={`tre-pill ${on ? 'tre-pill-on' : ''}`}
                    aria-pressed={on}
                    onClick={() => toggleTag(tag.value)}
                  >
                    {on && <Icon name="check" size={12} />}
                    <span>{tag.label}</span>
                  </button>
                );
              })}
            </span>
          ) : (
            <span className="tre-value">{tagWords.length ? tagWords.join(', ') : 'None'}</span>
          )}
        </div>
        <div className="tre-floor-item">
          {editable ? (
            <button
              type="button"
              className={`tre-pill ${floor.requireSentence ? 'tre-pill-on' : ''}`}
              aria-pressed={floor.requireSentence}
              onClick={() => setFloorPart({ requireSentence: !floor.requireSentence })}
            >
              {floor.requireSentence && <Icon name="check" size={12} />}
              <span>As a, I want, So that all filled</span>
            </button>
          ) : (
            <span>
              {floor.requireSentence
                ? 'As a, I want, So that must all be filled.'
                : 'As a, I want, So that need not all be filled.'}
            </span>
          )}
        </div>
      </div>
      <p className="tre-floor-sentence" data-testid="tre-floor-sentence">
        {floorLine(floor)}
      </p>
    </div>
  );
}
