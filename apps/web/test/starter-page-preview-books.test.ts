/**
 * The starter's page preview shows books, and the Testing copy does not
 * count variants a project may not have.
 *
 * The preview reads `preview/sample-data.json` from the room's own files. The
 * starter ships one, locked, in its Implementation and Maintenance rooms, so
 * the page lists four books instead of "The shelf is empty.". The file is
 * part of the pack: a project uploaded from an older starter keeps the pack
 * it was uploaded with.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { buildPageBundle } from '@/components/workspace/preview/client/bundle';
import { PHASE_SPEC } from '@/components/phases/spec';
import { phaseMounts } from './support/pack-mounts';
import { repoPath } from './support/paths';
import { PREVIEW_RUNTIME as RUNTIME, runFrame, sucrase } from './support/preview-frame';

const STARTER = repoPath('apps/api/test/fixtures/upload-packs/starter');
const SAMPLE = 'preview/sample-data.json';

/** The room's visible files, as the phase detail carries them. */
function visible(phase: string): Record<string, string> {
  // the folder layout (spec 7.1): the room's files are the phase folder's files/ and readonly/
  return Object.fromEntries(phaseMounts(path.join(STARTER, 'phases', phase)).map((f) => [f.path, f.content]));
}

const lines = (doc: Document) => [...doc.querySelectorAll('li')].map((li) => li.textContent);

/** The four sample books, as the shelf page lists them. */
const SHELF = [
  'Emma — Jane Austen (1815)',
  'Kindred — Octavia E. Butler (1979)',
  'Middlemarch — George Eliot (1871)',
  'Persuasion — Jane Austen (1817) · on loan',
];

describe('the page preview has books', { timeout: 30_000 }, () => {
  it('the Implementation and Maintenance rooms carry the sample data, the same bytes', () => {
    const impl = visible('03-implementation');
    const maint = visible('06-maintenance');
    expect(typeof impl[SAMPLE]).toBe('string');
    expect(maint[SAMPLE]).toBe(impl[SAMPLE]);
    const books = JSON.parse(impl[SAMPLE])['/api/books'] as { on_loan_to: string | null }[];
    expect(books).toHaveLength(4);
    expect(books.filter((b) => b.on_loan_to)).toHaveLength(1);
  });

  it('Implementation, once the gaps are filled: main.ts fetches api/books and the page lists the four books in shelf order', async () => {
    const files = visible('03-implementation');
    files['web/src/lib/shelf.ts'] = readFileSync(path.join(STARTER, 'phases/03-implementation/solution/web/src/lib/shelf.ts'), 'utf8');
    const bundle = buildPageBundle(files, { transform: sucrase, runtime: RUNTIME, nonce: 'g1' });
    if (!bundle.ok) throw new Error(bundle.error);
    const { document: doc, messages } = await runFrame(bundle.srcdoc);
    expect(messages.filter((m) => m.type === 'error')).toEqual([]);
    // painted fires on the first text; the list is drawn after it
    await vi.waitFor(() => expect(lines(doc)).toEqual(SHELF));
    expect(doc.querySelector('main')?.textContent).not.toContain('The shelf is empty.');
  });

  it('Implementation as it opens: the books reach the page, so the open gap shows as an error, not as an empty shelf', async () => {
    const bundle = buildPageBundle(visible('03-implementation'), { transform: sucrase, runtime: RUNTIME, nonce: 'g2' });
    if (!bundle.ok) throw new Error(bundle.error);
    const { document: doc, messages } = await runFrame(bundle.srcdoc, { until: (m) => m.type === 'error' });
    expect(messages.find((m) => m.type === 'error')?.message).toMatch(/not implemented yet/);
    // the page threw on the open gap: no empty-shelf paragraph was drawn
    expect(doc.querySelector('main p')).toBeNull();
  });

  it('Maintenance: the page component is mounted with the books, in the order the room ships (title, then id)', async () => {
    const bundle = buildPageBundle(visible('06-maintenance'), { transform: sucrase, runtime: RUNTIME, nonce: 'g3' });
    if (!bundle.ok) throw new Error(bundle.error);
    const { document: doc, messages } = await runFrame(bundle.srcdoc);
    expect(messages.filter((m) => m.type === 'error')).toEqual([]);
    await vi.waitFor(() => expect(lines(doc)).toEqual(SHELF));
  });
});

describe('the Testing copy counts no variants', () => {
  it('says the planted bugs wait in the code without a number', () => {
    expect(PHASE_SPEC.testing.purpose).toBe(
      'Write one test per criterion and see it fail before it passes. Variants with planted bugs wait in the code; the QA lead asks which ones your tests catch.',
    );
    expect(PHASE_SPEC.testing.drawn.find((d) => d.title === 'Kill matrix')?.detail).toBe('Your tests against the planted bugs');
    const text = JSON.stringify(PHASE_SPEC.testing);
    expect(text).not.toMatch(/\b(eight|four|six|ten)\b[^.]*\b(variants|planted)/i);
  });
});
