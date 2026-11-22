/**
 * How the session gets from the address bar into the page, and out of history.
 *
 * Single sign-on ends with a redirect to `/login/callback#token=<session>`. The
 * fragment is the safest place a redirect can carry a session (a fragment is
 * never sent to a server, so it reaches no access log), but it is still in the
 * document URL, and anything that quotes a URL quotes the session with it: a
 * failed subresource request, such as a manifest a cookie-authenticated proxy
 * refuses, puts the whole URL in the console entry for that failure.
 *
 * So the read and the scrub happen in an inline script in <head> (see
 * app/layout.tsx), which runs while the document is still parsing, before
 * React exists and before any of the page's own code runs. Whether that beats
 * the browser's own subresource requests is a browser's business and is not
 * claimed here, and it is why this page asks for no web manifest at all: React
 * emits that link above this script whatever order the layout writes them in,
 * and it would be the one request on the page made without the proxy's cookie,
 * so the page does not make it (see lib/manifest-link.tsx). What the
 * script buys is that nothing this page renders or reports can quote a URL that
 * still carries a session. The token is handed on in memory only:
 * {@link takeAuthHandoff} is the one way to collect it, it can be collected
 * once, and the URL it arrived on is published nowhere.
 *
 * The fallback matters as much as the script. Where the script never ran (a
 * client-side navigation, a unit run with no <head>, a browser that refused the
 * history write), the page reads the fragment itself.
 */

declare global {
  interface Window {
    /**
     * What the boot script took out of the address bar: the token alone, never
     * the URL it came in on. Deleted by the first {@link takeAuthHandoff}.
     */
    __lsdlcAuthHandoff?: { token: string; hash: boolean };
  }
}

/** The one path single sign-on redirects to, exactly as the API writes it. */
export const AUTH_HANDOFF_PATH = '/login/callback';

/**
 * Runs inline in <head> on every page, and returns immediately on all but one.
 *
 * Kept as a plain ES5 string for `dangerouslySetInnerHTML`, in the same shape
 * as the theme and sidebar boot scripts: no imports, no modern syntax, and the
 * whole body inside try/catch, because a throwing inline script is a page error
 * on every route and several browser suites fail on one.
 *
 * The order inside the try is deliberate. History is rewritten *before* the
 * token is published, so a browser that refuses the write leaves the fragment
 * in place for the page's own read rather than losing the session: a sign-in
 * that works matters more than a scrub that cannot happen. A fragment whose
 * escape sequence will not decode is left alone for the same reason: it cannot
 * be a session this API issued, and the page refuses it in its own words.
 *
 * The query survives the rewrite because the page still reads `next` from it;
 * the page's own `replaceState` is what drops the query a moment later.
 */
export const AUTH_HANDOFF_BOOT_SCRIPT =
  `(function(){try{` +
  `if(location.pathname!=='${AUTH_HANDOFF_PATH}')return;` +
  `var m=/[#&]token=([^&]+)/.exec(location.hash);` +
  `if(!m)return;` +
  `var t=decodeURIComponent(m[1]);` +
  `history.replaceState(null,'',location.pathname+location.search);` +
  `window.__lsdlcAuthHandoff={token:t,hash:true}` +
  `}catch(e){}})();`;

/**
 * The session this landing carried, taken once.
 *
 * Prefers what the boot script captured and deletes it on the way out, so a
 * second reader finds nothing. Where no script ran it reads the fragment the
 * same way the page always has, so nothing about which tokens are accepted
 * changes. This only reads: clearing the address bar is the page's own job,
 * and that is also what drops the query.
 */
export function takeAuthHandoff(): string | null {
  if (typeof window === 'undefined') return null;
  const handed = window.__lsdlcAuthHandoff;
  if (handed) {
    delete window.__lsdlcAuthHandoff;
    return handed.token || null;
  }
  return new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
}
