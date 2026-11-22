'use client';

/**
 * Dates for this class.
 *
 * Two dates per phase, and nothing else. A release date holds a phase shut
 * until it arrives, the learner's card reads locked and the route refuses with
 * the date in the sentence. A due date holds nothing shut; it marks work late,
 * and lateness is derived by comparing a submission's time with this date, so
 * moving a date moves what is late at once.
 *
 * The inputs are `datetime-local`, which is a wall time with no zone at all, so
 * the panel names the zone it is writing in rather than leaving anyone to
 * guess. What the API stores is the instant that wall time was.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CohortPhaseSchedule, CohortScheduleView, PhaseKey } from '@learnsdlc/shared';
import { ApiError, describeError } from '@/lib/api';
import { instructorApi } from '@/lib/api-instructor';
import { cohortsApi, type Cohort } from '@/lib/api-cohorts';
import { browserTimezone, fromLocalInput, toLocalInput } from '@/lib/schedule';
import { Button, EmptyState, Notice, Section } from '@/components/ui';
import { TD, TH } from '@/components/staff/primitives';

/** One row of the draft, held as the input's own wall-time strings. */
interface DraftRow {
  phaseKey: PhaseKey;
  title: string;
  opens: string;
  due: string;
}

export function SchedulePanel({
  projectSlug,
  phases,
  preferCohortId,
}: {
  projectSlug: string;
  /** The pack's phases, in pack order. */
  phases: { key: PhaseKey; title: string }[];
  /** The class most of the console's rows belong to, when there is one. */
  preferCohortId?: string | null;
}) {
  const [cohorts, setCohorts] = useState<Cohort[] | null>(null);
  const [cohortId, setCohortId] = useState('');
  const [view, setView] = useState<CohortScheduleView | null>(null);
  const [draft, setDraft] = useState<DraftRow[]>([]);
  /**
   * Whether the rows on screen are this class's own. Until they are, the
   * panel says it is loading rather than "No dates set" over an empty table:
   * drawn before the classes have even been listed, that sentence would read
   * as an answer.
   */
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    cohortsApi
      .mine()
      .then((list) => {
        if (!alive.current) return;
        setCohorts(list);
        const wanted = list.find((c) => c.id === preferCohortId) ?? list[list.length - 1];
        if (wanted) setCohortId(wanted.id);
      })
      .catch((err) => {
        if (!alive.current) return;
        setCohorts([]);
        setError(describeError(err, 'Your classes could not be loaded. Try again in a moment.'));
      });
  }, [preferCohortId]);

  /**
   * The phases by what they say, not by which array holds them. The class page
   * draws its projects' phase lists afresh on every render, so keying on the
   * array would read the dates again each time the list is a new array: in a
   * loop, on a page that re-renders often.
   */
  const phasesSaid = phases.map((phase) => `${phase.key}\u0000${phase.title}`).join('\u0001');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const steadyPhases = useMemo(() => phases, [phasesSaid]);
  /** A class whose dates answered 404, and the sentence it answered: read once, then settled. */
  const missing = useRef(new Map<string, string>());

  const rowsFrom = useCallback(
    (schedule: CohortPhaseSchedule[]): DraftRow[] => {
      const byKey = new Map(schedule.map((row) => [row.phaseKey, row]));
      return steadyPhases.map((phase) => ({
        phaseKey: phase.key,
        title: phase.title,
        opens: toLocalInput(byKey.get(phase.key)?.opensAt ?? null),
        due: toLocalInput(byKey.get(phase.key)?.dueAt ?? null),
      }));
    },
    [steadyPhases],
  );

  useEffect(() => {
    if (!cohortId) return;
    let cancelled = false;
    setSaved('');
    const asked = `${cohortId}\u0000${projectSlug}`;
    const settled = missing.current.get(asked);
    if (settled !== undefined) {
      // A 404 is not asked again: the empty table and the sentence it answered.
      setView(null);
      setDraft(rowsFrom([]));
      setError(settled);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    instructorApi
      .schedule(cohortId, projectSlug)
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setDraft(rowsFrom(next.phases));
        setError('');
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        const sentence = describeError(err, "This class's dates could not be loaded. Try again in a moment.");
        if (err instanceof ApiError && err.status === 404) missing.current.set(asked, sentence);
        setView(null);
        setDraft(rowsFrom([]));
        setError(sentence);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cohortId, projectSlug, rowsFrom]);

  const edit = (phaseKey: PhaseKey, field: 'opens' | 'due', value: string) => {
    setSaved('');
    setDraft((rows) => rows.map((row) => (row.phaseKey === phaseKey ? { ...row, [field]: value } : row)));
  };

  const save = async (rows: DraftRow[]) => {
    setSaving(true);
    setError('');
    setSaved('');
    try {
      const next = await instructorApi.saveSchedule(
        cohortId,
        projectSlug,
        rows.map<CohortPhaseSchedule>((row) => ({
          phaseKey: row.phaseKey,
          opensAt: fromLocalInput(row.opens),
          dueAt: fromLocalInput(row.due),
        })),
      );
      // A save that lands is the class answering, so its 404 is not kept.
      missing.current.delete(`${cohortId}\u0000${projectSlug}`);
      if (!alive.current) return;
      setView(next);
      setDraft(rowsFrom(next.phases));
      setSaved('Dates saved. Every learner in this class sees them on their next page.');
    } catch (err) {
      if (alive.current) setError(describeError(err, 'The dates could not be saved. Try again in a moment.'));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const none = useMemo(() => draft.every((row) => !row.opens && !row.due), [draft]);
  const zone = browserTimezone();
  const className = cohorts?.find((c) => c.id === cohortId)?.name ?? 'this class';

  if (cohorts !== null && cohorts.length === 0) {
    return (
      <Section
        title="Dates for this class"
        purpose="Phases open when a learner passes the gate before them. A release date holds a phase shut until then; a due date does not, it marks late work."
        testId="schedule-panel"
      >
        <EmptyState
          icon="clock"
          title="No class to set dates for"
          body="Dates belong to a class. Make one in Your classes below, and its dates appear here."
          testId="schedule-no-class"
        />
      </Section>
    );
  }

  return (
    <Section
      title="Dates for this class"
      purpose="Phases open when a learner passes the gate before them. A release date holds a phase shut until then; a due date does not, it marks late work."
      testId="schedule-panel"
      right={
        cohorts && cohorts.length > 1 ? (
          <label className="flex min-w-0 max-w-full items-center gap-2">
            <span className="label">Class</span>
            <select
              className="field h-[30px] min-w-0 max-w-full py-0 text-[13px]"
              value={cohortId}
              onChange={(e) => setCohortId(e.target.value)}
              data-testid="schedule-cohort"
            >
              {cohorts.map((cohort) => (
                <option key={cohort.id} value={cohort.id}>
                  {cohort.name}
                </option>
              ))}
            </select>
          </label>
        ) : undefined
      }
    >
      {error && (
        <Notice tone="fail" role="alert" testId="schedule-error">
          {error}
        </Notice>
      )}
      {saved && (
        <Notice tone="pass" role="status" testId="schedule-saved">
          {saved}
        </Notice>
      )}
      {!loaded && (
        <p className="purpose" data-testid="schedule-loading">
          Loading the dates for {className}.
        </p>
      )}
      {loaded && none && (
        <p className="purpose" data-testid="schedule-cleared">
          No dates set for {className}. Phases open when the learner passes the gate before them, and
          nothing is late.
        </p>
      )}

      {/* The table scrolls in its own box; `min-w-0` so a flex parent can
          shrink past the table's own minimum instead of widening the page. */}
      <div className="relative min-w-0 overflow-x-auto">
        <table
          className="w-full min-w-[520px] border-collapse text-left"
          data-testid="schedule-table"
          hidden={!loaded}
        >
          <thead>
            <tr>
              <th className={TH}>Phase</th>
              <th className={TH}>Opens</th>
              <th className={TH}>Due</th>
            </tr>
          </thead>
          <tbody>
            {draft.map((row) => (
              <tr key={row.phaseKey} className="border-b-1.5 border-edge last:border-b-0">
                <td className={`${TD} whitespace-nowrap font-medium`}>{row.title}</td>
                <td className={TD}>
                  <input
                    type="datetime-local"
                    className="field h-[30px] w-full min-w-[200px] py-0 text-[13px]"
                    value={row.opens}
                    onChange={(e) => edit(row.phaseKey, 'opens', e.target.value)}
                    aria-label={`${row.title} opens`}
                    data-testid={`schedule-opens-${row.phaseKey}`}
                  />
                </td>
                <td className={TD}>
                  <input
                    type="datetime-local"
                    className="field h-[30px] w-full min-w-[200px] py-0 text-[13px]"
                    value={row.due}
                    onChange={(e) => edit(row.phaseKey, 'due', e.target.value)}
                    aria-label={`${row.title} due`}
                    data-testid={`schedule-due-${row.phaseKey}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button onClick={() => save(draft)} disabled={saving || !loaded || !cohortId} busy={saving} busyLabel="Saving…" testId="schedule-save">
          Save dates
        </Button>
        <Button
          variant="secondary"
          onClick={() => save(draft.map((row) => ({ ...row, opens: '', due: '' })))}
          disabled={saving || !loaded || none || !cohortId}
          testId="schedule-clear"
        >
          Clear all dates
        </Button>
        <span className="label-sm">
          {zone
            ? `Times are in ${zone}, this machine's timezone.`
            : "Times are in this machine's timezone."}
          {view ? ` They apply to ${className} on ${view.projectSlug}.` : ''}
        </span>
      </div>
    </Section>
  );
}
