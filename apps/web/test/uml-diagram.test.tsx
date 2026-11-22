/**
 * The design's drawn UML, and the hook that writes the record.
 */
import { describe, expect, it } from 'vitest';
import { moduleText, productModules } from './support/source-text';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_DESIGN_FLOOR, EMPTY_DESIGN, serialiseDesign, type Design } from '@learnsdlc/shared';
import { RELATION_KINDS } from '@/components/workspace/panels/design/model';
import { UmlDiagram } from '@/components/workspace/panels/design/UmlDiagram';
import { useDesign, type DesignState } from '@/components/workspace/panels/design/useDesign';

const doc = (relations: Design['relations']): Design => ({
  ...EMPTY_DESIGN,
  entities: [
    { id: 'E1', name: 'Shelf', kind: 'component', attributes: [{ name: 'size', type: 'number' }], responsibilities: ['lend books'], satisfies: [] },
    { id: 'E2', name: 'Book', kind: 'class', attributes: [], responsibilities: [], satisfies: [] },
  ],
  relations,
});

describe('UmlDiagram', () => {
  it('draws three compartments and the stereotype of a non-class', () => {
    const html = renderToStaticMarkup(<UmlDiagram doc={doc([])} />);
    expect(html).toContain('data-testid="design-uml"');
    expect(html).toContain('«component»');
    expect(html).toContain('size: number');
    expect(html).toContain('lend books');
    expect(html).toContain('data-testid="design-uml-box-E1"');
    expect(html).toContain('data-testid="design-uml-box-E2"');
  });

  for (const kind of RELATION_KINDS) {
    it(`draws the ${kind} marker`, () => {
      const html = renderToStaticMarkup(
        <UmlDiagram doc={doc([{ id: 'R1', from: 'E1', to: 'E2', kind, fromCard: '1', toCard: '0..1', label: 'has' }])} />,
      );
      expect(html).toContain(`data-kind="${kind}"`);
      expect(html).toMatch(new RegExp(`marker-(start|end)="url\\(#[^)]*-${kind}\\)"`));
      expect(html).toContain(`data-marker="${kind}"`);
      if (kind === 'dependency') expect(html).toContain('stroke-dasharray');
      // Cardinality at both ends, and the label.
      expect(html).toContain('>0..1<');
      expect(html).toContain('>1<');
      expect(html).toContain('>has<');
    });
  }

  it('fills the composition diamond and leaves the aggregation one hollow', () => {
    const comp = renderToStaticMarkup(<UmlDiagram doc={doc([])} />);
    expect(comp).toMatch(/data-marker="composition"[^>]*fill="#1f2328"|fill="#1f2328"[^>]*data-marker="composition"/);
    expect(comp).toMatch(/data-marker="aggregation"[^>]*fill="#ffffff"|fill="#ffffff"[^>]*data-marker="aggregation"/);
  });

  it('draws a relation with no cardinality and no label without either', () => {
    const html = renderToStaticMarkup(<UmlDiagram doc={doc([{ id: 'R1', from: 'E1', to: 'E2', kind: 'dependency' }])} />);
    expect(html).toContain('data-kind="dependency"');
    expect(html).not.toContain('>undefined<');
  });

  it('offers the SVG as a download', () => {
    const html = renderToStaticMarkup(<UmlDiagram doc={doc([])} />);
    expect(html).toContain('Export diagram (SVG)');
  });
});

/* -------------------------------- the hook -------------------------------- */

const SPEC = { contracts: { api: true, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR };

function probe(opts: { json?: string; spec?: typeof SPEC; older?: boolean; flush?: () => Promise<void> }) {
  const writes: [string, string][] = [];
  const said: { notice: string[]; error: string[] } = { notice: [], error: [] };
  let state!: DesignState;
  function Probe() {
    state = useDesign({
      serverFiles: opts.json === undefined ? [] : [{ path: 'design/design.json', content: opts.json }],
      files: {},
      setFile: (path, content) => writes.push([path, content]),
      spec: opts.older ? undefined : opts.spec ?? SPEC,
      flushSave: opts.flush ?? (async () => undefined),
      setNotice: (m) => said.notice.push(m),
      setError: (m) => said.error.push(m),
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return { state, writes, said };
}

describe('useDesign writes the record', () => {
  it('writes the record, and only the record', () => {
    const { state, writes } = probe({ json: serialiseDesign(EMPTY_DESIGN) });
    state.write({ ...state.doc, notes: 'n' });
    expect(writes).toEqual([['design/design.json', serialiseDesign({ ...EMPTY_DESIGN, notes: 'n' })]]);
  });

  it('opens on the empty record when none is saved yet, and saves the first change', () => {
    const { state, writes } = probe({});
    expect(state.broken).toBeNull();
    expect(state.doc).toEqual(EMPTY_DESIGN);
    state.write({ ...state.doc, notes: 'n' });
    expect(writes.map(([p]) => p)).toEqual(['design/design.json']);
  });

  it('never writes over a record that does not validate', () => {
    const { state, writes } = probe({ json: '{"fields":[]}' });
    expect(state.broken).toBe('entities is not a list');
    state.write({ ...EMPTY_DESIGN, notes: 'n' });
    state.setDecisionStatus(0, 'accepted');
    expect(writes).toEqual([]);
  });

  it('writes a contract only while its switch is on', () => {
    const { state, writes } = probe({ json: serialiseDesign(EMPTY_DESIGN) });
    state.writeContract('shared/contract/api.json', '{"operations":[]}');
    state.writeContract('shared/contract/screens.json', '{"screens":[]}');
    expect(writes.map(([p]) => p)).toEqual(['shared/contract/api.json']);
  });

  it('checks by saving, and says what passed without naming a file', async () => {
    const { state, writes, said } = probe({ json: serialiseDesign(EMPTY_DESIGN) });
    await state.check();
    expect(writes).toEqual([]);
    expect(said.notice).toEqual([`Design checked: ${state.results.filter((r) => r.passed).length} of ${state.results.length} checks pass.`]);
  });

  it('refuses to check a room in the older format: no save, and never "0 of 0 checks pass"', async () => {
    let flushed = 0;
    const { state, said } = probe({ json: serialiseDesign(EMPTY_DESIGN), older: true, flush: async () => { flushed += 1; } });
    await state.check();
    expect(flushed).toBe(0);
    expect(said).toEqual({ notice: [], error: [] });
  });

  it('says so when the save behind the check fails', async () => {
    const { state, said } = probe({ json: serialiseDesign(EMPTY_DESIGN), flush: async () => { throw new Error('offline'); } });
    await state.check();
    expect(said.error).toEqual(['Your design did not save. Try the button again.']);
  });
});

describe('the copy', () => {
  it('never reads, writes or names a markdown file', () => {
    // Every module of the Design room, so a file added to it or moved within it is read too.
    const room = productModules().filter((path) => path.startsWith('components/workspace/panels/design/'));
    expect(room.length).toBeGreaterThan(10);
    for (const file of room) {
      const text = moduleText(file);
      expect(text, file).not.toContain('my-design.md');
      expect(text, file).not.toContain('DESIGN_MD');
      expect(text, file).not.toContain("useReferenceScaffolding('design')");
    }
    expect(moduleText('app/(app)/workspace/[phaseId]/design/page.tsx')).not.toContain('my-design.md');
  });
});
