/**
 * The live preview's own derivations.
 *
 * Everything the panel decides is here rather than inside a component: what
 * state the pane is in, how often to ask again, what the console tail is after
 * an answer, and which sentence a learner reads. The panel itself is a
 * rendering of these five functions, and the Playwright beat is what proves
 * the rendering; this is what proves the reasoning.
 *
 * The copy block is one assertion per sentence on purpose. `copy.ts` is the
 * only place the product says any of this, so a sentence that goes missing
 * (a `stopReason` the API gained, a state nobody drew) is a failing test
 * rather than an empty box in a pane at the back of a phase.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_DISABLED_MESSAGE,
  PREVIEW_ISOLATION_MESSAGE,
  PREVIEW_NOT_MARKED_MESSAGE,
  PREVIEW_UNAVAILABLE_MESSAGE,
  type PreviewLogLine,
  type PreviewSessionView,
  type PreviewStatus,
  type PreviewStopReason,
} from '@learnsdlc/shared';
import { severities, stripAnsi } from '@/components/workspace/preview/log';
import {
  CONSOLE_MAX,
  EMPTY_TAIL,
  POLL_FIRST_MS,
  POLL_READY_MS,
  POLL_STARTING_MS,
  errorCount,
  firstPollDelayMs,
  minutesLeftOf,
  nextTail,
  paneState,
  pollIntervalMs,
} from '@/components/workspace/usePreview';
import {
  BUNDLE_FAILED,
  FAILED_FALLBACK,
  IDLE,
  NOT_MARKED,
  STARTING,
  STOPPED,
  STOPPED_UNKNOWN,
  clockTime,
  failedSentence,
  minutesLeft,
  runningSince,
  stoppedSentence,
  unsupportedSentence,
} from '@/components/workspace/preview/copy';
import { PreviewFrame } from '@/components/workspace/preview/PreviewFrame';
import { PreviewOpenLink, PreviewPanel } from '@/components/workspace/preview/PreviewPanel';
import { ConsolePane } from '@/components/workspace/ConsolePane';

const NOW = Date.parse('2026-03-04T10:00:00.000Z');

function session(over: Partial<PreviewSessionView> = {}): PreviewSessionView {
  return {
    id: 's1',
    phaseStateId: 'p1',
    status: 'ready',
    url: null,
    bundleOk: true,
    message: null,
    stopReason: null,
    startedAt: new Date(NOW).toISOString(),
    readyAt: new Date(NOW + 1_000).toISOString(),
    expiresAt: new Date(NOW + 600_000).toISOString(),
    idleExpiresAt: new Date(NOW + 300_000).toISOString(),
    bytesServed: 0,
    console: [],
    cursor: 0,
    ...over,
  };
}

/** React escapes an apostrophe in text, and three of these sentences have one. */
const escapeHtml = (text: string) => text.replace(/'/g, '&#x27;');

const line = (text: string, stream: 'out' | 'err' = 'out'): PreviewLogLine => ({
  stream,
  text,
  at: new Date(NOW).toISOString(),
});

/* ------------------------------ the pane state ---------------------------- */

describe('paneState', () => {
  /**
   * The panel's `idle` is the client's own word. The API answers `null` for a
   * learner who has never pressed the button, and inventing a session for it
   * would make "never started" and "stopped a moment ago" the same picture.
   */
  it('calls a learner who has never started anything idle', () => {
    expect(paneState(null)).toBe('idle');
  });

  it('takes the API status for every other state', () => {
    const states: PreviewStatus[] = ['starting', 'ready', 'failed', 'stopped', 'busy'];
    for (const status of states) {
      expect(paneState(session({ status }))).toBe(status);
    }
  });

  /**
   * The phase carries why a deployment cannot preview, so the tab says so the
   * moment it is drawn. Without this the panel would draw its idle state, ask,
   * and correct itself, which reads as an app that failed rather than a
   * deployment that has no preview.
   */
  it('is unavailable on a deployment that cannot preview, before anything is asked', () => {
    expect(paneState(null, 'lambda-runner')).toBe('unavailable');
    expect(paneState(null, 'disabled')).toBe('unavailable');
  });

  it('stays unavailable even holding a session from before the switch was thrown', () => {
    expect(paneState(session({ status: 'ready' }), 'disabled')).toBe('unavailable');
  });
});

describe('pollIntervalMs', () => {
  it('asks every two seconds while the app is booting', () => {
    expect(pollIntervalMs('starting')).toBe(POLL_STARTING_MS);
    expect(POLL_STARTING_MS).toBe(2_000);
  });

  it('asks every fifteen seconds once it is up', () => {
    expect(pollIntervalMs('ready')).toBe(POLL_READY_MS);
    expect(POLL_READY_MS).toBe(15_000);
  });

  /**
   * A settled session is not going to change on its own, and thirty learners
   * polling about an app that stopped ten minutes ago is thirty requests a
   * second the API does not owe anybody.
   */
  it('stops asking about anything settled', () => {
    for (const status of ['idle', 'failed', 'stopped', 'busy', 'unavailable'] as PreviewStatus[]) {
      expect(pollIntervalMs(status)).toBeNull();
    }
  });
});

/**
 * The first ask after a press is not the cadence.
 *
 * A small application is up well inside two seconds, and the learner spent
 * that whole two seconds reading a panel that had nothing to say yet. The
 * steady cadence is right for the fifth ask and wrong for the first one, so
 * the two are separate numbers, and only the first is shorter.
 */
describe('firstPollDelayMs', () => {
  it('asks sooner than the cadence on the first poll after a start', () => {
    expect(firstPollDelayMs('starting')).toBe(POLL_FIRST_MS);
    expect(POLL_FIRST_MS).toBe(750);
    // The cadence itself: every later ask is two seconds.
    expect(POLL_STARTING_MS).toBe(2_000);
    expect(POLL_FIRST_MS).toBeLessThan(POLL_STARTING_MS);
  });

  /** Regression guard: nothing but a booting app gets a shorter first ask. */
  it('uses the ordinary cadence for the first poll of every other state', () => {
    expect(firstPollDelayMs('ready')).toBe(POLL_READY_MS);
    for (const status of ['idle', 'failed', 'stopped', 'busy', 'unavailable'] as PreviewStatus[]) {
      expect(firstPollDelayMs(status)).toBeNull();
    }
  });
});

/* ----------------------------- the console tail --------------------------- */

describe('nextTail', () => {
  it('starts from nothing', () => {
    expect(EMPTY_TAIL).toEqual({ lines: [], cursor: 0 });
  });

  it('appends what is new and carries the cursor the API answered', () => {
    const first = nextTail(EMPTY_TAIL, session({ console: [line('a'), line('b')], cursor: 2 }));
    expect(first.lines.map((l) => l.text)).toEqual(['a', 'b']);
    expect(first.cursor).toBe(2);

    const second = nextTail(first, session({ console: [line('c')], cursor: 3 }));
    expect(second.lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
    expect(second.cursor).toBe(3);
  });

  /**
   * The case this function exists for. A quiet app answers with no lines, and
   * a tail that only moved its cursor when lines arrived would ask for the
   * same nothing for ever, and then replay the whole ring the moment the app
   * printed one line.
   */
  it('moves the cursor even when the app printed nothing', () => {
    const held = { lines: [line('a')], cursor: 1 };
    expect(nextTail(held, session({ console: [], cursor: 9 })).cursor).toBe(9);
  });

  /**
   * A second start is a different application. Its cursor restarts at zero, so
   * an answer behind the one being held is the signal to drop the previous
   * app's console rather than to attribute its traceback to this one.
   */
  it('replaces the tail when the cursor goes backwards, which is a new session', () => {
    const held = { lines: [line('old'), line('older')], cursor: 12 };
    const next = nextTail(held, session({ console: [line('new')], cursor: 1 }));
    expect(next.lines.map((l) => l.text)).toEqual(['new']);
    expect(next.cursor).toBe(1);
  });

  it('keeps the newest lines when the ring overflows', () => {
    const held = {
      lines: Array.from({ length: CONSOLE_MAX }, (_, i) => line(`l${i}`)),
      cursor: CONSOLE_MAX,
    };
    const next = nextTail(held, session({ console: [line('last')], cursor: CONSOLE_MAX + 1 }));
    expect(next.lines).toHaveLength(CONSOLE_MAX);
    expect(next.lines[next.lines.length - 1].text).toBe('last');
    expect(next.lines[0].text).toBe('l1');
  });

  it('forgets everything when there is no session left', () => {
    expect(nextTail({ lines: [line('a')], cursor: 4 }, null)).toEqual(EMPTY_TAIL);
  });

  /**
   * The count the Console tab carries. It is not the stderr lines: Flask
   * writes its banner and its whole access log to stderr, so a working app
   * would wear a red "4". It is the lines that say something went wrong,
   * whichever pipe they came down.
   */
  it('counts the lines that say something went wrong, not the stderr ones', () => {
    expect(
      errorCount([
        line('a'),
        line('WARNING: This is a development server. Do not use it in a production deployment.', 'err'),
        line('Press CTRL+C to quit', 'err'),
        line('127.0.0.1 - - [06/Sep/2026 12:32:58] "GET /api/health HTTP/1.1" 200 -', 'err'),
      ]),
    ).toBe(0);
    expect(
      errorCount([
        line('Traceback (most recent call last):', 'err'),
        line('  File "app.py", line 12, in create', 'err'),
        line('ValueError: no such list', 'err'),
        line('127.0.0.1 - - [06/Sep/2026 12:33:01] "POST /api/lists HTTP/1.1" 500 -', 'err'),
      ]),
    ).toBe(4);
    expect(errorCount([])).toBe(0);
  });
});

/* ------------------------------- the console ------------------------------- */

/**
 * What a console line means, rather than which pipe it came down.
 * The pane draws these three severities and nothing else decides its colour.
 */
describe('severities', () => {
  it('reads a working Flask app as nothing to look at, on stderr or not', () => {
    expect(
      severities([
        line(' * Serving Flask app "app"', 'err'),
        line('WARNING: This is a development server. Do not use it in a production deployment.', 'err'),
        line('Press CTRL+C to quit', 'err'),
        line('127.0.0.1 - - [06/Sep/2026 12:32:58] "GET /api/health HTTP/1.1" 200 -', 'err'),
      ]),
    ).toEqual(['info', 'warn', 'info', 'info']);
  });

  it('reads an access log by its status code', () => {
    expect(
      severities([
        line('127.0.0.1 - - [06/Sep/2026 12:32:58] "GET /nope HTTP/1.1" 404 -', 'err'),
        line('127.0.0.1 - - [06/Sep/2026 12:32:59] "POST /api/lists HTTP/1.1" 500 -', 'err'),
      ]),
    ).toEqual(['warn', 'error']);
  });

  /** A traceback is a block: its frames say nothing on their own. */
  it('carries a traceback over the frames under it', () => {
    expect(
      severities([
        line('Traceback (most recent call last):', 'err'),
        line('  File "api/routes.py", line 41, in create_task', 'err'),
        line('    return repository.add(task)', 'err'),
        line('KeyError: "due"', 'err'),
        line('127.0.0.1 - - [06/Sep/2026 12:33:01] "GET / HTTP/1.1" 200 -', 'err'),
      ]),
    ).toEqual(['error', 'error', 'error', 'error', 'info']);
  });

  it('reads a compiler that failed, on whichever pipe it wrote', () => {
    expect(severities([line('src/App.tsx(12,3): error TS2304: Cannot find name "Task".')])).toEqual(
      ['error'],
    );
  });
});

describe('stripAnsi', () => {
  it('keeps the words and drops the colour, for lines stored before the runner did', () => {
    expect(stripAnsi('\u001b[31m\u001b[1mWARNING: development server\u001b[0m')).toBe(
      'WARNING: development server',
    );
    expect(stripAnsi('plain')).toBe('plain');
  });
});

/* -------------------------------- the clock -------------------------------- */

describe('minutesLeftOf', () => {
  it('says nothing while there is more than two minutes of the cap left', () => {
    expect(minutesLeftOf(new Date(NOW + 600_000).toISOString(), NOW)).toBeNull();
    expect(minutesLeftOf(new Date(NOW + 121_000).toISOString(), NOW)).toBeNull();
  });

  it('starts counting inside the last two minutes', () => {
    const left = minutesLeftOf(new Date(NOW + 90_000).toISOString(), NOW);
    expect(left).toBeCloseTo(1.5, 5);
    expect(minutesLeft(left as number)).toBe('About 2 minutes left.');
  });

  it('never counts below zero, and never says "About 0 minutes left."', () => {
    expect(minutesLeftOf(new Date(NOW - 60_000).toISOString(), NOW)).toBe(0);
    expect(minutesLeft(0)).toBe('About 1 minute left.');
  });

  it('says nothing at all about a session with no cap it can read', () => {
    expect(minutesLeftOf(null, NOW)).toBeNull();
    expect(minutesLeftOf('not a date', NOW)).toBeNull();
  });
});

/* --------------------------------- the copy -------------------------------- */

describe('copy', () => {
  it('says what the button will do and how long it lasts, before anything runs', () => {
    expect(IDLE).toBe(
      'The app is not running. Run app builds your front end, starts your API and shows it here. It runs in your own preview session for up to ten minutes.',
    );
  });

  it('says one thing while it boots', () => {
    expect(STARTING).toBe('Starting your app.');
  });

  it('names the time it started and both caps while it runs', () => {
    const at = new Date(NOW).toISOString();
    expect(runningSince(at)).toBe(
      `Running since ${clockTime(at)}. Stops after ten minutes, or five minutes with nothing happening.`,
    );
    expect(runningSince(at)).toContain('Stops after ten minutes, or five minutes with nothing happening.');
  });

  it('draws a dash rather than "Invalid Date" for a session with no ready time', () => {
    expect(clockTime(null)).toBe('—');
    expect(clockTime('nonsense')).toBe('—');
  });

  /**
   * One assertion per reason, and the record is exhaustive by its type: a
   * `PreviewStopReason` the API gains without a sentence here will not
   * compile, and a sentence that is empty fails below.
   */
  const reasons: [PreviewStopReason, string][] = [
    ['learner', 'You stopped the app.'],
    [
      'idle',
      'The app stopped after five quiet minutes. Nothing was lost. Start it again when you need it.',
    ],
    ['expired', 'The app ran for its ten minutes and stopped. Start it again to keep going.'],
    ['budget', 'The app stopped after serving 32 MB. The console shows what it was serving.'],
    [
      'build',
      "The front end did not build, so the app stopped. The console has the compiler's message.",
    ],
    ['crashed', 'Your app stopped on its own. The console shows what it printed last.'],
    [
      'shutdown',
      'The app was stopped because the platform restarted. Start it again when you need it.',
    ],
  ];
  for (const [reason, sentence] of reasons) {
    it(`says why a session stopped: ${reason}`, () => {
      expect(STOPPED[reason]).toBe(sentence);
      expect(stoppedSentence(reason)).toBe(sentence);
    });
  }

  it('still has something to say about a session that stopped without a reason', () => {
    expect(stoppedSentence(null)).toBe(STOPPED_UNKNOWN);
    expect(STOPPED_UNKNOWN.length).toBeGreaterThan(10);
  });

  /**
   * The runner is the only party that watched the learner's own process, so
   * its sentence wins whenever there is one. The fallback exists for the case
   * where the transport failed before anything was observed.
   */
  it('prefers the runner\'s own sentence about a failed start', () => {
    expect(failedSentence('Your API did not start.')).toBe('Your API did not start.');
    expect(failedSentence('   ')).toBe(FAILED_FALLBACK);
    expect(failedSentence(null)).toBe(FAILED_FALLBACK);
  });

  it('says the build failed without saying the platform did', () => {
    expect(BUNDLE_FAILED).toBe(
      "The front end did not build. The console has the compiler's message.",
    );
  });

  it('names the reason a deployment cannot preview at all', () => {
    expect(unsupportedSentence('lambda-runner')).toBe(PREVIEW_UNAVAILABLE_MESSAGE);
    expect(unsupportedSentence('disabled')).toBe(PREVIEW_DISABLED_MESSAGE);
    expect(unsupportedSentence(null)).toBe(PREVIEW_DISABLED_MESSAGE);
  });

  it('says a host without kernel isolation cannot run the app, not that preview is turned off', () => {
    expect(unsupportedSentence('isolation')).toBe(PREVIEW_ISOLATION_MESSAGE);
    expect(PREVIEW_ISOLATION_MESSAGE).toContain('cannot provide kernel isolation on this host');
    expect(unsupportedSentence('isolation')).not.toContain('turned off');
  });

  it('lets the API say it in its own words when it sent some', () => {
    expect(unsupportedSentence('disabled', 'The runner is being restarted.')).toBe(
      'The runner is being restarted.',
    );
  });

  it('says the preview is not marked, under every state', () => {
    expect(NOT_MARKED).toBe(PREVIEW_NOT_MARKED_MESSAGE);
    expect(NOT_MARKED).toBe('The preview is for you. It is not marked.');
  });

  /** Every state the pane can be in has something to say. */
  it('has a sentence for every status', () => {
    const said: Record<PreviewStatus, string> = {
      idle: IDLE,
      starting: STARTING,
      ready: runningSince(new Date(NOW).toISOString()),
      failed: failedSentence(null),
      stopped: stoppedSentence(null),
      busy: 'the API sends SANDBOX_BUSY_MESSAGE',
      unavailable: unsupportedSentence('lambda-runner'),
    };
    for (const [status, sentence] of Object.entries(said)) {
      expect(sentence.trim().length, status).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------- the rendering ----------------------------- */

/**
 * Two components are worth rendering here rather than leaving to Playwright:
 * the frame, because its `sandbox` attribute is the whole security posture of
 * the feature and a typo in it is silent; and the panel, because the point of
 * `copy.ts` is that every state actually draws its sentence.
 */
describe('PreviewFrame', () => {
  const render = (nonce: number) =>
    renderToStaticMarkup(
      createElement(PreviewFrame, { apiUrl: 'http://localhost:4000', url: '/api/v1/preview/CAP/', nonce }),
    );

  it('points at the door the start answered, on the API origin', () => {
    expect(render(0)).toContain('src="http://localhost:4000/api/v1/preview/CAP/?r=0"');
  });

  /**
   * Refresh is a nonce. Without it the button asks the browser to load a URL
   * it already has, which it is entitled to answer from cache.
   */
  it('changes the src when the nonce changes', () => {
    expect(render(1)).toContain('?r=1"');
    expect(render(1)).not.toContain('?r=0"');
  });

  /**
   * The nonce is a query and never the hash, and that is what this assertion
   * exists for: the pack's front end routes on the hash, so `#1` is a route,
   * and the app answers it with its own "No such page" (in Chrome, the header
   * drawn and `not-found` under it).
   */
  it('never puts the nonce where the app keeps its route', () => {
    expect(render(3)).not.toContain('#3');
    expect(render(3)).not.toContain('#"');
  });

  /**
   * `allow-same-origin` is absent on purpose: the document inside gets an
   * opaque origin and cannot read this page's token, storage or cookies. This
   * assertion is the one that fails loudly if anybody ever adds it back to
   * make the learner's `localStorage` work.
   */
  it('sandboxes the learner\'s app without giving it this page\'s origin', () => {
    const html = render(0);
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-modals"');
    expect(html).not.toContain('allow-same-origin');
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
  });
});

describe('PreviewPanel', () => {
  const draw = (over: Parameters<typeof PreviewPanel>[0] extends never ? never : any = {}) =>
    renderToStaticMarkup(
      createElement(PreviewPanel, {
        status: 'idle',
        session: null,
        apiUrl: 'http://localhost:4000',
        url: null,
        nonce: 0,
        errors: 0,
        starting: false,
        error: '',
        unsupported: null,
        onStart: () => {},
        onStop: () => {},
        onRefresh: () => {},
        onOpenConsole: () => {},
        ...over,
      }),
    );

  it('draws the pane and the footer in every state', () => {
    for (const status of ['idle', 'starting', 'ready', 'failed', 'stopped', 'busy', 'unavailable'] as PreviewStatus[]) {
      const html = draw({ status, session: status === 'idle' ? null : session({ status }) });
      expect(html, status).toContain('data-testid="preview-pane"');
      expect(html, status).toContain(escapeHtml(PREVIEW_NOT_MARKED_MESSAGE));
    }
  });

  it('offers the button and says what it does before anything is running', () => {
    const html = draw();
    expect(html).toContain('data-testid="preview-idle"');
    expect(html).toContain('data-testid="preview-run"');
    expect(html).toContain(escapeHtml(IDLE));
  });

  it('offers explicit restart and stop when a ready session has no private link in this tab', () => {
    const html = draw({ status: 'ready', session: session({ status: 'ready', url: null }), url: null });
    expect(html).toContain('data-testid="preview-detached"');
    expect(html).toContain('Your preview is running');
    expect(html).toContain('Start a new preview');
    expect(html).toContain('data-testid="preview-stop"');
    expect(html).not.toContain('data-testid="preview-frame"');
    expect(html).not.toContain('data-testid="preview-idle"');
    expect(html).not.toContain('/api/v1/preview/');
  });

  it('shows actual startup progress while replacing a detached session', () => {
    const html = draw({ status: 'ready', session: session({ status: 'ready' }), url: null, starting: true });
    expect(html).toContain('data-testid="preview-starting"');
    expect(html).not.toContain('data-testid="preview-detached"');
  });

  it('says one thing while the app boots, and no place in a queue', () => {
    const html = draw({ status: 'starting', session: session({ status: 'starting' }) });
    expect(html).toContain('data-testid="preview-starting"');
    expect(html).toContain(STARTING);
    expect(html).not.toContain('queue-line');
  });

  /**
   * The controls come before the frame in the DOM so Tab reaches them first:
   * everything inside the iframe is a tab stop of the learner's own making.
   */
  it('puts Refresh, Open and Stop before the frame, and the frame last', () => {
    const html = draw({
      status: 'ready',
      session: session({ status: 'ready' }),
      url: '/api/v1/preview/CAP/',
    });
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at('preview-refresh')).toBeGreaterThan(-1);
    expect(at('preview-refresh')).toBeLessThan(at('preview-open'));
    expect(at('preview-open')).toBeLessThan(at('preview-stop'));
    expect(at('preview-stop')).toBeLessThan(at('preview-console-toggle'));
    expect(at('preview-console-toggle')).toBeLessThan(at('preview-frame'));
  });

  it('opens in a new tab without handing the app this window', () => {
    const html = draw({
      status: 'ready',
      session: session({ status: 'ready' }),
      url: '/api/v1/preview/CAP/',
    });
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it('says the build failed while still showing the app that is running', () => {
    const html = draw({
      status: 'ready',
      session: session({ status: 'ready', bundleOk: false }),
      url: '/api/v1/preview/CAP/',
    });
    expect(html).toContain(escapeHtml(BUNDLE_FAILED));
    expect(html).toContain('data-testid="preview-frame"');
  });

  it('names the reason a session stopped, in the markup and in the sentence', () => {
    const html = draw({
      status: 'stopped',
      session: session({ status: 'stopped', stopReason: 'idle' }),
    });
    expect(html).toContain('data-reason="idle"');
    expect(html).toContain(escapeHtml(STOPPED.idle));
  });

  it('shows the runner\'s own sentence when the app did not start', () => {
    const html = draw({
      status: 'failed',
      session: session({ status: 'failed', message: 'Your API did not start.' }),
    });
    expect(html).toContain('data-testid="preview-failed"');
    expect(html).toContain('Your API did not start.');
  });

  it('says why a deployment cannot preview, and offers no button for it', () => {
    const html = draw({ status: 'unavailable', unsupported: 'lambda-runner' });
    expect(html).toContain('data-testid="preview-unsupported"');
    expect(html).toContain(escapeHtml(PREVIEW_UNAVAILABLE_MESSAGE));
    expect(html).not.toContain('data-testid="preview-run"');
    expect(html).not.toContain('data-testid="preview-console-toggle"');
  });

  it('carries the stderr count on the Console control', () => {
    const html = draw({ status: 'failed', session: session({ status: 'failed' }), errors: 3 });
    expect(html).toContain('data-testid="preview-console-toggle"');
    expect(html).toContain('>3<');
  });

  /**
   * A regression guard on `rel`. `noreferrer`
   * implies `noopener` and keeps the capability in the path out of any `Referer`
   * header, and the explicit policy says it a second time so that editing the
   * `rel` cannot drop it in silence.
   *
   * What this cannot fix: the browser's own status bubble and address bar still
   * print the capability when the link is hovered or opened. That is a
   * recording-hygiene rule rather than something this markup decides.
   */
  it('sends no referrer from either link that carries the private address', () => {
    const tagOf = (html: string, testId: string) => {
      const at = html.indexOf(`data-testid="${testId}"`);
      expect(at, testId).toBeGreaterThan(-1);
      return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1).toLowerCase();
    };
    const opened = tagOf(
      draw({ status: 'ready', session: session({ status: 'ready' }), url: '/api/v1/preview/CAP/' }),
      'preview-open',
    );
    expect(opened).toContain('rel="noopener noreferrer"');
    expect(opened).toContain('referrerpolicy="no-referrer"');
    expect(opened).toContain('target="_blank"');
    // Lowercased by `tagOf`, which is how the frame's own assertion compares.
    expect(opened).toContain('/api/v1/preview/');
    // The same link also sits under the sentence a pane too short to frame an
    // app shows. That branch is drawn from a measured height, which no server
    // render reaches, so the shared link is rendered on its own here.
    for (const testId of ['preview-open', 'preview-too-short-open']) {
      const link = tagOf(
        renderToStaticMarkup(
          createElement(PreviewOpenLink, {
            apiUrl: 'http://localhost:4000',
            url: '/api/v1/preview/CAP/',
            testId,
            className: 'font-semibold text-accent',
            children: 'Open in a new tab',
          }),
        ),
        testId,
      );
      expect(link, testId).toContain('rel="noopener noreferrer"');
      expect(link, testId).toContain('referrerpolicy="no-referrer"');
      expect(link, testId).toContain('target="_blank"');
    }
  });
});

describe('ConsolePane', () => {
  const draw = (lines: PreviewLogLine[]) =>
    renderToStaticMarkup(createElement(ConsolePane, { lines }));

  it('says so rather than drawing an empty box before the app has printed anything', () => {
    const html = draw([]);
    expect(html).toContain('data-testid="console-pane"');
    expect(html).toContain('Your app has printed nothing yet.');
  });

  it('draws stderr apart from stdout, newest last', () => {
    const html = draw([line('serving on 8000'), line('Traceback', 'err')]);
    expect(html.indexOf('serving on 8000')).toBeLessThan(html.indexOf('Traceback'));
    expect(html).toContain('data-stream="err"');
    expect(html).toMatch(/data-stream="err"[^>]*class="[^"]*text-fail/);
    expect(html).not.toMatch(/data-stream="out"[^>]*class="[^"]*text-fail/);
  });
});

/* ------------------------- what the API actually sends --------------------- */

describe('the shape that comes back', () => {
  /**
   * Nest serialises a `null` answer as an **empty body**, and `lib/api.ts`
   * reads a body it cannot parse back as `{}`, so "this learner has never
   * started anything" arrives at the panel as an object with no `status` in
   * it, which is neither idle nor any of the six states. Unhandled, the panel
   * draws its toolbar, its footer, and nothing in between.
   */
  it('treats an answer that is not a session as nothing running', () => {
    expect(paneState({} as unknown as PreviewSessionView)).toBe('idle');
    expect(paneState({ status: 'flying' } as unknown as PreviewSessionView)).toBe('idle');
  });

  it('normalises that empty body away before the panel ever sees it', async () => {
    const calls: string[] = [];
    const fetchMock = async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      } as unknown as Response;
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { previewApi } = await import('@/lib/api-preview');
      expect(await previewApi.status('p1', 7)).toBeNull();
      expect(calls[0]).toContain('/phases/p1/preview?cursor=7');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('never asks with a cursor that is not a whole number of lines', async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => null } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const { previewApi } = await import('@/lib/api-preview');
      await previewApi.status('p1', -4);
      await previewApi.status('p1', 2.7);
      expect(calls[0]).toContain('cursor=0');
      expect(calls[1]).toContain('cursor=2');
    } finally {
      globalThis.fetch = original;
    }
  });
});
