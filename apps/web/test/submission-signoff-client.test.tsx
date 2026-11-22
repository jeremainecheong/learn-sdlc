import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The sign-off client call, and the route it names. */
const request = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ request }));

import { experienceApi } from '@/lib/api-experience';

describe('experienceApi.submissionSignOff (FEEDBACK-G)', () => {
  beforeEach(() => request.mockReset());

  it('reads GET /submissions/:id/sign-off with the id encoded', async () => {
    request.mockResolvedValue({ signedOff: true, reason: 'Heard it in class.', signedOffAt: '2026-10-06T11:00:00.000Z' });
    await expect(experienceApi.submissionSignOff('a/b')).resolves.toEqual({
      signedOff: true, reason: 'Heard it in class.', signedOffAt: '2026-10-06T11:00:00.000Z',
    });
    expect(request).toHaveBeenCalledWith('GET', '/submissions/a%2Fb/sign-off');
  });
});
