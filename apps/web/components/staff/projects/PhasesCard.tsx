'use client';

/**
 * The Phases card: which of LearnSDLC's six phases this draft holds, and the
 * three doors that change that.
 *
 * The card is drawn from `DraftVersionView.phaseSet`, which the API answers
 * with every draft view: one row per phase in LearnSDLC's order, its state
 * and the doors it offers now. The card draws a door only where its row
 * offers it, and decides nothing of its own; what a door still refuses is
 * printed in the API's words.
 *
 * Remove asks first, in the words of what the Remove leaves
 * (`removeConfirm` over the row's `removeSource`), and sends nothing on
 * Keep it. Put back and Add send at once, because neither loses anything.
 * Each door answers the whole draft view, which goes to `onChanged`: the
 * editor replaces its view with it, as its other saves do, so the tabs, the
 * report and this card all redraw from one answer.
 *
 * It is drawn in the builders' layout (a hero line, a one-line why, then the
 * readiness line) with their classes, but not through `BuilderCard`: that
 * card's ids are keyed by its step number, and the Requirements builder drawn
 * under the tabs on the same page holds step 1. The builders' colours and
 * edges are custom properties set on `.tre-panel`, which each builder draws on
 * its own root; this card sits above the tabs, outside every builder, so it
 * draws `.tre-panel` itself, or its edge, header band and confirm border
 * would not resolve. Every state is the neutral chip: being in the project is
 * not a pass, and the words say which state it is.
 *
 * The keyboard stays in the card. Keep it hands focus back to the Remove that
 * opened the confirm. A door that is answered lands on the row's new door (Put
 * back after a Remove, Remove after a Put back or an Add) when one is drawn,
 * and otherwise on the line that says the change was made; a refusal lands on
 * the line that says it.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ADDABLE_PHASES,
  NO_PHASE_TO_PUBLISH,
  PHASE_TITLES,
  phaseListSentence,
  removeConfirm,
  type DraftPhaseSetView,
  type DraftPhaseState,
  type DraftVersionView,
  type PhaseKey,
} from '@learnsdlc/shared';
import { Button } from '@/components/ui';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import './requirements/requirements-builder.css';
import './design/design-builder.css';

const STATE_LABEL: Record<DraftPhaseState, string> = {
  held: 'In this project',
  removed: 'Removed',
  absent: 'Not in this project',
};

/** Said beside an application phase the draft does not hold: the browser cannot make one. */
export const ADDED_BY_UPLOAD = 'Added by upload: its files, tests and solution cannot be made in the browser.';

type Door = 'remove' | 'restore' | 'add';

const DONE: Record<Door, string> = {
  remove: 'was removed from this draft',
  restore: 'was put back',
  add: 'was added to this draft',
};

/** The door a row draws once each door is answered, which takes the keyboard. */
const NEXT_DOOR: Record<Door, string> = {
  remove: 'phases-putback',
  restore: 'phases-remove',
  add: 'phases-remove',
};

/**
 * "This draft holds 3 of LearnSDLC's six phases: Requirements, Design and
 * Implementation." A draft that holds none says so in the words publish
 * refuses it with.
 */
export function phasesReadiness(phaseSet: readonly DraftPhaseSetView[], draft: boolean): string {
  const keys = phaseSet.filter((row) => row.state === 'held').map((row) => row.key);
  if (keys.length === 0) return NO_PHASE_TO_PUBLISH;
  return `${draft ? 'This draft' : 'This version'} holds ${keys.length} of LearnSDLC's six phases: ${phaseListSentence(keys)}.`;
}

export function PhasesCard({
  projectId,
  versionId,
  phaseSet,
  editable,
  onChanged,
}: {
  projectId: string;
  versionId: string;
  /** The draft view's `phaseSet`, six rows in LearnSDLC's order. */
  phaseSet: readonly DraftPhaseSetView[];
  /** False on a version the caller may not change: the states are drawn, no door. */
  editable: boolean;
  /** The draft view a door answered with. */
  onChanged: (view: DraftVersionView) => void;
}) {
  const [asking, setAsking] = useState<PhaseKey | null>(null);
  const [working, setWorking] = useState<PhaseKey | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const alive = useRef(true);
  const card = useRef<HTMLElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const alertLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** A control of this card by its test id, or null. */
  const control = (testId: string) => card.current?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`) ?? null;

  /**
   * After a door is answered, once the card has redrawn from the answer: the
   * row's new door when it is drawn and on, else the line that says what
   * happened. The clicked control is gone or off by then, and focus would
   * otherwise fall to the page.
   */
  const land = (door: Door, key: PhaseKey, refused: boolean) =>
    requestAnimationFrame(() => {
      if (!alive.current) return;
      if (refused) {
        alertLine.current?.focus();
        return;
      }
      const next = control(`${NEXT_DOOR[door]}-${key}`);
      if (next && !next.disabled) next.focus();
      else statusLine.current?.focus();
    });

  const send = async (door: Door, key: PhaseKey) => {
    setAsking(null);
    setWorking(key);
    setError('');
    setDone('');
    let refused = false;
    try {
      const call = door === 'remove' ? projectsApi.removePhase : door === 'restore' ? projectsApi.restorePhase : projectsApi.addPhase;
      const next = await call(projectId, versionId, key);
      // The editor outlives the card, so the answer always reaches it.
      onChanged(next);
      if (alive.current) setDone(`${PHASE_TITLES[key]} ${DONE[door]}.`);
    } catch (err) {
      refused = true;
      if (alive.current) setError(describeError(err, 'That change to the phases could not be saved. Try again in a moment.'));
    } finally {
      if (alive.current) {
        setWorking(null);
        land(door, key, refused);
      }
    }
  };

  const asked = asking ? phaseSet.find((row) => row.key === asking && row.state === 'held') : undefined;

  return (
    <section ref={card} className="tre-panel tre-card" aria-labelledby="phases-card-title" data-testid="phases-card">
      <header className="tre-card-head">
        <div className="tre-card-titles col-span-full">
          <h3 id="phases-card-title" className="text-[14px] font-semibold text-ink">
            Phases
          </h3>
          <p className="purpose wrap">{"A project holds the phases it needs, in LearnSDLC's order."}</p>
        </div>
      </header>
      <div className="tre-card-body">
        <p className="label-sm wrap" data-testid="phases-card-readiness">
          {phasesReadiness(phaseSet, editable)}
        </p>
        <ul className="flex min-w-0 flex-col gap-2" aria-label="LearnSDLC's six phases">
          {phaseSet.map((row) => {
            const title = PHASE_TITLES[row.key];
            const byUpload = row.state !== 'held' && !ADDABLE_PHASES.includes(row.key);
            return (
              <li key={row.key} className="flex min-w-0 flex-col gap-1" data-testid={`phases-row-${row.key}`}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <strong className="min-w-0 flex-1 text-[13px] text-ink">{title}</strong>
                  <span className="chip" data-testid={`phases-state-${row.key}`}>
                    {STATE_LABEL[row.state]}
                  </span>
                  {editable && row.canRemove && (
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={working === row.key}
                      busyLabel="Removing…"
                      disabled={working !== null}
                      ariaLabel={`Remove ${title}`}
                      testId={`phases-remove-${row.key}`}
                      onClick={() => {
                        setError('');
                        setDone('');
                        setAsking(row.key);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                  {editable && row.canPutBack && (
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={working === row.key}
                      busyLabel="Putting back…"
                      disabled={working !== null}
                      ariaLabel={`Put back ${title}`}
                      testId={`phases-putback-${row.key}`}
                      onClick={() => void send('restore', row.key)}
                    >
                      Put back
                    </Button>
                  )}
                  {editable && row.canAdd && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="plus"
                      busy={working === row.key}
                      busyLabel="Adding…"
                      disabled={working !== null}
                      ariaLabel={`Add ${title}`}
                      testId={`phases-add-${row.key}`}
                      onClick={() => void send('add', row.key)}
                    >
                      Add
                    </Button>
                  )}
                </div>
                {byUpload && (
                  <p className="tre-inline-note wrap" data-testid={`phases-upload-${row.key}`}>
                    {ADDED_BY_UPLOAD}
                  </p>
                )}
                {editable && asked && asked.key === row.key && (
                  <div className="tde-confirm" role="group" aria-label={`Remove ${title}`}>
                    <p className="label-sm wrap" data-testid="phases-confirm-line">
                      {removeConfirm(row.key, asked.removeSource ?? 'held')}
                    </p>
                    <span className="tde-actions">
                      <Button
                        size="sm"
                        variant="danger"
                        testId="phases-confirm-yes"
                        onClick={() => void send('remove', row.key)}
                      >
                        {`Remove ${title}`}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        testId="phases-confirm-no"
                        onClick={() => {
                          setAsking(null);
                          // The Remove that opened the confirm is still drawn.
                          control(`phases-remove-${row.key}`)?.focus();
                        }}
                      >
                        Keep it
                      </Button>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {error ? (
          <p ref={alertLine} tabIndex={-1} role="alert" className="label-sm wrap text-fail" data-testid="phases-error">
            {error}
          </p>
        ) : (
          <p ref={statusLine} tabIndex={-1} role="status" className="tre-inline-note wrap" data-testid="phases-status">
            {done}
          </p>
        )}
      </div>
    </section>
  );
}
