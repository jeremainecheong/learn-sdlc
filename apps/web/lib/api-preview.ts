'use client';

/**
 * The learner's own application: start it, ask after it, stop it.
 *
 * Three routes and one rule. The capability that opens the app comes back on
 * the answer to a start and nowhere else, so this module never derives a URL,
 * never caches one and never puts one in a log line: the caller holds what the
 * start handed it, and a status poll answers about the same session without
 * repeating the secret.
 */
import type { PreviewSessionView } from '@learnsdlc/shared';
import { API_BASE, getToken, request, tokenAtSessionEnd } from './api';

export const previewApi = {
  /** Build the front end and start the API. The only answer that carries `url`. */
  start: (phaseId: string) =>
    request<PreviewSessionView>('POST', `/phases/${phaseId}/preview`),

  /**
   * How the session is doing, with only the console lines written since
   * `cursor`. `null` means this learner has never started anything on this
   * phase, which is the panel's idle state and not an error.
   *
   * The normalisation is load-bearing: Nest
   * serialises a `null` answer as an **empty body**, and `request` reads a
   * body it cannot parse back as `{}`. Without this the panel holds a session
   * object with no `status` in it, which is neither idle nor any of the six
   * states, and draws nothing at all.
   */
  status: async (phaseId: string, cursor = 0): Promise<PreviewSessionView | null> => {
    const answer = await request<PreviewSessionView | null>(
      'GET',
      `/phases/${phaseId}/preview?cursor=${Math.max(0, Math.trunc(cursor))}`,
    );
    return answer && typeof answer.status === 'string' ? answer : null;
  },

  stop: (phaseId: string) =>
    request<{ stopped: boolean }>('DELETE', `/phases/${phaseId}/preview`),
};

/**
 * Stop the app on the way out of the workspace.
 *
 * A preview holds one of very few seats and a learner who closes the tab is
 * not coming back to it, so leaving is worth one request that nobody waits
 * for. `navigator.sendBeacon` is the usual tool and cannot be used here: it
 * sends POST and carries no headers, and this route is a `DELETE` behind the
 * bearer token. `keepalive` is the same guarantee by another name (the
 * browser finishes the request after the document is gone) and it is exactly
 * what the workspace's exit save already relies on (`saveWorkspaceOnExit`).
 *
 * Everything here is best effort by design: the session's own idle sweep is
 * what actually bounds a preview, and this only makes the seat free sooner.
 */
export function stopPreviewOnExit(phaseId: string): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  // A session that has just ended still has the token it ended with, and a
  // signed request the server may refuse beats an unsigned one it certainly
  // will.
  const token = getToken() ?? tokenAtSessionEnd();
  if (!token) return;
  void fetch(`${API_BASE}/phases/${phaseId}/preview`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    keepalive: true,
  }).catch(() => undefined);
}
