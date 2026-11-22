// @vitest-environment jsdom
/**
 * Two copy rules, each on the component that draws it.
 *
 *  - After a publish, "Version 1.0.0 is published" is said once, by the
 *    confirmation, and not again by the line under the (now disabled)
 *    Publish button.
 *  - A written story being marked does not read "Reviewing your pull
 *    request…": a written phase has no pull request; every phase has a
 *    submission.
 *
 * The audit-row wording ("Reset X" beside "Signed off X in Design") is
 * pinned in `audit-task-labels.test.ts`, and the sign-off question's wording in
 * `teacher-task-levers.test.tsx`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubmissionView } from '@learnsdlc/shared';
import { PublishPanel } from '@/components/staff/projects/PublishPanel';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const PUBLISHED_REASON = 'Version 1.0.0 is published, and a published version never changes. Publish a new version to change what a class works on.';

describe('the publish panel after a publish', () => {
  const draw = (published: { version: string; publishedAt: string; sandboxBudget: number } | null) =>
    act(() =>
      root.render(
        <PublishPanel
          draftVersion="1.0.0"
          report={{ publishable: true, failed: 0, blocking: [] } as never}
          editable={false}
          readOnlyReason={PUBLISHED_REASON}
          publishing={false}
          error=""
          published={published}
          onPublish={() => {}}
        />,
      ),
    );

  it('says the version is published once, in the receipt', async () => {
    draw({ version: '1.0.0', publishedAt: '2026-09-28T14:20:00.000Z', sandboxBudget: 20 });
    expect(host.querySelector('[data-testid="project-published"]')?.textContent).toContain('Version 1.0.0 is published.');
    // Drawn once. The disabled button still carries the reason as its
    // accessible description (sr-only), which is the control's, not a line.
    const drawn = [...host.querySelectorAll('*')]
      .filter((node) => !node.closest('.sr-only') && [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent?.includes('1.0.0 is published')))
      .length;
    expect(drawn).toBe(1);
    expect(host.querySelector('[data-testid="project-publish-reason"]')).toBeNull();
    // Once published here the receipt is the panel; the greyed
    // form and Publish button that stood under it are gone.
    expect(host.querySelector('[data-testid="project-publish"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-publish-version"]')).toBeNull();
  });

  it('keeps the reason under the button on a version opened already published', async () => {
    draw(null);
    expect(host.querySelector('[data-testid="project-publish-reason"]')?.textContent).toBe(PUBLISHED_REASON);
  });
});

describe('the wait line while a written task is marked', () => {
  it('says a submission is being reviewed, not a pull request', async () => {
    const queued = { id: 'revision-1', taskKey: 'booking-story', status: 'queued', passed: null, score: null, report: null, createdAt: '2026-09-28T14:30:00.000Z' } as unknown as SubmissionView;
    await act(async () => root.render(<FeedbackPanel submission={queued} />));
    expect(host.querySelector('[data-testid="feedback-pending"]')?.textContent).toContain('Reviewing your submission…');
    expect(host.textContent).not.toContain('pull request');
  });
});
