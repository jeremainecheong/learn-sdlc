/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_BOOT_SCRIPT,
  SIDEBAR_DEFAULT,
  SIDEBAR_EVENT,
  SIDEBAR_IDE_KEY,
  SIDEBAR_KEY,
  appliedSidebar,
  applySidebar,
  sidebarContext,
  storedSidebar,
} from '@/lib/sidebar';

/**
 * The sidebar width the learner chose, remembered per kind of room.
 *
 * The interesting part is the boot script: a string of ES5 that runs inline in
 * <head> before React exists, so the first paint is already the right width.
 * Nothing had ever executed it, and it is the one piece of this app where a
 * typo costs a visible jump on every page load. Here it is run for real,
 * against the same document it runs against in the browser.
 */

const boot = (pathname: string): void => {
  window.history.replaceState({}, '', pathname);
  document.documentElement.removeAttribute('data-sidebar');
  // The body is the module's own exported constant and nothing else (no
  // interpolation, no input) because running the exact string the <head>
  // runs is the whole point of these cases.
  // eslint-disable-next-line no-new-func
  new Function(SIDEBAR_BOOT_SCRIPT)();
};
const WORKSPACE_PATHS = ['', '/design', '/issue', '/interview', '/brief', '/pr', '/matrix', '/drill', '/change', '/solution']
  .map(suffix => `/workspace/abc${suffix}`);
const OTHER_PATHS = [
  '/dashboard', '/map', '/learn/requirements', '/workspace', '/workspace/',
  '/workspaces/abc', '/dashboard/workspace/abc', '/workspace/abc/not-a-view',
  '/workspace/abc/interview/more', '/workspace//brief', '/workspace/abc//issue',
];

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-sidebar');
});

describe('sidebarContext', () => {
  it('keeps every supported phase view in the same working context', () => {
    for (const path of WORKSPACE_PATHS) {
      expect(sidebarContext(path), path).toBe('ide');
      expect(sidebarContext(`${path}/`), `${path}/`).toBe('ide');
    }
  });

  it('does not match unknown, nested or unrelated app routes', () => {
    for (const path of OTHER_PATHS) expect(sidebarContext(path), path).toBe('doc');
    expect(sidebarContext(null)).toBe('doc');
    expect(sidebarContext(undefined)).toBe('doc');
  });
});

describe('the width that is remembered', () => {
  it('opens document and working pages retracted until the learner pins them', () => {
    expect(storedSidebar('doc')).toBe(SIDEBAR_DEFAULT.doc);
    expect(storedSidebar('ide')).toBe(SIDEBAR_DEFAULT.ide);
    expect(SIDEBAR_DEFAULT).toEqual({ doc: 'rail', ide: 'rail' });
  });

  it('reads each context from its own key', () => {
    window.localStorage.setItem(SIDEBAR_KEY, 'rail');
    window.localStorage.setItem(SIDEBAR_IDE_KEY, 'full');
    expect(storedSidebar('doc')).toBe('rail');
    expect(storedSidebar('ide')).toBe('full');
  });

  it('ignores a stored value that is not a width', () => {
    window.localStorage.setItem(SIDEBAR_KEY, 'enormous');
    expect(storedSidebar('doc')).toBe('rail');
  });

  it('falls back to the default when storage refuses to answer', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(storedSidebar('doc')).toBe('rail');
    vi.unstubAllGlobals();
  });
});

describe('applySidebar', () => {
  it('stamps the width on the document and remembers it for that context', () => {
    applySidebar('ide', 'full');
    expect(appliedSidebar()).toBe('full');
    expect(window.localStorage.getItem(SIDEBAR_IDE_KEY)).toBe('full');
    // The other context is untouched.
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBeNull();
  });

  it('restores a width without writing it, so one room never overwrites the other', () => {
    window.localStorage.setItem(SIDEBAR_KEY, 'full');
    applySidebar('ide', 'rail', false);
    expect(appliedSidebar()).toBe('rail');
    expect(window.localStorage.getItem(SIDEBAR_IDE_KEY)).toBeNull();
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe('full');
  });

  it('tells the rest of the page, so both readers follow one switch', () => {
    const heard = vi.fn();
    window.addEventListener(SIDEBAR_EVENT, heard as EventListener);
    applySidebar('doc', 'rail');
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toBe('rail');
    window.removeEventListener(SIDEBAR_EVENT, heard as EventListener);
  });

  it('says nothing is applied when the attribute is missing or nonsense', () => {
    expect(appliedSidebar()).toBeNull();
    document.documentElement.setAttribute('data-sidebar', 'medium');
    expect(appliedSidebar()).toBeNull();
  });
});

describe('the navigation column', () => {
  it('lights no entry for a route that only redirects, and Overview for the dashboard', async () => {
    const { navKeyFromPath } = await import('@/components/shell/Sidebar');
    expect(navKeyFromPath('/warmup')).toBeUndefined();
    expect(navKeyFromPath('/phases')).toBeUndefined();
    expect(navKeyFromPath('/dashboard')).toBe('home');
  });
});

describe('the boot script', () => {
  it('stamps the remembered width before anything else runs', () => {
    window.localStorage.setItem(SIDEBAR_KEY, 'rail');
    boot('/dashboard');
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('rail');
  });

  it('never switches the saved width while moving between workspace views', () => {
    for (const workspaceWidth of ['rail', 'full']) {
      const documentWidth = workspaceWidth === 'rail' ? 'full' : 'rail';
      window.localStorage.setItem(SIDEBAR_KEY, documentWidth);
      window.localStorage.setItem(SIDEBAR_IDE_KEY, workspaceWidth);
      for (const path of WORKSPACE_PATHS) {
        boot(path);
        expect(appliedSidebar(), path).toBe(workspaceWidth);
        boot(`${path}/`);
        expect(appliedSidebar(), `${path}/`).toBe(workspaceWidth);
      }
      expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe(documentWidth);
      expect(window.localStorage.getItem(SIDEBAR_IDE_KEY)).toBe(workspaceWidth);
    }
  });

  it('reads only the pathname when a workspace link carries a query or anchor', () => {
    window.localStorage.setItem(SIDEBAR_KEY, 'full');
    window.localStorage.setItem(SIDEBAR_IDE_KEY, 'rail');
    boot('/workspace/abc/interview?source=dashboard#composer');
    expect(appliedSidebar()).toBe('rail');
    expect(sidebarContext(window.location.pathname)).toBe('ide');
  });

  it('agrees with sidebarContext about which routes are working pages', () => {
    window.localStorage.setItem(SIDEBAR_KEY, 'rail');
    window.localStorage.setItem(SIDEBAR_IDE_KEY, 'full');
    for (const path of [...WORKSPACE_PATHS, ...OTHER_PATHS]) {
      boot(path);
      const expected = sidebarContext(path) === 'ide' ? 'full' : 'rail';
      expect(document.documentElement.getAttribute('data-sidebar'), path).toBe(expected);
    }
  });

  it('falls back to each context’s default when nothing is stored', () => {
    boot('/dashboard');
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('rail');
    boot('/workspace/abc');
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('rail');
  });

  it('ignores a stored value that is not a width', () => {
    window.localStorage.setItem(SIDEBAR_KEY, 'null');
    boot('/dashboard');
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('rail');
  });

  it('leaves the page alone rather than throwing where storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(() => boot('/dashboard')).not.toThrow();
    vi.unstubAllGlobals();
  });
});
