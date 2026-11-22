'use client';

/**
 * The reference solution: what the pack answered, beside what you merged.
 *
 * It exists only behind a gate that has already passed, so there is nothing
 * left to protect and nothing here changes a score. The page draws two texts
 * per file and says nothing about them: reading the difference is the exercise,
 * and asking the mentor about it is the mentor's room, not this one.
 *
 * It asks the API for the answer and for nothing else. The shell's copy of the
 * phase is a summary with no file bodies in it, and this
 * page never needs them: the learner's own merged files come back inside the
 * answer, at the revision the phase was actually merged on.
 */

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SolutionView } from '@learnsdlc/shared';
import { ApiError, describeError } from '@/lib/api';
import { solutionApi } from '@/lib/api-solution';
import { useRecoverWhenBack } from '@/lib/poll';
import { railOf } from '@/lib/rail';
import { useProject } from '@/lib/useProject';
import { DocPage, briefHref, phaseDocHref, phaseDocLabel } from '@/components/shell';
import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';
import { TaskPanel, chooseTask, isSplit, taskKeyToSend } from '@/components/workspace/TaskPanel';
import { Button, EmptyState, Notice, Tabs, tabPanelProps } from '@/components/ui';
import { SolutionDiff, solutionRows, solutionSummary, standingLine } from '@/components/solution';
import { projectName } from '@/lib/project-name';

/** Below this the two columns cannot both be read, so only unified is offered. */
const SPLIT_AT = 1024;

export default function SolutionPage() {
  const params = useParams<{ phaseId: string }>();
  const phaseId = params.phaseId;
  const { details, enrollment, analytics, currentPhase } = useProject();
  const held = details[phaseId];

  const [view, setView] = useState<SolutionView | null>(null);
  const [error, setError] = useState('');
  const [locked, setLocked] = useState(false);
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const [wide, setWide] = useState(false);

  /**
   * Which task's answer this is.
   *
   * A teacher may split a written phase, and every one of the three numbers
   * below (the score, the day the gate went in, the day this learner first
   * looked) is read from the task's own row. The room therefore has to name
   * one. It opens on a task whose gate is in, because that is the task there
   * is an answer to read for; picking one still to pass would walk a learner
   * into a refusal they did not ask for.
   *
   * **A passed task the pack answers, before merely a passed one.** The phase
   * card's *Read the reference solution* is drawn from
   * `PhaseDetail.solution`, which reads the phase's sole **non-quiz** task,
   * so a quiz beside a code task leaves the button there. Opening on the first
   * passed row would then land a learner who pressed that button on the quiz:
   * *this is a quiz, there is no answer key to read*, about a task they were
   * never promised an answer for. `PhaseTaskView.solution` is each task's own
   * door and this is its reader: the room's default and the door the card
   * advertises are the same task. Where nothing passed ships an answer the
   * fallback is unchanged, so the reason a learner reads is still the reason
   * for a task whose gate is in.
   */
  const tasks = held?.tasks;
  const [chosen, setChosen] = useState<string | null>(null);
  const passed = tasks?.filter((t) => t.status === 'passed');
  const opened =
    chosen ?? passed?.find((t) => t.solution?.available)?.key ?? passed?.[0]?.key ?? null;
  const task = chooseTask(tasks, opened);
  const taskKey = taskKeyToSend(tasks, opened);
  // The gate the API will apply, asked of the copy the shell already holds. A
  // deep link into a cold tab holds no tasks and asks anyway: the route is
  // the gate and a doubt reads shut, not open.
  const gateIn = !task || task.status === 'passed';

  /**
   * One load, callable again.
   *
   * With the API unreachable the room never prints the browser's own string
   * ("Failed to fetch") with nothing but the way back: it says what happened
   * in the product's voice, carries a Try again, and picks the connection
   * back up on its own.
   */
  const [attempt, setAttempt] = useState(0);
  const load = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let stale = false;
    if (!gateIn) {
      // This task's own gate is not in. The refusal is the same refusal the
      // route makes, made without making the learner ask for it.
      setView(null);
      setError('');
      setLocked(true);
      return;
    }
    setLocked(false);
    solutionApi
      .read(phaseId, taskKey)
      .then((v) => {
        if (stale) return;
        setView(v);
        setError('');
      })
      .catch((err: unknown) => {
        if (stale) return;
        // A 403 here is the gate, not a fault: the page says so in its own
        // words rather than printing the route's sentence as an error.
        if (err instanceof ApiError && err.status === 403) setLocked(true);
        else setError(describeError(err, 'The reference could not be loaded.'));
      });
    return () => {
      stale = true;
    };
  }, [phaseId, attempt, taskKey, gateIn]);

  // Nothing pressed: a room whose server came back finishes opening itself.
  useRecoverWhenBack(Boolean(error) && !locked, load);

  // Side by side needs two columns of code; below 1024 the toggle is simply
  // not drawn and unified stands alone.
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${SPLIT_AT}px)`);
    const apply = () => setWide(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  const rows = useMemo(() => (view ? solutionRows(view) : []), [view]);
  // The shell's copy names the phase before the answer lands; a deep link into
  // a cold tab has neither, and "this phase" is the honest word for it then.
  const named = view?.phaseTitle ?? held?.title ?? null;
  const title = named ?? 'Phase';
  // On a split phase the work the refusals and the empty states are about is
  // the task, not the phase: "Out of scope is still yours to finish" is a
  // sentence a learner can act on and "Requirements is" is not.
  const namedTask = isSplit(tasks) ? (view?.taskTitle ?? task?.title ?? null) : null;
  const subject = namedTask ?? named ?? 'This phase';
  const phaseKey = view?.phaseKey ?? held?.key;
  const back = phaseKey ? phaseDocHref({ id: phaseId, key: phaseKey }) : `/workspace/${phaseId}`;
  const backLabel = phaseKey ? phaseDocLabel({ key: phaseKey }) : 'Back to the workspace';

  const nav = railOf(enrollment, analytics, currentPhase);
  const crumbs = [
    ...(enrollment
      ? [
          {
            label: projectName(enrollment.projectTitle),
            href: '/dashboard',
            testId: 'back-dashboard',
          },
        ]
      : []),
    // The phase links to its place on the phases page, as on every other page of a phase.
    { label: title, href: phaseKey ? `/phases?phase=${phaseKey}` : back },
    { label: 'Reference solution' },
  ];

  // The switcher sits above every state, refusals included: which task this
  // room is answering for is the one thing a learner must be able to change
  // from the state that told them they cannot read this one yet.
  const withTasks = (children: React.ReactNode) => (
    <div className="flex min-w-0 flex-col gap-3.5">
      <TaskPanel tasks={tasks} phase={held} selected={opened} onSelect={setChosen} counts={held?.taskCounts} />
      {children}
    </div>
  );

  // The h1 is the same in every state, including the refusals: a page whose
  // heading appears only when it has content is a page a screen reader lands
  // in the middle of.
  const shell = (body: React.ReactNode, purpose?: string) => { const children = withTasks(body); return phaseKey ? (
    <PhaseDocumentFrame phase={{id:phaseId,key:phaseKey,title}} view="solution"
      crumbs={crumbs}
      active="work"
      nav={nav}
      testId="solution-page"
      title="Reference solution"
      titleTestId="solution-title"
      purpose={purpose}
      right={
        <>
          <Button href={briefHref({ id: phaseId })} variant="ghost" icon="doc" testId="open-brief">
            Brief
          </Button>
          <Button href={back} variant="ghost" icon="arrow-left" testId="solution-back">
            {backLabel}
          </Button>
        </>
      }
    >
      {children}
    </PhaseDocumentFrame>
  ) : <DocPage crumbs={crumbs} nav={nav} testId="solution-page" title="Reference solution">{children}</DocPage>; };

  if (locked) {
    return shell(
      <EmptyState
        icon="lock"
        title="The reference opens when the gate passes"
        body={`${subject} is still yours to finish. The answer is here the moment your own work is in.`}
        action={
          <Button size="sm" href={back}>
            {backLabel}
          </Button>
        }
        testId="solution-locked"
      />,
    );
  }

  if (error) {
    return shell(
      <div className="flex max-w-[540px] flex-col items-start gap-3">
        <Notice tone="fail" testId="room-error">
          {error}
        </Notice>
        <Button testId="room-retry" onClick={load}>
          Try again
        </Button>
      </div>,
    );
  }

  if (!view) {
    return shell(<p className="label">Loading the reference…</p>);
  }

  if (!view.available) {
    // Three reasons, three sentences. A quiz has its own arm, so its shut
    // door never tells a learner their paper was "configuration you wrote for
    // your own machine": the `default:` arm's words, wrong about a task that
    // writes no file at all.
    const reason = view.unavailableReason;
    const body =
      reason === 'prose'
        ? `${subject} is a piece of writing, and the pack ships no model answer to hold yours against. What it does ship is the rubric your work was scored on, and the reviewer who read it.`
        : reason === 'quiz'
          ? `${subject} is a quiz, and there is no answer key to read. Your report says which questions you got wrong, and it explains each one once you are finished with it — a key you could read would be the paper.`
          : `${subject} is configuration you wrote for your own machine, and the pack ships no model copy of it. The checks it was scored against are on the phase, and the drill is the rest of the answer.`;
    return shell(
      <EmptyState
        icon="eye"
        title="This phase has no reference answer"
        body={body}
        action={
          <Button size="sm" href={back}>
            {backLabel}
          </Button>
        }
        testId={
          reason === 'prose'
            ? 'solution-empty-prose'
            : reason === 'quiz'
              ? 'solution-empty-quiz'
              : 'solution-empty-config'
        }
      />,
    );
  }

  return shell(
    <div className="flex min-w-0 flex-col gap-3.5">
      <div className="flex flex-col gap-1">
        <p className="label wrap" data-testid="solution-standing">
          {standingLine(view, title)}
        </p>
        <p className="label wrap" data-testid="solution-summary">
          {solutionSummary(rows)}
        </p>
      </div>

      {wide && (
        <Tabs
          items={[
            { key: 'unified', label: 'Unified', testId: 'solution-view-unified' },
            { key: 'split', label: 'Side by side', testId: 'solution-view-split' },
          ]}
          value={mode}
          onChange={(key) => setMode(key === 'split' ? 'split' : 'unified')}
          label="How to read the difference"
          panelId="solution-files"
        />
      )}

      <div
        {...(wide ? tabPanelProps('solution-files', mode) : {})}
        className="flex min-w-0 flex-col gap-3.5"
      >
        {rows.map((row) => (
          <SolutionDiff key={row.path} row={row} view={wide ? mode : 'unified'} />
        ))}
      </div>
    </div>,
    'How the pack answered this phase, beside what you merged. Your score is already recorded and nothing here changes it.',
  );
}
