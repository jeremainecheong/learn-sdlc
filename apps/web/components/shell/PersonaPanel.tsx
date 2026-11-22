'use client';

/**
 * The person who reviews this phase, and the thread you have with them.
 *
 * Each phase has one reviewer (the product owner reads your story, the
 * architect reads your decisions, the senior engineer reads your pull request)
 * and this column is where you talk to them. It is the workspace's mentor
 * thread, drawn as a person rather than a chat widget, so
 * the rule it works under is visible: hints are counted, and the reviewer
 * says out loud when it is refusing to do your work for you.
 *
 * Three parts, deliberately: the thread ({@link usePersona}), the feed that
 * draws it and the composer you type in. What the learner is typing belongs to
 * the composer and stays there (holding it in the hook would make every
 * character re-render the whole IDE around it), and the feed is memoised on the
 * thread, so a commit somewhere else in the workspace does not re-parse the
 * markdown of every reply.
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
// The markdown engine is fetched by the first page that draws a reply: the shell's barrel is reached from every
// signed-in page, and most of them draw no markdown. DeferredMarkdown shows the received text at once, then the
// formatted text when the parser arrives.
import { DeferredMarkdown as Markdown } from '@/components/DeferredMarkdown';
import type { AssistantMessageView, ExplainSource, PhaseKey } from '@learnsdlc/shared';
import { AI_BUSY_CODE, PHASE_TITLES, explainQuestionFor, pluralWord } from '@learnsdlc/shared';
import { capitalise } from '@/lib/capitalise';
import { api, ApiError, describeError } from '@/lib/api';
import { mentorApi } from '@/lib/api-mentor';
import { cachedRecords, loadRecords } from '@/lib/records';
import { onSessionEnd, ownedByToken } from '@/lib/session';
import { useViewAs, viewAsMentorSentence } from '@/lib/view-as';
import { useProjectMaybe } from '@/lib/useProject';
import { Icon } from '@/components/Icon';
import { WaitStage } from '@/components/WaitStage';
import { ChatSurface } from '@/components/chat/ChatSurface';
import { PHASE_EXPERIENCE, ownMentorPurpose } from '@/components/phases/experience';
import { useOwnRoomGuidance, usePhaseOwnIntro } from '@/lib/scenario';
import { MentorPortrait } from '@/components/phases/PhaseArtwork';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { keepMode, keepProposalOpen, openingMode, subscribeMentorMode } from '@/components/workspace/mentor/mentorMode';
import { Button, useEdgeFade } from '@/components/ui';
import { PERSONA_NAME, PHASE_REVIEWER } from '@/lib/phase';
// Three parts of this column, each in its own file, so this file's memoised
// render stays cheap.
import { MemoryLine } from '@/components/workspace/mentor/MemoryLine';
import { StuckFlag } from '@/components/workspace/mentor/StuckFlag';
// What a question costs, and what happened to the reply. Both live in their
// own files for the reason MemoryLine does: this column is memoised in three
// places and keeping its render cheap matters.
import { MetaBadges } from '@/components/workspace/mentor/MetaBadges';
import { questionOrdinals, questionsAsked } from '@/lib/hints';
import { useScrollFocusRef } from '@/lib/scroll-focus';

export { PERSONA_NAME };

/**
 * The conversation, per phase, for as long as the session lasts.
 *
 * A thread is the same thread whether you are looking at it or not: leaving
 * the workspace for the sidebar and coming back must not empty the column and
 * refetch it, or the reviewer's answers blink away and return. They are
 * held here instead: read synchronously when the column mounts, written
 * whenever a turn is added, and dropped the moment the session ends, because
 * they belong to one learner.
 */
const THREADS = new Map<string, AssistantMessageView[]>();

/**
 * The threads belong to the learner whose token they were fetched with.
 * Signing out empties them there and then; `ownThreads` catches the change
 * either way (a second learner signing in over the top of the first ends no
 * session and so fires no hook), and is called before every read and write.
 */
const dropThreads = () => THREADS.clear();
const ownThreads = ownedByToken(dropThreads);
onSessionEnd(dropThreads);

/** What this phase's thread already holds: this session's copy, or the record cache's. */
function heldThread(phaseStateId: string | undefined, lesson = false): AssistantMessageView[] | undefined {
  if (!phaseStateId) return undefined;
  ownThreads();
  const mine = THREADS.get(lesson ? `lesson:${phaseStateId}` : phaseStateId);
  if (mine || lesson) return mine;
  const records = cachedRecords([phaseStateId])[phaseStateId];
  return records?.chat;
}

/**
 * The tests this thread has already been asked about, mapped to the id of the
 * turn that asked.
 *
 * Read off the learner's own turns rather than out of a column: the question
 * the product types on their behalf is a fixed sentence, and that sentence is
 * the record. A second copy of the fact would only be something to keep in
 * step. The anchor and the escaped `?` are what keep a question somebody typed
 * themselves ("why does test_x fail? I have tried two things") from counting.
 */
export function explainedTests(messages: AssistantMessageView[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const hit = /^Why does (.+) fail\?$/.exec(m.content.trim());
    if (hit && !found.has(hit[1])) found.set(hit[1], m.id);
  }
  return found;
}

export interface PersonaThread {
  /** Lessons teach in Guided mode and cannot edit project work. */
  lesson?: boolean;
  guidedOnly?: boolean;
  phaseKey: PhaseKey;
  phaseStateId?: string;
  reviewer: (typeof PHASE_REVIEWER)[PhaseKey];
  name: string;
  /** "Ask the senior engineer", the label on the composer and its textarea. */
  ask: string;
  messages: AssistantMessageView[];
  /**
   * Which question each message belongs to, keyed by message id.
   * The counter moves on the learner's turn and the reply beneath it inherits
   * the same number, so one exchange reads as one question wherever it is drawn.
   */
  ordinals: Map<string, number>;
  /** Questions asked here, counted the way `hintsForPhase` counts them. */
  asked: number;
  busy: boolean;
  usage: { todayTokens: number } | null;
  /**
   * Ask the reviewer. Resolves with null when the question went, and with the
   * sentence to show the learner when it did not; the composer keeps what they
   * typed either way, so nothing is lost to a failure.
   */
  send: (message: string) => Promise<string | null>;
  /**
   * Ask the reviewer why a test fails. Same contract as `send`:
   * null when the turn went, the sentence to show when it did not. The question
   * is the API's, so the optimistic bubble uses `explainQuestionFor` and the
   * server's own `question` is what the thread keeps.
   */
  explain: (subject: {
    testName: string;
    source: ExplainSource;
    sourceId?: string;
    step?: string;
  }) => Promise<string | null>;
  /**
   * The last turn that did not go, said once above the composer. It is held
   * here rather than in the composer's own state because the explain buttons
   * live all over the workspace and the pull request, and a failure raised by
   * one of them belongs in the same place a failed question does.
   */
  failure: string | null;
  clearFailure: () => void;
  /**
   * The scrolling element of the feed. The feed itself keeps it at the newest
   * turn ({@link PersonaFeed}); the thread only holds the ref so a caller that
   * draws the feed somewhere else can still find the scroller.
   */
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * The thread itself, held apart from the column that draws it.
 *
 * The IDE needs the feed and the composer in two different places (the feed
 * inside the reviewer's tab, the composer pinned to the foot of the column on
 * every tab) and they are one conversation, so the
 * state has to sit above both. What is being typed does not: that is the
 * composer's own, so that a keystroke is the composer's business alone.
 */
export function usePersona({
  phaseKey,
  phaseStateId,
  lesson = false,
}: {
  phaseKey: PhaseKey;
  lesson?: boolean;
  /** The phase state the thread belongs to. Without one the column is read-only. */
  phaseStateId?: string;
}): PersonaThread {
  const project = useProjectMaybe();
  const analytics = project?.analytics ?? null;
  // The project the shell is drawn around, for the one read below that falls
  // back to the API. `GET /analytics/me` with no project answers the learner's
  // OLDEST enrolment, and for a learner whose class works on another project
  // that is the one set aside for it.
  const projectSlug = project?.slug || undefined;
  // The thread this phase already has, read before the first paint: coming back
  // to a phase shows the conversation as it was left, not an empty column.
  const [messages, setMessages] = useState<AssistantMessageView[]>(
    () => heldThread(phaseStateId, lesson) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<{ todayTokens: number } | null>(null);
  // The sentence above the composer, wherever the turn was asked from.
  const [failure, setFailure] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const reviewer = PHASE_REVIEWER[phaseKey];
  const name = PHASE_EXPERIENCE[phaseKey].name;
  const ask = `Ask ${name}`;

  /**
   * The keys this phase's revisions are read under, as one stable value.
   *
   * The read below is the only one this column makes, and it must not capture
   * the task list on its first run alone: a column mounted before the provider
   * had answered would ask the phase-wide route (the one the API refuses on a
   * split phase) and never ask again for the life of the mount. The string
   * rather than the array, because a phase refreshed behind the column hands
   * over a fresh array of the same tasks and that must not re-fetch.
   */
  const tasks = phaseStateId ? project?.details?.[phaseStateId]?.tasks : undefined;
  const taskScope = (tasks ?? []).map((row) => row.key).join(',');

  // The phase can change under a column that is not remounted, so this both
  // adopts the incoming thread and fetches one only when there is none. The
  // record cache is shared with the workspace's own history, so the three
  // requests a phase costs are made once between them.
  useEffect(() => {
    if (!phaseStateId) return;
    const held = heldThread(phaseStateId, lesson);
    if (held) {
      setMessages(held);
      return;
    }
    let live = true;
    setMessages([]);
    const history = lesson
      ? mentorApi.lessonHistory(phaseStateId)
      : // The phase's task list, which the provider already holds, so the
        // revisions leg of this read asks each task's own route rather than
        // the phase route the API refuses on a split phase.
        loadRecords(phaseStateId, { tasks }).then(({ records }) => records.chat);
    history.then((rows) => {
      if (live) setMessages(rows);
    }).catch((err: unknown) => {
      if (live) setFailure(describeError(err, 'The conversation could not be loaded. Reopen the mentor to try again.'));
    });
    return () => {
      live = false;
    };
    // `taskScope` rather than `tasks`: the scope of the read is the task keys,
    // and the read is made again once the provider has said what they are.
  }, [phaseStateId, lesson, taskScope]);

  // Every turn, kept where the next mount can find it.
  useEffect(() => {
    if (!phaseStateId || messages.length === 0) return;
    ownThreads();
    THREADS.set(lesson ? `lesson:${phaseStateId}` : phaseStateId, messages);
  }, [phaseStateId, lesson, messages]);

  // Usage is a diagnostic count. Replies refresh the known total; it never
  // limits access to the mentor. Unknown usage stays absent.
  useEffect(() => {
    if (analytics) {
      setUsage((u) => u ?? { todayTokens: analytics.tokensToday });
      return;
    }
    let live = true;
    api
      .analyticsMe(projectSlug)
      .then((a) => {
        if (live) setUsage((u) => u ?? { todayTokens: a.tokensToday });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [analytics, projectSlug]);

  // The ordinal moves on the learner's question, not on the reviewer's answer,
  // because that is what the score counts: `hintsForPhase` is
  // `count({ phaseStateId, role: 'user' })`. The two agree only because one
  // question writes one reply; they are a different rule.
  const ordinals = useMemo(() => questionOrdinals(messages), [messages]);
  const asked = useMemo(() => questionsAsked(messages), [messages]);

  const send = useCallback(
    async (text: string): Promise<string | null> => {
      const message = text.trim();
      if (!message || busy || !phaseStateId) return null;
      setBusy(true);
      setFailure(null);
      const local = `local-${Date.now()}`;
      setMessages((m) => [
        ...m,
        { id: local, role: 'user', content: message, createdAt: new Date().toISOString() },
      ]);
      try {
        const res = await (lesson ? mentorApi.lessonChat(phaseStateId, message) : api.chat(phaseStateId, message));
        setMessages((m) => [...m, res.reply]);
        setUsage(res.usage);
        return null;
      } catch (err) {
        // No accepted reply arrived. The provider may have received the
        // question, so do not claim otherwise or turn the failure into a hint.
        // Remove only this optimistic bubble and return the draft for retry.
        setMessages((m) => m.filter((x) => x.id !== local));
        const sentence = askFailureSentence(name, err, true);
        setFailure(sentence);
        return sentence;
      } finally {
        setBusy(false);
      }
    },
    [busy, phaseStateId, name, lesson],
  );

  /**
   * "Explain this failure". `send` with the question written for
   * the learner: the same optimistic bubble, the same rollback, and one extra
   * sentence for the one failure that is not a failure of the connection: the
   * result the button was drawn from has been replaced by a newer one.
   */
  const explain = useCallback(
    async (subject: {
      testName: string;
      source: ExplainSource;
      sourceId?: string;
      step?: string;
    }): Promise<string | null> => {
      if (lesson) return 'Project test explanations are available in the project workspace.';
      if (busy || !phaseStateId) return null;
      setBusy(true);
      setFailure(null);
      const local = `local-${Date.now()}`;
      setMessages((m) => [
        ...m,
        {
          id: local,
          role: 'user',
          content: explainQuestionFor(subject.testName),
          createdAt: new Date().toISOString(),
        },
      ]);
      try {
        const res = await mentorApi.explainTest(phaseStateId, subject);
        // The server's own words replace the guess, so the transcript and the
        // history agree to the character.
        setMessages((m) => [
          ...m.map((x) => (x.id === local ? { ...x, content: res.question } : x)),
          res.reply,
        ]);
        setUsage(res.usage);
        return null;
      } catch (err) {
        setMessages((m) => m.filter((x) => x.id !== local));
        const sentence =
          err instanceof ApiError && err.status === 404
            ? 'That test is not in this result any more. Run again and ask about the new result.'
            : askFailureSentence(name, err, false);
        setFailure(sentence);
        return sentence;
      } finally {
        setBusy(false);
      }
    },
    [busy, phaseStateId, name, lesson],
  );

  const clearFailure = useCallback(() => setFailure(null), []);

  // One object per change rather than one per render: the feed and the composer
  // are memoised on it, so a fresh literal here would make both memos useless.
  return useMemo(
    () => ({
      lesson,
      phaseKey,
      phaseStateId,
      reviewer,
      name,
      ask,
      messages,
      ordinals,
      asked,
      busy,
      usage,
      send,
      explain,
      failure,
      clearFailure,
      scrollRef,
    }),
    [
      lesson,
      phaseKey,
      phaseStateId,
      reviewer,
      name,
      ask,
      messages,
      ordinals,
      asked,
      busy,
      usage,
      send,
      explain,
      failure,
      clearFailure,
    ],
  );
}

/**
 * A failed or withheld response is not evidence that the question never
 * reached the provider. Name the mentor visible in this thread, retain the
 * diagnostic reference, and keep server internals out of the learner's copy.
 */
export function askFailureSentence(mentorName: string, err: unknown, questionRetained: boolean): string {
  const opening = `${mentorName} could not answer right now.`;
  const next = questionRetained ? 'Your question is kept for retry. Try again.' : 'Try again.';
  if (err instanceof ApiError && err.status === 0) {
    return `${mentorName} has not answered yet.${questionRetained ? ' Your question is kept for retry.' : ''} Wait a moment before trying again.`;
  }
  if (err instanceof ApiError && err.status >= 500) {
    const reference = err.requestId ? ` The reference is ${err.requestId}.` : '';
    const body = err.body;
    if (body && typeof body === 'object' && 'code' in body && body.code === 'GUIDED_REPLY_WITHHELD') {
      return `${mentorName} could not provide a Guided hint this time. ${next}${reference}`;
    }
    // The AI's queue turned the question away because the class was using every slot.
    if (body && typeof body === 'object' && 'code' in body && body.code === AI_BUSY_CODE) {
      return `${mentorName} is busy with the rest of the class, so this question was not answered. ${questionRetained ? 'Your question is kept for retry. ' : ''}Try again in a minute.${reference}`;
    }
    return `${opening} The server had a problem.${reference} ${next}`;
  }
  const said = describeError(err, 'the request did not go through');
  const trimmed = said.trim();
  const reason = `${capitalise(trimmed)}${
    /[.!?]$/.test(trimmed) ? '' : '.'
  }`;
  // A message that already says what to do does not need ours after it.
  return /try again/i.test(reason) ? `${opening} ${reason}` : `${opening} ${reason} ${next}`;
}

/** The reviewer's face and role, at the top of a column that is only theirs. */
export const PersonaHeader = memo(function PersonaHeader({ thread, busy = thread.busy }: { thread: PersonaThread; busy?: boolean }) {
  const mentor = PHASE_EXPERIENCE[thread.phaseKey];
  return <div className="phase-mentor-identity" style={{ '--phase-accent': mentor.colour } as React.CSSProperties}>
    <MentorPortrait phaseKey={thread.phaseKey} speaking={busy} />
    <div><h2>{mentor.name}</h2><span className="mentor-presence" data-active={busy}><span className="mentor-waves" aria-hidden="true"><i/><i/><i/></span>{busy ? 'Thinking with you…' : `${PHASE_TITLES[thread.phaseKey]} mentor`}</span></div>
  </div>;
});

export function MentorSession({ thread, interviewHref, interviewStarted = false, header = true, guidedOnly = false, onClose }: { thread: PersonaThread; interviewHref?: string; interviewStarted?: boolean; header?: boolean; guidedOnly?: boolean; onClose?: () => void }) {
  const phaseId = thread.phaseStateId;
  /*
   * The mode this mentor opens in is the phase's kept one
   * (`mentorMode.ts`): the mode last pressed on any page of the phase in this
   * tab's session, or Agentic where an open proposal is known, or Guided. The
   * server's snapshot is Guided; these columns
   * are drawn only once the client holds the phase (the session and the
   * project are read in the browser), so the first paint already reads the
   * kept mode. Once the learner presses a mode on this mount, that press
   * holds here (`chosen`), so a proposal applied or set aside under Agentic
   * never flips this column back to Guided mid-task.
   */
  const opening = useSyncExternalStore(subscribeMentorMode, () => openingMode(phaseId), () => 'guided' as const);
  const [chosen, setChosen] = useState<{ phaseId?: string; mode: 'guided' | 'agentic' } | null>(null);
  const mode = chosen && chosen.phaseId === phaseId ? chosen.mode : opening;
  const modeNow = useRef(mode);
  modeNow.current = mode;
  const setMode = (next: 'guided' | 'agentic') => { setChosen({ phaseId, mode: next }); keepMode(phaseId, next); };
  const [agenticVisited, setAgenticVisited] = useState(false);
  // What the Agentic panel's loaded conversation says, kept for the phase's next mentor. The column holds the mode it
  // shows now, so the report never changes this one.
  const onProposalOpen = useCallback((open: boolean) => {
    setChosen(current => current && current.phaseId === phaseId ? current : { phaseId, mode: modeNow.current });
    keepProposalOpen(phaseId, open);
  }, [phaseId]);
  const [agenticActivity, setAgenticActivity] = useState({ phaseId, busy: false });
  const onAgenticBusyChange = useCallback((busy: boolean) => {
    setAgenticActivity(current => current.phaseId === phaseId && current.busy === busy ? current : { phaseId, busy });
  }, [phaseId]);
  const agenticBusy = !thread.lesson && !guidedOnly && agenticActivity.phaseId === phaseId && agenticActivity.busy;
  const mentor = PHASE_EXPERIENCE[thread.phaseKey];
  // In a room that is not the reference project's the mentor's purpose is the
  // phase's own intro; a lesson teaches the reference project and
  // keeps the standing line.
  const ownRoom = useOwnRoomGuidance(thread.phaseKey);
  const ownIntro = usePhaseOwnIntro(thread.phaseKey);
  const purpose = ownRoom && !thread.lesson ? ownMentorPurpose(ownIntro) : mentor.purpose;
  const guided = thread.lesson || guidedOnly || mode === 'guided';
  return <ChatSurface name={mentor.name} className="mentor-session" onClose={onClose} identity={header ? <PersonaHeader thread={thread} busy={thread.busy || agenticBusy} /> : <strong>{mentor.name}</strong>} details={<>
    <p>{purpose ? `${purpose} Guided conversations offer hints and questions.` : 'Guided conversations offer hints and questions.'}</p>
    <p>{thread.lesson ? 'This conversation is about the lesson. It does not change your project work.' : guidedOnly ? 'Open the project workspace to propose agentic changes.' : 'Agentic changes need clear intent, your explanation of the proposal, and explicit approval before Apply.'}</p>
    {interviewHref && !interviewStarted && <Button href={interviewHref} variant="secondary" size="sm" icon="requirements" testId="interview-open">Interview the customer</Button>}
    {thread.usage && <p>{thread.asked} {pluralWord(thread.asked, 'Guided hint')} in this phase. <span data-testid="mentor-token-usage">{thread.usage.todayTokens.toLocaleString()} tokens used today</span></p>}
  </>}>
    {thread.lesson || guidedOnly ? <p className="chat-mode-label">{thread.lesson ? 'Guided lesson conversation' : 'Guided review'}</p> : <div className="mentor-mode-switch" aria-label="Mentor mode"><button type="button" aria-label="Guided" aria-pressed={mode === 'guided'} onClick={() => { if (mode === 'agentic') setAgenticVisited(true); setMode('guided'); }}><Icon name="hint" size={15}/><strong>Guided</strong></button><button type="button" aria-label="Agentic" aria-pressed={mode === 'agentic'} onClick={() => { setAgenticVisited(true); setMode('agentic'); }}><Icon name="sparkles" size={15}/><strong>Agentic</strong></button></div>}
    <div className="chat-mode-body" hidden={!guided}><PersonaFeed thread={thread} describe={!header} /><PersonaComposer thread={thread} /></div>
    {!thread.lesson && !guidedOnly && (agenticVisited || mode === 'agentic') && <div className="chat-mode-body" hidden={guided}><AgenticPanel phaseId={phaseId} phaseKey={thread.phaseKey} onBusyChange={onAgenticBusyChange} onProposalOpen={onProposalOpen} /></div>}
  </ChatSurface>;
}

/**
 * What a question named, for the label over the learner's turn: a criterion, a
 * story, a test, a function or a file. Nothing is invented: a question that
 * names none of them gets no label.
 */
function topicOf(text: string): string | null {
  const m = text.match(
    /\b(?:AC-\d+(?:\.\d+)?|US-\d+(?:\.\d+)?|D\d+|[A-Za-z_][\w]*\.(?:py|md|json|yml|yaml)|test_[a-z0-9_]+|[a-z_][a-z0-9_]*\(\))/,
  );
  return m ? m[0] : null;
}

/** How far from the bottom a learner can be and still count as reading the newest turn. */
const NEAR_BOTTOM_PX = 120;

/**
 * Keep the feed at its newest turn.
 *
 * A single `scrollTo` in {@link usePersona}, run when the messages or the busy
 * flag change, is wrong in three ways at once:
 *
 * - the IDE draws the feed only on the reviewer's tab, so opening that tab
 *   mounts a fresh scroller at the top and nothing would scroll it, as the deps
 *   have not changed;
 * - "Explain this failure" switches to that tab and adds the question in the
 *   same render, so the one scroll would run against a feed whose replies are
 *   still waiting on the markdown engine (a dynamic import) and measure a
 *   height that is about to double;
 * - a reply that lands grows by its own markdown, its badges and its memory
 *   line after the effect has measured it, so the scroll would stop a
 *   paragraph short.
 *
 * So the feed owns it, the way the interview room pins its transcript: pin on
 * mount and on every new turn,
 * then keep pinning while the content grows, watched by a `ResizeObserver` on
 * the scroller and each of its children. It stands down the moment the learner
 * has scrolled up to read an older reply, and stands back up when the next turn
 * arrives (a new question, an explain, or the reply to one) or when they
 * scroll back to the bottom themselves.
 */
function usePinnedToNewest(ref: React.RefObject<HTMLElement | null>, deps: unknown[]): void {
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pin = () => {
      el.scrollTop = el.scrollHeight;
    };
    // A new turn, a fresh mount, the "is reading" line coming or going: each
    // is a reason to show the newest thing, whatever the learner was reading.
    pinned.current = true;
    pin();
    const frame = requestAnimationFrame(pin);
    // A scroll the learner made, or one `pin` made: the distance says which.
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (pinned.current) pin();
          });
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
    // The caller's own dependencies are spread in, so the effect runs again when they change.
  }, [ref, ...deps]);
}

/**
 * The thread so far: your questions, and the numbered hints back.
 *
 * Memoised on the thread. Every reply in here is markdown and markdown is
 * parsed during render, so without the memo a keystroke in the editor would
 * re-parse the whole conversation.
 */
export const PersonaFeed = memo(function PersonaFeed({
  thread,
  className = '',
  describe = true,
}: {
  thread: PersonaThread;
  className?: string;
  /**
   * Say what the reviewer does above the first question. True where this feed
   * stands on its own (the IDE's mentor tab and the design room draw no
   * header), and false wherever a header is already saying it ninety pixels
   * up, as on a learner's first visit to every document room.
   */
  describe?: boolean;
}) {
  const { reviewer, phaseKey, messages, ordinals, busy, scrollRef } = thread;
  // The thread is taller than its box in every room that has been used, and the
  // reply at the bottom edge would be sliced through a line by whatever sits
  // under it: in the design room, by the "Drawn from your contracts" card's
  // rule. The edge that has more behind it fades.
  const fade = useEdgeFade(scrollRef as React.RefObject<HTMLElement | null>, [messages.length, busy], 'y');
  usePinnedToNewest(scrollRef, [messages.length, busy]);
  // The thread scrolls; while it does, the keyboard can reach it.
  const threadRef = useScrollFocusRef(scrollRef);
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`} data-testid="mentor-chat">
        <div
          ref={threadRef}
          className={`flex-1 space-y-3 overflow-y-auto px-4 py-3.5 ${fade}`}
          role="log"
          aria-live="polite"
          aria-busy={busy}
        >
          {messages.length === 0 && (
            <div className="mentor-welcome"><p>What are you working through? Share what you tried and where you need a hint.</p></div>
          )}

          {messages.map((m) =>
            m.role === 'user' ? (
              <div
                key={m.id}
                id={`msg-${m.id}`}
                className="flex flex-col items-end gap-1"
                data-testid="msg-user"
              >
                {/* What the question was about, when it named something: the
                    design labels the turn "About AC-4" rather than leaving the
                    reply to say which criterion it answers. */}
                {topicOf(m.content) && (
                  <span className="label-sm font-medium text-ink2">About {topicOf(m.content)}</span>
                )}
                <div className="chat-message-copy max-w-[92%] whitespace-pre-wrap break-words rounded-panel rounded-br-sm bg-tint px-3 py-2 text-[13px] leading-relaxed text-ink">
                  {m.content}
                </div>
              </div>
            ) : m.meta?.redacted ? (
              // A withheld answer is not a message with a warning on it: it is
              // a different kind of thing, so it gets a different shape. It is
              // still a hint, and still counted, so it carries its ordinal.
              <div
                key={m.id}
                id={`msg-${m.id}`}
                className="flex flex-col gap-1"
                data-testid="msg-assistant"
              >
                {/* One label row for both shapes of reply, so a withheld
                    answer and an ordinary one cannot drift apart. It carries
                    the "because" sentence that says why an answer was
                    withheld. */}
                <MetaBadges meta={m.meta} phaseKey={phaseKey} ordinal={ordinals.get(m.id)} />
                <div className="rounded-panel border-1.5 border-dashed border-edge2 px-3 py-2.5">
                  <div className="chat-message-copy text-[13px] leading-relaxed text-ink2">
                    <Markdown>{m.content}</Markdown>
                  </div>
                </div>
              </div>
            ) : (
              <div
                key={m.id}
                id={`msg-${m.id}`}
                className="flex flex-col gap-1"
                data-testid="msg-assistant"
              >
                {/* The mentor said it remembers something, so the
                    column says so too, and says what, rather than leaving the
                    learner to notice a sentence they did not ask for. */}
                <MemoryLine content={m.content} />
                <MetaBadges meta={m.meta} phaseKey={phaseKey} ordinal={ordinals.get(m.id)} />
                <div className="chat-message-copy text-[13px] leading-relaxed text-ink2">
                  <Markdown>{m.content}</Markdown>
                </div>
              </div>
            ),
          )}

          {/* The same wait block the interview room draws: the lead sentence
              is unchanged and stays here in its own words, so the voice lint
              still reads it, and a long wait says a little more rather than
              leaving the line to sit there alone. */}
          {busy && <WaitStage kind="guided">The {reviewer.role} is reading…</WaitStage>}
        </div>
    </div>
  );
});

/**
 * Where you ask: the box under the guided feed of a mentor session.
 *
 * The draft lives here and nowhere else. Held in {@link usePersona}, one
 * component above the IDE, every character would re-render the editor, the
 * explorer, the panels and every parsed reply in the feed. Nothing above
 * this box needs to know what is in it until it is sent.
 */
export const PersonaComposer = memo(function PersonaComposer({
  thread,
  className = '',
}: {
  thread: PersonaThread;
  className?: string;
}) {
  const { phaseStateId, ask, busy } = thread;
  // A teacher viewing a learner's work cannot ask as them,
  // and the learner's mentor conversation is theirs alone. The box and its
  // button are closed and say so, rather than taking a question the request
  // layer and the API would both refuse.
  const viewing = useViewAs();
  const viewAsNoteId = useId();
  const [draft, setDraft] = useState('');
  const [unanswered, setUnanswered] = useState<string | null>(null);
  // The sentence lives on the thread, because a turn can be
  // asked from the run panel, the problems list or the pull request's checks
  // as well as from this box, and there is one place to say it went wrong.
  const failed = thread.failure;
  const send = async () => {
    const message = draft.trim();
    if (!message || busy || !phaseStateId || viewing) return;
    setDraft('');
    const failure = await thread.send(message);
    if (!failure) { setUnanswered(null); return; }
    setUnanswered(message);
    // Their words back, unless they have started typing something else in the
    // meantime: that is newer, and theirs too.
    setDraft((d) => d || message);
  };
  return (
        <div
          className={`shrink-0 border-t-1.5 border-edge px-4 py-3 ${className}`}
          data-testid="mentor-composer"
        >
          {/* Said once, above the box the words are back in, and never in
              the thread: an answer that never came is not a hint, and every
              assistant message in the thread is counted as one. */}
          {failed && (
            <p role="alert" data-testid="chat-error" className="mb-2 text-[12px] leading-relaxed text-fail">
              {failed}
            </p>
          )}
          {unanswered && draft.trim() !== unanswered && <details className="mb-2 text-[12px] leading-relaxed" data-testid="unanswered-question">
            <summary>Previous unanswered question</summary>
            <p className="my-2 whitespace-pre-wrap">{unanswered}</p>
            <button type="button" className="underline" disabled={busy || !phaseStateId} onClick={async () => {
              if (busy || !phaseStateId) return;
              const failure = await thread.send(unanswered);
              if (!failure) setUnanswered(null);
            }}>Retry this question</button>
          </details>}
          <div className="flex items-end gap-2">
            {/* Read-only rather than disabled before the phase opens, so
                the field keeps its place in the tab order and says what it is
                waiting for. */}
            <textarea
              aria-label={ask}
              className="field max-h-28 min-h-[36px] flex-1 resize-y py-[7px] text-[13px]"
              placeholder={phaseStateId ? 'Where are you stuck?' : 'The mentor opens with the phase'}
              value={draft}
              readOnly={!phaseStateId}
              disabled={Boolean(viewing)}
              aria-describedby={viewing ? viewAsNoteId : undefined}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              data-testid="chat-input"
            />
            <button
              onClick={() => void send()}
              disabled={busy || !draft.trim() || !phaseStateId || Boolean(viewing)}
              title={!phaseStateId ? 'The mentor opens when the phase does' : undefined}
              data-testid="chat-send"
              className="btn h-[36px] w-[36px] shrink-0 !px-0"
              aria-label="Send"
            >
              <Icon name="send" size={15} />
            </button>
          </div>
          {viewing && (
            <p id={viewAsNoteId} className="label-sm wrap mt-2" data-testid="mentor-view-as">
              {viewAsMentorSentence(viewing)}
            </p>
          )}
          {/* The door past a mentor that will not write the answer. */}
          <div className="chat-composer-tools"><span>Shift + Enter for a new line</span>{!thread.lesson && <StuckFlag phaseStateId={phaseStateId} />}</div>
        </div>
  );
});

/**
 * The column's markup, over a thread somebody else holds.
 *
 * Split out of {@link PersonaPanel} so the pull request can draw the reviewer
 * under its Conversation tab and put an explain button in its Checks tab and
 * have both land in one conversation. A hook cannot be called conditionally and
 * a second `usePersona` would be a second thread, so the page holds the thread
 * and hands it down.
 */
export function PersonaColumn({
  thread,
  guidedOnly = false,
  className = '',
  header = true,
  interviewHref,
  interviewStarted = false,
  onClose,
}: {
  thread: PersonaThread;
  guidedOnly?: boolean;
  className?: string;
  /** Draw the avatar header. A caller whose own heading already names the reviewer hides it. */
  header?: boolean;
  /** This phase's customer interview, when the pack ships one. */
  interviewHref?: string;
  interviewStarted?: boolean;
  onClose?: () => void;
}) {
  return (
    <aside
      className={`flex min-h-0 w-full shrink-0 flex-col border-edge bg-surface lg:w-[340px] lg:border-l-1.5 ${className}`}
      data-testid="persona-panel"
    >
      <MentorSession thread={thread} header={header} interviewHref={interviewHref} interviewStarted={interviewStarted} guidedOnly={guidedOnly} onClose={onClose} />
    </aside>
  );
}

/**
 * The whole column: the reviewer, the thread, and the place you ask. Every
 * document page uses this; the IDE takes the two halves apart instead.
 */
export function PersonaPanel({
  lesson = false,
  guidedOnly = false,
  phaseKey,
  phaseStateId,
  className = '',
  header = true,
  interviewHref,
  interviewStarted = false,
  onClose,
}: {
  lesson?: boolean;
  guidedOnly?: boolean;
  phaseKey: PhaseKey;
  phaseStateId?: string;
  className?: string;
  header?: boolean;
  interviewHref?: string;
  interviewStarted?: boolean;
  onClose?: () => void;
}) {
  const thread = usePersona({ phaseKey, phaseStateId, lesson });
  return (
    <PersonaColumn
      thread={thread}
      guidedOnly={guidedOnly}
      className={className}
      header={header}
      interviewHref={interviewHref}
      interviewStarted={interviewStarted}
      onClose={onClose}
    />
  );
}
