'use client';

/**
 * The project this class works on.
 *
 * A class's project is a row rather than a column, so this card shows three
 * things that are all the same fact seen from different distances: the
 * assignment in force, the published versions the class could be put on
 * instead, and everything it has been put on before. The reason field is the
 * same ten characters every instructor override already asks for, and it is
 * what the audit trail carries.
 *
 * The sentences about who is where are the one thing on this card that a
 * teacher will be wrong about if nobody writes them down. Assigning a version
 * moves no learner's work and no pin: a learner who joins **from now on** is
 * given it, and a learner working a teacher's project this class was given
 * stays on it. But a learner working the default project or any
 * platform project other than the one assigned moves to the Start of the
 * class's project, with what they did kept in
 * their record, so the card says so, for the version chosen, before it is
 * assigned; the receipt after it names the version once. Moving a learner's
 * work between projects is a separate, explicitly audited act that refuses a learner holding an
 * in-flight submission, and it is not this control.
 *
 * Built on the teacher portal's own `exp-` tokens rather than the staff
 * console's, because the portal is where it is mounted (the same choice
 * `StuckList` made).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, RefreshCw } from 'lucide-react';
import {
  ASSIGNMENT_REASON_MAX,
  ASSIGNMENT_REASON_MIN,
  andList,
  phaseListSentence,
  type AssignableVersionView,
  type CohortProjectView,
  type VersionProvenanceView,
} from '@learnsdlc/shared';
import { describeError } from '@/lib/api';
import { instructorApi } from '@/lib/api-instructor';
import { describeInstant } from '@/lib/schedule';
import { StatusSquare } from '@/components/ui';

/**
 * Who stays where, said once under "What assigning does".
 * It does not say that everybody already in the class keeps what they
 * started: a learner on a platform project is moved to the class's project.
 */
const STAY_SENTENCE =
  "Learners working a teacher's project this class was given stay on it, at the version they started on.";

/** Said of every learner who moves, so the promise reads alike in each case. */
const STILL_KEPT = 'and the work they did before stays in their record';

/**
 * What the chosen version does to a learner working the default project or a
 * platform project. The server sets aside every such row whose project is not
 * the class's (`WorkflowService.standing`: the `yielding` rows, "a platform or
 * default project other than this one"), kept whole and still read by name,
 * and the learner meets the class's project's Start; a learner already on the
 * class's project stays at their own pin. So:
 *
 * - a teacher's project moves the learners of the default project and of every
 *   platform project to its Start;
 * - a platform project keeps its own learners and moves every other learner on
 *   the default or a platform project to its Start. "Every other", because the
 *   card cannot tell which platform project is the default (the assignable
 *   rows carry `platformOwned`, not `isDefault`), and "every other" is true
 *   either way;
 * - with nothing chosen, the general rule, with its one exception said.
 */
function platformSentence(picked: AssignableVersionView | null): string {
  if (picked?.platformOwned) {
    const named = picked.projectTitle;
    return `Learners working ${named} stay on it too, at the version they started on. Every other learner working the default project or a platform project moves to the Start of ${named}, ${STILL_KEPT}.`;
  }
  if (picked) {
    return `Learners working the default project or any other platform project move to the Start of ${picked.projectTitle}, ${STILL_KEPT}.`;
  }
  return `Learners working the default project or any other platform project move to the Start of the project you assign, unless they are working it already, ${STILL_KEPT}.`;
}

/**
 * What a version holds, in one sentence:
 * how many of its written phases are the teacher's own, and whose application
 * its last four phases run. Read from the version's provenance; the name is
 * the payload's (`applicationFrom`), never a literal. Null for a payload
 * without provenance, which says nothing rather than guess.
 *
 * Said to the teacher reading the card: `mine` true, the version is
 * "yours"; false (a version shared with them), "its author's"; left out,
 * "the teacher's".
 */
export function versionProvenanceSentence(
  title: string,
  provenance: VersionProvenanceView | null | undefined,
  mine?: boolean,
): string | null {
  if (!provenance) return null;
  const { ownPhases: own, mixedPhases: mixed, referencePhases: kept, applicationFrom } = provenance;
  const written = own + mixed + kept;
  const phases = (n: number) => (n === 1 ? '1 written phase' : `${n} written phases`);
  const reference = applicationFrom ? `${applicationFrom}'s` : 'the project it was copied from';
  const whose = mine === true ? 'yours' : mine === false ? "its author's own" : "the teacher's own";
  const partly = mine === true ? 'partly yours' : mine === false ? "partly its author's" : "partly the teacher's";
  const parts: string[] = [];
  if (written > 0) {
    if (kept === written) {
      parts.push(`Every written phase of ${title} is still ${reference}.`);
    } else if (own === written) {
      parts.push(`Every written phase of ${title} is ${whose}.`);
    } else {
      const verb = (n: number) => (n === 1 ? 'is' : 'are');
      const bits = [
        own ? `${own} ${verb(own)} ${whose}` : '',
        mixed ? `${mixed} ${verb(mixed)} ${partly}` : '',
        kept ? `${kept} ${verb(kept)} still ${reference}` : '',
      ].filter(Boolean);
      parts.push(`Of the ${phases(written)} in ${title}, ${andList(bits)}.`);
    }
  }
  if (applicationFrom) {
    parts.push(
      `Implementation, Testing, Deployment and Maintenance run ${applicationFrom}'s application: its code, hidden tests, deployment and maintenance.`,
    );
  }
  return parts.length ? parts.join(' ') : null;
}

/** Who set an assignment, when the account that set it is gone. */
const setBy = (name: string | null) => name ?? 'an account that has since been removed';

/**
 * How an option reads, so two versions of one project are never confusable.
 * A version of any subset of the six phases can be assigned, so
 * the line names the phases the version holds, in place order, when the
 * payload carries them: "RoomDesk 0.2.0: Requirements, Design and
 * Implementation (yours)". A payload without the phase list, or a version with
 * no phase rows, reads as the title, version and note alone.
 */
function optionLabel(row: AssignableVersionView): string {
  const note = row.current
    ? 'assigned now'
    : row.platformOwned
      ? 'the platform project'
      : row.mine
        ? 'yours'
        : 'shared with you';
  const phases = row.phases?.length ? phaseListSentence(row.phases) : '';
  return phases ? `${row.projectTitle} ${row.version}: ${phases} (${note})` : `${row.projectTitle} ${row.version}, ${note}`;
}

/** A row's `publishedAt` as a number to sort on, or null when it has none the browser can read. */
function publishedTime(row: AssignableVersionView): number | null {
  if (!row.publishedAt) return null;
  const time = Date.parse(row.publishedAt);
  return Number.isNaN(time) ? null : time;
}

/**
 * The order "Version to assign" lists its options in. The API answers
 * with the default project first, then the platform's, then the teacher's own
 * by title, so on an account with many versions the one published a minute
 * ago would sit deep in the list. Here the teacher's own versions (`mine`) come
 * first, the most recently published first by the row's own `publishedAt`; an
 * own version with no readable date follows the dated ones. The versions that
 * are not the teacher's (the platform's and any shared with them) follow, in
 * the order the API gave. Rows the payload cannot tell apart keep the API's
 * order, so two loads of the page list them alike. Only the order is this
 * function's: each option's text and value are the row's.
 */
export function assignableOrder(rows: readonly AssignableVersionView[]): AssignableVersionView[] {
  const placed = rows.map((row, index) => ({ row, index, time: publishedTime(row) }));
  const own = placed.filter((one) => one.row.mine === true);
  const rest = placed.filter((one) => one.row.mine !== true);
  own.sort((a, b) => {
    if (a.time !== null && b.time !== null && a.time !== b.time) return b.time - a.time;
    if (a.time === null && b.time !== null) return 1;
    if (a.time !== null && b.time === null) return -1;
    return a.index - b.index;
  });
  return [...own, ...rest].map((one) => one.row);
}

export function ClassProjectCard({
  cohortId,
  onAssigned,
}: {
  cohortId: string;
  /** Called once an assignment is saved, so the page's other views read the class's phases again. */
  onAssigned?: () => void;
}) {
  const [project, setProject] = useState<CohortProjectView | null>(null);
  const [options, setOptions] = useState<AssignableVersionView[]>([]);
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const alive = useRef(false);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setRefreshing(true);
    try {
      const [view, assignable] = await Promise.all([
        instructorApi.classProject(cohortId),
        instructorApi.assignableProjects(cohortId),
      ]);
      if (!alive.current || version !== loadVersion.current) return;
      setProject(view);
      setOptions(assignable);
      setError('');
    } catch (err) {
      if (alive.current && version === loadVersion.current)
        setError(describeError(err, 'The project for this class could not be read. Try again.'));
    } finally {
      if (alive.current && version === loadVersion.current) setRefreshing(false);
    }
  }, [cohortId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      loadVersion.current++;
    };
  }, [load]);

  const active = project?.active ?? null;
  const history = project?.history ?? [];
  const picked = options.find((row) => row.versionId === choice) ?? null;
  // Whether the version in force is this teacher's, from the assignable list (it lists the current one).
  const activeMine = active ? options.find((row) => row.versionId === active.projectVersionId)?.mine : undefined;
  const activeProvenance = active ? versionProvenanceSentence(active.projectTitle, active.provenance, activeMine) : null;
  const pickedProvenance = picked ? versionProvenanceSentence(picked.projectTitle, picked.provenance, picked.mine) : null;
  const shortReason = reason.trim().length < ASSIGNMENT_REASON_MIN;

  const assign = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const why = reason.trim();
    if (busy || !choice || why.length < ASSIGNMENT_REASON_MIN) return;
    // Named from what is already in hand rather than from the response, so the
    // receipt is true whatever shape the route answers with.
    const named = picked ? `${picked.projectTitle} ${picked.version}` : 'The version you chose';
    setBusy(true);
    setError('');
    setSaved('');
    try {
      await instructorApi.assignClassProject(cohortId, { projectVersionId: choice, reason: why });
      if (!alive.current) return;
      setChoice('');
      setReason('');
      // The receipt names the version and what it now does, once: who
      // stays and who moves was said under "What assigning does" before the
      // press, and the version in force is drawn just below.
      setSaved(`Assigned. ${named} is what a learner who joins this class from now on is given.`);
      onAssigned?.();
      await load();
    } catch (err) {
      if (alive.current)
        setError(
          describeError(err, 'The class was not moved, and nothing about it changed. Try again.'),
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <section
      className="exp-panel"
      data-testid="class-project-card"
      aria-labelledby="class-project-heading"
    >
      <header className="exp-section-heading">
        <div>
          <span className="exp-eyebrow">What this class works on</span>
          <h2 id="class-project-heading">Project for this class</h2>
          <p>The published version a learner is given when they join this class.</p>
        </div>
        <div className="exp-actions">
          <button
            type="button"
            className="exp-button"
            onClick={() => void load()}
            disabled={refreshing}
            data-testid="class-project-refresh"
          >
            <RefreshCw size={14} aria-hidden="true" />
            {refreshing ? 'Reading…' : 'Read again'}
          </button>
          <Link className="exp-text-link" href="/teacher/projects" data-testid="class-project-library">
            Your projects
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </header>

      {error && (
        <p role="alert" className="exp-error" data-testid="class-project-error">
          {error}
        </p>
      )}
      {/* Present before there is anything to say, so the receipt is announced
          rather than only drawn. Unclassed while empty: `.exp-caption` carries
          a top margin, and an empty one would be a gap with no reason. */}
      <div
        role="status"
        className={saved ? 'exp-caption' : ''}
        data-testid="class-project-status"
      >
        {saved}
      </div>

      {project === null ? (
        <>
          <p role="status">
            {error
              ? 'The project for this class is unavailable, so none of it is shown.'
              : 'Reading the project for this class…'}
          </p>
          {!error && (
            <div className="mt-2 flex flex-col gap-2" aria-hidden="true">
              <div className="skeleton h-4 w-2/5" />
              <div className="skeleton h-4 w-4/5" />
            </div>
          )}
        </>
      ) : (
        <>
          {active ? (
            // The gap a paragraph leaves before the form, as when no version is in force.
            <div className="exp-project-active" data-testid="class-project-active">
              <span className="label-sm inline-flex items-center gap-1.5">
                <StatusSquare state="pass" size={10} />
                In force
              </span>
              <strong className="block">
                {active.projectTitle} {active.version}
              </strong>
              <p className="exp-caption">
                In force since {describeInstant(active.createdAt)}, set by {setBy(active.assignedByName)}.
              </p>
              <p className="exp-caption">Why it was set: {active.reason}</p>
              {activeProvenance && (
                <p className="exp-caption" data-testid="class-project-active-provenance">
                  {activeProvenance}
                </p>
              )}
            </div>
          ) : (
            <p data-testid="class-project-none">
              This class has not been given a project of its own. A learner who joins it starts on
              LearnSDLC&rsquo;s default project.
            </p>
          )}

          <form className="exp-form" onSubmit={assign}>
            <label className="exp-field">
              {/* With a version in force the form is for moving the class on. */}
              {active ? 'Another version to assign' : 'Version to assign'}
              <select
                value={choice}
                disabled={busy}
                onChange={(event) => setChoice(event.target.value)}
                data-testid="class-project-pick"
              >
                <option value="">Choose a published version</option>
                {assignableOrder(options).map((row) => (
                  <option key={row.versionId} value={row.versionId} disabled={row.current}>
                    {optionLabel(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="exp-field">
              Why this class is moving
              <textarea
                value={reason}
                rows={3}
                maxLength={ASSIGNMENT_REASON_MAX}
                disabled={busy}
                onChange={(event) => setReason(event.target.value)}
                aria-describedby="class-project-reason-rule class-project-reason-count"
                data-testid="class-project-reason"
              />
            </label>
            <p
              className="exp-caption"
              id="class-project-reason-rule"
              data-testid="class-project-reason-rule"
            >
              At least {ASSIGNMENT_REASON_MIN} characters, and at most {ASSIGNMENT_REASON_MAX}. It is kept on
              the audit trail beside your name, and no learner reads it.
            </p>
            <aside aria-label="What assigning a version does">
              <h3>What assigning does</h3>
              <p className="exp-caption" data-testid="class-project-pinned">
                {`A learner who joins from now on is given the version you assign. ${STAY_SENTENCE} ${platformSentence(picked)}`}
              </p>
              {pickedProvenance && (
                <p className="exp-caption" data-testid="class-project-provenance">
                  {pickedProvenance}
                </p>
              )}
              <p className="exp-caption">
                Only published versions are listed. A draft is still being written, so a class cannot
                be put on one.
              </p>
            </aside>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className="exp-button exp-primary"
                disabled={busy || !choice || shortReason}
                data-testid="class-project-assign"
              >
                {busy ? 'Assigning…' : 'Assign this version'}
              </button>
              {/* Counted raw rather than trimmed, because the ceiling the box
                  stops typing at is raw: a count that disagreed with the
                  keyboard would defeat the point of counting. */}
              <span
                className="exp-caption"
                id="class-project-reason-count"
                data-testid="class-project-reason-count"
              >
                {reason.length} of {ASSIGNMENT_REASON_MAX}
              </span>
              {shortReason && (
                <span className="exp-caption">
                  Say why in at least {ASSIGNMENT_REASON_MIN} characters before assigning.
                </span>
              )}
            </div>
          </form>

          {history.length > 0 && (
            <>
              <h3>What this class has been on</h3>
              <ul className="exp-list" data-testid="class-project-history">
                {history.map((row) => (
                  <li key={row.id} data-testid={`class-project-history-${row.id}`}>
                    <div>
                      <strong className="inline-flex items-center gap-2">
                        <StatusSquare state={row.active ? 'pass' : 'todo'} size={10} />
                        {row.projectTitle} {row.version}
                      </strong>
                      <small>
                        {row.active ? 'In force' : 'Replaced'}, set by {setBy(row.assignedByName)}, on{' '}
                        {describeInstant(row.createdAt)}
                      </small>
                      <p className="exp-caption">{row.reason}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

export default ClassProjectCard;
