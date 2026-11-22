'use client';

/**
 * Step 2: the files learners start from and the checks that grade them,
 * read-only.
 *
 * The phase's mounted files (the ones learners edit and the ones they only
 * read; the runbook record is left out, as learners write it through forms),
 * the file rules (label, target, criterion), the smoke run (Dockerfile,
 * command, expected line) and the drill (fault, description, faulted files).
 * They change only when the project is uploaded again, so nothing here is an
 * input and nothing saves.
 */
import type { AuthoringFileView, DraftPhaseView, DraftTaskView } from '@learnsdlc/shared';
import { Chip } from '@/components/ui';
import { isRoomRecordPath } from '@/components/workspace/records';
import { SmokeDrillReadOnly } from '../ExecutableTask';
import { BuilderCard, type CardState } from '../requirements/BuilderCard';

type Row = Pick<AuthoringFileView, 'path' | 'editable' | 'phaseKey'>;

export function FilesAndChecksCard({
  phase,
  task,
  rows,
  loadError,
  state,
  onFocusCard,
}: {
  phase: DraftPhaseView;
  task: DraftTaskView;
  /** The draft's file rows, or null while they are read. */
  rows: readonly Row[] | null;
  /** Why the rows could not be read, or ''. */
  loadError: string;
  state: CardState;
  onFocusCard: () => void;
}) {
  const config = task.config;
  const mounted = (rows ?? []).filter((one) => one.phaseKey === phase.key && !isRoomRecordPath(one.path));
  return (
    <BuilderCard
      n={2}
      title="Files and checks"
      purpose="What learners start from and what grades it. These change only when the project is uploaded again."
      state={state}
      testId="tdp-files"
      onFocusCard={onFocusCard}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="label-sm">The files learners start from</span>
        {loadError ? (
          <p role="alert" className="label-sm wrap text-fail" data-testid="tdp-files-error">
            {loadError}
          </p>
        ) : rows === null ? (
          <p className="purpose">Reading the files.</p>
        ) : mounted.length ? (
          <ul className="tde-docs" data-testid="tdp-files-list">
            {mounted.map((one) => (
              <li key={one.path} className="tde-doc">
                <code className="mono tde-doc-name wrap">{one.path}</code>
                <Chip tone={one.editable ? 'accent' : 'neutral'}>{one.editable ? 'Learners edit this' : 'Read only'}</Chip>
              </li>
            ))}
          </ul>
        ) : (
          <p className="purpose">This phase mounts no files.</p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="label-sm">The file rules</span>
        {config?.fileRules.length ? (
          <ul className="tde-docs" data-testid="tdp-file-rules">
            {config.fileRules.map((rule) => (
              <li key={rule.id} className="tde-doc">
                <span className="tde-doc-name wrap">{rule.label}</span>
                <code className="mono wrap">{rule.target}</code>
                <code className="mono wrap">{rule.criterion}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="purpose">No file rules.</p>
        )}
      </div>

      <SmokeDrillReadOnly phaseTitle={phase.title} />
      {config && (
        <dl className="flex min-w-0 flex-col gap-1.5" data-testid="tdp-smoke">
          <dt className="label-sm">The smoke run builds</dt>
          <dd className="m-0">
            <code className="mono wrap">{config.smoke.dockerfile}</code>
          </dd>
          <dt className="label-sm">and runs</dt>
          {config.smoke.commands.map((command, at) => (
            <dd key={at} className="m-0">
              <code className="mono wrap">{command.join(' ')}</code>
            </dd>
          ))}
          <dt className="label-sm">expecting the line</dt>
          <dd className="m-0">
            <code className="mono wrap">{config.smoke.expectInOutput}</code>
          </dd>
        </dl>
      )}
      {config?.drill ? (
        <dl className="flex min-w-0 flex-col gap-1.5" data-testid="tdp-drill">
          <dt className="label-sm">The drill</dt>
          <dd className="m-0">
            <code className="mono wrap">{config.drill.fault}</code>
          </dd>
          <dd className="m-0 wrap">{config.drill.description}</dd>
          <dt className="label-sm">It breaks</dt>
          {config.drill.faultedFiles.map((path) => (
            <dd key={path} className="m-0">
              <code className="mono wrap">{path}</code>
            </dd>
          ))}
        </dl>
      ) : (
        config && <p className="purpose">This phase has no drill.</p>
      )}
    </BuilderCard>
  );
}
