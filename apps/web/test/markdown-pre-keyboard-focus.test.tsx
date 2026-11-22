// @vitest-environment jsdom
/**
 * /teacher/guide at 390px must pass axe's `scrollable-region-focusable`
 * (WCAG 2.1 A) on the guide document's `<pre>`.
 *
 * `.prose-docs pre` is its own horizontal scroller (globals.css,
 * `overflow-x-auto`), and a code example wider than a phone column needs a
 * tab stop, or a keyboard cannot reach the lines past its edge. The guide
 * document itself holds no code example since the Requirements phase stopped
 * being authored from a stories file, so the page arm checks that whatever
 * it holds is reachable, and the Markdown arms prove the rule on a block. `components/Markdown.tsx` gives `pre` the same treatment as
 * `table`: it joins the tab order while it scrolls (`lib/scroll-focus.ts`),
 * and a block that fits adds no tab stop.
 *
 * jsdom lays nothing out, so "390px" is the geometry axe and the watcher read:
 * the `<pre>` is 640px of content in a 300px column. The first arm proves the
 * rule fires on exactly that geometry, so a green below is not a check that
 * sees nothing.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAxe } from './support/axe-bridge';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/teacher/guide',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', role: 'INSTRUCTOR', displayName: 'A Teacher' }),
}));

import { Markdown } from '@/components/Markdown';
import TeacherGuidePage from '@/app/(app)/teacher/guide/page';

let style: HTMLStyleElement;
let root: Root;
let host: HTMLDivElement;
const spies: { mockRestore: () => void }[] = [];

beforeEach(() => {
  style = document.createElement('style');
  // globals.css: `.prose-docs pre { overflow-x-auto }`; the bare `pre` rule is
  // the armed control's own scroller.
  style.textContent = '.prose-docs pre{overflow-x:auto}pre.control{overflow-x:auto}';
  document.head.appendChild(style);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  style.remove();
  while (spies.length) spies.pop()!.mockRestore();
});

const render = (node: ReactNode) => act(async () => root.render(node));

/** Lay every `<pre>` out as a 640px block in a 300px phone column (390px viewport). */
function phoneWidth(wide: boolean) {
  const isPre = (el: Element) => el.tagName === 'PRE';
  spies.push(
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return isPre(this) && wide ? 640 : 0;
    }),
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return isPre(this) && wide ? 300 : 0;
    }),
  );
}

async function scrollerFindings(): Promise<string[]> {
  const axe = await loadAxe();
  const result = await axe.run(host, { runOnly: { type: 'rule', values: ['scrollable-region-focusable'] } });
  return result.violations.map((one) => `${one.id}: ${one.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

describe('a Markdown <pre> that scrolls at phone width can be reached by the keyboard', () => {
  it('the check is armed: a scrolling <pre> with no tab stop is reported', async () => {
    phoneWidth(true);
    await render(
      <pre className="control">
        <code>{'x'.repeat(80)}</code>
      </pre>,
    );
    expect((await scrollerFindings()).join('\n')).toMatch(/^scrollable-region-focusable:/m);
  });

  it('/teacher/guide (the page file) at 390px: axe reports no unreachable scroller', async () => {
    phoneWidth(true);
    await render(<TeacherGuidePage />);
    host.querySelectorAll('details').forEach((one) => one.setAttribute('open', ''));
    expect(host.querySelector('.prose-docs'), 'the guide document is drawn').not.toBeNull();
    // The guide's one code block is the archive's folder tree under "The
    // folders are the list" (section 1, the folder layout); like every
    // Markdown code block it is a tab stop, so axe finds no unreachable
    // scroller. The next case proves a code block that scrolls joins the tab order.
    const blocks = [...host.querySelectorAll('.prose-docs pre')];
    expect(blocks).toHaveLength(1);
    for (const one of blocks) expect(one.getAttribute('tabindex')).toBe('0');
    expect(await scrollerFindings()).toEqual([]);
  });

  it('a Markdown code block that scrolls joins the tab order', async () => {
    phoneWidth(true);
    await render(<Markdown>{'Example:\n\n```\n' + 'a long line '.repeat(8) + '\n```\n'}</Markdown>);
    const pre = host.querySelector<HTMLElement>('.prose-docs pre');
    expect(pre, 'the markdown code block').not.toBeNull();
    expect(pre!.getAttribute('tabindex')).toBe('0');
    expect(await scrollerFindings()).toEqual([]);
  });

  it('a code block that fits adds no tab stop', async () => {
    phoneWidth(false);
    await render(<Markdown>{'```\nshort\n```\n'}</Markdown>);
    expect(host.querySelector('.prose-docs pre')!.hasAttribute('tabindex')).toBe(false);
  });

  it('the code inside is drawn as one <pre> and one <code> holding the same text', async () => {
    phoneWidth(false);
    await render(<Markdown>{'```js\nconst a = 1;\n```\n'}</Markdown>);
    const pre = host.querySelector('.prose-docs pre')!;
    expect(pre.children.length).toBe(1);
    expect(pre.firstElementChild!.tagName).toBe('CODE');
    expect(pre.firstElementChild!.className).toBe('language-js');
    expect(pre.textContent).toBe('const a = 1;\n');
    expect(pre.hasAttribute('node')).toBe(false);
  });
});
