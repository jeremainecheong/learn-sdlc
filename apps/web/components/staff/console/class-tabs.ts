import type { InstructorLearnerDetail } from "@learnsdlc/shared";

/**
 * The class page's sections, one in view at a time.
 *
 * The tabs keep every
 * section mounted (a half-typed note, date or regrade reason survives a visit
 * to another tab, and nothing is read again on a switch) and show one.
 *
 * The open tab is in the address as `?tab=<key>`, beside `?class=` and
 * `?view=table`. Overview is the default and is never written, so the board's
 * own address (`/teacher/class?class=<id>`, with or without `&view=table`)
 * still opens on the phase map or the table.
 */
export const CLASS_TABS = [
  { key: "overview", label: "Overview" },
  { key: "signoff", label: "Sign-off" },
  { key: "project", label: "Project" },
  { key: "dates", label: "Dates and regrades" },
  { key: "invite", label: "Invite and notes" },
] as const;

export type ClassTabKey = (typeof CLASS_TABS)[number]["key"];

const DEFAULT_CLASS_TAB: ClassTabKey = "overview";

/** The one tab panel the row switches (`Tabs` `panelId`, `tabPanelProps`). */
export const CLASS_TAB_PANEL_ID = "class-section";

/** The address's `tab` value as a tab, or the default for anything else. */
export function classTabOf(value: string | null | undefined): ClassTabKey {
  return CLASS_TABS.some((tab) => tab.key === value) ? (value as ClassTabKey) : DEFAULT_CLASS_TAB;
}

/** What `?tab=` holds for a tab: nothing for the default. */
export function classTabParam(key: ClassTabKey): string | null {
  return key === DEFAULT_CLASS_TAB ? null : key;
}

/**
 * A class's page address: `/teacher/class?class=<id>`, with `&tab=<key>` when
 * it should open on a tab and `#<id>` when it should land on a part of it.
 */
export function classPageHref(classId: string, options: { tab?: ClassTabKey; hash?: string } = {}): string {
  const tab = options.tab ? `&tab=${options.tab}` : "";
  const hash = options.hash ? `#${options.hash}` : "";
  return `/teacher/class?class=${encodeURIComponent(classId)}${tab}${hash}`;
}

/**
 * The Sign-off tab's waiting count, as a reader hears it after the tab's name:
 * ", 2 waiting". Nothing while the queue has not answered, or when nobody waits.
 */
export function signoffWaitingSuffix(waiting: number | null): string {
  return waiting ? `, ${waiting} waiting` : "";
}

/**
 * How many task sign-offs wait in each class, from the learners the page has
 * already read (no queue read per class on the home page).
 *
 * The rule is the queue's own (`signoff.ts` `queue`): a learner's task that is
 * awaiting a sign-off and has not passed, on any of the learner's enrolments,
 * counted once per learner and task. The queue also leaves out a task the
 * learner's pinned version no longer marks for sign-off; the learner read does
 * not carry that mark, so in that one case this count can be higher than the
 * class page's queue. It arises only when an enrolment is re-pinned, and only
 * the seed's bootstrap repair re-pins one (`null-pin.ts`, `StoryRepinService`);
 * no teacher screen can cause it, so it is not an everyday drift.
 */
export function awaitingSignoffByClass(learners: InstructorLearnerDetail[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const learner of learners) {
    if (!learner.cohort) continue;
    const waiting = learner.enrollments.reduce(
      (sum, enrollment) =>
        sum +
        enrollment.phases.reduce(
          (inPhase, phase) =>
            inPhase + (phase.tasks ?? []).filter((task) => task.awaitingSignOff && task.status !== "passed").length,
          0,
        ),
      0,
    );
    counts.set(learner.cohort, (counts.get(learner.cohort) ?? 0) + waiting);
  }
  return counts;
}
