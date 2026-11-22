'use client';

import type { ComponentType } from 'react';
import type {
  DrillState,
  EnrollmentView,
  ExecutionRunView,
  PhaseDetail,
  PhaseLink,
  SubmissionView,
} from '@learnsdlc/shared';
import type { PersonaThread } from '@/components/shell';
import type { DrillHealthResult, DrillIncident, DrillStartResult } from '@/lib/api';
import type { IconName } from '@/components/Icon';
import type { Theme } from '@/lib/theme';

export interface PhasePanelHelpers {
  /** Save now, then run the sandbox; switches the right pane to Tests. Same as the header button. */
  runNow: () => void;
  /** Save now, then open/update the pull request; switches to Feedback. Same as ⌘↵. */
  submitNow: () => void;
  /** Flush pending edits. Rejects if the save fails; pending edits stay pending. */
  flushSave: () => Promise<void>;
  /** Open a path in the editor (and switch to the Code pane on narrow screens). */
  openFile: (path: string) => void;
  /** Current text of a path: the unsaved buffer if there is one, else the server copy, else ''. */
  fileText: (path: string) => string;
  /**
   * One submission by id, with its `workspaceSnapshot`. The only fetch a panel
   * may ask for: the list on `submissions` carries no snapshots, so the files a
   * revision was graded on can only come from here.
   */
  loadSubmission: (id: string) => Promise<SubmissionView>;
  setPane: (pane: 'task' | 'code' | 'panel') => void;
  setTab: (tab: 'mentor' | 'tests' | 'feedback' | 'phase') => void;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
  /** A run or a submission is in flight. */
  busy: boolean;
  saving: 'idle' | 'dirty' | 'saving' | 'saved';
  /**
   * An Agentic operation owns the room's saved copy (a proposal being made or
   * applied): forms over a record lock, as the code editor does.
   */
  agentBusy?: boolean;
}

/** The three drill calls, already bound to this phase. Each rejects with an ApiError. */
export interface DrillApi {
  /** Pages the learner: seeds the state and runs the smoke check against the faulted copy. */
  start: () => Promise<DrillStartResult>;
  /** Runs the smoke check against the files as saved right now. */
  health: () => Promise<DrillHealthResult>;
  /** Records INCIDENT-1. Rejects with a 409 while the smoke check still fails. */
  resolve: (incident: DrillIncident) => Promise<DrillState>;
}

export interface PhasePanelProps {
  detail: PhaseDetail;                 // key, order, title, files, rubric, objectives, taskPanel, canRun, runLabel, lastSubmission, updatedAt, status, bestScore, attempts, reflection, projectSlug, artifactKind
  files: Record<string, string>;       // live editor buffers, path → content
  /** Write a file. Silently ignored for a read-only path; debounced-saves like typing does. */
  setFile: (path: string, content: string) => void;
  activePath: string;
  submission: SubmissionView | null;   // the verdict this tab is holding
  run: ExecutionRunView | null;
  enrollment: EnrollmentView | null;   // null until it loads, and for a phase whose enrolment 404s
  theme: Theme;
  /** Learner-made links for this phase, newest write wins. Empty until they load. */
  links: PhaseLink[];
  /** Replace the phase's link set and save it. Rejects if the save fails; the props keep the old set. */
  setLinks: (links: PhaseLink[]) => Promise<void>;
  /**
   * What the sandbox will call today when this phase runs: an ISO date, or
   * null for the machine's clock. Testing only: a suite about overdue work is
   * only reproducible if the day it runs on is a decision rather than an
   * accident.
   */
  runClock: string | null;
  /**
   * Pin the clock, or clear it to the machine's with null, and save it.
   * Rejects if the save fails; the props keep the old value. It spends no
   * attempt, clears no run-before-submit and invalidates no verdict.
   */
  setRunClock: (date: string | null) => Promise<void>;
  /** Every verdict for this phase, oldest first. Loaded once per phase and refreshed after each verdict. */
  submissions: SubmissionView[];
  /** Every sandbox run for this phase, oldest first. */
  runs: ExecutionRunView[];
  /** Deployment only: null until the learner is paged. */
  drill: DrillState | null;
  drillApi: DrillApi;
  /** Refetch the phase (files, links, drill, verdict): after a write the page did not make. */
  reloadPhase: () => Promise<void>;
  helpers: PhasePanelHelpers;
  /**
   * The phase's one conversation with its reviewer. A panel that
   * draws a failing test can ask about it in the thread the learner already
   * has; `helpers.setTab('mentor')` is what brings it into view.
   */
  thread?: PersonaThread | null;
  /** The view a room opens on, from the page's `?panel=` (Deployment: 'runbook' opens the Runbook view). */
  initialView?: string;
  /**
   * The record fields the assistant changed and the learner has not edited
   * since, as `<list>:<id>:<field>` (Deployment's runbook): each carries the
   * "changed by the assistant" mark.
   */
  assisted?: Set<string>;
}

export interface PhasePanel {
  /** Extra card at the foot of the left brief pane. */
  Brief?: ComponentType<PhasePanelProps>;
  /** Extra tab in the right pane. */
  Tools?: ComponentType<PhasePanelProps>;
  /** Right-tab label. Required when Tools is given; keep it one short word. */
  toolsLabel?: string;
  toolsIcon?: IconName;
}
