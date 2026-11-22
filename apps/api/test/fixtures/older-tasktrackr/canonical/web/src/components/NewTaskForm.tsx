/**
 * The form that adds a task (US-1).
 *
 * It refuses an empty title before it asks the API, because the API refuses it
 * too and a round trip to be told what you already knew is a worse form. The
 * API's refusal is still the one that counts: this check is a courtesy, not a
 * guard.
 */

import { useState } from 'react';

import type { NewTask } from '../hooks/useTasks';
import type { Priority } from '../api/types';

export interface NewTaskFormProps {
  onAdd: (task: NewTask) => Promise<void> | void;
  disabled?: boolean;
}

const EMPTY = { title: '', priority: 'medium' as Priority, due: '', tags: '' };

export function NewTaskForm({ onAdd, disabled }: NewTaskFormProps) {
  const [draft, setDraft] = useState(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title) {
      setProblem('A task needs a title.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onAdd({
        title,
        priority: draft.priority,
        due_date: draft.due ? draft.due : null,
        tags: draft.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      setDraft(EMPTY);
    } catch (failure) {
      setProblem((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="new-task" data-testid="new-task-form" onSubmit={submit}>
      <input
        data-testid="new-task-title"
        placeholder="What needs doing?"
        value={draft.title}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
      />
      <select
        data-testid="new-task-priority"
        value={draft.priority}
        onChange={(event) => setDraft({ ...draft, priority: event.target.value as Priority })}
      >
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
      <input
        data-testid="new-task-due"
        type="date"
        value={draft.due}
        onChange={(event) => setDraft({ ...draft, due: event.target.value })}
      />
      <input
        data-testid="new-task-tags"
        placeholder="tags, comma separated"
        value={draft.tags}
        onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
      />
      <button type="submit" data-testid="new-task-submit" disabled={busy || disabled}>
        {busy ? 'Adding' : 'Add task'}
      </button>
      {problem ? (
        <p className="error" data-testid="new-task-error" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
