'use client';

/**
 * Change impact: the call graph before the change and after it, side by side.
 *
 * The report names the functions the change added, so the earlier graph is the
 * later one with those taken out: nothing is stored twice and nothing is
 * filled in by hand. Both drawings share one bar scale, so a bar on the left
 * means what a bar on the right means.
 */
import { useMemo } from 'react';
import type { AnalyzerFunction, ImpactReport } from '@learnsdlc/shared';
import { buildImpactGraph, readScope, withoutAdded } from './impact';
import { GraphCanvas, GraphLegend, UnreadNote, maxReach, useMeasuredWidth } from './ImpactGraph';
import { GRAPH_FALLBACK_WIDTH, GRAPH_MIN_WIDTH } from '../graph-size';

/** Below this the two graphs stack, and each gets the whole column. */
const TWO_UP = 720;
const GAP = 16;

function Side({
  title,
  graph,
  badges,
  unreadPaths,
  reach,
  onOpen,
  testId,
}: {
  title: string;
  graph: ReturnType<typeof buildImpactGraph>;
  badges: boolean;
  unreadPaths?: ReadonlySet<string>;
  reach: number;
  onOpen: (path: string) => void;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11.5px] font-semibold text-ink">{title}</span>
      <div className="min-w-0 overflow-x-auto">
        <GraphCanvas graph={graph} badges={badges} unreadPaths={unreadPaths} reach={reach} onOpen={onOpen} title={title} testId={testId} />
      </div>
    </div>
  );
}

export function ChangeImpact({
  impact,
  functions,
  editablePaths,
  onOpen,
  testId,
}: {
  impact: ImpactReport | undefined;
  functions: AnalyzerFunction[];
  /**
   * The files the learner edits in this phase. The After graph marks a function
   * removed only where this review read its file; the earlier reading's other
   * files are left out of it and named under it (`readScope`). The
   * Before graph is the earlier code and keeps them, their boxes named without
   * a mark's word.
   */
  editablePaths?: string[];
  onOpen: (path: string) => void;
  testId?: string;
}) {
  const [wrapRef, measured] = useMeasuredWidth();
  const twoUp = measured >= TWO_UP;
  const colW = Math.max(GRAPH_MIN_WIDTH, twoUp ? Math.floor((measured - GAP) / 2) : measured || GRAPH_FALLBACK_WIDTH);

  const before = useMemo(() => withoutAdded(impact, functions), [impact, functions]);
  const beforeGraph = useMemo(
    () => buildImpactGraph(before.impact, before.analyzed, colW),
    [before, colW],
  );
  const scope = useMemo(() => readScope(impact, functions, editablePaths), [impact, functions, editablePaths]);
  const afterGraph = useMemo(() => buildImpactGraph(scope.impact, functions, colW), [scope, functions, colW]);
  // The Before graph draws the unread files' functions as the earlier code: their boxes say nothing of removal.
  const unreadPaths = useMemo(() => new Set(scope.unread.map((u) => u.path)), [scope]);
  const reach = Math.max(maxReach(beforeGraph), maxReach(afterGraph));

  return (
    <div className="flex min-w-0 flex-col gap-3" ref={wrapRef} data-testid={testId}>
      <div className={`grid min-w-0 gap-4 ${twoUp ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <Side title="Before" graph={beforeGraph} badges={false} unreadPaths={unreadPaths} reach={reach} onOpen={onOpen} />
        <Side
          title="After"
          graph={afterGraph}
          badges
          reach={reach}
          onOpen={onOpen}
          testId="phase-maintenance-impact-after"
        />
      </div>
      <UnreadNote unread={scope.unread} />
      <GraphLegend />
    </div>
  );
}
