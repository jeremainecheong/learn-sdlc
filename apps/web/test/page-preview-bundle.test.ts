/**
 * The starter's page, bundled and run.
 *
 * The visible web files of the starter's implementation room (main.ts,
 * ShelfPage.ts and lib/shelf.ts with the learner's gaps still in it) are
 * transpiled with sucrase, wrapped in the page preview's CommonJS loader and
 * run in a DOM with the same React runtime asset the frame loads. The shelf
 * page has to draw, with `api/books` answered by the fetch shim and nothing
 * fetched from a network.
 */
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { buildPageBundle, pagePreviewCsp } from '@/components/workspace/preview/client/bundle';
import { PAGE_PREVIEW_LIMITS } from '@/components/workspace/preview/client/entry';
import { phaseMounts } from './support/pack-mounts';
import { repoPath } from './support/paths';
import { PREVIEW_RUNTIME as RUNTIME, runFrame, sucrase, type FrameMessage } from './support/preview-frame';

const STARTER = repoPath('apps/api/test/fixtures/upload-packs/starter');

/** The room's visible web files, as the phase detail carries them. */
function visible(phase: string): Record<string, string> {
  // the folder layout (spec 7.1): the room's files are the phase folder's files/ and readonly/
  return Object.fromEntries(phaseMounts(path.join(STARTER, 'phases', phase)).map((f) => [f.path, f.content]));
}

/**
 * Run a srcdoc the way the frame would. The runtime is already inlined: the
 * frame's origin is opaque, so a <script src> back to the app would go out
 * without the preview gate's cookie and be refused.
 */
async function run(srcdoc: string, until?: (m: FrameMessage) => boolean) {
  expect(srcdoc).not.toMatch(/<script[^>]*\ssrc=/i);
  return runFrame(srcdoc, { until });
}

describe('bundle', { timeout: 30_000 }, () => {
  it('draws the starter shelf page from main.ts and ShelfPage.ts, with api/books answered offline', async () => {
    const files = visible('03-implementation');
    // The starter ships preview/sample-data.json; without it the shim answers
    // api/books with [] and the page draws its empty state.
    delete files['preview/sample-data.json'];
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['web/src/main.ts', 'web/src/ShelfPage.ts', 'web/src/lib/shelf.ts']));
    const bundle = buildPageBundle(files, { transform: sucrase, runtime: RUNTIME, nonce: 'n1' });
    if (!bundle.ok) throw new Error(bundle.error);
    // Only page code goes into the frame: no Python, no tests.
    expect(bundle.srcdoc).not.toContain('api/shelf.py');
    expect(bundle.srcdoc).not.toContain('shelf.test.ts');
    const { document: doc, messages } = await run(bundle.srcdoc);
    expect(messages.filter((m) => m.type === 'error')).toEqual([]);
    expect(messages.some((m) => m.type === 'painted')).toBe(true);
    // painted fires on the first text; the page draws its heading and empty state after the offline answer
    await vi.waitFor(() => expect(doc.querySelector('h1')?.textContent).toBe('The shelf'));
    await vi.waitFor(() => expect(doc.body.textContent).toContain('The shelf is empty.'));
  });

  it('draws the reference implementation page (index.html + main.tsx, routed by the hash router shim)', async () => {
    const files = Object.fromEntries(phaseMounts(repoPath('content/tasktrackr/phases/03-implementation')).map((f) => [f.path, f.content]));
    const bundle = buildPageBundle(files, { transform: sucrase, runtime: RUNTIME, nonce: 'tt' });
    if (!bundle.ok) throw new Error(bundle.error);
    expect(bundle.entry).toEqual({ html: 'web/index.html', module: 'web/src/main.tsx', component: null });
    const { document: doc, messages } = await run(bundle.srcdoc);
    expect(messages.filter((m) => m.type === 'error')).toEqual([]);
    await vi.waitFor(() => expect(doc.querySelector('h1')?.textContent).toBe('Your lists'));
  });

  it('mounts the maintenance room page component with the sample books', async () => {
    const bundle = buildPageBundle(visible('06-maintenance'), { transform: sucrase, runtime: RUNTIME, nonce: 'n2' });
    if (!bundle.ok) throw new Error(bundle.error);
    const { document: doc, messages } = await run(bundle.srcdoc);
    expect(messages.filter((m) => m.type === 'error')).toEqual([]);
    await vi.waitFor(() => expect(doc.querySelector('h1')?.textContent).toBe('The shelf'));
  });

  it('answers api/* from preview/sample-data.json when the project has one', async () => {
    const files = { ...visible('03-implementation'), 'preview/sample-data.json': JSON.stringify({ '/api/books': [{ id: 1, title: 'Dune', author: 'Herbert', year: 1965, on_loan_to: null }] }) };
    // The learner's gaps are still open, so drawing a book shows their error as text.
    const bundle = buildPageBundle(files, { transform: sucrase, runtime: RUNTIME, nonce: 'n3' });
    if (!bundle.ok) throw new Error(bundle.error);
    const { messages } = await run(bundle.srcdoc, (m) => m.type === 'error');
    expect(messages.find((m) => m.type === 'error')?.message).toMatch(/not implemented yet/);
  });

  it('puts a no-network CSP in the document', () => {
    const bundle = buildPageBundle(visible('03-implementation'), { transform: sucrase, runtime: RUNTIME, nonce: 'n4' });
    if (!bundle.ok) throw new Error(bundle.error);
    const csp = pagePreviewCsp();
    expect(csp).toBe(`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`);
    expect(bundle.srcdoc).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp}">`);
    expect(csp).not.toMatch(/connect-src|https?:|preview-runtime/);
    // Nothing is loaded by URL: the runtime travels inside the document.
    expect(bundle.srcdoc).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(bundle.srcdoc).toContain('__learnsdlcPreviewRuntime');
  });

  it('names a module the preview cannot provide, and refuses oversized projects', () => {
    const bad = buildPageBundle({ 'web/src/main.ts': "import { x } from 'left-pad';\nconsole.log(x);" }, { transform: sucrase, runtime: RUNTIME, nonce: 'n5' });
    expect(bad.ok).toBe(true);
    const many = Object.fromEntries(Array.from({ length: PAGE_PREVIEW_LIMITS.files + 1 }, (_, i) => [`web/src/m${i}.ts`, '']));
    many['web/src/main.ts'] = '';
    const tooMany = buildPageBundle(many, { transform: sucrase, runtime: RUNTIME, nonce: 'n6' });
    expect(tooMany).toEqual({ ok: false, error: expect.stringMatching(/200 files/) });
    const big = buildPageBundle({ 'web/src/main.ts': 'x'.repeat(PAGE_PREVIEW_LIMITS.bytes + 1) }, { transform: sucrase, runtime: RUNTIME, nonce: 'n7' });
    expect(big).toEqual({ ok: false, error: expect.stringMatching(/2 MB/) });
  });

  it('reports a syntax error as text', () => {
    const broken = buildPageBundle({ 'web/src/main.ts': 'const = ;' }, { transform: sucrase, runtime: RUNTIME, nonce: 'n8' });
    expect(broken).toEqual({ ok: false, error: expect.stringContaining('web/src/main.ts') });
  });

  it('keeps learner code that holds <!-- and </script> working, even in a u-flag regex', async () => {
    const code = "const s = '<!-- </script> -->';\nconst ok = /<!--/u.test(s) && /<\\/script>/u.test(s);\ndocument.body.textContent = ok ? 'escaped fine' : 'mangled';";
    const bundle = buildPageBundle({ 'web/src/main.ts': code }, { transform: sucrase, runtime: RUNTIME, nonce: 'n10' });
    if (!bundle.ok) throw new Error(bundle.error);
    const { document: doc, messages } = await run(bundle.srcdoc);
    expect(messages.filter((m) => m.type === 'error')).toEqual([]);
    await vi.waitFor(() => expect(doc.body.textContent).toContain('escaped fine'));
  });

  it('reports an unknown package import at run time', async () => {
    const bundle = buildPageBundle({ 'web/src/main.ts': "import { x } from 'left-pad';\nconsole.log(x);" }, { transform: sucrase, runtime: RUNTIME, nonce: 'n9' });
    if (!bundle.ok) throw new Error(bundle.error);
    const { messages } = await run(bundle.srcdoc, (m) => m.type === 'error');
    expect(messages.find((m) => m.type === 'error')?.message).toMatch(/left-pad/);
  });
});
