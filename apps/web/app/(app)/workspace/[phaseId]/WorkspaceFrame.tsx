/**
 * The workspace room's frame: what the room draws before its files have
 * arrived, and when they could not be loaded.
 */
import type { PhaseSummary } from '@learnsdlc/shared';
import { useSocketPaused } from '@/lib/socket';
import { Icon } from '@/components/Icon';
import { ActivityBar, StatusBar, WorkPage } from '@/components/shell';
import { PERSONA_NAME } from '@/lib/phase';
import { Button, Notice } from '@/components/ui';
import { PhaseHeader } from '@/components/workspace/PhaseHeader';

/* -------------------------------------------------------------------------- */
/* The frame: what the room is before its files have arrived.                  */
/* -------------------------------------------------------------------------- */

/** A block of nothing yet, in the shape of what is coming. */
function Block({ className = '' }: { className?: string }) {
  return <span className={`skeleton block ${className}`} aria-hidden />;
}

/**
 * The workspace before its detail lands, and the workspace that could not
 * load.
 *
 * A room is not built in front of the person walking into it. The furniture is
 * the same either way (the phase strip, the modes down the left, the explorer,
 * the code column, the reviewer's column, the status line) so it is drawn
 * first, with the phase named from what the shell already knows, and the
 * contents are put in when they arrive. The learner sees one page fill in
 * rather than a blank document, a spinner and then a page.
 */
export function WorkspaceFrame({
  phase,
  projectTitle,
  error,
  onRetry,
}: {
  phase?: PhaseSummary;
  projectTitle?: string;
  error?: string;
  /**
   * Load the phase again. A room that says what went
   * wrong and then offers only the way home is a dead end; this is the
   * control that is missing from that sentence.
   */
  onRetry?: () => void;
}) {
  const persona = phase ? (PERSONA_NAME[phase.key] ?? 'Mentor') : 'Mentor';
  const locked = /locked/i.test(error ?? '');
  // Live updates come over the socket; when it is away results still arrive by
  // polling, a little later, and the status bar says so rather than pretending
  // The grace keeps the first handshake from drawing the pip.
  const socketPaused = useSocketPaused();
  return (
    <WorkPage
      // The root of the trail is the learner's own project. Until the shell
      // knows which one that is, there is no root: naming the wrong project
      // for a frame or two is worse than a trail that starts at Work.
      crumbs={[
        ...(projectTitle
          ? [{ label: projectTitle, href: '/dashboard', testId: 'back-dashboard' }]
          : []),
        // No "Work" level; the phase is the trail's second step, as on every page of the phase.
        ...(phase ? [{ label: phase.title, href: `/phases?phase=${phase.key}` }] : []),
      ]}
      testId="workspace-page"
      /* The frame drawn while the phase loads, and the one a learner sees on
         a locked phase, carries the heading "Workspace" while no phase is
         known; once one is, the strip's title is the page's heading. */
      heading={phase ? undefined : 'Workspace'}
      strip={
        phase ? (
          <PhaseHeader phase={phase} place={null} state={null} />
        ) : (
          <div className="flex min-h-[48px] shrink-0 items-center gap-3 border-b-1.5 border-edge bg-surface px-4 py-1.5">
            <Block className="h-5 w-5 rounded-ctl" />
            <Block className="h-3 w-40" />
          </div>
        )
      }
    >
      {error && (
        <div className="shrink-0 border-b-1.5 border-edge bg-surface px-4 py-3">
          <Notice tone={locked ? 'info' : 'fail'} testId={locked ? 'workspace-notice' : 'workspace-error'}>
            <span className="flex flex-wrap items-center gap-2.5">
              <Icon name={locked ? 'lock' : 'warn'} size={14} className="shrink-0" />
              <span>
                {locked ? 'This phase is not open yet. ' : ''}
                {error}
              </span>
              {!locked && onRetry && (
                <Button size="sm" testId="room-retry" onClick={onRetry}>
                  Try again
                </Button>
              )}
              <Button href="/dashboard" variant="secondary" size="sm" testId="room-back">
                Back to home
              </Button>
            </span>
          </Notice>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ActivityBar
          className="hidden lg:flex"
          active="files"
          items={[
            { key: 'files', icon: 'code', label: 'Files' },
            { key: 'problems', icon: 'bug', label: 'Problems' },
            { key: 'mentor', icon: 'sparkles', label: `Ask the ${persona.toLowerCase()}` },
          ]}
        />
        <div
          className="hidden w-[232px] shrink-0 flex-col gap-2.5 border-r-1.5 border-edge bg-surface px-3 py-3 xl:flex"
          data-testid="explorer-frame"
        >
          <Block className="h-2.5 w-16" />
          {[0, 1, 2, 3, 4].map((i) => (
            <Block key={i} className="h-3 w-full" />
          ))}
        </div>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-code lg:min-w-[420px]">
          <div className="flex h-[38px] shrink-0 items-center gap-4 border-b-1.5 border-edge bg-surface px-3.5">
            <Block className="h-3 w-24" />
            <Block className="h-3 w-20" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-4 py-4" data-testid="editor-frame">
            {/* Grey blocks alone would be all the frame shows for as long as
                the fetch takes: twelve seconds on a slow connection. The
                room says what it is doing in its first commit, and the
                blocks are what is coming under it. */}
            {!error && (
              <p className="mb-1 text-[13px] text-ink2" data-testid="workspace-loading">
                Opening the workspace. Your files are on their way.
              </p>
            )}
            {['w-[52%]', 'w-[36%]', 'w-[44%]', 'w-[28%]', 'w-[48%]', 'w-[32%]', 'w-[40%]', 'w-[24%]'].map(
              (w, i) => (
                <Block key={i} className={`h-3 ${w}`} />
              ),
            )}
          </div>
          {/* The panel under the code takes its height already rather than pushing
              the editor up when the phase lands. */}
          <div className="flex h-[150px] shrink-0 flex-col border-t-1.5 border-edge bg-surface">
            <div className="flex shrink-0 items-center gap-4 border-b-1.5 border-edge px-3.5 py-[9px]">
              <Block className="h-2.5 w-14" />
              <Block className="h-2.5 w-10" />
              <Block className="h-2.5 w-16" />
            </div>
          </div>
        </section>

        <aside className="hidden min-h-0 shrink-0 flex-col border-l-1.5 border-edge bg-surface lg:flex lg:w-[320px] xl:w-[352px] 2xl:w-[372px]">
          <div className="flex shrink-0 border-b-1.5 border-edge">
            {['Brief', 'Map', persona].map((label) => (
              <span
                key={label}
                className="min-w-0 flex-1 truncate border-b-2 border-transparent px-2 py-2.5 text-center text-[12.5px] font-semibold text-muted"
              >
                {label}
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-3 px-4 py-4">
            <Block className="h-4 w-2/3" />
            <Block className="h-3 w-full" />
            <Block className="h-3 w-5/6" />
            <Block className="h-3 w-3/4" />
          </div>
        </aside>
      </div>

      {/* No problem count: the frame has not been told of any, and "0 problems"
          before the verdict is read would be a claim rather than a standing.
          No save state either: a room whose files
          have not arrived, or that could not load at all, has saved nothing. */}
      <StatusBar branch="main" live={!socketPaused} saveState="" />
    </WorkPage>
  );
}
