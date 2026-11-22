/**
 * The add-a-task form (US-1).
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { NewTaskForm } from './NewTaskForm';
import type { NewTask } from '../hooks/useTasks';

test('an empty title is refused before the API is asked', async () => {
  cleanup();
  const added: NewTask[] = [];
  render(<NewTaskForm onAdd={(task) => { added.push(task); }} />);
  fireEvent.click(screen.getByTestId('new-task-submit'));
  await waitFor(() => assert.ok(screen.getByTestId('new-task-error')));
  assert.deepStrictEqual(added, []);
});

test('a task is sent with its title trimmed and its tags split', async () => {
  cleanup();
  const added: NewTask[] = [];
  render(<NewTaskForm onAdd={(task) => { added.push(task); }} />);
  fireEvent.change(screen.getByTestId('new-task-title'), { target: { value: '  Pay the rent  ' } });
  fireEvent.change(screen.getByTestId('new-task-tags'), { target: { value: 'home, money ,' } });
  fireEvent.change(screen.getByTestId('new-task-priority'), { target: { value: 'high' } });
  fireEvent.click(screen.getByTestId('new-task-submit'));
  await waitFor(() => assert.strictEqual(added.length, 1));
  assert.deepStrictEqual(added[0], {
    title: 'Pay the rent',
    priority: 'high',
    due_date: null,
    tags: ['home', 'money'],
  });
});

test('a refusal from the API is shown rather than swallowed', async () => {
  cleanup();
  render(<NewTaskForm onAdd={() => Promise.reject(new Error('A task needs a title.'))} />);
  fireEvent.change(screen.getByTestId('new-task-title'), { target: { value: 'Something' } });
  fireEvent.click(screen.getByTestId('new-task-submit'));
  await waitFor(() => assert.strictEqual(screen.getByTestId('new-task-error').textContent, 'A task needs a title.'));
});
