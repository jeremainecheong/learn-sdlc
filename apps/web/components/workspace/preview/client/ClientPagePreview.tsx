'use client';

/**
 * The page preview.
 *
 * The learner's visible page code, with their live buffers over it, run in a
 * sandboxed frame with sample data. It is how a student always sees a page:
 * an uploaded project has no sandbox preview, and a reference project on a
 * deployment that cannot run one falls back to this.
 *
 * Security posture, in one place:
 *  - `sandbox="allow-scripts"` and nothing else. Never `allow-same-origin`, so
 *    the document has an opaque origin and cannot read this app's storage,
 *    cookies or token; no forms, no popups, no top navigation.
 *  - `srcdoc`, never a URL, and a CSP inside with `default-src 'none'`: it
 *    loads nothing by URL (React is fetched here, by the parent, and written
 *    in inline) and may not connect anywhere (the `fetch` shim answers
 *    `api/*` locally).
 *  - messages from the frame are trusted only from this frame's own window
 *    and only with this build's nonce, and only ever drawn as text.
 *  - Open in a new tab: the link is a plain anchor to this app's own
 *    `/page-preview` route (`target="_blank" rel="noopener noreferrer"`, no
 *    referrer). The code goes over through this browser's localStorage
 *    (`handover.ts`), never in the address, and the tab draws it in this same
 *    frame with this same core (`usePagePreviewRun`, `PagePreviewBody`): no
 *    `allow-same-origin`, no `allow-popups`, no blob or data URL of learner
 *    code at the app's origin, no `document.write` into a same-origin window.
 *    The snapshot is drawn as code inside the frame and as nothing else.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  PAGE_PREVIEW_BUILDING,
  PAGE_PREVIEW_ERRORS,
  PAGE_PREVIEW_FRAME_TITLE,
  PAGE_PREVIEW_NO_PAGE,
  PAGE_PREVIEW_RELOAD,
  PAGE_PREVIEW_TIMEOUT,
  CONTROLS,
} from '../copy';
import { handoverHref, newHandoverId, stashHandover } from './handover';
import { PAGE_PREVIEW_MESSAGE_SOURCE, buildPageBundle, fetchPreviewRuntime, pagePreviewLabel, transformOptionsFor, type PageTransform } from './bundle';
import { PAGE_PREVIEW_LIMITS, resolvePageEntry } from './entry';

/** sucrase is loaded only when a page preview is drawn. */
export async function loadSucrase(): Promise<PageTransform> {
  const { transform } = await import('sucrase');
  return (code, path) => transform(code, transformOptionsFor(path)).code;
}

const REBUILD_AFTER_TYPING_MS = 700;
const MAX_ERRORS = 5;
/** Characters of one frame error kept for the list under the preview. */
const MAX_ERROR_CHARS = 500;

function freshNonce(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type RunOptions = {
  loadTransform?: () => Promise<PageTransform>;
  /** React for the frame, as text (fetched same-origin by the parent). */
  loadRuntime?: () => Promise<string>;
};

/**
 * The running core, shared by the workspace's panel and the tab of its own:
 * the tools, the bundle, the nonce, the message check, the 5 s clock and the
 * error list. A new snapshot is a new page.
 */
export function usePagePreviewRun(snapshot: Record<string, string>, { loadTransform = loadSucrase, loadRuntime = fetchPreviewRuntime }: RunOptions = {}) {
  const [tools, setTools] = useState<{ transform: PageTransform; runtime: string } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [nonce, setNonce] = useState(freshNonce);
  const [painted, setPainted] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([loadTransform(), loadRuntime()]).then(
      ([transform, runtime]) => live && setTools({ transform, runtime }),
      (e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [loadTransform, loadRuntime]);

  const restart = useCallback(() => {
    setNonce(freshNonce());
    setPainted(false);
    setTimedOut(false);
    setErrors([]);
  }, []);

  // A new snapshot is a new page: new nonce, fresh clock.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    restart();
  }, [snapshot, restart]);

  const hasPage = useMemo(() => resolvePageEntry(snapshot) !== null, [snapshot]);
  const bundle = useMemo(() => {
    if (!tools || !hasPage) return null;
    return buildPageBundle(snapshot, { transform: tools.transform, runtime: tools.runtime, nonce });
  }, [tools, hasPage, snapshot, nonce]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const own = frameRef.current?.contentWindow;
      if (!own || e.source !== own) return;
      const data = e.data as { source?: unknown; nonce?: unknown; type?: unknown; message?: unknown } | null;
      if (!data || data.source !== PAGE_PREVIEW_MESSAGE_SOURCE || data.nonce !== nonce) return;
      if (data.type === 'painted') setPainted(true);
      else if (data.type === 'error') {
        const text = String(data.message ?? '').slice(0, MAX_ERROR_CHARS);
        setErrors((list) => (list.includes(text) || list.length >= MAX_ERRORS ? list : [...list, text]));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [nonce]);

  const running = Boolean(bundle?.ok);
  useEffect(() => {
    if (!running || painted) return;
    const t = setTimeout(() => setTimedOut(true), PAGE_PREVIEW_LIMITS.paintMs);
    return () => clearTimeout(t);
  }, [running, painted, nonce]);

  return { hasPage, loadError, bundle, nonce, painted, timedOut, errors, restart, frameRef };
}

export type PagePreviewRun = ReturnType<typeof usePagePreviewRun>;

/** Everything under the header: no page, a load error, building, the problems and the frame. */
export function PagePreviewBody({ run }: { run: PagePreviewRun }) {
  const { hasPage, loadError, bundle, nonce, painted, timedOut, errors, restart, frameRef } = run;
  if (!hasPage) {
    return (
      <p className="purpose px-3.5 py-3" data-testid="page-preview-no-page">
        {PAGE_PREVIEW_NO_PAGE}
      </p>
    );
  }
  if (loadError) {
    return (
      <p role="alert" className="px-3.5 py-3 text-[12.5px] text-fail" data-testid="page-preview-error">
        {loadError}
      </p>
    );
  }
  if (!bundle) return <p className="purpose px-3.5 py-3">{PAGE_PREVIEW_BUILDING}</p>;
  if (!bundle.ok) {
    return (
      <p role="alert" className="wrap px-3.5 py-3 text-[12.5px] text-fail" data-testid="page-preview-error">
        {bundle.error}
      </p>
    );
  }
  return (
    <>
      {(timedOut && !painted) || errors.length > 0 ? (
        <div role="alert" className="shrink-0 border-b-1.5 border-edge bg-failtint px-3.5 py-2 text-[12.5px] text-ink" data-testid="page-preview-problems">
          {timedOut && !painted && (
            <p className="m-0" data-testid="page-preview-timeout">
              {PAGE_PREVIEW_TIMEOUT}{' '}
              <button type="button" className="font-semibold text-accent underline" onClick={restart}>
                {PAGE_PREVIEW_RELOAD}
              </button>
            </p>
          )}
          {errors.length > 0 && (
            <>
              <p className="m-0">{PAGE_PREVIEW_ERRORS}</p>
              <ul className="m-0 list-disc pl-5" data-testid="page-preview-errors">
                {errors.map((text) => (
                  <li key={text} className="wrap">
                    {text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
      <iframe
        key={nonce}
        ref={frameRef as RefObject<HTMLIFrameElement>}
        data-testid="page-preview-frame"
        data-nonce={nonce}
        title={PAGE_PREVIEW_FRAME_TITLE}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={bundle.srcdoc}
        className="min-h-[180px] w-full flex-1 border-0 bg-white"
      />
    </>
  );
}

/**
 * Open in a new tab: writes the code in the editor NOW for this preview's id,
 * on every way the link can be opened, then lets the browser follow the plain
 * anchor. "Now" is `liveFiles()` when the caller gives it (the editor's live
 * buffers, which reach `files` only at the 0.7 s autosave), otherwise the
 * `files` of the latest render; never the debounced snapshot. The workspace
 * itself is not touched.
 */
function PagePreviewOpenLink({ files, liveFiles }: { files: Record<string, string>; liveFiles?: () => Record<string, string> }) {
  const [id] = useState(newHandoverId);
  const latest = useRef(files);
  latest.current = files;
  const live = useRef(liveFiles);
  live.current = liveFiles;
  const stash = useCallback(() => {
    stashHandover(id, live.current?.() ?? latest.current);
  }, [id]);
  return (
    <a
      href={handoverHref(id)}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      className="btn-ghost btn-sm shrink-0"
      data-testid="page-preview-open"
      onPointerDown={stash}
      onKeyDown={(e) => {
        if (e.key === 'Enter') stash();
      }}
      onContextMenu={stash}
      onAuxClick={stash}
      onClick={stash}
    >
      {CONTROLS.open}
    </a>
  );
}

export function ClientPagePreview({
  files,
  liveFiles,
  notice,
  loadTransform = loadSucrase,
  loadRuntime = fetchPreviewRuntime,
}: {
  /** The room's visible files, the learner's live buffers over the server's copy. */
  files: Record<string, string>;
  /**
   * What the editor shows at this moment, read only when Open in a new tab is
   * pressed (keystrokes reach `files` at the autosave, up to 0.7 s later).
   */
  liveFiles?: () => Record<string, string>;
  /** A sentence above the label, e.g. why the reference app preview is not running here. */
  notice?: string | null;
} & RunOptions) {
  const [snapshot, setSnapshot] = useState(files);

  // Typing rebuilds the page, but not on every key.
  useEffect(() => {
    if (files === snapshot) return;
    const t = setTimeout(() => setSnapshot(files), REBUILD_AFTER_TYPING_MS);
    return () => clearTimeout(t);
  }, [files, snapshot]);

  const run = usePagePreviewRun(snapshot, { loadTransform, loadRuntime });
  // Read from the snapshot the frame draws, so the line and the page agree.
  const label = useMemo(() => pagePreviewLabel(snapshot), [snapshot]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="client-page-preview">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b-1.5 border-edge px-3.5 py-2">
        <p className="m-0 min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink2" data-testid="page-preview-label">
          {notice ? <span className="block text-muted">{notice}</span> : null}
          {label}
        </p>
        {run.hasPage && (
          <button type="button" className="btn-ghost btn-sm shrink-0" onClick={run.restart} data-testid="page-preview-reload">
            {PAGE_PREVIEW_RELOAD}
          </button>
        )}
        {run.hasPage && <PagePreviewOpenLink files={files} liveFiles={liveFiles} />}
      </div>
      <PagePreviewBody run={run} />
    </div>
  );
}
