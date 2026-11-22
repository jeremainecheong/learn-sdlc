'use client';

/**
 * One reading of the maintenance phase, shared by the brief card, the Change
 * tab and the change room so they never disagree about whether the contract is
 * written, the regression suite is green or the release is recorded.
 *
 * The ticket is the teacher's (`PhaseDetail.change.ticket`); the change's name,
 * its target file and its release are read from the learner's change request
 * record. Everything comes from props. The panel makes no request of its own.
 */
import { useMemo } from 'react';
import {
  CHANGE_REQUEST_JSON,
  type AnalyzerReport,
  type ChangeRequest,
  type ChangeTicket,
  type EnrollmentView,
  type ImpactFunction,
  type MutationReport,
  type PhaseDetail,
  type SubmissionView,
  type TestCaseResult,
} from '@learnsdlc/shared';
import type { StatusState } from '@/lib/phase';
import { projectName } from '@/lib/project-name';
import {
  CONTRACTS_JSON,
  baseName,
  diffRows,
  isWritten,
  maintainerNote,
  parseContracts,
  splitContracts,
  type ContractOperation,
  type ContractsDoc,
  type DiffRow,
} from './contracts';
import { impactNodes, markCounts, readScope, type ChangeMark } from './impact';
import { acceptanceLines, buildSuites, type ContractLine, type Suite } from './regression';
import { buildRelease, releaseWritten, type ReleaseRecord } from './release';
import { changeOperation, changeSignature, changeTarget, readChangeText } from './change-edit';

/**
 * What the reading needs. The Change tab hands it its panel props and the
 * change request page hands it what it loaded; both carry these four, and
 * neither has to own the rest of a panel to ask the question.
 */
export interface MaintenanceInput {
  detail: PhaseDetail;
  /** Live editor buffers, path → content. A path absent here takes the server's copy. */
  files: Record<string, string>;
  submission: SubmissionView | null;
  enrollment: EnrollmentView | null;
}

export interface MaintenanceModel {
  /** The teacher's ticket; an older-format phase, which carries none, reads an empty one named by the phase. */
  ticket: ChangeTicket;
  /** The change's name in headings and readouts: the operation the record names, else the ticket id. Never a contract key. */
  changeName: string;
  /**
   * The change's signature: the first added amendment's path, else
   * the first impact operation, else none. The diff rows and the card's
   * Signature row read it.
   */
  signature: string | null;
  /**
   * The operation the record's impact names first (`impact.operations`), else
   * none. The Contract card's claim check and its Add read it: `design/contracts.json`
   * names an operation by its function name, never by a path or a ticket id.
   */
  operation: string | null;
  /** The first impact file the phase mounts editable, else none. */
  targetPath: string | null;
  /**
   * The files the learner edits in this phase. The Change impact graphs read it:
   * a function is drawn removed only where this review read its file (`readScope`).
   */
  editablePaths: string[];

  /** The change request record as it stands (the empty one while it is blank or unreadable), and why it could not be read. */
  recordText: string;
  record: ChangeRequest;
  recordError: string | null;

  /** `design/contracts.json` as it stands, and why it could not be read. */
  contractsText: string;
  contractsError: string | null;
  doc: ContractsDoc;
  v1: ContractOperation[];
  change: ContractOperation | null;
  changeIndex: number;
  contractWritten: boolean;
  diff: DiffRow[];
  maintainer: string;

  /** The verdict's suites, and the change cases on their own. */
  suites: Suite[];
  changeSuite: Suite | null;
  regressionSuite: Suite | null;
  changeCases: TestCaseResult[];
  /** Each acceptance item, with what the change request's tests and the verdict say about it. */
  lines: ContractLine[];

  marks: { mark: ChangeMark; n: number }[];
  addedNames: string[];
  impactCount: number;
  /** The functions the change added or altered, short-named, in graph order. */
  touched: ImpactFunction[];
  mutation: MutationReport | null;

  release: ReleaseRecord;

  /** The three states the brief card reads out. */
  contractState: StatusState;
  regressionState: StatusState;
  /** 'pass' when the change request records a version and a named change line. */
  releaseState: StatusState;
  /** No verdict has landed for this phase yet. */
  awaitingVerdict: boolean;
  /** A submission is queued or running: its review, and the graph from it, are on the way. */
  reviewRunning: boolean;
  /** The verdict's static analysis, which says why a verdict carries no impact reading. */
  analysis: AnalyzerReport | null;
}

/** The file a path names in this workspace: the live buffer, else the server copy. */
function textOf(props: MaintenanceInput, path: string): string {
  const buffered = props.files[path];
  if (typeof buffered === 'string') return buffered;
  return props.detail.files.find((f) => f.path === path)?.content ?? '';
}

export function useMaintenance(props: MaintenanceInput): MaintenanceModel {
  const { detail, submission, enrollment } = props;

  const ticket = useMemo<ChangeTicket>(
    () => detail.change?.ticket ?? { id: 'Change request', title: detail.title, summary: '', acceptance: [] },
    [detail.change, detail.title],
  );
  const recordText = textOf(props, CHANGE_REQUEST_JSON);
  const read = useMemo(() => readChangeText(recordText, ticket.acceptance.map((a) => a.id)), [recordText, ticket]);
  const record = read.change;
  // A blank record is the empty one the forms start from; only a written one can be unreadable.
  const recordError = recordText.trim() ? read.error : null;
  const editablePaths = useMemo(() => detail.files.filter((f) => f.editable).map((f) => f.path), [detail.files]);
  const signature = changeSignature(record);
  const operation = changeOperation(record);
  const changeName = operation ?? ticket.id;
  const targetPath = changeTarget(record, editablePaths);

  const contractsText = textOf(props, CONTRACTS_JSON);
  const parsed = useMemo(() => parseContracts(contractsText), [contractsText]);
  const doc = parsed.ok ? parsed.doc : { operations: [] };
  const contractsError = parsed.ok ? null : parsed.error;
  // The claim check: the operation the record names, matched by name; nothing is claimed while it names none.
  const split = useMemo(() => splitContracts(doc, operation === null ? null : baseName(operation)), [doc, operation]);
  const contractWritten = split.change ? isWritten(split.change) : false;
  const diff = useMemo(() => diffRows(split, signature, ticket.id), [split, signature, ticket.id]);
  const maintainer = useMemo(
    () => maintainerNote(split.change, operation, { id: ticket.id, contract: ticket.acceptance.map((a) => a.line) }, detail.status === 'passed'),
    [split.change, operation, ticket, detail.status],
  );

  const report = submission?.report ?? null;
  const visiblePath = useMemo(
    () => detail.files.find((f) => !f.editable && /test/i.test(f.path))?.path ?? null,
    [detail.files],
  );
  const suites = useMemo(() => buildSuites(report, changeName, visiblePath), [report, changeName, visiblePath]);
  const changeSuite = suites.find((s) => s.id === 'change') ?? null;
  const regressionSuite = suites.find((s) => s.id === 'regression') ?? null;
  const changeCases = changeSuite?.cases ?? [];
  // Each acceptance item against what the record ties it to: a case only when
  // one entry covers that item alone and names the case; otherwise the run.
  const lines = useMemo(
    () => acceptanceLines(ticket.acceptance, record.tests, suites),
    [ticket, record.tests, suites],
  );

  const analyzed = useMemo(() => report?.staticAnalysis?.functions ?? [], [report]);
  // The counts and the touched list read the impact as far as this review read it, so a file it never read
  // again does not count as "14 removed" in the Change tab's chip.
  const scoped = useMemo(() => readScope(report?.impact, analyzed, editablePaths).impact, [report, analyzed, editablePaths]);
  const nodes = useMemo(() => impactNodes(scoped, analyzed), [scoped, analyzed]);
  const marks = useMemo(() => markCounts(nodes), [nodes]);
  const addedNames = useMemo(
    () => nodes.filter((n) => n.change === 'added').map((n) => n.name.split('.').pop() ?? n.name),
    [nodes],
  );

  const touched = useMemo(
    () =>
      nodes
        .filter((n) => n.change === 'added' || n.change === 'changed')
        .map((n) => ({ ...n, name: n.name.split('.').pop() ?? n.name })),
    [nodes],
  );

  // The Contract tab shows where the teacher's switch is on; an older-format phase has no switch and the room draws no
  // Contract tab, so its Release card never points at one.
  const contractTab = detail.change ? detail.change.contract : false;
  const release = useMemo(
    () =>
      buildRelease({
        projectTitle: projectName(enrollment?.projectTitle) || detail.projectSlug,
        ticket,
        change: split.change,
        signature: changeName,
        contractTab,
        report,
        impactRead: Boolean(report?.impact),
        marks,
        added: addedNames,
        record,
        enrollment,
        phaseOrder: detail.order,
      }),
    [enrollment, detail.projectSlug, detail.order, ticket, split.change, changeName, contractTab, report, marks, addedNames, record],
  );

  const contractState: StatusState = contractWritten ? 'pass' : split.change ? 'warn' : 'todo';
  const regressionState: StatusState = regressionSuite ? regressionSuite.state : 'todo';
  const releaseState: StatusState = releaseWritten(record) ? 'pass' : 'todo';

  return {
    ticket,
    changeName,
    signature,
    operation,
    targetPath,
    editablePaths,
    recordText,
    record,
    recordError,
    contractsText,
    contractsError,
    doc,
    v1: split.v1,
    change: split.change,
    changeIndex: split.changeIndex,
    contractWritten,
    diff,
    maintainer,
    suites,
    changeSuite,
    regressionSuite,
    changeCases,
    lines,
    marks,
    addedNames,
    impactCount: nodes.length,
    touched,
    mutation: report?.mutation ?? null,
    release,
    contractState,
    regressionState,
    releaseState,
    awaitingVerdict: !report,
    reviewRunning: submission?.status === 'queued' || submission?.status === 'running',
    analysis: report?.staticAnalysis ?? null,
  };
}

/** Kept next to the hook so both slots import the file names from one place. */
export { CHANGE_REQUEST_JSON, CONTRACTS_JSON };
export type { ContractOperation };
