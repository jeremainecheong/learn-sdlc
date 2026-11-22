// @vitest-environment jsdom
/**
 * The generated preview runtime asset itself runs.
 *
 * The other rf-preview tests stub the runtime; this one evaluates the real
 * `public/preview-runtime/react-runtime.js` the frame inlines, so a loader
 * rename that broke react-dom's `__previewRequire("scheduler")` (or any other
 * wrapped module) fails here rather than in a learner's frame.
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { RUNTIME_FILE } from '@/components/workspace/preview/client/build-runtime.mjs';

type Runtime = { version: string; has(name: string): boolean; require(name: string): any };

describe('runtime asset runs', () => {
  it('loads React, react-dom/client and the router from its own loader and draws a page', () => {
    const win = window as unknown as { __learnsdlcPreviewRuntime?: Runtime };
    delete win.__learnsdlcPreviewRuntime;
    new Function(readFileSync(RUNTIME_FILE, 'utf8'))();
    const rt = win.__learnsdlcPreviewRuntime!;
    expect(rt.has('scheduler')).toBe(true);
    expect(rt.has('react/jsx-dev-runtime')).toBe(true);
    const React = rt.require('react');
    expect(rt.version).toBe(React.version);
    const { flushSync } = rt.require('react-dom');
    const { createRoot } = rt.require('react-dom/client');
    const { jsx } = rt.require('react/jsx-runtime');
    const router = rt.require('react-router-dom');
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const Shelf = () => jsx('main', { children: [jsx('h1', { children: 'The shelf' }, 'h'), jsx('p', { children: 'The shelf is empty.' }, 'p')] });
    const root = createRoot(mount);
    flushSync(() => root.render(React.createElement(router.RouterProvider, { router: router.createHashRouter([{ path: '/', element: React.createElement(Shelf) }]) })));
    expect(mount.querySelector('h1')?.textContent).toBe('The shelf');
    expect(mount.textContent).toContain('The shelf is empty.');
    flushSync(() => root.unmount());
    expect(() => rt.require('left-pad')).toThrow('The page preview runtime has no left-pad.');
  });
});
