/**
 * The in-flight gate stops at the API's
 * age-out window. The feedback service writes off a queued or running revision
 * older than ten minutes when the next submit arrives (non-durable queue), so a
 * Submit held off past that would lock the task until a restart. Within the
 * window the gate holds; past it Submit is on and the press frees the slot.
 */
import { describe, expect, it } from 'vitest';
import * as signoff from '@/components/workspace/signoff-status';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const rev = (id: string, status: 'queued' | 'running' | 'completed', createdAt: string) => ({ id, status, passed: null, createdAt, taskKey: 'main' });
const s = signoff as unknown as Record<string, (...args: unknown[]) => unknown>;

describe('the in-flight gate and the API\'s age-out window', () => {
  it('the window is the API\'s ten minutes', () => {
    expect((signoff as unknown as Record<string, unknown>).IN_FLIGHT_MAX_AGE_MS).toBe(10 * 60 * 1000);
  });
  for (const status of ['queued', 'running'] as const) {
    it(`${status}: nine minutes old holds Submit off; eleven minutes old does not`, () => {
      expect(signoff.revisionInFlight(rev('r', status, at(9)), 'main', null, NOW)).toBe(true);
      expect(signoff.revisionInFlight(rev('r', status, at(11)), 'main', null, NOW)).toBe(false);
    });
  }
  it('pendingRevision names the revision in flight (the one the room watches), or null', () => {
    expect((s.pendingRevision(rev('held', 'queued', at(1)), 'main', rev('older', 'completed', at(5)), NOW) as { id: string } | null)?.id).toBe('held');
    expect(s.pendingRevision(rev('held', 'queued', at(1)), 'main', rev('held', 'completed', at(1)), NOW)).toBeNull();
  });
  it('an unreadable timestamp counts as new, as the API\'s own age reading does', () => {
    expect(signoff.revisionInFlight(rev('r', 'queued', 'not-a-date'), 'main', null, NOW)).toBe(true);
  });
  it('the reason says nothing more can be handed in, not that there is nothing to hand in', () => {
    expect(signoff.REVISION_IN_FLIGHT_REASON).toBe('Your last revision is still being reviewed, so nothing more can be handed in until its verdict is in.');
  });
});
