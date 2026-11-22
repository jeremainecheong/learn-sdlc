'use client';

/**
 * Step 4: the starting point, the design record and the contracts a learner
 * opens the room on.
 *
 * They are the phase's own documents, edited here with the room's own cards
 * (the UML model, the operations and the decisions over the record, the API
 * workbench, the screens form and the sequence diagram, each while its
 * switch is on), so a teacher seeds exactly what the learner will see, and
 * never as text. The cards read the documents through `useDesign`, the
 * room's one reading of a design, over the bytes the editor holds; every
 * edit saves through `files.replace` 600 ms after the last change, validated
 * as the room validates it. The switches here are the ones the server holds:
 * a contract switched on in step 3 is seeded by its save, and drawn here once
 * it answers. Before the documents are read again for a switch, the edits
 * still waiting out their 600 ms are saved; one to a contract just switched
 * off is not sent, and the card says why.
 *
 * Three whole-document actions sit under the cards: Replace one document's
 * bytes, "Start empty" (the empty record and the empty contracts, after a
 * confirm line) and "Reset to the pack's" (the bytes of the version this
 * draft was opened from, through the same door with `reset: 'source'`),
 * drawn only where the draft was opened from one.
 *
 * A task still in the older format is shown in words: its documents are the
 * room's record until a save that sends the design body (the stories, the
 * learner's design, the floor or the criteria) converts it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesignSwitches, DraftPhaseView, DraftTaskView, TaskMutationResult } from '@learnsdlc/shared';
import {
  API_CONTRACT_JSON,
  DESIGN_DOCUMENT_LABEL,
  DESIGN_JSON,
  EMPTY_API_CONTRACT,
  EMPTY_DESIGN,
  EMPTY_SCREEN_CONTRACT,
  SCREEN_CONTRACT_JSON,
  designDocumentError,
  designDocumentPaths,
  serialiseDesign,
} from '@learnsdlc/shared';
import { Button } from '@/components/ui';
import { ApiError, describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { EntitiesCard, RelationsCard } from '@/components/workspace/panels/design/BoardCards';
import { OperationsCard } from '@/components/workspace/panels/design/OperationsCard';
import { DecisionsCard } from '@/components/workspace/panels/design/DecisionsCard';
import { ApiWorkbench } from '@/components/workspace/panels/design/ApiWorkbench';
import { ScreensForm } from '@/components/workspace/panels/design/ScreensForm';
import { DiagramStudio } from '@/components/workspace/panels/design/DiagramStudio';
import { useDesign } from '@/components/workspace/panels/design/useDesign';
import { FileReplaceDialog, ProvenanceChip, starterProvenance } from '../PhaseScenario';
import { BuilderCard, SaveLine, useCardSave, type CardState } from '../requirements/BuilderCard';
import { DESIGN_CONVERTING_STEPS, contractOffSentence, isContractOffRefusal, startingPointSentence } from './design-builder-model';

type Doc = { path: string; content: string };

const EMPTY_BYTES: Record<string, string> = {
  [DESIGN_JSON]: serialiseDesign(EMPTY_DESIGN),
  [API_CONTRACT_JSON]: EMPTY_API_CONTRACT,
  [SCREEN_CONTRACT_JSON]: EMPTY_SCREEN_CONTRACT,
};

const noop = () => undefined;

export function StartingPointCard({
  projectId,
  versionId,
  phase,
  task,
  forkedFromVersionId,
  editable,
  state,
  onFocusCard,
  onSaved,
  onDocuments,
}: {
  projectId: string;
  versionId: string;
  phase: DraftPhaseView;
  task: DraftTaskView;
  /** The version this draft was opened from, or null: "Reset to the pack's" is drawn only with one. */
  forkedFromVersionId: string | null;
  editable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
  /**
   * The documents as the card holds them (saved, with the edits not saved yet
   * over them), by path, whenever they change; null while they have not been
   * read, or after a read failed.
   */
  onDocuments?: (documents: Record<string, string> | null) => void;
}) {
  const spec = task.design!;
  const switches: DesignSwitches = { contracts: spec.contracts, sequence: spec.sequence };
  const older = task.designOlderFormat === true;
  const writable = editable && !older;
  const paths = designDocumentPaths(spec.contracts);
  const pathsKey = paths.join('|');
  // The documents mounted now, for a save that runs after a switch changed them.
  const mounted = useRef(paths);
  mounted.current = paths;

  // The documents as the server holds them (null while they load), and the
  // edits not yet saved, by path.
  const [server, setServer] = useState<Doc[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [files, setFiles] = useState<Record<string, string>>({});
  const buffers = useRef<Record<string, string>>({});
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoadError('');
    try {
      const rows = await projectsApi.files(projectId, versionId);
      if (!alive.current) return;
      const wanted = pathsKey.split('|');
      setServer(
        (rows ?? [])
          .filter((one) => one.phaseKey === 'design' && one.content !== null && wanted.includes(one.path))
          .map((one) => ({ path: one.path, content: one.content as string })),
      );
      // An edit still waiting (one made, or one held back by a save in flight,
      // while the documents were read) stays over what was read; the rest is
      // what the server now holds.
      const kept: Record<string, string> = {};
      for (const path of [...pending.current]) {
        if (wanted.includes(path)) kept[path] = buffers.current[path];
        else pending.current.delete(path);
      }
      buffers.current = kept;
      setFiles(kept);
    } catch (err) {
      if (alive.current) setLoadError(describeError(err, 'The starting point could not be read. Try again in a moment.'));
    }
  }, [projectId, versionId, pathsKey]);
  const save = useCardSave({
    label: 'Starting point',
    // An edit to a contract switched off is not checked: `send` drops it with
    // the builder's sentence, so it never holds back the other documents.
    validate: () => {
      for (const path of pending.current) {
        if (!mounted.current.includes(path)) continue;
        const problem = designDocumentError(path, buffers.current[path] ?? '', 'starting');
        if (problem) return problem;
      }
      return '';
    },
    send: async () => {
      let last: TaskMutationResult | null = null;
      // An edit to a contract whose switch is off is not sent (or, sent while
      // step 3's save was out, is refused): it is dropped and said in the
      // builder's words, and the other documents still save.
      const off = new Set<string>();
      for (const path of [...pending.current]) {
        if (!mounted.current.includes(path)) {
          pending.current.delete(path);
          off.add(contractOffSentence(path));
          continue;
        }
        const content = buffers.current[path];
        try {
          last = await projectsApi.replaceFile(projectId, versionId, 'design', { path, content });
        } catch (err) {
          if (err instanceof ApiError && isContractOffRefusal(path, err.message, phase.title)) {
            pending.current.delete(path);
            off.add(contractOffSentence(path));
            continue;
          }
          if (last) onSaved(last);
          throw err;
        }
        // An edit made while this one was out stays pending for the next run.
        if (buffers.current[path] === content) pending.current.delete(path);
      }
      if (off.size) {
        if (last) onSaved(last);
        throw new ApiError(400, [...off].join(' '));
      }
      // A run that found nothing left to send (its edits went out with the run before it) answers null.
      return last;
    },
    onSaved,
  });

  // Read again whenever the documents the switches mount change (a contract
  // switched on is seeded by the server, one switched off is gone), once the
  // edits still waiting out their delay are saved, so none is dropped.
  const flush = useRef(save.saveNow);
  flush.current = save.saveNow;
  useEffect(() => {
    void (async () => {
      if (pending.current.size) await flush.current();
      await reload();
    })();
  }, [reload, older]);

  const setFile = useCallback(
    (path: string, content: string) => {
      buffers.current = { ...buffers.current, [path]: content };
      pending.current.add(path);
      setFiles(buffers.current);
      save.changed();
      save.saveSoon();
    },
    [save],
  );

  const serverFiles = useMemo(() => server ?? [], [server]);
  // One spec object while the task's design holds, so useDesign's view is not worked out again on every render.
  const designSpec = useMemo(
    () => ({ contracts: spec.contracts, sequence: spec.sequence, stories: spec.stories, floor: spec.floor }),
    [spec.contracts, spec.sequence, spec.stories, spec.floor],
  );
  const design = useDesign({
    serverFiles,
    files,
    setFile,
    spec: designSpec,
    flushSave: save.saveNow,
    setNotice: noop,
    setError: noop,
    busy: !writable,
  });
  const merged = (path: string) => files[path] ?? serverFiles.find((one) => one.path === path)?.content;

  // Step 3 asks before a switch-off loses a document that holds something.
  const told = useRef(onDocuments);
  told.current = onDocuments;
  useEffect(() => {
    if (server === null || loadError) {
      told.current?.(null);
      return;
    }
    const held: Record<string, string> = {};
    for (const one of server) held[one.path] = one.content;
    told.current?.({ ...held, ...files });
  }, [server, loadError, files]);

  // The whole-document actions: Replace one, Start empty, Reset to the pack's.
  const [asking, setAsking] = useState<'empty' | 'reset' | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replaced, setReplaced] = useState<ReadonlySet<string>>(() => new Set());
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState('');
  const [replaceError, setReplaceError] = useState('');

  const runAll = async (bodyFor: (path: string) => { path: string; content?: string; reset?: 'source' }) => {
    // The whole starting point is written over: an edit still waiting is dropped with it.
    pending.current.clear();
    setAsking(null);
    setWorking(true);
    setActionError('');
    // Each document on its own: a refusal of one (a source version with no
    // API contract, say) is said, and the next document is still tried. The
    // editor gets the answer of the last one that saved, so its report and
    // provenance are those of the documents as they now stand.
    let last: TaskMutationResult | null = null;
    const refusals: string[] = [];
    try {
      for (const path of paths) {
        try {
          last = await projectsApi.replaceFile(projectId, versionId, 'design', bodyFor(path));
        } catch (err) {
          refusals.push(describeError(err, 'The starting point could not be changed. Try again in a moment.'));
        }
      }
      if (last) onSaved(last);
      if (alive.current && refusals.length) setActionError([...new Set(refusals)].join(' '));
      await reload();
    } finally {
      if (alive.current) setWorking(false);
    }
  };

  const documents = (
    <ul className="tde-docs" aria-label="The documents learners start from" data-testid={`phase-starters-${phase.key}`}>
      {paths.map((path) => {
        const whose = starterProvenance(phase, task.taskKey, replaced.has(path));
        return (
          <li key={path} className="tde-doc" data-testid={`phase-starter-${path}`}>
            <span className="tde-doc-name">{DESIGN_DOCUMENT_LABEL[path] ?? path}</span>
            {whose && (
              <ProvenanceChip
                state={whose}
                referenceName={phase.provenance?.referenceName ?? ''}
                testId={`phase-starter-provenance-${path}`}
              />
            )}
            {writable && (
              <Button
                size="sm"
                variant="ghost"
                icon="file"
                ariaLabel={`Replace the ${(DESIGN_DOCUMENT_LABEL[path] ?? path).toLowerCase()}`}
                disabled={working}
                testId={`phase-starter-replace-${path}`}
                onClick={() => {
                  setReplaceError('');
                  setReplacing(path);
                }}
              >
                Replace
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <BuilderCard
      n={4}
      title="Starting point"
      purpose="What the learner's room opens on. Leave it empty, or seed part of the design for them to finish."
      state={state}
      testId="tde-starting-point"
      onFocusCard={onFocusCard}
    >
      {loadError && (
        <p role="alert" className="label-sm wrap text-fail" data-testid="tde-start-load-error">
          {loadError}
        </p>
      )}
      <p className="purpose wrap" data-testid="tde-start-words">
        {server === null
          ? 'Reading the starting point.'
          : startingPointSentence(
              paths.map((path) => ({ path, content: merged(path) ?? null })),
              switches,
            )}
      </p>
      {documents}
      {older && editable && (
        <p className="tre-legacy label-sm wrap" data-testid="tde-start-older">
          {`The starting point opens here once the task is converted. Save ${DESIGN_CONVERTING_STEPS} to convert it.`}
        </p>
      )}
      {writable && server !== null && (
        <div className="tde-room" data-testid="tde-start-cards">
          {design.broken ? (
            <p role="alert" className="label-sm wrap text-fail" data-testid="tde-start-broken">
              {`The starting design record cannot be opened: ${design.broken}. Replace it, start empty or reset it.`}
            </p>
          ) : (
            <>
              <EntitiesCard design={design} />
              <RelationsCard design={design} />
              <OperationsCard design={design} />
              <DecisionsCard design={design} />
              {spec.sequence && <DiagramStudio design={design} />}
            </>
          )}
          {spec.contracts.api && merged(API_CONTRACT_JSON) !== undefined && (
            <ApiWorkbench files={{ [API_CONTRACT_JSON]: merged(API_CONTRACT_JSON) as string }} setFile={setFile} audience="teacher" />
          )}
          {spec.contracts.screens && merged(SCREEN_CONTRACT_JSON) !== undefined && (
            <ScreensForm text={merged(SCREEN_CONTRACT_JSON)} editable onChange={(next) => setFile(SCREEN_CONTRACT_JSON, next)} />
          )}
        </div>
      )}
      {writable && asking && (
        <div className="tde-confirm" role="group" aria-label={asking === 'empty' ? 'Start empty' : "Reset to the pack's"}>
          <p className="label-sm wrap" data-testid="tde-start-confirm-line">
            {asking === 'empty'
              ? 'This replaces the starting point with an empty design: no entities, no operations and no decisions, and empty contracts. Learners in a version you publish from now on start from nothing.'
              : 'This puts back the starting point of the version this draft was opened from, and your changes to it are lost.'}
          </p>
          <span className="tde-actions">
            <Button
              size="sm"
              variant="danger"
              testId="tde-start-confirm"
              onClick={() =>
                void runAll(
                  asking === 'empty' ? (path) => ({ path, content: EMPTY_BYTES[path] }) : (path) => ({ path, reset: 'source' }),
                )
              }
            >
              {asking === 'empty' ? 'Start empty' : 'Reset it'}
            </Button>
            <Button size="sm" variant="ghost" testId="tde-start-keep" onClick={() => setAsking(null)}>
              Keep it
            </Button>
          </span>
        </div>
      )}
      {actionError && (
        <p role="alert" className="label-sm wrap text-fail" data-testid="tde-start-error">
          {actionError}
        </p>
      )}
      {writable && (
        <div className="tre-save-row">
          <SaveLine save={save} testId="tde-start-status" idle="Edits save as you make them." />
          <span className="tde-actions">
            <Button size="sm" variant="ghost" disabled={working} testId="tde-start-empty" onClick={() => setAsking('empty')}>
              Start empty
            </Button>
            {forkedFromVersionId && (
              <Button
                size="sm"
                variant="ghost"
                icon="refresh"
                disabled={working}
                testId="tde-start-reset"
                onClick={() => setAsking('reset')}
              >
                Reset to the pack&rsquo;s
              </Button>
            )}
          </span>
        </div>
      )}
      {replacing && (
        <FileReplaceDialog
          key={replacing}
          path={replacing}
          initial={merged(replacing) ?? ''}
          unread={server === null}
          busy={working}
          error={replaceError}
          note={null}
          onClose={() => {
            setReplacing(null);
            setReplaceError('');
          }}
          onSave={(content) => {
            const path = replacing;
            // The bytes sent here replace the document: an edit still waiting to it is dropped.
            pending.current.delete(path);
            setWorking(true);
            setReplaceError('');
            void projectsApi
              .replaceFile(projectId, versionId, 'design', { path, content })
              .then(async (result) => {
                onSaved(result);
                if (!alive.current) return;
                setReplaced((was) => new Set([...was, path]));
                setReplacing(null);
                await reload();
              })
              .catch((err) => {
                if (alive.current) setReplaceError(describeError(err, 'That file could not be replaced. Try again in a moment.'));
              })
              .finally(() => {
                if (alive.current) setWorking(false);
              });
          }}
        />
      )}
    </BuilderCard>
  );
}
