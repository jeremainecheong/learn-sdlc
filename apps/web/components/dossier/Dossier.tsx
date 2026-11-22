"use client";
import { isLastPhase, placeOf, pluralWord, type DossierPhase, type LearnerDossier, type PhaseKey } from "@learnsdlc/shared";
import { Chip, Section, StatusSquare, Stat, Table } from "@/components/ui";
import { usePresentationView } from "@/components/experience/presentation-view";
import { CodeBlock } from "./CodeBlock";
import { statusState, type StatusState } from "@/lib/phase";
import { STORY_JSON } from "@/components/workspace/panels/requirements/story";
import { readStoryRecord } from "@/components/workspace/panels/requirements/useStory";
import { StoryCard } from "@/components/workspace/panels/requirements/StoryCard";
import { COMPLETION_CHIP, closesLine, creditedWithoutReview, dossierCompletion, finishedWhen, reviewedPasses } from "./completion";
import { STATE_LABEL } from "@/components/workspace/gate-state";
import { creditLabel, creditState, revisionPassIsCurrent } from "@/lib/pass-kind";
import { Fact, Nothing, fileOf, longDate, phaseVerdict } from "./parts";
import { Criteria } from "./sections/Criteria";
import { DesignRecord } from "./sections/DesignRecord";
import { PullRequest } from "./sections/PullRequest";
import { KillMatrix } from "./sections/KillMatrix";
import { Drill } from "./sections/Drill";
import { ChangeRecord } from "./sections/ChangeRecord";
import { Journal } from "./sections/Journal";
export { caughtLine } from "./sections/KillMatrix";

/* --------------------------------- lookups -------------------------------- */

const phaseOf = (d: LearnerDossier, key: PhaseKey): DossierPhase | null =>
  d.phases.find((p) => p.key === key) ?? null;

/**
 * The verdict on a phase a teacher credited with no reviewed pass behind it.
 * Its last revision may have passed a review before a reset withdrew it, so a
 * bare "Pass" there would read as the reviewed pass the phase does not hold:
 * it reads "Earlier Pass / review required". A pass that still counts (a task
 * the board does not name as still wanted, as on a split phase where one task
 * is reviewed and another only credited, or one waiting only on the
 * countersignature) keeps its own word, "Pass".
 */
const creditVerdict = (phase: DossierPhase): string => {
  const verdict = phaseVerdict(phase);
  if (verdict !== "Pass") return verdict;
  const shown = phase.merged ?? phase.revisions[phase.revisions.length - 1];
  return revisionPassIsCurrent(phase, shown?.taskKey) ? verdict : "Earlier Pass / review required";
};

/**
 * What a credited phase's missing review or countersignature opens, for the
 * phases counted: the next phase; on the project's last phase alone, the way
 * to complete the project; with the last phase among several, both.
 */
const onwardOn = (lastAmong: boolean, count: number): string =>
  !lastAmong
    ? "the next phase opens"
    : count <= 1
      ? "the project can be completed"
      : "the next phase opens, or on the last phase the project can be completed,";

/** "1 phase", "2 phases". */
const phasesWord = (count: number): string => `${count} ${pluralWord(count, "phase")}`;

/**
 * "Opens in phase 5": the product's own sentence for a phase not yet reached,
 * numbered by the phase's place in its own project. A phase the project does
 * not hold has no section at all, so this is never said of one.
 */
function Locked({ place }: { place: number }) {
  return <p className="label">Opens in phase {place}.</p>;
}

/** A phase that is neither locked nor written yet still prints its heading. */
function PhaseBody({
  phase,
  place,
  empty,
  children,
}: {
  phase: DossierPhase;
  place: number;
  empty: string;
  children: React.ReactNode;
}) {
  if (phase.status === "locked") return <Locked place={place} />;
  if (phase.files.length === 0 && phase.revisions.length === 0)
    return <Nothing what={empty} />;
  return <>{children}</>;
}

/* ------------------------------- the document ----------------------------- */

export function Dossier({
  dossier,
  testId = "dossier",
}: {
  dossier: LearnerDossier;
  testId?: string;
}) {
  const requirements = phaseOf(dossier, "requirements");
  const design = phaseOf(dossier, "design");
  const testing = phaseOf(dossier, "testing");
  const deployment = phaseOf(dossier, "deployment");
  const maintenance = phaseOf(dossier, "maintenance");
  // A phase's number is its place in its own project, and the document
  // prints a phase's section only when the project holds the phase. Each
  // section keeps its own test id, so a section the project
  // does not hold is simply absent.
  const place = (phase: DossierPhase) => placeOf(dossier, phase.key);
  const holdsCode = dossier.phases.some((p) => p.key === "implementation" || p.key === "maintenance");
  // Implementation and Maintenance, once they are open. A phase with no files
  // is still printed: either it is not written yet, or its snapshot has been
  // pruned, and both of those are facts about the record rather than reasons
  // to leave a heading out of it.
  const code = dossier.phases.filter(
    (p) =>
      (p.key === "implementation" || p.key === "maintenance") &&
      p.status !== "locked",
  );
  const built = dossier.phases.filter((p) => p.revisions.length > 0);
  const artefacts = dossier.phases.reduce((n, p) => n + p.files.length, 0);
  const records =
    dossier.journal.length +
    dossier.phases.reduce((n, p) => n + p.revisions.length, 0) +
    dossier.releases.length;
  // The cover says where the project stands in the completion page's words:
  // sealed by the learner's own last advance ("Complete the project" on the
  // last phase), every phase passed but not yet sealed, or in progress.
  const completion = dossierCompletion(dossier);
  // The cover counts reviewed passes, as the completion page does; a teacher's
  // credit without one is said beside the count, never folded into it.
  const reviewed = reviewedPasses(dossier.phases);
  // Of those, the ones whose review passed and wait only on the teacher's
  // countersignature are said in those words, not "review still needed".
  const awaitingPhases = dossier.phases.filter(
    (phase) => creditedWithoutReview(phase) && creditState(phase) === "awaiting",
  );
  const awaiting = awaitingPhases.length;
  const credited = Math.max(0, dossier.phasesPassed - reviewed - awaiting);
  // What the missing review or countersignature opens: the next phase, or on
  // the project's last phase (`isLastPhase`) the way to complete the project.
  const lastCredited = dossier.phases.some(
    (phase) => isLastPhase(dossier, phase.key) && creditedWithoutReview(phase) && creditState(phase) === "credited",
  );
  const lastAwaiting = awaitingPhases.some((phase) => isLastPhase(dossier, phase.key));
  const creditHint = [
    credited > 0 ? `${STATE_LABEL.credited}: ${phasesWord(credited)}` : "",
    awaiting > 0 ? `${STATE_LABEL.awaiting}: ${phasesWord(awaiting)}` : "",
  ].filter(Boolean).join(". ");
  const [presenting] = usePresentationView();

  return (
    <article
      className="dossier flex min-w-0 flex-col gap-3.5"
      data-testid={testId}
    >
      {/* 1 · Cover ------------------------------------------------------- */}
      <Section
        className="dossier-section"
        testId="dossier-section-1"
        title="The record of a project"
        purpose={`${dossier.projectTitle}, made in the LearnSDLC workspace.`}
        right={
          <Chip tone={completion === "sealed" ? "pass" : "neutral"} testId="dossier-completion">
            {COMPLETION_CHIP[completion]}
          </Chip>
        }
      >
        <div>
          <p className="label">Learner</p>
          {/* The cover's name sits under the page's own heading in the ramp:
              at `.h1` it would tie /dossier's 28px title, so the largest text
              on the page would be the learner's name and the page's own title
              one of three things at that size. */}
          <p className="h2 mt-1 break-words" data-testid="dossier-cover-name">
            {dossier.displayName || "This learner"}
          </p>
          {/* The teacher's Presentation view hides learners' email
              addresses while the screen is shared; the record follows it, and
              says so rather than leaving a gap. */}
          <p className="label-sm mt-1" data-testid="dossier-cover-email">
            {presenting ? "Email hidden in Presentation view" : dossier.email}
          </p>
          {dossier.cohortName && (
            <p className="label-sm mt-0.5">{dossier.cohortName}</p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            value={`${reviewed} of ${dossier.totalPhases}`}
            label="Phases passed"
            hint={creditHint || undefined}
            tone={reviewed === dossier.totalPhases ? "pass" : "neutral"}
          />
          <Stat
            value={dossier.phases.reduce(
              (count, phase) => count + phase.revisions.length,
              0,
            )}
            label="Submitted reviews"
            hint="Retained review records"
          />
          <Stat
            value={artefacts}
            label="Submitted files listed"
            hint="Retained source snapshots"
          />
        </div>

        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <Fact
            label="Started"
            value={longDate(dossier.startedAt) || "Not recorded"}
          />
          <Fact
            label="Finished"
            value={
              longDate(dossier.completedAt) ||
              (completion === "all-passed" ? finishedWhen(dossier.audience) : "Not yet")
            }
          />
          <Fact label="Dossier made" value={longDate(dossier.generatedAt)} />
          <Fact
            label="Content pack"
            value={dossier.packVersion ?? "Not recorded"}
          />
        </dl>

        <p className="text-[13.5px] leading-relaxed text-ink2">
          <span data-testid="dossier-standing">
            {/* Sealed, the headline follows the count beside it: a phase a
                teacher later reset and credited, or one being retried, does
                not hold a reviewed pass. */}
            {completion === "sealed"
              ? reviewed >= dossier.totalPhases
                ? `All ${dossier.totalPhases} phases passed. The project is complete.`
                : `${reviewed} of ${dossier.totalPhases} phases passed. The project is complete.`
              : completion === "all-passed"
                ? closesLine(dossier.audience)
                : `${reviewed} of ${dossier.totalPhases} phases passed so far.`}
          </span>
          {credited > 0 && (
            <span data-testid="dossier-credited">
              {" "}
              {`Credit awarded, review still needed on ${phasesWord(credited)}: a teacher's credit counts on the board; ${onwardOn(lastCredited, credited)} on a reviewed pass.`}
            </span>
          )}
          {awaiting > 0 && (
            <span data-testid="dossier-awaiting">
              {" "}
              {`${STATE_LABEL.awaiting} on ${phasesWord(awaiting)}: the work passed review; ${onwardOn(lastAwaiting, awaiting)} on the countersignature.`}
            </span>
          )}{" "}
          This document records the available coursework and review evidence for
          the learner named above. Imported and older records may have missing
          source snapshots. It is not an accredited certificate.
        </p>
      </Section>

      {/* 2 · Scores ------------------------------------------------------ */}
      <Section
        className="dossier-section"
        testId="dossier-section-2"
        title="Phase reviews"
        purpose="Every phase and its retained review record."
        pad={false}
      >
        <div className="px-4 pb-4">
          <Table
            cols={[
              { label: "Phase", width: "minmax(0,1.6fr)" },
              { label: "Status", width: "110px" },
              // Every revision the phase holds, quiz papers included, so the
              // column adds up to the cover's "Submitted reviews". The
              // phase's own attempt counter leaves a quiz's papers out, so it
              // would read "1" beside a phase of two reviews.
              { label: "Reviews", width: "80px", align: "right", mono: true },
              { label: "Hints", width: "70px", align: "right", mono: true },
              { label: "Passed on", width: "130px", muted: true },
              { label: "Result", width: "minmax(0,140px)", align: "right" },
            ]}
            minWidth={640}
            rowTestId={(i) =>
              `dossier-score-${dossier.phases[i] ? place(dossier.phases[i]) : i + 1}`
            }
            rows={dossier.phases.map((phase) => {
              // A teacher's credit with no reviewed pass behind it prints as
              // credit, never as a pass square, word or date: the
              // same predicate the cover counts by.
              const credit = creditedWithoutReview(phase);
              const state = credit
                ? "warn"
                : statusState(phase.status, phase.status === "in_progress");
              return [
                <span key="p" className="flex items-center gap-2">
                  <StatusSquare state={state} hue={phase.key} />
                  <span className="font-medium">
                    {place(phase)}. {phase.title}
                  </span>
                </span>,
                <span key="s" data-testid={`dossier-status-${place(phase)}`}>
                  {credit ? creditLabel(phase) : word(state)}
                </span>,
                phase.revisions.length,
                phase.hints,
                (credit ? "" : longDate(phase.passedAt)) || "—",
                <Chip
                  key="r"
                  tone={phase.status === "passed" && !credit ? "pass" : "neutral"}
                >
                  {phase.status === "locked"
                    ? `Opens in phase ${place(phase)}`
                    : credit
                      ? creditVerdict(phase)
                      : phaseVerdict(phase)}
                </Chip>,
              ];
            })}
          />
        </div>
      </Section>

      {/* 3 · The issue --------------------------------------------------- */}
      {requirements && (
        <Section
          className="dossier-section"
          testId="dossier-section-3"
          title="The issue"
          purpose="Requirements: the story the learner wrote, and the criteria it can be checked against."
        >
          <PhaseBody
            phase={requirements}
            place={place(requirements)}
            empty="Requirements is open, and nothing is written yet."
          >
            {fileOf(requirements, STORY_JSON).trim() ? (
              <StoryCard
                story={readStoryRecord(fileOf(requirements, STORY_JSON))}
                full
                criteria={false}
                testId="dossier-story"
              />
            ) : (
              <Nothing what="The story record is empty." />
            )}
            <Criteria phase={requirements} />
          </PhaseBody>
        </Section>
      )}

      {/* 4 · The contract ------------------------------------------------ */}
      {design && (
        <Section
          className="dossier-section"
          testId="dossier-section-4"
          title="The contract"
          purpose="Design: the model, the operations the code promises, and the decision behind them."
        >
          <PhaseBody
            phase={design}
            place={place(design)}
            empty="Design is open, and nothing is written yet."
          >
            <DesignRecord phase={design} requirements={requirements} />
          </PhaseBody>
        </Section>
      )}

      {/* 5 · The code ---------------------------------------------------- */}
      {holdsCode && (
        <Section
          className="dossier-section"
          testId="dossier-section-5"
          title="The code"
          purpose="Implementation and Maintenance evidence. Teacher copies use the merged revision or latest submitted snapshot; unsubmitted drafts remain private."
        >
          {code.length === 0 ? (
            <Nothing what="No code has been written yet." />
          ) : (
            code.map((phase) => (
              <div key={phase.phaseStateId} className="flex flex-col gap-4">
                <h3 className="h3">{phase.title}</h3>
                {phase.files.length > 0 ? (
                  phase.files.map((file) => (
                    <CodeBlock
                      key={file.path}
                      path={file.path}
                      content={file.content}
                      testId={`dossier-file-${file.path}`}
                    />
                  ))
                ) : phase.merged ? (
                  // The same sentence the pull request's own `filesPruned` gives:
                  // retention keeps the newest five revisions and every passing
                  // one, and a copy that fell outside both was pruned, not lost.
                  <Nothing what="Files are not kept for this revision." />
                ) : (
                  <Nothing what="Nothing is written here yet." />
                )}
                {/* The day the learner opened the
                    pack's answer for this phase. The reference files themselves
                    are deliberately not printed. */}
                {phase.solutionReadAt && (
                  <p
                    className="label-sm wrap"
                    data-testid={`dossier-solution-${phase.key}`}
                  >
                    {dossier.audience === "instructor"
                      ? `Read the reference solution on ${longDate(phase.solutionReadAt)}.`
                      : `You read the reference solution for this phase on ${longDate(phase.solutionReadAt)}.`}
                  </p>
                )}
              </div>
            ))
          )}
        </Section>
      )}

      {/* 6 · The pull request -------------------------------------------- */}
      <Section
        className="dossier-section"
        testId="dossier-section-6"
        title="The pull request"
        purpose="Every revision with what the learner said it changed, what the reviewer asked, and the message it was merged on."
      >
        {built.length === 0 ? (
          <Nothing what="Nothing has been submitted yet." />
        ) : (
          built.map((phase) => (
            <PullRequest
              key={phase.phaseStateId}
              phase={phase}
              // Each merge writes the phase's release record (the advance).
              merged={dossier.releases.some((release) => release.phaseKey === phase.key)}
            />
          ))
        )}
      </Section>

      {/* 7 · The kill matrix --------------------------------------------- */}
      {testing && (
        <Section
          className="dossier-section"
          testId="dossier-section-7"
          title="The kill matrix"
          purpose="Testing: the planted bugs, the cases that caught them, and the day the suite was run at."
        >
          <PhaseBody
            phase={testing}
            place={place(testing)}
            empty="Testing is open, and no suite has been graded yet."
          >
            <KillMatrix phase={testing} />
          </PhaseBody>
        </Section>
      )}

      {/* 8 · The drill --------------------------------------------------- */}
      {deployment && (
        <Section
          className="dossier-section"
          testId="dossier-section-8"
          title="The drill"
          purpose="Deployment: the fault, the two health checks, and INCIDENT-1 in the learner's own words."
        >
          <PhaseBody
            phase={deployment}
            place={place(deployment)}
            empty="Deployment is open, and the drill has not started."
          >
            <Drill phase={deployment} />
          </PhaseBody>
        </Section>
      )}

      {/* 9 · The change record ------------------------------------------- */}
      {maintenance && (
        <Section
          className="dossier-section"
          testId="dossier-section-9"
          title="The change record"
          purpose="Maintenance: the ticket and the change request, what the change touched, what the contract claimed, and the release it shipped in."
        >
          <PhaseBody
            phase={maintenance}
            place={place(maintenance)}
            empty="Maintenance is open, and the change is not made yet."
          >
            <ChangeRecord
              phase={maintenance}
              audience={dossier.audience}
              release={
                dossier.releases.find((r) => r.phaseKey === "maintenance") ?? null
              }
            />
          </PhaseBody>
        </Section>
      )}

      {/* 10 · Reflections ------------------------------------------------ */}
      <Section
        className="dossier-section"
        testId="dossier-section-10"
        title="Reflections"
        purpose="The merge message from each phase, in the learner's own words."
      >
        {dossier.phases.filter((p) => p.mergeMessage).length === 0 ? (
          <Nothing what="No phase has been merged yet." />
        ) : (
          dossier.phases
            .filter((p) => p.mergeMessage)
            .map((phase) => {
              const release =
                dossier.releases.find((r) => r.phaseKey === phase.key) ?? null;
              return (
                <div key={phase.phaseStateId} className="flex flex-col gap-1">
                  <p className="flex flex-wrap items-baseline gap-2">
                    <span className="h3">{phase.title}</span>
                    {release && (
                      <span className="mono text-[12px] text-muted">
                        {release.version}
                      </span>
                    )}
                    <Chip tone={phase.status === "passed" && !creditedWithoutReview(phase) ? "pass" : "neutral"}>
                      {creditedWithoutReview(phase) ? creditVerdict(phase) : phaseVerdict(phase)}
                    </Chip>
                  </p>
                  <p className="wrap text-[13.5px] leading-relaxed text-ink2">
                    {phase.mergeMessage}
                  </p>
                </div>
              );
            })
        )}
      </Section>

      {/* 11 · The journal ------------------------------------------------ */}
      <Section
        className="dossier-section"
        testId="dossier-section-11"
        title="The journal"
        purpose="Every recorded event, grouped by the day it happened on, newest first."
      >
        <Journal rows={dossier.journal} audience={dossier.audience} />
      </Section>

      {/* 12 · Colophon --------------------------------------------------- */}
      <Section
        className="dossier-section"
        testId="dossier-section-12"
        title="Colophon"
        purpose="How this document was made."
      >
        <p
          className="text-[13.5px] leading-relaxed text-ink2"
          data-testid="dossier-colophon"
        >
          Made on {longDate(dossier.generatedAt)} from {artefacts}{" "}
          {pluralWord(artefacts, "artefact")} and {records}{" "}
          {pluralWord(records, "record")}. Content pack{" "}
          {dossier.packVersion ?? "not recorded"}. File listings use the
          retained merged or latest submitted revision for each phase. Earlier
          reports describe their own revisions; their complete source is
          available from the matching review when retained. Missing source
          remains unavailable; it is never replaced by a newer draft.{" "}
          {printedScope(dossier)} Prepared by this browser for the print
          destination you choose.
        </p>
      </Section>
    </article>
  );
}

/**
 * What the colophon says the page includes, derived from what the page
 * printed rather than fixed, so it never says the incident was left out of a
 * page that printed it. The drill prints in section 8 when
 * the project holds an open Deployment with recorded work and a drill; its
 * incident prints when the learner has written it up. Manually linked coverage
 * is never printed here, so that clause always stays.
 */
export function printedScope(dossier: LearnerDossier): string {
  const deployment = phaseOf(dossier, "deployment");
  const drillPrinted =
    !!deployment &&
    deployment.status !== "locked" &&
    (deployment.files.length > 0 || deployment.revisions.length > 0) &&
    !!deployment.drill;
  const coverage = "Manually linked coverage is not included in this printable view.";
  if (!deployment) return coverage;
  if (drillPrinted && deployment.drill?.incident)
    return `Deployment incident state is included as printed above. ${coverage}`;
  if (drillPrinted)
    return `The drill is included as printed above; its incident has not been written up yet. ${coverage}`;
  return `Deployment incident state is not included in this printable view. ${coverage}`;
}

/* -------------------------------- the parts ------------------------------- */

const STATE_WORD: Record<StatusState, string> = {
  pass: "Passed",
  done: "Done",
  now: "In progress",
  todo: "Not open",
  fail: "Failing",
  warn: "Needs attention",
};

const word = (state: StatusState): string => STATE_WORD[state];
