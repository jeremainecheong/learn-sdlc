// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseSummary, PhaseTaskView } from '@learnsdlc/shared';

/**
 * The one pass banner, which every room of a passed phase mounts.
 *
 * Every sub-route of a passed phase carries the banner and its Continue
 * control, not only the phase room and the requirements workspace: a learner
 * who comes back to the design studio, the case file, the change request, the
 * pull request, the kill matrix or the reference solution is told the phase
 * passed and offered a way on.
 *
 * The real merge sheet, the real button, the real door routing and the real
 * copy are mounted here. Only the network, the router and the shell's held
 * project are controlled; no private account, provider or browser is used.
 */
const rig = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  reflect: vi.fn(),
  advance: vi.fn(),
  invalidate: vi.fn(),
  records: vi.fn(),
  project: null as { enrollment: EnrollmentView | null; details?: Record<string, Partial<PhaseDetail>> } | null,
  calls: [] as string[],
}));
vi.mock('next/navigation', () => ({ useRouter: () => rig.router }));
vi.mock('@/lib/api', () => ({ api: { reflect: rig.reflect, advance: rig.advance } }));
vi.mock('@/lib/records', () => ({ refreshPhaseRecords: rig.records }));
vi.mock('@/lib/useProject', () => ({
  useProjectMaybe: () => rig.project,
  invalidateProject: rig.invalidate,
}));
// The document frame's surroundings: the shell chrome, the case-file panel and
// the mentor column. The frame's own banner, and the banner's own button, sheet
// and routing, stay real: they are what these tests are about.
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/components/shell', () => ({
  DocPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  WorkPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PhaseStrip: () => null,
}));
vi.mock('@/components/shell/PersonaPanel', () => ({ PersonaPanel: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  WorkspacePanelControls: () => null,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
  useWorkspacePanels: () => ({
    briefId: 'brief-panel', mentorId: 'mentor-panel', briefOpen: false, mentorOpen: false,
    setBriefOpen: () => undefined, setMentorOpen: () => undefined,
  }),
}));

import { PhaseGateBanner, ShellPhaseGateBanner } from '@/components/workspace/PhaseGateBanner';
import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';

const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
function phase(order: number, over: Partial<PhaseSummary> = {}): PhaseSummary {
  return {
    id: `phase-${order}`,
    key: KEYS[order - 1],
    order,
    title: KEYS[order - 1][0].toUpperCase() + KEYS[order - 1].slice(1),
    status: 'in_progress',
    bestScore: null,
    attempts: 0,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    ...over,
  };
}
/** Six phases, with this one's fields written over the second. */
function enrolled(over: Partial<PhaseSummary> = {}): EnrollmentView {
  const phases = [1, 2, 3, 4, 5, 6].map((order) => (order === 2 ? phase(2, over) : phase(order)));
  return {
    id: 'enrolment-1',
    projectSlug: 'tasktrackr',
    projectTitle: 'TaskTrackr',
    currentPhaseOrder: 2,
    completed: false,
    startedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    phases,
  } as EnrollmentView;
}

let root: Root, host: HTMLDivElement;
const render = (element: ReactElement) => act(async () => { root.render(element); });
const banner = () => host.querySelector('[data-testid="gate-banner"]');
const control = () => host.querySelector<HTMLButtonElement>('[data-testid="open-reflection"]');
const sheet = () => document.querySelector('[data-testid="reflection-modal"]');
const openSheet = () => act(async () => { fireEvent.click(control()!); });
const confirm = () => act(async () => {
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="reflection-submit"]')!);
});
/** A reflection the API keeps: at least twenty characters once trimmed. */
const WRITTEN = 'The review made me name the boundary before the rule.';
const write = (text: string) => act(async () => {
  fireEvent.change(document.querySelector<HTMLTextAreaElement>('[data-testid="reflection-input"]')!, {
    target: { value: text },
  });
});
const submitButton = () => document.querySelector<HTMLButtonElement>('[data-testid="reflection-submit"]');
const countLine = () => document.querySelector('[data-testid="reflection-count"]')?.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  rig.calls = [];
  window.sessionStorage.clear();
  rig.project = { enrollment: enrolled({ status: 'passed' }) };
  rig.reflect.mockImplementation(async () => { rig.calls.push('reflect'); return { saved: true }; });
  rig.advance.mockImplementation(async () => {
    rig.calls.push('advance');
    return { ...enrolled({ status: 'passed' }), currentPhaseOrder: 3 };
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** A room that holds the phase passes it, which is every room but the frame. */
const room = (over: Partial<PhaseSummary> = {}, props: Record<string, unknown> = {}) => (
  <PhaseGateBanner phaseId="phase-2" phase={phase(2, { status: 'passed', ...over })} isLast={false} {...props} />
);

describe('PhaseGateBanner', () => {
  it('draws nothing for a phase that has not passed', async () => {
    await render(room({ status: 'in_progress' }));
    expect(banner()).toBeNull();
    expect(control()).toBeNull();
  });

  it('draws nothing while the room has no phase yet', async () => {
    await render(<PhaseGateBanner phaseId="phase-2" phase={null} isLast={false} />);
    expect(banner()).toBeNull();
  });

  it('draws the pass banner and the continue control for a passed phase', async () => {
    await render(room());
    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain('Phase evidence accepted');
    expect(control()).not.toBeNull();
    // The class two verification scripts measure the mobile banner by.
    expect(banner()!.classList.contains('phase-gate-banner')).toBe(true);
  });

  it('draws exactly one banner and one continue control', async () => {
    await render(room());
    expect(host.querySelectorAll('[data-testid="gate-banner"]').length).toBe(1);
    expect(host.querySelectorAll('[data-testid="open-reflection"]').length).toBe(1);
  });

  it('says the merge message is recorded once a reflection exists', async () => {
    await render(room({ reflection: 'what changed' }));
    expect(banner()!.textContent).toContain('Merge message recorded.');
    await render(room());
    expect(banner()!.textContent).toContain('Continue when ready');
  });

  it('offers to complete the course on the last phase', async () => {
    await render(room());
    expect(control()!.textContent).toContain('Continue to next phase');
    await render(room({}, { isLast: true }));
    expect(control()!.textContent).toContain('Complete the project');
  });

  /**
   * The seam a room needs if its own surface cannot carry the shared chrome.
   * The two must never be applied at once (a room class that sets its own
   * background, padding and type would be fighting the shared one for every
   * declaration) so `className` replaces the chrome rather than adding to it.
   * All six rooms take the shared chrome; only `phase-gate-banner`,
   * which the two verification scripts measure, is kept either way.
   */
  it('lets a room replace the shared chrome with its own treatment', async () => {
    await render(room({}, { className: 'requirements-gate' }));
    expect(banner()!.className).toBe('phase-gate-banner requirements-gate');
    expect(banner()!.textContent).toContain('Phase evidence accepted');
    expect(control()).not.toBeNull();
  });

  it('flushes the room\'s buffer before recording the reflection', async () => {
    await render(
      room({}, { onBeforeContinue: async () => { rig.calls.push('before'); } }),
    );
    await openSheet();
    await write(WRITTEN);
    await confirm();
    expect(rig.calls).toEqual(['before', 'reflect', 'advance']);
    expect(rig.reflect).toHaveBeenCalledWith('phase-2', WRITTEN);
    expect(rig.invalidate).toHaveBeenCalled();
    expect(rig.records).toHaveBeenCalledWith('phase-2');
  });

  it('keeps the learner in the room when the room refuses to continue', async () => {
    const refusal = 'Finish the mentor operation and save or cancel your backlog draft before continuing.';
    await render(
      room({}, { onBeforeContinue: () => Promise.reject(new Error(refusal)) }),
    );
    await openSheet();
    await confirm();
    expect(rig.reflect).not.toHaveBeenCalled();
    expect(rig.advance).not.toHaveBeenCalled();
    expect(rig.router.push).not.toHaveBeenCalled();
    expect(sheet()!.textContent).toContain(refusal);
  });

  /**
   * A room that holds copies of its own drops them once the advance has
   * landed, not in the guard. The guard runs before the reflection and the
   * advance, so a cache emptied there can be refilled by a read of the phase
   * as it still was, with nothing left afterwards to clear it.
   */
  it('lets the room drop its held copies after the advance, never before it', async () => {
    await render(
      room({}, {
        onBeforeContinue: async () => { rig.calls.push('before'); },
        onAdvanced: () => { rig.calls.push('cleared'); },
      }),
    );
    await openSheet();
    await write(WRITTEN);
    await confirm();
    expect(rig.calls).toEqual(['before', 'reflect', 'advance', 'cleared']);
  });

  it('leaves the room\'s held copies alone when the advance never lands', async () => {
    rig.advance.mockRejectedValue(new Error('The advance could not be recorded.'));
    await render(room({}, { onAdvanced: () => { rig.calls.push('cleared'); } }));
    await openSheet();
    await write(WRITTEN);
    await confirm();
    expect(rig.calls).toEqual(['reflect']);
    expect(rig.router.push).not.toHaveBeenCalled();
    expect(sheet()!.textContent).toContain('The advance could not be recorded.');
  });

  it('opens the next phase\'s door after a successful advance', async () => {
    await render(room());
    await openSheet();
    await confirm();
    // The next phase's room, in one step: no case file in front of it.
    expect(rig.router.push).toHaveBeenCalledWith('/workspace/phase-3');
  });

  it('sends a finished learner to the completion page', async () => {
    rig.advance.mockImplementation(async () => {
      rig.calls.push('advance');
      return { ...enrolled({ status: 'passed' }), completed: true, currentPhaseOrder: 6 };
    });
    await render(room());
    await openSheet();
    await confirm();
    expect(rig.router.push).toHaveBeenCalledWith('/complete');
  });

  /**
   * The phase room keeps the sheet's open state because three of its own
   * keyboard shortcuts are suppressed while the sheet is up.
   */
  it('lets a room own whether the merge sheet is open', async () => {
    const changed = vi.fn();
    await render(room({}, { open: false, onOpenChange: changed }));
    await openSheet();
    expect(changed).toHaveBeenCalledWith(true);
    expect(sheet()).toBeNull();
    await render(room({}, { open: true, onOpenChange: changed }));
    expect(sheet()).not.toBeNull();
  });
});

describe('ShellPhaseGateBanner', () => {
  it('announces a passed phase the shell is holding', async () => {
    await render(<ShellPhaseGateBanner phaseId="phase-2" />);
    expect(banner()).not.toBeNull();
    expect(control()!.textContent).toContain('Continue to next phase');
  });

  it('offers to complete the course on the enrolment\'s last phase', async () => {
    rig.project = { enrollment: enrolled() };
    rig.project.enrollment!.phases[5] = phase(6, { status: 'passed' });
    await render(<ShellPhaseGateBanner phaseId="phase-6" />);
    expect(control()!.textContent).toContain('Complete the project');
  });

  it('draws nothing for a phase that has not passed', async () => {
    rig.project = { enrollment: enrolled({ status: 'in_progress' }) };
    await render(<ShellPhaseGateBanner phaseId="phase-2" />);
    expect(banner()).toBeNull();
  });

  it('draws nothing outside the project provider', async () => {
    rig.project = null;
    await render(<ShellPhaseGateBanner phaseId="phase-2" />);
    expect(banner()).toBeNull();
  });

  it('draws nothing for a phase the enrolment does not carry', async () => {
    await render(<ShellPhaseGateBanner phaseId="phase-nowhere" />);
    expect(banner()).toBeNull();
  });
});

/**
 * The frame carries six document routes, and two of them (the change request
 * and the incident drill) hold a debounced workspace buffer whose only other
 * flush is an unawaited one during unmount, after the router has already left.
 * On the last phase Continue completes the project, so an advance recorded
 * ahead of the write is edits the learner cannot get back. The frame therefore
 * takes the room's guard and hands it to the banner, exactly as the phase room
 * and the design studio pass their own.
 */
describe('PhaseDocumentFrame', () => {
  beforeEach(() => {
    rig.project = { enrollment: enrolled() };
    rig.project.enrollment!.phases[5] = phase(6, { status: 'passed' });
    rig.advance.mockImplementation(async () => {
      rig.calls.push('advance');
      return { ...enrolled(), completed: true, currentPhaseOrder: 6 };
    });
  });
  const frame = (props: Record<string, unknown> = {}) => (
    <PhaseDocumentFrame
      phase={{ id: 'phase-6', key: 'maintenance', title: 'Maintenance' }}
      view="change"
      {...props}
    />
  );

  it('announces the passed phase on a document route', async () => {
    await render(frame());
    expect(banner()).not.toBeNull();
    expect(control()!.textContent).toContain('Complete the project');
  });

  it('flushes the room\'s buffer before recording the advance', async () => {
    await render(frame({ onBeforeContinue: async () => { rig.calls.push('before'); } }));
    await openSheet();
    await write(WRITTEN);
    await confirm();
    expect(rig.calls).toEqual(['before', 'reflect', 'advance']);
  });

  it('records nothing when the room\'s buffer will not save', async () => {
    const refusal = 'Your changes could not be saved. Try again before continuing.';
    await render(frame({ onBeforeContinue: () => Promise.reject(new Error(refusal)) }));
    await openSheet();
    await confirm();
    expect(rig.reflect).not.toHaveBeenCalled();
    expect(rig.advance).not.toHaveBeenCalled();
    expect(rig.router.push).not.toHaveBeenCalled();
    expect(sheet()!.textContent).toContain(refusal);
  });

  it('continues straight away from a document that holds no buffer', async () => {
    await render(frame({ view: 'brief' }));
    await openSheet();
    await confirm();
    // Nothing written, so nothing posted for it.
    expect(rig.calls).toEqual(['advance']);
    expect(rig.router.push).toHaveBeenCalledWith('/complete');
  });
});

/**
 * "Reflection is optional" must be true: an empty box is never refused. The
 * rule the API pins (`reflect-dto.spec.ts`): a reflection is
 * optional, advancing never reads it, and a written one is at least twenty
 * characters. So an empty box posts nothing, and a started one waits until it
 * is a reflection or nothing.
 */
describe('the merge sheet and the optional reflection', () => {
  it('continues with an empty box, posting no reflection at all', async () => {
    await render(room());
    await openSheet();
    expect(countLine()).toBe('Reflection is optional');
    expect(submitButton()!.disabled).toBe(false);
    await confirm();
    expect(rig.reflect).not.toHaveBeenCalled();
    expect(rig.calls).toEqual(['advance']);
    // The next phase's room, in one step: no case file in front of it.
    expect(rig.router.push).toHaveBeenCalledWith('/workspace/phase-3');
  });

  it('treats a box of spaces as empty', async () => {
    await render(room());
    await openSheet();
    await write('    \n  ');
    expect(submitButton()!.disabled).toBe(false);
    await confirm();
    expect(rig.reflect).not.toHaveBeenCalled();
    expect(rig.calls).toEqual(['advance']);
  });

  it('holds Continue while a started reflection is under twenty characters, and says how to go on', async () => {
    await render(room());
    await openSheet();
    await write('Too short');
    expect(submitButton()!.disabled).toBe(true);
    expect(countLine()).toBe('11 more characters, or clear it to continue without one');
    await write('Nineteen characters');
    expect(countLine()).toBe('1 more character, or clear it to continue without one');
    expect(submitButton()!.disabled).toBe(true);
    // Clearing it is the other way on.
    await write('');
    expect(submitButton()!.disabled).toBe(false);
    expect(countLine()).toBe('Reflection is optional');
  });

  it('counts characters the way the API does, so an emoji is one character, not two', async () => {
    // `ReflectDto`'s `@MinLength(20)` is class-validator's `isLength`, which
    // counts a surrogate pair (and a character with its presentation selector)
    // as one. `String.length` counts UTF-16 units, so counted that way ten
    // emoji would read as twenty here and the route would refuse them with a 400.
    await render(room());
    await openSheet();
    await write('\u{1F642}'.repeat(10));
    expect(countLine()).toBe('10 more characters, or clear it to continue without one');
    expect(submitButton()!.disabled).toBe(true);
    await write('✔️'.repeat(19));
    expect(countLine()).toBe('1 more character, or clear it to continue without one');
    expect(submitButton()!.disabled).toBe(true);
    await write('\u{1F642}'.repeat(20));
    expect(submitButton()!.disabled).toBe(false);
    await confirm();
    expect(rig.reflect).toHaveBeenCalledWith('phase-2', '\u{1F642}'.repeat(20));
    expect(rig.calls).toEqual(['reflect', 'advance']);
  });

  it('posts a written reflection, trimmed, before the advance', async () => {
    await render(room());
    await openSheet();
    await write(`  ${WRITTEN}  `);
    expect(submitButton()!.disabled).toBe(false);
    await confirm();
    expect(rig.reflect).toHaveBeenCalledWith('phase-2', WRITTEN);
    expect(rig.calls).toEqual(['reflect', 'advance']);
  });

  it('says the phase is optional-to-reflect on and never asks for a message to unlock it', async () => {
    await render(room());
    await openSheet();
    expect(sheet()!.textContent).toContain('Optionally record what you learned');
    expect(sheet()!.textContent).not.toMatch(/needs a message|required/i);
  });
});

/**
 * A teacher signed off the phase's required task, so the phase reads passed,
 * but a countersignature is the second half of a pass and the gate still
 * wants a reviewed revision of that task, so Continue would be refused. The
 * API says so up front (`evidenceNeeded`), and the room offers the task's
 * submit door instead.
 */
describe('a phase passed on the board, not yet reviewed', () => {
  const tasks = [
    { key: 'main', order: 1, required: true, title: 'The design', artefactType: 'design', artefactPath: 'design/design.json' },
    { key: 'clash-decision', order: 2, required: true, title: 'The clash decision', artefactType: 'document' },
    { key: 'design-quiz', order: 3, required: true, title: 'Design concepts', artefactType: 'quiz' },
  ] as unknown as PhaseTaskView[];
  const signedOff = (over: Partial<PhaseDetail> = {}) =>
    room({ key: 'design', tasks, evidenceNeeded: [{ key: 'clash-decision', title: 'The clash decision' }], ...over } as Partial<PhaseSummary>);

  it('offers the named task\'s submit door and no Continue', async () => {
    await render(signedOff());
    expect(banner()).not.toBeNull();
    expect(banner()!.getAttribute('data-gate')).toBe('evidence-needed');
    expect(control()).toBeNull();
    expect(banner()!.textContent).not.toContain('Phase evidence accepted');
    expect(banner()!.textContent).toContain('Passed on the board, not yet reviewed');
    // Neutral about who wrote the board: the field is also served over a
    // stored pass that no teacher touched and the gate reads as no evidence,
    // so "Your teacher credited" would not always be true.
    expect(banner()!.textContent).toContain('The clash decision is marked passed, but has no reviewed pass of its own yet');
    expect(banner()!.textContent).not.toContain('teacher');
    const door = host.querySelector('[data-testid="gate-evidence-submit-clash-decision"]');
    expect(door?.textContent).toContain('Submit The clash decision for review');
    // The task list's own door: a second written task (a version from before
    // the markdown kind was retired) opens Design's own room, never an editor
    // of its own.
    expect(door?.getAttribute('href')).toBe('/workspace/phase-2/design');
  });

  it('names every task still waiting, each with its own door', async () => {
    await render(
      signedOff({
        evidenceNeeded: [
          { key: 'main', title: 'The design' },
          { key: 'design-quiz', title: 'Design concepts' },
        ],
      }),
    );
    expect(banner()!.textContent).toContain(
      'The design and Design concepts are marked passed, but have no reviewed pass of their own yet',
    );
    expect(banner()!.textContent).toContain('The next phase opens once each has one, so submit each one for review');
    // The phase room's own task opens the phase room; a quiz opens its paper.
    expect(host.querySelector('[data-testid="gate-evidence-submit-main"]')?.getAttribute('href')).toBe('/workspace/phase-2/design');
    expect(host.querySelector('[data-testid="gate-evidence-submit-design-quiz"]')?.getAttribute('href')).toBe(
      '/workspace/phase-2/quiz?task=design-quiz',
    );
    expect(control()).toBeNull();
  });

  it('on the last phase, says the project completes rather than a next phase opening', async () => {
    // There is no next phase after the last one, so the sentence the
    // banner says over a signed-off last phase is the one Continue would have
    // said (the project completes) and still offers the door, not Continue.
    await render(
      <PhaseGateBanner
        phaseId="phase-2"
        phase={phase(2, {
          status: 'passed',
          key: 'design',
          tasks,
          evidenceNeeded: [{ key: 'clash-decision', title: 'The clash decision' }],
        } as Partial<PhaseSummary>)}
        isLast
      />,
    );
    expect(banner()!.textContent).toContain('The project completes once it has one');
    expect(banner()!.textContent).not.toContain('next phase');
    expect(host.querySelector('[data-testid="gate-evidence-submit-clash-decision"]')).not.toBeNull();
    expect(control()).toBeNull();
  });

  it('sends a phase with one task to its own room', async () => {
    await render(room({ key: 'requirements', evidenceNeeded: [{ key: '', title: 'Requirements' }] } as Partial<PhaseSummary>));
    const door = host.querySelector('[data-testid="gate-evidence-submit-phase"]');
    expect(door?.getAttribute('href')).toBe('/workspace/phase-2/issue');
    expect(door?.textContent).toContain('Submit Requirements for review');
    expect(control()).toBeNull();
  });

  it('is the ordinary pass banner once the field is gone', async () => {
    await render(signedOff({ evidenceNeeded: undefined }));
    expect(banner()!.textContent).toContain('Phase evidence accepted');
    expect(control()).not.toBeNull();
    await render(signedOff({ evidenceNeeded: [] }));
    expect(control()).not.toBeNull();
  });

  it('draws nothing at all for a phase that has not passed, whatever the field says', async () => {
    await render(signedOff({ status: 'in_progress' }));
    expect(banner()).toBeNull();
  });

  it('says a quiz with no paper left needs a reset, and offers its room rather than a submit', async () => {
    // A Sign off on a quiz whose papers are all spent must not leave a
    // "Submit … for review" door into a room that cannot hand out a paper.
    // The API marks that gap, and the banner says who can open it.
    await render(
      signedOff({
        evidenceNeeded: [
          { key: 'clash-decision', title: 'The clash decision' },
          { key: 'design-quiz', title: 'Design concepts', noPapersLeft: true },
        ],
      }),
    );
    const text = banner()!.textContent ?? '';
    expect(text).toContain('Design concepts has no papers left, so your teacher has to reset it before you can sit it again');
    expect(host.querySelector('[data-testid="gate-evidence-submit-design-quiz"]')).toBeNull();
    const open = host.querySelector('[data-testid="gate-evidence-open-design-quiz"]');
    expect(open?.textContent).toContain('Open Design concepts');
    expect(open?.getAttribute('href')).toBe('/workspace/phase-2/quiz?task=design-quiz');
    // The written task beside it keeps its own submit door.
    expect(host.querySelector('[data-testid="gate-evidence-submit-clash-decision"]')).not.toBeNull();
    expect(control()).toBeNull();
  });

  it('on the last phase, names an earlier phase completion checks again, with that phase\'s door', async () => {
    // `advance` on the last phase re-checks every earlier phase, so a teacher's
    // reopen of an earlier phase must not leave this room drawing
    // "Complete the project" over a refusal: the API names the phase it refused on.
    await render(
      <PhaseGateBanner
        phaseId="phase-6"
        phase={phase(6, {
          status: 'passed',
          evidenceNeeded: [
            { key: '', title: 'Requirements', phaseId: 'phase-1', phaseKey: 'requirements', phaseTitle: 'Requirements' },
            { key: 'story', title: 'The story', phaseId: 'phase-2', phaseKey: 'design', phaseTitle: 'Design' },
          ],
        } as Partial<PhaseSummary>)}
        isLast
      />,
    );
    const text = banner()!.textContent ?? '';
    expect(text).toContain('An earlier phase needs a reviewed pass again');
    expect(text).toContain('Requirements and The story in Design have no reviewed pass that counts now');
    expect(text).toContain('The project completes once every phase has one');
    expect(host.querySelector('[data-testid="gate-evidence-open-requirements-phase"]')?.getAttribute('href')).toBe(
      '/workspace/phase-1/issue',
    );
    expect(host.querySelector('[data-testid="gate-evidence-open-design-story"]')?.getAttribute('href')).toBe(
      '/workspace/phase-2?task=story',
    );
    expect(control()).toBeNull();
  });

  it('reads the gate from the shell\'s summaries on a document route', async () => {
    rig.project = {
      enrollment: enrolled({ status: 'passed' }),
      details: { 'phase-2': { tasks, evidenceNeeded: [{ key: 'clash-decision', title: 'The clash decision' }] } },
    };
    await render(<ShellPhaseGateBanner phaseId="phase-2" />);
    expect(control()).toBeNull();
    expect(host.querySelector('[data-testid="gate-evidence-submit-clash-decision"]')?.getAttribute('href')).toBe(
      '/workspace/phase-2/design',
    );
  });
});

/**
 * A phase passed ahead of the learner, and the blocking colour.
 *
 * After a teacher's Unlock early and Pass on a phase the learner has not
 * reached, that phase's rooms must not say "Phase evidence accepted" with a
 * Continue the server refuses ("This phase must pass before advancing."). The
 * API says so (`notReachedYet`), and the banner says the true thing: the phase
 * is marked passed, it is ahead, and Continue opens once the learner gets
 * there. And the "passed on the board, not yet reviewed" banner blocks the
 * learner, so it is drawn in the waiting colour, not the pass colour.
 */
describe('a phase passed ahead of the learner', () => {
  const ahead = (over: Partial<PhaseDetail> = {}) =>
    room({ key: 'design', notReachedYet: true, ...over } as Partial<PhaseSummary>);

  beforeEach(() => {
    // The learner stands on Requirements; Design, ahead of them, reads passed.
    rig.project = { enrollment: { ...enrolled({ status: 'passed' }), currentPhaseOrder: 1 } };
  });

  it('offers no Continue, and says the phase is ahead rather than that it must pass', async () => {
    await render(ahead());
    expect(banner()).not.toBeNull();
    expect(banner()!.getAttribute('data-gate')).toBe('not-reached');
    expect(control()).toBeNull();
    const text = banner()!.textContent ?? '';
    expect(text).not.toContain('Phase evidence accepted');
    expect(text).toContain('Design is marked passed, but it is ahead of the phase you are on');
    expect(text).toContain('Continue opens here once you reach it, so finish the phase you are on first');
    // Nothing the server would refuse is offered.
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(rig.advance).not.toHaveBeenCalled();
  });

  it('says the same outside the shell', async () => {
    rig.project = null;
    await render(ahead());
    expect(control()).toBeNull();
    expect(banner()!.textContent).toContain('Continue opens here once you reach it');
  });

  it('reads the field from the shell’s summaries on a document route', async () => {
    rig.project = {
      enrollment: { ...enrolled({ status: 'passed' }), currentPhaseOrder: 1 },
      details: { 'phase-2': { notReachedYet: true } },
    };
    await render(<ShellPhaseGateBanner phaseId="phase-2" />);
    expect(banner()!.getAttribute('data-gate')).toBe('not-reached');
    expect(control()).toBeNull();
  });

  it('is the ordinary pass banner once the learner reaches it', async () => {
    rig.project = { enrollment: enrolled({ status: 'passed' }) };
    await render(ahead({ notReachedYet: undefined }));
    expect(control()).not.toBeNull();
  });

  /*
   * Over a teacher's board-only Pass the promise "Continue opens here once
   * you reach it" alone is false: reaching the phase leaves the strict gate
   * wanting the learner's own reviewed pass, and the room then turns into
   * "Passed on the board, not yet reviewed". The API names that gap on the
   * ahead phase (`evidenceNeeded` beside
   * `notReachedYet`), and the banner says both true things at once.
   */
  it('does not promise Continue on reaching a phase passed on the board alone, and offers its review', async () => {
    await render(ahead({ evidenceNeeded: [{ key: '', title: 'Design' }] }));
    expect(banner()!.getAttribute('data-gate')).toBe('not-reached');
    expect(control()).toBeNull();
    const text = banner()!.textContent ?? '';
    expect(text).toContain('Design is marked passed, but it is ahead of the phase you are on');
    expect(text).toContain('has no reviewed pass of its own yet');
    expect(text).not.toContain('Continue opens here once you reach it, so');
    expect(text).toContain('Continue opens here once you reach it and it has one, so submit it for review');
    expect(host.querySelector('[data-testid="gate-evidence-submit-phase"]')?.getAttribute('href')).toBe(
      '/workspace/phase-2/design',
    );
    expect(banner()!.getAttribute('class') ?? '').toContain('bg-warntint');
  });

  it('names each task still waiting on a split phase, and the quiz only a reset reopens', async () => {
    await render(
      ahead({
        tasks: [
          { key: 'story', title: 'The story', required: true } as PhaseTaskView,
          { key: 'quiz', title: 'The quiz', required: true } as PhaseTaskView,
        ],
        evidenceNeeded: [
          { key: 'story', title: 'The story' },
          { key: 'quiz', title: 'The quiz', noPapersLeft: true },
        ],
      }),
    );
    const text = banner()!.textContent ?? '';
    expect(text).toContain('The story and The quiz have no reviewed pass of their own yet');
    expect(text).toContain('so submit The story for review');
    expect(text).toContain('The quiz has no papers left, so your teacher has to reset it');
    expect(host.querySelector('[data-testid="gate-evidence-submit-story"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="gate-evidence-open-quiz"]')).not.toBeNull();
    expect(control()).toBeNull();
  });
});

describe('the blocking banner is not drawn in the pass colour', () => {
  const gaps = [{ key: '', title: 'Design' }];

  it('draws the evidence-needed banner in the waiting colour', async () => {
    await render(room({ key: 'design', evidenceNeeded: gaps } as Partial<PhaseSummary>));
    const classes = banner()!.getAttribute('class') ?? '';
    expect(classes).toContain('bg-warntint');
    expect(classes).not.toContain('bg-passtint');
    expect(banner()!.querySelector('svg')?.getAttribute('class') ?? '').not.toContain('text-pass');
  });

  it('keeps a room’s own chrome but swaps its pass tint for the waiting one', async () => {
    await render(
      room({ key: 'design', evidenceNeeded: gaps } as Partial<PhaseSummary>, {
        className: 'phase-gate-banner-quiz flex rounded-panel bg-passtint px-4',
      }),
    );
    const classes = banner()!.getAttribute('class') ?? '';
    expect(classes).toContain('phase-gate-banner-quiz');
    expect(classes).toContain('bg-warntint');
    expect(classes).not.toContain('bg-passtint');
  });

  it('keeps the pass colour on a phase that really is through its gate', async () => {
    await render(room());
    expect(banner()!.getAttribute('class') ?? '').toContain('bg-passtint');
  });
});
