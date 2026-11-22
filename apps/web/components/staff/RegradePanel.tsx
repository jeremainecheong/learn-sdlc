'use client';

/**
 * Regrade a phase across a class, after a content fix.
 *
 * The instructor fixes a hidden test or a rubric weight and bumps the pack's
 * version, and the verdicts already on record were produced by the earlier
 * pack. This re-runs each learner's newest revision against the pack as it is
 * on disk now and writes the result *beside* the earlier verdict as a new
 * revision. A score can only go up and a pass is never withdrawn: that
 * invariant is `nextPhaseStatus`, not something this panel arranges.
 *
 * Progress is polled rather than pushed. `EventsGateway` fans out to one room
 * per learner, so watching a class-sized batch would mean putting an instructor
 * in every learner's room for a job of a few minutes; a two-second poll is the
 * simpler answer. A batch also keeps running when the tab closes (it is queue
 * work), so the id is remembered per project in this browser and the panel
 * picks a running batch back up on mount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OVERRIDE_REASON_MIN,
  RUNNER_UNAVAILABLE_MESSAGE,
  pluralWord,
  type PhaseKey,
  type RegradeBatchView,
  type RegradeScope,
  type RegradeSkip,
} from '@learnsdlc/shared';
import { describeError } from '@/lib/api';
import { instructorApi } from '@/lib/api-instructor';
import { Button, EmptyState, Notice, Section } from '@/components/ui';

/** Slow enough not to hammer a laptop also running the grader, fast enough to read as live. */
export const REGRADE_POLL_MS = 2_000;

/** Where a running batch's id is kept, so a reload does not lose sight of it. */
const batchKey = (projectSlug: string) => `lsdlc_regrade_${projectSlug}`;

function rememberBatch(projectSlug: string, id: string | null): void {
  try {
    if (id) localStorage.setItem(batchKey(projectSlug), id);
    else localStorage.removeItem(batchKey(projectSlug));
  } catch {
    // Losing the id costs the progress line, not the batch.
  }
}

function rememberedBatch(projectSlug: string): string | null {
  try {
    return localStorage.getItem(batchKey(projectSlug));
  } catch {
    return null;
  }
}

/** One learner left out of a regrade, with every sentence saying why. */
type SkippedLearner = { userId: string; displayName: string; reasons: string[] };

/**
 * The skipped entries, one row per learner.
 *
 * `plan()` decides a skip per (learner, task), so a learner with three
 * unsubmitted tasks arrives here three times, and `RegradeSkip` carries a name
 * and a sentence and no task, so those three are byte-identical rows under a
 * line calling them three learners. Grouping is what this panel can do with
 * what it is given: the names are distinct again, the count is a count of
 * people, and a learner skipped for two different reasons keeps both.
 *
 * On a board of sole-task phases every learner appears at most once, so the
 * grouped list is the ungrouped one, row for row and in order.
 */
function byLearner(skipped: RegradeSkip[]): SkippedLearner[] {
  const out: SkippedLearner[] = [];
  const at = new Map<string, number>();
  for (const skip of skipped) {
    const seen = at.get(skip.userId);
    if (seen === undefined) {
      at.set(skip.userId, out.length);
      out.push({ userId: skip.userId, displayName: skip.displayName, reasons: [skip.reason] });
    } else if (!out[seen].reasons.includes(skip.reason)) {
      out[seen].reasons.push(skip.reason);
    }
  }
  return out;
}

export function RegradePanel({
  projectSlug,
  phases,
  onFinished,
}: {
  projectSlug: string;
  /** The pack's phases, in pack order. */
  phases: { key: PhaseKey; title: string }[];
  /** Called once when a batch finishes, so the page can reload what it draws. */
  onFinished?: () => void;
}) {
  const [phaseKey, setPhaseKey] = useState<PhaseKey | ''>('');
  const [scope, setScope] = useState<RegradeScope>('stale-pack');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<RegradeBatchView | null>(null);
  const [batch, setBatch] = useState<RegradeBatchView | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const told = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /* ------------------------------ the poll ------------------------------ */

  const running = batch?.status === 'running';

  useEffect(() => {
    // A batch this panel did not start (the tab was closed, or another one is
    // open) is still this project's batch, and its progress belongs here.
    const held = rememberedBatch(projectSlug);
    if (!held) return;
    instructorApi
      .regradeStatus(held)
      .then((view) => alive.current && setBatch(view))
      .catch(() => rememberBatch(projectSlug, null));
  }, [projectSlug]);

  useEffect(() => {
    if (!running || !batch) return;
    const id = setInterval(() => {
      instructorApi
        .regradeStatus(batch.id)
        .then((view) => alive.current && setBatch(view))
        // A failed poll changes nothing on screen; the next tick reads the batch again.
        .catch(() => undefined);
    }, REGRADE_POLL_MS);
    return () => clearInterval(id);
  }, [running, batch?.id]);

  useEffect(() => {
    if (!batch || batch.status === 'running' || told.current) return;
    told.current = true;
    rememberBatch(projectSlug, null);
    onFinished?.();
  }, [batch, projectSlug, onFinished]);

  /* ------------------------------- actions ------------------------------ */

  const phaseTitle = phases.find((p) => p.key === phaseKey)?.title ?? 'this phase';
  const skipped = preview ? byLearner(preview.skipped) : [];
  // A split phase can regrade one of a learner's tasks and skip another, and
  // then they are in both lists: "not included" would be false about someone
  // whose name is four rows up. On a sole-task board the two lists are
  // disjoint, so this is false and the sentence is the plain count.
  const partly = skipped.some((s) => (preview?.candidates ?? []).some((c) => c.userId === s.userId));
  const trimmed = reason.trim();
  const ready = phaseKey !== '' && trimmed.length >= OVERRIDE_REASON_MIN;
  const why =
    phaseKey === ''
      ? 'Choose a phase and give a reason'
      : trimmed.length < OVERRIDE_REASON_MIN
        ? `Give a reason of at least ${OVERRIDE_REASON_MIN} characters`
        : '';

  const request = useCallback(
    () => ({ projectSlug, phaseKey: phaseKey as PhaseKey, scope, reason: trimmed }),
    [projectSlug, phaseKey, scope, trimmed],
  );

  const check = async () => {
    setChecking(true);
    setError('');
    try {
      const view = await instructorApi.regradePreview(request());
      if (alive.current) setPreview(view);
    } catch (err) {
      if (alive.current) setError(describeError(err, 'The dry run could not be made. Try again in a moment.'));
    } finally {
      if (alive.current) setChecking(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setError('');
    try {
      const view = await instructorApi.regradeStart(request());
      if (!alive.current) return;
      told.current = false;
      rememberBatch(projectSlug, view.id);
      setBatch(view);
      setPreview(null);
    } catch (err) {
      if (alive.current) setError(describeError(err, 'The regrade could not be started. Try again in a moment.'));
    } finally {
      if (alive.current) setStarting(false);
    }
  };

  /* -------------------------------- draw -------------------------------- */

  // The regraded phase's title, as the running line names it.
  const regradedTitle = batch ? (phases.find((p) => p.key === batch.phaseKey)?.title ?? batch.phaseKey) : '';

  return (
    <Section
      title="Regrade a phase"
      purpose="Re-run grading against the content pack as it is on disk now. Every learner keeps the verdict they already have; the new one is added beside it as a revision."
      testId="regrade-panel"
    >
      {error && (
        <Notice tone="fail" role="alert" testId="regrade-error">
          {error}
        </Notice>
      )}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="label">Phase</span>
          <select
            className="field h-[34px] py-0 text-[13px]"
            value={phaseKey}
            onChange={(e) => {
              setPhaseKey(e.target.value as PhaseKey | '');
              setPreview(null);
            }}
            data-testid="regrade-phase"
          >
            <option value="">Choose a phase</option>
            {phases.map((phase) => (
              <option key={phase.key} value={phase.key}>
                {phase.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="label">Who</span>
          <select
            className="field h-[34px] py-0 text-[13px]"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as RegradeScope);
              setPreview(null);
            }}
            data-testid="regrade-scope"
          >
            <option value="stale-pack">Learners graded on an older pack</option>
            <option value="everyone">Everyone with a submission in this phase</option>
          </select>
        </label>
      </div>

      <label className="flex min-w-0 flex-col gap-1.5">
        {/* Named for what it is: the sign-off tab it sits on also holds the sign-off's reason. */}
        <span className="label">Reason for the regrade</span>
        <textarea
          className="field min-h-[72px] resize-y"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="For example: the hidden boundary test was wrong; fixed in the pack on disk."
          data-testid="regrade-reason"
        />
        <span className="label-sm">
          At least {OVERRIDE_REASON_MIN} characters. It is recorded against every revision the regrade writes.
        </span>
      </label>

      {/* The dry run's list, in the anatomy every other list here uses. */}
      {preview && (
        <div className="flex min-w-0 flex-col gap-2" data-testid="regrade-preview-list">
          <p className="text-[13px] text-ink">
            {/* A candidate is a learner
                AND a task, so this counts revisions to re-run rather than
                people. On a phase with one task it is also the number of
                learners; on a split one, printing it as a head count would
                tell a teacher three people when it means one person's three
                tasks. */}
            {preview.requested === 0
              ? `Nobody in this class has a submission in ${phaseTitle} that can be re-run.`
              : `${preview.requested} ${pluralWord(preview.requested, 'revision')} would be regraded in ${phaseTitle}${
                  preview.packVersionTo ? `, on pack ${preview.packVersionTo}` : ''
                }.`}
          </p>
          {preview.candidates && preview.candidates.length > 0 && (
            <ul className="flex min-w-0 flex-col border-t-1.5 border-edge2">
              {preview.candidates.map((c) => (
                <li
                  key={c.submissionId}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b-1.5 border-edge py-1.5 text-[13px] text-ink"
                >
                  {/* The task, where there is one to name: a learner with two
                      tasks appears twice, and a row that prints only a name
                      shows the same person twice with nothing to tell the
                      rows apart. */}
                  <span className="wrap font-medium">
                    {c.displayName}
                    {c.taskKey ? ` — ${c.taskTitle || c.taskKey}` : ''}
                  </span>
                  <span className="label-sm tabular-nums">
                    Revision {c.attempt}
                    {c.score === null ? ', not scored' : `, scored ${c.score}`}
                    {c.packVersion ? ` on pack ${c.packVersion}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {skipped.length > 0 && (
            <>
              <p className="text-[13px] text-ink" data-testid="regrade-skipped">
                {/* A count of people, because that is what the rows below are.
                    `preview.skipped.length` counts (learner, task) pairs, and
                    printing it here would tell a teacher three people when it
                    means one person's three tasks. */}
                {partly
                  ? `${skipped.length} learner${skipped.length === 1 ? ' has' : 's have'} work that is not included:`
                  : `${skipped.length} learner${skipped.length === 1 ? ' is' : 's are'} not included:`}
              </p>
              <ul
                className="flex min-w-0 flex-col border-t-1.5 border-edge2"
                data-testid="regrade-skipped-list"
              >
                {/* One row per learner, keyed by them: a split phase is skipped
                    once per task, and a skip names no task, so a row
                    per entry is the same person twice with nothing to tell the
                    rows apart. Their reasons are gathered onto the one row. */}
                {skipped.map((s) => (
                  <li
                    key={s.userId}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b-1.5 border-edge py-1.5 text-[13px] text-muted"
                  >
                    <span className="wrap font-medium text-ink">{s.displayName}</span>
                    <span className="label-sm wrap">{s.reasons.join(' ')}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* Running, then finished. Both are live regions: nobody watches a
          progress line, they look back at it. */}
      {batch && batch.status === 'running' && (
        <p className="text-[13px] text-ink" role="status" data-testid="regrade-progress">
          {`Regrading ${phases.find((p) => p.key === batch.phaseKey)?.title ?? batch.phaseKey}`}
          {batch.packVersionTo ? ` on the pack ${batch.packVersionTo}` : ''}
          {`. ${batch.done} of ${batch.requested} done, ${batch.failed} could not be re-run.`}
        </p>
      )}

      {batch && batch.status === 'finished' && (
        <Notice tone="pass" role="status" testId="regrade-done">
          {`Regrade finished. ${batch.done} revision${batch.done === 1 ? ' was' : 's were'} graded`}
          {batch.packVersionTo ? ` on pack ${batch.packVersionTo}` : ''}
          {'. '}
          {/* The count is of learners whose phase now reads passed (the API's
              `newPasses`), so the sentence names the phase rather than a
              "gate". */}
          {batch.newPasses === 0
            ? `Nobody passes ${regradedTitle} who did not pass it before.`
            : `${batch.newPasses} ${pluralWord(batch.newPasses, 'learner')} now pass${
                batch.newPasses === 1 ? 'es' : ''
              } ${regradedTitle} who did not before.`}{' '}
          Nobody&apos;s pass was withdrawn.
          {batch.failed > 0 && ` ${batch.failed} could not be re-run. Their old verdicts are unchanged.`}{' '}
          Every row is in the trail on each learner&apos;s page.
        </Notice>
      )}

      {batch && batch.status === 'stopped' && (
        <Notice tone="fail" role="alert" testId="regrade-done">
          {RUNNER_UNAVAILABLE_MESSAGE} Nothing was changed. Try again when the runner is back.
        </Notice>
      )}

      {phases.length === 0 ? (
        <EmptyState
          icon="folder"
          title="This project has no phases to regrade"
          body="The content pack declares none, so there is nothing to re-run."
          testId="regrade-empty"
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            variant="secondary"
            onClick={check}
            disabled={!ready || checking || running}
            busy={checking}
            busyLabel="Checking…"
            testId="regrade-preview"
          >
            Check what this would do
          </Button>
          <Button
            onClick={start}
            disabled={!ready || starting || running || preview?.requested === 0}
            busy={starting || running}
            busyLabel="Regrading…"
            testId="regrade-start"
          >
            {/* `requested` is the candidate count, and a candidate is a
                (learner, task) pair: the same number the sentence above the
                list prints, and it has to be called the same thing. */}
            {preview && preview.requested > 0
              ? `Regrade ${preview.requested} ${pluralWord(preview.requested, 'revision')}`
              : 'Regrade this phase'}
          </Button>
          {why && <span className="label-sm">{why}</span>}
        </div>
      )}
    </Section>
  );
}
