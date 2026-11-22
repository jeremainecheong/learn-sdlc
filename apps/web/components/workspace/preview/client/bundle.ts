/**
 * The page preview's document.
 *
 * The learner's visible web files are transpiled here, in the parent, with
 * sucrase (TypeScript, JSX, imports to CommonJS), and written into one srcdoc:
 *
 *  - a CSP meta with no network at all: scripts only inline, styles inline,
 *    images as data: URLs;
 *  - React and react-dom from the runtime asset (`public/preview-runtime`),
 *    fetched by the parent and written in inline. The frame's origin is
 *    opaque, so a `<script src>` back to the app would be a cross-site request
 *    without the preview gate's SameSite=Lax cookie, and the gate refuses it;
 *  - a `fetch` shim that answers `/api/*` and relative `api/*` from
 *    `preview/sample-data.json` when the project ships one, else GET with
 *    `[]` and every other method with 503 `{error:'preview_offline'}`;
 *  - a small CommonJS loader over the transpiled modules, and the start.
 *
 * The frame tells its parent two things by postMessage, tagged with a nonce:
 * that the page drew something (`painted`) and what went wrong (`error`).
 *
 * Only what the caller passes goes in: the room's visible files with the
 * learner's live buffers over them. Nothing hidden, canonical or sealed ever
 * reaches this function, because the phase detail never carries it.
 */
import type { Options } from 'sucrase';
import { PAGE_PREVIEW_LABEL, PAGE_PREVIEW_LABEL_NO_DATA, PAGE_PREVIEW_NO_PAGE, PAGE_PREVIEW_TOO_BIG, PAGE_PREVIEW_TOO_MANY, pagePreviewMissingPackage } from '../copy';
import { PAGE_PREVIEW_LIMITS, isPageScript, resolvePageEntry, type PageEntry } from './entry';

export const PREVIEW_RUNTIME_PATH = '/preview-runtime/react-runtime.js';
export const PAGE_PREVIEW_MESSAGE_SOURCE = 'learnsdlc-page-preview';
const SAMPLE_DATA = /(^|\/)preview\/sample-data\.json$/;

/**
 * The line above the frame. The frame's `fetch` answers the API
 * from `preview/sample-data.json` when the project ships one, and with nothing
 * otherwise. A page whose code calls `fetch` in a project with no sample data
 * therefore draws empty ("No lists yet."), and "with sample data" would not be
 * true of it: it reads {@link PAGE_PREVIEW_LABEL_NO_DATA}. Every other page (one that
 * holds its own data, as the Deadline badge pack's does, or a project that
 * ships sample data) reads {@link PAGE_PREVIEW_LABEL}.
 */
export function pagePreviewLabel(files: Record<string, string>): string {
  const paths = Object.keys(files);
  if (paths.some((p) => SAMPLE_DATA.test(p))) return PAGE_PREVIEW_LABEL;
  const asks = paths.some((p) => isPageScript(p) && /\bfetch\s*\(/.test(files[p] ?? ''));
  return asks ? PAGE_PREVIEW_LABEL_NO_DATA : PAGE_PREVIEW_LABEL;
}
const SERVER_ROOT = /^(api|server|backend|deploy|scripts|infra|tests?|canonical|solution|hidden_tests)\//;

export type PageTransform = (code: string, path: string) => string;
export type PageBundle = { ok: true; srcdoc: string; entry: PageEntry } | { ok: false; error: string };

/** The frame's own policy: nothing by URL. The parent's policy still applies on top of it. */
export function pagePreviewCsp(): string {
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`;
}

/**
 * The runtime's text, fetched by the parent: same origin, so the gate's cookie
 * goes with it. Fetched once per page load; a failure is forgotten, so the
 * next preview tries again.
 */
let runtimeText: Promise<string> | null = null;
export function fetchPreviewRuntime(): Promise<string> {
  runtimeText ??= fetch(PREVIEW_RUNTIME_PATH, { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error('The page preview runtime did not load.');
      return r.text();
    })
    .catch((e: unknown) => {
      runtimeText = null;
      throw e instanceof Error && e.message === 'The page preview runtime did not load.' ? e : new Error('The page preview runtime did not load.');
    });
  return runtimeText;
}

/** sucrase options per file: JSX only where the extension allows it (`<T>x` is a cast in .ts). */
export function transformOptionsFor(path: string): Options {
  const ts = /\.tsx?$/.test(path);
  const jsx = !/\.ts$/.test(path);
  return {
    transforms: [...(ts ? (['typescript'] as const) : []), ...(jsx ? (['jsx'] as const) : []), 'imports'],
    jsxRuntime: 'automatic',
    production: true,
    filePath: path,
  };
}

/**
 * Text that sits inside an inline <script> and cannot close it. `<\/` and
 * `\x21` mean the same inside a string, a template or a regex (u flag too).
 */
const scriptSafe = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\x21--');
/** JSON that sits inside an inline <script>. */
const jsonSafe = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

function isBundled(path: string): boolean {
  if (isPageScript(path)) return true;
  return /\.(css|json)$/.test(path) && !SERVER_ROOT.test(path) && !SAMPLE_DATA.test(path);
}

/** The html file's head styles and body, scripts removed (the module runs from the loader). */
function htmlParts(html: string): { head: string; body: string } {
  const noScripts = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  const styles = [...noScripts.matchAll(/<style\b[\s\S]*?<\/style\s*>/gi)].map((m) => m[0]).join('\n');
  const title = noScripts.match(/<title\b[\s\S]*?<\/title\s*>/i)?.[0] ?? '';
  const body = noScripts.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i)?.[1] ?? noScripts.replace(/<head\b[\s\S]*?<\/head\s*>/i, '').replace(/<\/?(html|body|!doctype)[^>]*>/gi, '');
  return { head: `${title}\n${styles}`, body };
}

const missing = pagePreviewMissingPackage('\u0000').split('\u0000');

/**
 * Runs inside the frame. ES5 on purpose: it is written into the document as
 * text, never compiled, and must run in whatever the learner's browser is.
 */
const LOADER = `
var __post = function (type, message) {
  try { parent.postMessage({ source: ${jsonSafe(PAGE_PREVIEW_MESSAGE_SOURCE)}, nonce: __nonce, type: type, message: message }, '*'); } catch (e) {}
};
var __text = function (e) { return e && e.message ? String(e.message) : String(e); };
window.addEventListener('error', function (e) { __post('error', e && e.error ? __text(e.error) : (e && e.message) || 'Script error'); });
window.addEventListener('unhandledrejection', function (e) { __post('error', __text(e && e.reason)); });
if (typeof window.reportError === 'function') {
  var __report = window.reportError;
  window.reportError = function (e) { __post('error', __text(e)); return __report.apply(window, arguments); };
}
(function () {
  var original = console.error;
  console.error = function () {
    var first = arguments[0];
    if (first instanceof Error) __post('error', __text(first));
    return original && original.apply(console, arguments);
  };
})();
var process = { env: { NODE_ENV: 'production' } };
(function () {
  function body(value) { return JSON.stringify(value === undefined ? null : value); }
  function respond(status, value) {
    var text = body(value);
    if (typeof Response === 'function') return new Response(text, { status: status, headers: { 'content-type': 'application/json' } });
    return { ok: status >= 200 && status < 300, status: status, headers: { get: function (h) { return String(h).toLowerCase() === 'content-type' ? 'application/json' : null; } },
      json: function () { return Promise.resolve(JSON.parse(text)); }, text: function () { return Promise.resolve(text); } };
  }
  function apiPath(input) {
    var url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    var m = String(url).match(/^(?:[a-z][a-z0-9+.-]*:\\/\\/[^\\/]+)?(?:\\.?\\/)?(?:[^?#]*?\\/)?(api\\/[^?#]*)/i);
    return m ? '/' + m[1].replace(/\\/+$/, '') : null;
  }
  window.fetch = function (input, init) {
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var path = apiPath(input);
    if (path && method === 'GET') {
      var data = __sample && Object.prototype.hasOwnProperty.call(__sample, path) ? __sample[path]
        : __sample && Object.prototype.hasOwnProperty.call(__sample, 'GET ' + path) ? __sample['GET ' + path] : [];
      return Promise.resolve(respond(200, data));
    }
    return Promise.resolve(respond(503, { error: 'preview_offline' }));
  };
})();
var __load = (function () {
  var cache = {};
  var rt = window.__learnsdlcPreviewRuntime;
  var exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
  function dir(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function join(folder, ref) {
    var out = [], parts = ((ref.charAt(0) === '/' ? '' : folder) + '/' + ref).split('/');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === '.') continue;
      if (parts[i] === '..') out.pop(); else out.push(parts[i]);
    }
    return out.join('/');
  }
  function resolve(from, spec) {
    var base = join(dir(from), spec);
    var tries = exts.map(function (x) { return base + x; });
    if (/\\.js$/.test(base)) tries.push(base.replace(/\\.js$/, '.ts'), base.replace(/\\.js$/, '.tsx'));
    for (var i = 0; i < tries.length; i++) if (Object.prototype.hasOwnProperty.call(__defs, tries[i])) return tries[i];
    throw new Error('Cannot find ' + spec + ' from ' + from + ' among the files this room shows.');
  }
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var module = { exports: {} };
    cache[id] = module;
    __defs[id].call(module.exports, function (spec) { return req(id, spec); }, module, module.exports);
    return module.exports;
  }
  function req(from, spec) {
    if (spec.charAt(0) === '.' || spec.charAt(0) === '/') return load(resolve(from, spec));
    if (rt && rt.has(spec)) return rt.require(spec);
    throw new Error(${jsonSafe(missing[0])} + spec + ${jsonSafe(missing[1])});
  }
  return load;
})();
var __watch = function () {
  var done = false;
  function drawn() {
    var b = document.body;
    if (!b) return false;
    if (b.textContent && b.textContent.replace(/\\s+/g, '')) return true;
    return !!b.querySelector('img,svg,canvas,input,button,select,textarea,video');
  }
  function check() {
    if (done || !drawn()) return;
    done = true;
    __post('painted');
    if (observer) observer.disconnect();
  }
  var observer = typeof MutationObserver === 'function' ? new MutationObserver(check) : null;
  if (observer) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  check();
  setTimeout(check, 0);
};
`;

/** Mounts a page component with sample data, for a room with no entry module. */
function componentStart(id: string): string {
  return `
var __mod = __load(${jsonSafe(id)});
var __C = __mod && __mod.default;
if (typeof __C !== 'function') {
  for (var __k in __mod) { if (typeof __mod[__k] === 'function' && /(Page|^App)$/.test(__k)) { __C = __mod[__k]; break; } }
}
if (typeof __C !== 'function') throw new Error(${jsonSafe(`${id} exports no page component to draw.`)});
var __React = window.__learnsdlcPreviewRuntime.require('react');
var __props = {};
if (__sample) for (var __p in __sample) {
  var __name = __p.replace(/^GET /, '').split('/').filter(Boolean).pop();
  if (__name) __props[__name] = __sample[__p];
}
var __proxy = typeof Proxy === 'function'
  ? new Proxy(__props, { get: function (t, k) { return typeof k === 'string' && !(k in t) && k !== 'then' ? [] : t[k]; } })
  : __props;
var __mount = document.getElementById('root') || document.body.appendChild(document.createElement('div'));
var __element = __C.prototype && __C.prototype.isReactComponent
  ? __React.createElement(__C, __props)
  : __React.createElement(function PagePreview() { return __C(__proxy); });
window.__learnsdlcPreviewRuntime.require('react-dom/client').createRoot(__mount).render(__element);
`;
}

export function buildPageBundle(
  files: Record<string, string>,
  { transform, runtime, nonce }: { transform: PageTransform; runtime: string; nonce: string },
): PageBundle {
  const entry = resolvePageEntry(files);
  if (!entry) return { ok: false, error: PAGE_PREVIEW_NO_PAGE };
  const paths = Object.keys(files).filter(isBundled).sort();
  if (paths.length > PAGE_PREVIEW_LIMITS.files) return { ok: false, error: PAGE_PREVIEW_TOO_MANY };
  const bytes = paths.reduce((n, p) => n + (files[p]?.length ?? 0), 0) + (entry.html ? files[entry.html].length : 0);
  if (bytes > PAGE_PREVIEW_LIMITS.bytes) return { ok: false, error: PAGE_PREVIEW_TOO_BIG };

  const defs: string[] = [];
  for (const path of paths) {
    const source = files[path] ?? '';
    let code: string;
    if (path.endsWith('.css')) {
      code = `var s = document.createElement('style'); s.textContent = ${jsonSafe(source)}; document.head.appendChild(s); module.exports = {};`;
    } else if (path.endsWith('.json')) {
      try {
        code = `module.exports = ${jsonSafe(JSON.parse(source || 'null'))};`;
      } catch (e) {
        code = `throw new Error(${jsonSafe(`${path}: ${(e as Error).message}`)});`;
      }
    } else {
      try {
        code = transform(source, path);
      } catch (e) {
        return { ok: false, error: `${path}: ${(e as Error).message}` };
      }
    }
    defs.push(`__defs[${jsonSafe(path)}] = function (require, module, exports) {\n${scriptSafe(code)}\n};`);
  }

  let sample: unknown = null;
  const samplePath = Object.keys(files).find((p) => SAMPLE_DATA.test(p));
  if (samplePath) {
    try {
      sample = JSON.parse(files[samplePath]);
    } catch {
      sample = null;
    }
  }

  const html = entry.html ? htmlParts(files[entry.html] ?? '') : { head: '', body: '<div id="root"></div>' };
  const start = entry.module ? `__load(${jsonSafe(entry.module)});` : entry.component ? componentStart(entry.component) : '';
  const csp = pagePreviewCsp();
  const srcdoc = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
${html.head}
</head>
<body>
${html.body}
<script>
${scriptSafe(runtime)}
</script>
<script>
var __nonce = ${jsonSafe(nonce)};
var __sample = ${jsonSafe(sample)};
var __defs = {};
${scriptSafe(LOADER)}
${defs.join('\n')}
__watch();
try {
  if (!window.__learnsdlcPreviewRuntime) throw new Error('The page preview runtime did not load.');
${start}
} catch (e) { __post('error', __text(e)); }
</script>
</body>
</html>`;
  return { ok: true, srcdoc, entry };
}
