/**
 * The tasks in one list, filtered and ordered by the API (US-3).
 *
 * The filtering and the ordering are the API's job, not this hook's. The
 * server is where the index is, the rule is written once, and a filter that
 * ran in the browser would only ever be right about the rows it had already
 * downloaded.
 */

import { useCallback, useEffect, useState } from 'react';

import { getJson, postJson } from '../api/client';
import type { Filters, Priority, Task } from '../api/types';

export interface UseTasks {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * The query string for a filter bar: only the filters that are actually set.
 *
 * "all" is not a status the API knows how to narrow by and an empty search box
 * is not a search, so neither is sent. Sending `q=` would ask the API to match
 * every title against the empty string, which it would happily do.
 */
export function queryFor(filters: Filters): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  if (filters.status !== 'all') query.status = filters.status;
  if (filters.q.trim()) query.q = filters.q.trim();
  if (filters.tag.trim()) query.tag = filters.tag.trim();
  return query;
}

export function useTasks(listId: number | null, filters: Filters): UseTasks {
  // TODO(learner): implement to the US-3 contract. Ask the API for the tasks
  // in this list, send only the filters that are set — queryFor above does
  // that part — and hand back { tasks, loading, error, reload }. getJson is in
  // ../api/client, and it rejects with an ApiError when the API says no: a
  // failed request is an error on the screen, never an empty list.
  //
  // listId is null before a list has been chosen, and that asks for nothing.
  throw new Error('useTasks is not implemented yet');
}

export interface NewTask {
  title: string;
  priority: Priority;
  due_date: string | null;
  tags: string[];
}

/** Add a task to a list. The caller reloads; this function only writes. */
export function createTask(listId: number, task: NewTask): Promise<Task> {
  return postJson<Task>(`lists/${listId}/tasks`, task);
}

/** Mark a task done (US-2). Completing a done task changes nothing. */
export function completeTask(taskId: number): Promise<Task> {
  return postJson<Task>(`tasks/${taskId}/complete`);
}

/** Put a task back on the pile. */
export function reopenTask(taskId: number): Promise<Task> {
  return postJson<Task>(`tasks/${taskId}/reopen`);
}
