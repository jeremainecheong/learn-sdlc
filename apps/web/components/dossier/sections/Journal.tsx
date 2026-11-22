"use client";

import type { DossierJournalRow, LearnerDossier } from "@learnsdlc/shared";
import { Chip, Table } from "@/components/ui";
import { PHASE_META } from "@/lib/phase";
import { clockTime, dayLabel } from "@/components/journal/derive";
import { Nothing } from "../parts";

/** The timeline, grouped by the day each thing happened on. */
export function Journal({
  rows,
  audience,
}: {
  rows: DossierJournalRow[];
  audience: LearnerDossier["audience"];
}) {
  if (rows.length === 0)
    return <Nothing what="Nothing has been recorded yet." />;
  const days: { key: string; label: string; rows: DossierJournalRow[] }[] = [];
  for (const row of rows) {
    const at = new Date(row.at);
    const key = Number.isNaN(at.getTime())
      ? "undated"
      : String(
          new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime(),
        );
    const last = days[days.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else days.push({ key, label: dayLabel(row.at), rows: [row] });
  }
  return (
    <>
      {audience === "instructor" && (
        <p className="label">
          Mentor exchanges are counted here, never quoted. The learner&rsquo;s
          own copy carries their questions.
        </p>
      )}
      {days.map((day) => (
        <div key={day.key} className="flex flex-col gap-2">
          <p className="label">{day.label}</p>
          <Table
            testId={`dossier-day-${day.key}`}
            cols={[
              { label: "Time", width: "64px", mono: true, muted: true },
              { label: "Phase", width: "120px", muted: true },
              { label: "What happened", width: "minmax(0,2fr)" },
              { label: "Result", width: "minmax(0,150px)", align: "right" },
            ]}
            minWidth={600}
            rows={day.rows.map((row) => [
              clockTime(row.at),
              PHASE_META[row.phaseKey]?.short ?? row.phaseKey,
              <span key="w" className="wrap flex flex-col gap-0.5">
                <span className="font-medium text-ink">{row.title}</span>
                {row.detail && <span className="text-muted">{row.detail}</span>}
              </span>,
              row.result ? <Chip key="r">{row.result}</Chip> : "",
            ])}
          />
        </div>
      ))}
    </>
  );
}
