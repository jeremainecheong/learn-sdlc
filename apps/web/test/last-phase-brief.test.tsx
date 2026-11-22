/**
 * On the project's last phase the brief closed with "This is
 * your project's last phase: once its work passes review, you can complete the
 * project." A phase with a task that needs the teacher's sign-off does not pass
 * on review (it waits for the countersignature), and a split phase passes only
 * when every required task has passed, so "once its work passes review" was
 * false there. The phase passing is what lets the learner complete the
 * project (advance() needs a strict pass on every phase), so the line now
 * says that, which is true in every one of those states.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PhaseBriefIntro } from '@/components/workspace/PhaseBriefIntro';
import { briefClosingLine } from '@/components/workspace/onward-copy';

const rig = vi.hoisted(() => ({ project: null as unknown }));
vi.mock('@/lib/useProject', () => ({ useProject: () => rig.project, useProjectMaybe: () => rig.project }));

const OLD_LAST = "This is your project's last phase: once its work passes review, you can complete the project.";
const LAST = "This is your project's last phase: once it passes, you can complete the project.";
const CARRY = 'Your saved work and real review evidence carry forward to the next phase.';

const row = (key: string, order: number) => ({ id: `ph-${key}`, key, order, title: key, status: order === 1 ? 'in_progress' : 'locked', bestScore: null, attempts: 0, reflection: null, passedAt: null });
const draw = (keys: string[], key: string) => {
  rig.project = { details: {}, loading: false, enrollment: { id: 'e', projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', currentPhaseOrder: 1, completed: false, releases: [], phases: keys.map((k, at) => row(k, at + 1)) } };
  return renderToStaticMarkup(<PhaseBriefIntro phaseKey={key as 'maintenance'} />).replaceAll('&#x27;', "'");
};

describe("the brief's closing line on the last phase", () => {
  it('says the phase passing is what completes the project, not its work passing review', () => {
    expect(briefClosingLine(true)).toBe(LAST);
    const html = draw(['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'], 'maintenance');
    expect(html).toContain(LAST);
    expect(html).not.toContain(OLD_LAST);
    expect(draw(['requirements', 'design', 'implementation', 'testing'], 'testing')).toContain(LAST);
  });
  it('a phase with one after it, and a room with no enrolment held, read the carry-on line', () => {
    expect(briefClosingLine(false)).toBe(CARRY);
    expect(draw(['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'], 'testing')).toContain(CARRY);
    rig.project = null;
    expect(renderToStaticMarkup(<PhaseBriefIntro phaseKey="maintenance" />)).toContain(CARRY);
  });
});
