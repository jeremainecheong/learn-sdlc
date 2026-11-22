'use client';

/**
 * Step 1: the background a learner reads first, which is the phase's intro.
 *
 * It saves through `phases.update`, the same door the intro editor of every
 * other phase uses, and it is plain text: never graded and never sent to a
 * model. Each new answer for the phase redraws it with the server's words
 * while nothing is typed in it (`useServerRedraw`).
 */
import { useState } from 'react';
import type { DraftPhaseView, TaskMutationResult } from '@learnsdlc/shared';
import { PHASE_INTRO_MAX } from '@learnsdlc/shared';
import { Button } from '@/components/ui';
import { projectsApi } from '@/lib/api-projects';
import { ProvenanceChip } from '../PhaseScenario';
import { BuilderCard, SaveLine, useCardSave, useServerRedraw, type CardState } from './BuilderCard';
import { GrowBox } from '../GrowBox';

export function BackgroundCard({
  projectId,
  versionId,
  phase,
  editable,
  state,
  onFocusCard,
  onSaved,
  testId = 'tre-background',
  art = '/artwork/requirements-discovery-3d.webp',
}: {
  projectId: string;
  versionId: string;
  phase: DraftPhaseView;
  editable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
  /** The card's test id; the Design builder draws the same card as `tde-background`. */
  testId?: string;
  /** The card's illustration, decorative. */
  art?: string;
}) {
  const [intro, setIntro] = useState(phase.intro);
  const save = useCardSave({
    label: 'Background',
    saveButton: 'Save the background',
    validate: () => (intro.trim() ? '' : 'Write the intro before you save it. A phase always has one.'),
    send: () => projectsApi.updatePhase(projectId, versionId, phase.key, { intro }),
    onSaved,
  });
  useServerRedraw(phase, save.clean, (next) => setIntro(next.intro));

  return (
    <BuilderCard
      n={1}
      title="Background"
      purpose="Learners read this first. Two or three sentences about the world and the problem."
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
      onLeave={editable ? save.saveSoon : undefined}
    >
      {editable ? (
        <>
          <GrowBox
            className="field tre-ta"
            rows={3}
            aria-label="What learners read first"
            value={intro}
            maxLength={PHASE_INTRO_MAX}
            data-testid="tre-background-field"
            onChange={(event) => {
              setIntro(event.target.value);
              save.changed();
            }}
          />
          <div className="tre-save-row">
            <SaveLine
              save={save}
              testId="tre-background-status"
              idle={`Edits save when you leave the field. ${intro.length} of ${PHASE_INTRO_MAX} characters.`}
            />
            <Button
              size="sm"
              variant="secondary"
              busy={save.status === 'saving'}
              busyLabel="Saving…"
              testId="tre-background-save"
              onClick={() => void save.saveNow()}
            >
              Save the background
            </Button>
          </div>
        </>
      ) : (
        <p className="purpose wrap" data-testid="tre-background-text">
          {phase.intro}
        </p>
      )}
    </BuilderCard>
  );
}
