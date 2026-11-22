// @vitest-environment jsdom
/**
 * The teacher's project page, class page and sign-off queue, and the
 * "Awaiting your sign-off" figure's place. Each case fails when the behaviour
 * it names breaks.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { closureText, moduleText, webSource } from './support/source-text';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DraftPhaseView,
  DraftTaskView,
  InstructorPhaseView,
  SignoffQueueView,
  SubmissionView,
  ValidationReport,
} from '@learnsdlc/shared';
import { ASSIGNMENT_REASON_MIN, lockedCriterionRefusal } from '@learnsdlc/shared';

const queue = vi.fn();
const bulk = vi.fn();
const draft = vi.fn();
const assignable = vi.fn();
vi.mock('@/lib/api-projects', () => ({
  signoffApi: {
    queue: (...args: unknown[]) => queue(...args),
    bulk: (...args: unknown[]) => bulk(...args),
  },
  projectsApi: { draft: (...args: unknown[]) => draft(...args) },
}));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: { assignableProjects: (...args: unknown[]) => assignable(...args) },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { CriteriaCard } from '@/components/staff/projects/requirements/CriteriaCard';
import { ValidationReportPanel } from '@/components/staff/projects/ValidationReportPanel';
import { PublishPanel } from '@/components/staff/projects/PublishPanel';
import { configPhaseBudget, versionCountIsExact } from '@/components/staff/projects/VersionBudget';
import { ceilingLine } from '@/components/staff/projects/BudgetCeiling';
import { versionProvenanceSentence } from '@/components/staff/ClassProjectCard';
import { ClassLevers } from '@/components/staff/ClassLevers';
import {
  SIGNOFF_QUEUE_EMPTY_BODY,
  SIGNOFF_QUEUE_EMPTY_IN_USE_BODY,
  SignoffQueue,
  signoffQuestion,
  taskGroupHeading,
  versionInForceMarksSignoff,
} from '@/components/staff/SignoffQueue';
import { reasonCountText } from '@/components/staff/primitives';
import { classUsesSignoff, latestSubmissionState } from '@/components/staff/console/teacher-states';
import { settle, typeInto } from './support/dom';

function rules(css: string): Array<[string, string]> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2].trim()] as [string, string]);
}
const declsOf = (css: string, selector: string) =>
  rules(css)
    .filter(([sel]) => sel === selector)
    .map(([, d]) => d)
    .join(';');
const prop = (decls: string, name: string) =>
  new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(decls)?.[1].trim() ?? null;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function draw(node: React.ReactNode) {
  await act(async () => root.render(node));
  await settle(6);
}
async function click(id: string) {
  const el = q(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => el!.click());
  await settle(6);
}
function type(id: string, value: string) {
  const node = q(id) as HTMLTextAreaElement;
  act(() => {
    typeInto(node, value);
  });
}

/* ------------------- the purpose lines and the floors ------------------- */

const criteriaTask = (criteria: { key: string; title: string; weight: number }[]) =>
  ({
    taskKey: 'main',
    order: 1,
    title: 'Fix the badge',
    brief: '',
    objectives: [],
    artefactType: 'code',
    artefactPath: null,
    checkKind: 'code',
    required: true,
    owns: [],
    authorable: true,
    notice: null,
    rubric: { passThreshold: 70, criteria: criteria.map((one) => ({ ...one, description: 'd' })) },
  }) as unknown as DraftTaskView;

describe('the criteria card', () => {
  it('draws no rubric key, and a locked row says why by its title', async () => {
    await draw(
      <CriteriaCard
        task={criteriaTask([
          { key: 'correctness_hidden', title: 'Hidden tests', weight: 0.5 },
          { key: 'story_quality', title: 'Story, as worded', weight: 0.5 },
        ])}
        writeTask={vi.fn()}
        editable
        state="current"
        onFocusCard={vi.fn()}
        onSaved={vi.fn()}
        locked={['correctness_hidden']}
        work={{ subject: 'The change', verb: 'passes' }}
      />,
    );
    expect(host.textContent).not.toContain('correctness_hidden');
    expect(host.textContent).not.toContain('story_quality');
    expect(host.querySelector('.tre-crit-head code')).toBeNull();
    expect(q('tre-criterion-1-locked')?.textContent).toBe(lockedCriterionRefusal('correctness_hidden', 'Hidden tests'));
    expect(q('tre-criterion-1-locked')?.textContent).toBe("Hidden tests is graded by the phase's own checks, so it stays in the rubric.");
  });

  // The shared sentence names a criterion by the title it is given, so a locked key the shared
  // package has no words for (a Deployment file rule's) reads the row's title, not the key quoted, and an untitled row
  // reads its place.
  it('names a locked file rule by its title, and an untitled locked row by its place, never by its key', async () => {
    await draw(
      <CriteriaCard
        task={criteriaTask([
          { key: 'config_completeness', title: 'Every service is configured', weight: 0.5 },
          { key: 'runbook_rollback', title: '', weight: 0.5 },
        ])}
        writeTask={vi.fn()}
        editable
        state="current"
        onFocusCard={vi.fn()}
        onSaved={vi.fn()}
        locked={['config_completeness', 'runbook_rollback']}
        work={{ subject: 'The change', verb: 'passes' }}
      />,
    );
    expect(q('tre-criterion-1-locked')?.textContent).toBe("Every service is configured is graded by the phase's own checks, so it stays in the rubric.");
    expect(q('tre-criterion-2-locked')?.textContent).toBe("Criterion 2 is graded by the phase's own checks, so it stays in the rubric.");
    expect(host.textContent).not.toContain('config_completeness');
    expect(host.textContent).not.toContain('runbook_rollback');
  });

  it('says what the pass mark does: it does not decide a pass, and a sign-off or a Pass gives a learner at least it', async () => {
    await draw(
      <CriteriaCard task={criteriaTask([{ key: 'scope', title: 'Scope', weight: 1 }])} writeTask={vi.fn()} editable state="current" onFocusCard={vi.fn()} onSaved={vi.fn()} />,
    );
    const line = q('tre-criteria-passmark')?.textContent ?? '';
    expect(line).toBe(
      'A story passes when every check passes and the review finds the criterion met; the pass mark does not decide that. Passing this phase by hand gives a learner at least the pass mark.',
    );
    // The default purpose line does not say a story passes at the pass mark.
    expect(host.textContent).not.toContain('passes at the pass mark');
    // The stepper that does something stays.
    expect(host.querySelector('[aria-label="Pass mark"]')).not.toBeNull();
  });

  /*
   * Each sentence by phase and task kind, as the
   * API decides it. Requirements and Design are floor-graded: every criterion
   * gets the share of floor rules that pass, so a weight moves no score and,
   * with every check passing (100), more than half of the criteria met is a
   * pass. The four executable phases score the weighted sum. A task marked for
   * sign-off waits for the teacher; the phase's Pass writes the mark only on a
   * required task that is not marked; a sign-off writes it on any task.
   */
  type Kind = 'required' | 'optional' | 'signoff' | 'optional-signoff';
  const kindTask = (criteria: { key: string; title: string; weight: number }[], kind: Kind) =>
    ({
      ...criteriaTask(criteria),
      required: kind === 'required' || kind === 'signoff',
      ...(kind === 'signoff' || kind === 'optional-signoff' ? { signOff: true } : {}),
    }) as DraftTaskView;
  const one = [{ key: 'scope', title: 'Scope', weight: 1 }];
  const three = [
    { key: 'a', title: 'A', weight: 0.3 },
    { key: 'b', title: 'B', weight: 0.4 },
    { key: 'c', title: 'C', weight: 0.3 },
  ];
  const BY_HAND = 'Passing this phase by hand gives a learner at least the pass mark.';
  const SIGN_OFF = 'Signing off this task gives a learner at least the pass mark.';
  const ONE = 'every check passes and the review finds the criterion met; the pass mark does not decide that.';
  const MANY = 'every check passes and the review finds more than half of the criteria met; the pass mark does not decide that.';
  const cases: Array<{
    phase: string;
    testId: string;
    work: { subject: string; verb: 'pass' | 'passes' };
    floor: boolean;
    be: string;
    purpose?: string;
  }> = [
    { phase: 'Requirements', testId: 'tre-criteria', work: { subject: 'A story', verb: 'passes' }, floor: true, be: 'is' },
    {
      phase: 'Design',
      testId: 'tde-criteria',
      work: { subject: 'A design', verb: 'passes' },
      floor: true,
      be: 'is',
      purpose: 'What the review judges the design against, in your words.',
    },
    { phase: 'Implementation', testId: 'tdi-criteria', work: { subject: 'The code', verb: 'passes' }, floor: false, be: 'is' },
    { phase: 'Testing', testId: 'tdt-criteria', work: { subject: 'The tests', verb: 'pass' }, floor: false, be: 'are' },
    { phase: 'Deployment', testId: 'tdp-criteria', work: { subject: 'The runbook and the files', verb: 'pass' }, floor: false, be: 'are' },
    { phase: 'Maintenance', testId: 'tdm-criteria', work: { subject: 'The change', verb: 'passes' }, floor: false, be: 'is' },
  ];
  for (const c of cases) {
    for (const [count, criteria] of [['one criterion', one], ['three criteria', three]] as const) {
      for (const kind of ['required', 'optional', 'signoff', 'optional-signoff'] as const) {
        it(`${c.phase}, ${count}, a ${kind} task: the line says what passes it and what writes the mark`, async () => {
          await draw(
            <CriteriaCard
              task={kindTask([...criteria], kind)}
              writeTask={vi.fn()}
              editable
              state="current"
              onFocusCard={vi.fn()}
              onSaved={vi.fn()}
              testId={c.testId}
              work={c.work}
              floorGraded={c.floor}
              {...(c.purpose ? { purpose: c.purpose } : {})}
            />,
          );
          const rule = criteria.length === 1 ? ONE : MANY;
          const marked = kind === 'signoff' || kind === 'optional-signoff';
          // Exact both ways on the floor-graded phases; a condition the executable pass needs, so "only when" there.
          const when = c.floor ? 'when' : 'only when';
          const opens = marked ? `${c.work.subject} ${c.be} ready for your sign-off ${when}` : `${c.work.subject} ${c.work.verb} ${when}`;
          const mark = kind === 'required' ? BY_HAND : SIGN_OFF;
          expect(q(`${c.testId}-passmark`)?.textContent).toBe(`${opens} ${rule} ${mark}`);
          // Never sentences that are false or too heavy for the case.
          const text = host.textContent ?? '';
          expect(text).not.toContain('share of the score');
          expect(text).not.toContain('every criterion is met');
          expect(text).not.toContain('pass it by hand');
          expect(text).not.toContain('score of 100');
          expect(text).not.toContain('own best score');
          if (c.floor) expect(text).not.toContain('only when');
        });
      }
    }
  }

  it('with no criterion left, only the mark\'s sentence is said (nothing passes a rubric with none)', async () => {
    await draw(
      <CriteriaCard task={kindTask([], 'required')} writeTask={vi.fn()} editable state="current" onFocusCard={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(q('tre-criteria-passmark')?.textContent).toBe(BY_HAND);
  });

  it('the line follows the rows: removing a criterion down to one says "the criterion"', async () => {
    await draw(
      <CriteriaCard
        task={kindTask([...three], 'optional')}
        writeTask={vi.fn()}
        editable
        state="current"
        onFocusCard={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(q('tre-criteria-passmark')?.textContent).toContain(MANY);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove criterion 3"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove criterion 2"]')!.click());
    expect(q('tre-criteria-passmark')?.textContent).toBe(`A story passes when ${ONE} ${SIGN_OFF}`);
  });

  it('the Requirements and Design purpose lines say nothing of weights; the builders pass the grading they have', () => {
    expect(closureText('CriteriaCard')).toContain("purpose = 'What the review judges the story against, in your words.',");
    expect(moduleText('CriteriaCard')).not.toContain('share of the score');
    expect(closureText('DesignBuilder')).toContain('purpose="What the review judges the design against, in your words."');
    expect(moduleText('DesignBuilder')).not.toContain('share of the score');
    expect(closureText('DesignBuilder')).toMatch(/testId="tde-criteria"[\s\S]*?floorGraded\n\s*\/>/);
    // Each builder's own file: MaintenanceBuilder imports ExecutableBuilder, so a
    // read through the import tree would find the prop in the wrong builder.
    for (const builder of ['ExecutableBuilder', 'DeploymentBuilder', 'MaintenanceBuilder']) {
      expect(moduleText(builder), builder).toContain('floorGraded={false}');
    }
    expect(moduleText('RequirementsBuilder')).not.toContain('floorGraded');
  });

  it('a plural work takes "pass": "The tests pass when", never "The tests passes"', async () => {
    await draw(
      <CriteriaCard
        task={criteriaTask([{ key: 'scope', title: 'Scope', weight: 1 }])}
        writeTask={vi.fn()}
        editable
        state="current"
        onFocusCard={vi.fn()}
        onSaved={vi.fn()}
        testId="tdt-criteria"
        work={{ subject: 'The tests', verb: 'pass' }}
      />,
    );
    const line = q('tdt-criteria-passmark')?.textContent ?? '';
    expect(line.startsWith('The tests pass when every check passes')).toBe(true);
    expect(line).not.toContain('The tests passes');
  });

  it('every builder names its own work on that line, and none says a pass is at the pass mark or shows a key', () => {
    const builders: Array<[string, string]> = [
      ['DesignBuilder', "work={{ subject: 'A design', verb: 'passes' }}"],
      ['MaintenanceBuilder', "work={{ subject: 'The change', verb: 'passes' }}"],
      ['DeploymentBuilder', "work={{ subject: 'The runbook and the files', verb: 'pass' }}"],
      ['ImplementationBuilder', "work: { subject: 'The code', verb: 'passes' }"],
      ['TestingBuilder', "work: { subject: 'The tests', verb: 'pass' }"],
      ['ExecutableBuilder', 'work={kind.work}'],
    ];
    for (const [builder, needle] of builders) {
      expect(closureText(builder), builder).toContain(needle);
      expect(moduleText(builder), builder).not.toContain('passes at the pass mark');
      expect(moduleText(builder), builder).not.toContain('keep their key');
    }
  });
});

/* ------------------------------ Validate ------------------------------- */

describe('Validate names phases and tasks, not their keys', () => {
  const report = {
    tier: 'fast',
    ranAt: '2026-11-17T00:00:00.000Z',
    checks: [
      { id: 'task-has-brief', label: 'Every task has a brief', status: 'failed', sentence: 'The story task has no brief.', phaseKey: 'requirements', taskKey: 'story', files: [] },
      { id: 'phase-holds', label: 'A phase holds tasks a learner can work on', status: 'passed', sentence: 'Design holds 1 task.', phaseKey: 'design', taskKey: null, files: [] },
    ],
    passed: 1,
    failed: 1,
    notApplicable: 0,
    publishable: false,
    blocking: ['The story task has no brief.'],
    notApplicableLine: null,
  } as unknown as ValidationReport;

  it('draws the phase title and the task title in the chips and the Go to label', async () => {
    await draw(
      <ValidationReportPanel
        report={report}
        running={false}
        onRun={() => undefined}
        onGoTo={() => undefined}
        taskTitleOf={(phase, key) => (phase === 'requirements' && key === 'story' ? 'Write the badge story' : undefined)}
      />,
    );
    const chips = [...host.querySelectorAll('.chip')].map((one) => one.textContent);
    expect(chips).toEqual(expect.arrayContaining(['Requirements', 'Write the badge story', 'Design']));
    expect(chips).not.toContain('requirements');
    expect(chips).not.toContain('design');
    expect(chips).not.toContain('story');
    expect(q('project-goto-task-has-brief-requirements-story')?.textContent).toBe('Go to Requirements, task Write the badge story');
  });

  it('the editor hands the panel the draft\'s task titles', () => {
    // The editor's own mount of the panel: the panel passes the same prop on to
    // its rows, so a read through the import tree would find it there too.
    expect(moduleText('ProjectEditor')).toMatch(/<ValidationReportPanel[^>]*taskTitleOf=\{taskTitleOf\}/);
  });
});

/* ---------------------- one trail on the project page ---------------------- */

describe('one trail on the project page', () => {
  it('the editor draws no in-page breadcrumb beginning at "Your classes"', () => {
    const source = moduleText('ProjectEditor');
    expect(source).not.toMatch(/<Breadcrumbs\b/);
    expect(source).not.toContain("label: 'Your classes'");
    expect(closureText('ProjectEditor')).toContain("crumbs={[\n        { label: 'Projects', href: '/teacher/projects' },");
  });
});

describe('the publish receipt', () => {
  it('after a publish here: the receipt alone, in microVMs, linking to My classes; no greyed form under it', async () => {
    await draw(
      <PublishPanel
        draftVersion="0.1.0"
        report={null}
        editable={false}
        readOnlyReason="Version 1.0.0 is published, and a published version never changes."
        publishing={false}
        error=""
        published={{ version: '1.0.0', publishedAt: '2026-11-17T02:54:00.000Z', sandboxBudget: 8 }}
        onPublish={() => undefined}
      />,
    );
    const receipt = q('project-published')!;
    expect(receipt.textContent).toBe("Version 1.0.0 is published. One full pass boots 8 microVMs. Assign it to a class on that class's Project tab, from My classes.");
    expect(receipt.textContent).not.toContain('sandbox runs');
    expect(q('project-published-classes')?.getAttribute('href')).toBe('/teacher');
    for (const id of ['project-publish', 'project-publish-version', 'project-publish-notes', 'project-publish-reason']) expect(q(id), id).toBeNull();
  });

  it('the pressed "Publish 1.0.0" goes with the form, so focus moves to the receipt, not the body', async () => {
    const report = { publishable: true, failed: 0, blocking: [] } as unknown as ValidationReport;
    const panel = (published: { version: string; publishedAt: string; sandboxBudget: number } | null) => (
      <PublishPanel
        draftVersion="0.1.0"
        report={report}
        editable={published === null}
        readOnlyReason={published ? 'Version 1.0.0 is published, and a published version never changes.' : null}
        publishing={false}
        error=""
        published={published}
        onPublish={() => undefined}
      />
    );
    await draw(panel(null));
    await click('project-publish');
    const yes = q('project-publish-confirm-yes') as HTMLButtonElement;
    act(() => yes.focus());
    expect(document.activeElement).toBe(yes);
    await click('project-publish-confirm-yes');
    await draw(panel({ version: '1.0.0', publishedAt: '2026-11-17T02:54:00.000Z', sandboxBudget: 8 }));
    expect(q('project-publish-confirm-yes')).toBeNull();
    const at = document.activeElement as HTMLElement | null;
    expect(at).not.toBe(document.body);
    expect(at?.contains(q('project-published'))).toBe(true);
  });

  it('a receipt already drawn when the panel mounts takes no focus', async () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    await draw(
      <PublishPanel
        draftVersion="0.1.0"
        report={null}
        editable={false}
        readOnlyReason="Version 1.0.0 is published, and a published version never changes."
        publishing={false}
        error=""
        published={{ version: '1.0.0', publishedAt: '2026-11-17T02:54:00.000Z', sandboxBudget: 8 }}
        onPublish={() => undefined}
      />,
    );
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('a version opened already published keeps its disabled button and its reason', async () => {
    await draw(
      <PublishPanel
        draftVersion="1.0.0"
        report={null}
        editable={false}
        readOnlyReason="Version 1.0.0 is published, and a published version never changes."
        publishing={false}
        error=""
        published={null}
        onPublish={() => undefined}
      />,
    );
    expect((q('project-publish') as HTMLButtonElement).disabled).toBe(true);
    expect(q('project-publish-reason')?.textContent).toContain('is published');
  });

  const deployment = (runbook: { drill: boolean } | null) =>
    ({
      key: 'deployment',
      order: 5,
      title: 'Deployment',
      artifactKind: 'config',
      checkKind: 'config',
      tasks: [{ taskKey: 'main', ...(runbook ? { runbook } : {}) }],
    }) as unknown as DraftPhaseView;

  it('a deployment phase with a runbook is priced as publish prices it; without one it is not priced', () => {
    expect(configPhaseBudget(deployment({ drill: true }))).toBe(2);
    expect(configPhaseBudget(deployment({ drill: false }))).toBe(1);
    expect(configPhaseBudget(deployment(null))).toBeNull();
    expect(versionCountIsExact([deployment({ drill: true })], new Set(['deployment']))).toBe(true);
    expect(versionCountIsExact([deployment(null)], new Set())).toBe(false);
  });

  it('Validate leads with the full pass, in the unit the receipt uses', () => {
    const line = ceilingLine([
      { title: 'Implementation', microVMs: 2 },
      { title: 'Deployment', microVMs: 2 },
    ]);
    expect(line.startsWith('One full pass boots 4 microVMs of at most')).toBe(true);
  });
});

/* --------------------------- the class card ---------------------------- */

describe('the class card speaks to the teacher', () => {
  const ALL_OWN = { ownPhases: 2, mixedPhases: 0, referencePhases: 0, applicationFrom: null };
  const MIXED = { ownPhases: 1, mixedPhases: 1, referencePhases: 0, applicationFrom: null };
  it('a version of theirs is "yours"; a shared one is its author\'s', () => {
    expect(versionProvenanceSentence('Deadline badge', ALL_OWN, true)).toBe('Every written phase of Deadline badge is yours.');
    expect(versionProvenanceSentence('Deadline badge', ALL_OWN, false)).toBe("Every written phase of Deadline badge is its author's own.");
    expect(versionProvenanceSentence('Deadline badge', MIXED, true)).toBe('Of the 2 written phases in Deadline badge, 1 is yours and 1 is partly yours.');
  });

  it('no "this deployment\'s default project", and the receipt is one sentence', () => {
    const source = closureText('ClassProjectCard');
    expect(moduleText('ClassProjectCard')).not.toContain('this deployment');
    expect(source).toContain('LearnSDLC&rsquo;s default project.');
    expect(source).toContain('setSaved(`Assigned. ${named} is what a learner who joins this class from now on is given.`);');
  });
});

/* ------------------------ a new class and My classes ------------------------- */

describe('a new class and My classes', () => {
  const portal = moduleText('TeacherPortal');
  // What the portal never says is read across the portal and the model module
  // its roster logic is split into.
  const portalAndModel = portal + moduleText('components/staff/console/teacher-portal-model.ts');
  // A new class opening on its Project tab, from the redirect and from the
  // receipt's link, is asserted on the rendered page (experience-navigation,
  // my-classes-first-load).
  it('the portal never sends a new class to the Invite tab', () => {
    expect(portalAndModel).not.toContain('&tab=invite');
    expect(portalAndModel).not.toContain('tab: "invite"');
  });
  it('My classes is titled, and so crumbed, "My classes", not a slogan', () => {
    expect(portal).toContain(': "My classes"');
    expect(portalAndModel).not.toContain('A clear view of every learner.');
  });
});

describe('Dates and regrades before a project is given', () => {
  it('is a card with the way to the Project tab', async () => {
    const open = vi.fn();
    await draw(<ClassLevers projects={[]} onOpenProject={open} />);
    const card = q('class-levers-empty-card')!;
    expect(card.classList.contains('exp-panel')).toBe(true);
    expect(card.contains(q('class-levers-empty'))).toBe(true);
    await click('class-levers-open-project');
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('the class page wires it to its Project tab', () => {
    expect(closureText('TeacherPortal')).toContain('onOpenProject={classView ? openProjectTab : undefined}');
  });
});

/* --------------------------- the sign-off queue ---------------------------- */

const ROW = (userId: string, learnerName: string, taskTitle = 'Maintenance') => ({
  userId,
  learnerName,
  phaseKey: 'maintenance' as const,
  taskKey: 'main',
  taskTitle,
  awaitingSince: '2026-11-17T03:20:00.000Z',
});
const REASON = 'Countersigned after reading the change request.';

describe('the sign-off queue', () => {
  it('one learner waiting: chosen already, one box, a counter that says what is needed, a heading said once', async () => {
    queue.mockResolvedValue({ cohortId: 'c-1', rows: [ROW('u-1', 'Mateo Okafor')] } satisfies SignoffQueueView);
    await draw(<SignoffQueue cohortId="c-1" />);
    expect((q('signoff-pick-maintenance-main-u-1') as HTMLInputElement).checked).toBe(true);
    expect(q('signoff-all-maintenance-main')).toBeNull();
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(q('signoff-task-maintenance-main')?.querySelector('legend')?.textContent).toBe('Maintenance');
    expect(host.textContent).toContain(`${ASSIGNMENT_REASON_MIN} characters needed`);
    expect(host.textContent).not.toMatch(/0 of \d+ characters/);
    type('signoff-reason-maintenance-main', 'x'.repeat(ASSIGNMENT_REASON_MIN - 3));
    expect(host.textContent).toContain('3 more characters needed');
    // The purpose is true on the last phase: no "before the phase opens", one word for the act.
    const purpose = q('signoff-queue')?.textContent ?? '';
    expect(purpose).not.toContain('before the phase opens');
    expect(purpose).not.toContain('countersignature');
    // The waiting chip is the soft warn the tab's count is drawn in.
    expect(q('signoff-waiting')?.className).toContain('bg-warntint');
    expect(q('signoff-waiting')?.className).toContain('text-warn');
    expect(q('signoff-waiting')?.className).not.toContain('chip-warn');
  });

  it('the confirm asks once, without the button\'s words, then the empty queue says nothing waits instead of the set-up hint', async () => {
    queue.mockResolvedValueOnce({ cohortId: 'c-1', rows: [ROW('u-1', 'Mateo Okafor')] }).mockResolvedValue({ cohortId: 'c-1', rows: [] });
    bulk.mockResolvedValue({ signedOff: ['u-1'], refused: [] });
    await draw(<SignoffQueue cohortId="c-1" />);
    type('signoff-reason-maintenance-main', REASON);
    expect(q('signoff-bulk-maintenance-main')?.textContent).toBe('Sign off 1 learner');
    await click('signoff-bulk-maintenance-main');
    const dialog = q('signoff-confirm')!;
    expect(dialog.textContent).toContain('Maintenance counts as passed for Mateo Okafor once you sign it off. Your reason is kept in their record of changes.');
    expect(dialog.textContent).not.toContain('Each gets its own row');
    expect(q('signoff-confirm-yes')?.textContent).toBe('Confirm sign-off');
    await click('signoff-confirm-yes');
    expect(bulk).toHaveBeenCalledWith('c-1', { phaseKey: 'maintenance', taskKey: 'main', userIds: ['u-1'], reason: REASON });
    expect(q('signoff-result')?.textContent).toContain('Signed off 1 learner.');
    const empty = q('signoff-empty')!;
    expect(empty.textContent).toContain('Nothing is waiting for a sign-off');
    expect(empty.textContent).toContain(SIGNOFF_QUEUE_EMPTY_IN_USE_BODY);
    expect(empty.textContent).not.toContain(SIGNOFF_QUEUE_EMPTY_BODY);
  });

  it('an empty queue keeps the set-up hint only while nothing shows the class uses sign-off', async () => {
    queue.mockResolvedValue({ cohortId: 'c-1', rows: [] });
    await draw(<SignoffQueue cohortId="c-1" />);
    expect(q('signoff-empty')?.textContent).toContain(SIGNOFF_QUEUE_EMPTY_BODY);
    act(() => root.unmount());
    root = createRoot(host);
    await draw(<SignoffQueue cohortId="c-1" inUse />);
    expect(q('signoff-empty')?.textContent).toContain(SIGNOFF_QUEUE_EMPTY_IN_USE_BODY);
    expect(q('signoff-empty')?.textContent).not.toContain(SIGNOFF_QUEUE_EMPTY_BODY);
  });

  // C-teacher-1: the version in force decides the empty queue's words where
  // the class's records cannot (nobody has reached the marked task yet).
  it('no task marked in the version in force: the empty queue keeps the set-up hint', async () => {
    queue.mockResolvedValue({ cohortId: 'c-1', rows: [] });
    const marks = vi.fn().mockResolvedValue(false);
    await draw(<SignoffQueue cohortId="c-1" readVersionMarks={marks} />);
    expect(marks).toHaveBeenCalledTimes(1);
    expect(marks).toHaveBeenCalledWith('c-1');
    expect(q('signoff-empty')?.textContent).toContain(SIGNOFF_QUEUE_EMPTY_BODY);
    expect(q('signoff-empty')?.textContent).not.toContain(SIGNOFF_QUEUE_EMPTY_IN_USE_BODY);
  });

  it('a task marked and nobody waiting yet: the empty queue says nothing waits, and never draws the hint first', async () => {
    queue.mockResolvedValue({ cohortId: 'c-1', rows: [] });
    let answer: (marks: boolean) => void = () => undefined;
    const marks = vi.fn(() => new Promise<boolean>((done) => (answer = done)));
    await draw(<SignoffQueue cohortId="c-1" readVersionMarks={marks} />);
    // While the version is asked about, the queue is still loading: no hint to take back.
    expect(q('signoff-empty')).toBeNull();
    expect(q('signoff-loading')).not.toBeNull();
    await act(async () => answer(true));
    await settle(6);
    expect(q('signoff-empty')?.textContent).toContain(SIGNOFF_QUEUE_EMPTY_IN_USE_BODY);
    expect(q('signoff-empty')?.textContent).not.toContain(SIGNOFF_QUEUE_EMPTY_BODY);
  });

  // A second read started while the first still waits on the version
  // (a refresh, or the effect run twice under strict mode) waits on the same
  // answer, so the set-up hint is never drawn and then taken back.
  it('two reads racing: one ask, and no hint drawn while it is pending', async () => {
    queue.mockResolvedValue({ cohortId: 'c-1', rows: [] });
    let answer: (marks: boolean) => void = () => undefined;
    const marks = vi.fn(() => new Promise<boolean>((done) => (answer = done)));
    const drawn: string[] = [];
    await draw(<SignoffQueue cohortId="c-1" readVersionMarks={marks} />);
    expect(q('signoff-loading')).not.toBeNull();
    // The class page reads again before the version answers.
    await draw(<SignoffQueue cohortId="c-1" readVersionMarks={marks} refreshRound={1} />);
    expect(queue).toHaveBeenCalledTimes(2);
    expect(marks).toHaveBeenCalledTimes(1);
    expect(q('signoff-empty')).toBeNull();
    const seen = new MutationObserver(() => {
      const empty = q('signoff-empty');
      if (empty) drawn.push(empty.textContent ?? '');
    });
    seen.observe(host, { childList: true, subtree: true, characterData: true });
    await act(async () => answer(true));
    await settle(6);
    seen.disconnect();
    expect(marks).toHaveBeenCalledTimes(1);
    expect(q('signoff-empty')?.textContent).toContain(SIGNOFF_QUEUE_EMPTY_IN_USE_BODY);
    // Every empty state drawn on the way said the in-use words, never the hint.
    expect(drawn.length).toBeGreaterThan(0);
    for (const text of drawn) expect(text).not.toContain(SIGNOFF_QUEUE_EMPTY_BODY);
  });

  it('a reader that throws answers false: the hint, not the queue\'s load error', async () => {
    queue.mockResolvedValue({ cohortId: 'c-1', rows: [] });
    const marks = vi.fn(() => {
      throw new Error('boom');
    });
    await draw(<SignoffQueue cohortId="c-1" readVersionMarks={marks as unknown as (id: string) => Promise<boolean>} />);
    expect(q('signoff-empty')?.textContent).toContain(SIGNOFF_QUEUE_EMPTY_BODY);
    expect(host.textContent).not.toContain('could not be loaded');
  });

  it('a task marked and a learner waiting: the batch is drawn, and the version is not asked about', async () => {
    queue.mockResolvedValue({ cohortId: 'c-1', rows: [ROW('u-1', 'Mateo Okafor')] });
    const marks = vi.fn().mockResolvedValue(true);
    await draw(<SignoffQueue cohortId="c-1" readVersionMarks={marks} />);
    expect(q('signoff-task-maintenance-main')).not.toBeNull();
    expect(q('signoff-empty')).toBeNull();
    expect(marks).not.toHaveBeenCalled();
  });

  it('the version in force is read through the assignable list and that version\'s tree', async () => {
    const tree = (signOff: boolean) => ({
      phases: [
        { key: 'requirements', tasks: [{ taskKey: 'story' }] },
        { key: 'maintenance', tasks: [{ taskKey: 'main', ...(signOff ? { signOff: true } : {}) }] },
      ],
    });
    assignable.mockResolvedValue([
      { projectId: 'p-old', versionId: 'v-old', current: false },
      { projectId: 'p-1', versionId: 'v-2', current: true },
    ]);
    draft.mockResolvedValue(tree(true));
    expect(await versionInForceMarksSignoff('c-1')).toBe(true);
    expect(assignable).toHaveBeenCalledWith('c-1');
    expect(draft).toHaveBeenCalledWith('p-1', 'v-2');
    draft.mockResolvedValue(tree(false));
    expect(await versionInForceMarksSignoff('c-1')).toBe(false);
    // No version in force: nothing more is read.
    draft.mockClear();
    assignable.mockResolvedValue([{ projectId: 'p-old', versionId: 'v-old', current: false }]);
    expect(await versionInForceMarksSignoff('c-1')).toBe(false);
    expect(draft).not.toHaveBeenCalled();
    // A refused read keeps today's behaviour (the hint).
    assignable.mockRejectedValue(new Error('Not found.'));
    expect(await versionInForceMarksSignoff('c-1')).toBe(false);
  });

  // That the class page hands the queue the version check is asserted on the rendered class page in
  // `teacher-class-page-refresh.test.tsx` (the empty queue's words follow the version in force).

  it('two learners: the "every learner" box, nothing chosen, and the plural question', async () => {
    queue.mockResolvedValue({ cohortId: 'c-1', rows: [ROW('u-1', 'Mateo Okafor', 'Fix the badge'), ROW('u-2', 'Ada Lim', 'Fix the badge')] });
    await draw(<SignoffQueue cohortId="c-1" />);
    expect(q('signoff-all-maintenance-main')).not.toBeNull();
    expect((q('signoff-pick-maintenance-main-u-1') as HTMLInputElement).checked).toBe(false);
    expect(q('signoff-task-maintenance-main')?.querySelector('legend')?.textContent).toBe('Fix the badge, in Maintenance');
    expect(signoffQuestion('Fix the badge', ['Ada Lim', 'Mateo Okafor'])).toBe(
      'Fix the badge counts as passed for Ada Lim and Mateo Okafor once you sign it off. Each of them gets their own row in the record of changes, with your reason.',
    );
  });

  it('the group heading says the phase once when the task is named for it', () => {
    expect(taskGroupHeading('Maintenance', 'maintenance')).toBe('Maintenance');
    expect(taskGroupHeading('Ship the shelf', 'deployment')).toBe('Ship the shelf, in Deployment');
  });

  it('the reason counter', () => {
    expect(reasonCountText(0, 10)).toBe('10 characters needed');
    expect(reasonCountText(9, 10)).toBe('1 more character needed');
    expect(reasonCountText(10, 10)).toBe('10 characters');
  });

  it('the class page tells the queue when its records show sign-off in use', () => {
    // The class page's wiring of this to the queue is asserted on the rendered class page in `teacher-class-page-refresh.test.tsx`.
    expect(classUsesSignoff([{ phases: [{ tasks: [{ awaitingSignOff: false, signedOffAt: '2026-11-17T03:21:00.000Z' }] }] }] as never)).toBe(true);
    expect(classUsesSignoff([{ phases: [{ tasks: [{ awaitingSignOff: true, signedOffAt: null }] }] }] as never)).toBe(true);
    expect(classUsesSignoff([{ phases: [{ tasks: [{ awaitingSignOff: false, signedOffAt: null }] }] }, undefined] as never)).toBe(false);
  });

  it('the tab\'s count and the card\'s chip are one tone', () => {
    const css = webSource('components/experience/experience.css');
    const count = declsOf(css, '.exp-teacher-page .exp-class-tab-count');
    expect(prop(count, 'background')).toBe('rgb(var(--c-warntint))');
    expect(prop(count, 'color')).toBe('rgb(var(--c-warn))');
    // In Graphite too: no rule for the count, of any theme, sets
    // its own colours over the two tokens, which Graphite redefines.
    const all = rules(css).filter(([sel]) => sel.includes('.exp-class-tab-count'));
    expect(all.map(([sel]) => sel)).toEqual(['.exp-teacher-page .exp-class-tab-count']);
    expect(css).not.toMatch(/\[data-theme="graphite"\][^{]*\.exp-class-tab-count/);
  });
});

/* ----------------------- the latest submission ------------------------ */

describe("the table's latest submission says what the learner's page says", () => {
  const pass = { id: 's-1', status: 'completed', passed: true, verifiedPass: true, taskKey: 'main', report: { passed: true } } as unknown as SubmissionView;
  const phase = (status: string, awaitingSignOff: boolean, taskStatus = 'in_progress') =>
    ({ status, tasks: [{ key: 'main', status: taskStatus, awaitingSignOff }] }) as unknown as InstructorPhaseView;

  it('a pass waiting on the countersignature reads "Awaiting your sign-off", then "Review passed" once signed', () => {
    expect(latestSubmissionState(phase('submitted', true), pass)).toEqual({ label: 'Awaiting your sign-off', tone: 'open' });
    expect(latestSubmissionState(phase('passed', false, 'passed'), pass)).toEqual({ label: 'Review passed', tone: 'pass' });
  });

  it('another task waiting does not relabel this task\'s pass', () => {
    const other = { status: 'submitted', tasks: [{ key: 'quiz', status: 'in_progress', awaitingSignOff: true }] } as unknown as InstructorPhaseView;
    expect(latestSubmissionState(other, pass).label).toBe('Review passed');
  });

  // The table and the Latest submissions list both draw it: asserted on the rendered class page, before and
  // after a sign-off, in `teacher-class-page-refresh.test.tsx`.
});

/* ------------------- the "Awaiting your sign-off" figure ------------------- */

describe('the "Awaiting your sign-off" tile\'s figure', () => {
  it('its caption link is plain inline text, so its line is no taller than the other tiles\'', () => {
    const decls = declsOf(webSource('components/experience/experience.css'), '.exp-teacher-metrics small .exp-text-link');
    expect(prop(decls, 'display')).toBe('inline');
    expect(prop(decls, 'padding-block')).toBe('0');
    expect(prop(decls, 'font-size')).toBe('inherit');
  });
});
