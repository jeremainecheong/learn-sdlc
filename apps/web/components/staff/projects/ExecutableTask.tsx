'use client';

/**
 * A phase's executable task, read-only.
 *
 * What every reader of an executable task sees, with or without the editor:
 * its starter files, its runs, and
 * each sealed file (hidden test, reference solution, mutant) as **its path,
 * its digest and its size**. There is no field here that could hold the bytes:
 * a row is drawn from `SealedFileView`'s three members by name, so a payload
 * that arrived carrying more still draws three things.
 *
 * And the deployment phase's smoke check and incident drill, which are read
 * here and changed only by uploading the project again.
 */
import type { ExecutableTaskView, SealedFileView } from '@learnsdlc/shared';
import { RUN_SHAPES, pluralWord } from '@learnsdlc/shared';
import { Chip, Notice } from '@/components/ui';
import { formatBytes } from '@/components/staff/projects/upload-bytes';

/** Why the smoke check and the drill are read-only, in one sentence. */
export const SMOKE_DRILL_READ_ONLY =
  'The smoke check and the incident drill are part of the project’s files. They are read here and not edited: a project of your own changes them when its archive is uploaded again.';

/** A run shape's own summary, from the contract's closed list. */
export function shapeSummary(shape: string): string {
  return RUN_SHAPES.find((one) => one.id === shape)?.summary ?? shape;
}

/**
 * Sealed files as rows: path, digest, size. `group` names the rows'
 * test ids (`sealed-<group>-row-<n>`).
 */
export function SealedFileRows({
  files,
  group,
  empty,
}: {
  files: readonly SealedFileView[];
  group: string;
  /** What to say when there are none yet. */
  empty: string;
}) {
  if (files.length === 0) {
    return (
      <p className="label-sm" data-testid={`sealed-${group}-empty`}>
        {empty}
      </p>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid={`sealed-${group}`}>
      {files.map((file, at) => {
        // Three members by name, and nothing else of whatever arrived.
        const path = String(file.path);
        const sha256 = String(file.sha256);
        const bytes = Number(file.bytes);
        return (
          <li
            key={`${path}-${at}`}
            className="flex min-w-0 flex-col gap-0.5 rounded-ctl border-1.5 border-edge px-3 py-2"
            data-testid={`sealed-${group}-row-${at}`}
          >
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="mono min-w-0 flex-1 break-all text-[12.5px] text-ink">{path}</span>
              <Chip tone="outline">Sealed</Chip>
              <span className="label-sm whitespace-nowrap tabular-nums">{formatBytes(bytes)}</span>
            </span>
            <span className="label-sm">
              {'sha256 '}
              <span className="mono break-all text-[11.5px] text-ink2">{sha256}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The deployment phase's smoke and drill, read-only. */
export function SmokeDrillReadOnly({ phaseTitle }: { phaseTitle: string }) {
  return (
    <Notice tone="info" icon="lock" testId="smoke-drill-read-only-box">
      <span className="block font-medium">{`${phaseTitle}: the smoke check and the drill`}</span>
      <span className="block" data-testid="smoke-drill-read-only">
        {SMOKE_DRILL_READ_ONLY}
      </span>
    </Notice>
  );
}

function List({ items, none }: { items: readonly string[]; none: string }) {
  if (items.length === 0) return <span className="label-sm">{none}</span>;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {items.map((item) => (
        <li key={item} className="mono break-all text-[12.5px] text-ink">
          {item}
        </li>
      ))}
    </ul>
  );
}

/** The executable task as a teacher reads it, with no control at all. */
export function ExecutableSummary({
  phaseTitle,
  executable,
}: {
  phaseTitle: string;
  executable: ExecutableTaskView;
}) {
  const tests = executable.checkKind === 'tests';
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-ctl border-1.5 border-edge p-3" data-testid="exec-summary">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[13.5px] font-semibold text-ink">
          {`${phaseTitle}: the ${tests ? 'testing' : 'coding'} task that runs`}
        </span>
        <Chip tone="neutral" className="tabular-nums">
          {`${executable.sandboxBudget} ${pluralWord(executable.sandboxBudget, 'microVM')} a pass`}
        </Chip>
      </div>

      <div className="min-w-0">
        <span className="label-sm font-medium">Starter files a learner works in</span>
        <List items={executable.owns} none="None listed." />
      </div>

      {executable.runs.map((run) => (
        <div key={run.id} className="flex min-w-0 flex-col gap-1.5" data-testid={`exec-summary-run-${run.id}`}>
          <span className="text-[13px] font-medium text-ink">{run.label}</span>
          <span className="label-sm wrap">{shapeSummary(run.shape)}</span>
          <span className="label-sm font-medium">{tests ? 'The learner’s own test files' : 'Tests a learner can see and run'}</span>
          <List items={tests ? run.learnerTestFiles : run.visibleTests} none="None listed." />
          <span className="label-sm font-medium">{tests ? 'Reference tests (sealed)' : 'Hidden tests (sealed)'}</span>
          <SealedFileRows files={run.hidden} group={`hidden-${run.id}`} empty="No sealed file in this run." />
        </div>
      ))}

      <div className="min-w-0">
        <span className="label-sm font-medium">{tests ? 'Reference implementation (sealed)' : 'Reference solution (sealed)'}</span>
        <SealedFileRows files={executable.solution} group="solution" empty="No reference solution yet." />
      </div>

      {tests && (
        <>
          <div className="min-w-0">
            <span className="label-sm font-medium">Mutants (sealed)</span>
            <SealedFileRows files={executable.mutants} group="mutant" empty="No mutant yet." />
          </div>
          <p className="label-sm wrap">
            {`A learner's suite holds at least ${executable.minTests ?? 0} tests${
              executable.coverageKeywords.length > 0 ? ` and covers ${executable.coverageKeywords.join(', ')}` : ''
            }.`}
          </p>
        </>
      )}
    </div>
  );
}
