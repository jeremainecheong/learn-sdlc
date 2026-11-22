// @vitest-environment jsdom
/**
 * What the signed-in frame mounts around every page, and in which order.
 *
 * The notices themselves are tested on their own (`session-notices.test.tsx`).
 * Here the frame is rendered with its neighbours stood in for, so a mount that
 * is deleted, doubled or moved below the offline line fails.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard', useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'learner-1', role: 'LEARNER', onboardingCompleted: true }),
}));
vi.mock('@/components/shell/Sidebar', () => ({ Sidebar: () => <nav data-testid="sidebar" /> }));
vi.mock('@/components/shell/TopBar', () => ({ TopBar: () => <header data-testid="top-bar" /> }));
vi.mock('@/components/shell/ViewAsBanner', () => ({ ViewAsBanner: () => <div data-testid="view-as" /> }));
vi.mock('@/components/shell/CoachMarks', () => ({ CoachMarks: () => null }));
vi.mock('@/components/shell/SessionNotices', () => ({ SessionNotices: () => <div data-testid="session-notices" /> }));

import { AppFrame } from '@/components/shell/AppFrame';

let root: Root, host: HTMLDivElement;
const online = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (online) Object.defineProperty(Navigator.prototype, 'onLine', online);
});

describe('the signed-in frame mounts the session notices', () => {
  it('renders them once, above the offline banner and above the page', async () => {
    // The offline line is drawn only while the browser says it is offline.
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });
    await act(async () => root.render(<AppFrame><main data-testid="page" /></AppFrame>));

    const notices = host.querySelectorAll('[data-testid="session-notices"]');
    const offline = host.querySelector('[data-testid="offline-banner"]');
    const page = host.querySelector('[data-testid="page"]');
    expect(notices).toHaveLength(1);
    expect(offline).not.toBeNull();
    // A session that has ended is why nothing below it can work, so it is
    // read first.
    expect(notices[0].compareDocumentPosition(offline!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(offline!.compareDocumentPosition(page!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('still renders them while the browser is online, when there is no offline line', async () => {
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true });
    await act(async () => root.render(<AppFrame><main data-testid="page" /></AppFrame>));

    expect(host.querySelectorAll('[data-testid="session-notices"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="offline-banner"]')).toBeNull();
  });
});
