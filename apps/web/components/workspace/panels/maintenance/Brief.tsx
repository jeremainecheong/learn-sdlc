'use client';

/**
 * The ticket header, under the change request in the brief pane: what CR-1 is,
 * which pull request carries it, and the state of the three artefacts the
 * change travels with. The Change tab holds the work; this card says where it
 * stands without opening it.
 */
import { Chip, StatusSquare } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { StatusState } from '@/lib/phase';
import type { PhasePanelProps } from '../types';
import { useMaintenance } from './useMaintenance';

/** The chip word for one artefact's state; never a bare colour. */
function stateChip(state: StatusState, label: string, testId?: string) {
  const tone = state === 'pass' ? 'pass' : state === 'fail' ? 'fail' : state === 'warn' ? 'warn' : 'outline';
  return (
    <Chip tone={tone} testId={testId}>
      {label}
    </Chip>
  );
}

export default function MaintenanceBrief(props: PhasePanelProps) {
  const { detail, submission, helpers } = props;
  const m = useMaintenance(props);
  // Named by the phase's place in its own project, never its stored order.
  const pr = `PR-${detail.place}`;
  const target = m.targetPath;

  const attempt = submission?.attempt ?? (detail.attempts > 0 ? detail.attempts : null);
  const prLine = submission
    ? `${pr} open, submission ${attempt ?? 1}.`
    : `${pr} opens when you submit.`;

  const contractLabel = m.contractWritten
    ? 'Contract v2 written'
    : m.change
      ? 'Contract v2 incomplete'
      : 'Contract v2 unwritten';
  const regressionLabel = m.regressionSuite
    ? `Regression ${m.regressionSuite.result.toLowerCase()}`
    : 'Regression not run';
  const releaseLabel = m.releaseState === 'pass' ? 'Release written' : 'Release unwritten';

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="phase-maintenance-brief">
      <div className="flex min-w-0 items-start gap-2.5">
        <StatusSquare state="now" size={11} className="mt-[6px]" label="In progress" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="h3 wrap">
            {m.ticket.id}: {m.ticket.title}
          </h3>
          <p className="purpose wrap">{prLine}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {/* No contract chip while the teacher's contract switch is off: the phase has no Contract tab to write it in. */}
        {detail.change?.contract !== false && stateChip(m.contractState, contractLabel)}
        {stateChip(m.regressionState, regressionLabel)}
        {stateChip(m.releaseState, releaseLabel)}
      </div>

      {/* Only a named operation reads as what the ticket asks for; without one the sentence would name the ticket twice. */}
      {target && m.operation && (
        <p className="wrap text-[12.5px] leading-[1.45] text-ink2">
          {m.ticket.id} asks for <span className="mono text-ink">{m.changeName}</span> in{' '}
          <button
            type="button"
            className="mono rounded-sm text-accent underline underline-offset-2 hover:text-ink"
            onClick={() => helpers.openFile(target)}
          >
            {target}
          </button>
          .
        </p>
      )}

      <button type="button" className="btn-secondary btn-sm self-start" onClick={() => helpers.setTab('phase')}>
        <Icon name="maintenance" size={14} />
        Open the change
      </button>
    </div>
  );
}
