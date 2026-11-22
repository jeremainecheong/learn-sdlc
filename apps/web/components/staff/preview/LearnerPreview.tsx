'use client';

/**
 * A version as a learner of it would first read it, for its owner.
 *
 * **Read-only, and nothing else.** One request, the preview GET; no Run,
 * Check, Submit, Ask or mentor control; no editor, so no write handler; the
 * learner's project store (`useProject`) is never mounted and no learner
 * store is touched. The words are drawn in the learner rooms' own typography
 * (`PlainText` for the teacher's words, the `ui` primitives), read-only. The banner says what this is
 * on every frame, the loading and the refusal included.
 */
import { useEffect, useState } from 'react';
import type { LearnerPreviewPhase, LearnerPreviewView } from '@learnsdlc/shared';
import { CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, EMPTY_RUNBOOK, RUNBOOK_JSON, changeFloorSentence, designFloorSentence, serialiseRunbook, validateChangeRequestRecord } from '@learnsdlc/shared';
import { startingPointSentence, switchesSentence } from '@/components/staff/projects/design/design-builder-model';
import { PlainText } from '@/components/PlainText';
import { RunbookTab } from '@/components/workspace/panels/deployment/RunbookTab';
import { AmendmentsForm, ReleaseForm, RequestForm, TestsForm } from '@/components/workspace/panels/maintenance/ChangeForms';
import { Breadcrumbs, Chip, Notice, Section } from '@/components/ui';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { PREVIEW_BANNER, PREVIEW_EVIDENCE_WORD, PREVIEW_LOADING, PREVIEW_REFUSED } from './copy';
import { writeGuideMark } from '@/components/staff/guide/guide-marks';

export function LearnerPreview({ projectId, versionId }: { projectId: string; versionId: string }) {
  const [view, setView] = useState<LearnerPreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    projectsApi
      .learnerPreview(projectId, versionId)
      .then((answer) => {
        if (!alive) return;
        setView(answer);
        // Only a preview that loaded counts on the editor's rail: a refusal, or
        // a page left before the answer, writes nothing.
        writeGuideMark('previewed', versionId);
      })
      .catch((err) => {
        if (alive) setError(describeError(err, PREVIEW_REFUSED));
      });
    return () => {
      alive = false;
    };
  }, [projectId, versionId]);

  const editorHref = `/teacher/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`;
  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-w-0 max-w-[900px] flex-col gap-4 p-4 sm:p-6" data-testid="learner-preview">
      <div className="sticky top-0 z-10" data-testid="preview-banner-frame">
        <Notice tone="warn" role="note" icon="info" testId="preview-banner">
          {PREVIEW_BANNER}
        </Notice>
      </div>
      <Breadcrumbs
        items={[
          { label: 'Projects', href: '/teacher/projects' },
          { label: view?.title ?? 'Project', href: editorHref },
          { label: 'Learner preview' },
        ]}
      />
      {error && (
        <Notice tone="fail" role="alert" testId="preview-error">
          {error}
        </Notice>
      )}
      {!view && !error && (
        <p className="purpose" data-testid="preview-loading">
          {PREVIEW_LOADING}
        </p>
      )}
      {view && (
        <>
          <header className="flex min-w-0 flex-col gap-1.5">
            <h1 className="h2 wrap">{view.title}</h1>
            <p className="purpose wrap">{`Version ${view.version}, as a learner opens it, phase by phase.`}</p>
          </header>
          <nav aria-label="Phases in order">
            <ol className="flex flex-wrap gap-2" data-testid="preview-stepper">
              {view.phases.map((phase) => (
                <li key={phase.key} data-testid={`preview-step-${phase.key}`}>
                  <a href={`#preview-phase-${phase.key}`} className="chip">
                    {`${phase.order}. ${phase.title}`}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          {view.phases.map((phase) => (
            <PreviewPhase key={phase.key} phase={phase} />
          ))}
        </>
      )}
    </main>
  );
}

function PreviewPhase({ phase }: { phase: LearnerPreviewPhase }) {
  return (
    <Section
      id={`preview-phase-${phase.key}`}
      title={`${phase.order}. ${phase.title}`}
      purpose={<span data-testid={`preview-gate-${phase.key}`}>{phase.gate}</span>}
      hue={phase.key}
      testId={`preview-phase-${phase.key}`}
    >
      {/* Every teacher's text below is served through learnerText, so it is drawn plain with nothing more taken. */}
      {phase.intro && <div data-testid={`preview-intro-${phase.key}`}><PlainText text={phase.intro} commentsHidden /></div>}
      {phase.objectives.length > 0 && (
        <div>
          <h3 className="h4">What learners aim for</h3>
          <ul className="list-disc pl-5" data-testid={`preview-objectives-${phase.key}`}>
            {phase.objectives.map((objective) => (
              <li key={objective}><PlainText text={objective} commentsHidden /></li>
            ))}
          </ul>
        </div>
      )}
      {phase.interview && (
        <div className="panel p-3" data-testid={`preview-interview-${phase.key}`}>
          <h3 className="h4">{`Stakeholder: ${phase.interview.persona.name}`}</h3>
          <p className="purpose wrap">{phase.interview.persona.role}</p>
          <blockquote className="wrap">{phase.interview.opening}</blockquote>
        </div>
      )}
      <div>
        <h3 className="h4">Tasks</h3>
        <ul className="flex flex-col gap-1.5" data-testid={`preview-tasks-${phase.key}`}>
          {phase.tasks.map((task) => (
            <li key={task.key} className="flex flex-wrap items-center gap-2">
              <span className="wrap">{task.title}</span>
              <Chip>{PREVIEW_EVIDENCE_WORD[task.evidence]}</Chip>
              {!task.required && <Chip tone="outline">Optional</Chip>}
              {task.needsSignOff && <Chip tone="accent">You sign this off</Chip>}
            </li>
          ))}
        </ul>
      </div>
      {phase.quizzes.map((quiz) => (
        <div key={quiz.taskKey} data-testid={`preview-quiz-${quiz.taskKey}`}>
          <h3 className="h4">{quiz.title}</h3>
          <p className="purpose">{`A paper draws ${quiz.drawn} of these ${quiz.questions.length} questions. The pass mark is ${quiz.passMark}%.`}</p>
          <ol className="list-decimal pl-5">
            {quiz.questions.map((question) => (
              <li key={question.id}>
                <div data-testid={`preview-stem-${question.id}`}><PlainText text={question.stem} commentsHidden /></div>
                <ul className="list-disc pl-5" data-testid={`preview-options-${question.id}`}>
                  {question.options.map((option, at) => (
                    <li key={`${question.id}-${at}`}><PlainText text={option} commentsHidden /></li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      ))}
      {phase.brief && (
        <div data-testid={`preview-brief-${phase.key}`}>
          <h3 className="h4">The brief</h3>
          <PlainText text={phase.brief} commentsHidden />
        </div>
      )}
      {/* A Design phase of the design kind is drawn in words: no file and no markdown. */}
      {phase.design ? (
        <PreviewDesign phase={phase} />
      ) : (
        <div>
          <h3 className="h4">Files</h3>
          <ul className="flex flex-col gap-1.5" data-testid={`preview-files-${phase.key}`}>
            {/* A phase that grades a runbook or a change request shows it in its forms below, never as a file. */}
            {phase.files.filter((file) => !(phase.runbook && file.path === RUNBOOK_JSON) && !(phase.change && file.path === CHANGE_REQUEST_JSON)).map((file) => (
              <li key={file.path}>
                <details>
                  <summary className="flex flex-wrap items-center gap-2">
                    <code className="wrap">{file.path}</code>
                    <Chip tone={file.editable ? 'accent' : 'neutral'}>{file.editable ? 'Learners edit this' : 'Read only'}</Chip>
                  </summary>
                  <pre className="wrap overflow-x-auto text-[12px]" tabIndex={0} aria-label={`${file.path}, as learners first see it`}>
                    {file.content}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
      {phase.runbook && <PreviewRunbook phase={phase} />}
      {phase.change && <PreviewChangeRoom phase={phase} />}
      <div data-testid={`preview-checks-${phase.key}`}>
        <h3 className="h4">How it is checked</h3>
        {phase.canRun && <p className="purpose wrap">{`Learners can run: ${phase.runLabel}.`}</p>}
        <ul className="list-disc pl-5">
          {phase.checkLabels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

/**
 * A Design phase of the design kind, in words where the file list would be:
 * the stories the learner designs for, what their design is made of, the
 * floor it is checked against, and the starting point as counts read from
 * the phase's documents with the shared readers. No file name and no
 * markdown: the learner's room never shows either.
 */
export function PreviewDesign({ phase }: { phase: LearnerPreviewPhase }) {
  const design = phase.design;
  if (!design) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="preview-design">
      <h3 className="h4">Stories to design for</h3>
      {design.stories.length ? (
        <ul className="flex flex-col gap-1.5" data-testid="preview-design-stories">
          {design.stories.map((story) => (
            <li key={story.id} className="flex min-w-0 flex-col">
              <span className="flex flex-wrap items-center gap-2">
                <code>{story.id}</code>
                <span className="wrap">{story.title}</span>
              </span>
              <span className="purpose wrap">{story.line}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="purpose wrap">No stories are listed.</p>
      )}
      <p className="wrap">{switchesSentence(design)}</p>
      <p className="wrap">{`Their design needs ${designFloorSentence(design.floor, design)}.`}</p>
      <p className="wrap">{startingPointSentence(phase.files, design)}</p>
    </div>
  );
}

const noop = () => undefined;

/**
 * A Deployment phase that grades a runbook, as the learner's Runbook tab
 * first shows it: the room's own forms, read-only, over the phase's starting
 * record, or over the empty runbook when the phase ships none. No file name:
 * the learner's room never shows one.
 */
export function PreviewRunbook({ phase }: { phase: LearnerPreviewPhase }) {
  const spec = phase.runbook;
  if (!spec) return null;
  const text = phase.files.find((file) => file.path === RUNBOOK_JSON)?.content ?? serialiseRunbook(EMPTY_RUNBOOK);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="preview-runbook">
      <h3 className="h4">The runbook</h3>
      <RunbookTab detail={{ key: phase.key, artifactKind: 'config', runbook: spec }} text={text} onChange={noop} editable={false} />
    </div>
  );
}

/**
 * A Maintenance phase that grades a change request, as the learner's change
 * room first shows it: the ticket and the room's own forms (Request, Contract
 * when the switch is on, Tests, Release), read-only, over the phase's starting
 * record, or over the empty change request when the phase ships none (or one
 * that does not read). The floor in words, without the room's Check control.
 * No file name: the learner's room never shows one.
 */
export function PreviewChangeRoom({ phase }: { phase: LearnerPreviewPhase }) {
  const spec = phase.change;
  if (!spec) return null;
  const text = phase.files.find((file) => file.path === CHANGE_REQUEST_JSON)?.content ?? '';
  const change = (text.trim() ? validateChangeRequestRecord(text, spec.ticket.acceptance.map((one) => one.id)).change : null) ?? EMPTY_CHANGE_REQUEST;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="preview-change">
      <h3 className="h4">The change request</h3>
      <p className="wrap">{`The floor asks for ${changeFloorSentence(spec.floor, spec.contract)}.`}</p>
      <RequestForm ticket={spec.ticket} change={change} files={[]} editable={false} onChange={noop} />
      {spec.contract && <AmendmentsForm change={change} editable={false} onChange={noop} />}
      <TestsForm ticket={spec.ticket} change={change} editable={false} onChange={noop} />
      <ReleaseForm ticket={spec.ticket} change={change} editable={false} onChange={noop} />
    </div>
  );
}

