/**
 * The shapes the API sends, mirroring shared/contract/api.json.
 *
 * This file is the TypeScript half of the contract you wrote in the design
 * phase. When the contract changes, this file changes with it, and every
 * component that reads a field it no longer has stops compiling.
 */

export type Priority = 'low' | 'medium' | 'high';
export type TaskStatus = 'open' | 'done';

export interface Task {
  id: number;
  list_id: number;
  title: string;
  priority: Priority;
  /** An ISO date, "2026-03-14", or null. A task with no due date is never late. */
  due_date: string | null;
  status: TaskStatus;
  created_at: string;
  completed_at: string | null;
  tags: string[];
  comment_count: number;
}

export interface TaskList {
  id: number;
  name: string;
  created_at: string;
  task_count: number;
  open_count: number;
}

export interface Comment {
  id: number;
  task_id: number;
  author: string;
  body: string;
  created_at: string;
}

/** Every error the API sends looks like this, whatever went wrong. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** What a task filter bar can ask for. Empty strings mean "do not filter". */
export interface Filters {
  status: 'all' | 'open' | 'done';
  q: string;
  tag: string;
}

export const NO_FILTERS: Filters = { status: 'all', q: '', tag: '' };
