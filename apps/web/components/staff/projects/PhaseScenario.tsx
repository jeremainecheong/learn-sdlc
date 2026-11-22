'use client';

/**
 * One phase's scenario, and whose it is.
 *
 * A teacher who copied the reference project can make every **written**
 * element of Requirements and Design their own: the intro (on every phase),
 * the stakeholder interview, and the read-only documents a written
 * phase mounts. Each element carries a chip that says whose it is, read from
 * the phase's provenance ("{name}'s", "Yours", "Edited", "Partly yours") and
 * the name is the payload's (`referenceName`), never a literal.
 * Implementation, Testing, Deployment and Maintenance of a copied project run
 * the reference project's application, and the phase says so in the
 * contract's sentence.
 *
 * Every save answers with the phase and a fresh report, which `onApplied`
 * hands to the editor exactly as a task save does. Every refusal is the
 * door's, printed word for word, inside the form it refused. An open intro
 * form nobody has typed in takes the server's intro from each new answer.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type {
  AuthoringFileView,
  DraftPhaseView,
  ElementProvenance,
  InterviewBody,
  PhaseProvenanceRollup,
  TaskMutationResult,
} from '@learnsdlc/shared';
import {
  INTERVIEW_PHASE,
  PHASE_INTRO_MAX,
  REPLACE_FILE_CONTENT_MAX,
  applicationPhasesSentence,
  referenceFileBriefNote,
} from '@learnsdlc/shared';
import { Button, Chip, Notice, useDialogFocus } from '@/components/ui';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { InterviewEditor, emptyInterview } from './InterviewEditor';

/** What a chip says about one element or a whole phase. */
function provenanceLabel(
  state: ElementProvenance | PhaseProvenanceRollup,
  referenceName: string,
): string {
  if (state === 'reference') return `${referenceName || 'The reference project'}'s`;
  if (state === 'own') return 'Yours';
  if (state === 'edited') return 'Edited';
  return 'Partly yours';
}

function provenanceTone(state: ElementProvenance | PhaseProvenanceRollup): 'neutral' | 'pass' | 'accent' {
  return state === 'reference' ? 'neutral' : state === 'own' ? 'pass' : 'accent';
}

export function ProvenanceChip({
  state,
  referenceName,
  testId,
}: {
  state: ElementProvenance | PhaseProvenanceRollup;
  referenceName: string;
  testId?: string;
}) {
  return (
    <Chip tone={provenanceTone(state)} testId={testId}>
      {provenanceLabel(state, referenceName)}
    </Chip>
  );
}

/**
 * The wording of the remove confirm for a task that came with the copy
 * (design 0: removing an inherited written task is honest about what goes).
 * Null for a task the teacher added, which keeps the editor's own sentence.
 */
export function inheritedRemovalSentence(
  phase: DraftPhaseView,
  taskKey: string,
  title: string,
): string | null {
  const provenance = phase.provenance;
  const task = provenance?.tasks.find((one) => one.taskKey === taskKey);
  if (!provenance || !task || task.provenance === 'own') return null;
  const name = provenance.referenceName || 'the reference project';
  return `Remove "${title}" from ${phase.title}? It came with the copy of ${name}. Learners given this version will not meet it, its brief and its criteria go with it, and ${phase.title} is then no longer ${name}'s scenario. A version already published keeps it.`;
}

/**
 * Replace one file's bytes: a dialog that holds focus, closes with Escape and
 * gives focus back to the control that opened it.
 *
 * It is a native `<dialog>` opened with `showModal()`, as the
 * learner's "Start this task over" dialog is: the browser then makes the rest
 * of the document inert, so what `aria-modal` tells a screen reader (the page
 * behind is gone) is also true for a pointer. It is closed before focus goes
 * back, because the opener is inert while the modal is up.
 */
export function FileReplaceDialog({
  path,
  initial,
  busy,
  error,
  note,
  unread = false,
  onSave,
  onClose,
}: {
  path: string;
  initial: string;
  busy: boolean;
  error: string;
  note: string | null;
  /** The current contents could not be read, so the field opens empty. */
  unread?: boolean;
  onSave: (content: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const base = useId().replace(/:/g, '');
  const [content, setContent] = useState(initial);
  const [blank, setBlank] = useState(false);
  const { onKeyDown } = useDialogFocus(ref, true);
  // Read by the native `close` handler, which runs outside React's render.
  const busyNow = useRef(busy);
  busyNow.current = busy;

  // Once the busy Save disables, focus falls to BODY, and every Escape
  // is then a close request the dialog's keydown never sees. Chromium lets a
  // page refuse two of them; the third closes the modal natively. Keeping
  // focus inside the dialog while the save is in flight keeps Escape a key
  // the dialog hears, and the `close` handler below is the backstop.
  useEffect(() => {
    if (!busy) return;
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) node.focus();
  }, [busy]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    if (node && !node.open) {
      if (typeof node.showModal === 'function') {
        try {
          node.showModal();
        } catch {
          node.setAttribute('open', '');
        }
      } else node.setAttribute('open', '');
    }
    field.current?.focus();
    return () => {
      if (node?.open) {
        if (typeof node.close === 'function') node.close();
        else node.removeAttribute('open');
      }
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const described = [`${base}-rule`, unread ? `${base}-unread` : '', note ? `${base}-note` : '', error || blank ? `${base}-error` : '']
    .filter(Boolean)
    .join(' ');

  return (
    <dialog
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${base}-title`}
      tabIndex={-1}
      className="m-auto max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-ctl border-1.5 border-edge2 bg-ground p-4 text-ink"
      data-testid="file-replace-dialog"
      onCancel={(event) => {
        // Escape on a native modal: the dialog closes through `onClose`, the
        // same way as the Cancel button, and never while a save is in flight.
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClose={() => {
        // The browser closed the modal itself (a close request it
        // would not let the page refuse). While a save is in flight it opens
        // again, so its outcome, a refusal included, is drawn where the
        // teacher can read it. Otherwise React is told, so its state matches
        // the page and the same file's Replace can open the dialog again.
        const node = ref.current;
        if (!node || node.open) return;
        if (busyNow.current) {
          try {
            if (typeof node.showModal === 'function') node.showModal();
            else node.setAttribute('open', '');
          } catch {
            node.setAttribute('open', '');
          }
          node.focus();
          return;
        }
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        onKeyDown(event);
      }}
    >
      <div className="flex min-w-0 flex-col gap-2.5">
        <h3 id={`${base}-title`} className="h3 wrap">
          {`Replace ${path}`}
        </h3>
        <label htmlFor={`${base}-content`} className="label-sm font-semibold text-ink">
          The file&rsquo;s new contents
        </label>
        <textarea
          ref={field}
          id={`${base}-content`}
          className="field mono min-h-[220px] w-full min-w-0 text-[12.5px]"
          value={content}
          maxLength={REPLACE_FILE_CONTENT_MAX}
          aria-invalid={Boolean(error || blank) || undefined}
          aria-describedby={described}
          data-testid="file-replace-content"
          onChange={(event) => {
            setContent(event.target.value);
            if (event.target.value.trim()) setBlank(false);
          }}
        />
        <p id={`${base}-rule`} className="label-sm wrap">
          Its path and its role stay as they are. Learners given a version you publish from now on read
          these words; a version already published keeps its own.
        </p>
        {unread && (
          <p id={`${base}-unread`} className="label-sm wrap text-warn" data-testid="file-replace-unread">
            The file&rsquo;s current contents could not be read, so this field starts empty. Close it and
            try again to edit what is there; what you save here replaces the whole file.
          </p>
        )}
        {note && (
          <p id={`${base}-note`} className="label-sm wrap" data-testid="file-replace-note">
            {note}
          </p>
        )}
        {(error || blank) && (
          <p id={`${base}-error`} role="alert" className="label-sm wrap text-fail" data-testid="file-replace-error">
            {blank ? 'Write the file before you save it.' : error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            size="sm"
            busy={busy}
            busyLabel="Replacing…"
            testId="file-replace-save"
            onClick={() => {
              if (!content.trim()) {
                setBlank(true);
                field.current?.focus();
                return;
              }
              onSave(content);
            }}
          >
            Replace the file
          </Button>
          <Button size="sm" variant="ghost" testId="file-replace-cancel" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * The files a learner starts a written task from, such as a teacher's own
 * document (`docs/<phase>/<task>.md`) on a copied task, which `files.replace`
 * accepts (a Design task starts from its record and contracts, which are JSON); this is the editor's control for them. Each
 * non-quiz task's own paths, less the structured records the room builds
 * from a learner's work (`.json`, which the door refuses with
 * `roomRecordRefusal`) and less the read-only documents listed above them.
 * None on a phase whose files are an application's, and none on a payload
 * without provenance (the documents block asks the same).
 */
function starterFiles(phase: DraftPhaseView): { path: string; taskKey: string }[] {
  const provenance = phase.provenance;
  if (!provenance || provenance.application !== undefined) return [];
  const documents = new Set(provenance.files.map((file) => file.path));
  const seen = new Set<string>();
  const out: { path: string; taskKey: string }[] = [];
  for (const task of phase.tasks) {
    if (task.checkKind === 'quiz') continue;
    for (const path of [...(task.owns ?? []), ...(task.artefactPath ? [task.artefactPath] : [])]) {
      if (!path || path.endsWith('.json') || documents.has(path) || seen.has(path)) continue;
      seen.add(path);
      out.push({ path, taskKey: task.taskKey });
    }
  }
  return out;
}

/**
 * The starter files replaced in this editor, by version and phase.
 *
 * A starter is part of its task's provenance (the anchor hashes the task's
 * owned baselines), so the payload says only that the task is "Edited", not
 * whose the file is. What this editor did itself it knows: a file it
 * replaced is the teacher's. Held for the life of the page, across phase
 * tabs; a reload falls back to what the payload says.
 */
const replacedStarters = new Map<string, Set<string>>();
const starterKey = (versionId: string, phaseKey: string) => `${versionId}:${phaseKey}`;

/** Whose a starter file is, as far as the payload and this editor know: a chip state, or null for "not known". */
export function starterProvenance(
  phase: DraftPhaseView,
  taskKey: string,
  replaced: boolean,
): ElementProvenance | null {
  const task = phase.provenance?.tasks.find((one) => one.taskKey === taskKey)?.provenance;
  // The payload's "the reference's" outranks this editor's memory: a file
  // replaced back to its own bytes is the reference's again.
  if (task === 'reference') return 'reference';
  if (replaced || task === 'own') return 'own';
  return null;
}

export function PhaseScenario({
  projectId,
  versionId,
  phase,
  editable,
  onApplied,
  onLive,
  loadFiles,
}: {
  projectId: string;
  versionId: string;
  phase: DraftPhaseView;
  /** False on a published version and on a project that is not the caller's. */
  editable: boolean;
  /** The phase and the fresh report a save answered with. */
  onApplied: (result: TaskMutationResult) => void;
  /** What a save did, for the editor's polite live region. */
  onLive: (message: string) => void;
  /** The version's file rows, read once and only when a replace asks for them. */
  loadFiles: () => Promise<AuthoringFileView[] | null>;
}) {
  const base = useId().replace(/:/g, '');
  const provenance = phase.provenance ?? null;
  const name = provenance?.referenceName ?? '';
  const application = provenance?.application ?? null;

  const [busy, setBusy] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const [intro, setIntro] = useState(phase.intro);
  const [introError, setIntroError] = useState('');
  // The intro form typed in since it opened, or its save out: a new answer for the phase does not redraw it then.
  const introTyped = useRef(false);
  const introOut = useRef(false);
  const [interview, setInterview] = useState<InterviewBody | null>(null);
  const [interviewError, setInterviewError] = useState('');
  const [reading, setReading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [replacing, setReplacing] = useState<{ path: string; content: string; unread?: boolean; starter?: boolean } | null>(null);
  const [replaced, setReplaced] = useState<ReadonlySet<string>>(() => new Set(replacedStarters.get(starterKey(versionId, phase.key)) ?? []));
  const starters = starterFiles(phase);
  const [fileError, setFileError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Run one door, keeping its refusal where the form that asked can print it. */
  const save = async (
    work: () => Promise<TaskMutationResult>,
    fail: (message: string) => void,
    done: (result: TaskMutationResult) => void,
  ) => {
    setBusy(true);
    fail('');
    try {
      const result = await work();
      if (!alive.current) return;
      onApplied(result);
      done(result);
    } catch (err) {
      if (alive.current) fail(describeError(err, 'That change could not be saved. Try again in a moment.'));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const openInterview = async () => {
    setInterviewError('');
    if (!phase.interview) {
      setInterview(emptyInterview());
      return;
    }
    setReading(true);
    try {
      const body = await projectsApi.readInterview(projectId, versionId);
      if (alive.current) setInterview(body);
    } catch (err) {
      if (alive.current) {
        setInterviewError(describeError(err, 'The interview could not be read. Try again in a moment.'));
      }
    } finally {
      if (alive.current) setReading(false);
    }
  };

  const openReplace = async (path: string, starter = false) => {
    setFileError('');
    const rows = await loadFiles().catch(() => null);
    if (!alive.current) return;
    const row = rows?.find((one) => one.path === path && one.phaseKey === phase.key) ?? rows?.find((one) => one.path === path);
    setReplacing({ path, content: row?.content ?? '', unread: rows === null, starter });
  };

  // A new answer for the phase (any door's) redraws an open, untouched intro form with the server's
  // words: the server stores the intro plain, so the form shows what is stored.
  const seenPhase = useRef(phase);
  useEffect(() => {
    if (seenPhase.current === phase) return;
    seenPhase.current = phase;
    if (!introTyped.current && !introOut.current) setIntro(phase.intro);
  }, [phase]);

  const introId = `${base}-intro`;
  const introDescribed = [`${introId}-rule`, introError ? `${introId}-error` : ''].filter(Boolean).join(' ');

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={`phase-scenario-${phase.key}`}>
      {provenance && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="label-sm">Whose this phase is:</span>
          <ProvenanceChip
            state={provenance.rollup}
            referenceName={name}
            testId={`phase-provenance-${phase.key}`}
          />
        </div>
      )}

      {application && (
        <Notice tone="info" testId={`phase-application-notice-${phase.key}`}>
          <span data-testid={`phase-application-${phase.key}`}>{applicationPhasesSentence(application)}</span>
        </Notice>
      )}

      {/* The intro: every phase's, the last four included. */}
      <div className="flex min-w-0 flex-col gap-1.5" data-testid={`phase-intro-${phase.key}`}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-[13.5px] font-semibold text-ink">The phase intro</h3>
          {provenance && (
            <ProvenanceChip
              state={provenance.intro}
              referenceName={name}
              testId={`phase-intro-provenance-${phase.key}`}
            />
          )}
        </div>
        {introOpen ? (
          <form
            className="flex min-w-0 flex-col gap-1.5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!intro.trim()) {
                setIntroError('Write the intro before you save it. A phase always has one.');
                return;
              }
              introOut.current = true;
              void save(
                () =>
                  projectsApi.updatePhase(projectId, versionId, phase.key, { intro }).finally(() => {
                    introOut.current = false;
                  }),
                setIntroError,
                () => {
                  setIntroOpen(false);
                  onLive(`The intro to ${phase.title} was saved.`);
                },
              );
            }}
          >
            <label htmlFor={introId} className="label-sm font-semibold text-ink">
              {`Intro to ${phase.title}`}
            </label>
            <textarea
              id={introId}
              className="field min-h-[100px] w-full min-w-0"
              value={intro}
              maxLength={PHASE_INTRO_MAX}
              aria-invalid={Boolean(introError) || undefined}
              aria-describedby={introDescribed}
              data-testid={`phase-intro-field-${phase.key}`}
              onChange={(event) => {
                introTyped.current = true;
                setIntro(event.target.value);
              }}
            />
            <p id={`${introId}-rule`} className="label-sm wrap">
              {`What a learner reads first in this phase, up to ${PHASE_INTRO_MAX} characters. It is never graded and never sent to a model. ${intro.length} of ${PHASE_INTRO_MAX}.`}
            </p>
            {introError && (
              <p id={`${introId}-error`} role="alert" className="label-sm wrap text-fail" data-testid={`phase-intro-error-${phase.key}`}>
                {introError}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2.5">
              <Button type="submit" size="sm" busy={busy} busyLabel="Saving…" testId={`phase-intro-save-${phase.key}`}>
                Save the intro
              </Button>
              <Button
                size="sm"
                variant="ghost"
                testId={`phase-intro-cancel-${phase.key}`}
                onClick={() => {
                  setIntro(phase.intro);
                  introTyped.current = false;
                  setIntroError('');
                  setIntroOpen(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="purpose wrap">{phase.intro}</p>
            {editable && (
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="edit"
                  testId={`phase-intro-edit-${phase.key}`}
                  onClick={() => {
                    setIntro(phase.intro);
                    introTyped.current = false;
                    setIntroOpen(true);
                  }}
                >
                  Edit the intro
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* The stakeholder interview: Requirements only, and only where the
          payload says whether it holds one: a payload without provenance
          carries neither the interview nor its provenance, and "none" would
          be a guess. */}
      {phase.key === INTERVIEW_PHASE && (phase.interview !== undefined || provenance?.interview === null) && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="phase-interview">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="text-[13.5px] font-semibold text-ink">The stakeholder interview</h3>
            {provenance && provenance.interview && (
              <ProvenanceChip state={provenance.interview} referenceName={name} testId="phase-interview-provenance" />
            )}
          </div>
          {interview ? (
            <InterviewEditor
              initial={interview}
              busy={busy}
              error={interviewError}
              onCancel={() => {
                setInterview(null);
                setInterviewError('');
              }}
              onSave={(body) =>
                void save(
                  () => projectsApi.putInterview(projectId, versionId, body),
                  setInterviewError,
                  () => {
                    setInterview(null);
                    onLive('The stakeholder interview was saved.');
                  },
                )
              }
            />
          ) : phase.interview ? (
            <>
              <p className="purpose wrap" data-testid="phase-interview-persona">
                {`${phase.interview.persona.name}, ${phase.interview.persona.role}. ${phase.interview.facts.length === 1 ? '1 fact' : `${phase.interview.facts.length} facts`}, ${phase.interview.factsExpected} worth settling, up to ${phase.interview.maxTurns} questions.`}
              </p>
              <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5" data-testid="phase-interview-topics">
                {phase.interview.facts.map((fact) => (
                  <li key={fact.id} className="label-sm wrap">
                    {fact.topic}
                  </li>
                ))}
              </ul>
              {interviewError && (
                <Notice tone="fail" role="alert" testId="phase-interview-error">
                  {interviewError}
                </Notice>
              )}
              {editable && (
                <>
                  <p className="label-sm wrap">
                    Opening the editor reads the stakeholder&rsquo;s answers, and the read is kept on this
                    project&rsquo;s audit trail.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="edit"
                      busy={reading}
                      busyLabel="Reading the answers…"
                      testId="phase-interview-edit"
                      onClick={() => void openInterview()}
                    >
                      Edit the interview
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      testId="phase-interview-remove"
                      onClick={() => setRemoving(true)}
                    >
                      Remove the interview
                    </Button>
                  </div>
                </>
              )}
              {removing && (
                <Notice tone="warn" role="status" testId="phase-interview-remove-confirm">
                  <span className="block">
                    Remove the stakeholder interview? Learners given a version you publish from now on
                    meet no stakeholder in {phase.title}: they read the case file and work on their
                    backlog.
                  </span>
                  <span className="mt-2 flex flex-wrap items-center gap-2.5">
                    <Button
                      size="sm"
                      variant="danger"
                      busy={busy}
                      busyLabel="Removing…"
                      testId="phase-interview-remove-yes"
                      onClick={() =>
                        void save(
                          () => projectsApi.removeInterview(projectId, versionId),
                          setInterviewError,
                          () => {
                            setRemoving(false);
                            onLive('The stakeholder interview was removed.');
                          },
                        )
                      }
                    >
                      Remove it
                    </Button>
                    <Button size="sm" variant="ghost" testId="phase-interview-remove-no" onClick={() => setRemoving(false)}>
                      Keep it
                    </Button>
                  </span>
                </Notice>
              )}
            </>
          ) : (
            <>
              <p className="purpose wrap" data-testid="phase-interview-none">
                This phase has no stakeholder interview. Learners read the case file and work on their
                backlog.
              </p>
              {editable && (
                <div>
                  <Button size="sm" variant="secondary" icon="plus" testId="phase-interview-write" onClick={() => void openInterview()}>
                    Write an interview
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* The read-only documents a written phase mounts. */}
      {provenance && provenance.files.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid={`phase-files-${phase.key}`}>
          <h3 className="text-[13.5px] font-semibold text-ink">Documents learners read</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {provenance.files.map((file) => (
              <li key={file.path} className="flex min-w-0 flex-col gap-1" data-testid={`phase-file-${file.path}`}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-ink">{file.path}</span>
                  <ProvenanceChip state={file.provenance} referenceName={name} testId={`phase-file-provenance-${file.path}`} />
                  {editable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="file"
                      ariaLabel={`Replace ${file.path}`}
                      testId={`phase-file-replace-${file.path}`}
                      onClick={() => void openReplace(file.path)}
                    >
                      Replace
                    </Button>
                  )}
                </div>
                {/* The reviewer binds a document only when a brief names it. */}
                {phase.key === 'design' && (
                  <p className="label-sm wrap" data-testid={`phase-file-note-${file.path}`}>
                    {referenceFileBriefNote(file.path)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The files a learner starts a written task from. */}
      {starters.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid={`phase-starters-${phase.key}`}>
          <h3 className="text-[13.5px] font-semibold text-ink">Files learners start from</h3>
          <p className="label-sm wrap">
            A learner&rsquo;s work on a task begins from these files. Replacing one changes where a learner starts in a
            version you publish from now on.
          </p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {starters.map(({ path, taskKey }) => {
              const state = starterProvenance(phase, taskKey, replaced.has(path));
              return (
                <li key={path} className="flex min-w-0 flex-wrap items-center gap-2" data-testid={`phase-starter-${path}`}>
                  <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-ink">{path}</span>
                  {state && <ProvenanceChip state={state} referenceName={name} testId={`phase-starter-provenance-${path}`} />}
                  {editable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="file"
                      ariaLabel={`Replace ${path}`}
                      testId={`phase-starter-replace-${path}`}
                      onClick={() => void openReplace(path, true)}
                    >
                      Replace
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {replacing && (
        <FileReplaceDialog
          key={replacing.path}
          path={replacing.path}
          initial={replacing.content}
          unread={replacing.unread === true}
          busy={busy}
          error={fileError}
          note={phase.key === 'design' && !replacing.starter ? referenceFileBriefNote(replacing.path) : null}
          onClose={() => {
            setReplacing(null);
            setFileError('');
          }}
          onSave={(content) =>
            void save(
              () =>
                projectsApi.replaceFile(projectId, versionId, phase.key, {
                  path: replacing.path,
                  content,
                }),
              setFileError,
              (result) => {
                const also = 'alsoReplacedIn' in result ? (result as { alsoReplacedIn: string[] }).alsoReplacedIn : [];
                if (replacing.starter) {
                  const key = starterKey(versionId, phase.key);
                  const held = new Set(replacedStarters.get(key) ?? []);
                  held.add(replacing.path);
                  replacedStarters.set(key, held);
                  setReplaced(held);
                }
                setReplacing(null);
                onLive(
                  also.length > 0
                    ? `${replacing.path} was replaced here and in ${also.length === 1 ? 'one other phase' : `${also.length} other phases`} that read it.`
                    : `${replacing.path} was replaced.`,
                );
              },
            )
          }
        />
      )}
    </div>
  );
}
