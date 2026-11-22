'use client';

import Link from 'next/link';
import { Button, EmptyState, Notice } from '@/components/ui';
import { ChatSurface } from '@/components/chat/ChatSurface';
import { Room } from '../interview/Room';
import { Composer } from '../interview/Composer';
import type { useInterview } from './useInterview';
import { useScenarioReference } from '@/lib/scenario';
import { REFERENCE_COPY } from '../reference/copy';

export function InterviewPanel({ interview, backlogHref }: { interview: ReturnType<typeof useInterview>; backlogHref: string }) {
  const { state, draft, setDraft, outgoing, retry, busy, error, absent, loading, scrollRef, send, reopen } = interview;
  // What to ask about is the reference story's only where the phase still is
  // the reference project's: the
  // scenario's roll-up, not the room task, since it speaks of the interview.
  const reference = useScenarioReference('requirements');
  return <ChatSurface name={state?.persona.name ?? 'Stakeholder'} className="requirements-conversation" testId="interview-page" headerTestId="interview-persona" identity={<>
    <img src="/artwork/requirements-maya-3d.webp" width={52} height={56} alt="" className="stakeholder-portrait" data-speaking={busy} />
    <div className="min-w-0"><p>{state?.persona.name ?? 'Your project stakeholder'}</p><small role="status">{busy ? 'Thinking about your question…' : state?.persona.role ?? 'Project stakeholder'}</small></div>
  </>} details={<>
    <p>{reference ? REFERENCE_COPY.requirements.interviewBrief : 'Ask what the stakeholder needs and why, collect examples, then turn the answers into your story and its acceptance criteria.'}</p>
    <Link className="requirements-next-step" href={backlogHref} scroll={false}>Continue to my backlog <span aria-hidden="true">→</span></Link>
  </>}>
    {error && <div className="px-5 pt-3"><Notice tone="fail" testId="interview-error">{error}</Notice></div>}
    {loading && !state ? <p className="label p-5">Opening the conversation…</p> : state ? <>
      <Room persona={state.persona} opening={state.opening} turns={state.turns} facts={state.facts} factsExpected={state.factsExpected} outgoing={outgoing} onRetry={id => void retry(id)} canRetry={state.turnsLeft > 0} busy={busy} scrollRef={scrollRef} />
      <Composer personaName={state.persona.name} draft={draft} setDraft={setDraft} onSend={() => void send()} busy={busy} turnsLeft={state.turnsLeft} />
    </> : <div className="p-5"><EmptyState icon="requirements" title={absent ? 'This project has no stakeholder interview' : 'The conversation did not open'} body={absent ? 'Read the supplied case file, then work on your backlog.' : 'Your work is safe. Try opening the conversation again.'} action={<div className="flex gap-2">{!absent && <Button size="sm" testId="room-retry" onClick={reopen}>Try again</Button>}<Button href={backlogHref} size="sm" variant="ghost">Open my backlog</Button></div>} testId={absent ? 'interview-absent' : 'interview-unavailable'} /></div>}
  </ChatSurface>;
}
