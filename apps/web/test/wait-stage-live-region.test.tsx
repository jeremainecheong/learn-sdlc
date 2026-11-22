// @vitest-environment jsdom
/**
 * A wait a screen reader can hear.
 *
 * `WaitStage` draws its lines inside the interview transcript and the Guided
 * feed, and both are a `role="log"` that is `aria-busy` for exactly as long as
 * the block is mounted. A live region inside a busy container is presented only
 * once the busy state clears, and by then the answer has replaced the block, so
 * a status inside the log would leave the wait silent to a screen reader.
 *
 * So there is one polite, visually hidden status that is not inside the busy
 * log, and that says the stage the wait has reached. It announces stage changes
 * only: nothing before the first stage, then the newest stage's one sentence,
 * never the lead and never the whole block again, and it leaves with the wait.
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WAIT_STAGES, WaitStage, type WaitKind } from '@/components/WaitStage';
import { Room } from '@/components/workspace/interview/Room';
import { PersonaFeed } from '@/components/shell/PersonaPanel';
import { PHASE_REVIEWER } from '@/lib/phase';

vi.mock('next/dynamic', () => ({ default: () => (props: { children?: string }) => <div>{props.children}</div> }));
vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <p>{children}</p> }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = (node: React.ReactNode) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

/** Every polite or assertive region on the page, as an accessibility audit reads them. */
const liveRegions = () =>
  [...document.querySelectorAll<HTMLElement>('[role="status"],[role="alert"],[aria-live="polite"],[aria-live="assertive"]')];
/** The regions a screen reader would present now: not inside a busy container. */
const heard = () => liveRegions().filter((el) => !el.closest('[aria-busy="true"]'));
const status = () => document.querySelector<HTMLElement>('[data-testid="wait-stage-status"]');

describe('the wait line has a live-region equivalent outside the busy log', () => {
  for (const kind of ['interview', 'guided'] as WaitKind[]) {
    it(`${kind}: one polite status, empty until the first stage, then the newest stage only`, () => {
      vi.useFakeTimers();
      mount(
        <div role="log" aria-live="polite" aria-busy="true">
          <WaitStage kind={kind}>Somebody is thinking…</WaitStage>
        </div>,
      );
      const region = status();
      expect(region, 'a status region is mounted with the wait').not.toBeNull();
      expect(region!.getAttribute('role')).toBe('status');
      expect(region!.getAttribute('aria-live')).toBe('polite');
      expect(region!.closest('[aria-busy="true"]'), 'the status is not inside the busy log').toBeNull();
      expect(region!.className).toContain('sr-only');
      // Nothing before the first stage: a quick answer says no word about waiting.
      expect(region!.textContent).toBe('');

      act(() => void vi.advanceTimersByTime(WAIT_STAGES[kind][0].atMs));
      expect(status()!.textContent).toBe(WAIT_STAGES[kind][0].line);
      // The audit rule's own test: a live region not inside aria-busy whose words
      // are among the drawn wait line's.
      const drawn = document.querySelector('[data-testid="wait-stage"]')!.textContent ?? '';
      expect(heard().some((el) => (el.textContent ?? '').length > 0 && drawn.includes(el.textContent ?? ''))).toBe(true);

      act(() => void vi.advanceTimersByTime(WAIT_STAGES[kind][1].atMs - WAIT_STAGES[kind][0].atMs));
      // The newest stage replaces the last one; the status never repeats the block.
      expect(status()!.textContent).toBe(WAIT_STAGES[kind][1].line);
    });
  }

  it('leaves with the wait', () => {
    vi.useFakeTimers();
    mount(<WaitStage kind="interview">Maya is thinking…</WaitStage>);
    act(() => void vi.advanceTimersByTime(6_000));
    expect(status()).not.toBeNull();
    act(() => root!.render(<p>The answer.</p>));
    expect(status()).toBeNull();
  });

  it('is heard from the interview room while its transcript is busy', () => {
    vi.useFakeTimers();
    mount(
      <Room
        persona={{ name: 'Maya', role: 'product owner' }}
        opening="The report is wrong."
        turns={[]}
        facts={[]}
        outgoing={[]}
        onRetry={() => {}}
        canRetry
        busy
        scrollRef={createRef<HTMLDivElement>()}
      />,
    );
    act(() => void vi.advanceTimersByTime(6_000));
    const transcript = document.querySelector('[data-testid="interview-transcript"]')!;
    expect(transcript.getAttribute('aria-busy')).toBe('true');
    expect(heard().map((el) => el.textContent)).toContain(WAIT_STAGES.interview[0].line);
  });

  it('is heard from the Guided feed while its log is busy', () => {
    vi.useFakeTimers();
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
      scrollRef: createRef<HTMLDivElement>(),
    };
    mount(<PersonaFeed thread={thread} />);
    act(() => void vi.advanceTimersByTime(6_000));
    expect(heard().map((el) => el.textContent)).toContain(WAIT_STAGES.guided[0].line);
  });
});
