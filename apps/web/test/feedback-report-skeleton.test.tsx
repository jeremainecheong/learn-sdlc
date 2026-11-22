// @vitest-environment jsdom
/**
 * The feedback report while a review is being written draws the report's
 * shape rather than a sentence alone, hidden from assistive technology (the
 * sheet's `.skeleton`).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubmissionView } from '@learnsdlc/shared';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';

let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const row = (over: Partial<SubmissionView>): SubmissionView => ({ id: 'r', status: 'completed', score: null, passed: false, verifiedPass: false, report: null, createdAt: '2026-10-31T00:00:00Z', ...over } as SubmissionView);

describe('the feedback report draws its states', () => {
  it('a review being written draws the report\'s shape, hidden from assistive technology', async () => {
    await act(async () => root.render(<FeedbackPanel submission={row({ status: 'running' as SubmissionView['status'] })} />));
    const skeleton = host.querySelector('[data-testid="feedback-pending"] .feedback-skeleton')!;
    expect(skeleton.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(3);
    expect(host.textContent).toContain('Reviewing your submission');
  });
});
