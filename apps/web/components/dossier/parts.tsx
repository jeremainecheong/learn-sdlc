"use client";

/**
 * The lookups and small parts the printed record and its sections share: a
 * phase's file, a long date, a phase's verdict, an empty line, a fact.
 */
import type { DossierPhase } from "@learnsdlc/shared";
import { DISPLAY_LOCALE } from "@/lib/locale";

export const fileOf = (phase: DossierPhase | null, path: string): string =>
  phase?.files.find((f) => f.path === path)?.content ?? "";

export const longDate = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(DISPLAY_LOCALE, {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
};

/** Historical records retain their original label; current reviews are binary. */
export const phaseVerdict = (phase: DossierPhase): string => {
  const revision = phase.merged ?? phase.revisions[phase.revisions.length - 1];
  if (!revision) return "Not submitted";
  if (!revision.report)
    return revision.status === "failed" ? "Review failed" : "In review";
  const verdict = revision.report.passed ? "Pass" : "Needs revision";
  return revision.report.assessmentMode === "strict_binary"
    ? verdict
    : `Historical ${verdict}`;
};

export function Nothing({ what }: { what: string }) {
  return <p className="label">{what}</p>;
}

export function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="label-sm">{label}</dt>
      <dd className="m-0 text-[13.5px] text-ink">{value}</dd>
    </div>
  );
}

export const text = (v: unknown): string => (typeof v === "string" ? v : "");
