'use client';
import { useCallback, useEffect, useState } from 'react';

/**
 * Whether a document page's read of the phase after an Apply has failed.
 *
 * `useAgentWorkspace` holds a page from the start of a proposal operation
 * until the page has read back what was applied; when that read fails it keeps
 * holding (the mentor offers "Retry workspace refresh", and refuses another
 * proposal until it succeeds), which the page cannot tell apart from an
 * operation still running. This wraps the page's own read-back, the one the
 * hook calls, and says when it failed, so the page can say what to do in that
 * state instead of "when it has finished". Kept out of `useAgentWorkspace`'s
 * module so that the many tests that stand in for that hook keep working.
 */
export function useAppliedReadBack(phaseId: string, read: () => Promise<unknown>) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [phaseId]);
  const readBack = useCallback(async () => {
    setFailed(false);
    try {
      await read();
    } catch (error) {
      setFailed(true);
      throw error;
    }
  }, [read]);
  return { failed, readBack };
}
