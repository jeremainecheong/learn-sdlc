// @vitest-environment jsdom
/** The account entry keeps registration focused; class setup follows sign-in. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} data-testid={rest['data-testid'] as string | undefined}>
      {children}
    </a>
  ),
}));
// The Google button asks the server whether it exists; not the point here.
vi.mock('@/components/landing/GoogleSignIn', () => ({ GoogleSignIn: () => null }));
vi.mock('@/components/legal/LegalPage', () => ({ LegalPage: ({ children }: { children: React.ReactNode }) => <article>{children}</article> }));
vi.mock('@/components/landing/AuthLayout', () => ({
  AuthLayout: ({ children, purpose }: { children: React.ReactNode; purpose?: string }) => (
    <div>
      <p>{purpose}</p>
      {children}
    </div>
  ),
  AuthNotice: ({ children, testId }: { children: React.ReactNode; testId?: string }) => (
    <p data-testid={testId}>{children}</p>
  ),
  AuthRule: () => <hr />,
}));

describe('SignInPanel', () => {
  it('is one form and one line: no class code, no second address', async () => {
    const { SignInPanel } = await import('@/components/landing/SignInPanel');
    const html = renderToStaticMarkup(<SignInPanel />);
    expect(html).toContain('data-testid="login-submit"');
    expect(html).toContain('data-testid="email"');
    expect(html).toContain('data-testid="password"');
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('[data-testid="login-submit"]')?.hasAttribute('disabled')).toBe(true);
    expect(html).not.toContain('join-class-code');
    expect(html).not.toContain('join-university-email');
    expect(html).not.toContain('Class code');
  });

  it('links directly to account creation with the approved full-width action', async () => {
    const { SignInPanel } = await import('@/components/landing/SignInPanel');
    const html = renderToStaticMarkup(<SignInPanel />);
    expect(html).toContain('New here?');
    const document = new DOMParser().parseFromString(html, "text/html");
    const link = document.querySelector('[data-testid="to-register"]');
    expect(link?.getAttribute("href")).toBe("/register");
    expect(link?.textContent).toContain("Create an account");
    // The link carries no half-filled query: the code is typed once.
    expect(html).not.toContain('/register?');
  });

  it('offers to continue only when asked, and never on the server pass', async () => {
    const { SignInPanel } = await import('@/components/landing/SignInPanel');
    // Signed-out during SSR: the continue link waits for the effect that reads
    // storage, so static markup never draws it.
    expect(renderToStaticMarkup(<SignInPanel offerContinue />)).not.toContain('landing-continue');
    expect(renderToStaticMarkup(<SignInPanel />)).not.toContain('landing-continue');
  });
});

describe('the register page', () => {
  it('collects only account details, with optional membership handled after sign-in', async () => {
    const Page = (await import('@/app/register/page')).default;
    const html = renderToStaticMarkup(<Page />);
    expect(html).not.toContain('data-testid="register-code"');
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect([...document.querySelectorAll('input')].map(input => input.id)).toEqual(['displayName', 'email', 'password']);
    expect(html).toContain('data-testid="register-submit"');
    expect(document.querySelector('[data-testid="register-submit"]')?.hasAttribute('disabled')).toBe(true);
    expect(html).toContain('data-testid="to-login"');
  });

  it('links to terms and explains actual AI data sharing in the privacy policy', async () => {
    const Register = (await import('@/app/register/page')).default;
    const html = renderToStaticMarkup(<Register />);
    expect(html).toContain('href="/terms"');
    expect(html).not.toMatch(/your code is never sent|nothing you write here is used to train/i);
    const Privacy = (await import('@/app/privacy/page')).default;
    const policy = renderToStaticMarkup(<Privacy />);
    expect(policy).toContain('submitted editable source');
    expect(policy).toContain('Private mentor conversation text is excluded from teacher views');
    expect(policy).toContain('provider’s own retention and data-use practices depend');
  });
});
