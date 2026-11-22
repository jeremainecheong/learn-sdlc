/**
 * Where a page preview starts.
 *
 * The page preview runs the learner's visible web files in a sandboxed frame.
 * It needs one thing to start from, chosen in this order:
 *
 *  1. an .html file (its body is the page; a module it names, or the main
 *     module beside it, is run inside it);
 *  2. `main.(tsx|ts|jsx|js)`;
 *  3. `index.*` under a `src` folder;
 *  4. a page component, `*Page.*` or `App.*`, mounted with sample data.
 *
 * Tests, type declarations and anything under a server folder are never an
 * entry, so a room that only holds a library and its tests has no page.
 */

export const PAGE_PREVIEW_LIMITS = { files: 200, bytes: 2 * 1024 * 1024, paintMs: 5000 } as const;

export interface PageEntry {
  /** The html file whose body (and head styles) the frame uses, if any. */
  html: string | null;
  /** The module run first, if any. */
  module: string | null;
  /** A page component mounted with sample data when nothing else starts the page. */
  component: string | null;
}

const SCRIPT = /\.(tsx|ts|jsx|js|mjs|cjs)$/;
// Tests anywhere; server, deploy and sealed folders only at the top (web/src/api/client.ts is page code).
const NOT_PAGE = /(\.test\.|\.spec\.|\.d\.ts$|(^|\/)(__tests__|hidden_tests)\/|^(api|server|backend|deploy|scripts|infra|tests?|canonical|solution)\/)/;

/** Learner page code: a script that is not a test, a declaration or server code. */
export function isPageScript(path: string): boolean {
  return SCRIPT.test(path) && !NOT_PAGE.test(path);
}

function isPageHtml(path: string): boolean {
  return /\.html?$/.test(path) && !NOT_PAGE.test(path);
}

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dir = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const byDepth = (a: string, b: string) => a.split('/').length - b.split('/').length || a.localeCompare(b);

/** Join a relative reference onto a folder, resolving `.` and `..`. */
export function joinPath(folder: string, ref: string): string {
  const out: string[] = [];
  for (const part of `${ref.startsWith('/') ? '' : folder}/${ref}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function htmlScript(html: string, htmlPath: string, paths: Set<string>): string | null {
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const ref = match[1].split(/[?#]/)[0];
    if (/^[a-z]+:/i.test(ref)) continue;
    const here = joinPath(dir(htmlPath), ref);
    if (paths.has(here) && isPageScript(here)) return here;
    // `/src/main.tsx` in a Vite page means "from the page's own folder".
    const rooted = joinPath(dir(htmlPath), ref.replace(/^\//, ''));
    if (paths.has(rooted) && isPageScript(rooted)) return rooted;
  }
  return null;
}

function mainModule(paths: string[]): string | null {
  const scripts = paths.filter(isPageScript);
  const main = scripts.filter((p) => /^main\.(tsx|ts|jsx|js)$/.test(base(p))).sort(byDepth)[0];
  if (main) return main;
  const index = scripts.filter((p) => /(^|\/)src\//.test(p) && /^index\.(tsx|ts|jsx|js)$/.test(base(p))).sort(byDepth)[0];
  return index ?? null;
}

function pageComponent(paths: string[]): string | null {
  return paths.filter((p) => isPageScript(p) && /^(\w*Page|App)\.(tsx|ts|jsx|js)$/.test(base(p))).sort(byDepth)[0] ?? null;
}

/** The entry for a set of visible files (path to content), or null when they hold no page. */
export function resolvePageEntry(files: Record<string, string>): PageEntry | null {
  const paths = Object.keys(files);
  const set = new Set(paths);
  const html = paths.filter(isPageHtml).sort((a, b) => Number(base(b) === 'index.html') - Number(base(a) === 'index.html') || byDepth(a, b))[0] ?? null;
  if (html) {
    const named = htmlScript(files[html] ?? '', html, set);
    const module = named ?? mainModule(paths.filter((p) => p.startsWith(dir(html) ? `${dir(html)}/` : '')));
    return { html, module, component: module ? null : pageComponent(paths) };
  }
  const module = mainModule(paths);
  if (module) return { html: null, module, component: null };
  const component = pageComponent(paths);
  return component ? { html: null, module: null, component } : null;
}

/** Whether these paths hold a page to draw. Paths only: the summary view carries no content. */
export function hasPagePreview(paths: readonly string[]): boolean {
  return paths.some(isPageHtml) || mainModule([...paths]) !== null || pageComponent([...paths]) !== null;
}
