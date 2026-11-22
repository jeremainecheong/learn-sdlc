/**
 * The filter bar (US-3): a status, a search box and a tag.
 *
 * It holds no state of its own. The page owns the filters and this component
 * shows them and reports a change, which is what makes it testable without a
 * page and what keeps the URL of the request in one place.
 */

import type { Filters } from '../api/types';

export interface TaskFiltersProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
}

export function TaskFilters({ filters, onChange }: TaskFiltersProps) {
  return (
    <div className="filters" data-testid="task-filters">
      <label>
        <span>Status</span>
        <select
          data-testid="filter-status"
          value={filters.status}
          onChange={(event) =>
            onChange({ ...filters, status: event.target.value as Filters['status'] })
          }
        >
          <option value="all">All</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
        </select>
      </label>

      <label>
        <span>Search</span>
        <input
          data-testid="filter-q"
          type="search"
          placeholder="Part of a title"
          value={filters.q}
          onChange={(event) => onChange({ ...filters, q: event.target.value })}
        />
      </label>

      <label>
        <span>Tag</span>
        <input
          data-testid="filter-tag"
          type="text"
          placeholder="One tag"
          value={filters.tag}
          onChange={(event) => onChange({ ...filters, tag: event.target.value })}
        />
      </label>
    </div>
  );
}
