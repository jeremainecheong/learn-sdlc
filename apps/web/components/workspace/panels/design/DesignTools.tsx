'use client';

/**
 * The IDE's view of the design.
 *
 * The design is written in its own room, `/workspace/[phaseId]/design`, where
 * the model, the contracts and the decisions have the space they need. What
 * the IDE keeps is the summary: what the design is made of, the diagram drawn
 * from it, the same forms for a quick edit, and the door back to the room.
 */
import { DESIGN_OLDER_FORMAT_ROOM } from '@learnsdlc/shared';
import { Button, Notice } from '@/components/ui';
import type { PhasePanelProps } from '../types';
import { DesignParts, DesignUnavailable } from './DesignBoard';
import { EntitiesCard, NotesCard, RelationsCard } from './BoardCards';
import { ChecksPanel } from './ChecksPanel';
import { DecisionsCard } from './DecisionsCard';
import { OperationsCard } from './OperationsCard';
import { UmlDiagram } from './UmlDiagram';
import { useDesign } from './useDesign';

export function DesignTools({ detail, files, setFile, helpers }: PhasePanelProps) {
  const design = useDesign({
    serverFiles: detail.files,
    files,
    setFile,
    spec: detail.design,
    flushSave: helpers.flushSave,
    setNotice: helpers.setNotice,
    setError: helpers.setError,
    busy: helpers.busy,
    phaseId: detail.id,
  });

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4" data-testid="phase-design-tools">
      <div className="flex flex-wrap items-center gap-2">
        <Button href={`/workspace/${detail.id}/design`} size="sm" testId="phase-design-open-editor">
          Open the design
        </Button>
      </div>
      {design.olderFormat ? (
        <Notice tone="info" testId="phase-design-older-format">
          {DESIGN_OLDER_FORMAT_ROOM}
        </Notice>
      ) : design.broken ? (
        <DesignUnavailable design={design} />
      ) : (
        <>
          <DesignParts design={design} files={files} />
          <UmlDiagram doc={design.doc} testId="phase-design-tools-uml" />
          <details className="flex flex-col gap-3" data-testid="phase-design-tools-board">
            <summary className="label-sm cursor-pointer">Edit the design here</summary>
            <div className="mt-3 flex flex-col gap-4">
              <EntitiesCard design={design} />
              <RelationsCard design={design} />
              <OperationsCard design={design} />
              <DecisionsCard design={design} />
              <NotesCard design={design} />
            </div>
          </details>
          {design.floor && (
            <ChecksPanel results={design.results} floor={design.floor} contracts={design.contracts} sequence={design.sequence} />
          )}
        </>
      )}
    </div>
  );
}
