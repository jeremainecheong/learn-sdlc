// @vitest-environment jsdom
/**
 * What a wait is allowed to say, and when it may say it.
 *
 * The interview and the Guided thread each answer with one blocking POST, so
 * for nine to eighteen seconds a learner has one static line and nothing else.
 * `WaitStage` adds sentences as that wait grows. The sentences are the risk:
 * a wait line is copy nobody reviews at the moment it appears, it renders
 * inside the interview transcript that `e2e/interview.spec.ts` ('the customer
 * answers from the pack and never writes the story') lowercases and searches
 * for "as a " and "so that", and it renders inside the transcript whose height
 * and scroll position `e2e/reviewer-column.spec.ts` ('the interview gives the
 * conversation the screen on a phone') measures. So the table is
 * asserted as copy, the clock is asserted with fake timers, and the markup is
 * asserted to be a block of siblings that leaves the existing lead line's box
 * exactly as it was.
 *
 * Two things this suite deliberately stands in for:
 *
 * - `copy-lint.mjs` reads JSX text and a short list of prose props, and it can
 *   read neither a module-level table nor a prop it has never heard of. The
 *   lead sentences are therefore passed as children, which keeps them as the
 *   JsxText the lint has always read at both call sites, and the table's own
 *   copy is asserted here (separators included) because nothing else can.
 * - the block renders inside a `role="log"` that is `aria-busy` for exactly as
 *   long as the block is mounted, and a live region inside a busy container is
 *   presented only once the busy state clears. The lines are visual, then, and
 *   these tests say so rather than claiming an announcement nobody would hear.
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, REVIEWED_AI_TIMEOUT_MS } from '@/lib/api';
import { WAIT_STAGES, WaitStage, waitLines, type WaitKind } from '@/components/WaitStage';
import { Room } from '@/components/workspace/interview/Room';
import { askFailureSentence, PersonaFeed } from '@/components/shell/PersonaPanel';
import { PHASE_REVIEWER } from '@/lib/phase';

// Two parsers this suite never waits on: a reply here is its own text.
vi.mock('next/dynamic', () => ({ default: () => (props: { children?: string }) => <div>{props.children}</div> }));
vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <p>{children}</p> }));

const KINDS: WaitKind[] = ['interview', 'guided'];
const CHECKED_INTERVIEW = 'Every answer is checked before it reaches you.';
const CHECKED_GUIDED = 'Every reply is checked before you see it.';
const STILL_WAITING_INTERVIEW = 'This is taking longer than usual. Your question is kept.';
const STILL_WAITING_GUIDED = 'This is taking longer than usual. You do not need to ask again.';
/** The classes the two call sites draw their one wait line with. */
const LEAD_CLASS = 'flex items-center gap-2 text-[12.5px] text-muted';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = (node: React.ReactNode) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
};
const text = () => host!.textContent ?? '';
const block = () => host!.querySelector('[data-testid="wait-stage"]')!;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

describe('the honest wait lines', () => {
  it('says nothing beyond the lead sentence before the quiet threshold', () => {
    for (const kind of KINDS) {
      expect(waitLines(kind, 0)).toEqual([]);
      expect(waitLines(kind, 5_999)).toEqual([]);
    }
  });

  it('adds the always-true checking sentence once the wait is long, then the one about waiting', () => {
    expect(waitLines('interview', 6_000)).toEqual([CHECKED_INTERVIEW]);
    expect(waitLines('guided', 6_000)).toEqual([CHECKED_GUIDED]);
    expect(waitLines('interview', 24_999)).toEqual([CHECKED_INTERVIEW]);
    expect(waitLines('interview', 25_000)).toEqual([CHECKED_INTERVIEW, STILL_WAITING_INTERVIEW]);
    expect(waitLines('guided', 25_000)).toEqual([CHECKED_GUIDED, STILL_WAITING_GUIDED]);
    // A wait that ran long says the same two things a minute later: the table
    // is a ladder of thresholds, not a queue that empties.
    expect(waitLines('guided', 120_000)).toEqual([CHECKED_GUIDED, STILL_WAITING_GUIDED]);
  });

  it('promises the question is kept only on the wait where it is kept', () => {
    // The interview keeps a question that failed: the outgoing row stays with
    // its words and a Retry beside it (Room.tsx:127-132) and the draft is put
    // back (useInterview.ts:155-157), so the promise holds on that path.
    expect(waitLines('interview', 25_000)).toContain(STILL_WAITING_INTERVIEW);
    expect(STILL_WAITING_INTERVIEW).toContain('kept');

    // The Guided thread's block is mounted by one `busy` that "Explain this
    // failure" sets as well as the composer (PersonaPanel.tsx:329 and :286),
    // and the explain path keeps nothing: its bubble is dropped (:352), its
    // question was generated rather than typed so there is no draft to hand
    // back, and its own failure sentence says as much. A retention promise
    // read at 25 s would be a promise that path cannot keep.
    expect(askFailureSentence('Mira', new ApiError(500, 'The server had a problem.'), false)).not.toContain('kept');
    for (const { line } of WAIT_STAGES.guided) {
      expect(line.toLowerCase()).not.toContain('kept');
      expect(line.toLowerCase()).not.toContain('saved');
    }
  });

  it('never uses the two phrases the interview transcript must not contain', () => {
    // Regression guard for e2e/interview.spec.ts:132-134, which lowercases the
    // whole interview-transcript element and asserts neither phrase is in it:
    // the proof that the customer never wrote the learner's story. The wait
    // line renders inside that element.
    for (const kind of KINDS) {
      for (const { line } of WAIT_STAGES[kind]) {
        expect(line.toLowerCase()).not.toContain('as a ');
        expect(line.toLowerCase()).not.toContain('so that');
      }
    }
  });

  it('regression guard: keeps the product voice copy-lint cannot see in a module table', () => {
    // `copy-lint.mjs` reads JsxText, a bare literal in an expression container
    // and a short list of prose props (:47-58, :86-110). A table declared at
    // module scope is none of those, so its two rules are asserted here: no
    // middle dot and no pipe standing in for a word.
    for (const kind of KINDS) {
      for (const { line } of WAIT_STAGES[kind]) {
        expect(line).not.toContain('·');
        expect(line).not.toContain('|');
        expect(line).toMatch(/^[A-Z]/);
      }
    }
  });

  it('regression guard: says its last sentence well before the request gives up, in ascending order', () => {
    for (const kind of KINDS) {
      const thresholds = WAIT_STAGES[kind].map(stage => stage.atMs);
      expect(thresholds).toEqual([...thresholds].sort((a, b) => a - b));
      expect(Math.max(...thresholds)).toBeLessThan(REVIEWED_AI_TIMEOUT_MS / 2);
      // No line counts anything down, and none of them names a server step.
      for (const { line } of WAIT_STAGES[kind]) {
        expect(line).not.toMatch(/\d/);
        expect(line.toLowerCase()).not.toMatch(/second|minute|reviewer call|draft/);
      }
    }
  });
});

describe('the wait block on screen', () => {
  it('adds the later sentence beside the lead line without remounting it, and clears its timers on unmount', () => {
    vi.useFakeTimers();
    mount(<WaitStage kind="interview">Maya is thinking…</WaitStage>);
    const lead = block().querySelector('p')!;
    expect(lead.className).toBe(LEAD_CLASS);
    expect(text()).toContain('Maya is thinking…');
    expect(text()).not.toContain(CHECKED_INTERVIEW);

    act(() => void vi.advanceTimersByTime(6_000));
    expect(text()).toContain(CHECKED_INTERVIEW);
    expect(text()).not.toContain(STILL_WAITING_INTERVIEW);
    // The lead is the same element it was, with the same box: the second
    // sentence is a sibling of it, never a paragraph nested inside it.
    expect(block().querySelector('p')).toBe(lead);
    expect(lead.className).toBe(LEAD_CLASS);
    expect(lead.querySelector('p')).toBeNull();
    expect(block().querySelectorAll('p')).toHaveLength(2);

    act(() => void vi.advanceTimersByTime(19_000));
    expect(text()).toContain(STILL_WAITING_INTERVIEW);
    expect(block().querySelectorAll('p')).toHaveLength(3);
    expect(block().querySelector('p')).toBe(lead);
    // Nothing moves, so there is nothing for reduced motion to switch off.
    for (const line of block().querySelectorAll('*')) {
      expect(line.className.toString()).not.toMatch(/animate|transition|pulse|spin/);
    }

    act(() => void root!.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops the threshold the answer outran, rather than leaving it to fire into an unmounted tree', () => {
    // The failure this is named for is an answer at eight seconds: the block
    // goes, and the twenty-five second timeout must go with it. Asserted while
    // that timer is still pending, because a count taken after both thresholds
    // have fired is zero whether the teardown runs or not.
    vi.useFakeTimers();
    mount(<WaitStage kind="guided">The senior engineer is reading…</WaitStage>);
    expect(vi.getTimerCount()).toBe(WAIT_STAGES.guided.length);

    act(() => void vi.advanceTimersByTime(6_000));
    expect(text()).toContain(CHECKED_GUIDED);
    expect(vi.getTimerCount()).toBe(1);

    act(() => void root!.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a new clock for the next request rather than reusing the last one', () => {
    vi.useFakeTimers();
    mount(<WaitStage kind="guided">The senior engineer is reading…</WaitStage>);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(text()).toContain(STILL_WAITING_GUIDED);

    // Both call sites drop the block in their `finally` and draw a new one for
    // the next question, so a mount is a request and the clock starts at nil.
    act(() => void root!.unmount());
    root = null;
    host!.remove();
    mount(<WaitStage kind="guided">The senior engineer is reading…</WaitStage>);
    expect(text()).toContain('The senior engineer is reading…');
    expect(text()).not.toContain(CHECKED_GUIDED);
    expect(text()).not.toContain(STILL_WAITING_GUIDED);

    // A clock kept outside the component would be half a minute old here and
    // would fire both thresholds on the next tick, which the first paint alone
    // cannot see. So the clock is asserted by advancing it.
    act(() => void vi.advanceTimersByTime(5_999));
    expect(text()).not.toContain(CHECKED_GUIDED);
    expect(text()).not.toContain(STILL_WAITING_GUIDED);
    act(() => void vi.advanceTimersByTime(1));
    expect(text()).toContain(CHECKED_GUIDED);
    expect(text()).not.toContain(STILL_WAITING_GUIDED);
  });

  it('draws the interview line inside the transcript, with no second live region under the busy log', () => {
    vi.useFakeTimers();
    const scrollRef = createRef<HTMLDivElement>();
    mount(
      <Room
        persona={{ name: 'Maya', role: 'product owner' }}
        opening="The overdue report is wrong."
        turns={[]}
        facts={[]}
        outgoing={[]}
        onRetry={() => {}}
        canRetry
        busy
        scrollRef={scrollRef}
      />,
    );
    const transcript = host!.querySelector('[data-testid="interview-transcript"]')!;
    expect(transcript.getAttribute('role')).toBe('log');
    expect(transcript.getAttribute('aria-live')).toBe('polite');
    expect(transcript.getAttribute('aria-busy')).toBe('true');
    expect(transcript.textContent).toContain('Maya is thinking…');

    act(() => void vi.advanceTimersByTime(6_000));
    expect(transcript.textContent).toContain(CHECKED_INTERVIEW);
    // The log is busy for exactly as long as the block is mounted, and a live
    // region inside a busy container is presented only once that clears: by
    // which time the answer has replaced the block. These lines are read, not
    // heard, and the block adds no status region of its own: a nested one
    // would repeat the whole block on every change and still not be heard.
    expect(transcript.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(0);
  });

  it('draws the Guided line inside the feed, under the same one busy log', () => {
    vi.useFakeTimers();
    const scrollRef = createRef<HTMLDivElement>();
    const thread = {
      phaseKey: 'implementation' as const,
      phaseStateId: 'ps-1',
      reviewer: PHASE_REVIEWER.implementation,
      name: 'Senior engineer',
      ask: 'Ask the senior engineer',
      messages: [],
      ordinals: new Map<string, number>(),
      asked: 0,
      busy: true,
      usage: null,
      send: async () => null,
      explain: async () => null,
      failure: null,
      clearFailure: () => {},
      scrollRef,
    };
    mount(<PersonaFeed thread={thread} />);
    const log = host!.querySelector('[role="log"]')!;
    expect(log.textContent).toContain('The senior engineer is reading…');

    act(() => void vi.advanceTimersByTime(6_000));
    expect(log.textContent).toContain(CHECKED_GUIDED);
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.getAttribute('aria-busy')).toBe('true');
    expect(log.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(0);
  });
});
