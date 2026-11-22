'use client';

/**
 * The budget ceiling.
 *
 * One full pass of a version may boot at most `BUDGET_CEILING.perPhase`
 * microVMs in any phase and `BUDGET_CEILING.perVersion` in all. Publish refuses
 * above either, naming the phase and the count; this says the same thing in
 * the same words (`budgetCeilingRefusal`) before a teacher gets that far, and
 * says what fits when nothing is over.
 */
import { BUDGET_CEILING, budgetCeilingRefusal } from '@learnsdlc/shared';
import { Notice } from '@/components/ui';

interface PhaseBudget {
  title: string;
  microVMs: number;
}

/** Every refusal publish would make on these counts, phases first, in order. */
function ceilingRefusals(phases: readonly PhaseBudget[], version = true): string[] {
  const out = phases
    .filter((phase) => phase.microVMs > BUDGET_CEILING.perPhase)
    .map((phase) => budgetCeilingRefusal(phase.microVMs, phase.title));
  const total = phases.reduce((sum, phase) => sum + phase.microVMs, 0);
  if (version && total > BUDGET_CEILING.perVersion) out.push(budgetCeilingRefusal(total, null));
  return out;
}

function microVMs(count: number): string {
  return count === 1 ? '1 microVM' : `${count} microVMs`;
}

/**
 * The line that says what fits: the version against its own ceiling first (the
 * full-pass figure publish's receipt repeats), then each phase against its.
 */
export function ceilingLine(phases: readonly PhaseBudget[], version = true): string {
  const each = phases.map(
    (phase) => `${phase.title} boots ${microVMs(phase.microVMs)} of at most ${BUDGET_CEILING.perPhase}.`,
  );
  if (version) {
    const total = phases.reduce((sum, phase) => sum + phase.microVMs, 0);
    each.unshift(`One full pass boots ${microVMs(total)} of at most ${BUDGET_CEILING.perVersion} for a version.`);
  }
  return each.join(' ');
}

export function BudgetCeiling({
  phases,
  version = true,
  testId = 'budget-ceiling',
}: {
  phases: readonly PhaseBudget[];
  /** False where only one phase is on screen, so no version total is claimed. */
  version?: boolean;
  testId?: string;
}) {
  const refusals = ceilingRefusals(phases, version);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <p className="label-sm wrap tabular-nums" data-testid={`${testId}-line`}>
        {ceilingLine(phases, version)}
      </p>
      {refusals.length > 0 && (
        <Notice tone="fail" role="status">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {refusals.map((sentence, at) => (
              <li key={at} className="wrap" data-testid={`${testId}-refusal-${at}`}>
                {sentence}
              </li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  );
}
