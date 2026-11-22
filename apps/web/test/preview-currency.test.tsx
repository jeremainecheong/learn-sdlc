// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewSessionView, PreviewStatus } from '@learnsdlc/shared';
import { PreviewPanel } from '@/components/workspace/preview/PreviewPanel';
import { newestSave, previewCurrency, type PreviewBuildFields } from '@/components/workspace/preview/currency';
import {
  PREVIEW_EARLIER,
  PREVIEW_REBUILDING,
  PREVIEW_REBUILT,
  builtFromSentence,
  clockTime,
} from '@/components/workspace/preview/copy';

/*
 * After an Apply the running preview still serves the build it started with,
 * so the panel compares the save the app was built from with the current save,
 * says so when they differ, offers one Rebuild preview action that reports its
 * progress and its result, and names what the running app was built from.
 */

const FIRST = '2026-11-08T10:00:00.000Z';
const APPLIED = '2026-11-08T10:04:30.000Z';

type Session = PreviewSessionView & PreviewBuildFields;
const session = (over: Partial<Session> = {}): Session => ({
  id: 's1', phaseStateId: 'p1', status: 'ready', url: null, bundleOk: true, message: null, stopReason: null,
  startedAt: FIRST, readyAt: FIRST, expiresAt: '2099-01-01T00:00:00.000Z', idleExpiresAt: '2099-01-01T00:00:00.000Z',
  bytesServed: 0, console: [], cursor: 0, builtFromVersion: FIRST, workspaceVersion: FIRST, ...over,
});

describe('previewCurrency', () => {
  it('is current when the build is the newest save, earlier when a later save exists', () => {
    expect(previewCurrency(session())).toBe('current');
    expect(previewCurrency(session({ workspaceVersion: APPLIED }))).toBe('earlier');
    expect(previewCurrency(session(), APPLIED)).toBe('earlier');
    // The tab's own stamp older than the poll's is not newer news.
    expect(previewCurrency(session({ builtFromVersion: APPLIED, workspaceVersion: APPLIED }), FIRST)).toBe('current');
    expect(previewCurrency(session({ builtFromVersion: null, workspaceVersion: null }))).toBe('current');
    expect(previewCurrency(session({ builtFromVersion: null, workspaceVersion: FIRST }))).toBe('earlier');
  });

  it('makes no claim about a session that does not name its build', () => {
    expect(previewCurrency(null)).toBe('unknown');
    expect(previewCurrency(session({ builtFromVersion: undefined }), APPLIED)).toBe('unknown');
    expect(previewCurrency(session({ workspaceVersion: undefined }))).toBe('unknown');
  });

  it('takes the newer of two save stamps', () => {
    expect(newestSave(FIRST, APPLIED)).toBe(APPLIED);
    expect(newestSave(APPLIED, FIRST)).toBe(APPLIED);
    expect(newestSave(undefined, FIRST)).toBe(FIRST);
    expect(newestSave(undefined, undefined)).toBeUndefined();
  });

  it('names what the running app was built from', () => {
    expect(builtFromSentence(true, FIRST)).toBe('Built from the current save.');
    expect(builtFromSentence(false, FIRST)).toBe(`Built from your save at ${clockTime(FIRST)}.`);
    expect(builtFromSentence(false, null)).toBe('Built from the starting code.');
  });
});

describe('the panel', () => {
  let root: Root;
  let host: HTMLDivElement;
  const onStart = vi.fn();
  beforeEach(() => {
    onStart.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const draw = (over: { status?: PreviewStatus; session?: Session | null; url?: string | null; starting?: boolean; error?: string; savedVersion?: string | null; onOpenAppView?: () => void } = {}) =>
    act(() =>
      root.render(
        <PreviewPanel
          status={over.status ?? 'ready'}
          session={over.session === undefined ? session() : over.session}
          apiUrl="http://localhost:4000"
          url={over.url === undefined ? '/api/v1/preview/cap/' : over.url}
          nonce={0}
          errors={0}
          starting={over.starting ?? false}
          error={over.error ?? ''}
          unsupported={null}
          onStart={onStart}
          onStop={() => {}}
          onRefresh={() => {}}
          onOpenConsole={() => {}}
          savedVersion={over.savedVersion}
          onOpenAppView={over.onOpenAppView}
        />,
      ),
    );
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

  it('names a current build and raises nothing', () => {
    draw();
    expect(q('preview-built-from')?.textContent).toBe('Built from the current save.');
    expect(q('preview-stale')).toBeNull();
  });

  it('says the preview is on an earlier version, from the poll, with one Rebuild preview action', () => {
    draw({ session: session({ workspaceVersion: APPLIED }) });
    expect(q('preview-stale')?.textContent).toContain(PREVIEW_EARLIER);
    expect(q('preview-rebuild')?.textContent).toContain('Rebuild preview');
    expect(q('preview-built-from')?.textContent).toBe(`Built from your save at ${clockTime(FIRST)}.`);
  });

  it('notices a save from the tab before the next poll', () => {
    draw({ savedVersion: APPLIED });
    expect(q('preview-stale')?.textContent).toContain(PREVIEW_EARLIER);
  });

  it('says nothing about a session that does not name its build', () => {
    draw({ session: session({ builtFromVersion: undefined, workspaceVersion: APPLIED }) });
    expect(q('preview-stale')).toBeNull();
    expect(q('preview-built-from')).toBeNull();
  });

  it('rebuilds by one start, says it is rebuilding, then that the new app serves the current save', () => {
    draw({ session: session({ workspaceVersion: APPLIED }) });
    act(() => (q('preview-rebuild') as HTMLButtonElement).click());
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(q('preview-rebuilding')?.textContent).toBe(PREVIEW_REBUILDING);
    // The page saves, then starts: the old app keeps serving meanwhile.
    draw({ session: session({ workspaceVersion: APPLIED }), starting: true });
    expect(q('preview-rebuilding')?.textContent).toBe(PREVIEW_REBUILDING);
    expect(q('preview-stale')).toBeNull();
    // The start answers a new session, booting.
    draw({ status: 'starting', session: session({ id: 's2', status: 'starting', builtFromVersion: APPLIED, workspaceVersion: APPLIED }), url: '/api/v1/preview/cap2/' });
    expect(q('preview-starting')?.textContent).toContain(PREVIEW_REBUILDING);
    // Ready.
    draw({ session: session({ id: 's2', builtFromVersion: APPLIED, workspaceVersion: APPLIED }), url: '/api/v1/preview/cap2/' });
    expect(q('preview-rebuilt')?.textContent).toBe(PREVIEW_REBUILT);
    expect(q('preview-built-from')?.textContent).toBe('Built from the current save.');
    expect(q('preview-stale')).toBeNull();
  });

  it('puts the stale line back when the rebuild did not land, beside the error the page reports', () => {
    draw({ session: session({ workspaceVersion: APPLIED }) });
    act(() => (q('preview-rebuild') as HTMLButtonElement).click());
    draw({ session: session({ workspaceVersion: APPLIED }), starting: true });
    draw({ session: session({ workspaceVersion: APPLIED }), error: 'Your app could not be started. Try again in a moment.' });
    expect(q('preview-error')?.textContent).toContain('could not be started');
    expect(q('preview-stale')?.textContent).toContain(PREVIEW_EARLIER);
    expect(q('preview-rebuilt')).toBeNull();
  });

  it('offers the App preview view when the pane is too short to show the app', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 90 } as DOMRect);
    const open = vi.fn();
    draw({ onOpenAppView: open });
    expect(q('preview-too-short')?.textContent).toContain('This pane is too short to show your app.');
    act(() => (q('preview-too-short-app-view') as HTMLButtonElement).click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(q('preview-too-short-open')).not.toBeNull();
  });
});
