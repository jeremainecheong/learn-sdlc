'use client';

/**
 * One version of one project, as its author sees it.
 *
 * One section at a time: Overview, each phase, Validate and Publish are
 * tabs under the project's header, the open one named in the address as
 * `?section=`; the selected phase lists its tasks in order. Overview, Validate,
 * Publish and the open phase stay mounted (hidden) while another tab is open;
 * only the open phase's builder is mounted, and opening another phase closes
 * the open phase's forms. Four rules hold the surface
 * together, and each one is a thing the API also enforces: this page is the
 * near half of a guarantee, never the whole of it.
 *
 * **Every sentence a teacher reads about a refusal is the contract's.** The
 * gate beside a phase, the failures in the report, the reason Publish is off
 * and the refusal a save comes back with are all printed unchanged. This page
 * writes copy about what a teacher is *doing*; it never writes copy about what
 * the server *decided*.
 *
 * **A version that is not editable is drawn as read-only, with the reason.** A
 * published version never changes, the platform's project is copy-only, and a
 * project that is not the caller's is not theirs to change: three different
 * facts with three different sentences, rather than one greyed page.
 *
 * **Every task mutation answers with the phase and a fresh report**, so the
 * editor never has to guess what a save did and the report on screen is never
 * one save out of date.
 *
 * **The files are not loaded until they are asked for.** A copied project
 * carries its whole workspace, and opening an editor is not a reason to pull
 * every byte of it across.
 *
 * **A published version carries the door to the next draft.** `DraftVersionView`
 * says nothing about the project around it (which version is the published
 * head, whether a draft is already open, whether the project is the caller's)
 * and all three decide what that door may honestly say. So the summary is read
 * once, and only for a version that is not a draft, and each of the contract's
 * refusals is drawn before it can be met rather than after: a draft already
 * open becomes a link to that draft, and a project that is not the caller's
 * says so in the sentence the door would have answered with.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AddTaskBody,
  AuthoredProjectSummary,
  AuthoringFileView,
  DraftPhaseView,
  DraftTaskView,
  DraftVersionView,
  PhaseKey,
  TaskMutationResult,
  UpdateTaskBody,
  ValidationReport,
} from '@learnsdlc/shared';
import {
  QUIZ_ONLY_ADD_REFUSAL,
  RUNBOOK_JSON,
  CHANGE_REQUEST_JSON,
  PHASE_TITLES,
  plainTextNotesOn,
} from '@learnsdlc/shared';
import { AppShell } from '@/components/AppShell';
// The learner rooms' own predicate for "the reference's application".
import { runsReferenceApplication } from '@/components/workspace/application';
import { Button, Chip, Notice, Section } from '@/components/ui';
import { PhaseTasks } from '@/components/staff/projects/PhaseTasks';
import { PhasesCard } from '@/components/staff/projects/PhasesCard';
import { PhaseScenario, inheritedRemovalSentence } from '@/components/staff/projects/PhaseScenario';
import { ProjectFiles } from '@/components/staff/projects/ProjectFiles';
import { draftHref } from '@/components/staff/projects/ProjectsLibrary';
import { PublishPanel } from '@/components/staff/projects/PublishPanel';
import { ExportButton, ExportOutcomeNotice, type ExportOutcome } from '@/components/staff/projects/ExportButton';
import { TaskEditor } from '@/components/staff/projects/TaskEditor';
import { ValidationReportPanel, failedCheckCount } from '@/components/staff/projects/ValidationReportPanel';
import { EditorNav, type ValidateMark } from '@/components/staff/projects/EditorNav';
import {
  EDITOR_SECTION_KEYS,
  isPhaseSection,
  sectionFromSearch,
  sectionPanelProps,
  writeSection,
  type EditorSection,
} from '@/components/staff/projects/editor-sections';
import { BAR_HEIGHT_VAR, BELOW_BAR, MEASURE, WIDE_PAGE } from '@/components/staff/projects/page-frame';
import { EditorSaveProvider, RunSaveReport, type EditorSaveState } from '@/components/staff/projects/save-status';
import { describeError } from '@/lib/api';
import { projectsApi, type AuthoredVersionRow } from '@/lib/api-projects';
import { useSession } from '@/lib/session';
import { executableOf } from '@/components/staff/projects/executable';
import { RuntimeProfileLine } from '@/components/staff/projects/RuntimeProfileLine';
import { PartialVersionBudget, configPhaseBudget, versionCountIsExact } from '@/components/staff/projects/VersionBudget';
import { ExecutableSummary, SmokeDrillReadOnly } from '@/components/staff/projects/ExecutableTask';
import { BudgetCeiling } from '@/components/staff/projects/BudgetCeiling';
import { DeepValidationPanel } from '@/components/staff/projects/DeepValidationPanel';
import { ExecutableEditor } from '@/components/staff/projects/ExecutableEditor';
import { RequirementsBuilder, requirementsBuilderTask } from '@/components/staff/projects/requirements/RequirementsBuilder';
import { DesignBuilder, designBuilderTask } from '@/components/staff/projects/design/DesignBuilder';
import { DeploymentBuilder, deploymentBuilderTask } from '@/components/staff/projects/deployment/DeploymentBuilder';
import { startingRunbookWarning } from '@/components/staff/projects/deployment/deployment-builder-model';
import { MaintenanceBuilder, maintenanceBuilderTask } from '@/components/staff/projects/maintenance/MaintenanceBuilder';
import { ImplementationBuilder, implementationBuilderTask } from '@/components/staff/projects/implementation/ImplementationBuilder';
import { TestingBuilder, testingBuilderTask } from '@/components/staff/projects/testing/TestingBuilder';
import { startingChangeWarning } from '@/components/staff/projects/maintenance/maintenance-builder-model';
import { type GuideMark, guideMarkKey, readGuideMark, writeGuideMark } from '@/components/staff/guide/guide-marks';
import type { DeepValidationView } from '@learnsdlc/shared';
import { GuideRail } from '@/components/staff/guide/GuideRail';
import { InlineHelp, InterviewHint } from '@/components/staff/guide/InlineHelp';
import { deriveGuideSteps } from '@/components/staff/guide/guide-steps';
import { NextDraft, isWithdrawn, nextDraftAnnouncement, readOnlyReason } from '@/components/staff/projects/next-draft';

export function ProjectEditor({ projectId, versionId }: { projectId: string; versionId: string }) {
  const user = useSession();
  const router = useRouter();

  const [view, setView] = useState<DraftVersionView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [phaseKey, setPhaseKey] = useState<PhaseKey | ''>('');
  /**
   * The section on screen: Overview, one phase, Validate or Publish,
   * read from `?section=` when the page opens. Overview is the default. A
   * phase named here is also the phase the editor opens on; `phaseKey` stays
   * the phase last opened while another section is on screen, so its panel
   * keeps what was typed in it.
   */
  const [section, setSection] = useState<EditorSection>(() =>
    typeof window === 'undefined' ? 'overview' : sectionFromSearch(window.location.search),
  );
  const askedSection = useRef(section);
  // Something on this draft was saved from this page: the
  // process checklist folds to its one line so the phases lead the page.
  const [editedHere, setEditedHere] = useState(false);
  // The editor's own saves (a task form, a move, a removal), for the one save status.
  const [runSave, setRunSave] = useState<{ state: EditorSaveState; message: string }>({ state: 'idle', message: '' });
  const [validation, setValidation] = useState<ValidationReport | null>(null);

  const [busy, setBusy] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [form, setForm] = useState<'closed' | 'add' | DraftTaskView>('closed');
  const [removing, setRemoving] = useState<DraftTaskView | null>(null);
  const [live, setLive] = useState('');
  /**
   * The control to put focus on once a reorder has re-rendered.
   *
   * Move up and Move down are real disabled buttons, so the moment a task
   * reaches an end the button just pressed goes off and the browser drops focus
   * to `<body>`, so a keyboard-only teacher loses their place on every move that
   * finishes the job. The row is still there, so focus goes to the control on
   * it that is still live, and it is done in an effect because the row only
   * takes its new state on the render after the save.
   */
  const [focusWanted, setFocusWanted] = useState('');

  const [running, setRunning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [published, setPublished] = useState<{
    version: string;
    publishedAt: string;
    sandboxBudget: number;
  } | null>(null);
  // The last export's refusal or saved sentence, drawn under the section tabs.
  const [exportOutcome, setExportOutcome] = useState<ExportOutcome>({ error: '', done: '' });

  const [files, setFiles] = useState<AuthoringFileView[] | null>(null);
  const [filesError, setFilesError] = useState('');
  const [filesOpen, setFilesOpen] = useState(false);

  /** The project around this version, read only once the version is frozen. */
  const [summary, setSummary] = useState<AuthoredProjectSummary | null>(null);
  /** Its versions, for the one state the summary alone cannot tell apart. */
  const [versions, setVersions] = useState<AuthoredVersionRow[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState('');

  // Bumped after a sealed write, so deep validation is read again.
  const [sealedRound, setSealedRound] = useState(0);
  // The phase whose executable task is open for editing.
  const [execEditing, setExecEditing] = useState<PhaseKey | ''>('');
  // Which draft re-read after a seal is the newest.
  const sealReads = useRef(0);
  // The draft re-read after a save converted the draft's texts to plain text, and the phases saved since it was asked.
  const convertedRead = useRef<{ applied: Set<string> } | null>(null);
  // The executable editor's own refusals (its save, the
  // re-read after a seal), kept apart from the page's and the task form's, so
  // each is said once and in the place it belongs to.
  const [execError, setExecError] = useState('');
  // The deep-validation view the rail reads (the panel hands it over).
  const [guideDeep, setGuideDeep] = useState<DeepValidationView | null>(null);
  // The rail's Preview and Export, read back from this browser's markers.
  const [guideMarks, setGuideMarks] = useState({ previewed: false, exported: false });
  useEffect(() => {
    const readBoth = () =>
      setGuideMarks({ previewed: readGuideMark('previewed', versionId), exported: readGuideMark('exported', versionId) });
    readBoth();
    // A mark written in another tab of this
    // browser (a preview opened in a new tab) reaches this rail without a reload.
    const keys = new Set([guideMarkKey('previewed', versionId), guideMarkKey('exported', versionId)]);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || keys.has(event.key)) readBoth();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [versionId]);
  const markGuide = (mark: GuideMark) => {
    writeGuideMark(mark, versionId);
    setGuideMarks((was) => ({ ...was, [mark]: readGuideMark(mark, versionId) }));
  };

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (user?.role === 'LEARNER') router.replace('/dashboard');
  }, [user?.role, router]);

  useEffect(() => {
    if (!focusWanted) return;
    const control = document.querySelector<HTMLElement>(`[data-testid="${focusWanted}"]`);
    if (control && !(control as HTMLButtonElement).disabled) control.focus();
    setFocusWanted('');
  }, [focusWanted]);

  useEffect(() => {
    projectsApi
      .draft(projectId, versionId)
      .then((next) => {
        if (!alive.current) return;
        setView(next);
        setValidation(next.validation);
        // The phase the address named opens first, when this draft holds it.
        const named = askedSection.current;
        setPhaseKey(
          (was) =>
            was ||
            (isPhaseSection(named) && next.phases.some((one) => one.key === named) ? named : next.phases[0]?.key) ||
            '',
        );
        setLoadError('');
      })
      .catch((err) => {
        if (!alive.current) return;
        setLoadError(describeError(err, 'This project could not be loaded. Try again in a moment.'));
      });
  }, [projectId, versionId]);

  /**
   * A published version is the only one with a next draft to offer, so the
   * project summary is asked for there and nowhere else. It is what says which
   * version is the head, whether a draft is already open, and whether the
   * project is the caller's at all: three facts `DraftVersionView` does not
   * carry and all three of which decide what the door may say.
   *
   * The answer is the envelope `{ project, versions }`, so the row is taken out
   * of it rather than read off the top: every field the door branches on is on
   * `project`, and a summary read one level too high is `undefined` in all of
   * them. The versions beside it are kept for `isWithdrawn`, which is the one
   * fact about this project the summary cannot carry. The door is also a state
   * change like any other on this page, so it says what it has become through
   * the same live region the saves use.
   */
  const status = view?.status ?? null;
  useEffect(() => {
    if (status === null || status === 'draft') return;
    projectsApi
      .get(projectId)
      .then((next) => {
        if (!alive.current) return;
        const rows = next.versions ?? [];
        setSummary(next.project);
        setVersions(rows);
        setLive(nextDraftAnnouncement(next.project, isWithdrawn(rows)));
        setDraftError('');
      })
      .catch((err) => {
        if (!alive.current) return;
        setDraftError(
          describeError(err, 'What this project has published could not be read. Try again in a moment.'),
        );
      });
  }, [status, projectId]);

  const phase: DraftPhaseView | null = useMemo(() => {
    if (!view) return null;
    return view.phases.find((one) => one.key === phaseKey) ?? view.phases[0] ?? null;
  }, [view, phaseKey]);

  /**
   * Every phase whose work task carries an executable
   * view. Empty on every draft a server sends without one, and then nothing
   * below draws: no summary, no ceiling, no deep validation.
   */
  const executables = useMemo(
    () =>
      (view?.phases ?? []).flatMap((one) => {
        const task = one.tasks.find((row) => executableOf(row) !== null);
        const exec = task ? executableOf(task) : null;
        return task && exec ? [{ phase: one, task, exec }] : [];
      }),
    [view],
  );
  const phaseExecutable = executables.find((one) => one.phase.key === phase?.key) ?? null;
  /**
   * Every phase the draft view can price as publish does, in phase order: the
   * coding and testing phases by their executable view, and a deployment phase
   * with a runbook by its smoke check and drill, so Validate can say the
   * full pass that publish's receipt then repeats.
   */
  const pricedPhases = useMemo(
    () =>
      (view?.phases ?? []).flatMap((one) => {
        const exec = executables.find((row) => row.phase.key === one.key);
        const microVMs = exec ? exec.exec.sandboxBudget : configPhaseBudget(one);
        return microVMs === null ? [] : [{ key: one.key, title: one.title, microVMs }];
      }),
    [view, executables],
  );
  // The rail's state, from what this page reads. Deep validation
  // comes from the panel's own reads (onView), so a polled run moves the rail too.
  // The rail is the owner's: never drawn on a platform-owned or library version.
  // A version published from this page is this teacher's: only its owner can
  // publish it. Counting it as theirs before the project summary answers keeps
  // the header's Export and Preview from leaving and coming back the moment it
  // is published (which would move the section tabs up, then down again),
  // and the rail with them.
  const mineHere = Boolean(view?.editable || published !== null || summary?.mine);
  const ownsDeep = Boolean(view && !view.platformOwned && mineHere);
  const guideSteps = useMemo(
    () => deriveGuideSteps({ view, deep: guideDeep, summary, ...guideMarks }),
    [view, guideDeep, summary, guideMarks],
  );
  /**
   * What the page's own notice says. The task form, while
   * it is open, says the page's refusal itself; the executable editor, while it
   * is open, says its own. A refusal of the executable editor stays on the page
   * once it is closed. Each sentence once.
   */
  // Open only where the editor is drawn (an editable, executable phase),
  // so a re-read that takes either away hands the editor's refusal back to the page.
  const execOpen = Boolean(phaseExecutable && view?.editable) && execEditing !== '' && execEditing === phase?.key;
  const pageError = [...new Set([form === 'closed' ? taskError : '', execOpen ? '' : execError])]
    .filter(Boolean)
    .join(' ');

  /**
   * A save's answer: its phase replaces this one, and its report the shown one.
   * The save that converted the draft's texts to plain text (its first)
   * says so with the draft's notes: the conversion reached every phase,
   * so the draft is read again for the others, and a phase saved while that
   * read is out keeps its own answer. A Phases card door or a seal re-read
   * asked meanwhile replaces the whole view, so that read is dropped.
   */
  const apply = useCallback(
    (result: TaskMutationResult) => {
      setEditedHere(true);
      setView((was) =>
        was
          ? {
              ...was,
              phases: was.phases.map((one) => (one.key === result.phase.key ? result.phase : one)),
              ...(result.plainTextConversion ? { plainTextConversion: result.plainTextConversion } : {}),
            }
          : was,
      );
      setValidation(result.validation);
      convertedRead.current?.applied.add(result.phase.key);
      if (!result.plainTextConversion) return;
      const asked = { applied: new Set<string>([result.phase.key]) };
      convertedRead.current = asked;
      const seals = sealReads.current;
      projectsApi
        .draft(projectId, versionId)
        .then((next) => {
          if (!alive.current || convertedRead.current !== asked || seals !== sealReads.current) return;
          convertedRead.current = null;
          setView((was) =>
            was
              ? {
                  ...was,
                  ...(next.plainTextConversion ? { plainTextConversion: next.plainTextConversion } : {}),
                  phases: next.phases.map((one) => (asked.applied.has(one.key) ? (was.phases.find((held) => held.key === one.key) ?? one) : one)),
                }
              : was,
          );
        })
        .catch(() => {
          // the other phases show their plain text at the next read of the draft
          if (convertedRead.current === asked) convertedRead.current = null;
        });
    },
    [projectId, versionId],
  );

  /**
   * A Phases card door's answer: the whole draft view, which replaces this
   * one as the load's does. The file rows are read again, and deep validation
   * is read again, because its receipt names the phases it validated. A seal's
   * re-read still in flight was answered before this write, so it is dropped
   * rather than put the earlier phases back. A phase that went away is closed by
   * the effect below, which reads the phase selected when the answer lands.
   */
  const applyPhases = (next: DraftVersionView) => {
    if (!alive.current) return;
    ++sealReads.current;
    setView(next);
    setValidation(next.validation);
    setFiles(null);
    setFilesOpen(false);
    setSealedRound((n) => n + 1);
  };

  /**
   * When the selected phase is no longer in the draft (a Phases card door
   * took it, or any later answer that replaced the view), its open task form,
   * its task-remove confirm and its executable editor go with it, and the
   * first phase is opened. It reads the phase selected now, not the one
   * selected when the door was pressed, so a tab opened while a door was out
   * is closed too.
   */
  useEffect(() => {
    if (!view || !phaseKey || view.phases.some((one) => one.key === phaseKey)) return;
    setForm('closed');
    setRemoving(null);
    setTaskError('');
    setExecEditing('');
    setExecError('');
    setPhaseKey(view.phases[0]?.key ?? '');
  }, [view, phaseKey]);

  /** Run one mutation, keeping the refusal it comes back with. */
  const run = useCallback(
    async (work: () => Promise<TaskMutationResult>, onDone?: () => void, say: (sentence: string) => void = setTaskError) => {
      setBusy(true);
      say('');
      setRunSave({ state: 'saving', message: '' });
      try {
        const result = await work();
        if (!alive.current) return;
        apply(result);
        setRunSave({ state: 'saved', message: '' });
        onDone?.();
      } catch (err) {
        if (alive.current) {
          const sentence = describeError(err, 'That change could not be saved. Try again in a moment.');
          say(sentence);
          setRunSave({ state: 'failed', message: sentence });
        }
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [apply],
  );

  const move = (taskKey: string, by: -1 | 1) => {
    if (!phase) return;
    const keys = phase.tasks.map((one) => one.taskKey);
    const at = keys.indexOf(taskKey);
    const to = at + by;
    if (at < 0 || to < 0 || to >= keys.length) return;
    const next = [...keys];
    next.splice(at, 1);
    next.splice(to, 0, taskKey);
    const moved = phase.tasks[at];
    // Keep the direction the teacher was moving in where the task can still go
    // that way, and hand focus to the opposite control where it cannot.
    const sameWayStillOpen = by === -1 ? to > 0 : to < keys.length - 1;
    const keep = by === -1 ? 'up' : 'down';
    const other = by === -1 ? 'down' : 'up';
    void run(
      () => projectsApi.reorderTasks(projectId, versionId, phase.key, next),
      () => {
        setLive(`${moved.title} is now ${to + 1} of ${keys.length} in ${phase.title}.`);
        setFocusWanted(`task-${sameWayStillOpen ? keep : other}-${taskKey}`);
      },
    );
  };

  const validateNow = async () => {
    setRunning(true);
    setTaskError('');
    try {
      const report = await projectsApi.validate(projectId, versionId);
      if (alive.current) setValidation(report);
    } catch (err) {
      if (alive.current) {
        setTaskError(describeError(err, 'The checks could not be run. Try again in a moment.'));
      }
    } finally {
      if (alive.current) setRunning(false);
    }
  };

  const publishNow = async (version: string, notes: string) => {
    setPublishing(true);
    setPublishError('');
    try {
      const result = await projectsApi.publish(projectId, versionId, {
        version,
        notes: notes.trim() || undefined,
      });
      if (!alive.current) return;
      setPublished({
        version: result.version,
        publishedAt: result.publishedAt,
        sandboxBudget: result.sandboxBudget,
      });
      setValidation(result.validation);
      setView((was) =>
        was ? { ...was, status: 'published', version: result.version, editable: false } : was,
      );
    } catch (err) {
      if (alive.current) {
        setPublishError(describeError(err, 'This version could not be published. Try again in a moment.'));
      }
    } finally {
      if (alive.current) setPublishing(false);
    }
  };

  /**
   * Open the next draft from the head, and go straight into it.
   *
   * The head's id rides as `fromVersionId`: it is an optimistic guard, so a
   * teacher who has had this page open while somebody else published is
   * refused by name rather than handed a draft that quietly starts from older
   * work. Every refusal is printed exactly as the door wrote it.
   */
  const openNextDraft = async (fromVersionId: string) => {
    setDrafting(true);
    setDraftError('');
    if (summary?.publishedVersion) setLive(`Opening a draft from ${summary.publishedVersion}.`);
    try {
      const opened = await projectsApi.createDraft(projectId, { fromVersionId });
      if (!alive.current) return;
      router.push(draftHref(opened.projectId || projectId, opened.versionId));
    } catch (err) {
      if (alive.current) {
        setDraftError(describeError(err, 'The next draft could not be opened. Try again in a moment.'));
      }
    } finally {
      if (alive.current) setDrafting(false);
    }
  };

  /**
   * The file rows, for a replace that wants the current bytes in its dialog.
   * Read once, like the Files section, and shared with it.
   */
  const loadFiles = async (): Promise<AuthoringFileView[] | null> => {
    if (files !== null) return files;
    try {
      const rows = await projectsApi.files(projectId, versionId);
      if (alive.current) setFiles(rows);
      return rows;
    } catch {
      return null;
    }
  };

  /** A scenario save: the phase and report as a task save applies them; the file rows are read again. */
  const applyScenario = (result: TaskMutationResult) => {
    apply(result);
    setFiles(null);
    setFilesOpen(false);
  };

  const openFiles = async () => {
    setFilesOpen(true);
    if (files !== null) return;
    try {
      const rows = await projectsApi.files(projectId, versionId);
      if (alive.current) setFiles(rows);
    } catch (err) {
      if (alive.current) {
        setFilesError(describeError(err, 'The files could not be loaded. Try again in a moment.'));
      }
    }
  };

  /** A task's required mark, through its own route (`tasks.setRequired`). */
  const toggleRequired = (task: DraftTaskView) => {
    if (!phase) return;
    void run(() => projectsApi.setTaskRequired(projectId, versionId, phase.key, task.taskKey, !task.required));
  };

  /**
   * After a sealed write, from the executable editor or the Maintenance
   * builder's Code and runs step. A seal changes the draft: its files, its
   * microVMs a pass, its fast report. Read it again so the summary, the
   * ceiling and the report are the server's. Only the newest read applies, so
   * two seals back to back cannot leave the older draft on screen.
   */
  const afterSeal = () => {
    setSealedRound((n) => n + 1);
    const asked = ++sealReads.current;
    projectsApi
      .draft(projectId, versionId)
      .then((next) => {
        if (!alive.current || asked !== sealReads.current) return;
        setView(next);
        setValidation(next.validation);
      })
      .catch((err) => {
        if (alive.current && asked === sealReads.current) {
          setExecError(describeError(err, 'The draft could not be read again after the seal. Reload the page to see it.'));
        }
      });
  };

  /** The sign-off mark, saved alone: `{ signOff }` and no other member. */
  const markSignOff = (task: DraftTaskView, signOff: boolean) =>
    phase
      ? run(
          () => projectsApi.updateTask(projectId, versionId, phase.key, task.taskKey, { signOff }),
          () =>
            setLive(
              signOff ? `${task.title} now needs your sign-off.` : `${task.title} no longer needs your sign-off.`,
            ),
        )
      : Promise.resolve();

  const frozen = view ? readOnlyReason(view) : null;
  const editable = Boolean(view?.editable);
  /**
   * Requirements is built in five steps, Design in six, Implementation and
   * Testing in three, Deployment in four and Maintenance in five, rather than
   * drawn as a scenario and a task list. A concept quiz beside its one work
   * task keeps its own row on the task list, which leaves out the builder's
   * task but still orders over the whole phase.
   */
  const builderTask = phase
    ? (requirementsBuilderTask(phase, editable) ??
      designBuilderTask(phase, editable) ??
      deploymentBuilderTask(phase, editable) ??
      maintenanceBuilderTask(phase, editable) ??
      implementationBuilderTask(phase, editable) ??
      testingBuilderTask(phase, editable))
    : null;
  // The Implementation, Testing and Maintenance builders draw the executable summary and editor in their own step, so they are not drawn twice.
  const executableBuilt = Boolean(builderTask && (phase?.key === 'maintenance' || phase?.key === 'implementation' || phase?.key === 'testing'));
  /*
   * A Deployment or Maintenance task still in the older format whose
   * conversion would refuse carries no record view, so no builder mounts on
   * it and the generic panels are drawn. The API's sentence saying why is
   * drawn above them, under the id its builder would give it.
   */
  const conversionRefused =
    phase && !builderTask && (phase.key === 'deployment' || phase.key === 'maintenance')
      ? (phase.tasks.find((one) => one.recordConversionRefused)?.recordConversionRefused ?? null)
      : null;
  const plainNotes = phase && view?.plainTextConversion ? plainTextNotesOn(view.plainTextConversion.notes, PHASE_TITLES[phase.key]) : [];
  const drawnElsewhere = useMemo(
    () => (builderTask ? new Set([builderTask.taskKey]) : undefined),
    [builderTask],
  );

  /*
   * The starting runbook's and change request's bytes, for their publish
   * warnings: read once with the file rows when the draft's
   * Deployment or Maintenance is built in steps, then as each builder reads
   * or saves them. No API field carries a warning; neither refuses publish.
   */
  const deploymentPhase = view?.phases.find((one) => one.key === 'deployment');
  const deploymentTask = deploymentPhase ? deploymentBuilderTask(deploymentPhase, editable) : null;
  const maintenancePhase = view?.phases.find((one) => one.key === 'maintenance');
  const maintenanceTask = maintenancePhase ? maintenanceBuilderTask(maintenancePhase, editable) : null;
  const [startingRunbook, setStartingRunbook] = useState<string | null>(null);
  const [startingChange, setStartingChange] = useState<string | null>(null);
  const readsRunbook = Boolean(deploymentTask?.runbook);
  const readsChange = Boolean(maintenanceTask?.change);
  useEffect(() => {
    if (!readsRunbook && !readsChange) return;
    let live = true;
    projectsApi
      .files(projectId, versionId)
      .then((rows) => {
        if (!live) return;
        const content = (key: string, path: string) => (rows ?? []).find((one) => one.phaseKey === key && one.path === path)?.content ?? null;
        if (readsRunbook) setStartingRunbook(content('deployment', RUNBOOK_JSON));
        if (readsChange) setStartingChange(content('maintenance', CHANGE_REQUEST_JSON));
      })
      // A failed read leaves the starting-record warnings off; Validate still reports the floor.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, versionId, readsRunbook, readsChange]);
  const runbookWarning =
    deploymentTask?.runbook && startingRunbook !== null ? startingRunbookWarning(startingRunbook, deploymentTask.runbook.floor) : null;
  const changeWarning =
    maintenanceTask?.change && startingChange !== null ? startingChangeWarning(startingChange, maintenanceTask.change) : null;
  const publishWarnings = [runbookWarning, changeWarning].filter((one): one is string => one !== null);

  /**
   * The section that is open: the one asked for or, when it names a phase this
   * draft does not hold (an old link, or a phase the Phases card took away
   * while its tab was open), the first phase, as the phase tabs have always
   * fallen back; Overview when the draft holds no phase at all. The address
   * is put right to match, without a history entry.
   */
  const missingPhase = Boolean(view && isPhaseSection(section) && !view.phases.some((one) => one.key === section));
  const openSection: EditorSection = missingPhase ? (view?.phases[0]?.key ?? 'overview') : section;
  useEffect(() => {
    if (!missingPhase) return;
    setSection(openSection);
    writeSection(openSection, 'replace');
  }, [missingPhase, openSection]);

  /**
   * Open a section. A phase's tab opens that phase; moving to another
   * phase closes the open task form, remove confirm and executable editor as
   * the phase tabs always have, and unmounts its builder: only the open
   * phase's builder is mounted. Overview, Validate and Publish close nothing:
   * they and the open phase stay mounted while hidden, so that phase's unsaved
   * edit, a validation run and the save queue are all still there when the
   * teacher comes back from one of them.
   * `remember` keeps each section's scroll position, as the pull request
   * page's tabs do.
   */
  const sectionsRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const scrollMemory = useRef(new Map<EditorSection, number>());
  const restoreScroll = useRef(false);
  const goSection = (key: EditorSection, mode: 'push' | 'replace' | null, remember = true) => {
    if (isPhaseSection(key) && key !== phaseKey) {
      setForm('closed');
      setRemoving(null);
      setTaskError('');
      setExecEditing('');
      setExecError('');
      setPhaseKey(key);
    }
    if (remember && key !== openSection) {
      const host = scrollHost(sectionsRef.current);
      if (host) scrollMemory.current.set(openSection, host.scrollTop);
      restoreScroll.current = true;
    }
    setSection(key);
    if (mode) writeSection(key, mode);
  };
  const goSectionNow = useRef(goSection);
  useEffect(() => {
    goSectionNow.current = goSection;
  });

  /**
   * A section returns to where the teacher left it; one not visited yet opens
   * at its top, under the tab bar if the bar is stuck, and where the page is
   * if it is not, so the tab just pressed does not jump away from the pointer.
   */
  useLayoutEffect(() => {
    if (!restoreScroll.current) return;
    restoreScroll.current = false;
    const host = scrollHost(sectionsRef.current);
    const panels = sectionsRef.current;
    if (!host || !panels) return;
    const panelsTop = panels.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
    const barHeight = panels.parentElement?.querySelector<HTMLElement>('[data-testid="editor-nav"]')?.offsetHeight ?? 0;
    const stuckAt = Math.max(0, panelsTop - barHeight - 16);
    host.scrollTop = scrollMemory.current.get(openSection) ?? Math.min(host.scrollTop, stuckAt);
  }, [openSection]);

  // Back and Forward land on the section their address names.
  useEffect(() => {
    const onPop = () => goSectionNow.current(sectionFromSearch(window.location.search), null);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /**
   * A link to a place inside a section that is not open (a step of the path's
   * "Take me there", an address with a `#fragment`): open that section, then
   * bring the place into view and put focus on it, so focus never falls to the
   * page when the link's own section is hidden. A place in the open section,
   * or in the header every section shares, is left to the link itself.
   */
  const goToPlace = (id: string, mode: 'push' | 'replace'): boolean => {
    const target = document.getElementById(id);
    const holder = target?.closest('[data-project-section]');
    const key = holder?.getAttribute('data-project-section') ?? '';
    if (!target || !(EDITOR_SECTION_KEYS as readonly string[]).includes(key) || key === openSection) return false;
    goSection(key as EditorSection, mode, false);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!target.matches('a[href], button, input, select, textarea, [tabindex]')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: 'start' });
      }),
    );
    return true;
  };
  const goToPlaceNow = useRef(goToPlace);
  useEffect(() => {
    goToPlaceNow.current = goToPlace;
  });
  const loaded = view !== null;
  useEffect(() => {
    if (!loaded) return;
    const fromHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (id) goToPlaceNow.current(id, 'replace');
    };
    // An address that arrived with a fragment, once there is a page to find it in.
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [loaded]);
  const onLinkCapture = (event: React.MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.('a[href^="#"]');
    const id = link ? decodeURIComponent((link.getAttribute('href') ?? '').slice(1)) : '';
    // Taken before the link's own handler, so the router does not scroll to a hidden place.
    if (id && goToPlace(id, 'push')) event.preventDefault();
  };

  /** What the Validate tab says while the teacher is elsewhere: a run in progress, or the failures the panel counts. */
  const deepInFlight = guideDeep?.status === 'queued' || guideDeep?.status === 'running';
  const failedNow = failedCheckCount(validation, guideDeep);
  const validateMark: ValidateMark | null =
    running || deepInFlight
      ? { state: 'running', text: 'Running' }
      : failedNow > 0
        ? { state: 'failed', text: `${failedNow} failed` }
        : null;

  /** A validation row's task by its title in this draft, so Validate never shows a bare task key where a name exists. */
  const taskTitleOf = (key: PhaseKey, taskKey: string) =>
    view?.phases.find((one) => one.key === key)?.tasks.find((one) => one.taskKey === taskKey)?.title;

  /**
   * A failed validation row's link: open its phase, bring the
   * phase into view and focus its first field (the task's own card's, when
   * the row names a task and the card says which it is). Nothing is cleared.
   */
  const goToField = (key: PhaseKey, taskKey: string | null) => {
    setForm('closed');
    setRemoving(null);
    setExecEditing('');
    // Its phase's tab opens first; the address says so, and Back returns to Validate.
    setPhaseKey(key);
    setSection(key);
    writeSection(key, 'push');
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const panel = document.getElementById('project-phase-panel');
        const scope =
          (taskKey && panel?.querySelector<HTMLElement>(`[data-testid$="-${CSS.escape(taskKey)}"]`)) || panel;
        const field = scope?.querySelector<HTMLElement>(
          'textarea:not([readonly]):not([disabled]), input:not([type="checkbox"]):not([type="radio"]):not([readonly]):not([disabled]), select:not([disabled])',
        );
        (field ?? panel)?.focus();
        (field ?? panel)?.scrollIntoView?.({ block: 'center' });
      }),
    );
  };

  return (
    <AppShell
      active="projects"
      crumbs={[
        { label: 'Projects', href: '/teacher/projects' },
        { label: view?.title ?? 'Project' },
      ]}
    >
      {/* The class pages' width and left edge. */}
      <main ref={mainRef} id="main" tabIndex={-1} className={WIDE_PAGE} data-testid="project-editor" onClickCapture={onLinkCapture}>
        {/* The top bar's crumbs (Projects › title) are the page's only trail: an
            in-page one would begin at "Your classes", and a project is not under a class. */}
        {loadError && (
          <Notice tone="fail" role="alert" testId="project-error">
            {loadError}
          </Notice>
        )}

        {view === null ? (
          !loadError && (
            <p className="purpose" data-testid="project-loading">
              Loading this project.
            </p>
          )
        ) : (
          <EditorSaveProvider>
            <header id="guide-export" className={`flex min-w-0 ${BELOW_BAR} flex-col gap-1.5`}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="h2 min-w-0 flex-1 wrap">{view.title}</h1>
                <Chip tone={view.status === 'draft' ? 'warn' : 'pass'} testId="project-status">
                  {`${view.status === 'draft' ? 'Draft' : 'Published'} ${view.version}`}
                </Chip>
              </div>
              {view.tagline && <p className={`purpose wrap ${MEASURE}`}>{view.tagline}</p>}
              {/* Export, for the project's owner. */}
              {(editable || (view.status !== 'draft' && mineHere)) && (
                <ExportButton
                  projectId={projectId}
                  versionId={versionId}
                  slug={view.slug}
                  version={view.version}
                  onSaved={() => markGuide('exported')}
                  onOutcome={setExportOutcome}
                />
              )}
              {!view.platformOwned && mineHere && (
                // The preview page marks Preview once it has loaded, not this click.
                <div id="guide-preview" className={BELOW_BAR}>
                  <Button size="sm" variant="secondary" href={`${draftHref(projectId, versionId)}/preview`} testId="project-preview-open">
                    Preview as a learner
                  </Button>
                </div>
              )}
            </header>

            {/* Overview, each phase, Validate and Publish, one at a time, and the one save status. */}
            <EditorNav
              phases={view.phases.map((one) => ({
                key: one.key,
                label: (
                  <span className="inline-flex items-center gap-1.5" data-testid={`project-phase-tab-${one.key}`}>
                    {one.title}
                    <span className="mono text-[11.5px]">{one.tasks.length}</span>
                  </span>
                ),
              }))}
              value={openSection}
              // A tab opens only on a press, Enter or Space (manual activation): always a pushed entry.
              onChange={(key) => goSection(key, 'push')}
              validateMark={validateMark}
              // The bar's real height, for every scrolled-to place's margin (BELOW_BAR).
              onHeight={(px) => mainRef.current?.style.setProperty(BAR_HEIGHT_VAR, `${px}px`)}
              // A read-only version saves nothing, so the bar does not say it does.
              readOnly={frozen !== null}
            />
            <RunSaveReport state={runSave.state} message={runSave.message} />
            {/* The page's notices sit under the tabs, so one appearing never moves
                the row. Why this version is read-only is said in every
                section but Publish, whose own reason line beside the button, or
                its receipt once published here, says it already. */}
            {frozen && openSection !== 'publish' && (
              <Notice tone="info" testId="project-frozen-box">
                <span data-testid="project-frozen">{frozen}</span>
              </Notice>
            )}
            <ExportOutcomeNotice outcome={exportOutcome} />
            {/* While the form is open it carries the refusal itself; two
                copies of one sentence read as two problems. */}
            {pageError && (
              <Notice tone="fail" role="alert" testId="project-task-error">
                {pageError}
              </Notice>
            )}
            <p aria-live="polite" role="status" className="sr-only" data-testid="project-live">
              {live}
            </p>
            {/* Only the open section is shown. Overview, Validate, Publish and the
                open phase stay mounted while hidden; only the open phase's builder is
                mounted, so opening another phase unmounts it and closes its forms. */}
            <div ref={sectionsRef} className="flex min-w-0 flex-col">
              <div {...sectionPanelProps('overview')} hidden={openSection !== 'overview'} className="flex min-w-0 flex-col gap-4">
                {/* The path and the project's own doors beside the Phases card, which is about every phase. */}
                <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
                  <div className="flex min-w-0 flex-col gap-4">
                    {/* The ten steps, with this draft's state. */}
                    {/* Folded to its one line once the draft is being edited here. */}
                    {ownsDeep && <GuideRail steps={guideSteps} where="editor" collapsible defaultOpen={!editedHere} />}

                    {view.status !== 'draft' && (
                      <Section
                        title="The next draft"
                        purpose="A published version never changes. Editing this project again means opening a draft from what it last published."
                        testId="project-next-draft"
                      >
                        <NextDraft
                          summary={summary}
                          withdrawn={isWithdrawn(versions)}
                          version={view.version}
                          versionId={view.versionId}
                          projectId={projectId}
                          busy={drafting}
                          error={draftError}
                          onOpen={openNextDraft}
                        />
                      </Section>
                    )}

                    {/* The runtime and its packages, available but out of the editing path. */}
                    <details className="min-w-0" data-testid="project-advanced">
                      <summary className="cursor-pointer text-[13px] font-semibold text-ink" data-testid="project-advanced-toggle">
                        Advanced information
                      </summary>
                      <div className="mt-2 flex min-w-0 flex-col gap-2">
                        <Notice tone="info" icon="info" testId="project-stacks-box">
                          <span data-testid="project-stacks">{view.supportedStacks.sentence}</span>
                          {/* The runtime profile line, on the version. */}
                          <span className="mt-1 block">
                            <RuntimeProfileLine stacks={view.supportedStacks} testId="project-runtime-profile" />
                          </span>
                        </Notice>

                        {/* What the runtime profile is. */}
                        <InlineHelp topic="runtime" />
                      </div>
                    </details>
                  </div>
                  {/* Which of the six phases this draft holds, and the doors that change it. */}
                  <PhasesCard
                    projectId={projectId}
                    versionId={versionId}
                    phaseSet={view.phaseSet}
                    editable={editable}
                    onChanged={applyPhases}
                  />
                </div>

                <Section
                  title="Files"
                  purpose="Every file this version carries. A file that grades learners shows its path and its size, never its contents."
                  testId="project-files-panel"
                  right={
                    filesOpen ? undefined : (
                      <Button size="sm" variant="secondary" testId="project-files-open" onClick={openFiles}>
                        Show the files
                      </Button>
                    )
                  }
                >
                  {filesError && (
                    <Notice tone="fail" role="alert" testId="project-files-error">
                      {filesError}
                    </Notice>
                  )}
                  {!filesOpen ? (
                    <p className="purpose">
                      A copied project carries its whole workspace, so the files are fetched when you ask
                      for them rather than every time this page opens.
                    </p>
                  ) : files === null ? (
                    !filesError && (
                      <p className="purpose" data-testid="project-files-loading">
                        Loading the files.
                      </p>
                    )
                  ) : (
                    <ProjectFiles
                      rows={files}
                      previewOffered={!view.phases.some((one) => !runsReferenceApplication(one.provenance))}
                    />
                  )}
                </Section>
              </div>

              {phase && (
                <div {...sectionPanelProps(phase.key)} hidden={!isPhaseSection(openSection)} className="flex min-w-0 flex-col gap-4">
                  <Section
                    title="Phases and their tasks"
                    purpose="A phase passes when every required task in it passes. An optional task never blocks one."
                    testId="project-phases"
                    id="guide-refine"
                    className={BELOW_BAR}
                  >
                    {phase && (
                      // The phase's help, builder (every phase's, the scenario editor's
                      // when none), task list and executable task at the reading
                      // measure: single-column forms and prose.
                      <div className={`flex min-w-0 flex-col gap-4 ${MEASURE}`} data-testid="project-phase-measure">
                        {/* What this phase's parts are, and where an interview comes from: prose. */}
                        <div className="flex min-w-0 flex-col gap-4">
                          <InlineHelp topic="tasks" />
                          {phase.tasks.some((one) => one.quiz) && <InlineHelp topic="quiz" />}
                          {phase.interview && <InlineHelp topic="interview" />}
                          {phaseExecutable && <InlineHelp topic="sealedFiles" />}
                          <InterviewHint phase={phase} />
                          {conversionRefused && (
                            <Notice
                              tone="fail"
                              role="note"
                              testId={phase.key === 'deployment' ? 'tdp-conversion-refused' : 'tdm-conversion-refused'}
                            >
                              {conversionRefused}
                            </Notice>
                          )}
                          {/* What storing this phase's texts as plain text changed, and
                              where an HTML comment is kept that learners do not see
                              the draft's notes that name this phase. */}
                          {plainNotes.length > 0 && (
                            <div className="flex min-w-0 flex-col gap-2" data-testid="project-plain-text-notes">
                              {plainNotes.map((note) => (
                                <Notice key={note} tone="info" role="note" testId="project-plain-text-note">
                                  {note}
                                </Notice>
                              ))}
                            </div>
                          )}
                        </div>
                        {builderTask && phase.key === 'implementation' ? (
                          <ImplementationBuilder
                            key={`${phase.key}-${view.versionId}-${builderTask.taskKey}`}
                            projectId={projectId}
                            versionId={versionId}
                            phase={phase}
                            task={builderTask}
                            editable={editable}
                            onSaved={applyScenario}
                            onSignOff={(signOff) => markSignOff(builderTask, signOff)}
                            onSealed={afterSeal}
                            busy={busy}
                          />
                        ) : builderTask && phase.key === 'testing' ? (
                          <TestingBuilder
                            key={`${phase.key}-${view.versionId}-${builderTask.taskKey}`}
                            projectId={projectId}
                            versionId={versionId}
                            phase={phase}
                            task={builderTask}
                            editable={editable}
                            onSaved={applyScenario}
                            onSignOff={(signOff) => markSignOff(builderTask, signOff)}
                            onSealed={afterSeal}
                            busy={busy}
                          />
                        ) : builderTask && phase.key === 'maintenance' ? (
                          <MaintenanceBuilder
                            key={`${phase.key}-${view.versionId}-${builderTask.taskKey}`}
                            projectId={projectId}
                            versionId={versionId}
                            draft={view}
                            phase={phase}
                            task={builderTask}
                            editable={editable}
                            onSaved={applyScenario}
                            onSignOff={(signOff) => markSignOff(builderTask, signOff)}
                            onStartingText={setStartingChange}
                            onSealed={afterSeal}
                            busy={busy}
                          />
                        ) : builderTask && phase.key === 'deployment' ? (
                          <DeploymentBuilder
                            key={`${phase.key}-${view.versionId}-${builderTask.taskKey}`}
                            projectId={projectId}
                            versionId={versionId}
                            draft={view}
                            phase={phase}
                            task={builderTask}
                            editable={editable}
                            onSaved={applyScenario}
                            onSignOff={(signOff) => markSignOff(builderTask, signOff)}
                            onStartingText={setStartingRunbook}
                            busy={busy}
                          />
                        ) : builderTask && phase.key === 'design' ? (
                          <DesignBuilder
                            key={`${phase.key}-${view.versionId}-${builderTask.taskKey}`}
                            projectId={projectId}
                            versionId={versionId}
                            draft={view}
                            phase={phase}
                            task={builderTask}
                            editable={editable}
                            onSaved={applyScenario}
                            onSignOff={(signOff) => markSignOff(builderTask, signOff)}
                            onToggleRequired={() => toggleRequired(builderTask)}
                            busy={busy}
                          />
                        ) : builderTask ? (
                          <RequirementsBuilder
                            key={`${phase.key}-${view.versionId}-${builderTask.taskKey}`}
                            projectId={projectId}
                            versionId={versionId}
                            phase={phase}
                            task={builderTask}
                            editable={editable}
                            onSaved={applyScenario}
                            onSignOff={(signOff) => markSignOff(builderTask, signOff)}
                            onToggleRequired={() => toggleRequired(builderTask)}
                            busy={busy}
                          />
                        ) : (
                          <PhaseScenario
                            key={`${phase.key}-${view.versionId}`}
                            projectId={projectId}
                            versionId={versionId}
                            phase={phase}
                            editable={editable}
                            onApplied={applyScenario}
                            onLive={setLive}
                            loadFiles={loadFiles}
                          />
                        )}
                        {!builderTask || phase.tasks.length > 1 ? (
                          <PhaseTasks
                            showIntro={false}
                            phase={phase}
                            drawnElsewhere={drawnElsewhere}
                            editable={editable}
                            busy={busy}
                            onMove={move}
                            onToggleRequired={toggleRequired}
                            onEdit={(task) => {
                              setTaskError('');
                              setRemoving(null);
                              setForm(task);
                            }}
                            onRemove={(task) => {
                              setTaskError('');
                              setForm('closed');
                              setRemoving(task);
                            }}
                            // The mark saves alone, `{ signOff }` and no other member.
                            readOnlyReason={frozen}
                            onSignOff={markSignOff}
                          />
                        ) : null}
                        {/* The phase's executable task. */}
                        {phaseExecutable && !execOpen && !executableBuilt && (
                          <ExecutableSummary phaseTitle={phase.title} executable={phaseExecutable.exec} />
                        )}
                        {/* The executable editor. */}
                        {phaseExecutable && editable && !execOpen && !executableBuilt && (
                          <div>
                            <Button size="sm" variant="secondary" icon="edit" testId="exec-edit-open" onClick={() => {
                                setExecError('');
                                setExecEditing(phase.key);
                              }}>
                              Edit the executable task
                            </Button>
                          </div>
                        )}
                        {phaseExecutable && execOpen && !executableBuilt && (
                          <ExecutableEditor
                            key={`exec-${phase.key}-${view.versionId}`}
                            phaseKey={phase.key}
                            phaseTitle={phase.title}
                            task={phaseExecutable.task}
                            executable={phaseExecutable.exec}
                            busy={busy}
                            error={execError}
                            onCancel={() => setExecEditing('')}
                            onSave={(body) =>
                              void run(
                                // The executable members ride on the task's own door (`UpdateTaskBody`).
                                () =>
                                  projectsApi.updateTask(
                                    projectId,
                                    versionId,
                                    phase.key,
                                    phaseExecutable.task.taskKey,
                                    body,
                                  ),
                                () => {
                                  setLive(`${phaseExecutable.task.title} was saved.`);
                                  setExecEditing('');
                                },
                                setExecError,
                              )
                            }
                            onWriteSealed={(body) =>
                              projectsApi.writeSealed(projectId, versionId, phase.key, phaseExecutable.task.taskKey, body)
                            }
                            onSealed={afterSeal}
                          />
                        )}
                        {/* Smoke and drill, read-only. */}
                        {executables.length > 0 && (phase.checkKind ?? phase.artifactKind) === 'config' && !(builderTask && phase.key === 'deployment') && (
                          <SmokeDrillReadOnly phaseTitle={phase.title} />
                        )}
                      </div>
                    )}

                    {removing && phase && (
                      <Notice tone="warn" role="status" testId="task-remove-confirm" className={MEASURE}>
                        <span className="block">
                          {inheritedRemovalSentence(phase, removing.taskKey, removing.title) ??
                            `Remove "${removing.title}" from ${phase.title}? Its brief and what scores it are removed with it.`}
                        </span>
                        <span className="mt-2 flex flex-wrap items-center gap-2.5">
                          <Button
                            size="sm"
                            variant="danger"
                            busy={busy}
                            busyLabel="Removing…"
                            testId="task-remove-yes"
                            onClick={() =>
                              void run(
                                () =>
                                  projectsApi.removeTask(projectId, versionId, phase.key, removing.taskKey),
                                () => {
                                  setLive(`${removing.title} was removed from ${phase.title}.`);
                                  setRemoving(null);
                                },
                              )
                            }
                          >
                            Remove it
                          </Button>
                          <Button size="sm" variant="ghost" testId="task-remove-no" onClick={() => setRemoving(null)}>
                            Keep it
                          </Button>
                        </span>
                      </Notice>
                    )}

                    {editable && phase && form === 'closed' && (
                      <div>
                        <Button size="sm" icon="plus" testId="project-add-task" onClick={() => setForm('add')}>
                          Add a concept quiz
                        </Button>
                      </div>
                    )}
                  </Section>

                  {/* A single-column form, at a reading measure. */}
                  {phase && form !== 'closed' && (
                    <div className={`min-w-0 ${MEASURE}`}>
                      <TaskEditor
                        key={form === 'add' ? `add-${phase.key}` : `edit-${phase.key}-${form.taskKey}`}
                        task={form === 'add' ? null : form}
                        busy={busy}
                        error={taskError}
                        // Whether a cohort could already have passed the phase this
                        // quiz is being added to. It is the only thing the editor
                        // needs to say the sentence no compile rule can: marking a
                        // quiz required on a published phase re-shuts it for everyone
                        // who passed before the quiz existed.
                        published={Boolean(summary?.publishedVersion)}
                        // Every phase holds the work it came with, so a task added
                        // here is a concept quiz, and the door's own sentence says so.
                        quizOnly={form === 'add'}
                        quizOnlyReason={QUIZ_ONLY_ADD_REFUSAL}
                        // The key, behind an explicit action and never on a render.
                        // `readQuizKey` is rate limited and audits every read, so the
                        // editor asks for it when a teacher opens the answer panel and
                        // at no other moment. There is nothing to read on the add form,
                        // which is why this is passed only when a task is open.
                        onReadQuizKey={
                          form === 'add'
                            ? undefined
                            : () =>
                                projectsApi.readQuizKey(
                                  projectId,
                                  versionId,
                                  phase.key,
                                  (form as DraftTaskView).taskKey,
                                )
                        }
                        onCancel={() => {
                          setTaskError('');
                          setForm('closed');
                        }}
                        onAdd={(body: AddTaskBody) =>
                          void run(
                            () => projectsApi.addTask(projectId, versionId, phase.key, body),
                            () => {
                              setLive(`${body.title} was added to ${phase.title}.`);
                              setForm('closed');
                            },
                          )
                        }
                        onSave={(body: UpdateTaskBody) =>
                          void run(
                            () =>
                              projectsApi.updateTask(
                                projectId,
                                versionId,
                                phase.key,
                                (form as DraftTaskView).taskKey,
                                body,
                              ),
                            () => {
                              setLive(`${(form as DraftTaskView).title} was saved.`);
                              setForm('closed');
                            },
                          )
                        }
                      />
                    </div>
                  )}
                </div>
              )}

              <div
                {...sectionPanelProps('validate')}
                hidden={openSection !== 'validate'}
                className={`grid min-w-0 items-start gap-4 ${executables.length > 0 ? 'xl:grid-cols-2' : ''}`}
              >
                {/* The ceiling per phase and deep validation, beside the checks: two cards, two columns on a wide screen. */}
                {executables.length > 0 && (
                  <div className="flex min-w-0 flex-col gap-4">
                    {/* The version's total against BUDGET_CEILING.perVersion, claimed only when exact. */}
                    <BudgetCeiling
                      phases={pricedPhases.map(({ title, microVMs }) => ({ title, microVMs }))}
                      version={versionCountIsExact(view.phases, new Set(pricedPhases.map((one) => one.key)))}
                      testId="project-budget"
                    />
                    {!versionCountIsExact(view.phases, new Set(pricedPhases.map((one) => one.key))) && (
                      <PartialVersionBudget
                        total={executables.reduce((sum, one) => sum + one.exec.sandboxBudget, 0)}
                        phases={view.phases}
                        testId="project-budget"
                      />
                    )}
                    {/* What a microVM and the ceiling are. */}
                    <InlineHelp topic="budget" />
                    {/* Deep validation answers the project's owner only: drawn where Export is. */}
                    {!view.platformOwned && mineHere && (
                      <div id="guide-deep" className={BELOW_BAR}>
                        <DeepValidationPanel
                          projectId={projectId}
                          versionId={versionId}
                          editable={editable}
                          refreshKey={sealedRound}
                          onView={setGuideDeep}
                        />
                      </div>
                    )}
                  </div>
                )}
                <div id="editor-validate" className={`min-w-0 ${BELOW_BAR}`}>
                  <ValidationReportPanel report={validation} running={running} onRun={validateNow} onGoTo={goToField} deep={guideDeep} taskTitleOf={taskTitleOf} />
                </div>
              </div>

              <div {...sectionPanelProps('publish')} hidden={openSection !== 'publish'} className="min-w-0">
                {/* A box the rail's "Take me there: Publish" can scroll to. */}
                <div id="guide-publish" className={`min-w-0 ${BELOW_BAR} ${MEASURE}`}>
                  <PublishPanel
                    draftVersion={view.version}
                    report={validation}
                    editable={editable}
                    readOnlyReason={frozen}
                    publishing={publishing}
                    error={publishError}
                    published={published}
                    onPublish={publishNow}
                    warnings={publishWarnings.length ? publishWarnings : undefined}
                  />
                </div>
              </div>
            </div>
          </EditorSaveProvider>
        )}
      </main>
    </AppShell>
  );
}

/** The box that scrolls the editor: the shell's column, found as the pull request page finds its own. */
function scrollHost(node: HTMLElement | null): HTMLElement | null {
  for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
    if (/^(auto|scroll)$/.test(getComputedStyle(current).overflowY)) return current;
  }
  return null;
}
