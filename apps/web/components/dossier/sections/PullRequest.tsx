"use client";

import type { DossierPhase } from "@learnsdlc/shared";
import { Chip, Table } from "@/components/ui";
import { buildRevisions, checksSummary } from "@/components/workspace/panels/implementation/pr";
import { carriedThreads, prThreads, type PrThread } from "@/components/pr/threads";
import { NOT_MEASURED_REASON, NOT_MEASURED_WORD, analysisNotMeasured } from "@/components/pr/analysisReach";

/** One phase's revision log, review threads, checks and merge message. */
export function PullRequest({ phase, merged }: { phase: DossierPhase; merged: boolean }) {
  const revisions = buildRevisions(
    phase.revisions,
    phase.revisions.find((row) => row.report?.passThreshold)?.report
      ?.passThreshold ?? 0,
  );
  const graded = revisions.filter((r) => r.report);
  const head = graded[graded.length - 1] ?? null;
  const previous = graded[graded.length - 2] ?? null;
  const later = head ? revisions.filter((r) => r.attempt > head.attempt) : [];
  const open = prThreads(phase.key, head, later);
  const keys = new Set(open.map((t) => t.key));
  const threads: PrThread[] = [
    ...open,
    ...carriedThreads(phase.key, previous, head).filter(
      (t) => !keys.has(t.key),
    ),
  ];
  const checks = phase.merged?.report?.checks ?? [];

  return (
    <div
      className="flex flex-col gap-4"
      data-testid={`dossier-pr-${phase.order}`}
    >
      <h3 className="h3">{phase.title}</h3>
      <Table
        testId={`dossier-revisions-${phase.order}`}
        rowTestId={(i) =>
          `dossier-revision-${phase.order}-${revisions[i]?.attempt ?? i + 1}`
        }
        cols={[
          { label: "Revision", width: "80px", mono: true },
          { label: "Message", width: "minmax(0,1.6fr)" },
          { label: "What ran", width: "minmax(0,1.4fr)", muted: true },
          { label: "Result", width: "minmax(0,150px)", align: "right" },
        ]}
        minWidth={620}
        rows={revisions.map((r) => [
          `#${r.attempt}`,
          <span key="m" className="wrap">
            {r.message || "No message"}
          </span>,
          r.report ? checksSummary(r.report) : r.detail,
          <Chip
            key="r"
            tone={
              r.state === "pass"
                ? "pass"
                : r.state === "fail"
                  ? "fail"
                  : "neutral"
            }
          >
            {r.result}
          </Chip>,
        ])}
      />

      {threads.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="label">Review</p>
          {threads.map((t) => (
            <div
              key={t.key}
              className="flex flex-col gap-0.5 border-l-1.5 border-edge2 pl-3"
            >
              <p className="flex flex-wrap items-baseline gap-2 text-[13px]">
                <span className="font-semibold text-ink">{t.who}</span>
                <span className="mono text-[12px] text-muted">
                  {t.path}, line {t.line}
                </span>
                <Chip tone={t.state === "resolved" ? "pass" : "warn"}>
                  {t.state === "resolved"
                    ? `Closed in revision ${t.resolvedIn}`
                    : "Open"}
                </Chip>
              </p>
              <p className="wrap text-[13px] text-ink2">{t.message}</p>
              {t.ask && <p className="wrap text-[13px] text-ink2">{t.ask}</p>}
            </div>
          ))}
        </div>
      )}

      {checks.length > 0 && (
        <Table
          testId={`dossier-checks-${phase.order}`}
          cols={[
            { label: "Check", width: "minmax(0,1fr)" },
            { label: "Detail", width: "minmax(0,1.6fr)", muted: true },
            { label: "Verdict", width: "110px", align: "right" },
          ]}
          minWidth={520}
          rows={checks.map((c) =>
            // An analysis that read no file is not a pass of anything: the row says so, as the IDE does.
            c.id === "static-analysis" && analysisNotMeasured(phase.merged?.report?.staticAnalysis)
              ? [c.label, NOT_MEASURED_REASON, <Chip key="v">{NOT_MEASURED_WORD}</Chip>]
              : [
                c.label,
                c.detail || "—",
                <Chip
                  key="v"
                  tone={
                    c.status === "passed"
                      ? "pass"
                      : c.status === "failed"
                        ? "fail"
                        : "warn"
                  }
                >
                  {c.status === "passed"
                    ? "Passed"
                    : c.status === "failed"
                      ? "Failed"
                      : "Warning"}
                </Chip>,
              ])}
        />
      )}

      <div className="flex flex-col gap-1">
        <p className="label">Merge message</p>
        <p className="wrap text-[13.5px] leading-relaxed text-ink2" data-testid={`dossier-merge-message-${phase.order}`}>
          {/* A phase merged with the note left empty has a release and no
              message: it is merged, so "Not merged yet." would be false.
              Completing the project merges the last phase. */}
          {phase.mergeMessage || (merged ? "No merge message was recorded for this phase." : "Not merged yet.")}
        </p>
      </div>
    </div>
  );
}
