// @vitest-environment jsdom
/**
 * The first-run page's class code field is the /join page's field:
 * the visible label "Class code" tied to the input, the same input rules, and
 * the same rule for the button that sends it (eight letters and digits).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';



const join = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'learner-1', displayName: 'A Learner', avatar: 0, profileVersion: 1 }),
  setSession: vi.fn(),
}));
vi.mock('@/lib/api-cohorts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-cohorts')>()),
  cohortsApi: { join: (...a: unknown[]) => join(...a) },
}));
vi.mock('@/lib/useProject', () => ({ invalidateProject: vi.fn() }));

import OnboardingPage from '@/app/(app)/onboarding/page';
import { settle } from './support/dom';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the first-run class code field is the /join field', () => {
  const mountSetup = async () => {
    await act(async () => root.render(<OnboardingPage />));
    await settle(6);
    await act(async () => {
      (host.querySelector('input[value="class"]') as HTMLInputElement).click();
    });
  };

  it('has a visible label, "Class code", tied to the input', async () => {
    await mountSetup();
    const input = host.querySelector<HTMLInputElement>('#onboarding-class-code')!;
    const label = host.querySelector<HTMLLabelElement>('label[for="onboarding-class-code"]')!;
    expect(label.textContent).toBe('Class code');
    expect(label.control).toBe(input);
    expect(label.classList.contains('sr-only')).toBe(false);
  });

  it("takes /join's input rules", async () => {
    await mountSetup();
    const input = host.querySelector<HTMLInputElement>('#onboarding-class-code')!;
    expect(input.maxLength).toBe(24);
    expect(input.getAttribute('autocapitalize')).toBe('characters');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.placeholder).toBe('ABCD-EFGH');
    expect(input.required).toBe(true);
    // /join's own field is rendered with the same rules in `finished-project-pages.test.tsx`.
  });

  it('keeps Start learning off until the code holds eight letters and digits, as /join keeps Join class', async () => {
    await mountSetup();
    const input = host.querySelector<HTMLInputElement>('#onboarding-class-code')!;
    const start = host.querySelector<HTMLButtonElement>('.onboarding-submit')!;
    expect(start.disabled).toBe(true);
    act(() => {
      fireEvent.change(input, { target: { value: 'ABCD-EFG' } });
    });
    expect(start.disabled).toBe(true);
    await act(async () => {
      fireEvent.submit(host.querySelector('form')!);
    });
    expect(join).not.toHaveBeenCalled();
    act(() => {
      fireEvent.change(input, { target: { value: 'abcd-efgh' } });
    });
    expect(start.disabled).toBe(false);
    // Learning independently needs no code.
    await act(async () => {
      (host.querySelector('input[value="solo"]') as HTMLInputElement).click();
    });
    expect(start.disabled).toBe(false);
  });
});

