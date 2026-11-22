'use client';

/**
 * The version's total in the editor, only as far as the
 * draft view can price it.
 *
 * Publish prices every phase (`sandboxBudgetFor`): a coding or testing phase by
 * its runs and mutants, a deployment phase by its smoke check and, when it has
 * one, its drill. The draft view carries a count for a coding or testing
 * phase whose task has an executable view (`ExecutableTaskView.sandboxBudget`),
 * and says whether a deployment phase with a runbook drills (`runbook.drill`),
 * so such a phase is priced here as publish prices it: 1, or 2 with a drill.
 * The editor claims a full pass, and draws publish's own version
 * refusal, only when every phase publish would price is priced here.
 * Otherwise it names the phases shown as what they are, and says publish
 * counts the rest.
 */
import type { DraftPhaseView } from '@learnsdlc/shared';
import { BUDGET_CEILING } from '@learnsdlc/shared';
import { Notice } from '@/components/ui';

/**
 * Whether the total of `priced` is the whole version's: every coding, testing
 * and deployment phase priced on the view.
 */
export function versionCountIsExact(phases: readonly DraftPhaseView[], priced: ReadonlySet<string>): boolean {
  return phases.every((phase) => {
    const kind = phase.checkKind ?? phase.artifactKind;
    if (kind === 'code' || kind === 'tests' || kind === 'config') return priced.has(phase.key);
    return true;
  });
}

/**
 * The microVMs one full pass boots in a deployment phase, as publish prices it
 * (`sandboxBudgetFor`: the smoke check, and the drill when the phase has one),
 * or null where the draft view does not say whether it drills (no task with a
 * runbook) or the phase is not a deployment one.
 */
export function configPhaseBudget(phase: DraftPhaseView): number | null {
  if ((phase.checkKind ?? phase.artifactKind) !== 'config') return null;
  const runbook = phase.tasks.find((task) => task.runbook)?.runbook;
  return runbook ? 1 + (runbook.drill ? 1 : 0) : null;
}

function microVMs(count: number): string {
  return count === 1 ? '1 microVM' : `${count} microVMs`;
}

/**
 * What publish counts besides the phases shown, named only
 * as far as the draft view knows it. A deployment phase graded as `config` has a
 * smoke check; the draft view says whether it drills only where a task holds a
 * runbook (`runbook.drill`). This sentence is drawn only when the version's
 * count is not exact, when the deployment phase may be one the view could not
 * price, so the drill is named only as possible. Without a config phase (a
 * written runbook, say) neither is named.
 */
function alsoCounted(phases: readonly DraftPhaseView[]): string {
  const config = phases.some((phase) => (phase.checkKind ?? phase.artifactKind) === 'config');
  return config
    ? 'Publish counts every phase again, including the deployment smoke check (and its drill, if it has one)'
    : 'Publish counts every phase again';
}

/** The phases shown, named as such: never "one full pass", never publish's version refusal. */
export function PartialVersionBudget({
  total,
  phases,
  testId,
}: {
  total: number;
  /** The draft's phases, to say what else publish counts. */
  phases: readonly DraftPhaseView[];
  testId: string;
}) {
  return (
    <>
      <p className="label-sm wrap tabular-nums" data-testid={`${testId}-note`}>
        {`The coding and testing phases shown here boot ${microVMs(total)} in all. ${alsoCounted(phases)}, and a version may boot at most ${BUDGET_CEILING.perVersion}.`}
      </p>
      {total > BUDGET_CEILING.perVersion && (
        <Notice tone="fail" role="status" testId={`${testId}-over`}>
          {/* The editor removes neither a run (draft.ts refuses it) nor a mutant (no sealed delete). */}
          {`The coding and testing phases shown here already boot ${microVMs(total)}, and a version may boot at most ${BUDGET_CEILING.perVersion}. Upload the project again with fewer runs or mutants.`}
        </Notice>
      )}
    </>
  );
}
