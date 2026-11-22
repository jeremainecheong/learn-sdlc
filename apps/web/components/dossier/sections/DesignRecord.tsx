"use client";

import { API_CONTRACT_JSON, DESIGN_JSON, SCREEN_CONTRACT_JSON, apiEndpoints, decidedOn, readDesignRecord, screenRows, type DossierPhase } from "@learnsdlc/shared";
import { Table } from "@/components/ui";
import { Fact, Nothing, fileOf, text } from "../parts";
import { Contradictions } from "./Contradictions";

/** A list of text, or a dash for none. */
const listOr = (items: string[] | undefined, dash = "—"): string =>
  (items ?? []).map((i) => i.trim()).filter(Boolean).join(", ") || dash;

const texts = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : [];

/**
 * The design as it was submitted: the record (the model, the operations, the
 * decisions) and the contracts the snapshot holds, read-only. An older
 * board's record is shown folded, as the room reads it; a snapshot that holds
 * only the older markdown shows no record (the prose is not shown).
 */
export function DesignRecord({
  phase,
  requirements,
}: {
  phase: DossierPhase | null;
  /** The requirements phase as it was merged, for the learner's own story record. */
  requirements: DossierPhase | null;
}) {
  const read = readDesignRecord(fileOf(phase, DESIGN_JSON));
  if (!read.design) {
    return (
      <Nothing
        what={
          read.error
            ? `The design record could not be read: ${read.error}.`
            : "This submission holds no design record."
        }
      />
    );
  }
  const doc = read.design;
  // a contract's table follows the teacher's switch; an older payload without the switches reads the files
  const on = phase?.designContracts ?? { api: true, screens: true };
  const endpoints = on.api ? apiEndpoints(fileOf(phase, API_CONTRACT_JSON) || undefined) : [];
  const screens = on.screens ? screenRows(fileOf(phase, SCREEN_CONTRACT_JSON) || undefined) : [];
  return (
    <>
      {read.folded && (
        <p className="label">Kept in the design board&apos;s older shape, and shown here as the room reads it.</p>
      )}
      {doc.entities.length > 0 && (
        <Table
          testId="dossier-model"
          cols={[
            { label: "Entity", width: "minmax(0,1fr)", mono: true },
            { label: "Kind", width: "100px" },
            { label: "Attributes", width: "minmax(0,1.6fr)", mono: true },
            { label: "For", width: "110px", muted: true },
          ]}
          minWidth={600}
          rows={doc.entities.map((e) => [
            e.name || e.id,
            e.kind,
            e.attributes.map((a) => (a.type ? `${a.name}: ${a.type}` : a.name)).filter(Boolean).join(", ") || "—",
            listOr(e.satisfies),
          ])}
        />
      )}
      {doc.operations.map((op) => (
        <div key={op.id} className="flex flex-col gap-1">
          <p className="mono text-[13px] font-semibold text-ink">{op.name || op.id}</p>
          <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            <Fact label="Satisfies" value={listOr(op.satisfies)} />
            <Fact label="Inputs" value={listOr(op.inputs)} />
            <Fact label="Returns" value={op.returns || "—"} />
            <Fact label="Errors" value={listOr(op.errors)} />
            {op.note && <Fact label="Note" value={op.note} />}
          </dl>
        </div>
      ))}
      {/* The decision record in full, for both audiences, with no extra API
          call: this section already reads the record for the instructor's copy. */}
      {doc.decisions.map((d) => {
        const when = decidedOn(d.decidedAt);
        const consequences = (d.consequences ?? []).filter((c) => c.trim());
        return (
          <div
            key={d.id}
            className="flex flex-col gap-1"
            data-testid={`dossier-adr-${d.id}`}
          >
            <p className="h3">
              {d.id}: {d.title || d.choice || "No choice recorded"}
            </p>
            <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              <Fact
                label="Status"
                value={`${d.status}${when ? `, ${when}` : ""}${
                  d.supersededBy ? `, superseded by ${d.supersededBy}` : ""
                }`}
              />
              <Fact label="Serves" value={listOr(d.satisfies)} />
              <Fact label="Choice" value={d.choice || "—"} />
              <Fact label="Context" value={d.context || "—"} />
              <Fact label="Instead of" value={d.alternative || "—"} />
              <Fact label="Because" value={d.rationale || "—"} />
              <Fact label="Costs" value={d.tradeOff || "—"} />
            </dl>
            {consequences.length > 0 && (
              <ul className="ml-4 list-disc text-[13px] text-ink2">
                {consequences.map((c, i) => (
                  <li key={i} className="wrap">
                    {c}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {endpoints.length > 0 && (
        <Table
          testId="dossier-api"
          cols={[
            { label: "Endpoint", width: "minmax(0,1fr)", mono: true },
            { label: "Route", width: "minmax(0,1.2fr)", mono: true },
            { label: "Errors", width: "minmax(0,1fr)", mono: true, muted: true },
          ]}
          minWidth={600}
          rows={endpoints.map((e) => [
            text(e.id) || "—",
            [text(e.method), text(e.path)].filter(Boolean).join(" ") || "—",
            listOr(texts(e.errors)),
          ])}
        />
      )}
      {screens.length > 0 && (
        <Table
          testId="dossier-screens"
          cols={[
            { label: "Screen", width: "minmax(0,1fr)", mono: true },
            { label: "Component", width: "minmax(0,1fr)", mono: true },
            { label: "When there is nothing to show", width: "minmax(0,1.6fr)", muted: true },
          ]}
          minWidth={600}
          rows={screens.map((r) => [text(r.route) || "—", text(r.component) || "—", text(r.empty) || "—"])}
        />
      )}
      <Contradictions design={doc} stories={phase?.designStories ?? []} requirements={requirements} />
    </>
  );
}
