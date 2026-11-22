'use client';

/**
 * One file of the pack's answer, beside the learner's own.
 *
 * The same four columns the pull request draws (the old file's line numbers,
 * the new one's, the mark and the line) over the same pure `fileDiff`, so a
 * learner who has read one diff in this product can read this one. What is
 * different is the legend: on a pull request the base is the learner's previous
 * revision, and here it is the learner themselves, so the page says which side
 * is whose in words rather than leaving a plus and a minus to be guessed at.
 *
 * A plain grid of `<pre>`-shaped rows, not Monaco. Monaco draws only the rows
 * in the viewport and cannot print, and this is a page to be read end to end:
 * the same reason `dossier/CodeBlock.tsx` gives.
 */
import { pluralWord } from '@learnsdlc/shared';
import { diffLineMark, diffLineTone, type DiffLine } from '@/components/pr';
import { MAX_LINES } from '@/components/dossier/CodeBlock';
import { Chip, Panel } from '@/components/ui';
import type { SolutionFileRow } from './derive';

const COLUMNS = '44px 44px 18px 1fr';

function Line({ line }: { line: DiffLine }) {
  const tone = diffLineTone(line.kind);
  const mark = diffLineMark(line.kind);
  return (
    <div className={`grid min-h-[22px] items-center ${tone}`} style={{ gridTemplateColumns: COLUMNS }}>
      <span className="mono pr-2 text-right text-[11.5px] text-gutter">{line.oldNo ?? ''}</span>
      <span className="mono pr-2 text-right text-[11.5px] text-gutter">{line.newNo ?? ''}</span>
      <span className={`mono text-[12px] font-bold ${mark}`}>{line.kind === ' ' ? '' : line.kind}</span>
      <span className="mono whitespace-pre text-[12.5px] text-ink">{line.text}</span>
    </div>
  );
}

/**
 * A file listed whole, for the pack's answer when the learner's copy is gone.
 *
 * Not `dossier/CodeBlock.tsx`: that one carries the dossier's print classes and
 * prints the path in a header of its own, which this panel has already drawn.
 * The rule it states is the one followed here: a plain `<pre>`-shaped grid
 * with numbered lines, cut rather than silently truncated.
 */
function Listing({ text, testId }: { text: string; testId?: string }) {
  const all = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const lines = all.slice(0, MAX_LINES);
  return (
    <div className="overflow-x-auto bg-code py-1.5" data-testid={testId}>
      <div className="min-w-[560px]">
        {lines.map((text2, i) => (
          <div key={i} className="grid min-h-[22px] items-center" style={{ gridTemplateColumns: '44px 1fr' }}>
            <span className="mono pr-2 text-right text-[11.5px] text-gutter">{i + 1}</span>
            <span className="mono whitespace-pre text-[12.5px] text-ink">{text2}</span>
          </div>
        ))}
        {all.length > lines.length && (
          <p className="label-sm px-3 py-1.5">
            and {all.length - lines.length} more {pluralWord(all.length - lines.length, 'line')}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Two columns, yours then the pack's, paired row by row.
 *
 * A removal and the addition that follows it are the same change seen twice, so
 * they sit on one row; an unpaired line leaves the other side blank.
 */
function pairs(lines: DiffLine[]): { left: DiffLine | null; right: DiffLine | null }[] {
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.kind === ' ') {
      rows.push({ left: line, right: line });
    } else if (line.kind === '-') {
      const next = lines[i + 1];
      if (next && next.kind === '+') {
        rows.push({ left: line, right: next });
        i += 1;
      } else {
        rows.push({ left: line, right: null });
      }
    } else {
      rows.push({ left: null, right: line });
    }
  }
  return rows;
}

function SplitLine({ line, side }: { line: DiffLine | null; side: 'yours' | 'theirs' }) {
  const changed = line !== null && line.kind !== ' ';
  const tone = !changed ? '' : side === 'yours' ? 'bg-failtint' : 'bg-passtint';
  return (
    <div className={`grid min-h-[22px] items-center ${tone}`} style={{ gridTemplateColumns: '44px 1fr' }}>
      <span className="mono pr-2 text-right text-[11.5px] text-gutter">
        {line ? (side === 'yours' ? (line.oldNo ?? '') : (line.newNo ?? '')) : ''}
      </span>
      <span className="mono whitespace-pre text-[12.5px] text-ink">{line?.text ?? ''}</span>
    </div>
  );
}

export function SolutionDiff({ row, view }: { row: SolutionFileRow; view: 'unified' | 'split' }) {
  const chip =
    row.state === 'identical' ? (
      <Chip tone="pass">Same as yours</Chip>
    ) : row.state === 'not-kept' ? (
      <Chip tone="warn">Your file was not kept</Chip>
    ) : (
      <Chip tone="outline">
        {row.adds + row.dels} {pluralWord(row.adds + row.dels, 'line differs', 'lines differ')}
      </Chip>
    );

  return (
    <Panel as="section" className="flex flex-col overflow-hidden" testId={`solution-file-${row.path}`}>
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b-1.5 border-edge bg-raised px-3 py-2">
        <h2 className="mono text-[12.5px] font-semibold text-ink">{row.path}</h2>
        {row.state === 'differs' && (
          <>
            <span className="mono text-[11.5px] text-pass">+{row.adds}</span>
            <span className="mono text-[11.5px] text-fail">−{row.dels}</span>
          </>
        )}
        <span className="flex-1" aria-hidden />
        {chip}
      </header>

      {row.state === 'identical' && (
        <p className="label wrap px-3 py-3" data-testid={`solution-identical-${row.path}`}>
          You and the pack wrote this file the same way, line for line.
        </p>
      )}

      {row.state === 'not-kept' && (
        <>
          <p className="label wrap px-3 py-3" data-testid={`solution-notkept-${row.path}`}>
            The copy of your file from that revision has been cleared. The reference is below on its own.
          </p>
          <Listing text={row.theirs} />
        </>
      )}

      {row.state === 'differs' && row.diff && (
        <>
          {/* The legend, in words. A diff with no legend is a diff nobody can
              read, and this one's two sides are two people rather than two
              revisions. */}
          <div className="flex flex-col gap-0.5 border-b-1.5 border-edge px-3 py-2">
            <p className="label-sm wrap">Removed lines are yours.</p>
            <p className="label-sm wrap">Added lines are the pack&apos;s.</p>
          </div>
          <div className="overflow-x-auto bg-code py-1.5" data-testid={`solution-diff-${row.path}`}>
            {view === 'unified' ? (
              <div className="min-w-[560px]">
                {row.diff.hunks.map((hunk, hi) => (
                  <div key={hi}>
                    {hunk.skipped > 0 && (
                      <div
                        className="grid min-h-[22px] items-center border-y-1.5 border-edge bg-codeline"
                        style={{ gridTemplateColumns: COLUMNS }}
                      >
                        <span className="mono pr-2 text-right text-[11.5px] text-gutter">⋯</span>
                        <span className="mono pr-2 text-right text-[11.5px] text-gutter">⋯</span>
                        <span aria-hidden />
                        <span className="label-sm">
                          {hunk.skipped} unchanged {pluralWord(hunk.skipped, 'line')}
                        </span>
                      </div>
                    )}
                    {hunk.lines.map((line, li) => (
                      <Line key={`${hi}-${li}`} line={line} />
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid min-w-[900px]" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="border-r-1.5 border-edge">
                  <p className="label-sm px-3 py-1">Yours</p>
                  {row.diff.hunks.flatMap((hunk, hi) =>
                    pairs(hunk.lines).map((p, li) => (
                      <SplitLine key={`l-${hi}-${li}`} line={p.left} side="yours" />
                    )),
                  )}
                </div>
                <div>
                  <p className="label-sm px-3 py-1">The pack&apos;s</p>
                  {row.diff.hunks.flatMap((hunk, hi) =>
                    pairs(hunk.lines).map((p, li) => (
                      <SplitLine key={`r-${hi}-${li}`} line={p.right} side="theirs" />
                    )),
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
