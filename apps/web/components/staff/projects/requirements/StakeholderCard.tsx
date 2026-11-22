'use client';

/**
 * Step 2: the stakeholder the learner interviews, and the facts they know.
 *
 * The draft every instructor can read carries the interview without its
 * answers. The answers come from `interview.read`, which is owner-only and
 * leaves an audit row on every read, so the card asks for them behind an
 * explicit action and never on a render. Once read, the interview is edited
 * in place with the editor every other surface uses, and saved whole through
 * `interview.replace`; it can be removed through `interview.remove`.
 *
 * The controls keep the test ids the editor's scenario panel gave them, so
 * one door has one name wherever it is drawn. A payload that cannot tell an
 * interview from none (one with no provenance) claims neither.
 */
import { useEffect, useRef, useState } from 'react';
import type { DraftPhaseView, InterviewBody, TaskMutationResult } from '@learnsdlc/shared';
import { Button, Notice } from '@/components/ui';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { InterviewEditor, emptyInterview } from '../InterviewEditor';
import { ProvenanceChip } from '../PhaseScenario';
import { BuilderCard, type CardState } from './BuilderCard';

export function StakeholderCard({
  projectId,
  versionId,
  phase,
  editable,
  state,
  onFocusCard,
  onSaved,
}: {
  projectId: string;
  versionId: string;
  phase: DraftPhaseView;
  editable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
}) {
  const [open, setOpen] = useState<InterviewBody | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const interview = phase.interview;
  const provenance = phase.provenance ?? null;
  // Whether the payload says if there is an interview at all.
  const known = interview !== undefined || provenance?.interview === null;

  const openEditor = async () => {
    setError('');
    setSaid('');
    if (!interview) {
      setOpen(emptyInterview());
      return;
    }
    setReading(true);
    try {
      const body = await projectsApi.readInterview(projectId, versionId);
      if (alive.current) setOpen(body);
    } catch (err) {
      if (alive.current) setError(describeError(err, 'The interview could not be read. Try again in a moment.'));
    } finally {
      if (alive.current) setReading(false);
    }
  };

  const run = async (work: () => Promise<TaskMutationResult>, done: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await work();
      if (!alive.current) return;
      onSaved(result);
      setOpen(null);
      setRemoving(false);
      setSaid(done);
    } catch (err) {
      if (alive.current) setError(describeError(err, 'That change could not be saved. Try again in a moment.'));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const factCount = interview?.facts.length ?? 0;

  return (
    <BuilderCard
      n={2}
      title="Stakeholder"
      purpose="Who the learner interviews. The interview answers only from these facts, so what you leave out, they cannot find."
      state={state}
      testId="tre-stakeholder"
      whose={
        provenance?.interview ? (
          <ProvenanceChip
            state={provenance.interview}
            referenceName={provenance.referenceName ?? ''}
            testId="phase-interview-provenance"
          />
        ) : null
      }
      onFocusCard={onFocusCard}
    >
      {open ? (
        <InterviewEditor
          initial={open}
          busy={busy}
          error={error}
          onCancel={() => {
            setOpen(null);
            setError('');
          }}
          onSave={(body) => void run(() => projectsApi.putInterview(projectId, versionId, body), 'Saved')}
        />
      ) : (
        <>
          {interview ? (
            <>
              <div className="tre-persona">
                <img src="/artwork/requirements-maya-3d.webp" alt="" width={56} height={56} className="tre-portrait" />
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="tre-value m-0 font-semibold" data-testid="phase-interview-persona">
                    {`${interview.persona.name}, ${interview.persona.role}. ${factCount === 1 ? '1 fact' : `${factCount} facts`}, ${interview.factsExpected} worth settling, up to ${interview.maxTurns} questions.`}
                  </p>
                  <p className="purpose wrap m-0" data-testid="tre-stakeholder-opening">
                    {interview.opening}
                  </p>
                </div>
              </div>
              <span className="label-sm font-medium">Facts they know</span>
              <ul className="tre-facts" data-testid="phase-interview-topics">
                {interview.facts.map((fact) => (
                  <li key={fact.id} className="tre-fact-topic">
                    {fact.topic}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            known && (
              <p className="purpose wrap" data-testid="phase-interview-none">
                No stakeholder yet. Learners meet no one to interview until you add one.
              </p>
            )
          )}
          {error && (
            <p role="alert" className="label-sm wrap text-fail" data-testid="phase-interview-error">
              {error}
            </p>
          )}
          {said && (
            <p role="status" className="tre-inline-note">
              {said}
            </p>
          )}
          {editable && known && (
            <>
              {interview && (
                <p className="label-sm wrap">
                  Opening the editor reads the stakeholder&rsquo;s answers, and the read is kept on this project&rsquo;s
                  audit trail.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={interview ? 'edit' : 'plus'}
                  busy={reading}
                  busyLabel="Reading the answers…"
                  testId={interview ? 'phase-interview-edit' : 'phase-interview-write'}
                  onClick={() => void openEditor()}
                >
                  {interview ? 'Edit the stakeholder' : 'Add a stakeholder'}
                </Button>
                {interview && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    testId="phase-interview-remove"
                    onClick={() => setRemoving(true)}
                  >
                    Remove the stakeholder
                  </Button>
                )}
              </div>
              {removing && (
                <Notice tone="warn" role="status" testId="phase-interview-remove-confirm">
                  <span className="block">
                    Remove the stakeholder interview? Learners given a version you publish from now on meet no
                    stakeholder in {phase.title}: they read the case file and work on their backlog.
                  </span>
                  <span className="mt-2 flex flex-wrap items-center gap-2.5">
                    <Button
                      size="sm"
                      variant="danger"
                      busy={busy}
                      busyLabel="Removing…"
                      testId="phase-interview-remove-yes"
                      onClick={() => void run(() => projectsApi.removeInterview(projectId, versionId), 'Removed')}
                    >
                      Remove it
                    </Button>
                    <Button size="sm" variant="ghost" testId="phase-interview-remove-no" onClick={() => setRemoving(false)}>
                      Keep it
                    </Button>
                  </span>
                </Notice>
              )}
            </>
          )}
        </>
      )}
    </BuilderCard>
  );
}
