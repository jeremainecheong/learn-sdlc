import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect }));

import LearnerDetailPage from '@/app/(app)/instructor/learners/[userId]/page';

describe('legacy learner route', () => {
  beforeEach(() => redirect.mockReset());

  it('waits for asynchronous route params before selecting the learner', async () => {
    let resolve!: (value: { userId: string }) => void;
    const params = new Promise<{ userId: string }>((done) => { resolve = done; });
    const rendering = LearnerDetailPage({ params });

    expect(redirect).not.toHaveBeenCalled();
    resolve({ userId: 'learner-123' });
    await rendering;

    expect(redirect).toHaveBeenCalledExactlyOnceWith('/teacher?learner=learner-123');
  });

  it('keeps the resolved route segment within the learner query value', async () => {
    await LearnerDetailPage({ params: Promise.resolve({ userId: 'learner&cohort=other' }) });
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/teacher?learner=learner%26cohort%3Dother');
  });
});
