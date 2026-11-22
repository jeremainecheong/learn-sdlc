// @vitest-environment jsdom
/**
 * The "Your design" rail reads the record, and the brief pane counts the same
 * record the same way.
 *
 * A design with four entities and five endpoints must read as four entities
 * and five endpoints, half a design never reads as an empty one, and a
 * contract the teacher left off is not a part at all.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_CONTRACT_JSON,
  DEFAULT_DESIGN_FLOOR,
  DESIGN_JSON,
  EMPTY_DESIGN,
  SCREEN_CONTRACT_JSON,
  serialiseDesign,
  type Design,
  type DesignEntity,
  type PhaseDetail,
} from '@learnsdlc/shared';
import { DesignParts } from '@/components/workspace/panels/design/DesignBoard';
import { DesignBrief } from '@/components/workspace/panels/design/DesignBrief';
import { useDesign, type DesignState } from '@/components/workspace/panels/design/useDesign';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

vi.mock('@/components/ui', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/ui')>();
  return {
    ...real,
    StatusSquare: ({ state }: { state: string }) => <span data-testid="state" data-state={state} />,
    CellTitle: ({ state, title, detail }: { state: string; title: string; detail?: string }) => (
      <span data-part={title} data-state={state}>
        {detail}
      </span>
    ),
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const SPEC = { contracts: { api: true, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR };

const ent = (id: string, name: string, attrs: string[]): DesignEntity => ({
  id,
  name,
  kind: 'class',
  attributes: attrs.map((a) => ({ name: a, type: 'string' })),
  responsibilities: [],
  satisfies: [],
});

/** Four entities (nine attributes, one blank row being typed into), two decisions, one accepted. */
const BOARD: Design = {
  ...EMPTY_DESIGN,
  entities: [
    ent('E1', 'Shelf', ['books']),
    ent('E2', 'Book', ['id', 'title', 'author', 'onLoan']),
    ent('E3', 'Loan', ['bookId', 'borrower', 'since']),
    { ...ent('E4', 'Borrower', ['name']), attributes: [{ name: 'name', type: 'string' }, { name: ' ' }] },
  ],
  decisions: [
    { id: 'D1', title: 'Storage', choice: 'keep books in memory', alternative: 'a database', rationale: 'small', tradeOff: 'durability', status: 'accepted', satisfies: [] },
    { id: 'D2', title: 'Ids', choice: 'numbers', alternative: 'uuids', rationale: 'short', tradeOff: 'guessable', status: 'proposed', satisfies: [] },
  ],
};
const API = JSON.stringify({ operations: [1, 2, 3, 4, 5].map((n) => ({ id: `op${n}`, method: 'GET', path: `/api/${n}` })), errors: {} });

function stateFrom(files: Record<string, string>, spec: PhaseDetail['design'] = SPEC): DesignState {
  let captured: DesignState | null = null;
  function Probe() {
    captured = useDesign({
      serverFiles: Object.entries(files).map(([path, content]) => ({ path, content })),
      files,
      setFile: () => undefined,
      spec,
      flushSave: async () => undefined,
      setNotice: () => undefined,
      setError: () => undefined,
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured) throw new Error('the hook did not run');
  return captured;
}

function railOf(state: DesignState): Record<string, { state: string; detail: string }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  host.innerHTML = renderToStaticMarkup(<DesignParts design={state} files={{}} />);
  const out: Record<string, { state: string; detail: string }> = {};
  for (const el of host.querySelectorAll('[data-part]')) {
    out[el.getAttribute('data-part')!] = { state: el.getAttribute('data-state')!, detail: el.textContent ?? '' };
  }
  return out;
}

function briefOf(files: Record<string, string>): Record<string, { state: string; detail: string }> {
  const props = {
    detail: { files: [], projectSlug: 'shelf', design: SPEC } as unknown as PhaseDetail,
    files,
    enrollment: { projectTitle: 'Shelf' },
    helpers: { setTab: () => {}, setPane: () => {} },
  } as unknown as PhasePanelProps;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<DesignBrief {...props} />));
  const out: Record<string, { state: string; detail: string }> = {};
  for (const li of host.querySelectorAll('li')) {
    const [t, d] = [...li.querySelectorAll('p')].map((p) => p.textContent ?? '');
    out[t] = { state: li.querySelector('[data-testid="state"]')?.getAttribute('data-state') ?? '', detail: d };
  }
  return out;
}

describe('the rail reads the record', () => {
  const files = { [DESIGN_JSON]: serialiseDesign(BOARD), [API_CONTRACT_JSON]: API };

  it('DesignParts counts entities with attributes, the endpoints, and which decisions were accepted', () => {
    const rail = railOf(stateFrom(files));
    expect(rail['Data model']).toEqual({ state: 'done', detail: 'Four entities, nine attributes' });
    expect(rail['API contract']).toEqual({ state: 'done', detail: 'Five endpoints' });
    expect(rail['Decisions']).toEqual({ state: 'done', detail: 'One accepted, one proposed' });
    expect(rail['Screens']).toBeUndefined();
  });

  it('one entity and one endpoint read in the singular', () => {
    const one: Design = { ...BOARD, entities: [ent('E1', 'Book', ['title'])] };
    const api = JSON.stringify({ operations: [{ id: 'op1' }], errors: {} });
    const rail = railOf(stateFrom({ [DESIGN_JSON]: serialiseDesign(one), [API_CONTRACT_JSON]: api }));
    expect(rail['Data model'].detail).toBe('One entity, one attribute');
    expect(rail['API contract'].detail).toBe('One endpoint');
  });

  it('a screen contract the teacher switched on is a part of its own', () => {
    const spec = { ...SPEC, contracts: { api: false, screens: true } };
    const rail = railOf(stateFrom({ [DESIGN_JSON]: serialiseDesign(BOARD), [SCREEN_CONTRACT_JSON]: '{"screens":[{"route":"#/"}]}' }, spec));
    expect(rail['Screens']).toEqual({ state: 'done', detail: 'One screen' });
    expect(rail['API contract']).toBeUndefined();
  });

  it('DesignBrief counts the same record', () => {
    const brief = briefOf(files);
    expect(brief['Data model']).toEqual({ state: 'done', detail: '4 entities, 9 attributes.' });
    expect(brief['Decisions']).toEqual({ state: 'done', detail: '2 decisions, 1 accepted.' });
  });
});

describe('half a design never reads as an empty one', () => {
  it('DesignParts: endpoints and no entities, entities and no endpoints', () => {
    let rail = railOf(stateFrom({ [DESIGN_JSON]: serialiseDesign({ ...BOARD, entities: [] }), [API_CONTRACT_JSON]: API }));
    expect(rail['Data model']).toEqual({ state: 'todo', detail: 'No entities yet' });
    expect(rail['API contract'].detail).toBe('Five endpoints');
    host?.remove();
    rail = railOf(stateFrom({ [DESIGN_JSON]: serialiseDesign(BOARD), [API_CONTRACT_JSON]: '{"operations":[],"errors":{}}' }));
    expect(rail['API contract']).toEqual({ state: 'todo', detail: 'No endpoints yet' });
    expect(rail['Data model'].detail).toBe('Four entities, nine attributes');
  });

  it('an empty record reads every part as still to do', () => {
    const rail = railOf(stateFrom({ [DESIGN_JSON]: serialiseDesign(EMPTY_DESIGN) }));
    expect(rail['Data model']).toEqual({ state: 'todo', detail: 'No entities yet' });
    expect(rail['Operations']).toEqual({ state: 'todo', detail: 'No operations yet' });
    expect(rail['Decisions']).toEqual({ state: 'todo', detail: 'Not written' });
  });
});
