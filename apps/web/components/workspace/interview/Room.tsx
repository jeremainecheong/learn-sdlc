'use client';

/**
 * The transcript: the customer's opening line, then one block per question.
 *
 * It is drawn as a conversation with a person rather than as a hint ladder,
 * because that is what it is: nothing here is numbered "hint 3 of 6" and
 * nothing is withheld. What each answer settled is said underneath it in the
 * product's own small label, so a learner can see the checklist move without
 * looking away from the answer that moved it.
 */
import { numberWord, plainTextOf, type InterviewFactView, type InterviewTurn } from '@learnsdlc/shared';
import { Chip, EmptyState } from '@/components/ui';
import { Markdown } from '@/components/Markdown';
import { PlainText } from '@/components/PlainText';
import { WaitStage } from '@/components/WaitStage';
import { useScrollFocusRef } from '@/lib/scroll-focus';
import type { OutgoingInterviewQuestion } from '../requirements/useInterview';

/** A count a person says out loud, for the one sentence that needs one. */
const word = (n: number) => numberWord(n, 10);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The empty room's count, from the pack's own two numbers: how many topics the
 * customer can settle (`total`, the topics the room is given) and how many are
 * enough to write the story (`expected`, the number the teacher saved). The two
 * differ on most packs (seven topics, five enough), so neither is said as the
 * other. Without a topic there is nothing to count; without the saved number
 * only the topics are counted.
 */
export function interviewCountSentence(total: number, expected?: number): string {
  if (total <= 0) return '';
  const can = `${capital(word(total))} ${total === 1 ? 'thing' : 'things'} can be settled`;
  if (expected === undefined || expected <= 0) return `${can}.`;
  if (expected >= total) return total === 1 ? `${can}, and it is needed to write your story.` : `${can}, and all ${word(total)} are needed to write your story.`;
  return `${can}; ${word(expected)} ${expected === 1 ? 'is' : 'are'} enough to write your story.`;
}

/**
 * A topic as a chip under the answer names it: the pack writes a topic with the
 * story or criterion it belongs to ("US-1/AC-1: a task due yesterday"); the chip
 * says the topic ("a task due yesterday") and keeps the whole of it as its title.
 */
export function settledTopicLabel(topic: string): string {
  const bare = topic.replace(/^[A-Z][A-Z0-9]*-\d+(?:\/[A-Z][A-Z0-9]*-\d+)*:\s+/, '');
  return bare.trim() ? bare : topic;
}

/**
 * The provider a turn was answered by, in the one word learners already read
 * under a mentor's reply. Only the offline mentor is named: an answer from the
 * model, or one the guardrail wrote, needs no word.
 */
function offline(turn: InterviewTurn): boolean {
  return turn.provider === 'local-mentor';
}

export function Room({
  persona,
  opening,
  turns,
  facts,
  factsExpected,
  outgoing,
  onRetry,
  canRetry,
  busy,
  scrollRef,
}: {
  persona: { name: string; role: string };
  opening: string;
  turns: InterviewTurn[];
  /** The topics, so a settled id can be printed as the sentence it settled. */
  facts: InterviewFactView[];
  /**
   * How many are enough: the number the teacher saved, said beside the topic
   * count and never as it (see {@link interviewCountSentence}).
   */
  factsExpected?: number;
  /** Local delivery state, never a saved turn or evidence of learned facts. */
  outgoing: OutgoingInterviewQuestion[];
  onRetry: (id: number) => void;
  canRetry: boolean;
  busy: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const topicOf = (id: string) => facts.find((fact) => fact.id === id)?.topic ?? null;
  // The transcript scrolls; while it does, the keyboard can reach it.
  const transcriptRef = useScrollFocusRef(scrollRef);
  return (
    <div
      ref={transcriptRef}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4"
      role="log"
      aria-live="polite"
      aria-busy={busy}
      data-testid="interview-transcript"
    >
      {/* The opening is the customer speaking before anybody asked, so it is
          drawn as their message and not as an instruction to the learner. */}
      <div className="flex items-start gap-3" data-testid="interview-opening">
        <img src="/artwork/requirements-maya-3d.webp" width={44} height={44} alt="" className="rounded-full object-contain shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="label-sm font-medium text-ink2">{persona.name}</p>
          <p className="mt-1 max-w-[70ch] wrap text-[13.5px] leading-relaxed text-ink2">{opening}</p>
        </div>
      </div>

      {/* Before the first question the room is not empty of the customer, only
          of answers, so this sits under their opening rather than instead of
          it: the thing to say is what is worth asking about. */}
      {/* No project's story by name: "US-4" is
          TaskTrackr's, and on a teacher's project the story the class writes
          is the teacher's. */}
      {turns.length === 0 && outgoing.length === 0 && (
        <EmptyState
          icon="requirements"
          title="The customer is waiting"
          body={`Ask what you need to know before you write your user story.${
            interviewCountSentence(facts.length, factsExpected) ? ` ${interviewCountSentence(facts.length, factsExpected)}` : ''
          }`}
          testId="interview-empty"
        />
      )}

      {turns.map((turn, i) => {
        const settled = turn.facts.map(topicOf).filter((topic): topic is string => Boolean(topic));
        return (
          <div key={turn.id} className="flex flex-col gap-2.5" data-testid={`interview-turn-${i + 1}`}>
            <div className="flex flex-col items-end gap-1">
              <div className="max-w-[86%] whitespace-pre-wrap break-words rounded-panel rounded-br-sm bg-tint px-3 py-2 text-[13px] leading-relaxed text-ink">
                {turn.question}
              </div>
            </div>

            <div className="flex items-start gap-3">
              <img src="/artwork/requirements-maya-3d.webp" width={44} height={44} alt="" className="rounded-full object-contain shrink-0" />
              <div className="min-w-0 flex-1">
                <div
                  className="max-w-[70ch] text-[13.5px] leading-relaxed text-ink2"
                  data-testid={`interview-answer-${i + 1}`}
                >
                  {/* Markdown only for what a model wrote. A
                      guardrail answer is the interview's authored refusal, which
                      the teacher wrote, or the product's off-phase line: drawn
                      plain, its words kept, its markup not interpreted. */}
                  {turn.provider === 'guardrail'
                    ? <PlainText className="text-[13.5px] leading-relaxed text-ink2" text={plainTextOf(turn.answer)} />
                    : <Markdown>{turn.answer}</Markdown>}
                </div>
                {(settled.length > 0 || offline(turn)) && <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {/* The topics this answer settled, each as the app's small chip
                      without the story or criterion id the pack files it under. */}
                  {settled.length > 0 && (
                    // A list named "Settled", so a screen reader says the topics one by one.
                    <span className="flex flex-wrap items-center gap-1.5" data-testid={`interview-settled-${i + 1}`} role="list" aria-label="Settled">
                      <span className="label-sm font-medium text-ink2" aria-hidden="true">Settled</span>
                      {settled.map((topic, at) => <span key={at} role="listitem"><Chip tone="outline" title={topic}>{settledTopicLabel(topic)}</Chip></span>)}
                    </span>
                  )}
                  {/* No fact credit does not imply an undecided requirement:
                      greetings, clarifications and redirects speak for themselves. */}
                  {/* No guardrail badge here, unlike the mentor's column. The
                      refusal is already in the customer's own words, and a
                      product owner who suddenly talks about withheld hints is
                      a broken customer. */}
                  {offline(turn) && <span className="label-sm">offline mentor</span>}
                </p>}
              </div>
            </div>
          </div>
        );
      })}

      {outgoing.map(question => <div key={question.id} className="flex flex-col items-end gap-1" data-testid="interview-outgoing" data-status={question.status}>
        <div className="max-w-[86%] whitespace-pre-wrap break-words rounded-panel rounded-br-sm bg-tint px-3 py-2 text-[13px] leading-relaxed text-ink" data-testid="interview-outgoing-question">{question.question}</div>
        {question.status === 'failed' && <p id={`interview-question-error-${question.id}`} role="alert" data-testid="interview-error" data-failure={question.failure?.kind}
          className="max-w-[86%] break-words text-right text-[12px] leading-relaxed text-muted">{question.failure?.message ?? 'Your question is kept. Try sending it again.'}</p>}
        {question.status === 'failed' && <button type="button" className="btn-secondary" aria-describedby={`interview-question-error-${question.id}`} onClick={() => onRetry(question.id)} disabled={busy || !canRetry} data-testid="interview-retry-question">Retry question</button>}
      </div>)}

      {/* The wait says more the longer it lasts, and the lead sentence is
          still the one the customer's room always drew: kept here, as its own
          words, so the voice lint still reads it. It is mounted under `busy`,
          so the next question starts its clock again. */}
      {busy && <WaitStage kind="interview">{persona.name} is thinking…</WaitStage>}
    </div>
  );
}
