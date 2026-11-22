/**
 * "#/lists/:listId" — the tasks in one list, the filter bar and the add form.
 *
 * The page owns the filters and hands them to the hook. The hook asks the API.
 * Nothing here filters an array in the browser, which is why the search finds
 * the task on page four.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { NewTaskForm } from '../components/NewTaskForm';
import { TaskFilters } from '../components/TaskFilters';
import { TaskRow } from '../components/TaskRow';
import { completeTask, createTask, reopenTask, useTasks } from '../hooks/useTasks';
import { NO_FILTERS } from '../api/types';
import type { Filters, Task } from '../api/types';

export function TasksPage() {
  const params = useParams<{ listId: string }>();
  const listId = Number(params.listId);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const { tasks, loading, error, reload } = useTasks(Number.isFinite(listId) ? listId : null, filters);
  const today = new Date().toISOString().slice(0, 10);

  async function complete(task: Task) {
    await completeTask(task.id);
    reload();
  }

  async function reopen(task: Task) {
    await reopenTask(task.id);
    reload();
  }

  return (
    <section data-testid="tasks-page">
      <p>
        <Link to="/" data-testid="back-to-lists">
          All lists
        </Link>
      </p>
      <h1>Tasks</h1>

      <NewTaskForm
        onAdd={async (task) => {
          await createTask(listId, task);
          reload();
        }}
      />

      <TaskFilters filters={filters} onChange={setFilters} />

      {loading ? <p data-testid="tasks-loading">Loading tasks.</p> : null}
      {error ? (
        <p className="error" data-testid="tasks-error" role="alert">
          {error}
        </p>
      ) : null}
      {!loading && !error && tasks.length === 0 ? (
        <p data-testid="tasks-empty">Nothing here matches those filters.</p>
      ) : null}

      <ul className="tasks" data-testid="task-list">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} today={today} onComplete={complete} onReopen={reopen} />
        ))}
      </ul>
    </section>
  );
}
