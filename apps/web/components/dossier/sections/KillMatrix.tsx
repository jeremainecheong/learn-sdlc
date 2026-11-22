"use client";

import { Fragment } from "react";
import { pluralWord, type DossierPhase } from "@learnsdlc/shared";
import { Chip, Table } from "@/components/ui";
import { clockPhrase, matrixView, parseTests } from "@/components/workspace/panels/testing/lib";
import { Nothing } from "../parts";

/**
 * A test's name with a line-break opportunity after each underscore, dot and
 * slash (`<wbr>`, no text of its own), so the narrow "Caught by" and "Case"
 * columns break a long name between its words, never mid-word
 * ("..._done_stat" over "e,").
 */
function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[_./])/);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/** "7 of 8 planted bugs were caught"; one planted bug reads singular. */
export function caughtLine(killed: number, total: number): string {
  return `${killed} of ${total} planted ${pluralWord(total, "bug was", "bugs were")} caught`;
}

/** The planted bugs against the learner's cases, and the clock they ran at. */
export function KillMatrix({ phase }: { phase: DossierPhase | null }) {
  if (!phase) return null;
  const report =
    phase.merged?.report ??
    phase.revisions[phase.revisions.length - 1]?.report ??
    null;
  const matrix = report?.mutation?.matrix ?? [];
  // `testFiles` reads one field, and every file the dossier carries is an
  // editable one by construction, so the phase's files are the test files in
  // the order the phase declares them.
  const tests = phase.files
    .filter(
      (f) =>
        /(^|\/)tests?\//.test(f.path) ||
        /test/i.test(f.path.split("/").pop() ?? ""),
    )
    .flatMap((f) => parseTests(f.path, f.content));
  const view = matrixView(matrix, tests);
  const clock = report?.runClock ?? null;

  if (matrix.length === 0) {
    return (
      <Nothing what="No graded suite has run against the planted bugs yet." />
    );
  }
  return (
    <>
      <p className="text-[13.5px] text-ink2" data-testid="dossier-clock">
        {caughtLine(view.killed, view.total)}, run at{" "}
        {clockPhrase(clock)}.
      </p>
      <Table
        testId="dossier-matrix"
        cols={[
          { label: "Bug", width: "70px", mono: true },
          { label: "What it changed", width: "minmax(0,1.6fr)" },
          { label: "Covers", width: "110px", mono: true, muted: true },
          { label: "Caught by", width: "minmax(0,1.2fr)", mono: true },
          { label: "Verdict", width: "110px", align: "right" },
        ]}
        minWidth={640}
        rows={view.rows.map((r) => [
          r.id,
          <span key="d" className="wrap">
            {r.row.description || r.row.mutant}
          </span>,
          r.row.covers || "—",
          r.killers.length ? (
            <span key="k">
              {r.killers.map((name, i) => (
                <Fragment key={`${i}-${name}`}>
                  {i > 0 && ", "}
                  <Breakable text={name} />
                </Fragment>
              ))}
            </span>
          ) : (
            "—"
          ),
          <Chip key="v" tone={r.row.killed ? "pass" : "fail"}>
            {r.row.killed ? "Killed" : "Survived"}
          </Chip>,
        ])}
      />
      {view.columns.length > 0 && (
        <Table
          testId="dossier-cases"
          cols={[
            { label: "Case", width: "minmax(0,1fr)", mono: true },
            { label: "Kills", width: "minmax(0,1fr)", mono: true, muted: true },
            { label: "Verdict", width: "150px", align: "right" },
          ]}
          minWidth={520}
          rows={view.columns.map((c) => [
            <Breakable key="n" text={c.name} />,
            c.kills.join(", ") || "—",
            <Chip
              key="v"
              tone={c.verdict === "kills-nothing" ? "neutral" : "pass"}
            >
              {c.verdict === "kills-nothing"
                ? "No bug behind it"
                : c.verdict === "load-bearing"
                  ? "Load bearing"
                  : c.verdict === "twin"
                    ? `Same as ${c.twinOf}`
                    : "Kills"}
            </Chip>,
          ])}
        />
      )}
    </>
  );
}
