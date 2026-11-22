/**
 * The one door from a web test to axe-core.
 *
 * The accessibility tests (teacher-guide-axe, teacher-guide-content's axe arms,
 * learner-preview-page) run axe-core over what a component draws. axe-core is a
 * devDependency of the monorepo's root package.json only, not of the web
 * package, so the web package never names it in an `import ... from`.
 *
 * It is loaded at run time instead. The specifier below is a variable, so
 * neither the type checker nor Vite's import analysis follows it; the tests run
 * in the monorepo, where the root node_modules holds axe-core, and they are
 * type checked against the minimal shapes declared here (the part of axe's
 * result the tests read, and the options they pass). Do not add axe-core to
 * apps/web/package.json instead: that changes the root lockfile.
 */

/** The options the tests pass to `axe.run`. */
export interface AxeRunOptions {
  runOnly?: { type: 'tag' | 'rule'; values: string[] };
  rules?: Record<string, { enabled: boolean }>;
}

/** One element a rule flagged: `target` is its selector path (a string per frame or shadow root). */
export interface AxeNodeResult {
  target: Array<string | string[]>;
}

/** One rule that failed, and every element it failed on. */
export interface AxeViolation {
  id: string;
  impact?: string | null;
  nodes: AxeNodeResult[];
}

export interface AxeResults {
  violations: AxeViolation[];
}

export interface Axe {
  run(context: Element | Document, options?: AxeRunOptions): Promise<AxeResults>;
}

/** A variable, not a literal: see the header. */
const AXE_CORE: string = 'axe-core';

let loaded: Promise<Axe> | undefined;

/**
 * axe-core, loaded once per test file. axe.js is a CommonJS bundle, so the
 * module namespace carries it as `default` (or as itself, by interop); either
 * way it must have `run`, or the test would pass on a check that ran nothing.
 */
export function loadAxe(): Promise<Axe> {
  loaded ??= (import(/* @vite-ignore */ AXE_CORE) as Promise<{ default?: unknown }>).then((mod) => {
    const axe = (mod.default ?? mod) as Partial<Axe> | undefined;
    if (!axe || typeof axe.run !== 'function') {
      throw new Error('axe-core loaded without a run function');
    }
    return axe as Axe;
  });
  return loaded;
}
