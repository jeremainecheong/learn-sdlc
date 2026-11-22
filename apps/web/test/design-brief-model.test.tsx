// @vitest-environment jsdom
/**
 * The design brief's "Data model" row reads the same record the Design room
 * edits: entities with their attributes read as written, no entity reads as
 * still to do, and a phase whose Design task is in the older format says so
 * instead of counting anything. It also reports how many contradictions the
 * room has to settle, counted from the same stories and the learner's own
 * story record, so the brief and the room never report two numbers.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DESIGN_FLOOR,
  DESIGN_JSON,
  DESIGN_OLDER_FORMAT_ROOM,
  EMPTY_DESIGN,
  EMPTY_STORY,
  serialiseDesign,
  serialiseStory,
  type Design,
  type PhaseDetail,
} from '@learnsdlc/shared';
import type { PhasePanelProps } from '@/components/workspace/panels/types';
import { DesignBrief } from '@/components/workspace/panels/design/DesignBrief';

vi.mock('@/components/ui', () => ({
  StatusSquare: ({ state }: { state: string }) => <span data-testid="state" data-state={state} />,
}));

const ownRecord = vi.fn((_enrollment: unknown): string | undefined => undefined);
vi.mock('@/components/workspace/panels/design/useStories', () => ({ useOwnStoryRecord: (e: unknown) => ownRecord(e) }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const SPEC = { contracts: { api: true, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR };

/** A model of two entities, three attributes (one blank row being typed into). */
const complete: Design = {
  ...EMPTY_DESIGN,
  entities: [
    { id: 'E1', name: 'Task', kind: 'class', attributes: [{ name: 'id', type: 'string' }, { name: 'due', type: 'date' }, { name: ' ' }], responsibilities: [], satisfies: [] },
    { id: 'E2', name: 'List', kind: 'class', attributes: [{ name: 'title' }], responsibilities: [], satisfies: [] },
  ],
};

function brief(text: string | null, spec: PhaseDetail['design'] | null = SPEC, enrollment: unknown = null) {
  const props = {
    detail: { files: [], projectSlug: 'reference', design: spec ?? undefined } as unknown as PhaseDetail,
    files: text === null ? {} : { [DESIGN_JSON]: text },
    enrollment,
    helpers: { setTab: () => {}, setPane: () => {} },
  } as unknown as PhasePanelProps;
  if (root) act(() => root!.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<DesignBrief {...props} />));
  const row = [...host.querySelectorAll('li')].find((li) => li.textContent?.includes('Data model'));
  return { state: row?.querySelector('[data-testid="state"]')?.getAttribute('data-state') ?? null, text: row?.textContent ?? '' };
}

describe('the design brief reads the record the room edits', () => {
  it('a model with entities reads done, never a green pass, and counts the attributes written', () => {
    expect(brief(serialiseDesign(complete))).toEqual({ state: 'done', text: 'Data model2 entities, 3 attributes.' });
  });

  it('a model with no entity reads as still to do', () => {
    expect(brief(serialiseDesign(EMPTY_DESIGN)).state).toBe('todo');
    expect(brief(null).state).toBe('todo');
  });

  it('a phase in the older format says so and counts nothing', () => {
    brief(serialiseDesign(complete), null);
    expect(host!.textContent).toContain(DESIGN_OLDER_FORMAT_ROOM);
    expect(host!.querySelector('li')).toBeNull();
  });

  it('a record that does not validate is reported, never counted', () => {
    brief('{"fields":[]}');
    expect(host!.textContent).toContain('It cannot be opened: entities is not a list.');
    expect(host!.textContent).not.toContain('Data model');
  });
});

describe('the design brief reports the contradictions the room settles', () => {
  const US3 = {
    id: 'US-3',
    title: 'Filter, search and order a list',
    line: 'As a busy learner, I want to narrow a list by status, tag and keyword and read it with high priority tasks before medium, so that I can see the right work first.',
  };
  const withStories = { ...SPEC, stories: [US3] };
  const op = (id: string, name: string, over: Partial<Design['operations'][number]> = {}) => ({
    id,
    name,
    inputs: [],
    returns: '',
    errors: [],
    satisfies: [],
    ...over,
  });
  const listing = op('O1', 'listTasks(listId, filters)', { note: 'ordering: lowest first.' });
  const overdue = op('O2', 'getOverdue(today)', { inputs: ['none'] });
  const warnings = () => host!.querySelector('[data-testid="phase-design-brief-warnings"]');

  it('one contradiction reads "One contradiction to settle."', () => {
    brief(serialiseDesign({ ...complete, operations: [listing] }), withStories);
    expect(warnings()?.textContent).toBe('One contradiction to settle.');
  });

  it('two read "Two contradictions to settle.", in words as the room counts them', () => {
    brief(serialiseDesign({ ...complete, operations: [listing, overdue] }), withStories);
    expect(warnings()?.textContent).toBe('Two contradictions to settle.');
  });

  it('a settled record draws no line', () => {
    brief(serialiseDesign({ ...complete, operations: [op('O1', 'listTasks(listId, filters)', { note: 'ordering: high priority first.' })] }), withStories);
    expect(warnings()).toBeNull();
  });

  it("counts a contradiction only the learner's own story record shows, with no story listed by the phase (Task 18)", () => {
    ownRecord.mockReturnValueOnce(serialiseStory({
      ...EMPTY_STORY, id: 'US-3', title: 'Filter, search and order a list', persona: 'busy learner',
      capability: 'to narrow a list by status, tag and keyword and read it with high priority tasks before medium', benefit: 'I can see the right work first',
    }));
    brief(serialiseDesign({ ...complete, operations: [listing] }), SPEC, { phases: [] });
    expect(warnings()?.textContent).toBe('One contradiction to settle.');
  });

  it("reads the learner's own story record through the enrollment it is given", () => {
    const enrollment = { phases: [] };
    ownRecord.mockClear();
    brief(serialiseDesign(complete), withStories, enrollment);
    expect(ownRecord).toHaveBeenCalledWith(enrollment);
  });
});
