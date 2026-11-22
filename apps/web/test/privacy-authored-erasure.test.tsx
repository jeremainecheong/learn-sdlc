/**
 * The privacy policy says what account deletion does to the projects a
 * teacher wrote.
 *
 * A teacher writes a copy's interview, backlog and replaced files as well as
 * its titles and briefs, and the account export carries them. Erasure
 * follows the `refused-then-archived` policy for `projects.ownerUserId`
 * (`account.service.ts` ACTOR_SCOPED_ENTITIES): refused while a class is pinned
 * to one of the project's published versions, otherwise archived rather than
 * deleted, and file contents are stored once by content and shared, so they are
 * never deleted. The policy page must say all of this.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/legal/LegalPage', () => ({
  LegalPage: ({ children }: { children: React.ReactNode }) => <article>{children}</article>,
}));

describe('the privacy policy on deleting a teacher account', () => {
  it('says how the projects a teacher wrote are erased', async () => {
    const Privacy = (await import('@/app/privacy/page')).default;
    const text = renderToStaticMarkup(<Privacy />).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const deleting = text.slice(text.indexOf('Deleting your account'), text.indexOf('Connection and execution security'));
    // The new content is named: the interview, the backlog and replaced files.
    expect(deleting).toMatch(/interview/i);
    expect(deleting).toMatch(/backlog/i);
    expect(deleting).toMatch(/replaced/i);
    // Refused while any enrolment resolves a published version (account.service
    // pinnedOwnedVersions counts learners, in a class or not); otherwise archived.
    expect(deleting).toMatch(/while any learner is still enrolled on one of their published versions/i);
    expect(deleting).toMatch(/archived/i);
    // Content-addressed file contents are never deleted.
    expect(deleting).toMatch(/file contents[^.]*never deleted/i);
  });
});
