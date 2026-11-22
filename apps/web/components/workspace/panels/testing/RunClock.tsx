'use client';

/**
 * The run clock: the day the sandbox calls today in the testing phase.
 *
 * It is drawn at the foot of the testing phase's brief, beside the two buttons
 * that use it, rather than in a pane of its own: this is the phase's own
 * panel (`panels/testing/Brief.tsx`), which is where a learner is standing
 * when they run a suite.
 */
import { useState } from 'react';
import { RUN_CLOCK_PATTERN } from '@learnsdlc/shared';
import { Button, Chip, Detail, Section } from '@/components/ui';
import { clockWords } from './lib';

/**
 * The clock the learner's tests read.
 *
 * A suite about overdue work is only reproducible if the day it runs on is a
 * decision rather than an accident: pinned, the same suite gives the same
 * verdict tomorrow, and every planted bug in one verdict was run against the
 * same day. It costs nothing to change, no attempt, no verdict, no run gate,
 * and the panel says so, because a learner who thinks it costs them something
 * will not use it.
 */
export function RunClock({
  runClock,
  setRunClock,
  busy,
  onNotice,
  onError,
  /** How this pack's suite reads the clock; the two packs speak two languages. */
  importLine = 'from tests.clock import today',
}: {
  runClock: string | null;
  setRunClock: (date: string | null) => Promise<void>;
  busy: boolean;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  /** Null where the pack ships no clock module to import. */
  importLine?: string | null;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // The date the learner is about to pin: what they have typed, else what is
  // pinned, else today: a date field that opens empty is one more decision.
  const value = draft || runClock || new Date().toISOString().slice(0, 10);

  const write = async (date: string | null) => {
    setSaving(true);
    try {
      await setRunClock(date);
      setDraft('');
      onNotice(
        date ? `Your tests see ${clockWords(date)} every time they run.` : "Back to today's date.",
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'The run clock did not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Run clock"
      purpose={
        runClock
          ? 'Your tests see this date every time they run, so the same suite gives the same verdict tomorrow.'
          : "Your tests see today's real date. A test that reads the clock will pass some days and fail others."
      }
      right={<Chip tone={runClock ? 'accent' : 'outline'}>{runClock ? clockWords(runClock) : "Today's date"}</Chip>}
      testId="run-clock"
    >
      <Detail label="What the sandbox calls today">
        {runClock ? `${clockWords(runClock)}, every run in this phase.` : "Today's date, whenever you run."}
      </Detail>
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="label-sm text-ink2">Pin the clock to</span>
          <input
            type="date"
            className="field h-8 py-0 text-[13px]"
            value={value}
            min="1970-01-01"
            max="2100-12-31"
            disabled={saving || busy}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="run-clock-date"
          />
        </label>
        <Button
          size="sm"
          busy={saving}
          busyLabel="Pinning"
          disabled={!RUN_CLOCK_PATTERN.test(value)}
          onClick={() => void write(RUN_CLOCK_PATTERN.test(value) ? value : null)}
          testId="run-clock-pin"
        >
          Pin the clock
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!runClock || saving}
          onClick={() => void write(null)}
          testId="run-clock-clear"
        >
          Use today's date
        </Button>
      </div>
      {importLine !== null ? (
        <p className="purpose">
          Read it with <span className="mono">{importLine}</span> and build your dates from{' '}
          <span className="mono">today()</span>. Changing it spends no attempt, clears no run and leaves your last
          verdict standing: it is a parameter of the next run, not an event.
        </p>
      ) : (
        <p className="purpose">
          Changing it spends no attempt, clears no run and leaves your last verdict standing: it is a parameter of the
          next run, not an event.
        </p>
      )}
    </Section>
  );
}

