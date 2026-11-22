'use client';

/**
 * The floor in words: every rule the review grades the design with, its state
 * and what it found, and under them the whole floor in one sentence. The room
 * shows it after "Check the design", and nowhere else says pass or fail.
 */
import { Chip, Panel } from '@/components/ui';
import { Row } from '../requirements/Rows';
import {
  designFloorSentence,
  type DesignContracts,
  type DesignFloor,
  type DesignFloorResult,
} from '@learnsdlc/shared';

export function ChecksPanel({
  results,
  floor,
  contracts,
  sequence,
  onHide,
}: {
  results: DesignFloorResult[];
  floor: DesignFloor;
  contracts: DesignContracts;
  sequence: boolean;
  onHide?: () => void;
}) {
  return (
    <Panel className="flex flex-col gap-3 p-3.5" testId="phase-design-checks">
      <div className="flex items-center gap-2">
        {/* Named as Requirements names its rows ("Story checks"), under one heading. */}
        <h2 className="h3">Design checks</h2>
        <span className="flex-1" />
        {onHide && (
          <button type="button" className="btn-ghost btn-sm" onClick={onHide}>
            Hide
          </button>
        )}
      </div>
      {/* the Requirements room's own row: a status square, the rule, what it found, and the result */}
      <ul className="m-0 list-none p-0">
        {results.map((r) => (
          <Row
            key={r.id}
            state={r.passed ? 'pass' : 'fail'}
            title={r.label}
            detail={r.detail}
            right={<Chip tone={r.passed ? 'pass' : 'fail'}>{r.passed ? 'Passed' : 'Failed'}</Chip>}
            testId={`phase-design-check-${r.id}`}
          />
        ))}
      </ul>
      <p className="label-sm wrap" data-testid="phase-design-floor-sentence">
        Your design needs {designFloorSentence(floor, { contracts, sequence })}.
      </p>
    </Panel>
  );
}
