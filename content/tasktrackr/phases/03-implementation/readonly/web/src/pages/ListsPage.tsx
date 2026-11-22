/**
 * "#/" — every list, with its counts, and a form to add one.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { createList, useLists } from '../hooks/useLists';

export function ListsPage() {
  const { lists, loading, error, reload } = useLists();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  async function add(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!name.trim()) {
      setProblem('A list needs a name.');
      return;
    }
    try {
      await createList(name.trim());
      setName('');
      setProblem(null);
      reload();
    } catch (failure) {
      setProblem((failure as Error).message);
    }
  }

  return (
    <section data-testid="lists-page">
      <h1>Your lists</h1>

      <form className="new-list" data-testid="new-list-form" onSubmit={add}>
        <input
          data-testid="new-list-name"
          placeholder="Name a new list"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" data-testid="new-list-submit">
          Add list
        </button>
      </form>
      {problem ? (
        <p className="error" data-testid="lists-error" role="alert">
          {problem}
        </p>
      ) : null}

      {loading ? <p data-testid="lists-loading">Loading your lists.</p> : null}
      {error ? (
        <p className="error" data-testid="lists-load-error" role="alert">
          {error}
        </p>
      ) : null}

      {!loading && !error && lists.length === 0 ? (
        <p data-testid="lists-empty">No lists yet. The form above makes the first one.</p>
      ) : null}

      <ul className="lists">
        {lists.map((list) => (
          <li className="list-card" data-testid="list-card" key={list.id}>
            <Link to={`/lists/${list.id}`} data-testid="list-link">
              {list.name}
            </Link>
            <span className="muted" data-testid="list-counts">
              {list.open_count} open of {list.task_count}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
