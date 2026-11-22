import { expect, it, vi } from 'vitest';
import { mentorApi } from '@/lib/api-mentor';
const request = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('@/lib/api', () => ({ request, REVIEWED_AI_TIMEOUT_MS: 60_000 }));

it('sends the selected class to the authorized help endpoint before its result limit is applied', async () => {
  await mentorApi.stuckList({ project: 'tasktrackr', state: 'open', cohortId: 'class-1' });
  const [method, target] = request.mock.calls.at(-1)!;
  const url = new URL(target, 'http://test.local');
  expect(method).toBe('GET'); expect(url.pathname).toBe('/instructor/stuck');
  expect(Object.fromEntries(url.searchParams)).toEqual({ project: 'tasktrackr', state: 'open', cohortId: 'class-1' });
});
