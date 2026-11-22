'use client';

import { sameSession } from '@/lib/session-token';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { ExecutionRunView, PhaseDetail } from '@learnsdlc/shared';
import { api, ApiError, describeError, getToken } from '@/lib/api';
import { getSession, onSessionEnd, useSession } from '@/lib/session';
import { useRecoverWhenBack } from '@/lib/poll';
import { DocPage } from '@/components/shell/DocPage';
import { phaseDoorHref } from '@/components/shell/routes';
import { Button } from '@/components/ui';
import { RunPanel } from '@/components/workspace/RunPanel';
import { RoomFallback } from '@/components/workspace/panels/RoomFallback';

export default function RecordedRunPage() {
  const { phaseId, runId } = useParams<{ phaseId: string; runId: string }>();
  const owner = useSession()?.id ?? '';
  return <RecordedRun key={`${owner}:${phaseId}:${runId}`} owner={owner} phaseId={phaseId} runId={runId} />;
}

/** An exact recorded run; fetching it never saves files or starts execution. */
function RecordedRun({ owner, phaseId, runId }: { owner: string; phaseId: string; runId: string }) {
  const [evidence, setEvidence] = useState<{ phase: PhaseDetail; run: ExecutionRunView } | null>(null);
  const [error, setError] = useState('');
  const [recoverable, setRecoverable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useRecoverWhenBack(Boolean(error) && recoverable, retry);
  useEffect(() => {
    let active = true;
    const token = getToken();
    const owns = () => active && Boolean(owner && token) && getSession()?.id === owner && sameSession(getToken(), token);
    const unsubscribe = onSessionEnd(() => {
      active = false; setEvidence(null); setRecoverable(false);
      setError('Your session changed. Reopen this run after signing in.');
    });
    setError(''); setRecoverable(false);
    async function load() {
      if (!owns()) return;
      const phase = await api.phase(phaseId);
      if (!owns()) return;
      if (phase.id !== phaseId || phase.status === 'locked') throw new ApiError(404, 'This phase is not available.');
      const run = await api.getRun(runId);
      if (!owns()) return;
      if (run.id !== runId || run.kind !== 'run' || run.phaseStateId !== phaseId) {
        throw new ApiError(404, 'This run is not available in this phase. Check the link or open its recorded activity.');
      }
      setEvidence({ phase, run });
    }
    void load().catch(cause => {
      if (!owns()) return;
      setEvidence(null);
      setRecoverable(!(cause instanceof ApiError && [400, 401, 403, 404].includes(cause.status)));
      setError(describeError(cause, 'This recorded run could not be loaded. Try again.'));
    });
    return () => { active = false; unsubscribe(); };
  }, [owner, phaseId, runId, attempt]);
  if (!evidence || error) return <RoomFallback room="recorded run" error={error} onRetry={retry} backHref="/journal" backLabel="Open activity" />;
  const { phase, run } = evidence;
  return <DocPage title={`${phase.title}: recorded run`} purpose="Recorded execution evidence. Your current workspace stays unchanged." active="journal" testId="recorded-run"
    crumbs={[{ label: 'Activity', href: '/journal' }, { label: phase.title, href: phaseDoorHref(phase) }, { label: 'Recorded run' }]}
    right={<Button variant="secondary" href={phaseDoorHref(phase)}>Open current workspace</Button>}>
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-ctl border border-edge bg-surface p-4">
      <div className="min-w-0 text-sm"><p className="break-all font-mono" data-testid="recorded-run-id">Run {run.id}</p><p className="mt-1 text-muted">Recorded <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>. Status: {run.status}.</p></div>
      <Button variant="ghost" onClick={retry}>Refresh evidence</Button>
    </div>
    <section className="min-w-0 rounded-ctl border border-edge bg-surface py-3" aria-label="Recorded run results">
      <RunPanel run={run} canRun readOnly busy={false} runLabel="Run" onRun={() => undefined} appearance={phase.key === 'testing' ? 'testing' : 'standard'} />
    </section>
  </DocPage>;
}
