/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The fetched project map.
 *
 * The map is a pure function of the enrolment and every open phase's files.
 * Building it in the browser would mean the shell downloading every open
 * phase's whole workspace on the way to Home: far more bytes than the graph
 * itself, and over the landing budget (e2e/render-cost.spec.ts). So the API
 * answers with the graph, and this is the cache in front of it: what is held,
 * what costs a request, and what an invalidation does to it.
 */
type ProjectMap = typeof import('@/lib/project-map');
type Api = typeof import('@/lib/api');

let maps: ProjectMap;
let api: Api;

const graph = (id: string) => ({ nodes: [{ id }], edges: [] }) as never;

beforeEach(async () => {
  window.localStorage.clear();
  vi.resetModules();
  api = await import('@/lib/api');
  maps = await import('@/lib/project-map');
});

describe('the two shapes', () => {
  it('are the folded one Home draws and the unfolded one ⌘K reads', () => {
    expect(maps.CARD_MAP).toEqual({ compact: true, showLocked: true });
    // Unfolded, because folding turns a story's four criteria into one block
    // and ⌘K has to find the criterion, not the heading. Locked placeholders
    // cost the palette nothing (it asks for no kind a placeholder has) so one
    // answer serves both it and the map page's opening view.
    expect(maps.FULL_MAP).toEqual({ compact: false, showLocked: true });
  });
});

describe('what a map costs', () => {
  it('is one request, and nothing at all for the second reader', async () => {
    const fetched = vi.spyOn(api.api, 'projectMap').mockResolvedValue(graph('n1'));

    await maps.loadMap('tasktrackr', maps.FULL_MAP);
    await maps.loadMap('tasktrackr', maps.FULL_MAP);

    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched).toHaveBeenCalledWith('tasktrackr', maps.FULL_MAP);
    expect(maps.cachedMap('tasktrackr', maps.FULL_MAP)).toEqual({ nodes: [{ id: 'n1' }], edges: [] });
  });

  it('is one request for two readers asking at the same moment', async () => {
    const fetched = vi.spyOn(api.api, 'projectMap').mockResolvedValue(graph('n1'));

    await Promise.all([
      maps.loadMap('tasktrackr', maps.FULL_MAP),
      maps.loadMap('tasktrackr', maps.FULL_MAP),
    ]);

    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('is a different request for the other shape, because they are different nodes', async () => {
    const fetched = vi.spyOn(api.api, 'projectMap').mockResolvedValue(graph('n1'));

    await maps.loadMap('tasktrackr', maps.FULL_MAP);
    await maps.loadMap('tasktrackr', maps.CARD_MAP);

    expect(fetched).toHaveBeenCalledTimes(2);
    expect(fetched).toHaveBeenNthCalledWith(2, 'tasktrackr', maps.CARD_MAP);
  });

  it('is nothing when the project loader has already been handed one', async () => {
    const fetched = vi.spyOn(api.api, 'projectMap').mockResolvedValue(graph('n1'));
    // What `fetchProject` does with the folded map it fetches with the project:
    // the map page opens on the same shape and must not ask for it again.
    maps.putMap('tasktrackr', maps.CARD_MAP, { nodes: [], edges: [] });

    await maps.loadMap('tasktrackr', maps.CARD_MAP);

    expect(fetched).not.toHaveBeenCalled();
  });

  it('is nothing before anybody asks: ⌘K is not part of a landing', () => {
    expect(maps.cachedMap('tasktrackr', maps.FULL_MAP)).toBeNull();
    expect(maps.cachedMap(undefined, maps.FULL_MAP)).toBeNull();
  });
});

describe('when the work moves under it', () => {
  it('keeps drawing what it holds, and asks again for the next reader', async () => {
    const fetched = vi.spyOn(api.api, 'projectMap').mockResolvedValue(graph('n1'));
    await maps.loadMap('tasktrackr', maps.FULL_MAP);

    maps.staleMaps();

    // Still drawn: a page that mounts now gets the graph, not a skeleton.
    expect(maps.cachedMap('tasktrackr', maps.FULL_MAP)).toEqual({ nodes: [{ id: 'n1' }], edges: [] });
    fetched.mockResolvedValue(graph('n2'));
    await maps.loadMap('tasktrackr', maps.FULL_MAP);
    expect(fetched).toHaveBeenCalledTimes(2);
    expect(maps.cachedMap('tasktrackr', maps.FULL_MAP)).toEqual({ nodes: [{ id: 'n2' }], edges: [] });
  });

  it('throws it away for a different learner or a different project', async () => {
    vi.spyOn(api.api, 'projectMap').mockResolvedValue(graph('n1'));
    await maps.loadMap('tasktrackr', maps.FULL_MAP);

    maps.resetMaps();

    expect(maps.cachedMap('tasktrackr', maps.FULL_MAP)).toBeNull();
  });

  it('never lets an answer from before the change overwrite one from after it', async () => {
    let release: (value: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    vi.spyOn(api.api, 'projectMap').mockImplementation(() => slow as never);

    const inflight = maps.loadMap('tasktrackr', maps.FULL_MAP);
    maps.staleMaps();
    release({ nodes: [{ id: 'stale' }], edges: [] });
    await inflight;

    expect(maps.cachedMap('tasktrackr', maps.FULL_MAP)).toBeNull();
  });
});

describe('a map that will not load', () => {
  it('is an empty graph and not a failed page', async () => {
    vi.spyOn(api.api, 'projectMap').mockRejectedValue(new Error('request failed (503)'));

    await expect(maps.loadMap('tasktrackr', maps.FULL_MAP)).resolves.toEqual({
      nodes: [],
      edges: [],
    });
  });
});

describe('ensureFullMap', () => {
  it('asks for the unfolded shape, which is what the palette reads', async () => {
    const fetched = vi.spyOn(api.api, 'projectMap').mockResolvedValue(graph('n1'));

    maps.ensureFullMap('tasktrackr');
    await Promise.resolve();

    expect(fetched).toHaveBeenCalledWith('tasktrackr', maps.FULL_MAP);
  });

  it('does nothing outside a project, where there is no map to ask for', () => {
    const fetched = vi.spyOn(api.api, 'projectMap');
    maps.ensureFullMap(undefined);
    expect(fetched).not.toHaveBeenCalled();
  });
});
