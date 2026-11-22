/**
 * The filter bar holds no state; it reports what the reader asked for.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TaskFilters } from './TaskFilters';
import { NO_FILTERS } from '../api/types';
import type { Filters } from '../api/types';

test('changing the status reports the whole filter set, not just the change', () => {
  cleanup();
  const seen: Filters[] = [];
  render(<TaskFilters filters={{ ...NO_FILTERS, q: 'rent' }} onChange={(next) => seen.push(next)} />);
  fireEvent.change(screen.getByTestId('filter-status'), { target: { value: 'open' } });
  assert.deepStrictEqual(seen, [{ status: 'open', q: 'rent', tag: '' }]);
});

test('the search box and the tag box report their own text', () => {
  cleanup();
  const seen: Filters[] = [];
  render(<TaskFilters filters={NO_FILTERS} onChange={(next) => seen.push(next)} />);
  fireEvent.change(screen.getByTestId('filter-q'), { target: { value: 'passport' } });
  fireEvent.change(screen.getByTestId('filter-tag'), { target: { value: 'home' } });
  assert.deepStrictEqual(seen, [
    { status: 'all', q: 'passport', tag: '' },
    { status: 'all', q: '', tag: 'home' },
  ]);
});
