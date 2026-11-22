/**
 * The Deadline badge page: three sample tasks drawn with isOverdue from
 * lib/overdue.ts. The team supplies this file; you do not edit it.
 * Ticking Done changes the task in memory only, and the list is drawn again.
 */
import { isOverdue } from './lib/overdue';
import type { Task } from './lib/types';

/** Fixed, the same day the tests use, so the page never depends on the real calendar. */
const DEMO_DATE = '2026-11-13';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const tasks: Task[] = [
  { title: 'Yesterday', dueDate: '2026-11-12', done: false },
  { title: 'Today', dueDate: '2026-11-13', done: false },
  { title: 'No due date', dueDate: null, done: false },
];

function dueText(dueDate: string | null): string {
  if (dueDate === null) return 'No due date';
  const [year, month, day] = dueDate.split('-');
  return `Due ${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

function element(tag: string, className: string, text: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function row(task: Task, index: number) {
  const item = document.createElement('li');
  item.setAttribute('data-testid', 'preview-task-row');
  item.setAttribute('data-title', task.title);
  item.appendChild(element('span', 'title', task.title));
  item.appendChild(element('span', 'due', dueText(task.dueDate)));
  if (isOverdue(task, DEMO_DATE)) {
    const badge = element('span', 'badge', 'Overdue');
    badge.setAttribute('data-testid', 'preview-overdue-badge');
    item.appendChild(badge);
  }
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = task.done;
  box.setAttribute('data-testid', 'preview-done');
  box.addEventListener('change', () => {
    tasks[index] = { ...task, done: box.checked };
    draw();
  });
  label.appendChild(box);
  label.appendChild(document.createTextNode(' Done'));
  item.appendChild(label);
  return item;
}

function draw(): void {
  const list = document.getElementById('tasks');
  if (!list) return;
  list.textContent = '';
  tasks.forEach((task, index) => list.appendChild(row(task, index)));
}

// Only where there is a page: the test runner compiles this file but never loads it.
if (typeof document !== 'undefined') draw();
