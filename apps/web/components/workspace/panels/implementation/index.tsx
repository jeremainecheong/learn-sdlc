'use client';

/**
 * Implementation: the pull request. One PR per phase, one revision per
 * submission, a thread for every failing case and analyzer finding, the
 * conformance ledger against the design contract, and the call graph the
 * analyzer resolved. Everything comes off the props; the panel never fetches.
 */
import { useMemo, useState } from 'react';
import type { ContractClaim, FeedbackCheck } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Avatar, Chip, EmptyState, Notice, Section, StatusSquare, type Tone } from '@/components/ui';
import { phaseHue, type StatusState } from '@/lib/phase';
import type { PhasePanel, PhasePanelProps } from '../types';
import { CallGraph } from './CallGraph';
import {
  VERDICT_STATE,
  buildLedger,
  buildRevisions,
  buildThreads,
  claimSentence,
  count,
  dateOf,
  failingFrames,
  timeOf,
} from './pr';

/* ------------------------------ small pieces ----------------------------- */

const checkState = (s: FeedbackCheck['status']): StatusState =>
  s === 'passed' ? 'pass' : s === 'failed' ? 'fail' : s === 'warning' ? 'warn' : 'now';
const checkTone = (s: FeedbackCheck['status']): Tone =>
  s === 'passed' ? 'pass' : s === 'failed' ? 'fail' : s === 'warning' ? 'warn' : 'accent';
const checkWord = (s: FeedbackCheck['status']): string =>
  s === 'passed' ? 'Passed' : s === 'failed' ? 'Failed' : s === 'warning' ? 'Warning' : 'Note';

const VERDICT_WORD: Record<ContractClaim['verdict'], string> = {
  kept: 'Kept',
  broken: 'Broken',
  unclaimed: 'Unclaimed',
  contradicted: 'Contradicted',
};
const VERDICT_TONE: Record<ContractClaim['verdict'], Tone> = {
  kept: 'pass',
  broken: 'fail',
  unclaimed: 'neutral',
  contradicted: 'warn',
};

/** The column headings a list of rows is read under. */
function ListHead({ left, right }: { left: string; right: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b-1.5 border-edge2 px-4 pb-1.5">
      <span className="label-sm font-medium">{left}</span>
      <span className="label-sm font-medium">{right}</span>
    </div>
  );
}

/** One row, read as a sentence: state, what it is, what happened, the result. */
function Row({
  state,
  title,
  detail,
  right,
  pad = 'px-4 py-2.5',
}: {
  state: StatusState;
  title: React.ReactNode;
  detail?: React.ReactNode;
  right?: React.ReactNode;
  /** Tailwind cannot resolve two padding utilities on one element, so the row takes its padding whole. */
  pad?: string;
}) {
  return (
    <span className={`flex items-start gap-2.5 ${pad}`}>
      <span className="pt-[3px]">
        <StatusSquare state={state} size={11} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="wrap text-[13.5px] font-semibold text-ink">{title}</span>
        {detail && <span className="wrap text-[12.5px] leading-[1.4] text-ink2">{detail}</span>}
      </span>
      {right && <span className="shrink-0">{right}</span>}
    </span>
  );
}

const LI = 'border-t-1.5 border-edge first:border-t-0';

/* ---------------------------------- brief -------------------------------- */

function Brief({ detail, submissions, helpers }: PhasePanelProps) {
  const gate = detail.rubric.passThreshold;
  const revisions = useMemo(() => buildRevisions(submissions, gate), [submissions, gate]);
  const latest = revisions[revisions.length - 1] ?? null;
  const threads = useMemo(() => (latest ? buildThreads(latest, []) : []), [latest]);
  const merged = detail.status === 'passed';
  // Named by the phase's place in its own project, never its stored order.
  const pr = `PR-${detail.place}`;

  return (
    <div>
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl border-1.5 border-edge bg-raised"
          style={{ color: phaseHue(detail.key) }}
          aria-hidden
        >
          <Icon name={merged ? 'merge' : 'pr'} size={17} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="h3">{pr}</h2>
          <p className="purpose">
            The pull request for this phase. Each submission is a revision; a thread closes when a
            later revision passes it.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Chip tone={merged ? 'pass' : latest?.state === 'fail' ? 'fail' : 'neutral'}>
          {merged ? 'Pass · Completed' : (latest?.result ?? 'Not opened')}
        </Chip>
        <span className="label-sm">
          {count(revisions.length, 'revision')}, {count(threads.length, 'open thread')}
        </span>
      </div>
      <button
        type="button"
        onClick={() => {
          helpers.setTab('phase');
          helpers.setPane('panel');
        }}
        className="btn-secondary btn-sm mt-3"
      >
        <Icon name="pr" size={13} />
        Open the pull request
      </button>
    </div>
  );
}

/* ---------------------------------- tools -------------------------------- */

function Tools(props: PhasePanelProps) {
  const { detail, submissions, enrollment, helpers } = props;
  const gate = detail.rubric.passThreshold;
  const [chosen, setChosen] = useState<string | null>(null);

  const revisions = useMemo(() => buildRevisions(submissions, gate), [submissions, gate]);
  const newestFirst = useMemo(() => [...revisions].reverse(), [revisions]);
  const selected =
    revisions.find((r) => r.id === chosen) ?? revisions[revisions.length - 1] ?? null;
  const later = useMemo(
    () => (selected ? revisions.filter((r) => r.attempt > selected.attempt) : []),
    [revisions, selected],
  );
  const threads = useMemo(
    () => (selected ? buildThreads(selected, later) : []),
    [selected, later],
  );
  const open = threads.filter((t) => t.state === 'open').length;
  const report = selected?.report ?? null;
  const ledger = useMemo(() => buildLedger(report?.contract ?? []), [report]);
  const functions = report?.staticAnalysis?.functions ?? [];
  const failing = useMemo(() => failingFrames(report), [report]);

  const passing = revisions.filter((r) => r.state === 'pass').pop() ?? null;
  const release = enrollment?.releases?.find((r) => r.phaseKey === detail.key) ?? null;
  // Crossing the gate is not merging. The gate banner above this panel is
  // still asking for the merge message at that point, so reading `passed` as
  // "merged" put "Merged at 100" directly under "One step left: the merge
  // message". A merge is a release row, or the project having moved past this
  // phase: both are written by advance(), which is the merge.
  const advanced = Boolean(
    enrollment && (enrollment.completed || enrollment.currentPhaseOrder > detail.order),
  );
  const merged = Boolean(release) || advanced;
  const readyToMerge = !merged && detail.status === 'passed';
  // Named by the phase's place in its own project, never its stored order.
  const pr = `PR-${detail.place}`;

  if (revisions.length === 0) {
    return (
      <div className="px-4 py-4">
        <EmptyState
          icon="pr"
          title={`${pr} is not open yet`}
          body="Submitting opens it. Each submission becomes a revision here, with what ran, the threads it left open and the conformance ledger."
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={helpers.submitNow}
              disabled={helpers.busy}
            >
              <Icon name="pr" size={13} />
              Submit
            </button>
          }
          testId="phase-implementation-revisions"
        />
      </div>
    );
  }

  const first = revisions[0];
  const latest = revisions[revisions.length - 1];

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex items-start gap-2.5">
        <span
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl border-1.5 border-edge bg-raised"
          style={{ color: phaseHue(detail.key) }}
          aria-hidden
        >
          <Icon name={merged ? 'merge' : 'pr'} size={17} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="h3">{pr}</h3>
            <Chip tone={merged ? 'pass' : latest.state === 'fail' ? 'fail' : 'neutral'}>
              {merged ? 'Pass · Completed' : `In review, ${latest.result.toLowerCase()}`}
            </Chip>
          </div>
          <p className="purpose">
            Opened {timeOf(first.createdAt)}, {count(revisions.length, 'revision')},{' '}
            {count(open, 'open thread')}.
          </p>
        </div>
      </div>

      {!merged && (
        <Section
          testId="phase-implementation-merge"
          icon="merge"
          hue={detail.key}
          title="Merge"
          purpose={
            readyToMerge
              ? `Revision ${passing?.attempt ?? latest.attempt} passed. Continue when ready; a reflection is optional.`
              : 'Every required criterion needs evidence. This pull request is still in review.'
          }
          right={<Chip tone={readyToMerge ? 'pass' : 'outline'}>{readyToMerge ? 'Gate met' : 'Gate not met'}</Chip>}
        >
          <p className="purpose">
            {readyToMerge
              ? `Write what the review changed and merge from the banner at the top of the workspace. The message is kept as docs/pr/${pr}.md.`
              : `${latest.result} on revision ${latest.attempt}. Fix what the ${
                  open === 1 ? 'open thread asks' : 'open threads ask'
                } for and submit again.`}
          </p>
        </Section>
      )}

      {merged && (
        <Section
          testId="phase-implementation-merged"
          icon="merge"
          hue={detail.key}
          title="Merged"
          purpose={
            passing
              ? `Revision ${passing.attempt} passed all required criteria.`
              : 'This phase has a recorded Pass.'
          }
          right={release ? <Chip tone="pass">{release.version}</Chip> : undefined}
        >
          {detail.reflection ? (
            <div className="rounded-ctl border-1.5 border-edge2 bg-ground px-3 py-2.5">
              <p className="label-sm">Your merge message, kept as docs/pr/{pr}.md</p>
              <p className="mt-1 wrap text-[13px] leading-[1.5] text-ink">{detail.reflection}</p>
            </div>
          ) : (
            <p className="purpose">No merge message was recorded for this phase.</p>
          )}
          {release && (
            <p className="text-[13px] text-ink2">
              Release {release.version}, recorded {dateOf(release.createdAt)}.
            </p>
          )}
        </Section>
      )}

      <Section
        testId="phase-implementation-revisions"
        title="Revisions"
        purpose="Each submission is a revision of this pull request. Selecting one shows what ran and what it left open."
        pad={false}
      >
        <div>
          <ListHead left="Revision" right="Result" />
          <ol className="m-0 flex list-none flex-col p-0">
            {newestFirst.map((r) => {
              const active = r.id === selected?.id;
              return (
                <li key={r.id} className={LI}>
                  <button
                    type="button"
                    onClick={() => setChosen(r.id)}
                    aria-pressed={active}
                    data-testid={`phase-implementation-revision-${r.attempt}`}
                    className={`w-full text-left transition-colors hover:bg-raised ${
                      active ? 'bg-tint' : ''
                    }`}
                  >
                    <Row
                      state={r.state}
                      title={`Revision ${r.attempt}`}
                      detail={r.detail}
                      right={
                        <Chip
                          tone={r.state === 'pass' ? 'pass' : r.state === 'fail' ? 'fail' : 'neutral'}
                        >
                          {r.result}
                        </Chip>
                      }
                    />
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </Section>

      {selected && !report && (
        <Notice tone={selected.state === 'fail' ? 'fail' : 'info'}>
          {selected.state === 'fail'
            ? `Revision ${selected.attempt} did not produce a review. Submit again.`
            : `Revision ${selected.attempt} is still running in the sandbox.`}
        </Notice>
      )}

      {report && selected && report.checks.length > 0 && (
        <Section
          testId="phase-implementation-checks"
          title="Checks"
          purpose={`What ran on revision ${selected.attempt}, in the sandbox. All required checks need evidence.`}
          pad={false}
        >
          <div>
            <ListHead left="Check" right="Result" />
            <ul className="m-0 flex list-none flex-col p-0">
              {report.checks.map((c) => (
                <li key={c.id} className={LI}>
                  <Row
                    state={checkState(c.status)}
                    title={c.label}
                    detail={c.detail}
                    right={<Chip tone={checkTone(c.status)}>{checkWord(c.status)}</Chip>}
                  />
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}

      {report && (
        <Section
          testId="phase-implementation-threads"
          title="Threads"
          purpose="One thread for every failing case and every analyzer finding. Selecting a thread opens the file at that line."
          right={
            <Chip tone={open > 0 ? 'warn' : threads.length > 0 ? 'pass' : 'neutral'}>
              {open > 0 ? `${open} open` : threads.length > 0 ? 'All resolved' : 'No threads'}
            </Chip>
          }
          pad={false}
        >
          {threads.length === 0 ? (
            <p className="purpose px-4 pb-4">
              No thread on this revision. Nothing failed with a line in your files, and the analyzer
              reported nothing.
            </p>
          ) : (
            <ol className="m-0 flex list-none flex-col p-0">
              {threads.map((t, i) => (
                <li key={t.key} className={LI}>
                  <button
                    type="button"
                    onClick={() => helpers.openFile(t.path)}
                    title={`Open ${t.path} at line ${t.line}`}
                    data-testid={`phase-implementation-thread-${i + 1}`}
                    className="flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-raised"
                  >
                    <Avatar initials="SE" phaseKey="implementation" size={26} className="mt-0.5" />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[13px] font-semibold text-ink">Senior engineer</span>
                        <span className="label-sm wrap">
                          on {t.path} line {t.line}
                        </span>
                      </span>
                      <span className="wrap text-[13px] leading-[1.5] text-ink2">{t.message}</span>
                      {t.snippet && (
                        <span className="mono wrap rounded-sm bg-raised px-2 py-1 text-[11.5px] text-ink2">
                          {t.snippet}
                        </span>
                      )}
                      <span className="mono wrap text-[11.5px] text-muted">
                        {t.kind === 'test'
                          ? t.source
                          : `${t.source}, ${t.severity === 'error' ? 'error' : 'warning'}`}
                      </span>
                    </span>
                    <span className="shrink-0">
                      <Chip tone={t.state === 'open' ? 'warn' : 'pass'}>
                        {t.state === 'open' ? 'Open' : `Resolved in revision ${t.resolvedIn}`}
                      </Chip>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Section>
      )}

      {ledger.length > 0 && (
        <Section
          testId="phase-implementation-ledger"
          title="Conformance ledger"
          purpose="What your design contract claimed, and what the code did. Where the two disagree, decide which one to change and say so in the merge message."
          pad={false}
        >
          <div>
            <ListHead left="Claim" right="Verdict" />
            <ul className="m-0 flex list-none flex-col p-0">
              {ledger.map((g) => (
                <li key={g.name} className={LI} data-testid={`phase-implementation-ledger-row-${g.name}`}>
                  <div className="flex flex-wrap items-baseline gap-x-2 px-4 pb-0.5 pt-2.5">
                    <span className="mono text-[12.5px] font-semibold text-ink">{g.name}</span>
                    {g.story && <span className="label-sm">{g.story}</span>}
                  </div>
                  <ul className="m-0 flex list-none flex-col p-0 pb-1.5">
                    {g.claims.map((c, i) => (
                      <li key={`${c.claim}-${i}`}>
                        <Row
                          pad="py-1.5 pl-7 pr-4"
                          state={VERDICT_STATE[c.verdict]}
                          title={claimSentence(c)}
                          detail={c.evidence.length > 0 ? c.evidence.join(' ') : undefined}
                          right={<Chip tone={VERDICT_TONE[c.verdict]}>{VERDICT_WORD[c.verdict]}</Chip>}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}

      {functions.length > 0 && (
        <Section
          title="Call graph"
          purpose="Arrows point from a caller to what it calls. A red outline means a failing case's traceback landed in that function; selecting a box opens the file."
        >
          <CallGraph
            functions={functions}
            failing={failing}
            onOpen={(path) => helpers.openFile(path)}
            testId="phase-implementation-callgraph"
          />
        </Section>
      )}
    </div>
  );
}

const panel: PhasePanel = {
  Brief,
  Tools,
  toolsLabel: 'Revisions',
  toolsIcon: 'pr',
};

export default panel;
