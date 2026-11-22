/**
 * The guide's ten steps' states, derived on the client from
 * the draft the editor already holds, the deep-validation view it already
 * reads and the project summary. No new API is asked.
 *
 * Six fixture drafts, one per moment in a teacher's path: a fresh upload whose
 * sealed files are not written yet, the same draft sealed, deep-validated,
 * stale after an executable edit, published, and assigned. Each pins the whole
 * row of states, so a rule that moves one step is a red here.
 */
import { describe, expect, it } from 'vitest';
import type {
  AuthoredProjectSummary,
  DeepValidationView,
  DraftPhaseView,
  DraftTaskView,
  DraftVersionView,
  ExecutableTaskView,
  ValidationReport,
} from '@learnsdlc/shared';
import { GUIDE_STEP_KEYS, PREVIEW_STEP_HELP } from '@learnsdlc/shared';
import {
  deriveGuideSteps,
  guideStepHref,
  nextGuideStep,
  type GuideInput,
} from '@/components/staff/guide/guide-steps';
import { phaseSetFor } from './support/phase-set';

const sealed = (path: string) => ({ path, sha256: 'a'.repeat(64), bytes: 10 });

function exec(over: Partial<ExecutableTaskView> = {}): ExecutableTaskView {
  return {
    taskKey: 'build',
    checkKind: 'code',
    artefactType: 'code',
    owns: ['app/shelf.py'],
    profile: 'baked',
    runs: [
      {
        id: 'api',
        shape: 'run-python-hidden',
        label: 'API tests',
        testPaths: ['tests'],
        visibleTests: ['tests/test_visible.py'],
        learnerTestFiles: [],
        hidden: [],
      },
    ],
    minTests: null,
    coverageKeywords: [],
    solution: [],
    mutants: [],
    sandboxBudget: 2,
    ...over,
  } as ExecutableTaskView;
}

function task(over: Partial<DraftTaskView> = {}): DraftTaskView {
  return {
    taskKey: 'build',
    order: 1,
    required: true,
    title: 'Build the shelf',
    brief: 'Build it.',
    artefactType: 'code',
    artefactPath: null,
    checkKind: 'code',
    rubric: { criteria: [] } as unknown as DraftTaskView['rubric'],
    objectives: [],
    owns: [],
    authorable: true,
    notice: null,
    ...over,
  };
}

function phase(key: DraftPhaseView['key'], tasks: DraftTaskView[], over: Partial<DraftPhaseView> = {}): DraftPhaseView {
  return {
    key,
    order: 1,
    title: key[0].toUpperCase() + key.slice(1),
    intro: '',
    artifactKind: 'story',
    checkKind: 'story',
    tasks,
    blocksPublish: false,
    ...over,
  };
}

const REPORT = (publishable: boolean): ValidationReport => ({
  tier: 'fast' as ValidationReport['tier'],
  ranAt: '2026-10-02T00:00:00.000Z',
  checks: [],
  passed: 3,
  failed: publishable ? 0 : 1,
  notApplicable: 0,
  publishable,
  blocking: publishable ? [] : ['Something blocks publish.'],
  notApplicableLine: null,
});

function draft(execView: ExecutableTaskView | null, over: Partial<DraftVersionView> = {}): DraftVersionView {
  const phases = [
    phase('requirements', [task({ taskKey: 'story', checkKind: 'story', artefactType: 'user-story' })]),
    phase(
      'implementation',
      [task(execView ? { executable: execView } : {})],
      { artifactKind: 'code', checkKind: 'code' },
    ),
  ];
  return {
    projectId: 'p1',
    versionId: 'v1',
    version: '0.1.0',
    status: 'draft',
    slug: 'books-on-a-shelf',
    title: 'Books on a shelf',
    tagline: '',
    description: '',
    platformOwned: false,
    editable: true,
    phases,
    validation: REPORT(true),
    supportedStacks: { sentence: '' } as DraftVersionView['supportedStacks'],
    createdAt: '2026-10-02T00:00:00.000Z',
    phaseSet: phaseSetFor(phases.map((one) => one.key), true),
    ...over,
  };
}

function deep(status: DeepValidationView['status'], current: boolean): DeepValidationView {
  return {
    versionId: 'v1',
    status,
    current,
    contentDigest: status === 'not-run' ? null : 'd'.repeat(64),
    checks: [],
    costWarning: { microVMs: 4, sentence: '' },
    startedAt: null,
    finishedAt: null,
  };
}

const SEALED = exec({
  runs: [{ ...exec().runs[0], hidden: [sealed('tests/test_hidden.py')] }],
  solution: [sealed('app/shelf.py')],
});

const states = (input: GuideInput) =>
  Object.fromEntries(deriveGuideSteps(input).map((step) => [step.key, step.applies ? step.state : 'n/a']));

describe('the ten steps derived from the draft', () => {
  it('derives exactly the ten steps, in order', () => {
    expect(deriveGuideSteps({ view: null }).map((step) => step.key)).toEqual([...GUIDE_STEP_KEYS]);
    expect(GUIDE_STEP_KEYS).toHaveLength(10);
  });

  it('a fresh upload: prepared, uploaded and refined; nothing sealed yet', () => {
    expect(states({ view: draft(exec()), deep: deep('not-run', false) })).toEqual({
      prepare: 'done',
      upload: 'done',
      refine: 'done',
      seal: 'todo',
      'deep-validate': 'todo',
      preview: 'todo',
      publish: 'todo',
      assign: 'todo',
      'sign-off': 'todo',
      export: 'todo',
    });
  });

  it('a fresh upload whose fast report blocks publish is not refined yet', () => {
    expect(states({ view: draft(exec(), { validation: REPORT(false) }) }).refine).toBe('todo');
    expect(states({ view: draft(exec(), { validation: null }) }).refine).toBe('todo');
  });

  it('sealed: hidden tests and the solution written', () => {
    expect(states({ view: draft(SEALED), deep: deep('not-run', false) })).toMatchObject({
      seal: 'done',
      'deep-validate': 'todo',
    });
  });

  it('a testing task is sealed only with at least one mutant', () => {
    const tests = exec({
      checkKind: 'tests',
      artefactType: 'tests',
      runs: [{ ...exec().runs[0], hidden: [sealed('tests/test_reference.py')] }],
      solution: [sealed('app/shelf.py')],
      mutants: [],
    });
    expect(states({ view: draft(tests) }).seal).toBe('todo');
    expect(states({ view: draft({ ...tests, mutants: [sealed('off-by-one/app/shelf.py')] }) }).seal).toBe('done');
  });

  it('deep-validated: a passing run on the current bytes', () => {
    expect(states({ view: draft(SEALED), deep: deep('passed', true) })).toMatchObject({
      seal: 'done',
      'deep-validate': 'done',
    });
  });

  it('stale: a passing or failing run on bytes that have changed since', () => {
    expect(states({ view: draft(SEALED), deep: deep('passed', false) })['deep-validate']).toBe('stale');
    expect(states({ view: draft(SEALED), deep: deep('failed', false) })['deep-validate']).toBe('stale');
    // A run that failed on the current bytes is still to do, not stale.
    expect(states({ view: draft(SEALED), deep: deep('failed', true) })['deep-validate']).toBe('todo');
    expect(states({ view: draft(SEALED), deep: deep('running', false) })['deep-validate']).toBe('todo');
  });

  it('published: frozen, so refine, seal and deep validation are behind it', () => {
    const view = draft(SEALED, { status: 'published', editable: false, version: '1.0.0' });
    expect(states({ view, deep: deep('passed', true), summary: { cohortsUsing: 0, publishedVersion: '1.0.0' } })).toEqual({
      prepare: 'done',
      upload: 'done',
      refine: 'done',
      seal: 'done',
      'deep-validate': 'done',
      preview: 'todo',
      publish: 'done',
      assign: 'todo',
      'sign-off': 'todo',
      export: 'todo',
    });
  });

  it('assigned: a class is on the project', () => {
    const view = draft(SEALED, { status: 'published', editable: false, version: '1.0.0' });
    const summary: Pick<AuthoredProjectSummary, 'cohortsUsing' | 'publishedVersion'> = { cohortsUsing: 2, publishedVersion: '1.0.0' };
    expect(states({ view, summary }).assign).toBe('done');
  });

  it('sign-off is done once a task is marked, and preview and export once this session did them', () => {
    const marked = draft(SEALED);
    marked.phases[0].tasks[0] = { ...marked.phases[0].tasks[0], signOff: true };
    expect(states({ view: marked, previewed: true, exported: true })).toMatchObject({
      'sign-off': 'done',
      preview: 'done',
      export: 'done',
    });
  });

  it('a project with no executable phase: seal and deep validation do not apply', () => {
    expect(states({ view: draft(null) })).toMatchObject({ seal: 'n/a', 'deep-validate': 'n/a' });
  });

  it('with no draft (the Projects page) every step is still to do', () => {
    expect(new Set(Object.values(states({ view: null })))).toEqual(new Set(['todo']));
  });

  it('names the next step: the first required step that is not done', () => {
    expect(nextGuideStep(deriveGuideSteps({ view: draft(exec()) }))?.key).toBe('seal');
    expect(nextGuideStep(deriveGuideSteps({ view: draft(SEALED), deep: deep('passed', false) }))?.key).toBe('deep-validate');
    const view = draft(SEALED, { status: 'published', editable: false });
    expect(nextGuideStep(deriveGuideSteps({ view, summary: { cohortsUsing: 1, publishedVersion: '1.0.0' } }))).toBeNull();
  });

  it('the Preview step reads the preview help and points at the Preview button', () => {
    const preview = deriveGuideSteps({ view: null }).find((step) => step.key === 'preview')!;
    expect(preview.help).toEqual(PREVIEW_STEP_HELP);
    expect(preview.applies).toBe(true);
    expect(preview.anchor.id).toBe('guide-preview');
  });

  it('the next draft after a publish keeps Publish done, so Assign never reads done ahead of it', () => {
    const summary = { cohortsUsing: 1, publishedVersion: '1.0.0' };
    expect(states({ view: draft(SEALED), deep: deep('passed', true), summary })).toMatchObject({ publish: 'done', assign: 'done' });
    expect(states({ view: draft(SEALED), deep: deep('passed', true), summary: { cohortsUsing: 0, publishedVersion: null } }).publish).toBe('todo');
  });

  it('"Take me there" goes to the page each step lives on, and only where it can', () => {
    const steps = deriveGuideSteps({ view: null });
    const by = (key: string) => steps.find((step) => step.key === key)!;
    expect(guideStepHref(by('prepare'), 'projects')).toBe('#guide-start-here');
    expect(guideStepHref(by('prepare'), 'editor')).toBe('/teacher/projects#guide-start-here');
    expect(guideStepHref(by('deep-validate'), 'editor')).toBe('#guide-deep');
    expect(guideStepHref(by('deep-validate'), 'projects')).toBeNull();
    expect(guideStepHref(by('assign'), 'editor')).toBe('/teacher');
  });
});
