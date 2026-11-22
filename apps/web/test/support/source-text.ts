/**
 * Product source read as text, for the few rules a render cannot show.
 *
 * Most facts about a page are asserted on what it renders. What is left for a
 * text read is where a call sits, what a module never names, or a stylesheet a
 * component imports for itself. Those reads go through these helpers so that
 * moving a component to another file, or splitting it into several, does not
 * turn a test red while the rule still holds:
 *
 * - {@link moduleOf} finds a module by what it exports, not by its path.
 * - {@link moduleText} is that one file's text. It is the right read for a
 *   rule that says what one file holds, where the same text in a module it
 *   imports would make a read through the import tree pass on the wrong file.
 *   For a rule that says what a page or component never contains, one file is
 *   not enough once that code is split into several modules: the text could
 *   come back in a split-off module unseen. Such a rule reads the whole import
 *   tree when nothing in it legitimately holds the text, or else every module
 *   the code is split into.
 * - {@link closureText} is the text of a module and of every module of the web
 *   app it imports, directly or not. It is the right read for a rule that says
 *   what a page never contains, and for one that says what it draws, because
 *   the text is still found after it moves into a new child module. A
 *   positive read through it proves something only while the text appears in
 *   one module of the tree; where it also appears in another, read the module
 *   that must hold it with moduleText.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { WEB_ROOT } from './paths';

export { WEB_ROOT };

/** The folders whose modules a page is built from. */
const SOURCE_ROOTS = ['app', 'components', 'lib'];
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];

/** A file under `apps/web`, by its path from there. */
export function webSource(path: string): string {
  return readFileSync(resolve(WEB_ROOT, path), 'utf8');
}

let sources: string[] | null = null;
/** Every product module of the web app, by its path from `apps/web`. */
export function productModules(): string[] {
  if (sources) return sources;
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name);
      if (statSync(at).isDirectory()) walk(at);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) found.push(relative(WEB_ROOT, at).split('\\').join('/'));
    }
  };
  for (const root of SOURCE_ROOTS) walk(resolve(WEB_ROOT, root));
  sources = found.sort();
  return sources;
}

/**
 * The one module that declares `name` as an export, by its path from `apps/web`.
 * `default` names a route's page, so a page is found by its path instead.
 */
export function moduleOf(name: string): string {
  const declares = new RegExp(
    `^export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|class|interface|type|enum)\\s+${name}\\b`,
    'm',
  );
  const hits = productModules().filter((path) => declares.test(webSource(path)));
  if (hits.length !== 1) throw new Error(`expected one module to export ${name}, found ${hits.length}: ${hits.join(', ')}`);
  return hits[0];
}

/** The text of one module, named by a path from `apps/web` or by a name it exports. */
export function moduleText(pathOrExport: string): string {
  return webSource(/[/.]/.test(pathOrExport) ? pathOrExport : moduleOf(pathOrExport));
}

/** Where an import specifier of `from` lands inside the web app, or null for a package or a stylesheet. */
function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = resolve(WEB_ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(WEB_ROOT, dirname(from), specifier);
  else return null;
  const candidates = [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => join(base, `index${ext}`))];
  const hit = candidates.find((one) => EXTENSIONS.some((ext) => one.endsWith(ext)) && existsSync(one) && statSync(one).isFile());
  return hit ? relative(WEB_ROOT, hit).split('\\').join('/') : null;
}

/**
 * The text of a module and of every web-app module it imports, directly or
 * not, each under a line naming its path. Packages and stylesheets are left
 * out. A module is named by its path from `apps/web` or by a name it exports.
 */
export function closureText(pathOrExport: string): string {
  const start = /[/.]/.test(pathOrExport) ? pathOrExport : moduleOf(pathOrExport);
  const seen = new Set<string>();
  const queue = [start];
  const parts: string[] = [];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = webSource(path);
    parts.push(`// ${path}\n${text}`);
    for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) {
      const next = resolveImport(path, match[1]);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return parts.join('\n');
}
