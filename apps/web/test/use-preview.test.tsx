// @vitest-environment jsdom
/**
 * The preview hook, driven by hand.
 *
 * `preview.test.ts` covers everything in this feature that is a pure function.
 * What is left is the part that cannot be: two requests in flight at once, and
 * which of their answers the panel is allowed to believe. That race is hard
 * to see in a browser, so it is pinned here, where it costs a second to check.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewSessionView } from '@learnsdlc/shared';

const start = vi.fn();
const status = vi.fn();
const stop = vi.fn();

vi.mock('@/lib/api-preview', () => ({
  previewApi: {
    start: (...a: unknown[]) => start(...a),
    status: (...a: unknown[]) => status(...a),
    stop: (...a: unknown[]) => stop(...a),
  },
  stopPreviewOnExit: () => {},
}));

const { usePreview } = await import('@/components/workspace/usePreview');
type Controller = ReturnType<typeof usePreview>;

const NOW = '2026-03-04T10:00:00.000Z';

function session(over: Partial<PreviewSessionView> = {}): PreviewSessionView {
  return {
    id: 's1',
    phaseStateId: 'p1',
    status: 'ready',
    url: null,
    bundleOk: true,
    message: null,
    stopReason: null,
    startedAt: NOW,
    readyAt: NOW,
    expiresAt: '2026-03-04T10:10:00.000Z',
    idleExpiresAt: '2026-03-04T10:05:00.000Z',
    bytesServed: 0,
    console: [],
    cursor: 0,
    ...over,
  };
}

/** A promise somebody else decides the end of. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let held: Controller | null = null;

function render(props: Parameters<typeof usePreview>[0]): void {
  function Probe(p: Parameters<typeof usePreview>[0]) {
    held = usePreview(p);
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<Probe {...props} />);
  });
}

beforeEach(() => {
  held = null;
  start.mockReset();
  status.mockReset();
  stop.mockReset();
  status.mockResolvedValue(null);
});

afterEach(() => {
  // Here rather than only in the one test that installs them: a failed
  // assertion there would skip its own restore, and the next test to be
  // written after it would wait on a clock that never moves.
  vi.useRealTimers();
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe('usePreview', () => {
  it('starts idle, and asks once on arrival in case an app is already running', async () => {
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    expect(held!.status).toBe('idle');
    expect(status).toHaveBeenCalledWith('p1', 0);
  });

  it('retains the actual ready state after reload without inventing a private link', async () => {
    status.mockResolvedValue(session({ status: 'ready' }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    expect(held!.status).toBe('ready');
    expect(held!.url).toBeNull();
  });

  it('holds the url the start answered, because no later answer repeats it', async () => {
    start.mockResolvedValue(session({ status: 'starting', url: '/api/v1/preview/CAP/' }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    await act(async () => {
      await held!.start();
    });
    expect(held!.url).toBe('/api/v1/preview/CAP/');

    // A poll never carries it, and the panel must not lose it because of that.
    status.mockResolvedValue(session({ status: 'ready', url: null }));
    await act(async () => {
      await status.mock.results[0]?.value;
    });
    expect(held!.url).toBe('/api/v1/preview/CAP/');
  });

  it('drops a previous private link when another tab replaces the session, without guessing the new link', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    start.mockResolvedValue(session({ id: 's1', url: '/api/v1/preview/OLD/' }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    await act(async () => { await held!.start(); });
    status.mockResolvedValue(session({ id: 's1', url: null }));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(held!.url).toBe('/api/v1/preview/OLD/');
    status.mockResolvedValue(session({ id: 's2', url: null }));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(held!.status).toBe('ready');
    expect(held!.session?.id).toBe('s2');
    expect(held!.url).toBeNull();
    vi.restoreAllMocks();
  });

  it('reloads a changed session console from zero even when its cursor exceeds the previous cursor', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const oldLine = { stream: 'err' as const, text: 'Previous app traceback', at: NOW };
    const firstLine = { stream: 'out' as const, text: 'New app booted', at: NOW };
    const lastLine = { stream: 'out' as const, text: 'New app request', at: NOW };
    start.mockResolvedValue(session({ url: '/api/v1/preview/OLD/', console: [oldLine], cursor: 2 }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    await act(async () => { await held!.start(); });
    const fullConsole = deferred<PreviewSessionView | null>();
    status.mockResolvedValueOnce(session({ id: 's2', console: [lastLine], cursor: 5 }));
    status.mockReturnValueOnce(fullConsole.promise);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(status).toHaveBeenNthCalledWith(2, 'p1', 2);
    expect(status).toHaveBeenNthCalledWith(3, 'p1', 0);
    expect(held!.console).toEqual([]);
    expect(held!.url).toBeNull();
    await act(async () => {
      fullConsole.resolve(session({ id: 's2', console: [firstLine, lastLine], cursor: 5 }));
      await fullConsole.promise;
    });
    expect(held!.console).toEqual([firstLine, lastLine]);
    status.mockResolvedValueOnce(session({ id: 's2', console: [], cursor: 5 }));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(status).toHaveBeenLastCalledWith('p1', 5);
    expect(held!.console).toEqual([firstLine, lastLine]);
  });

  it('does not let a replacement console reload overwrite a newer start', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    start.mockResolvedValueOnce(session({ console: [{ stream: 'out', text: 'Old app', at: NOW }], cursor: 2 }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    await act(async () => { await held!.start(); });
    const fullConsole = deferred<PreviewSessionView | null>();
    status.mockResolvedValueOnce(session({ id: 's2', cursor: 5 }));
    status.mockReturnValueOnce(fullConsole.promise);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    const newestLine = { stream: 'out' as const, text: 'Newest app booted', at: NOW };
    start.mockResolvedValueOnce(session({ id: 's3', url: '/api/v1/preview/NEW/', console: [newestLine], cursor: 1 }));
    await act(async () => { await held!.start(); });
    await act(async () => {
      fullConsole.resolve(session({ id: 's2', console: [{ stream: 'out', text: 'Superseded app', at: NOW }], cursor: 5 }));
      await fullConsole.promise;
    });
    expect(held!.session?.id).toBe('s3');
    expect(held!.url).toBe('/api/v1/preview/NEW/');
    expect(held!.console).toEqual([newestLine]);
  });

  /**
   * The race, and the reason this file exists.
   *
   * A start stops the learner's previous session first, so a status poll that
   * was already in flight comes back saying `stopped`, reason `learner`. If the
   * panel believes it, it draws "You stopped the app." over an application that
   * is booting, and `pollIntervalMs('stopped')` is null, so nothing ever asks
   * again and the panel stays wrong until the page is reloaded (in Chrome,
   * a second press of Run app would leave the panel on `preview-stopped`).
   */
  it('does not let a poll that was in flight bury the start that overtook it', async () => {
    const inFlight = deferred<PreviewSessionView | null>();
    status.mockReturnValueOnce(inFlight.promise);
    render({ phaseId: 'p1', canPreview: true });

    start.mockResolvedValue(session({ status: 'starting', url: '/api/v1/preview/NEW/' }));
    await act(async () => {
      await held!.start();
    });
    expect(held!.status).toBe('starting');

    // Now the poll from before the press finally answers, about the session the
    // start itself stopped.
    await act(async () => {
      inFlight.resolve(session({ status: 'stopped', stopReason: 'learner' }));
      await inFlight.promise;
    });

    expect(held!.status).toBe('starting');
    expect(held!.url).toBe('/api/v1/preview/NEW/');
  });

  it('does not let a poll bury a Stop either', async () => {
    const inFlight = deferred<PreviewSessionView | null>();
    status.mockResolvedValueOnce(session({ status: 'ready' }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    expect(held!.status).toBe('ready');

    status.mockReturnValueOnce(inFlight.promise);
    stop.mockResolvedValue({ stopped: true });
    await act(async () => {
      await held!.stop();
    });
    expect(held!.status).toBe('stopped');

    await act(async () => {
      inFlight.resolve(session({ status: 'ready' }));
      await inFlight.promise;
    });
    expect(held!.status).toBe('stopped');
    expect(held!.session?.stopReason).toBe('learner');
  });

  it('drops the capability the moment the session is not one that can be opened', async () => {
    start.mockResolvedValue(session({ status: 'starting', url: '/api/v1/preview/CAP/' }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    await act(async () => {
      await held!.start();
    });
    expect(held!.url).toBe('/api/v1/preview/CAP/');

    stop.mockResolvedValue({ stopped: true });
    await act(async () => {
      await held!.stop();
    });
    // A frame pointing at a dead door and an "Open in a new tab" that lies.
    expect(held!.url).toBeNull();
  });

  it('keeps the last known app and private link on a failed Stop, then clears them only after confirmed retry', async () => {
    start.mockResolvedValue(session({ url: '/api/v1/preview/CAP/' }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    await act(async () => { await held!.start(); });
    stop.mockRejectedValueOnce(new Error('Network disconnected'));
    await act(async () => { await held!.stop(); });
    expect(held!.status).toBe('ready');
    expect(held!.url).toBe('/api/v1/preview/CAP/');
    expect(held!.error).toContain('could not be stopped');
    expect(held!.error).toContain('may still be running');
    stop.mockResolvedValueOnce({ stopped: true });
    await act(async () => { await held!.stop(); });
    expect(held!.status).toBe('stopped');
    expect(held!.url).toBeNull();
    expect(held!.error).toBe('');
  });

  it.each([{}, { stopped: false }, null])('does not claim stopped for an unconfirmed response %j', async answer => {
    status.mockResolvedValue(session({ status: 'ready' }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    stop.mockResolvedValue(answer);
    await act(async () => { await held!.stop(); });
    expect(held!.status).toBe('ready');
    expect(held!.error).toContain('could not be stopped');
  });

  it('clears failed-Stop guidance when a later status confirms the lost response had stopped the app', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    status.mockResolvedValue(session({ status: 'ready' }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    stop.mockRejectedValueOnce(new Error('Response lost'));
    await act(async () => { await held!.stop(); });
    expect(held!.error).toContain('could not be stopped');
    status.mockResolvedValueOnce(session({ status: 'stopped', stopReason: 'learner' }));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(held!.status).toBe('stopped');
    expect(held!.error).toBe('');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('asks nothing at all of a deployment that cannot preview', async () => {
    render({ phaseId: 'p1', canPreview: true, unsupported: 'lambda-runner' });
    await act(async () => {});
    expect(status).not.toHaveBeenCalled();
    expect(held!.status).toBe('unavailable');
  });

  it('asks nothing at all on a phase with no application to run', async () => {
    render({ phaseId: 'p1', canPreview: false });
    await act(async () => {});
    expect(status).not.toHaveBeenCalled();
    await act(async () => {
      await held!.start();
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('says the server’s own reason when it refused the start, rather than "try again"', async () => {
    const { ApiError } = await import('@/lib/api');
    start.mockRejectedValue(new ApiError(400, 'this phase has no app to run'));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    await act(async () => {
      await held!.start();
    });
    expect(held!.error).toBe('this phase has no app to run');
    expect(held!.error).not.toContain('Try again');
  });

  it('says so, once, when the start itself could not be made', async () => {
    start.mockRejectedValue(new Error('nope'));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    await act(async () => {
      await held!.start();
    });
    expect(held!.error).toContain('could not be started');
    expect(held!.status).toBe('idle');
  });

  /**
   * The wait a learner actually watches, rather than the cadence.
   *
   * Armed at the full two seconds, the first ask would leave a small app that
   * is already serving reading "Starting your app…" for two seconds of
   * nothing. The first ask is three quarters of a second; every ask
   * after it keeps the two-second cadence, which is what the API is owed.
   */
  it('asks for the status three quarters of a second after the app starts', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    start.mockResolvedValue(session({ status: 'starting' }));
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    await act(async () => {
      await held!.start();
    });
    expect(held!.status).toBe('starting');

    // From here on, only the poll asks, and the app is still booting when it does.
    status.mockClear();
    status.mockResolvedValue(session({ status: 'starting' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(status).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith('p1', 0);

    status.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('bumps the refresh nonce without asking the server anything', async () => {
    render({ phaseId: 'p1', canPreview: true });
    await act(async () => {});
    const before = held!.nonce;
    act(() => held!.refresh());
    expect(held!.nonce).toBe(before + 1);
    expect(status).toHaveBeenCalledTimes(1);
  });
});
