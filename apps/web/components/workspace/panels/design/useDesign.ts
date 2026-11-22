'use client';
/**
 * The Design room's one reading of the learner's design: the record and the
 * contracts that are on, as the server and the shared floor read them. It
 * never fetches; every write goes out through `setFile`, debounced like typing.
 */
import { ApiError } from '@/lib/api';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  API_CONTRACT_JSON,
  DESIGN_JSON,
  EMPTY_DESIGN,
  SCREEN_CONTRACT_JSON,
  designReviewProjection,
  evaluateDesignFloor,
  serialiseDesign,
  validateDesignRecord,
  type Design,
  type DesignContracts,
  type DesignDecisionStatus,
  type DesignFloor,
  type DesignFloorResult,
  type DesignStory,
  type PhaseDetail,
} from '@learnsdlc/shared';
import { isTouched, moveDesignTouched, readDesignTouched } from '../requirements/touched';

export interface DesignView {
  doc: Design;
  /** Why the saved record does not validate, or null. A broken record is shown as broken and never overwritten. */
  broken: string | null;
  /** The floor over the record and the switched-on contracts, as the review grades it. */
  results: DesignFloorResult[];
  apiText: string | undefined;
  screensText: string | undefined;
  /** The phase carries no design spec: its Design task still grades the older format. */
  olderFormat: boolean;
  /** The documents as the review reads them, one path per field: what the assistant's marks are matched against. */
  projection: Record<string, string>;
}

const read = (path: string, files: Record<string, string>, serverFiles: { path: string; content: string }[]) =>
  files[path] ?? serverFiles.find((f) => f.path === path)?.content;

export function designView(
  files: Record<string, string>,
  serverFiles: { path: string; content: string }[],
  spec: PhaseDetail['design'],
): DesignView {
  if (!spec) return { doc: EMPTY_DESIGN, broken: null, results: [], apiText: undefined, screensText: undefined, olderFormat: true, projection: {} };
  const raw = read(DESIGN_JSON, files, serverFiles) ?? serialiseDesign(EMPTY_DESIGN);
  const out = validateDesignRecord(raw);
  const apiText = spec.contracts.api ? read(API_CONTRACT_JSON, files, serverFiles) : undefined;
  const screensText = spec.contracts.screens ? read(SCREEN_CONTRACT_JSON, files, serverFiles) : undefined;
  const documents = { [DESIGN_JSON]: raw, [API_CONTRACT_JSON]: apiText, [SCREEN_CONTRACT_JSON]: screensText };
  const results = evaluateDesignFloor(documents, spec);
  return { doc: out.design ?? EMPTY_DESIGN, broken: out.error, results, apiText, screensText, olderFormat: false, projection: designReviewProjection(documents, spec) };
}

/** What the hook needs, whoever is hosting the room. */
export interface DesignSource {
  /** The phase's files as the server has them. */
  serverFiles: { path: string; content: string }[];
  /** Live buffers, path to content. Wins over the server copy. */
  files: Record<string, string>;
  setFile: (path: string, content: string) => void;
  /** The phase's design spec: its switches, its stories and its floor. Absent on the older format. */
  spec: PhaseDetail['design'];
  /** Flush pending edits. Rejects if the save fails. */
  flushSave: () => Promise<void>;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
  /** A run or a submission is in flight; the forms wait for it. */
  busy?: boolean;
  /** The phase, for the marks an applied Agentic proposal left (`recordDesignTouched`). */
  phaseId?: string;
}

export interface DesignState extends DesignView {
  contracts: DesignContracts;
  sequence: boolean;
  stories: DesignStory[];
  floor: DesignFloor | null;
  write: (next: Design) => void;
  writeContract: (path: string, text: string) => void;
  /** Set a decision's status, stamping `decidedAt` the first time it becomes accepted. */
  setDecisionStatus: (index: number, status: DesignDecisionStatus) => void;
  /** Flush the save; the page then shows the checks panel. Refused on the older format. */
  check: () => Promise<void>;
  /**
   * The fields of one item the assistant wrote and that still hold its text:
   * `item` is a review path ('design/operation-2'), `fields` its field names
   * ('' for the item's own path). Empty when there is no such mark.
   */
  assisted: (item: string, fields?: string[]) => string[];
  busy: boolean;
  writing: boolean;
}

const OFF: DesignContracts = { api: false, screens: false };

export function useDesign(source: DesignSource): DesignState {
  const { serverFiles, files, setFile, spec, flushSave, setNotice, setError, phaseId } = source;
  const [writing, setWriting] = useState(false);
  // The page can be left mid-save; the notice belongs to a live room.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const view = useMemo(() => designView(files, serverFiles, spec), [files, serverFiles, spec]);
  const { doc, broken, results, projection } = view;
  // The marks an applied proposal left, read again whenever the saved files move (an apply refreshes them)
  // and whenever the learner's own edit moves them (`moved`).
  const [moved, setMoved] = useState(0);
  const marks = useMemo(() => readDesignTouched(phaseId), [phaseId, serverFiles, moved]);
  const assisted = useCallback(
    (item: string, fields: string[] = ['']) => fields.filter((field) => isTouched(marks, projection, field ? `${item}/${field}` : item)),
    [marks, projection],
  );
  const contracts = spec?.contracts ?? OFF;

  const write = useCallback(
    (next: Design) => {
      // A record that does not validate is the learner's to repair; a form never overwrites it.
      if (broken || !spec) return;
      const text = serialiseDesign(next);
      // an item added or removed through the forms takes its marks with it
      if (moveDesignTouched(phaseId, { [DESIGN_JSON]: serialiseDesign(doc) }, { [DESIGN_JSON]: text })) setMoved((n) => n + 1);
      setFile(DESIGN_JSON, text);
    },
    [broken, doc, phaseId, setFile, spec],
  );

  const writeContract = useCallback(
    (path: string, text: string) => {
      const on = (path === API_CONTRACT_JSON && contracts.api) || (path === SCREEN_CONTRACT_JSON && contracts.screens);
      if (!on) return;
      const was = path === API_CONTRACT_JSON ? view.apiText : view.screensText;
      if (was !== undefined && moveDesignTouched(phaseId, { [path]: was }, { [path]: text })) setMoved((n) => n + 1);
      setFile(path, text);
    },
    [contracts.api, contracts.screens, phaseId, setFile, view.apiText, view.screensText],
  );

  // The one clock this module reads, and it reads it on a click. A decision
  // keeps the day it was first accepted: accepting twice, or superseding it
  // and accepting it again, never moves the stamp the journal orders by.
  const setDecisionStatus = useCallback(
    (index: number, status: DesignDecisionStatus) =>
      write({
        ...doc,
        decisions: doc.decisions.map((d, i) =>
          i !== index
            ? d
            : { ...d, status, ...(status === 'accepted' && !d.decidedAt ? { decidedAt: new Date().toISOString() } : {}) },
        ),
      }),
    [doc, write],
  );

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const check = useCallback(async () => {
    // The older format has no floor to report: "0 of 0 checks pass" would be a false answer.
    if (!spec) return;
    setWriting(true);
    try {
      await flushSave();
      if (!alive.current) return;
      setNotice(`Design checked: ${passed} of ${total} checks pass.`);
    } catch (err) {
      // a refusal of the room's own (an unfinished screen or endpoint) says what to finish; anything else, the save failed
      if (alive.current) setError(err instanceof ApiError && err.status < 500 ? err.message : 'Your design did not save. Try the button again.');
    } finally {
      if (alive.current) setWriting(false);
    }
  }, [flushSave, passed, setError, setNotice, spec, total]);

  return {
    ...view,
    contracts,
    sequence: spec?.sequence ?? false,
    stories: spec?.stories ?? [],
    floor: spec?.floor ?? null,
    write,
    writeContract,
    setDecisionStatus,
    check,
    assisted,
    busy: Boolean(source.busy),
    writing,
  };
}
