"use client";

/**
 * An instructor reads one learner's whole project, and prints it.
 *
 * One fetch, then the same document component the learner's own page renders.
 * The server returns submitted evidence only. Private drafts and mentor
 * conversations are excluded, and no client toggle can include them.
 *
 * Opening this page writes a `dossier.read` row naming who read whose project.
 * That is deliberate and it is why the console links to a page rather than
 * quietly fetching the document behind a menu.
 */
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { teacherReturnHref } from "@/lib/navigation";
import type { LearnerDossier } from "@learnsdlc/shared";
import { ExperiencePage, LoadingState } from "@/components/experience/shared";
import { ArrowLeft } from "lucide-react";
import { RetryNotice } from "@/components/shell/AppFrame";
import { Button, EmptyState, Kbd } from "@/components/ui";
import { Dossier } from "@/components/dossier/Dossier";
import { DOSSIER_PRINT_CSS, PrintStyle } from "@/components/dossier/print.css";
import { describeError } from "@/lib/api";
import { instructorApi } from "@/lib/api-instructor";
import { getConsoleProject, ALL_PROJECTS } from "@/lib/api-instructor";
import { shortcutWord } from "@/lib/keys";

function InstructorDossierContent() {
  const params = useParams<{ userId: string }>();
  const userId = params?.userId ?? "";
  const query = useSearchParams();
  const returnHref = teacherReturnHref(query.get("returnTo"), userId);
  const [dossier, setDossier] = useState<LearnerDossier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloads, setReloads] = useState(0);

  // The project the link names: the one the roster was showing.
  // Without it, the console's chosen project, unless the console is looking at
  // all of them. In that case the API picks the learner's oldest enrolment, and
  // for a learner whose class works on another project that is the one set
  // aside for it.
  const named = query.get("project") ?? "";
  const project = useMemo(() => {
    if (named) return named;
    const chosen = getConsoleProject();
    return chosen && chosen !== ALL_PROJECTS ? chosen : undefined;
  }, [named]);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    setLoading(true);
    setError("");
    instructorApi
      .learnerDossier(userId, project)
      .then((got) => {
        if (live) setDossier(got);
      })
      .catch((err) => {
        if (live)
          setError(describeError(err, "The dossier could not be read."));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [userId, project, reloads]);

  const [printKey, setPrintKey] = useState("⌘P");
  useEffect(() => setPrintKey(shortcutWord("P")), []);
  const print = useCallback(() => window.print(), []);

  return (
    <ExperiencePage
      title="Submitted project evidence"
      eyebrow="A learner’s retained record"
      variant="dossier"
      active="class"
      actions={
        <Link
          href={returnHref}
          className="exp-button"
          data-testid="back-to-learner"
        >
          <ArrowLeft size={15} />
          Back to the learner
        </Link>
      }
    >
      <PrintStyle css={DOSSIER_PRINT_CSS} />
      <div data-testid="instructor-dossier-page" className="exp-stack">
        <section className="exp-panel print-hide">
          <header className="exp-section-heading">
            <h2 data-testid="instructor-dossier-title">
              A record of submitted work
            </h2>
            <Button
              variant="secondary"
              onClick={print}
              disabled={loading || Boolean(error) || !dossier}
              testId="dossier-print"
            >
              Print or save as PDF <Kbd>{printKey}</Kbd>
            </Button>
          </header>
          <p className="purpose max-w-[80ch]">
            {dossier
              ? `${dossier.displayName}'s submitted project evidence and retained review history. Private drafts and mentor conversations are excluded. Reading this is recorded.`
              : "One learner’s submitted project evidence and review history."}
          </p>
          {loading && (
            <p className="label" role="status" data-testid="dossier-waiting">
              Reading the record, so printing is not ready yet.
            </p>
          )}
        </section>

        {error && (
          <RetryNotice
            message={error}
            onRetry={() => setReloads((n) => n + 1)}
            busy={loading}
          />
        )}

        {loading && !dossier ? (
          <div className="flex flex-col gap-4" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-40 w-full" />
            ))}
          </div>
        ) : dossier ? (
          <Dossier dossier={dossier} />
        ) : !error ? (
          <EmptyState
            icon="doc"
            title="Nothing to print"
            body="This learner has not started a project yet, so there is no record to make."
            action={
              <Link
                href={returnHref}
                className="btn-secondary btn-sm"
              >
                Back to the learner
              </Link>
            }
            testId="dossier-empty"
          />
        ) : null}
      </div>
    </ExperiencePage>
  );
}

export default function InstructorDossierPage() {
  return <Suspense fallback={<LoadingState />}><InstructorDossierContent /></Suspense>;
}
