/**
 * Which file a page preview starts from.
 *
 * An .html file first, else main.(tsx|ts|jsx|js), else index.* under a web
 * src folder, else a page component (`*Page.*` or `App.*`). Tests, type
 * declarations and server code are never an entry.
 */
import { describe, expect, it } from 'vitest';
import { hasPagePreview, resolvePageEntry } from '@/components/workspace/preview/client/entry';

const map = (...paths: string[]) => Object.fromEntries(paths.map((p) => [p, '']));

describe('entry resolution', () => {
  it('prefers an html file, and runs the main module beside it', () => {
    const entry = resolvePageEntry(map('web/index.html', 'web/src/main.tsx', 'web/src/router.tsx'));
    expect(entry).toEqual({ html: 'web/index.html', module: 'web/src/main.tsx', component: null });
  });

  it('runs a module the html names when it is one of the files', () => {
    const files = { 'site/index.html': '<div id="app"></div><script type="module" src="./boot.js"></script>', 'site/boot.js': '' };
    expect(resolvePageEntry(files)).toEqual({ html: 'site/index.html', module: 'site/boot.js', component: null });
  });

  it('takes main.* when there is no html', () => {
    expect(resolvePageEntry(map('web/src/lib/shelf.ts', 'web/src/ShelfPage.ts', 'web/src/main.ts'))).toEqual({ html: null, module: 'web/src/main.ts', component: null });
    expect(resolvePageEntry(map('web/src/main.jsx'))?.module).toBe('web/src/main.jsx');
  });

  it('takes index.* under a src folder when there is no main', () => {
    expect(resolvePageEntry(map('frontend/src/index.tsx', 'frontend/src/App.tsx'))?.module).toBe('frontend/src/index.tsx');
  });

  it('mounts a page component when nothing else starts the page', () => {
    expect(resolvePageEntry(map('web/src/lib/shelf.ts', 'web/src/ShelfPage.ts'))).toEqual({ html: null, module: null, component: 'web/src/ShelfPage.ts' });
  });

  it('finds no page in a library, its tests, or server code', () => {
    expect(resolvePageEntry(map('web/src/lib/shelf.ts', 'web/src/lib/acceptance.test.ts'))).toBeNull();
    expect(resolvePageEntry(map('web/serve.js'))).toBeNull();
    expect(resolvePageEntry(map('api/main.py', 'api/index.js', 'server/main.ts'))).toBeNull();
    expect(resolvePageEntry(map('web/src/main.test.ts', 'web/src/types.d.ts'))).toBeNull();
    expect(hasPagePreview(['requirements/story.json'])).toBe(false);
    expect(hasPagePreview(['web/src/main.ts'])).toBe(true);
  });
});
