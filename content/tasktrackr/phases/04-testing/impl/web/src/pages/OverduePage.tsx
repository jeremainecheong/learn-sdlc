/**
 * "#/overdue" — the overdue report (US-4).
 *
 * The report is its own page rather than a filter on the task list, because it
 * crosses every list: it answers "what is late", not "what is late in here".
 * The day is sent to the API rather than looked up there, so the report can be
 * asked about any day and tested on all of them.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { TaskRow } from '../components/TaskRow';
import { getJson } from '../api/client';
import { completeTask, reopenTask } from '../hooks/useTasks';
import { daysLate } from '../lib/overdue';
import type { Task } from '../api/types';
import screenCopy from '../../../shared/contract/accepted-screen-copy.json';

export function OverduePage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getJson<Task[]>('tasks/overdue', { today })
      .then((data) => {
        if (!live) return;
        setTasks(data);
        setError(null);
      })
      .catch((failure: Error) => {
        if (!live) return;
        setError(failure.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [today, nonce]);

  // Finishing something from the report is the whole point of reading it, so
  // the rows here do what the rows anywhere else do.
  async function complete(task: Task) {
    await completeTask(task.id);
    setNonce((n) => n + 1);
  }

  async function reopen(task: Task) {
    await reopenTask(task.id);
    setNonce((n) => n + 1);
  }

  const worst = tasks.length > 0 ? daysLate(tasks[0], today) : 0;

  return (
    <section data-testid="overdue-page">
      <p>
        <Link to="/" data-testid="back-to-lists">
          All lists
        </Link>
      </p>
      <h1>{screenCopy.title}</h1>
      <p className="muted" data-testid="overdue-asof">
        As of {today}. A task due today is not late yet.
      </p>

      {loading ? <p data-testid="overdue-loading">Working out what is late.</p> : null}
      {error ? (
        <p className="error" data-testid="overdue-error" role="alert">
          {error}
        </p>
      ) : null}
      {!loading && !error && tasks.length === 0 ? (
        <p data-testid="overdue-empty">{screenCopy.empty}</p>
      ) : null}
      {tasks.length > 0 ? (
        <p data-testid="overdue-summary">
          {tasks.length === 1 ? '1 task is late' : `${tasks.length} tasks are late`}, the worst by{' '}
          {worst === 1 ? '1 day' : `${worst} days`}.
        </p>
      ) : null}

      <ul className="tasks" data-testid="overdue-list">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} today={today} sourceList={<Link to={`/lists/${task.list_id}`}>List {task.list_id}</Link>} onComplete={complete} onReopen={reopen} />
        ))}
      </ul>
    </section>
  );
}
