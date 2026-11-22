"use client";
import { sameSession, sessionKey } from '@/lib/session-token';
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  LayoutGrid,
  List,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  MoreHorizontal,
  UsersRound,
} from "lucide-react";
import type {
  AuditEventView,
  CohortView,
  InstructorLearnerDetail,
  InstructorLearnerRow,
  InstructorPhaseView,
  PhaseKey,
  SubmissionView,
} from "@learnsdlc/shared";
import {
  CLASS_NAME_MAX,
  CLASS_NAME_MIN,
  QUIZ_RESULTS_COPY,
  QUIZ_RESULTS_EXPORT_KINDS,
  pluralWord,
  type QuizResultsExportKind,
} from "@learnsdlc/shared";
import { instructorApi } from "@/lib/api-instructor";
import { assignedVersionPhases } from "@/lib/assigned-phases";
import { exportFilename, gradebookFilename, saveBlob } from "@/lib/download";
import { startViewAs } from "@/lib/view-as";
import { resetProject } from "@/lib/useProject";
import { cohortsApi } from "@/lib/api-cohorts";
import {
  experienceApi,
  type TeacherFeedback,
  type SubmissionHistoryItem,
} from "@/lib/api-experience";
import { api, describeError } from "@/lib/api";
import { getToken, onSessionEnd, setSession, useSession } from "@/lib/session";
import { PHASE_KEYS, PHASE_META } from "@/lib/phase";
import {
  ExperiencePage,
  LoadingState,
  formatDate,
  isPass,
  isReviewUnavailable,
} from "@/components/experience/shared";
import { SubmissionEvidence } from "@/components/experience/SubmissionEvidence";
import { JoinCode } from "@/components/experience/JoinCode";
import { LearnerAvatar } from "@/components/experience/LearnerAvatar";
import { ScrollRegion } from "@/components/experience/ScrollRegion";
import { patchPageHref, updatePageQuery } from "@/lib/navigation";
import { createTeacherDraftStore } from "./teacher-feedback-drafts";
import { classUsesSignoff, clockTime, latestSubmissionState, phaseCellState, teacherVerdict, type TeacherState } from "./teacher-states";
import { usePresentationView, usePresentationViewSetting } from "@/components/experience/presentation-view";
import { PresentationToggle } from "@/components/experience/PresentationToggle";
import { StuckList } from "@/components/staff/StuckList";
import { ClassProjectCard } from "@/components/staff/ClassProjectCard";
import { NotesCard } from "@/components/staff/NotesCard";
import { SignoffQueue } from "@/components/staff/SignoffQueue";
import { AuditList } from "@/components/staff/AuditList";
import { LearnerTasks } from "@/components/staff/LearnerTasks";
import { PhaseLevers } from "@/components/staff/PhaseLevers";
import { ClassLevers, type ClassLeverProject } from "@/components/staff/ClassLevers";
import { SIGNOFF_QUEUE_ID, focusSignoffQueue, versionInForceMarksSignoff } from "@/components/staff/SignoffQueue";
import { PaneBoundary } from "@/components/shell/PaneBoundary";
import { Tabs, tabPanelProps } from "@/components/ui";
import {
  CLASS_TABS,
  CLASS_TAB_PANEL_ID,
  awaitingSignoffByClass,
  classPageHref,
  classTabOf,
  classTabParam,
  signoffWaitingSuffix,
  type ClassTabKey,
} from "./class-tabs";
import { revealBoardHead } from "./board-reveal";
import { useIsoLayoutEffect } from "@/lib/use-iso-layout-effect";
import {
  ACKNOWLEDGE_ROWS_SHOWN,
  AUDIT_ROWS,
  awaitingClassProject,
  CLASS_REFRESH_THROTTLE_MS,
  classFileLabel,
  currentPhaseWords,
  dossierHref,
  enrollmentOf,
  evidenceWaitAdvice,
  evidenceWaitLine,
  FEEDBACK_READ_BATCH,
  NO_PERCENT,
  phaseCellRevision,
  revisionTaskPrefix,
  ROSTER_SORTS,
  rowKey,
  VERDICT_FILTERS,
  type RosterSort,
} from "./teacher-portal-model";

type Selection = {
  learner: InstructorLearnerDetail;
  phase: InstructorPhaseView;
};
type QueueRow = {
  learner: InstructorLearnerDetail;
  phase: InstructorPhaseView;
  submission: SubmissionView;
};

/** A state in the teacher's words, on the badge's own classes and marks. */
function TeacherBadge({ state }: { state: TeacherState }) {
  const Mark = state.tone === "pass" ? Check : state.tone === "locked" ? LockKeyhole : state.tone === "revision" ? RotateCcw : Clock3;
  return (
    <span className={`exp-status ${state.tone === "pass" ? "is-pass" : state.tone === "revision" ? "is-revision" : state.tone === "locked" ? "is-locked" : ""}`}>
      <Mark size={14} />
      {state.label}
    </span>
  );
}

function Portal({ classView }: { classView: boolean }) {
  const user = useSession();
  const [feedbackDrafts] = useState(() => createTeacherDraftStore(() => sessionKey(getToken())));
  useEffect(() => onSessionEnd(() => feedbackDrafts.clear()), [feedbackDrafts]);
  const router = useRouter();
  const query = useSearchParams();
  const [cohorts, setCohorts] = useState<CohortView[]>([]);
  const [learners, setLearners] = useState<InstructorLearnerDetail[]>([]);
  // The class rows the overview already answers with, kept
  // rather than reduced to a list of ids. `checklistPercent` and
  // `masteryPercent` are computed over the learner's **pinned version** (the
  // task list and the `task_states` rows) which is a question the per-learner
  // detail read does not ask, so the roster's two columns read them from here.
  const [classRows, setClassRows] = useState<InstructorLearnerRow[]>([]);
  const [loading, setLoading] = useState(true);
  // How fresh the records on screen are. `updatedAt` is the last
  // read that answered; `staleAt` the last that did not, while the earlier read
  // stays on screen and the page says so rather than implying freshness.
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [staleAt, setStaleAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped after each quiet read, so the sign-off queue and the help requests
  // are read with the table rather than left a read behind.
  const [refreshRound, setRefreshRound] = useState(0);
  const lastRead = useRef(0);
  // A quiet read put new learners on screen: the evidence panel keeps its
  // place rather than reloading and taking focus.
  const quietLearners = useRef(false);
  const [signoffWaiting, setSignoffWaiting] = useState<number | null>(null);
  // Emails are hidden while the switch is on or not yet read; the line
  // that says the view is on says so only once it is read and on.
  const [presenting] = usePresentationView();
  const presentationOn = usePresentationViewSetting() === true;
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const search = query.get("search") ?? "";
  const requestedPhaseFilter: PhaseKey | "" = PHASE_KEYS.includes(query.get("phaseFilter") as PhaseKey) ? query.get("phaseFilter") as PhaseKey : "";
  const verdictFilter = VERDICT_FILTERS.some((option) => option.value === query.get("verdict")) ? query.get("verdict")! : "";
  const view = query.get("view") === "table" ? "table" : "map";
  const sort: RosterSort = ROSTER_SORTS.some((option) => option.value === query.get("sort"))
    ? (query.get("sort") as RosterSort)
    : "name";
  const setSort = (value: RosterSort) =>
    updatePageQuery({ sort: value === "name" ? null : value });
  const setSearch = (value: string) => updatePageQuery({ search: value }, "replace");
  const setPhaseFilter = (value: PhaseKey | "" | ((current: PhaseKey | "") => PhaseKey | "")) => updatePageQuery({ phaseFilter: typeof value === "function" ? value(phaseFilter) : value });
  const setVerdictFilter = (value: string) => updatePageQuery({ verdict: value });
  const setView = (value: "map" | "table") => updatePageQuery({ view: value === "map" ? null : value });
  // A press on Phase map or Table brings the head of the board into view
  // (board-reveal.ts): at once when that view is already drawn, else
  // once it is. Only a press asks; a page opened at ?view=table, a refresh,
  // data arriving and Back never do.
  const boardPanel = useRef<HTMLElement>(null);
  const revealOnDraw = useRef<"map" | "table" | null>(null);
  const askBoardReveal = (value: "map" | "table") => {
    if (value !== view) revealOnDraw.current = value;
    else if (boardPanel.current) revealBoardHead(boardPanel.current);
  };
  useIsoLayoutEffect(() => {
    if (revealOnDraw.current !== view) return;
    revealOnDraw.current = null;
    if (boardPanel.current) revealBoardHead(boardPanel.current);
  }, [view]);
  // The class page's open section (class-tabs.ts). The address leads: a
  // link, a reload and Back all land on its `?tab=`. A press shows its section
  // at once and replaces the address, so Back leaves the page rather than
  // walking back through every tab looked at.
  const addressTab = classTabOf(query.get("tab"));
  const [tab, setTab] = useState<ClassTabKey>(addressTab);
  useEffect(() => setTab(addressTab), [addressTab]);
  const selectTab = useCallback((next: ClassTabKey) => {
    setTab(next);
    updatePageQuery({ tab: classTabParam(next) }, "replace");
  }, []);
  /**
   * Open the Sign-off tab and put focus on the queue's heading: the header's
   * "Sign-off queue", the tile's "Open the sign-off queue" and a
   * `#signoff-queue` that arrives while the page is open. True when focus
   * moved; false when the queue is not drawn yet, so the caller can leave the
   * hash for the queue's own arrival rule (SignoffQueue.tsx).
   */
  const openSignoffQueue = useCallback((): boolean => {
    // The panel is shown before focus moves: a hidden heading cannot take it.
    flushSync(() => setTab("signoff"));
    updatePageQuery({ tab: classTabParam("signoff") }, "replace");
    return focusSignoffQueue();
  }, []);
  /**
   * Open the Project tab and put focus on its card's heading: the Dates and
   * regrades tab's "Give this class a project".
   */
  const openProjectTab = useCallback(() => {
    flushSync(() => setTab("project"));
    updatePageQuery({ tab: classTabParam("project") }, "replace");
    const heading = document.getElementById("class-project-heading");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, []);
  useEffect(() => {
    if (!classView) return;
    // Arriving with `#signoff-queue` (the home's link beside each class) opens
    // the Sign-off tab; the queue moves focus to its heading once it is drawn
    // and spends the hash itself.
    if (window.location.hash === `#${SIGNOFF_QUEUE_ID}`) selectTab("signoff");
    const arrived = () => {
      if (window.location.hash !== `#${SIGNOFF_QUEUE_ID}`) return;
      if (!openSignoffQueue()) return;
      const { pathname, search } = window.location;
      window.history.replaceState(null, "", `${pathname}${search}`);
    };
    window.addEventListener("hashchange", arrived);
    return () => window.removeEventListener("hashchange", arrived);
  }, [classView, selectTab, openSignoffQueue]);
  const [className, setClassName] = useState("");
  const [creating, setCreating] = useState(false);
  const createPending = useRef(false);
  const [createdReceipt, setCreatedReceipt] = useState<CohortView | null>(null);
  const [createRefreshError, setCreateRefreshError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [history, setHistory] = useState<SubmissionHistoryItem[]>([]);
  // The selected learner's own record of changes. It is read with the
  // evidence rather than behind a menu, because every per-task lever below
  // leaves a row on it and a teacher needs to see the one they just pulled,
  // and because this panel's `AuditList` is where a teacher reads a learner's
  // `task.signoff`, `task.reopen` and `task.reset` rows.
  const [audit, setAudit] = useState<AuditEventView[] | null>(null);
  const [auditError, setAuditError] = useState("");
  const [auditReload, setAuditReload] = useState(0);
  const requestedEvidence = query.get("evidence") ?? "";
  const requestedPhase = query.get("phase") ?? "";
  const requestedSubmission = query.get("submission") ?? "";
  const selectedId = requestedSubmission ? history.find(row => row.id === requestedSubmission)?.id ?? "" : history.at(-1)?.id ?? "";
  const [evidenceReload, setEvidenceReload] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, TeacherFeedback[]>>(
    {},
  );
  /**
   * The two CSV exports and View as. `/instructor` and
   * `/instructor/learners/[id]` redirect here, so this page is the only place
   * the product offers them. Which one is in flight, so its button reads busy
   * and the other stays pressable.
   */
  const [exporting, setExporting] = useState<"" | "grades" | "gradebook" | "classGrades" | "classGradebook">("");
  const [openingView, setOpeningView] = useState("");
  const evidenceHeading = useRef<HTMLHeadingElement>(null);
  const evidencePanel = useRef<HTMLElement>(null);
  const inspectionTrigger = useRef<HTMLElement | null>(null);
  const selectionVersion = useRef(0);
  const loadVersion = useRef(0);
  // Whether this page is still on screen: a create whose class-list read
  // answers after the teacher has left must not pull them to the new class
  // Not `loadVersion`, which a quiet refresh on focus also moves.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Classes created on this page, each with the last read begun before it was
  // made. A read that began earlier (the home's first read, still
  // running when Create class is pressed) answers without the new class; it
  // is added back to what that read sets, so its card is not dropped. A read
  // begun later has it from the server.
  const createdHere = useRef<{ cohort: CohortView; before: number }[]>([]);
  // Whether any read of the page has answered, as `updatedAt` says, for
  // `refresh`, which must not wait on a render to know it.
  const answered = useRef(false);
  const requestedClass = query.get("class") || "";
  const requestedLearner = query.get("learner") || "";
  const selectedClass = requestedClass || cohorts[0]?.id || "";
  const cohort = cohorts.find((item) => item.id === selectedClass);
  const pageHref = `${classView ? "/teacher/class" : "/teacher"}${query.toString() ? `?${query}` : ""}`;
  const load = useCallback(async (showError = true, quiet = false) => {
    const version = ++loadVersion.current;
    lastRead.current = Date.now();
    const withCreated = (classes: CohortView[]) => {
      const missing = createdHere.current
        .filter((item) => item.before >= version && !classes.some((one) => one.id === item.cohort.id))
        .map((item) => item.cohort);
      return missing.length ? [...classes, ...missing] : classes;
    };
    if (!quiet) {
      setError("");
      setLoading(true);
    }
    try {
      // Nothing of the page is drawn from this read until all of it has
      // answered: the parts above the class cards on the
      // home grow with their data, so cards drawn early would drop out of
      // place, under the pointer, when those parts arrived.
      const [classes, overview] = await Promise.all([
        cohortsApi.mine(),
        // No slug: the overview answers one row per enrolment for every
        // learner in the caller's scope, whatever project they are in.
        instructorApi.overview(),
      ]);
      if (version !== loadVersion.current) return false;
      const classId = requestedClass || classes[0]?.id;
      const ids = [
        ...new Set(
          overview.learners
            .filter((learner) => !classView || learner.cohort === classId)
            .map((learner) => learner.userId),
        ),
      ];
      // One class read per 50 learners (`GET /instructor/learners`), not one
      // `learners/:id` each against that route's 60 a minute, which would
      // refuse a class of 30 by the third view.
      const details: InstructorLearnerDetail[] = await instructorApi.learnersIn(
        ids,
        classView ? classId : undefined,
        () => version === loadVersion.current,
      );
      if (version !== loadVersion.current) return false;
      if (quiet) quietLearners.current = true;
      setCohorts(withCreated(classes));
      setClassRows(overview.learners);
      setLearners(details);
      setSelection((current) => {
        if (!current) return null;
        const fresh = details.find(
          (learner) =>
            learner.userId === current.learner.userId &&
            learner.cohort === current.learner.cohort,
        );
        if (!fresh) return null;
        // A quiet read hands the open panel the learner as they now stand.
        const phase = quiet ? enrollmentOf(fresh)?.phases.find((item) => item.id === current.phase.id) : undefined;
        return phase ? { learner: fresh, phase } : current;
      });
      answered.current = true;
      setUpdatedAt(new Date());
      setStaleAt(null);
      return true;
    } catch (err) {
      if (version === loadVersion.current) {
        if (quiet) setStaleAt(new Date());
        else if (showError) setError(describeError(err, "Your classes could not be loaded."));
      }
      return false;
    } finally {
      // Whichever read is current ends the loading state, quiet or not: a
      // quiet read never set it, but one that overtakes a full read in flight
      // (a countersign or a tab return during a mount, a class switch or a
      // regrade) is the read that answers, and the superseded one never will.
      if (version === loadVersion.current) setLoading(false);
    }
  }, [classView, requestedClass]);
  /**
   * Read the class again without taking the page away: after a
   * countersign, a lever, a regrade, the class-level Refresh, and on returning
   * to the tab. The table, the counters, the phase map, the queue and the help
   * requests follow; a failure keeps the earlier read on screen and says so.
   */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // With no read answered yet (the first one failed) there is no earlier
      // read to keep on screen, so this is a full read: the loading line, then
      // the page, or the failure said again.
      const quiet = answered.current;
      if (await load(!quiet, quiet)) setRefreshRound((round) => round + 1);
    } finally {
      setRefreshing(false);
    }
  }, [load]);
  /**
   * After a lever or a regrade, whose answer already patched the learner on
   * the board: the overview's rows (the checklist and mastery percentages),
   * the sign-off queue and the help requests are read again. A failed read
   * keeps the rows on screen; the page-level Refresh says when it fails.
   */
  const refreshAround = useCallback(async () => {
    try {
      const overview = await instructorApi.overview();
      setClassRows(overview.learners);
    } catch {
      // The rows on screen stay; the next Refresh reads them again.
    }
    setRefreshRound((round) => round + 1);
  }, []);
  useEffect(() => {
    if (!user || user.role === "LEARNER") return;
    const back = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastRead.current < CLASS_REFRESH_THROTTLE_MS) return;
      void refresh();
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [user?.id, user?.role, refresh]);
  useEffect(() => {
    if (!user) return;
    if (user.role === "LEARNER") {
      router.replace("/dashboard");
      return;
    }
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [user?.id, user?.role, load, router]);
  const associated = learners.filter(
    (learner) => !classView || learner.cohort === selectedClass,
  );
  // The phases of the version this class is assigned, for the board. Read
  // again whenever the class card saves an assignment on this page
  // (`assignmentRound`), so the columns follow it without a reload.
  const [assigned, setAssigned] = useState<{ cohortId: string; keys: PhaseKey[] | undefined } | null>(null);
  const [assignmentRound, setAssignmentRound] = useState(0);
  useEffect(() => {
    if (!classView || !selectedClass || !user || user.role === "LEARNER") return;
    let alive = true;
    void assignedVersionPhases(selectedClass).then((keys) => {
      if (alive) setAssigned({ cohortId: selectedClass, keys });
    });
    return () => {
      alive = false;
    };
  }, [classView, selectedClass, user?.id, user?.role, assignmentRound]);
  const assignedKeys = assigned?.cohortId === selectedClass ? assigned.keys : undefined;
  // Until the class's assignment has answered, the page waits rather than
  // drawing fallback columns it would then take back.
  const assignmentPending = classView && Boolean(selectedClass) && assigned?.cohortId !== selectedClass;
  // The projects the learners in view are actually in, named once each in the
  // order they appear, because a class's learners can be on different
  // projects and one title would be wrong for some of them.
  const projectsInView = [
    ...new Set(
      associated.flatMap((learner) => {
        const enrollment = enrollmentOf(learner);
        return enrollment?.projectTitle ? [enrollment.projectTitle] : [];
      }),
    ),
  ];
  // The phases the board draws, in LearnSDLC's order. On a
  // class's page they are the ones the class's assignment names, whoever owns
  // the version, so a class nobody has started on a three-phase version draws
  // three, plus the phase any learner in view is working on that the
  // assignment lacks (a learner still pinned to an older version), so every
  // learner has a column and a bar where they are. Where the assignment names
  // none (the view across classes, a response without the list, a version
  // with no phase rows here), they are the ones the learners in view hold, every phase any of
  // them holds; LearnSDLC's six stand in only when neither names any.
  const heldKeys = new Set(
    associated.flatMap((learner) => enrollmentOf(learner)?.phases.map((phase) => phase.key) ?? []),
  );
  const workingKeys = new Set(
    associated.flatMap((learner) => {
      const enrollment = enrollmentOf(learner);
      const key = enrollment?.phases.find((phase) => phase.order === enrollment.currentPhaseOrder)?.key;
      return key ? [key] : [];
    }),
  );
  const boardKeys: PhaseKey[] =
    classView && assignedKeys?.length
      ? PHASE_KEYS.filter((key) => assignedKeys.includes(key) || workingKeys.has(key))
      : heldKeys.size
        ? PHASE_KEYS.filter((key) => heldKeys.has(key))
        : PHASE_KEYS;
  // A filter is a phase the board draws: `?phaseFilter=testing` on a board
  // without Testing would empty the roster with no visible cause.
  const phaseFilter: PhaseKey | "" = requestedPhaseFilter && boardKeys.includes(requestedPhaseFilter) ? requestedPhaseFilter : "";
  // The projects this view's learners are working, for the class levers.
  const leverProjects: ClassLeverProject[] = [
    ...new Map(
      associated.flatMap((learner) => {
        const enrollment = enrollmentOf(learner);
        return enrollment
          ? [
              [
                enrollment.projectSlug,
                {
                  slug: enrollment.projectSlug,
                  title: enrollment.projectTitle,
                  phases: enrollment.phases.map((item) => ({ key: item.key, title: item.title })),
                },
              ] as const,
            ]
          : [];
      }),
    ).values(),
  ];
  const queue: QueueRow[] = associated
    .flatMap((learner) => {
      const phase = enrollmentOf(learner)
        ?.phases.filter((item) => item.lastSubmission)
        .sort((a, b) =>
          b.lastSubmission!.createdAt.localeCompare(
            a.lastSubmission!.createdAt,
          ),
        )[0];
      return phase?.lastSubmission
        ? [{ learner, phase, submission: phase.lastSubmission }]
        : [];
    })
    .sort((a, b) =>
      b.submission.createdAt.localeCompare(a.submission.createdAt),
    );
  const queueKey = queue.map((row) => row.submission.id).join("|");
  useEffect(() => {
    let alive = true;
    if (!queueKey) {
      setFeedback({});
      return;
    }
    const ids = queueKey.split("|");
    void (async () => {
      const rows: Array<readonly [string, TeacherFeedback[]]> = [];
      for (let offset = 0; offset < ids.length && alive; offset += FEEDBACK_READ_BATCH) {
        rows.push(
          ...(await Promise.all(
            ids
              .slice(offset, offset + FEEDBACK_READ_BATCH)
              .map(
                async (id) =>
                  [id, await experienceApi.teacherFeedback(id)] as const,
              ),
          )),
        );
      }
      return rows;
    })()
      .then((rows) => {
        if (alive) setFeedback(Object.fromEntries(rows));
      })
      .catch((err) => {
        if (alive)
          setDetailError(
            describeError(err, "Teacher review status could not be loaded."),
          );
      });
    return () => {
      alive = false;
    };
  }, [queueKey]);
  const currentKey = (learner: InstructorLearnerDetail) => {
    const enrollment = enrollmentOf(learner);
    return enrollment?.phases.find(
      (phase) => phase.order === enrollment.currentPhaseOrder,
    )?.key;
  };
  const classRowBy = new Map(
    classRows.map((row) => [rowKey(row.userId, row.projectSlug), row]),
  );
  /**
   * The class row for the enrolment this table is drawing, or undefined.
   *
   * Undefined is an ordinary answer, not a fault: the two fields are optional
   * on the contract, so a response may come without them, and a learner who has
   * started nothing has nothing to be a percentage of. Every reader below draws
   * a dash for it rather than a zero.
   */
  const classRowFor = (learner: InstructorLearnerDetail) =>
    classRowBy.get(rowKey(learner.userId, enrollmentOf(learner)?.projectSlug));
  const percentOf = (
    learner: InstructorLearnerDetail,
    field: "checklistPercent" | "masteryPercent",
  ): number | null => classRowFor(learner)?.[field] ?? null;
  const drawPercent = (value: number | null) =>
    value === null ? NO_PERCENT : `${value}%`;
  const visible = associated
    .filter((learner) => {
      if (requestedLearner && learner.userId !== requestedLearner) return false;
      // With Presentation view on (or not yet read) the search matches names
      // only, so typing part of an address on a projector cannot confirm it.
      if (
        search &&
        !(presenting ? learner.displayName : `${learner.displayName} ${learner.email}`)
          .toLowerCase()
          .includes(search.toLowerCase())
      )
        return false;
      if (phaseFilter && currentKey(learner) !== phaseFilter) return false;
      const last = queue.find(
        (row) => row.learner.userId === learner.userId,
      )?.submission;
      return (
        !verdictFilter ||
        (verdictFilter === "pass"
          ? Boolean(last && isPass(last))
          : verdictFilter === "revision"
            ? last?.status === "completed" && !isPass(last) && !isReviewUnavailable(last)
            : verdictFilter === "unavailable"
              ? Boolean(last && isReviewUnavailable(last))
              : !last)
      );
    })
    .sort((a, b) => {
      if (sort === "name") return a.displayName.localeCompare(b.displayName);
      const field = sort === "checklist" ? "checklistPercent" : "masteryPercent";
      const left = percentOf(a, field);
      const right = percentOf(b, field);
      // A learner with no number sorts last whichever way the column runs: a
      // blank is not a zero, and a teacher sorting by quiz mastery is asking
      // about the learners who have taken one.
      if (left === null || right === null)
        return left === right ? a.displayName.localeCompare(b.displayName) : left === null ? 1 : -1;
      return right - left || a.displayName.localeCompare(b.displayName);
    });
  /*
   * The home's way to one learner. The phase map is a class's, so it is
   * on the class page only, and `/teacher?learner=<id>` (where the bell's class
   * notifications, Stop viewing in the View as banner and a dossier's return
   * land, most through `/instructor/learners/<id>`) opens that learner's class
   * page with the same address, which filters its map to them. A learner in no
   * class of this teacher's (an admin's wider view) has no class page, so the
   * home still draws the map filtered to them.
   */
  const learnerHome =
    !classView && requestedLearner && !loading
      ? learners.find((learner) => learner.userId === requestedLearner)
      : undefined;
  const learnerClassId =
    learnerHome?.cohort && cohorts.some((item) => item.id === learnerHome.cohort) ? learnerHome.cohort : "";
  const learnerMapFallback = !classView && Boolean(requestedLearner) && !learnerClassId;
  /** Whether the roster is on this page, for the controls that filter it. */
  const rosterShown = classView || learnerMapFallback;
  const queryString = query.toString();
  useEffect(() => {
    if (!learnerClassId) return;
    // `class` first, then the rest of the address as it came.
    const next = new URLSearchParams({ class: learnerClassId });
    for (const [key, value] of new URLSearchParams(queryString)) if (key !== "class") next.append(key, value);
    router.replace(`/teacher/class?${next}`);
  }, [learnerClassId, queryString, router]);
  const loadEvidence = useCallback(async (
    learner: InstructorLearnerDetail,
    phase: InstructorPhaseView,
  ) => {
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      !evidencePanel.current?.contains(focused)
    )
      inspectionTrigger.current = focused;
    const version = ++selectionVersion.current;
    setSelection({ learner, phase });
    setHistory([]);
    setSelecting(true);
    setDetailError("");
    try {
      const rows = await experienceApi.teacherSubmissions(
        learner.userId,
        phase.id,
      );
      if (version !== selectionVersion.current) return;
      setHistory(rows);
      requestAnimationFrame(() => {
        if (version !== selectionVersion.current) return;
        evidenceHeading.current?.focus();
        evidenceHeading.current?.scrollIntoView({ block: "start" });
      });
    } catch (err) {
      if (version === selectionVersion.current)
        setDetailError(
          describeError(
            err,
            "The submitted phase evidence could not be loaded.",
          ),
        );
    } finally {
      if (version === selectionVersion.current) setSelecting(false);
    }
  }, []);
  useEffect(() => {
    // A quiet read moved the learners under an open panel: the
    // panel was handed them in place, and keeps its history, focus and scroll.
    // Only a panel that is open on the evidence asked for keeps its place: a
    // quiet read that overtook a full one, or that removed the learner, goes
    // on to open (or explain) the evidence the address asks for.
    if (quietLearners.current) {
      quietLearners.current = false;
      if (!selecting && selection?.learner.userId === requestedEvidence && selection.phase.id === requestedPhase) return;
    }
    selectionVersion.current++;
    setSelection(null); setHistory([]); setDetailError("");
    if (loading || !requestedEvidence || !requestedPhase) { setSelecting(false); return; }
    const learner = learners.find(item => item.userId === requestedEvidence && (!classView || item.cohort === selectedClass));
    const phase = learner && enrollmentOf(learner)?.phases.find(item => item.id === requestedPhase);
    if (!learner || !phase) { setDetailError("This learner or phase is not in this class view. Return to the roster or choose an available record."); setSelecting(false); return; }
    void loadEvidence(learner, phase);
    return () => { selectionVersion.current++; };
  }, [requestedEvidence, requestedPhase, selectedClass, classView, learners, loading, evidenceReload, loadEvidence]);
  const auditFor = selection?.learner.userId ?? "";
  useEffect(() => {
    if (!auditFor) { setAudit(null); setAuditError(""); return; }
    let alive = true;
    setAudit(null);
    void (async () => {
      try {
        const rows = await instructorApi.audit(auditFor, AUDIT_ROWS);
        if (alive) { setAudit(rows); setAuditError(""); }
      } catch (err) {
        if (alive) setAuditError(describeError(err, "The record of changes could not be read."));
      }
    })();
    return () => { alive = false; };
  }, [auditFor, auditReload]);
  function inspect(learner: InstructorLearnerDetail, phase: InstructorPhaseView, initialId?: string) {
    // The evidence opens under Overview on the class page, where its panel is.
    setTab("overview");
    updatePageQuery({ evidence: learner.userId, phase: phase.id, submission: initialId ?? phase.lastSubmission?.id ?? null, tab: classTabParam("overview") });
  }
  /**
   * The phase as an override left it, put back where the teacher is looking.
   *
   * `overridePhase` answers the whole `InstructorPhaseView`, so re-reading the
   * class would be a second answer to a question already answered, and would
   * throw away the evidence panel the teacher has open. Phase-state ids are
   * unique, so the patch is by id and needs no learner to aim at.
   */
  function applyPhase(answer: InstructorPhaseView & { note?: string }) {
    // The lever's sentence is the panel's to say, not a field of the phase.
    // `evidenceNeeded` is taken as answered, present or absent: a spread would
    // keep a wait an answer without one has just ended.
    const { note: _note, ...rest } = answer;
    const next: InstructorPhaseView = { ...rest, evidenceNeeded: answer.evidenceNeeded };
    const patch = (learner: InstructorLearnerDetail): InstructorLearnerDetail => ({
      ...learner,
      enrollments: learner.enrollments.map(enrollment => ({
        ...enrollment,
        phases: enrollment.phases.map(phase => (phase.id === next.id ? { ...phase, ...next } : phase)),
      })),
    });
    setLearners(current => current.map(patch));
    setSelection(current =>
      current && current.phase.id === next.id
        ? { learner: patch(current.learner), phase: { ...current.phase, ...next } }
        : current,
    );
    // Every lever leaves a row, so the trail beside it is read again.
    setAuditReload(value => value + 1);
    // The board is patched from the lever's own answer; the class's two
    // percentages, the sign-off queue and the help requests follow it without
    // re-reading the class the answer already covers.
    void refreshAround();
  }
  /**
   * One learner read again after a regrade of their phase moved its revision,
   * score and status on the server. Only that learner: a whole-class reload
   * would put the page back to loading, drop the evidence panel for a moment
   * and throw away the sentence the lever panel is showing about the regrade.
   */
  async function reloadLearner(userId: string) {
    try {
      const fresh = await instructorApi.learner(userId);
      setLearners((current) => current.map((learner) => (learner.userId === userId ? fresh : learner)));
      setAuditReload((value) => value + 1);
      void refreshAround();
    } catch (err) {
      setDetailError(describeError(err, "This learner could not be read again. Refresh records to see the regrade."));
    }
  }
  /**
   * One of the CSV exports, saved as the file the API names. `classOnly` asks
   * for this class alone (the routes' optional `?cohort=`); without
   * it the file covers every class of the teacher's, and its button says so.
   */
  async function download(kind: "grades" | "gradebook", classOnly = false) {
    if (exporting) return;
    const one = classOnly && cohort ? cohort : undefined;
    setExporting(one ? (kind === "grades" ? "classGrades" : "classGradebook") : kind);
    setError("");
    try {
      const label = one ? classFileLabel(one.name, one.id) : "";
      if (kind === "grades") saveBlob(await instructorApi.exportCsv(undefined, one?.id), exportFilename().replace(/\.csv$/, `${label}.csv`));
      else saveBlob(await instructorApi.exportGradebook(undefined, one?.id), gradebookFilename().replace(/\.csv$/, `${label}.csv`));
    } catch (err) {
      setError(
        describeError(
          err,
          kind === "grades"
            ? "The grades could not be exported. Try again in a moment."
            : "The grade book could not be exported. Try again in a moment.",
        ),
      );
    } finally {
      setExporting("");
    }
  }
  /**
   * Look at this learner's screens as they are. One POST records it; after
   * that this console's own credential makes instructor reads and every write
   * is refused in the browser and again at the API (lib/view-as). The banner
   * it raises is drawn by the frame, on every route, until it is stopped.
   */
  async function viewAs(learner: InstructorLearnerDetail) {
    if (openingView) return;
    setOpeningView(learner.userId);
    setError("");
    try {
      startViewAs(await instructorApi.viewAs(learner.userId));
      // The project cache is keyed on the token, and the token has not
      // changed, so nothing else would drop this teacher's own enrolment.
      resetProject();
      router.push("/dashboard");
    } catch (err) {
      setError(describeError(err, "That learner could not be viewed. Try again in a moment."));
      setOpeningView("");
    }
  }
  const firstName = (learner: InstructorLearnerDetail) =>
    learner.displayName.trim().split(/\s+/)[0] || learner.displayName;
  async function refreshCreatedClass(created: CohortView) {
    const owner = getToken();
    const version = loadVersion.current;
    setCreateRefreshError("");
    try {
      const profile = await api.me();
      if (!sameSession(getToken(), owner) || version !== loadVersion.current) return;
      setSession(profile);
      // The class list alone, read again to confirm the account reaches its
      // classes before leaving for the new one. Not the page's whole
      // load: that reads every learner of every class, the page it fills is
      // left at once, and the class page reads its own learners on arrival.
      const classes = await cohortsApi.mine();
      // A teacher who has left this page is not pulled back to the new class.
      if (!alive.current || !sameSession(getToken(), owner)) return;
      setCohorts(classes);
      // A new class has no project yet, so it opens on its Project tab;
      // the join code is under Invite and notes once there is something to join.
      router.push(classPageHref(created.id, { tab: "project" }));
    } catch (err) {
      if (alive.current && sameSession(getToken(), owner)) setCreateRefreshError(describeError(err, "Your account view could not be refreshed."));
    }
  }
  async function retryCreatedClassRefresh() {
    if (createPending.current || !createdReceipt) return;
    createPending.current = true; setCreating(true);
    try { await refreshCreatedClass(createdReceipt); }
    finally { createPending.current = false; setCreating(false); }
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createPending.current) return;
    createPending.current = true; setCreating(true);
    setError(""); setCreateRefreshError(""); setCreatedReceipt(null);
    try {
      let created: CohortView;
      try { created = await cohortsApi.create(className.trim()); }
      catch (err) { setError(describeError(err, "The class could not be created.")); return; }
      setCreatedReceipt(created);
      createdHere.current.push({ cohort: created, before: loadVersion.current });
      setCohorts(current => [...current.filter(item => item.id !== created.id), created]);
      setClassName(""); setShowCreate(false);
      await refreshCreatedClass(created);
    } finally {
      createPending.current = false; setCreating(false);
    }
  }
  // The class page's first row, from what is already on the page.
  const acknowledgeKnown = queue.every((row) =>
    Object.prototype.hasOwnProperty.call(feedback, row.submission.id),
  );
  const toAcknowledge = queue.filter(
    (row) => !feedback[row.submission.id]?.some((note) => note.action === "acknowledge"),
  ).length;
  // The bar's own rule, so the number and the phase map's cells count the same learners.
  const needsRevisionCount = associated.filter((learner) => {
    const key = currentKey(learner);
    const current = key ? enrollmentOf(learner)?.phases.find((phase) => phase.key === key) : undefined;
    const shown = current ? phaseCellRevision(current) : undefined;
    return (
      current?.status !== "passed" &&
      shown?.status === "completed" &&
      shown.passed === false &&
      !isReviewUnavailable(shown)
    );
  }).length;
  // Each class card's waiting count on the home, from the learners read.
  // The cards are drawn only once a read has answered (see the home's
  // branch below), so this count is always one that read made.
  const waitingByClass = awaitingSignoffByClass(learners);
  // What each export will hold, said before it is pressed.
  const classLearnerCount = associated.length;
  const everyLearner = new Set(classRows.map((row) => row.userId)).size;
  const everyClass = cohorts.length;
  const allScopeLine = `${everyLearner === 1 ? "1 learner" : `${everyLearner} learners`} across ${
    everyClass === 1 ? "1 class" : `${everyClass} classes`
  }`;
  // The page's parts, drawn once and placed by view.
  const metricsPart = (
    <>
          <div className={`exp-teacher-metrics${classView ? " is-class" : ""}`} data-testid="teacher-metrics">
            {/* Each number says whose it is: this class's on a class page, every class's on the home. */}
            {!classView && (
              <section className="exp-panel" data-scope="all">
                <span>Classes</span>
                <strong>{cohorts.length}</strong>
                <small>All your classes</small>
              </section>
            )}
            <section className="exp-panel" data-scope={classView ? "class" : "all"}>
              <span>Enrolled learners</span>
              <strong>
                {
                  associated.filter((learner) => Boolean(enrollmentOf(learner)))
                    .length
                }
              </strong>
              <small>{classView ? "This class" : "All your classes"}</small>
            </section>
            {classView && (
              <section className="exp-panel" data-scope="class" data-testid="metric-signoff">
                <span>Awaiting your sign-off</span>
                <strong>{signoffWaiting ?? "—"}</strong>
                <small>
                  This class.{" "}
                  <a
                    href={`#${SIGNOFF_QUEUE_ID}`}
                    className="exp-text-link"
                    style={{ textDecoration: "underline" }}
                    onClick={(event) => {
                      // Opens the Sign-off tab; the hash is left only when the queue is not drawn yet.
                      if (openSignoffQueue()) event.preventDefault();
                    }}
                  >
                    Open the sign-off queue
                  </a>
                </small>
              </section>
            )}
            {classView && (
              <section className="exp-panel" data-scope="class" data-testid="metric-revision">
                <span>Needs revision</span>
                <strong>{needsRevisionCount}</strong>
                <small>This class, at their current phase</small>
              </section>
            )}
            <section className="exp-panel" data-scope={classView ? "class" : "all"} data-testid="metric-acknowledge">
              <span>Latest submissions</span>
              <strong>{acknowledgeKnown ? toAcknowledge : "—"}</strong>
              <small>
                {acknowledgeKnown
                  ? `To acknowledge, ${classView ? "this class" : "all your classes"}`
                  : detailError
                    ? "Review status unavailable"
                    : "Loading teacher review status…"}
              </small>
            </section>
          </div>
    </>
  );
  // The class's records as files, each saying whose records it holds. On a
  // class page, this class's alone; the grade book and the long
  // export of every class of yours stay one press away, labelled so. Each
  // sub-line counts what is already on this page. On the home they are the
  // All classes block's.
  const exportsPart = (
      <div className="exp-actions exp-exports" data-testid="teacher-exports">
        {classView && cohort && (
          <span className="exp-export">
            <button
              type="button"
              className="exp-button"
              data-testid="export-class-gradebook"
              disabled={exporting !== ""}
              aria-busy={exporting === "classGradebook"}
              aria-describedby="export-class-scope"
              onClick={() => void download("gradebook", true)}
            >
              {exporting === "classGradebook" ? "Exporting…" : "Download this class\u2019s grade book"}
            </button>
            <small id="export-class-scope" className="exp-export-scope" data-testid="export-class-scope">
              {classLearnerCount === 1 ? "1 learner in this class" : `${classLearnerCount} learners in this class`}
            </small>
          </span>
        )}
        {classView && cohort && (
          <span className="exp-export">
            <button
              type="button"
              className="exp-button"
              data-testid="export-class-csv"
              disabled={exporting !== ""}
              aria-busy={exporting === "classGrades"}
              aria-describedby="export-class-scope"
              onClick={() => void download("grades", true)}
            >
              {exporting === "classGrades" ? "Exporting…" : "Download this class\u2019s grades"}
            </button>
          </span>
        )}
        <span className="exp-export">
          <button
            type="button"
            className="exp-button"
            data-testid="export-gradebook"
            disabled={exporting !== ""}
            aria-busy={exporting === "gradebook"}
            aria-describedby="export-all-scope"
            onClick={() => void download("gradebook")}
          >
            {exporting === "gradebook" ? "Exporting…" : "Download the grade book (all your classes)"}
          </button>
          <small id="export-all-scope" className="exp-export-scope" data-testid="export-all-scope">
            {allScopeLine}
          </small>
        </span>
        <span className="exp-export">
          <button
            type="button"
            className="exp-button"
            data-testid="export-csv"
            disabled={exporting !== ""}
            aria-busy={exporting === "grades"}
            aria-describedby="export-all-scope"
            onClick={() => void download("grades")}
          >
            {exporting === "grades" ? "Exporting…" : "Download the grades (all your classes)"}
          </button>
        </span>
        {/* The quiz results as one of four
            read-only files, saved and never drawn. None carries a key,
            an explanation, a question or an option. */}
        <form
          className="exp-actions"
          data-testid="export-quiz-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (exporting) return;
            const form = event.currentTarget;
            const kind = new FormData(form).get("kind") as QuizResultsExportKind;
            const submit = form.querySelector("button");
            if (submit?.disabled) return;
            if (submit) submit.disabled = true;
            form.setAttribute("aria-busy", "true");
            setError("");
            // The class page saves that class's file; teacher home, every class's.
            void (classView && cohort
              ? instructorApi.exportClassQuizResults(kind, cohort.id)
              : instructorApi.exportQuizResults(kind))
              .then((blob) => saveBlob(blob, `quiz-${kind}.csv`))
              .catch((err) =>
                setError(describeError(err, "The quiz results could not be exported. Try again in a moment.")),
              )
              .finally(() => {
                if (submit) submit.disabled = false;
                form.removeAttribute("aria-busy");
              });
          }}
        >
          <label className="exp-field">
            Quiz results
            <select name="kind" data-testid="export-quiz-kind" defaultValue={QUIZ_RESULTS_EXPORT_KINDS[0]}>
              {QUIZ_RESULTS_EXPORT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {(
                    {
                      learners: "One row per learner and quiz",
                      attempts: "Every attempt",
                      questions: "Every question drawn, right or wrong",
                      class: "Each question across the class",
                    } satisfies Record<QuizResultsExportKind, string>
                  )[kind]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="exp-button"
            data-testid="export-quiz-results"
            disabled={exporting !== ""}
          >
            Download the quiz results
          </button>
          <span className="exp-caption" data-testid="export-quiz-scope">
            {classView && cohort ? "For this class only." : "For every class of yours."}
          </span>
        </form>
      </div>
  );
  const mapPart = (
    <>
          <section className="exp-panel" ref={boardPanel}>
            <header className="exp-section-heading">
              <div>
                <h2>Learner phase map</h2>
                <p>Select a phase cell to inspect its submitted evidence.</p>
              </div>
              <div className="exp-tabs">
                <button
                  type="button"
                  aria-pressed={view === "map"}
                  onClick={() => {
                    askBoardReveal("map");
                    setView("map");
                  }}
                >
                  <LayoutGrid size={13} className="inline mr-2" />
                  Phase map
                </button>
                <button
                  type="button"
                  aria-pressed={view === "table"}
                  onClick={() => {
                    askBoardReveal("table");
                    setView("table");
                  }}
                >
                  <List size={13} className="inline mr-2" />
                  Table
                </button>
              </div>
            </header>
            {/* The files, here on a class page; on the home they sit in the All classes block. */}
            {classView && exportsPart}
            <div className="exp-filters">
              <label className="exp-field">
                Find a learner
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={presenting ? "Search name" : "Search name or email"}
                />
              </label>
              <label className="exp-field">
                Current phase
                <select
                  value={phaseFilter}
                  onChange={(event) =>
                    setPhaseFilter(event.target.value as PhaseKey | "")
                  }
                >
                  <option value="">All phases</option>
                  {boardKeys.map((key) => (
                    <option key={key} value={key}>
                      {PHASE_META[key].title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="exp-field">
                Latest verdict
                <select
                  value={verdictFilter}
                  onChange={(event) => setVerdictFilter(event.target.value)}
                >
                  <option value="">All results</option>
                  {VERDICT_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {/*
                The roster's order, offered where the table's
                two percentage columns are drawn. It is a select beside the
                filters rather than a header a teacher clicks, because the other
                four columns do not sort and a table with two sortable headers
                out of six reads as three that are broken.
              */}
              {view === "table" && (
                <label className="exp-field">
                  Sort by
                  <select
                    value={sort}
                    onChange={(event) => setSort(event.target.value as RosterSort)}
                  >
                    {ROSTER_SORTS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <ScrollRegion
              className="exp-scroll"
              label="Learner phase map and roster"
              hint={view === "map" ? "Scroll sideways to see every phase." : "Scroll sideways to read the full roster."}
            >
              <table className="exp-table">
                <thead>
                  <tr>
                    <th scope="col">Learner</th>
                    {view === "map" ? (
                      boardKeys.map((key) => (
                        <th scope="col" key={key}>{PHASE_META[key].title}</th>
                      ))
                    ) : (
                      <>
                        <th scope="col">Class</th>
                        <th scope="col">Current phase</th>
                        <th scope="col">Phases passed</th>
                        {/*
                          Two different questions, which is
                          why they are two columns and not one: the checklist is
                          how much of the required work is done, over the
                          version's tasks rather than its phases, and mastery is
                          how the concepts are going. `aria-sort` names whichever
                          one the roster is ordered by, so a screen reader is
                          told what the select above did.
                        */}
                        <th
                          scope="col"
                          aria-sort={sort === "checklist" ? "descending" : "none"}
                        >
                          Checklist
                        </th>
                        <th
                          scope="col"
                          aria-sort={sort === "mastery" ? "descending" : "none"}
                        >
                          Quiz mastery
                        </th>
                        <th scope="col">Latest submission</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((learner) => {
                    const enrollment = enrollmentOf(learner);
                    const latest = queue.find(
                      (row) => row.learner.userId === learner.userId,
                    );
                    return (
                      <tr key={learner.userId}>
                        <td>
                          <div className="exp-learner-identity">
                            {learner.avatar !== undefined && (
                              <LearnerAvatar
                                avatar={learner.avatar}
                                size={36}
                              />
                            )}
                            <div>
                              <strong>{learner.displayName}</strong>
                              {/* Hidden while the screen is shared. */}
                              {!presenting && <div className="exp-caption">{learner.email}</div>}
                              {awaitingClassProject(learner) && (
                                <div
                                  className="exp-caption"
                                  data-testid={`set-aside-${learner.userId}`}
                                >
                                  Has not started the class’s project yet
                                </div>
                              )}
                              {enrollment && (
                                <button
                                  type="button"
                                  className="exp-text-link"
                                  data-testid={`view-as-${learner.userId}`}
                                  disabled={openingView !== ""}
                                  onClick={() => void viewAs(learner)}
                                >
                                  {openingView === learner.userId ? "Opening…" : `View as ${firstName(learner)}`}
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                        {view === "map" ? (
                          boardKeys.map((key) => {
                            const phase = enrollment?.phases.find(
                              (item) => item.key === key,
                            );
                            return (
                              <td key={key}>
                                {phase ? (
                                  <button
                                    className="exp-cell-button"
                                    aria-label={`Inspect ${learner.displayName}, ${PHASE_META[key].title}`}
                                    onClick={() => void inspect(learner, phase)}
                                  >
                                    <TeacherBadge state={phaseCellState(phase, phaseCellRevision(phase))} />
                                    {evidenceWaitLine(phase) && (
                                      <small
                                        className="exp-caption block"
                                        data-testid={`evidence-wait-${learner.userId}-${key}`}
                                      >
                                        Waiting on a reviewed pass
                                      </small>
                                    )}
                                  </button>
                                ) : enrollment ? (
                                  // The learner's version does not hold this
                                  // phase: they will never have it, which
                                  // "Not started" would not say.
                                  <span className="exp-caption">
                                    Not in their version
                                  </span>
                                ) : (
                                  <span className="exp-caption">
                                    Not started
                                  </span>
                                )}
                              </td>
                            );
                          })
                        ) : (
                          <>
                            <td>{learner.cohortName ?? "—"}</td>
                            <td>
                              {currentKey(learner)
                                ? currentPhaseWords(PHASE_META[currentKey(learner)!].title, enrollment?.completed)
                                : "Not started"}
                            </td>
                            <td>
                              {/* Over the phases this learner's version holds. */}
                              {enrollment?.phases.filter(
                                (phase) => phase.status === "passed",
                              ).length ?? 0}{" "}
                              / {enrollment?.phases.length ?? boardKeys.length}
                            </td>
                            <td data-testid={`checklist-${learner.userId}`}>
                              {drawPercent(percentOf(learner, "checklistPercent"))}
                            </td>
                            <td data-testid={`mastery-${learner.userId}`}>
                              {drawPercent(percentOf(learner, "masteryPercent"))}
                            </td>
                            <td>
                              {latest ? (
                                <button
                                  className="exp-cell-button"
                                  onClick={() =>
                                    void inspect(
                                      learner,
                                      latest.phase,
                                      latest.submission.id,
                                    )
                                  }
                                >
                                  <TeacherBadge state={latestSubmissionState(latest.phase, latest.submission)} />
                                </button>
                              ) : (
                                "No submission"
                              )}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollRegion>
            {!visible.length && <p>No learners match these filters.</p>}
            {requestedLearner && (
              <Link className="exp-text-link" scroll={false} href={patchPageHref(pageHref, { learner: null })}>
                Show all learners
                <ArrowRight size={14} />
              </Link>
            )}
            <p className="exp-caption">
              Only associated learners and their submitted evidence appear here.
              Private mentor conversations are excluded.
            </p>
          </section>
    </>
  );
  const evidencePart = (
    <>
          {selection && (
            <section className="exp-stack" ref={evidencePanel}>
              <header className="exp-section-heading">
                <div>
                  <span className="exp-eyebrow">Submitted phase evidence</span>
                  <h2 ref={evidenceHeading} tabIndex={-1}>
                    {selection.learner.displayName} / {selection.phase.title}
                  </h2>
                </div>
                <button
                  className="exp-button"
                  onClick={() => {
                    updatePageQuery({ evidence: null, phase: null, submission: null });
                    requestAnimationFrame(() =>
                      inspectionTrigger.current?.focus(),
                    );
                  }}
                >
                  Close evidence
                </button>
                <Link
                  className="exp-text-link"
                  href={dossierHref(selection.learner, pageHref)}
                >
                  Print submitted evidence
                  <ArrowRight size={14} />
                </Link>
                {/* Their screens, as they are. */}
                <button
                  type="button"
                  className="exp-button"
                  data-testid="view-as-start"
                  disabled={openingView !== ""}
                  onClick={() => void viewAs(selection.learner)}
                >
                  {openingView === selection.learner.userId ? "Opening…" : `View as ${firstName(selection.learner)}`}
                </button>
              </header>
              {/* The phase reads passed on the board and the gate still waits:
                  said where the teacher who pulled the lever is
                  looking, including on a phase with one task, whose task
                  panel below draws nothing. */}
              {evidenceWaitLine(selection.phase) && (
                <p className="exp-inline-note" role="status" data-testid="evidence-needed-line">
                  {evidenceWaitLine(selection.phase)}. {evidenceWaitAdvice(selection.phase, firstName(selection.learner))}
                </p>
              )}
              <div className="exp-tabs flex-wrap">
                {enrollmentOf(selection.learner)?.phases.map((phase) => (
                  <button
                    key={phase.id}
                    aria-pressed={phase.id === selection.phase.id}
                    onClick={() => void inspect(selection.learner, phase)}
                  >
                    {PHASE_META[phase.key].title}
                  </button>
                ))}
              </div>
              {/* The per-task levers, where the teacher already is. It
                  draws nothing at all on a phase whose compiled list is the
                  synthesised sole task, because the three levers are refused
                  there by name and the phase's own levers are the levers. */}
              <LearnerTasks
                key={selection.phase.id}
                userId={selection.learner.userId}
                learnerName={selection.learner.displayName}
                phase={selection.phase}
                onPhase={applyPhase}
                onOpenSubmission={(submission) => updatePageQuery({ submission })}
              />
              {/* The phase's own levers: Pass, Reopen, Reset the workspace,
                  Reset this phase, and a regrade of this learner's phase.
                  /instructor/learners/[id] redirects here, so without them a
                  phase with one task would have no lever at all. */}
              {enrollmentOf(selection.learner) && (
                <PaneBoundary label="The phase levers" testId="phase-levers-failed">
                <PhaseLevers
                  key={`levers-${selection.phase.id}`}
                  userId={selection.learner.userId}
                  learnerName={firstName(selection.learner)}
                  projectSlug={enrollmentOf(selection.learner)!.projectSlug}
                  phase={selection.phase}
                  onPhase={applyPhase}
                  onRegraded={() => void reloadLearner(selection.learner.userId)}
                />
                </PaneBoundary>
              )}
              {selecting ? (
                <LoadingState />
              ) : detailError ? (
                <div><p role="alert" className="exp-error">{detailError}</p><button className="exp-button" type="button" onClick={() => setEvidenceReload(value => value + 1)}>Retry evidence</button></div>
              ) : history.length ? (
                <>
                  <label className="exp-field">
                    Submission history
                    <select
                      value={selectedId}
                      onChange={(event) => updatePageQuery({ submission: event.target.value })}
                    >
                      {!selectedId && <option value="" disabled>Choose a recorded review</option>}
                      {[...history].reverse().map((row, index) => (
                        <option key={row.id} value={row.id}>
                          Review {row.attempt ?? history.length - index},{" "}
                          {revisionTaskPrefix(selection?.phase, row.id)}
                          {formatDate(row.createdAt)},{" "}
                          {teacherVerdict(row).label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedId ? <SubmissionEvidence
                    teacher
                    drafts={feedbackDrafts}
                    draftScope={{ learnerId: selection.learner.userId, phaseId: selection.phase.id, submissionId: selectedId }}
                    key={selectedId}
                    submissionId={selectedId}
                    onFeedback={(note) =>
                      setFeedback((current) => current[selectedId]?.some(item => item.id === note.id) ? current : ({
                        ...current,
                        [selectedId]: [...(current[selectedId] ?? []), note],
                      }))
                    }
                  /> : <p role="alert" className="exp-error">This review is not in the selected phase. Choose a recorded review from the history.</p>}
                </>
              ) : (
                <section className="exp-panel">
                  <h3>No submitted work in this phase yet.</h3>
                  <p>
                    The learner’s private drafts and mentor conversations are
                    not included.
                  </p>
                </section>
              )}
              {/* Every lever on this page leaves a row here, including the
                  three per-task ones, so the record is read beside the work
                  rather than on a page of its own. */}
              {auditError ? (
                <div>
                  <p role="alert" className="exp-error">{auditError}</p>
                  <button className="exp-button" type="button" onClick={() => setAuditReload(value => value + 1)}>
                    Retry the record of changes
                  </button>
                </div>
              ) : audit === null ? (
                <p role="status">Reading the record of changes…</p>
              ) : (
                <AuditList
                  events={audit}
                  testId="learner-audit"
                  purpose={`Recorded changes on ${selection.learner.displayName}, newest first. Every override and every task lever leaves a row with the reason you gave.`}
                  emptyBody="No staff change has been recorded on this learner."
                />
              )}
            </section>
          )}
    </>
  );
  const workPart = (
    <>
          <div className="exp-grid">
            <section className="exp-panel">
              <header className="exp-section-heading">
                <div>
                  <span className="exp-eyebrow">{classView ? "This class" : "All your classes"}</span>
                  <h2>Where the work is happening.</h2>
                  <p>
                    {associated.length} associated {pluralWord(associated.length, "learner")}
                    {projectsInView.length
                      ? ` / ${projectsInView.join(", ")}`
                      : ""}
                  </p>
                </div>
                <UsersRound size={23} />
              </header>
              <div className="exp-legend">
                <span>
                  <i className="is-active" />
                  In progress
                </span>
                <span>
                  <i className="is-pass" />
                  Phase passed
                </span>
                <span>
                  <i className="is-revision" />
                  Needs revision
                </span>
              </div>
              {boardKeys.map((key) => {
                const group = associated.filter(
                  (learner) => currentKey(learner) === key,
                );
                const passed = group.filter(
                  (learner) =>
                    enrollmentOf(learner)?.phases.find(
                      (phase) => phase.key === key,
                    )?.status === "passed",
                ).length;
                const revised = group.filter((learner) => {
                  const current = enrollmentOf(learner)?.phases.find(
                    (phase) => phase.key === key,
                  );
                  // The cell's own rule, so the bar and the cells
                  // count the same learners as needing revision.
                  const shown = current ? phaseCellRevision(current) : undefined;
                  return (
                    current?.status !== "passed" &&
                    shown?.status === "completed" &&
                    shown.passed === false &&
                    !isReviewUnavailable(shown)
                  );
                }).length;
                const active = group.length - passed - revised;
                const max = Math.max(
                  1,
                  ...boardKeys.map(
                    (phaseKey) =>
                      associated.filter(
                        (learner) => currentKey(learner) === phaseKey,
                      ).length,
                  ),
                );
                const bar = (
                  <>
                    <span>{PHASE_META[key].title}</span>
                    <span className="exp-bar">
                      <i
                        className="is-active"
                        style={{ width: `${(active / max) * 100}%` }}
                      >
                        {active || ""}
                      </i>
                      <i
                        className="is-pass"
                        style={{ width: `${(passed / max) * 100}%` }}
                      >
                        {passed || ""}
                      </i>
                      <i
                        className="is-revision"
                        style={{
                          width: `${(revised / max) * 100}%`,
                        }}
                      >
                        {revised || ""}
                      </i>
                    </span>
                    <strong>{group.length}</strong>
                  </>
                );
                // A bar filters the roster, so it is a press only where the
                // roster is drawn; on the home it is a row that reads.
                return rosterShown ? (
                  <button
                    type="button"
                    key={key}
                    className="exp-bar-row w-full text-left"
                    aria-pressed={phaseFilter === key}
                    onClick={() =>
                      setPhaseFilter((current) => (current === key ? "" : key))
                    }
                  >
                    {bar}
                  </button>
                ) : (
                  <div key={key} className="exp-bar-row" data-testid={`work-bar-${key}`}>
                    {bar}
                  </div>
                );
              })}
              <p className="exp-caption">
                {/* What a bar counts, said plainly: a learner who has
                    passed five phases is counted at the sixth, so the five
                    read 0 for them, which read as a fault without this. */}
                Each learner is counted once, at the phase they are in now,
                not at the phases they passed before it.{" "}
                {associated.filter((learner) => !enrollmentOf(learner)).length}{" "}
                have not started the project.
                {rosterShown && " Select a phase to filter the roster."}
              </p>
            </section>
            <section className="exp-panel">
              <header className="exp-section-heading">
                <div>
                  <span className="exp-eyebrow">To acknowledge</span>
                  <h2>Latest submissions</h2>
                  <p>The newest submission from each learner, with its review&rsquo;s verdict. Open one to read it and acknowledge it.</p>
                </div>
              </header>
              {detailError && !selection && (
                <p role="alert" className="exp-error">
                  {detailError}
                </p>
              )}
              <ul className="exp-list">
                {queue
                  .filter(
                    (row) =>
                      !feedback[row.submission.id]?.some(
                        (note) => note.action === "acknowledge",
                      ),
                  )
                  .slice(0, ACKNOWLEDGE_ROWS_SHOWN)
                  .map((row) => (
                    <li key={row.submission.id}>
                      <button
                        type="button"
                        className="exp-row w-full text-left"
                        onClick={() =>
                          void inspect(
                            row.learner,
                            row.phase,
                            row.submission.id,
                          )
                        }
                      >
                        {row.learner.avatar !== undefined && (
                          <LearnerAvatar
                            avatar={row.learner.avatar}
                            size={40}
                          />
                        )}
                        <div>
                          <strong>{row.learner.displayName}</strong>
                          <small>
                            {row.phase.title},{" "}
                            {formatDate(row.submission.createdAt)}
                          </small>
                        </div>
                        <TeacherBadge state={latestSubmissionState(row.phase, row.submission)} />
                      </button>
                    </li>
                  ))}
              </ul>
              {!queue.length && (
                <p>
                  Submitted work will appear here when your learners begin
                  submitting.
                </p>
              )}
              {queue.length > 0 &&
                queue.every((row) =>
                  feedback[row.submission.id]?.some(
                    (note) => note.action === "acknowledge",
                  ),
                ) && (
                  <p>
                    <Check size={16} className="inline mr-2" />
                    All latest submissions have been acknowledged.
                  </p>
                )}
            </section>
          </div>
    </>
  );
  const helpPart = (
    <>
          <StuckList
            cohortId={classView ? selectedClass : undefined}
            refreshRound={refreshRound}
            learnerIds={associated.map((learner) => learner.userId)}
            onInspect={(request) => {
              const learner = associated.find((item) => item.userId === request.userId);
              const phase = learner && enrollmentOf(learner)?.phases.find((item) => item.id === request.phaseStateId);
              if (learner && phase) void inspect(learner, phase);
            }}
          />
    </>
  );
  const signoffPart = (
    <>
          {classView && cohort && (
            <SignoffQueue
              cohortId={cohort.id}
              refreshRound={refreshRound}
              onSigned={() => void refresh()}
              onWaiting={setSignoffWaiting}
              inUse={classUsesSignoff(associated.flatMap((learner) => learner.enrollments))}
              readVersionMarks={versionInForceMarksSignoff}
            />
          )}
    </>
  );
  // The class's own panels: what it works on, what it hears from its teacher,
  // and how learners join it. Each is addressed to one class, so none belongs
  // on the view across every class. On the class page they sit under the
  // Project and Invite and notes tabs.
  const projectPart = (
    <>
          {classView && cohort && <ClassProjectCard cohortId={cohort.id} onAssigned={() => setAssignmentRound((round) => round + 1)} />}
    </>
  );
  const notesPart = (
    <>
          {classView && cohort && <NotesCard cohortId={cohort.id} phases={boardKeys} />}
    </>
  );
  const invitePart = (
    <>
          {classView && cohort && (
            <section className="exp-panel exp-row">
              <div>
                <span className="exp-eyebrow">Invite your learners</span>
                <h2>{cohort.name}</h2>
                <p>
                  Share this code. Joining is optional and preserves existing
                  project work.
                </p>
              </div>
              {/* "Copied." is drawn under the buttons here, so it never moves them. */}
              <div className="exp-invite-code">
                <span className="exp-caption">Class join code</span>
                <JoinCode code={cohort.joinCode} />
              </div>
            </section>
          )}
    </>
  );
  const classesPart = (
    <>
          {!classView && (
            <section className="exp-panel">
              <header className="exp-section-heading">
                <h2>Your classes</h2>
              </header>
              {cohorts.length ? (
                // One card per class. The row link opens the class, and
                // the card's own ground opens it too (CSS); the code's two
                // buttons and the queue link sit above that, never inside it.
                <ul className="exp-list exp-class-cards" data-testid="teacher-class-cards">
                  {cohorts.map((item) => (
                    <li key={item.id} data-testid={`class-card-${item.id}`}>
                      <Link
                        className="exp-row"
                        href={classPageHref(item.id)}
                      >
                        <div>
                          <strong>{item.name}</strong>
                          <small>
                            {item.memberCount} {pluralWord(item.memberCount, "learner")}
                          </small>
                        </div>
                        <ArrowRight size={17} />
                      </Link>
                      {/* The code and its two buttons sit beside the row link, never inside it. */}
                      <JoinCode code={item.joinCode} compact />
                      {/* The queue itself is read on the class page only; the count is
                          the learners this page has already read (class-tabs.ts). */}
                      {user && user.role !== "LEARNER" && (
                        <div className="exp-class-card-signoff">
                          <Link
                            className="exp-text-link"
                            style={{ textDecoration: "underline" }}
                            href={classPageHref(item.id, { hash: SIGNOFF_QUEUE_ID })}
                            aria-label={`Sign-off queue for ${item.name}`}
                          >
                            Sign-off queue
                          </Link>
                          <small data-testid={`class-card-waiting-${item.id}`}>
                            {waitingByClass.get(item.id) ?? 0} awaiting your sign-off
                          </small>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  You have no classes yet. Create a class to invite your first
                  learners.
                </p>
              )}
            </section>
          )}
    </>
  );
  // The files that cover every class at once. The phase map is a class's,
  // so on the home they keep a block of their own.
  const allClassesPart = (
    <>
          {!classView && (
            <section className="exp-panel" data-testid="teacher-all-classes" aria-labelledby="teacher-all-classes-title">
              <header className="exp-section-heading">
                <h2 id="teacher-all-classes-title">All classes</h2>
              </header>
              {exportsPart}
            </section>
          )}
    </>
  );
  const leversPart = (
    <>
          {/* A class's dates and the class-wide regrade, mounted on the class
              page (under its Dates and regrades tab) because /instructor
              redirects to these pages. */}
          {/* A panel that cannot draw itself costs that panel, never the
              roster and the evidence above it. */}
          <PaneBoundary label="Dates and regrades" testId="class-levers-failed">
            <ClassLevers
              cohortId={classView ? cohort?.id : undefined}
              assignmentRound={assignmentRound}
              projects={leverProjects}
              onRegraded={() => void load(false)}
              onOpenProject={classView ? openProjectTab : undefined}
            />
          </PaneBoundary>
    </>
  );
  return (
    <ExperiencePage
      title={
        classView
          ? (cohort?.name ?? "Your class")
          : "My classes"
      }
      eyebrow={classView ? "Your class, at a glance" : "Teaching"}
      active="class"
      variant="teacher"
      actions={
        <>
          {classView && (
            <Link href="/teacher" className="exp-button">
              <ArrowLeft size={15} />
              All classes
            </Link>
          )}
          {/* The class's sign-off queue, under this page's Sign-off tab. */}
          {classView && cohort && user && user.role !== "LEARNER" && (
            <a
              href={`#${SIGNOFF_QUEUE_ID}`}
              className="exp-button"
              onClick={(event) => {
                // The Sign-off tab opens and focus moves to the queue itself; no
                // hash is left to be read as an arrival later.
                if (openSignoffQueue()) event.preventDefault();
              }}
            >
              Sign-off queue
            </a>
          )}
          {/* The class's quiz results as charts, on a page of their own. */}
          {classView && cohort && user && user.role !== "LEARNER" && (
            <Link
              href={`/teacher/class/quiz-results?class=${encodeURIComponent(cohort.id)}`}
              className="exp-button"
              data-testid="quiz-results-link"
            >
              {QUIZ_RESULTS_COPY.link}
            </Link>
          )}
          {/* How fresh the records are, and the class-level read again. */}
          <span className="exp-freshness" role="status" data-testid="class-updated">
            {updatedAt && !staleAt ? `Updated ${clockTime(updatedAt)}` : ""}
          </span>
          <button
            type="button"
            className="exp-button"
            data-testid="class-refresh"
            disabled={refreshing || loading}
            aria-busy={refreshing || undefined}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <PresentationToggle />
          <details className="exp-action-menu">
            <summary className="exp-button" aria-label="More teacher options">
              <MoreHorizontal size={18} />
            </summary>
            <div>
              {/* The authoring surface. Its API lives under /instructor; the
                  pages a teacher opens live here under /teacher. */}
              <Link href="/teacher/projects">Your projects</Link>
              {/* The teacher guide, staff only. */}
              {user && user.role !== "LEARNER" && <Link href="/teacher/guide">Teacher guide</Link>}
              <Link href="/teacher/settings">Class data</Link>
              <button onClick={() => void load()} disabled={loading}>
                <RefreshCw size={15} />
                Refresh records
              </button>
              {/* On a class's page, Create class is a secondary action. */}
              {classView && (
                <button
                  type="button"
                  disabled={creating}
                  data-testid="create-class-menu"
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    setShowCreate((value) => !value);
                  }}
                >
                  <Plus size={15} />
                  Create a class
                </button>
              )}
            </div>
          </details>
          {!classView && (
            <button
              className="exp-button exp-primary"
              disabled={creating}
              onClick={() => setShowCreate((value) => !value)}
            >
              <Plus size={15} />
              Create class
            </button>
          )}
        </>
      }
    >
      {error && (
        <p role="alert" className="exp-error">
          {error}
        </p>
      )}
      {/* A read that failed keeps the earlier one on screen, and says so. */}
      {staleAt && (
        <p role="status" className="exp-inline-note" data-testid="class-stale">
          Could not refresh at {clockTime(staleAt)}. Showing the earlier read.
        </p>
      )}
      {presentationOn && (
        <p role="status" className="exp-inline-note" data-testid="presentation-view-on">
          Presentation view is on: learners&rsquo; email addresses are hidden on these pages. Nothing else has changed.
        </p>
      )}
      {createdReceipt && (
        <section className="exp-panel" aria-label="Created class">
          <p role="status"><strong>{createdReceipt.name}</strong> was created. Give it a project, then share its join code with your learners.</p>
          {/* Masked until Show code; Copy code copies it unseen. */}
          <JoinCode code={createdReceipt.joinCode} />
          {createRefreshError && <p role="alert">Your class is saved. The account view could not refresh. {createRefreshError}</p>}
          <div className="exp-actions">
            <Link className="exp-button exp-primary" href={classPageHref(createdReceipt.id, { tab: "project" })}>Open created class</Link>
            {createRefreshError && <button type="button" className="exp-button" disabled={creating} onClick={() => void retryCreatedClassRefresh()}>{creating ? "Refreshing account…" : "Retry account refresh"}</button>}
          </div>
        </section>
      )}
      {showCreate && (
        <section className="exp-panel">
          <h2>Create a class</h2>
          <p>
            Start with an empty class and share its generated join code with
            learners.
          </p>
          <form className="exp-form" onSubmit={create}>
            <label className="exp-field">
              Class name
              <input
                required
                minLength={CLASS_NAME_MIN}
                maxLength={CLASS_NAME_MAX}
                value={className}
                onChange={(event) => setClassName(event.target.value)}
                placeholder="Software Delivery / Cohort 26"
              />
            </label>
            <div className="exp-actions">
              <button
                className="exp-button exp-primary"
                disabled={creating || className.trim().length < 2}
              >
                {creating ? "Creating…" : "Create class"}
              </button>
              <button
                type="button"
                className="exp-button"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}
      {(loading && learners.length === 0) || assignmentPending || learnerClassId ? (
        // `learnerClassId`: the home is on its way to that learner's class page.
        // The loading line alone: nothing is drawn below it before the read
        // answers, so nothing drawn there moves when the rest arrives.
        <LoadingState />
      ) : !classView && updatedAt === null ? (
        // The home's first read failed and none has answered since: the
        // alert above says so, and nothing is drawn that a read would have had
        // to count (no "0 learners", no "0 awaiting", no "no classes yet").
        // Refresh reads the whole page again.
        null
      ) : classView ? (
        // A class's page leads with this class's numbers, then one row of
        // tabs and one section in view. Overview is the
        // phase map or table, the evidence opened from it, the latest
        // submissions and the help requests (one row when there are none).
        // Every section stays mounted under its tab, hidden while another is
        // open, so a draft in one survives a look at another.
        <>
          {metricsPart}
          <Tabs
            value={tab}
            onChange={(key) => selectTab(classTabOf(key))}
            label="Class sections"
            panelId={CLASS_TAB_PANEL_ID}
            className="exp-class-tabs flex-wrap"
            items={CLASS_TABS.map((item) => ({
              key: item.key,
              testId: `class-tab-${item.key}`,
              label:
                item.key === "signoff" && signoffWaitingSuffix(signoffWaiting) ? (
                  <>
                    {item.label}
                    {/* Read as part of the tab's name: "Sign-off, 2 waiting". */}
                    <span className="sr-only">, </span>
                    <span className="exp-class-tab-count" data-testid="class-tab-signoff-count">
                      {`${signoffWaiting} waiting`}
                    </span>
                  </>
                ) : (
                  item.label
                ),
            }))}
          />
          <div className="exp-class-sections" {...tabPanelProps(CLASS_TAB_PANEL_ID, tab)}>
            <div className="exp-teacher-flow" data-class-section="overview" hidden={tab !== "overview"}>
              {mapPart}
              {evidencePart}
              {workPart}
              {helpPart}
            </div>
            <div className="exp-teacher-flow" data-class-section="signoff" hidden={tab !== "signoff"}>
              {signoffPart}
            </div>
            <div className="exp-teacher-flow" data-class-section="project" hidden={tab !== "project"}>
              {projectPart}
            </div>
            <div className="exp-teacher-flow" data-class-section="dates" hidden={tab !== "dates"}>
              {leversPart}
            </div>
            <div className="exp-teacher-flow" data-class-section="invite" hidden={tab !== "invite"}>
              {invitePart}
              {notesPart}
            </div>
          </div>
        </>
      ) : (
        // The home across every class: the numbers, what needs the
        // teacher now, the classes, and the files that cover them all. The
        // phase map, the dates and the regrade are a class's, on its page.
        <>
          {metricsPart}
          {helpPart}
          {workPart}
          {evidencePart}
          {classesPart}
          {learnerMapFallback && mapPart}
          {allClassesPart}
        </>
      )}
    </ExperiencePage>
  );
}
export function TeacherPortal({ classView = false }: { classView?: boolean }) {
  return (
    <Suspense fallback={<LoadingState />}>
      <Portal classView={classView} />
    </Suspense>
  );
}
