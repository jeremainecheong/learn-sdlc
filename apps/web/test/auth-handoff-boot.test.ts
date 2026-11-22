// @vitest-environment jsdom
/**
 * Getting the session out of the address bar, first thing.
 *
 * Single sign-on hands the app its session in the URL fragment, which is the
 * safest place a redirect can carry it: a fragment is never sent to a server,
 * so it reaches no access log. It is still in the document URL, though, and
 * anything that quotes a URL quotes the session with it. The callback page used
 * to take it out in an effect, which is after hydration and after the document
 * has already asked for its subresources; one of those requests failed behind
 * the private preview gate and the console entry for it carried the whole URL.
 *
 * So the read and the scrub moved into an inline script in <head>, which runs
 * while the document is still parsing, before React exists and before any of
 * the page's own code can report a URL. These cases run the exact exported
 * string against a real document, the way test/sidebar.test.ts runs the
 * sidebar's.
 *
 * What they cannot prove: when the browser runs the script relative to the
 * manifest request. Only a browser shows that. What they do prove is that the
 * string scrubs when it runs, hands the token over in memory and never the URL,
 * leaves every other page alone, and cannot throw: a throwing inline script in
 * <head> is a page error on every route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_HANDOFF_BOOT_SCRIPT, AUTH_HANDOFF_PATH, takeAuthHandoff } from '@/lib/auth-handoff';

/** An obvious fake. No case here needs anything a real session would carry. */
const FAKE = 'fake-handoff-token';

const at = (url: string): void => {
  window.history.replaceState(null, '', url);
};

const boot = (): void => {
  // The body is the module's own exported constant and nothing else (no
  // interpolation, no input) because running the exact string the <head> runs
  // is the whole point of these cases.
  // eslint-disable-next-line no-new-func
  new Function(AUTH_HANDOFF_BOOT_SCRIPT)();
};

beforeEach(() => {
  delete window.__lsdlcAuthHandoff;
  at('/');
});

afterEach(() => {
  delete window.__lsdlcAuthHandoff;
  at('/');
});

describe('the callback boot script', () => {
  it('takes the token out of the address bar and hands it over in memory', () => {
    at(`${AUTH_HANDOFF_PATH}?next=%2Fprogress#token=${FAKE}`);

    boot();

    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('token=');
    // The page still reads `next` from the query, so the query survives here
    // and the page's own scrub is what finally drops it.
    expect(window.location.search).toBe('?next=%2Fprogress');
    expect(window.__lsdlcAuthHandoff).toEqual({ token: FAKE, hash: true });
    // Nothing anywhere is left holding the URL it arrived on.
    expect(window.history.state).toBeNull();
  });

  it('decodes the token it hands over', () => {
    at(`${AUTH_HANDOFF_PATH}#token=fake%2Ejwt%2Efake`);

    boot();

    expect(window.__lsdlcAuthHandoff?.token).toBe('fake.jwt.fake');
    expect(window.location.hash).toBe('');
  });

  it('finds the token in a fragment that carries more than one field', () => {
    at(`${AUTH_HANDOFF_PATH}#state=abc&token=${FAKE}`);

    boot();

    expect(window.__lsdlcAuthHandoff?.token).toBe(FAKE);
    expect(window.location.hash).toBe('');
  });

  it('leaves every other address bar alone', () => {
    for (const path of ['/login', '/dashboard', '/login/callback/more', '/Login/Callback']) {
      at(`${path}#token=${FAKE}`);

      boot();

      expect(window.location.hash, path).toBe(`#token=${FAKE}`);
      expect(window.__lsdlcAuthHandoff, path).toBeUndefined();
    }
  });

  it('rewrites no history entry when the callback carried no session', () => {
    for (const hash of ['', '#token', '#tokens=x', '#next=%2Fprogress']) {
      at(`${AUTH_HANDOFF_PATH}${hash}`);

      expect(() => boot(), hash).not.toThrow();

      expect(window.__lsdlcAuthHandoff, hash).toBeUndefined();
      expect(window.location.hash, hash).toBe(hash);
    }
  });

  it('never throws, whatever the document hands it', () => {
    // A fragment that is not a valid percent-escape: decoding it throws, and a
    // page error on the sign-in landing fails seven browser suites.
    for (const hash of ['#', '#token=', '#token=%', '#token=%E0%A4%A']) {
      at(`${AUTH_HANDOFF_PATH}${hash}`);

      expect(() => boot(), hash).not.toThrow();

      expect(window.__lsdlcAuthHandoff, hash).toBeUndefined();
    }
  });

  it('leaves the token where the page can still find it when history refuses', () => {
    at(`${AUTH_HANDOFF_PATH}#token=${FAKE}`);
    const refuse = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(() => boot()).not.toThrow();

    // Nothing was published, because the fragment is still there and the page's
    // own read is the fallback: a sign-in that works matters more than a scrub
    // that cannot happen.
    expect(window.__lsdlcAuthHandoff).toBeUndefined();
    expect(window.location.hash).toBe(`#token=${FAKE}`);
    refuse.mockRestore();
  });
});

describe('takeAuthHandoff', () => {
  it('hands the captured token over once and takes the global with it', () => {
    at(AUTH_HANDOFF_PATH);
    window.__lsdlcAuthHandoff = { token: FAKE, hash: true };

    expect(takeAuthHandoff()).toBe(FAKE);
    expect(window.__lsdlcAuthHandoff).toBeUndefined();
    // A second read finds nothing: the token lives in the page's own ref now.
    expect(takeAuthHandoff()).toBeNull();
  });

  it('falls back to the address bar where no script ran', () => {
    at(`${AUTH_HANDOFF_PATH}#token=${FAKE}`);

    expect(takeAuthHandoff()).toBe(FAKE);
    // A read, not a scrub: the page clears the address bar itself, and that is
    // what both browser suites assert on.
    expect(window.location.hash).toBe(`#token=${FAKE}`);
  });

  it('prefers what the script captured over whatever is in the address bar', () => {
    at(`${AUTH_HANDOFF_PATH}#token=stale-fragment-token`);
    window.__lsdlcAuthHandoff = { token: FAKE, hash: true };

    expect(takeAuthHandoff()).toBe(FAKE);
  });

  it('returns nothing when the landing carried no session at all', () => {
    at(`${AUTH_HANDOFF_PATH}?next=%2Fprogress`);

    expect(takeAuthHandoff()).toBeNull();
  });
});
