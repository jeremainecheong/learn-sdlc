"use client";

import type { DossierPhase } from "@learnsdlc/shared";
import { Chip, Table } from "@/components/ui";
import { STORY_JSON } from "@/components/workspace/panels/requirements/story";
import { criterionState, CRITERION_WORD, readStoryRecord } from "@/components/workspace/panels/requirements/useStory";
import { Nothing, fileOf } from "../parts";

/** The acceptance criteria, with the verdict the requirements panel gives them. */
export function Criteria({ phase }: { phase: DossierPhase | null }) {
  const story = readStoryRecord(fileOf(phase, STORY_JSON));
  if (story.criteria.length === 0)
    return <Nothing what="No acceptance criteria are recorded." />;
  return (
    <Table
      testId="dossier-criteria"
      cols={[
        { label: "Criterion", width: "90px", mono: true },
        { label: "Given, when, then", width: "minmax(0,3fr)" },
        { label: "Kind", width: "110px", muted: true },
        { label: "Verdict", width: "120px", align: "right" },
      ]}
      minWidth={560}
      rows={story.criteria.map((c) => {
        const state = criterionState(c);
        return [
          c.id,
          <span key="t" className="wrap">
            Given {c.given || "…"}, when {c.when || "…"}, then {c.then || "…"}
          </span>,
          c.tag === "happy"
            ? "Happy path"
            : c.tag === "boundary"
              ? "Boundary"
              : "Error",
          <Chip
            key="v"
            tone={
              state === "runnable"
                ? "pass"
                : state === "weak"
                  ? "warn"
                  : "neutral"
            }
          >
            {CRITERION_WORD[state]}
          </Chip>,
        ];
      })}
    />
  );
}
