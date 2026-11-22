import { describe, expect, it } from 'vitest';
import type { PhaseSummary } from '@learnsdlc/shared';
import { navigationItems, phaseItems } from '@/components/shell/navigation';

const phase: PhaseSummary = { id: 'phase-1', key: 'requirements', title: 'Requirements', order: 1, status: 'in_progress', attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null };
describe('search follows the approved role and phase navigation', () => {
  it('exposes learner destinations without the redundant legacy layout', () => {
    const items = navigationItems('LEARNER', phase);
    const links = items.map(row => row.href);
    expect(links).toContain('/feedback'); expect(links).toContain('/classroom'); expect(links).toContain('/profile');
    expect(items.find(row => row.label === 'My project')?.href).toBe('/workspace/phase-1/interview');
    expect(links).not.toContain('/journal'); expect(links).not.toContain('/artefacts'); expect(links).not.toContain('/phases'); expect(links).not.toContain('/teacher');
  });
  it('opens an interview-less phase\'s Requirements room from My project', () => {
    const none = { 'phase-1': { tasks: [], provenance: { application: undefined, interview: null } } };
    expect(navigationItems('LEARNER', phase, false, none).find(row => row.label === 'My project')?.href).toBe('/workspace/phase-1');
    expect(phaseItems([phase], 'phase-1', none)[0].href).toBe('/workspace/phase-1');
    // A held phase that has an interview, and a bare summary, keep the interview door.
    const held = { 'phase-1': { tasks: [], provenance: { interview: 'own' as const } } };
    expect(navigationItems('LEARNER', phase, false, held).find(row => row.label === 'My project')?.href).toBe('/workspace/phase-1/interview');
    expect(phaseItems([phase], 'phase-1')[0].href).toBe('/workspace/phase-1/interview');
  });
  it('gives teachers their classes and retains learner navigation only during explicit viewing', () => {
    const teacher = navigationItems('INSTRUCTOR', phase).map(row => row.href);
    expect(teacher).toContain('/teacher'); expect(teacher).not.toContain('/progress'); expect(teacher).not.toContain('/classroom'); expect(teacher).not.toContain('/admin');
    expect(navigationItems('ADMIN').map(row => row.href)).toContain('/admin');
    const view = navigationItems('INSTRUCTOR', phase, true).map(row => row.href);
    expect(view).toContain('/teacher'); expect(view).toContain('/progress');
  });
  it('keeps a locked phase discoverable without claiming it opens or providing an action', () => {
    const [locked, passed] = phaseItems([{ ...phase, status: 'locked' }, { ...phase, id: 'phase-2', status: 'passed' }]);
    expect(locked.disabled).toBe(true); expect(locked.hint).toBe('locked'); expect(locked.href).toBeUndefined();
    expect(passed.disabled).toBe(false); expect(passed.hint).toBe('passed'); expect(passed.href).toContain('/workspace/phase-2');
  });
  it('gives staff a first-class way to their projects, and learners none (F-a)', async () => {
    const teacher = navigationItems('INSTRUCTOR', phase);
    expect(teacher.find(row => row.href === '/teacher/projects')?.label).toBe('Projects');
    expect(navigationItems('ADMIN').map(row => row.href)).toContain('/teacher/projects');
    expect(navigationItems('LEARNER', phase).map(row => row.href)).not.toContain('/teacher/projects');
    const { navKeyFromPath } = await import('@/components/shell/Sidebar');
    expect(navKeyFromPath('/teacher/projects')).toBe('projects');
    expect(navKeyFromPath('/teacher/projects/p/versions/v')).toBe('projects');
    expect(navKeyFromPath('/teacher')).toBe('class');
    expect(navKeyFromPath('/teacher/class')).toBe('class');
  });
});
