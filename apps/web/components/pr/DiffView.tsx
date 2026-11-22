'use client';

/**
 * Files changed: the diff of a revision, with the reviewer's threads inline.
 *
 * Two gutters (the old file's line numbers and the new one's), then the mark
 * and the line: the shape a pull request has everywhere, so a learner reading
 * one here can read one at work. Runs of untouched lines are elided; a run
 * carrying a thread never is.
 */
import { Fragment, type ReactNode } from 'react';
import { pluralWord, type PhaseKey } from '@learnsdlc/shared';
import { Panel } from '@/components/ui';
import { scrollFocusRef } from '@/lib/scroll-focus';
import { diffLineMark, diffLineTone, type DiffLine, type FileDiff } from './diff';
import { Thread } from './Thread';
import { threadSummary, type PrThread } from './threads';
import './DiffView.css';

/**
 * One line. In a whole file (`whole`: the first submission, read against no
 * earlier one) every line is drawn plain, without the added tint and mark: it
 * is the file as handed in, not a change.
 */
function Line({ line, whole = false }: { line: DiffLine; whole?: boolean }) {
  const tone = whole ? '' : diffLineTone(line.kind);
  const mark = diffLineMark(line.kind);
  return (
    <tr className={tone} data-diff-kind={line.kind === '+' ? 'added' : line.kind === '-' ? 'removed' : 'context'}>
      <td data-diff-column="old" className="mono h-[22px] min-w-[44px] p-0 pr-2 text-right align-top text-[11.5px] leading-[22px] text-gutter">{line.oldNo ?? ''}</td>
      <td data-diff-column="new" className="mono h-[22px] min-w-[44px] p-0 pr-2 text-right align-top text-[11.5px] leading-[22px] text-gutter">{line.newNo ?? ''}</td>
      <td data-diff-column="mark" className={`mono h-[22px] min-w-[18px] p-0 align-top text-[12px] font-bold leading-[22px] ${mark}`}>
        {line.kind === ' ' || whole ? '' : line.kind}
      </td>
      <td data-diff-column="code" className="h-[22px] p-0 align-top">
        <span className="mono block whitespace-pre pr-3 text-[12.5px] leading-[22px] text-ink">{line.text}</span>
      </td>
    </tr>
  );
}

function ThreadRow({ children }: { children: ReactNode }) {
  return <tr data-diff-kind="thread"><td colSpan={4} className="p-0"><div className="pr-diff-thread">{children}</div></td></tr>;
}

export function DiffView({
  diff,
  threads,
  phaseKey,
  firstThreadIndex = 1,
  closedByMerge = false,
  onReply,
  whole = false,
}: {
  diff: FileDiff;
  /** The threads on this file, in line order. */
  threads: PrThread[];
  phaseKey: PhaseKey;
  /** Where this file's threads start in the page's numbering, for the test ids. */
  firstThreadIndex?: number;
  /** The phase is merged: the threads on it are closed, not waiting. */
  closedByMerge?: boolean;
  onReply?: (thread: PrThread, text: string) => Promise<string>;
  /**
   * The revision has no earlier submission to be read against (the first one): the file is drawn whole, its size in
   * lines rather than "+n −0", which would read as the size of the change.
   */
  whole?: boolean;
}) {
  const shown = new Set<string>();
  return (
    <Panel className="flex min-w-0 max-w-full flex-col overflow-hidden" testId={`pr-file-${diff.path}`}>
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b-1.5 border-edge bg-raised px-3 py-2">
        <span className="mono wrap min-w-0 text-[12.5px] font-semibold text-ink">{diff.path}</span>
        {whole ? (
          <span className="label-sm" data-testid="pr-file-whole">Whole file, {diff.lines} {pluralWord(diff.lines, 'line')}</span>
        ) : (
          <>
            <span className="mono text-[11.5px] text-pass">+{diff.adds}</span>
            <span className="mono text-[11.5px] text-fail">−{diff.dels}</span>
          </>
        )}
        <span className="flex-1" aria-hidden />
        <span className="label-sm">{threadSummary(threads, closedByMerge)}</span>
      </header>
      {/* A long line scrolls sideways (a design's JSON does at 390), so the
          scroller joins the tab order while it scrolls and is named after its file. */}
      <div
        ref={scrollFocusRef}
        role="region"
        aria-label={`Diff: ${diff.path}`}
        className="pr-diff-scroll min-w-0 max-w-full overflow-x-auto bg-code py-1.5"
        data-diff-scroll
      >
        {/* One table sizes all hunks from the longest code line. Each row's
            background therefore spans the same scroll width as its gutters
            and code; a long line cannot overflow an independently sized row. */}
        <table className="w-full min-w-[560px] border-collapse text-left" aria-label={whole ? `${diff.path} as submitted` : `Changes in ${diff.path}`}>
          <colgroup><col style={{ width: 44 }} /><col style={{ width: 44 }} /><col style={{ width: 18 }} /><col /></colgroup>
          <thead className="sr-only"><tr><th scope="col">Old line</th><th scope="col">New line</th><th scope="col">Change</th><th scope="col">Code</th></tr></thead>
          <tbody>
          {diff.hunks.map((hunk, hi) => (
            <Fragment key={hi}>
              {hunk.skipped > 0 && (
                <tr data-diff-kind="gap" className="border-y-1.5 border-edge bg-codeline">
                  <td data-diff-column="old" className="mono h-[22px] min-w-[44px] p-0 pr-2 text-right text-[11.5px] leading-[22px] text-gutter">⋯</td>
                  <td data-diff-column="new" className="mono h-[22px] min-w-[44px] p-0 pr-2 text-right text-[11.5px] leading-[22px] text-gutter">⋯</td>
                  <td data-diff-column="mark" className="min-w-[18px] p-0" aria-hidden />
                  <td data-diff-column="code" className="label-sm p-0 leading-[22px]">
                    {hunk.skipped} unchanged {pluralWord(hunk.skipped, 'line')}
                  </td>
                </tr>
              )}
              {hunk.lines.map((line, li) => {
                // A thread the previous revision left is anchored on the base's
                // gutter (the line it was written about, which this revision
                // changed), and an open one on the line as it stands now.
                const here = threads.filter((t) =>
                  t.side === 'old'
                    ? line.oldNo !== null && t.line === line.oldNo
                    : line.newNo !== null && t.line === line.newNo,
                );
                return (
                  <Fragment key={`${hi}-${li}`}>
                    <Line line={line} whole={whole} />
                    {here.map((t) => {
                      if (shown.has(t.key)) return null;
                      shown.add(t.key);
                      return (
                        <ThreadRow key={t.key}><Thread
                          thread={t}
                          phaseKey={phaseKey}
                          index={firstThreadIndex + threads.indexOf(t)}
                          closedByMerge={closedByMerge}
                          onReply={onReply}
                        /></ThreadRow>
                      );
                    })}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
          {/* A thread whose line the diff never draws still has to be read. */}
          {threads
            .filter((t) => !shown.has(t.key))
            .map((t) => (
              <ThreadRow key={t.key}><Thread
                thread={t}
                phaseKey={phaseKey}
                index={firstThreadIndex + threads.indexOf(t)}
                closedByMerge={closedByMerge}
                onReply={onReply}
              /></ThreadRow>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
