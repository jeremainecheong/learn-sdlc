"use client";

import { RUNBOOK_JSON, filledRunbookCounts, pluralWord, validateRunbookRecord, type DossierPhase } from "@learnsdlc/shared";
import { Chip } from "@/components/ui";
import { CodeBlock } from "../CodeBlock";
import { Fact, Nothing, longDate } from "../parts";

const counted = (n: number, one: string, many: string) => `${n} ${pluralWord(n, one, many)}`;

/**
 * The runbook's four list counts, read from the snapshot's record: filled
 * items only, as the floor counts them. Null for a snapshot that holds no
 * record (an older one, read through `OlderRunbookText`).
 */
function RunbookCounts({ phase }: { phase: DossierPhase | null }) {
  const text = phase?.files.find((file) => file.path === RUNBOOK_JSON)?.content;
  if (text === undefined) return null;
  const runbook = validateRunbookRecord(text).runbook;
  if (!runbook) return <p className="label-sm wrap" data-testid="dossier-runbook-counts">The runbook record is not valid.</p>;
  const n = filledRunbookCounts(runbook);
  return (
    <p className="label-sm wrap" data-testid="dossier-runbook-counts">
      {`The runbook: ${counted(n.environment, "environment entry", "environment entries")}, ${counted(n.health, "health check", "health checks")}, ${counted(n.rollback, "rollback step", "rollback steps")}, ${counted(n.data, "data entry", "data entries")}`}
    </p>
  );
}

/** An older snapshot's runbook: its markdown as it stood when the page came, the reader it has always had. */
function OlderRunbookText({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <CodeBlock
      path="RUNBOOK.md, as it stood when the page came"
      content={text}
      testId="dossier-runbook-before"
    />
  );
}

/** The fault, the two health checks and INCIDENT-1, the incident read from the record, and the runbook's counts. */
export function Drill({ phase }: { phase: DossierPhase | null }) {
  const drill = phase?.drill ?? null;
  const report = phase?.merged?.report?.drill ?? null;
  if (!drill) return <><Nothing what="The learner has not been paged yet." /><RunbookCounts phase={phase} /></>;
  return (
    <>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Fact
          label="Fault"
          value={<span className="mono">{drill.fault}</span>}
        />
        <Fact label="Paged at" value={longDate(drill.pagedAt) || "—"} />
        <Fact
          label="Health check before the fix"
          value={
            <Chip tone="fail">
              {report
                ? report.failedBeforeFix
                  ? "Failed, as it must"
                  : "Did not fail"
                : "Red"}
            </Chip>
          }
        />
        <Fact
          label="Health check after the fix"
          value={
            <Chip tone={drill.healthExit === 0 ? "pass" : "warn"}>
              {drill.healthExit == null
                ? "Not run"
                : drill.healthExit === 0
                  ? "Passed"
                  : `Exited ${drill.healthExit}`}
            </Chip>
          }
        />
      </dl>
      {drill.incident ? (
        <dl className="grid gap-2">
          <Fact label="Root cause" value={drill.incident.rootCause} />
          <Fact label="Fix" value={drill.incident.fix} />
          <Fact label="Action item" value={drill.incident.actionItem} />
        </dl>
      ) : (
        <Nothing what="INCIDENT-1 has not been written up yet." />
      )}
      <RunbookCounts phase={phase} />
      <OlderRunbookText text={drill.runbookBefore} />
    </>
  );
}
