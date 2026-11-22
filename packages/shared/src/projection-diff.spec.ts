import { numberedSlots, projectionChangeSet, uniqueKeys } from './projection-diff';

describe('projectionChangeSet', () => {
  it('lists changed, removed and added paths, the old side\'s order first', () => {
    const before = { 'x/a': 'one', 'x/b': 'two', 'x/c': 'three' };
    const after = { 'x/new': 'four', 'x/c': 'three', 'x/a': 'uno' };
    expect(projectionChangeSet(before, after)).toEqual([
      { path: 'x/a', before: 'one', after: 'uno' },
      { path: 'x/b', before: 'two' },
      { path: 'x/new', after: 'four' },
    ]);
  });
  it('reads an absent path as empty, so an empty field that goes or comes is no change', () => {
    expect(projectionChangeSet({ 'x/a': '' }, {})).toEqual([]);
    expect(projectionChangeSet({}, { 'x/a': '' })).toEqual([]);
  });
});

describe('uniqueKeys', () => {
  it('keeps a first key as written and numbers a repeat or a missing key by its occurrence', () => {
    const keys = uniqueKeys([{ id: 'A' }, { id: 'B' }, { id: 'A' }, {}, { id: 2 }, { id: { b: 1, a: 2 } }], (x: { id?: unknown }) => x.id);
    expect(keys).toEqual(['A', 'B', 'A\u00001', '\u00000', '2', '{"a":2,"b":1}']);
  });
});

describe('numberedSlots', () => {
  const id = (x: { id: string }) => x.id;
  it('is the list itself with no base', () => {
    const list = [{ id: 'B' }, { id: 'A' }];
    expect(numberedSlots(list, id)).toEqual(list);
  });
  it('follows the base\'s keys, leaves a removed key\'s slot empty and puts new keys last', () => {
    const base = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
    expect(numberedSlots([{ id: 'D' }, { id: 'C' }, { id: 'A' }], id, base)).toEqual([{ id: 'A' }, undefined, { id: 'C' }, { id: 'D' }]);
  });
});
