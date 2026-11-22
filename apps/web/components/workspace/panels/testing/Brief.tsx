'use client';

/**
 * The foot of the brief pane: how big the suite is, how much of it is linked
 * to a criterion, and how many planted bugs it catches. The three numbers the
 * gate cares about, in the order the work happens.
 */
import { Chip, Stat } from '@/components/ui';
import type { PhasePanelProps } from '../types';
import { RunClock } from './RunClock';
import { useTesting } from './useTesting';
import { runsReferenceApplication } from '@/components/workspace/application';

export default function TestingBrief(props: PhasePanelProps) {
  const { runClock, setRunClock, helpers } = props;
  const { files: testFiles, tests, linked, view, first } = useTesting(props);
  // The two packs speak Python and JavaScript, so the line that reads the clock
  // is the one this learner would actually type.
  const script = /script$/i.test(testFiles[0]?.language ?? '');
  // The import line names TaskTrackr's clock module.
  // A teacher's own application is told how to read the clock only where it
  // ships one.
  const clockShipped =
    runsReferenceApplication(props.detail.provenance) ||
    props.detail.files.some((file) => /(^|\/)clock\.(py|[cm]?[jt]sx?)$/.test(file.path));
  const linkedCount = tests.filter((t) => linked[t.name]).length;
  const alive = view.total - view.killed;
  const ran = first.filter((r) => r.state !== 'unseen').length;
  const neverRed = first.filter((r) => r.state === 'never-red' || r.state === 'green-first').length;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Which day the suite will run on, above the numbers it produces: the
          three figures below are only reproducible if this is a decision. */}
      <RunClock
        runClock={runClock}
        setRunClock={setRunClock}
        busy={helpers.busy}
        onNotice={helpers.setNotice}
        onError={helpers.setError}
        importLine={clockShipped ? (script ? "const { today } = require('./clock')" : 'from tests.clock import today') : null}
      />

      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="h3 wrap">Your suite</h2>
        <p className="purpose wrap">
          Counted from your test file and the last verdict. A test proves a criterion only when it is linked to one and
          fails on the bug that breaks it.
        </p>
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-2">
        <Stat value={tests.length} label="Tests written" />
        <Stat
          value={`${linkedCount} of ${tests.length}`}
          label="Linked to a criterion"
          tone={tests.length === 0 ? 'neutral' : linkedCount === tests.length ? 'pass' : linkedCount === 0 ? 'warn' : 'neutral'}
        />
        <Stat
          className="col-span-2"
          value={view.total > 0 ? `${view.killed} of ${view.total}` : 'Not yet'}
          label="Planted bugs caught"
          hint={view.total > 0 ? 'From the last verdict' : 'The verdict runs them'}
          tone={view.total === 0 ? 'neutral' : alive === 0 ? 'pass' : view.killed === 0 ? 'fail' : 'warn'}
        />
      </div>

      {/* The one signal the three numbers cannot carry: a test that was never
          red proves nothing, however many bugs the suite catches. */}
      {ran > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {neverRed > 0 ? (
            <Chip tone="warn">
              {neverRed === 1 ? '1 test has never been red' : `${neverRed} tests have never been red`}
            </Chip>
          ) : (
            <Chip tone="pass">Every test was red before it was green</Chip>
          )}
        </div>
      )}
    </div>
  );
}
