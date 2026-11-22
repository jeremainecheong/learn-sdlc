"use client";

import type { Design, DesignStory, DossierPhase } from "@learnsdlc/shared";
import { STORY_JSON } from "@/components/workspace/panels/requirements/story";
import { contractWarnings, storyFacts } from "@/components/workspace/panels/design/contradictions";
import { Nothing, fileOf } from "../parts";

/**
 * What the contract said against what the stories said, at the revision the
 * phase was merged on. The same engine the editor runs, over the stories the
 * Design phase lists and the learner's own story record as it was merged, so
 * the record and the room cannot disagree.
 */
export function Contradictions({
  design,
  stories,
  requirements,
}: {
  design: Design;
  stories: DesignStory[];
  requirements: DossierPhase | null;
}) {
  const own = fileOf(requirements, STORY_JSON);
  const facts = storyFacts(stories, own || undefined);
  const warnings = contractWarnings({ design, facts });
  return (
    <div className="flex flex-col gap-1.5" data-testid="dossier-contradictions">
      <p className="label">Contradictions at merge</p>
      {warnings.length === 0 ? (
        <Nothing
          what={
            facts.length === 0
              ? "The stories of this project were not kept, so the contract was only read against itself."
              : "No contradiction was found between the contract and the stories."
          }
        />
      ) : (
        <ul className="ml-4 list-disc text-[13px] text-ink2">
          {warnings.map((w) => (
            <li key={w.id} className="wrap">
              {w.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
