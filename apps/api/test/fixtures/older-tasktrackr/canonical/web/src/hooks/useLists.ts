/**
 * The lists, loaded once and reloaded when something changes them.
 *
 * One hook per resource, each owning its own { data, loading, error }. No
 * store, no context, no cache: three screens do not need one, and the moment
 * they do you will know because this file will be the thing in the way.
 */

import { useCallback, useEffect, useState } from 'react';

import { getJson, postJson } from '../api/client';
import type { TaskList } from '../api/types';

export interface UseLists {
  lists: TaskList[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useLists(): UseLists {
  const [lists, setLists] = useState<TaskList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getJson<TaskList[]>('lists')
      .then((data) => {
        if (!live) return;
        setLists(data);
        setError(null);
      })
      .catch((failure: Error) => {
        // A request that failed is an error on the screen, never an empty
        // list: "you have no lists" and "we could not ask" are different
        // sentences and only one of them is true.
        if (!live) return;
        setError(failure.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  return { lists, loading, error, reload };
}

/** Make a list. The caller reloads; this function only writes. */
export function createList(name: string): Promise<TaskList> {
  return postJson<TaskList>('lists', { name });
}
