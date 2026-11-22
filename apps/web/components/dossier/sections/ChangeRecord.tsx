"use client";

import { CHANGE_REQUEST_JSON, validateChangeRequestRecord, type DossierPhase, type LearnerDossier } from "@learnsdlc/shared";
import { Chip, StatusSquare, Table } from "@/components/ui";
import { buildLedger, CLAIM_WORD, VERDICT_STATE } from "@/components/workspace/panels/implementation/pr";
import { MARK_WORD, readScope, unreadLine } from "@/components/workspace/panels/maintenance/impact";
import { Fact, Nothing, fileOf, phaseVerdict } from "../parts";

const TEST_RESULT_WORD = { pass: "Passes", fail: "Fails", "not-run": "Not run" } as const;

/**
 * The change request as the snapshot kept it: the teacher's ticket, the
 * declared contract amendments, the tests and the release. Drawn only for a
 * Maintenance whose spec carries a ticket and whose snapshot holds the record;
 * an older snapshot shows the report facts alone.
 */
function ChangeRequestFacts({ phase }: { phase: DossierPhase | null }) {
  const ticket = phase?.changeTicket;
  const text = fileOf(phase, CHANGE_REQUEST_JSON);
  if (!ticket || !text.trim()) return null;
  const change = validateChangeRequestRecord(text, null).change;
  return (
    <div className="flex flex-col gap-3" data-testid="dossier-change-request">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Fact label="Ticket" value={`${ticket.id}: ${ticket.title}`} />
        <Fact
          label="Release version"
          value={change?.release.version || "Not written"}
        />
        <Fact
          label="Release summary"
          value={change ? change.release.summary || "Not written" : "The change request record could not be read."}
        />
      </dl>
      {change && change.contract.length > 0 && (
        <Table
          testId="dossier-change-amendments"
          cols={[
            { label: "Method", width: "90px", mono: true },
            { label: "Path", width: "minmax(0,1fr)", mono: true },
            { label: "Change", width: "100px" },
            { label: "Why", width: "minmax(0,2fr)" },
          ]}
          minWidth={560}
          rows={change.contract.map((c) => [
            c.method,
            c.path,
            c.change,
            <span key="w" className="wrap">
              {c.why}
            </span>,
          ])}
        />
      )}
      {change && change.tests.length > 0 && (
        <Table
          testId="dossier-change-tests"
          cols={[
            { label: "Suite", width: "minmax(0,1fr)", mono: true },
            { label: "Covers", width: "minmax(0,1fr)", mono: true },
            { label: "Marked as", width: "100px", align: "right" },
          ]}
          minWidth={480}
          rows={change.tests.map((t) => [
            t.suite,
            t.covers.join(", ") || "None",
            TEST_RESULT_WORD[t.result],
          ])}
        />
      )}
    </div>
  );
}

/** The contract ledger, the change impact and the release for 1.1.0, after the change request the snapshot kept. */
export function ChangeRecord({
  phase,
  release,
  audience,
}: {
  phase: DossierPhase | null;
  release: LearnerDossier["releases"][number] | null;
  audience: LearnerDossier["audience"];
}) {
  const report = phase?.merged?.report ?? null;
  const ledger = buildLedger(report?.contract ?? []);
  const impact = report?.impact ?? null;
  const tests = report?.tests ?? null;
  // The API marks "removed" every earlier function this review did not find again, and the Maintenance review reads
  // only the files the learner edits in the phase, so a read-only file's functions (on TaskTrackr, the 14 of
  // api/routes/tasks.py) would all read "Removed". The table reads the impact through the change request's
  // `readScope`: a function is listed removed only where this review read its
  // file; the files it did not read are named in one line under the table. `phase.files` is the merged revision's
  // editable files (`DossierPhase.files`), the dossier's copy of the room's editable paths. A revision whose snapshot
  // retention has pruned holds no files: then which files the learner edits is not known, and the line under the
  // table says only that this review did not read those functions again.
  const editable = (phase?.files ?? []).map((file) => file.path);
  const scope = readScope(
    impact ?? undefined,
    report?.staticAnalysis?.functions ?? [],
    editable,
  );
  const shownImpact = scope.impact ?? null;
  const unread = unreadLine(scope.unread, audience, "the table", editable.length > 0);
  if (!report) {
    return (
      <>
        <ChangeRequestFacts phase={phase} />
        <Nothing what="The change has not been graded yet." />
      </>
    );
  }
  return (
    <>
      <ChangeRequestFacts phase={phase} />
      {ledger.length > 0 && (
        <Table
          testId="dossier-ledger"
          cols={[
            { label: "Operation", width: "minmax(0,1fr)", mono: true },
            { label: "Claims", width: "minmax(0,2fr)" },
            { label: "Verdict", width: "130px", align: "right" },
          ]}
          minWidth={560}
          rows={ledger.map((group) => [
            group.name,
            <span key="c" className="wrap">
              {group.claims
                .map((c) => `${CLAIM_WORD[c.claim]}: ${c.text}`)
                .join("; ")}
            </span>,
            <span key="v" className="flex items-center justify-end gap-2">
              <StatusSquare state={VERDICT_STATE[group.verdict]} />
              {group.verdict === "kept"
                ? "Kept"
                : group.verdict === "broken"
                  ? "Broken"
                  : group.verdict === "contradicted"
                    ? "Contradicted"
                    : "Unclaimed"}
            </span>,
          ])}
        />
      )}
      {shownImpact && (
        <Table
          testId="dossier-impact"
          cols={[
            { label: "Function", width: "minmax(0,1fr)", mono: true },
            { label: "Where", width: "minmax(0,1fr)", mono: true, muted: true },
            { label: "Reached by", width: "110px", align: "right", mono: true },
            { label: "Change", width: "110px", align: "right" },
          ]}
          minWidth={560}
          rows={shownImpact.functions.map((fn) => [
            fn.name,
            `${fn.path}, line ${fn.line}`,
            fn.reachedBy.length,
            <Chip
              key="c"
              tone={fn.change === "unchanged" ? "neutral" : "accent"}
            >
              {MARK_WORD[fn.change]}
            </Chip>,
          ])}
        />
      )}
      {shownImpact && unread && (
        <p className="label-sm wrap" data-testid="dossier-impact-unread">
          {unread}
        </p>
      )}
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Fact
          label="Regression run"
          value={
            tests ? `${tests.passed} of ${tests.total} cases passed` : "Not run"
          }
        />
        <Fact label="Baseline" value={impact?.baseline ?? "Not recorded"} />
        <Fact
          label="Release"
          value={release ? release.version : "Not released"}
        />
        <Fact
          label="Shipped at"
          value={release && phase ? phaseVerdict(phase) : "Not released"}
        />
      </dl>
    </>
  );
}
