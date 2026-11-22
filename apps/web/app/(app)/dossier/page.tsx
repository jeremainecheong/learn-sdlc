"use client";

/**
 * A printable view of retained submissions and the learner's available activity.
 * Cursor history supplies every revision; source is fetched in batches of four.
 * A failed request blocks the print action and can be retried. A successful
 * null snapshot means unavailable source and never falls back to live drafts.
 */
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ExperiencePage } from "@/components/experience/shared";
import { KeptProjects } from "@/components/experience/KeptProjects";
import { ArrowLeft } from "lucide-react";
import { RetryNotice } from "@/components/shell/AppFrame";
import { Button, EmptyState, Kbd } from "@/components/ui";
import { Dossier } from "@/components/dossier/Dossier";
import { DOSSIER_PRINT_CSS, PrintStyle } from "@/components/dossier/print.css";
import { buildDossier, type SnapshotMap } from "@/components/dossier/build";
import { shortTitle } from "@/components/home/derive";
import { api, describeError } from "@/lib/api";
import { experienceApi } from "@/lib/api-experience";
import { shortcutWord } from "@/lib/keys";
import {
  cachedRecords,
  loadAllRecords,
  loadRecords,
  type PhaseRecords,
} from "@/lib/records";
import { useSession } from "@/lib/session";
import { useRecordProject } from "@/lib/record-project";

/**
 * `?project=<slug>` opens one of the learner's other projects (a platform
 * project set aside for their class's), read by name and read only
 * (`useRecordProject`). With no name, or a name that is not one of theirs,
 * this is the shell's current project.
 */
function DossierContent() {
  const { enrollment, details, slug, loading, revalidating, error, reload, kept, others } =
    useRecordProject();
  const user = useSession();

  const phases = enrollment?.phases;
  const phaseIds = useMemo(
    () => (enrollment ? enrollment.phases.map((p) => p.id) : []),
    [enrollment],
  );
  const [records, setRecords] = useState<Record<string, PhaseRecords>>(() =>
    cachedRecords(phaseIds),
  );
  const [snapshots, setSnapshots] = useState<SnapshotMap>({});
  const [reading, setReading] = useState(true);
  const [recordError, setRecordError] = useState("");
  const [readRevision, setReadRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!phaseIds.length) {
      setReading(false);
      return;
    }
    setReading(true);
    setRecordError("");
    void (async () => {
      const history = await experienceApi.history(slug);
      const submitted: Array<{
        phaseStateId: string;
        submission: Awaited<ReturnType<typeof api.getSubmissionWithFiles>>;
      }> = [];
      for (let offset = 0; offset < history.length && alive; offset += 4) {
        submitted.push(
          ...(await Promise.all(
            history.slice(offset, offset + 4).map(async (row) => ({
              phaseStateId: row.phaseStateId,
              submission: {
                ...(await api.getSubmissionWithFiles(row.id)),
                verifiedPass: row.verifiedPass,
                attempt: row.attempt,
              },
            })),
          )),
        );
      }
      if (!alive) return;
      await loadAllRecords(slug);
      const next: Record<string, PhaseRecords> = {};
      for (const id of phaseIds) {
        // Locked phases have no accessible project activity. Their run and
        // submission routes correctly reject reads; optional lesson threads
        // are separate and do not belong in this project export.
        if (phases?.find((phase) => phase.id === id)?.status === "locked") {
          next[id] = {
            submissions: submitted
              .filter((row) => row.phaseStateId === id)
              .map((row) => row.submission),
            runs: [],
            chat: [],
          };
          continue;
        }
        const got = await loadRecords(id);
        if (!alive) return;
        if (got.partial)
          throw new Error(
            "Some activity records could not be read. Retry before printing.",
          );
        next[id] = {
          ...got.records,
          submissions: submitted
            .filter((row) => row.phaseStateId === id)
            .map((row) => row.submission),
        };
      }
      setRecords(next);
      setSnapshots(
        Object.fromEntries(
          submitted.map(({ submission }) => [
            submission.id,
            submission.workspaceSnapshot ?? null,
          ]),
        ),
      );
    })()
      .catch((err) => {
        if (alive)
          setRecordError(
            describeError(
              err,
              "The document could not be prepared. Please retry.",
            ),
          );
      })
      .finally(() => {
        if (alive) setReading(false);
      });
    return () => {
      alive = false;
    };
  }, [phaseIds, phases, slug, readRevision]);

  const waiting =
    loading || reading ? "Still reading your records and submitted files" : "";
  const printed = details;

  const dossier = useMemo(
    () =>
      enrollment
        ? buildDossier(enrollment, printed, records, snapshots, user)
        : null,
    [enrollment, printed, records, snapshots, user],
  );

  const [printKey, setPrintKey] = useState("⌘P");
  useEffect(() => setPrintKey(shortcutWord("P")), []);
  const print = useCallback(() => window.print(), []);

  const project = enrollment ? shortTitle(enrollment.projectTitle) : "";
  const keptName = kept ? shortTitle(kept.title) : "";

  return (
    <ExperiencePage
      title="Printable project evidence"
      eyebrow="Your portfolio, ready to keep"
      variant="dossier"
      active="artefacts"
      actions={
        <Link href="/artefacts" className="exp-button">
          <ArrowLeft size={15} />
          Your portfolio
        </Link>
      }
    >
      <PrintStyle css={DOSSIER_PRINT_CSS} />
      <div data-testid="dossier-page" className="exp-stack">
        <section className="exp-panel print-hide">
          <div className="exp-section-heading">
            <div>
              <span className="exp-eyebrow">{project || "Your project"}</span>
              <h2 data-testid="dossier-title">A record you can keep</h2>
            </div>
            <Button
              variant="secondary"
              onClick={print}
              disabled={Boolean(waiting || recordError || error) || !dossier}
              testId="dossier-print"
            >
              Print or save as PDF <Kbd>{printKey}</Kbd>
            </Button>
          </div>
          <p className="purpose max-w-[80ch]">
            A printable view of retained submissions for{" "}
            {project || "this project"}, with review reports, release notes and
            your available activity journal. File listings show the merged or
            latest submitted revision, and exclude newer drafts. Your own mentor
            questions may appear in the journal. Choose Save as PDF in the
            browser’s print dialog to create a PDF; its filename and destination
            are chosen there.
          </p>
          {kept && (
            <p className="exp-caption" data-testid="kept-project-notice">
              {keptName} is kept in your record: this is its evidence, to read
              and print. Your dashboard opens the project you are on now.{" "}
              <Link className="exp-text-link" href="/dossier">
                Your current project&rsquo;s evidence
              </Link>
            </p>
          )}
          {waiting && (
            <p className="label" role="status" data-testid="dossier-waiting">
              {waiting}, so printing is not ready yet.
            </p>
          )}
          {recordError && (
            <RetryNotice
              message={recordError}
              onRetry={() => setReadRevision((value) => value + 1)}
              busy={reading}
            />
          )}
        </section>

        {error && (
          <RetryNotice
            message={error}
            onRetry={() => void reload()}
            busy={revalidating}
          />
        )}

        {loading && !dossier ? (
          <div className="flex flex-col gap-4" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-40 w-full" />
            ))}
          </div>
        ) : !enrollment && error ? null : !enrollment && others.length && !kept ? (
          // Not started on the project their class works, but not a learner
          // with nothing either: the work kept in
          // their record is listed just below.
          <EmptyState
            icon="doc"
            title="Nothing submitted on this project yet"
            body="Start it from your dashboard. The work you did on your other projects stays in your record, and its evidence is below."
            action={
              <Link href="/dashboard" className="btn-secondary btn-sm">
                Go to dashboard
              </Link>
            }
            testId="dossier-empty"
          />
        ) : !enrollment ? (
          <EmptyState
            icon="doc"
            title="No project started"
            body="Start your project to collect your submitted evidence, phase by phase."
            action={
              <Link href="/dashboard" className="btn-secondary btn-sm">
                Go to dashboard
              </Link>
            }
            testId="dossier-empty"
          />
        ) : (
          dossier && <Dossier dossier={dossier} />
        )}
        <KeptProjects projects={others} viewing={kept?.slug} />
      </div>
    </ExperiencePage>
  );
}

/** `useSearchParams` reads the query in the browser, so the page renders it inside a boundary. */
export default function DossierPage() {
  return (
    <Suspense fallback={null}>
      <DossierContent />
    </Suspense>
  );
}
