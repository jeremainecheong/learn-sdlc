'use client';

/**
 * The learner's own application, framed.
 *
 * `sandbox` without `allow-same-origin` is the whole security posture of this
 * component: the document inside gets an opaque origin, so it cannot read this
 * page's storage, its token or its cookies, and the code it runs is the
 * learner's own on a door that only their session can open. It is also why the
 * pack's front end routes on the hash and keeps its state in its own API:
 * an opaque-origin document has neither storage nor `history.pushState`.
 *
 * Refresh is a nonce, in two places on purpose. It goes into the `src` so the
 * URL genuinely changes, and into the element's `key` so React replaces the
 * iframe rather than leaving the browser to decide whether the change is worth
 * a reload. One without the other is a refresh button that sometimes does
 * nothing.
 *
 * The frame is exactly as tall as the pane gives it. A fixed 420px floor would
 * put a scrollbar inside a scrollbar wherever the rail is shorter than that:
 * and draw nothing at all where the rail is shorter than the toolbar and the
 * footer together. The only floor is the one below which the panel says so
 * instead.
 *
 * The nonce is a **query parameter and never the hash**, and that is not a
 * detail. The pack's front end routes on the hash, it has to, because a
 * document with an opaque origin cannot rely on `history.pushState`, so
 * `#1` is a *route*, and the router answers it with "No such page": in Chrome
 * a hash nonce lets the app boot and draw its header, then render
 * `data-testid="not-found"` under it. The door ignores the query (it
 * reads Express's path, which excludes it) and serves the same document.
 */
import { FRAME_TITLE } from './copy';

export function PreviewFrame({
  /** The API's origin: the door is served by the API, not by this app. */
  apiUrl,
  /** `/api/v1/preview/<capability>/`, exactly as the start answered it. */
  url,
  nonce,
}: {
  apiUrl: string;
  url: string;
  nonce: number;
}) {
  const src = `${apiUrl}${url}?r=${nonce}`;
  return (
    <iframe
      key={nonce}
      data-testid="preview-frame"
      title={FRAME_TITLE}
      src={src}
      sandbox="allow-scripts allow-forms allow-modals"
      referrerPolicy="no-referrer"
      className="h-full min-h-[180px] w-full border-0 bg-surface"
    />
  );
}
