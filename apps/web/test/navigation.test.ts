import { describe, expect, it } from 'vitest';
import { homeHrefFor, safeLocalPath } from '@/lib/navigation';

describe('local return destinations', () => {
  it.each(['https://outside.invalid', '//outside.invalid', '/\\outside.invalid', '/\t/outside.invalid', '/\r/outside.invalid', '/\n/outside.invalid', '/a/..//outside.invalid', '/../../..//outside.invalid', 'javascript:alert(1)', '\u0000/dashboard', '/dashboard\u007f'])('rejects %j before a router can normalize it into a different destination', value => {
    expect(safeLocalPath(value, '/teacher')).toBe('/teacher');
  });
  it('preserves local historical evidence links, query values and fragments', () => {
    expect(safeLocalPath('/feedback?phase=p1&submission=s2#files')).toBe('/feedback?phase=p1&submission=s2#files');
    expect(safeLocalPath('/teacher?search=late+tasks&returnTo=%2Fteacher')).toBe('/teacher?search=late+tasks&returnTo=%2Fteacher');
    expect(safeLocalPath('/profile/../account')).toBe('/account');
    expect(safeLocalPath(null, '/learn')).toBe('/learn');
  });
});

describe('role-aware home', () => {
  it('takes learners through setup and teachers directly to teaching', () => {
    expect(homeHrefFor({ role: 'LEARNER', onboardingCompleted: false })).toBe('/onboarding');
    expect(homeHrefFor({ role: 'LEARNER', onboardingCompleted: true })).toBe('/dashboard');
    expect(homeHrefFor({ role: 'INSTRUCTOR', onboardingCompleted: false })).toBe('/teacher');
    expect(homeHrefFor({ role: 'ADMIN' })).toBe('/teacher');
  });
});
