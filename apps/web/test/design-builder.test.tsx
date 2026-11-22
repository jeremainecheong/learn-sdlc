// @vitest-environment jsdom
/**
 * The six-step Design builder in the teacher's editor, and the Design part of
 * Preview as a learner.
 *
 * The model's three readings (Copy from Requirements, the steps done, the
 * starting point in words) are pure; the builder is rendered with the
 * projects API mocked, so every assertion reads what the teacher sees and
 * what a save sends.
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  API_CONTRACT_JSON,
  DEFAULT_DESIGN_FLOOR,
  DESIGN_JSON,
  EMPTY_API_CONTRACT,
  LEARNER_PICKS,
  SCREEN_CONTRACT_JSON,
  designContractOffRefusal,
  serialiseDesign,
  type LearnerPreviewPhase,
} from '@learnsdlc/shared';

const updateTask = vi.fn();
const replaceFile = vi.fn();
const files = vi.fn();
vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    updateTask: (...a: unknown[]) => updateTask(...a),
    updatePhase: vi.fn(),
    replaceFile: (...a: unknown[]) => replaceFile(...a),
    files: (...a: unknown[]) => files(...a),
  },
}));

import {
  copyFromRequirements,
  designStepsDone,
  startingPointSentence,
} from '@/components/staff/projects/design/design-builder-model';
import { DesignBuilder } from '@/components/staff/projects/design/DesignBuilder';
import { forgetTaskSaves } from '@/components/staff/projects/requirements/RequirementsBuilder';
import { ApiError } from '@/lib/api';
import { expectSignOffJumpLands } from './support/signoff-jump';
import { expectStepLinksLand } from './support/step-links';
import { PreviewDesign } from '@/components/staff/preview/LearnerPreview';

const provided = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `US-${i + 1}`, title: `Story ${i + 1}`, persona: 'busy learner', capability: `to do thing ${i + 1}`, benefit: 'I keep up' }));
const requirementsPhase = (count: number, learnerId: string) =>
  ({
    key: 'requirements',
    intro: 'x',
    tasks: [
      {
        taskKey: 'main',
        checkKind: 'story',
        story: {
          kind: 'story',
          record: 'requirements/story.json',
          providedStories: provided(count),
          learnerStory: { id: learnerId, hints: { capability: 'a report of the tasks that are overdue', persona: 'person who runs TaskTrackr', benefit: 'I catch what I missed' } },
          floor: {},
        },
      },
    ],
  }) as never;
const designTask = {
  taskKey: 'main',
  title: 'Design the overdue report',
  brief: 'Design it.',
  objectives: [],
  artefactType: 'design-doc',
  required: true,
  checkKind: 'design',
  authorable: true,
  design: { kind: 'design', record: 'design/design.json', contracts: { api: true, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR },
  rubric: { passThreshold: 70, criteria: [{ key: 'design', title: 'The design', description: 'd', weight: 1 }] },
} as never;
const designPhase = { key: 'design', intro: 'Two services.', tasks: [designTask], files: [] } as never;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetTaskSaves();
  updateTask.mockReset();
  replaceFile.mockReset();
  files.mockReset();
  files.mockResolvedValue([]);
  updateTask.mockImplementation(() => new Promise(() => undefined));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
}
function byTestId(id: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element ${id}`);
  return el;
}
const queryTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function click(id: string) {
  act(() => {
    fireEvent.click(byTestId(id));
  });
}

describe('copyFromRequirements', () => {
  test('copies the provided stories and the learner story with its capability as title', () => {
    const out = copyFromRequirements({ phases: [requirementsPhase(4, 'US-5')] })!;
    expect(out.stories.map((s) => s.id)).toEqual(['US-1', 'US-2', 'US-3', 'US-4', 'US-5']);
    expect(out.stories[0].line).toBe('As a busy learner, I want to do thing 1, so that I keep up.');
    expect(out.stories[4]).toEqual({
      id: 'US-5',
      title: 'a report of the tasks that are overdue',
      line: 'As a person who runs TaskTrackr, I want a report of the tasks that are overdue, so that I catch what I missed.',
    });
    expect(out.left).toEqual([]);
  });
  test('copies at most 12 and names the one left out', () => {
    const out = copyFromRequirements({ phases: [requirementsPhase(12, 'US-13')] })!;
    expect(out.stories).toHaveLength(12);
    expect(out.left).toEqual(['US-13']);
  });
  test('skips a learner-picked id, and is null without a Requirements story task', () => {
    expect(copyFromRequirements({ phases: [requirementsPhase(2, LEARNER_PICKS)] })!.stories.map((s) => s.id)).toEqual(['US-1', 'US-2']);
    expect(copyFromRequirements({ phases: [] })).toBeNull();
  });
  test('never copies a story the door would refuse: an over-long text is cut to the cap', () => {
    const long = requirementsPhase(1, LEARNER_PICKS) as unknown as { tasks: { story: { providedStories: { title: string }[] } }[] };
    long.tasks[0].story.providedStories[0].title = 'x'.repeat(500);
    const out = copyFromRequirements({ phases: [long as never] })!;
    expect(out.stories[0].title.length).toBe(400);
  });
});

describe('DesignBuilder', () => {
  const props = {
    projectId: 'p',
    versionId: 'v',
    draft: { phases: [requirementsPhase(4, 'US-5'), designPhase] } as never,
    phase: designPhase,
    task: designTask,
    editable: true,
    onSaved: () => {},
    onSignOff: () => {},
    onToggleRequired: () => {},
  };
  test('draws six steps, the floor in words, and Copy from Requirements', () => {
    render(<DesignBuilder {...props} />);
    for (const id of ['tde-background', 'tde-stories', 'tde-learner-design', 'tde-starting-point', 'tde-floor', 'tde-criteria']) {
      expect(queryTestId(id), id).not.toBeNull();
    }
    expect(byTestId('design-builder').querySelectorAll('[data-testid^="tre-step-"][aria-label^="Step"]')).toHaveLength(6);
    expect(byTestId('tde-floor-sentence').textContent).toContain('at least 2 entities and 1 relation');
    expect(queryTestId('tde-copy-requirements')).not.toBeNull();
    expect(byTestId('tde-readiness').textContent).toBe('5 of 6 steps done');
    expect(queryTestId('tde-older-format')).toBeNull();
    expect(queryTestId('tde-converted')).toBeNull();
    // Design is floor-graded: a weight moves no score, and with every check passing more than half met is a pass.
    expect(byTestId('tde-criteria').textContent).not.toContain('share of the score');
    expect(byTestId('tde-criteria-passmark').textContent).toMatch(
      /^A design passes when every check passes and the review finds (the criterion|more than half of the criteria) met; the pass mark does not decide that\. /,
    );
    expect(byTestId('tde-criteria-passmark').textContent).not.toContain('score of 100');
    expect(byTestId('tde-criteria-passmark').textContent).not.toContain('only when');
  });
  test('a draft converted from the older format names the documents the conversion removed', () => {
    const draft = { phases: [requirementsPhase(4, 'US-5'), designPhase], designConversion: { note: 'Design converted from markdown: 2 markdown files dropped.', removed: ['design/architecture.md', 'design/my-design.md'] } };
    render(<DesignBuilder {...props} draft={draft as never} />);
    expect(byTestId('tde-converted').textContent).toContain('removed from the phase: design/architecture.md, design/my-design.md.');
    expect(byTestId('tde-converted').textContent).toContain('Design converted from markdown: 2 markdown files dropped.');
  });
  test('greys the screen rows of the floor while the screen contract is off, and the sentence follows the switch', () => {
    render(<DesignBuilder {...props} />);
    expect(byTestId('tde-floor-minScreens').getAttribute('aria-disabled')).toBe('true');
    expect(byTestId('tde-floor-minScreens').classList.contains('tde-row-off')).toBe(true);
    expect(byTestId('tde-floor-minEndpoints').getAttribute('aria-disabled')).toBeNull();
    click('tde-contract-screens');
    expect(byTestId('tde-floor-sentence').textContent).toContain('at least 1 screen in the screen contract');
    expect(byTestId('tde-floor-minScreens').getAttribute('aria-disabled')).toBeNull();
  });
  test('says on the page, not in a tooltip, why a floor row is greyed, and ties the row to it', () => {
    render(<DesignBuilder {...props} />);
    const note = (id: string) => {
      const row = byTestId(id);
      const by = row.getAttribute('aria-describedby');
      return by ? (host.querySelector(`[id="${by}"]`)?.textContent ?? null) : null;
    };
    expect(byTestId('tde-floor-minScreens').hasAttribute('title')).toBe(false);
    expect(note('tde-floor-minScreens')).toBe('Read only while the screen contract is on.');
    expect(byTestId('tde-floor-minScreens').textContent).toContain('Read only while the screen contract is on.');
    expect(note('tde-floor-minEndpoints')).toBeNull();
    expect(byTestId('tde-floor-sequence').hasAttribute('title')).toBe(false);
    expect(note('tde-floor-sequence')).toBe('Set by the sequence diagram switch in step 3.');
    click('tde-contract-screens');
    expect(note('tde-floor-minScreens')).toBeNull();
    expect(byTestId('tde-floor-minScreens').textContent).not.toContain('Read only');
  });
  test('the sequence switch puts the sequence rule into the floor and its sentence', () => {
    render(<DesignBuilder {...props} />);
    expect(byTestId('tde-sequence-diagram').getAttribute('aria-checked')).toBe('false');
    expect(byTestId('tde-floor-sequence').getAttribute('aria-disabled')).toBe('true');
    expect(byTestId('tde-floor-sentence').textContent).not.toContain('sequence diagram');
    click('tde-sequence-diagram');
    expect(byTestId('tde-sequence-diagram').getAttribute('aria-checked')).toBe('true');
    expect(byTestId('tde-floor-sequence').hasAttribute('aria-disabled')).toBe(false);
    expect(byTestId('tde-floor-sentence').textContent).toContain('a sequence diagram that names at least one of the operations');
  });
  test('the switches save the whole design body with only the switches changed, and touch no file', async () => {
    updateTask.mockResolvedValue({ phase: designPhase, validation: null });
    render(<DesignBuilder {...props} />);
    click('tde-sequence-diagram');
    await act(async () => {
      fireEvent.click(byTestId('tde-learner-save'));
    });
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'design', 'main', {
      title: 'Design the overdue report',
      brief: 'Design it.',
      objectives: [],
      design: { contracts: { api: true, screens: false }, sequence: true, stories: [], floor: DEFAULT_DESIGN_FLOOR },
    });
    expect(replaceFile).not.toHaveBeenCalled();
  });
  test('the Learner design card\'s brief field says it is plain text, in the editor\'s own sentence, by aria-describedby', async () => {
    render(<DesignBuilder {...props} />);
    expect((((byTestId('tde-learner-brief')).getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' '))).toBe("Plain text. Lists, indented lines and code in backticks are kept as you type them; a heading's # and the stars or underscores around words are removed when you save.");
  });
  test("the Learner design card takes the server's plain words from the save's answer (Task 12)", async () => {
    // The editor's part: the server's answer handed down.
    function Live() {
      const [held, setHeld] = useState(designPhase as { tasks: unknown[] });
      return (
        <DesignBuilder
          {...props}
          draft={{ phases: [requirementsPhase(4, 'US-5'), held] } as never}
          phase={held as never}
          task={held.tasks[0] as never}
          onSaved={(result) => setHeld(result.phase as never)}
        />
      );
    }
    const plain = { ...(designTask as object), title: 'Design the report', brief: 'Design it plain.', objectives: ['Name the late rows'] };
    updateTask.mockResolvedValueOnce({ phase: { ...(designPhase as object), tasks: [plain] }, validation: null });
    await act(async () => root.render(<Live />));
    const field = (id: string) => byTestId(id) as HTMLInputElement | HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(field('tde-learner-title'), { target: { value: '**Design** the report' } });
      fireEvent.change(field('tde-learner-brief'), { target: { value: 'Design it **plain**.' } });
      fireEvent.change(field('tde-learner-objectives'), { target: { value: 'Name the _late_ rows' } });
    });
    await act(async () => {
      fireEvent.click(byTestId('tde-learner-save'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(updateTask.mock.calls[0][4]).toMatchObject({ title: '**Design** the report', brief: 'Design it **plain**.', objectives: ['Name the _late_ rows'] });
    expect(field('tde-learner-title').value).toBe('Design the report');
    expect(field('tde-learner-brief').value).toBe('Design it plain.');
    expect(field('tde-learner-objectives').value).toBe('Name the late rows');
  });
  test('Copy from Requirements asks first, then fills the list', async () => {
    render(<DesignBuilder {...props} />);
    click('tde-copy-requirements');
    expect(host.textContent).toMatch(/This replaces the 0 stories listed here with 5 from Requirements/);
    await act(async () => {
      fireEvent.click(byTestId('tde-copy-confirm'));
    });
    expect((byTestId('tde-story-4-id') as HTMLInputElement).value).toBe('US-5');
    expect(updateTask).toHaveBeenCalledTimes(1);
    const sent = updateTask.mock.calls[0][4] as { design: { stories: { id: string }[] } };
    expect(sent.design.stories.map((s) => s.id)).toEqual(['US-1', 'US-2', 'US-3', 'US-4', 'US-5']);
  });
  test('names the story left out when Requirements holds more than 12', () => {
    render(<DesignBuilder {...props} draft={{ phases: [requirementsPhase(12, 'US-13'), designPhase] } as never} />);
    click('tde-copy-requirements');
    expect(host.textContent).toContain('One story did not fit and was left out: US-13.');
  });
  test('draws no Copy from Requirements on a draft without a Requirements story task', () => {
    render(<DesignBuilder {...props} draft={{ phases: [designPhase] } as never} />);
    expect(queryTestId('tde-copy-requirements')).toBeNull();
  });
  test('refuses two stories with one id before the save', async () => {
    render(<DesignBuilder {...props} />);
    click('tde-story-add');
    click('tde-story-add');
    const set = (id: string, value: string) =>
      act(() => {
        fireEvent.change(byTestId(id), { target: { value } });
      });
    set('tde-story-0-id', 'US-1');
    set('tde-story-0-title', 'One');
    set('tde-story-0-line', 'As a member, I want one.');
    set('tde-story-1-id', 'US-1');
    set('tde-story-1-title', 'Two');
    set('tde-story-1-line', 'As a member, I want two.');
    await act(async () => {
      fireEvent.click(byTestId('tde-stories-save'));
    });
    expect(byTestId('tde-stories-status').textContent).toBe('Two stories share the id US-1.');
    expect(updateTask).not.toHaveBeenCalled();
  });
  test('says the older format until a save answers, and its first save sends the converted defaults', async () => {
    const older = { ...(designTask as object), designOlderFormat: true } as never;
    updateTask.mockResolvedValue({ phase: designPhase, validation: null });
    render(<DesignBuilder {...props} task={older} phase={{ ...(designPhase as object), tasks: [older] } as never} />);
    // A Background save and a sign-off mark alone never convert it, so the line names the steps that do.
    expect(byTestId('tde-older-format').textContent).toBe(
      'This task is in the older format. Saving the stories, the learner’s design, the floor or the criteria converts it.',
    );
    expect(byTestId('tde-start-older').textContent).toBe(
      'The starting point opens here once the task is converted. Save the stories, the learner’s design, the floor or the criteria to convert it.',
    );
    expect(designStepsDone(designPhase, older)).toEqual([true, false, true, false, false, true]);
    await act(async () => {
      fireEvent.click(byTestId('tre-criteria-save'));
    });
    const sent = updateTask.mock.calls[0][4] as { design: unknown; rubric: unknown };
    expect(sent.design).toEqual({ contracts: { api: true, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR });
    expect(sent.rubric).toBeDefined();
    // The editor draws the builder again with the converted task the save answered with: the line goes.
    await act(async () => root.render(<DesignBuilder {...props} />));
    expect(queryTestId('tde-older-format')).toBeNull();
    expect(queryTestId('tde-start-older')).toBeNull();
  });
  test('steps done follow what the server holds', () => {
    expect(designStepsDone(designPhase, designTask)).toEqual([true, false, true, true, true, true]);
  });
  test('draws Reset to the pack’s only where the draft was opened from a version', () => {
    render(<DesignBuilder {...props} draft={{ phases: [designPhase], forkedFromVersionId: 'v-0' } as never} />);
    expect(queryTestId('tde-start-reset')).not.toBeNull();
    expect(queryTestId('tde-start-empty')).not.toBeNull();
    render(<DesignBuilder {...props} draft={{ phases: [designPhase], forkedFromVersionId: null } as never} />);
    expect(queryTestId('tde-start-reset')).toBeNull();
  });
  // Each link of the row of steps goes to its own card ("The floor" is the fifth).
  test('each step link of the row names its own card, in the order of the cards', () => {
    render(<DesignBuilder {...props} />);
    expect(expectStepLinksLand(host)).toEqual(['Background', 'Stories to design for', "The learner's design", 'Starting point', 'The floor', 'Criteria']);
  });
  // The floor card's box; the row's Sign-off entry goes to it.
  test('the Sign-off entry after the six steps brings the floor card box into view and focuses it, never ticking it', async () => {
    render(<DesignBuilder {...props} />);
    await expectSignOffJumpLands(host, 'main', 'tde-floor');
    expect(updateTask).not.toHaveBeenCalled();
    render(<DesignBuilder {...props} editable={false} />);
    expect(queryTestId('tre-signoff-jump')).toBeNull();
    expect(document.getElementById('task-signoff-main')).toBeNull();
  });
});

describe('the Starting point', () => {
  const props = {
    projectId: 'p',
    versionId: 'v',
    draft: { phases: [designPhase], forkedFromVersionId: 'v-0' } as never,
    phase: designPhase,
    task: designTask,
    editable: true,
    onSaved: () => {},
  };
  const row = (path: string, content: string) => ({ id: path, ownerKind: 'phase', phaseKey: 'design', path, role: 'workspace', editable: true, language: 'json', size: 1, sealed: false, content, notice: null });
  const answer = { phase: designPhase, validation: null, alsoReplacedIn: [] };

  test("draws the room's own cards over the starting record, and saves an edit through files.replace", async () => {
    vi.useFakeTimers();
    try {
      files.mockResolvedValue([row(DESIGN_JSON, serialiseDesign({ entities: [], relations: [], operations: [], decisions: [] })), row(API_CONTRACT_JSON, '{"operations":[{"id":"listTasks","method":"GET","path":"/tasks"}],"errors":{}}')]);
      replaceFile.mockResolvedValue(answer);
      await act(async () => root.render(<DesignBuilder {...props} />));
      expect(queryTestId('design-board-entities')).not.toBeNull();
      expect(host.querySelector('[aria-label="API contract workbench"]')).not.toBeNull();
      // The screens form and the sequence diagram wait for their switches.
      expect(queryTestId('design-screens')).toBeNull();
      expect(host.querySelector('[aria-label="Diagram studio"]')).toBeNull();
      act(() => {
        fireEvent.click(byTestId('design-board-entity-add'));
      });
      expect(replaceFile).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(replaceFile).toHaveBeenCalledTimes(1);
      const [, , phaseKey, body] = replaceFile.mock.calls[0] as [string, string, string, { path: string; content: string }];
      expect(phaseKey).toBe('design');
      expect(body.path).toBe(DESIGN_JSON);
      expect(JSON.parse(body.content).entities).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("over the empty seed the API workbench adds a first endpoint and saves it through files.replace, without the learner's words", async () => {
    vi.useFakeTimers();
    try {
      files.mockResolvedValue([row(DESIGN_JSON, serialiseDesign({ entities: [], relations: [], operations: [], decisions: [] })), row(API_CONTRACT_JSON, EMPTY_API_CONTRACT)]);
      replaceFile.mockResolvedValue(answer);
      await act(async () => root.render(<DesignBuilder {...props} />));
      // the learner's words stay in the learner's room
      const bench = host.querySelector('[aria-label="API contract workbench"]')!;
      expect(bench.textContent).not.toContain('Saved with your design');
      expect(bench.querySelector('a[href="/learn/design"]')).toBeNull();
      const add = [...host.querySelectorAll('button')].find((one) => one.textContent === 'Add an endpoint');
      expect(add).toBeDefined();
      act(() => {
        fireEvent.click(add!);
      });
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(replaceFile).toHaveBeenCalledTimes(1);
      const body = replaceFile.mock.calls[0][3] as { path: string; content: string };
      expect(body.path).toBe(API_CONTRACT_JSON);
      expect(JSON.parse(body.content).operations).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('draws the sequence diagram once the sequence switch is saved on', async () => {
    files.mockResolvedValue([row(DESIGN_JSON, serialiseDesign({ entities: [], relations: [], operations: [], decisions: [] }))]);
    const on = { ...(designTask as { design: object }), design: { ...(designTask as { design: object }).design, sequence: true } } as never;
    const saved = { ...(designPhase as object), tasks: [on] } as never;
    updateTask.mockResolvedValue({ phase: saved, validation: null });
    await act(async () => root.render(<DesignBuilder {...props} />));
    expect(host.querySelector('[aria-label="Diagram studio"]')).toBeNull();
    click('tde-sequence-diagram');
    await act(async () => {
      fireEvent.click(byTestId('tde-learner-save'));
    });
    // The editor draws the builder again with the task the save answered with.
    await act(async () => root.render(<DesignBuilder {...props} phase={saved} task={on} />));
    expect(host.querySelector('[aria-label="Diagram studio"]')).not.toBeNull();
    expect(queryTestId('design-screens')).toBeNull();
  });

  describe('edits still waiting out their 600 ms', () => {
    const record = row(DESIGN_JSON, serialiseDesign({ entities: [], relations: [], operations: [], decisions: [] }));
    const api = row(API_CONTRACT_JSON, '{"operations":[{"id":"listTasks","method":"GET","path":"/tasks"}],"errors":{}}');
    const withContracts = (contracts: { api: boolean; screens: boolean }) => {
      const task = { ...(designTask as { design: object }), design: { ...(designTask as { design: object }).design, contracts } } as never;
      return { task, phase: { ...(designPhase as object), tasks: [task] } as never };
    };
    const editApi = () =>
      act(() => {
        fireEvent.change(host.querySelector('textarea[aria-label="Behavior and boundaries"]')!, { target: { value: 'Lists every task.' } });
      });
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test('are saved before the documents are read again when a switch changes them', async () => {
      files.mockResolvedValue([record, api]);
      replaceFile.mockResolvedValue(answer);
      await act(async () => root.render(<DesignBuilder {...props} />));
      act(() => {
        fireEvent.click(byTestId('design-board-entity-add'));
      });
      // Step 3's save switched the screen contract on: the documents are read again.
      const next = withContracts({ api: true, screens: true });
      await act(async () => root.render(<DesignBuilder {...props} {...next} />));
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(replaceFile).toHaveBeenCalledTimes(1);
      const body = replaceFile.mock.calls[0][3] as { path: string; content: string };
      expect(body.path).toBe(DESIGN_JSON);
      expect(JSON.parse(body.content).entities).toHaveLength(1);
    });

    test("to a contract just switched off are not sent, and the builder says so in its own words", async () => {
      files.mockResolvedValue([record, api]);
      replaceFile.mockResolvedValue(answer);
      await act(async () => root.render(<DesignBuilder {...props} />));
      editApi();
      files.mockResolvedValue([record]);
      await act(async () => root.render(<DesignBuilder {...props} {...withContracts({ api: false, screens: false })} />));
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(replaceFile).not.toHaveBeenCalled();
      expect(byTestId('tde-start-status').textContent).toBe(
        'The API contract is switched off; turn it on in step 3 to edit its starting point.',
      );
    });

    test('to a contract just switched off never hold back the record edit waiting with them, even when not valid', async () => {
      files.mockResolvedValue([record, api]);
      replaceFile.mockResolvedValue(answer);
      await act(async () => root.render(<DesignBuilder {...props} />));
      act(() => {
        fireEvent.click(byTestId('design-board-entity-add'));
      });
      // a shared error catalogue that is not an object: the door would refuse this contract
      act(() => {
        fireEvent.click([...host.querySelectorAll('button')].find((one) => one.textContent === 'Errors')!);
      });
      const catalogue = host.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Shared error catalogue"]')!;
      act(() => {
        fireEvent.change(catalogue, { target: { value: '[]' } });
      });
      act(() => {
        fireEvent.focusOut(catalogue);
      });
      files.mockResolvedValue([record]);
      await act(async () => root.render(<DesignBuilder {...props} {...withContracts({ api: false, screens: false })} />));
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(replaceFile).toHaveBeenCalledTimes(1);
      const body = replaceFile.mock.calls[0][3] as { path: string; content: string };
      expect(body.path).toBe(DESIGN_JSON);
      expect(JSON.parse(body.content).entities).toHaveLength(1);
      expect(byTestId('tde-start-status').textContent).toBe(
        'The API contract is switched off; turn it on in step 3 to edit its starting point.',
      );
    });

    test("refused by the server as switched off are said in the builder's words, not the door's", async () => {
      files.mockResolvedValue([record, api]);
      replaceFile.mockRejectedValue(new ApiError(400, designContractOffRefusal('API')));
      await act(async () => root.render(<DesignBuilder {...props} />));
      editApi();
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(replaceFile).toHaveBeenCalledTimes(1);
      expect(byTestId('tde-start-status').textContent).toBe(
        'The API contract is switched off; turn it on in step 3 to edit its starting point.',
      );
    });
  });

  test('a starting point that cannot be read says so, and a switch-off still asks, without a count (Task 12b)', async () => {
    files.mockRejectedValue(new Error('offline'));
    await act(async () => root.render(<DesignBuilder {...props} />));
    expect(byTestId('tde-start-load-error').textContent).toBe('The starting point could not be read. Try again in a moment.');
    click('tde-contract-api');
    expect(byTestId('tde-switch-confirm-line').textContent).toBe('Switching the API contract off removes its starting document.');
  });

  test('switching a contract off asks first when its starting document holds something, and Keep it sends nothing', async () => {
    const api = JSON.stringify({ operations: [{ id: 'a', method: 'GET', path: '/a' }, { id: 'b', method: 'GET', path: '/b' }], errors: {} });
    files.mockResolvedValue([row(DESIGN_JSON, serialiseDesign({ entities: [], relations: [], operations: [], decisions: [] })), row(API_CONTRACT_JSON, api)]);
    updateTask.mockResolvedValue({ phase: designPhase, validation: null });
    await act(async () => root.render(<DesignBuilder {...props} />));
    click('tde-contract-api');
    const line = byTestId('tde-switch-confirm-line');
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toBe(
      'Switching the API contract off removes its starting document (2 endpoints). Switching it back on starts it empty.',
    );
    expect(byTestId('tde-switch-confirm').textContent).toBe('Switch it off');
    expect(byTestId('tde-contract-api').getAttribute('aria-checked')).toBe('true');
    click('tde-switch-keep');
    expect(queryTestId('tde-switch-confirm-line')).toBeNull();
    expect(byTestId('tde-contract-api').getAttribute('aria-checked')).toBe('true');
    expect(byTestId('tde-floor-minEndpoints').getAttribute('aria-disabled')).toBeNull();
    await act(async () => {
      fireEvent.focusOut(byTestId('tde-learner-design'));
    });
    expect(updateTask).not.toHaveBeenCalled();
    expect(replaceFile).not.toHaveBeenCalled();
    // Asked again and answered: the switch goes off, and the card saves it.
    click('tde-contract-api');
    click('tde-switch-confirm');
    expect(byTestId('tde-contract-api').getAttribute('aria-checked')).toBe('false');
    expect(byTestId('tde-floor-minEndpoints').getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      fireEvent.click(byTestId('tde-learner-save'));
    });
    expect((updateTask.mock.calls[0][4] as { design: { contracts: unknown } }).design.contracts).toEqual({ api: false, screens: false });
  });

  test('switching a contract off asks without a count until step 4 has read its documents, and after a failed read', async () => {
    // still being read: the switch asks anyway
    files.mockReturnValue(new Promise(() => undefined));
    await act(async () => root.render(<DesignBuilder {...props} />));
    click('tde-contract-api');
    expect(byTestId('tde-switch-confirm-line').textContent).toBe('Switching the API contract off removes its starting document.');
    expect(byTestId('tde-contract-api').getAttribute('aria-checked')).toBe('true');
    act(() => root.unmount());
    root = createRoot(host);
    // a read that failed: the switch still asks, without a count
    files.mockRejectedValue(new ApiError(500, 'down'));
    await act(async () => root.render(<DesignBuilder {...props} />));
    click('tde-contract-api');
    expect(byTestId('tde-switch-confirm-line').textContent).toBe('Switching the API contract off removes its starting document.');
    click('tde-switch-confirm');
    expect(byTestId('tde-contract-api').getAttribute('aria-checked')).toBe('false');
  });

  test('switching off a contract still holding its empty seed asks nothing, and the screen contract counts its screens', async () => {
    const both = { ...(designTask as { design: object }), design: { ...(designTask as { design: object }).design, contracts: { api: true, screens: true } } } as never;
    const phase = { ...(designPhase as object), tasks: [both] } as never;
    files.mockResolvedValue([
      row(DESIGN_JSON, serialiseDesign({ entities: [], relations: [], operations: [], decisions: [] })),
      row(API_CONTRACT_JSON, EMPTY_API_CONTRACT),
      row(SCREEN_CONTRACT_JSON, JSON.stringify({ screens: [{ route: '/tasks' }] })),
    ]);
    await act(async () => root.render(<DesignBuilder {...props} phase={phase} task={both} />));
    click('tde-contract-api');
    expect(queryTestId('tde-switch-confirm-line')).toBeNull();
    expect(byTestId('tde-contract-api').getAttribute('aria-checked')).toBe('false');
    click('tde-contract-screens');
    expect(byTestId('tde-switch-confirm-line').textContent).toBe(
      'Switching the screen contract off removes its starting document (1 screen). Switching it back on starts it empty.',
    );
    expect(byTestId('tde-contract-screens').getAttribute('aria-checked')).toBe('true');
  });

  test('Start empty asks first, then writes the empty record and each contract that is on', async () => {
    replaceFile.mockResolvedValue(answer);
    await act(async () => root.render(<DesignBuilder {...props} />));
    click('tde-start-empty');
    expect(byTestId('tde-start-confirm-line').textContent).toContain('start from nothing');
    await act(async () => {
      fireEvent.click(byTestId('tde-start-confirm'));
    });
    expect(replaceFile.mock.calls.map((call) => (call[3] as { path: string }).path)).toEqual([DESIGN_JSON, API_CONTRACT_JSON]);
    expect(JSON.parse((replaceFile.mock.calls[0][3] as { content: string }).content)).toEqual({ entities: [], relations: [], operations: [], decisions: [] });
  });

  test("Reset to the pack's sends each document with reset: 'source' and no bytes", async () => {
    replaceFile.mockResolvedValue(answer);
    await act(async () => root.render(<DesignBuilder {...props} />));
    click('tde-start-reset');
    await act(async () => {
      fireEvent.click(byTestId('tde-start-confirm'));
    });
    expect(replaceFile.mock.calls.map((call) => call[3])).toEqual([
      { path: DESIGN_JSON, reset: 'source' },
      { path: API_CONTRACT_JSON, reset: 'source' },
    ]);
  });

  test('says the refusal of a reset in its own words', async () => {
    replaceFile.mockRejectedValue(new ApiError(400, 'This draft was not opened from another version, so there is nothing to reset to.'));
    await act(async () => root.render(<DesignBuilder {...props} />));
    click('tde-start-reset');
    await act(async () => {
      fireEvent.click(byTestId('tde-start-confirm'));
    });
    expect(byTestId('tde-start-error').textContent).toContain('nothing to reset to');
  });

  test("Reset to the pack's carries on past a refusal: the record resets, the API contract's refusal is said, the screen contract is still tried", async () => {
    const both = { ...(designTask as { design: object }), design: { ...(designTask as { design: object }).design, contracts: { api: true, screens: true } } } as never;
    const phase = { ...(designPhase as object), tasks: [both] } as never;
    const record = { ...answer, phase: { ...(phase as object), intro: 'record' } };
    const screens = { ...answer, phase: { ...(phase as object), intro: 'screens' } };
    replaceFile.mockImplementation((_p: string, _v: string, _k: string, body: { path: string }) =>
      body.path === API_CONTRACT_JSON
        ? Promise.reject(new ApiError(400, 'The version this draft came from has no starting API contract.'))
        : Promise.resolve(body.path === DESIGN_JSON ? record : screens),
    );
    const onSaved = vi.fn();
    await act(async () => root.render(<DesignBuilder {...props} phase={phase} task={both} onSaved={onSaved} />));
    click('tde-start-reset');
    await act(async () => {
      fireEvent.click(byTestId('tde-start-confirm'));
    });
    expect(replaceFile.mock.calls.map((call) => (call[3] as { path: string }).path)).toEqual([DESIGN_JSON, API_CONTRACT_JSON, SCREEN_CONTRACT_JSON]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(screens);
    expect(byTestId('tde-start-error').textContent).toBe('The version this draft came from has no starting API contract.');
  });

  test('Start empty says every refusal it met, and hands the editor the last document that saved', async () => {
    const both = { ...(designTask as { design: object }), design: { ...(designTask as { design: object }).design, contracts: { api: true, screens: true } } } as never;
    const phase = { ...(designPhase as object), tasks: [both] } as never;
    replaceFile.mockImplementation((_p: string, _v: string, _k: string, body: { path: string }) =>
      body.path === DESIGN_JSON ? Promise.resolve(answer) : Promise.reject(new ApiError(400, `No ${body.path}.`)),
    );
    const onSaved = vi.fn();
    await act(async () => root.render(<DesignBuilder {...props} phase={phase} task={both} onSaved={onSaved} />));
    click('tde-start-empty');
    await act(async () => {
      fireEvent.click(byTestId('tde-start-confirm'));
    });
    expect(replaceFile).toHaveBeenCalledTimes(3);
    expect(onSaved).toHaveBeenCalledWith(answer);
    expect(byTestId('tde-start-error').textContent).toBe(`No ${API_CONTRACT_JSON}. No ${SCREEN_CONTRACT_JSON}.`);
  });

  test('a read-only version draws the starting point in words, with no control', async () => {
    files.mockResolvedValue([row(DESIGN_JSON, serialiseDesign({ entities: [], relations: [], operations: [], decisions: [] }))]);
    await act(async () => root.render(<DesignBuilder {...props} editable={false} />));
    expect(byTestId('tde-start-words').textContent).toBe('The starting point is an empty design.');
    expect(queryTestId('tde-start-empty')).toBeNull();
    expect(queryTestId('design-board-entities')).toBeNull();
    expect(queryTestId('tde-story-add')).toBeNull();
    expect(byTestId('tde-sequence-diagram').hasAttribute('disabled')).toBe(true);
  });
});

describe('the starting point in words', () => {
  const record = serialiseDesign({
    entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: [], satisfies: [] }],
    relations: [],
    operations: ['a', 'b', 'c'].map((name, i) => ({ id: `O${i + 1}`, name, inputs: [], returns: '', errors: [], satisfies: [] })),
    decisions: [{ id: 'D1', title: 't', choice: '', alternative: '', rationale: '', tradeOff: '', status: 'proposed', satisfies: [] }],
  });
  const api = JSON.stringify({ operations: [{}, {}, {}, {}, {}], errors: {} });
  const screens = JSON.stringify({ screens: [{}, {}, {}] });
  const files = [
    { path: DESIGN_JSON, content: record },
    { path: API_CONTRACT_JSON, content: api },
    { path: SCREEN_CONTRACT_JSON, content: screens },
  ];
  test('counts the record and each contract that is on', () => {
    expect(startingPointSentence(files, { contracts: { api: true, screens: true }, sequence: false })).toBe(
      'The starting point holds 1 entity, 3 operations and 1 decision; the API contract 5 endpoints; the screen contract 3 screens.',
    );
    expect(startingPointSentence(files, { contracts: { api: false, screens: false }, sequence: false })).toBe(
      'The starting point holds 1 entity, 3 operations and 1 decision.',
    );
    expect(startingPointSentence([], { contracts: { api: false, screens: false }, sequence: false })).toBe('The starting point is an empty design.');
  });

  test('Preview as a learner draws the stories, the switches and the floor in words, never a file', () => {
    const phase = {
      key: 'design',
      files: files.map((one) => ({ ...one, editable: true })),
      design: {
        contracts: { api: true, screens: false },
        sequence: true,
        stories: [{ id: 'US-4', title: 'Overdue report', line: 'As a person who runs TaskTrackr, I want a report.' }],
        floor: DEFAULT_DESIGN_FLOOR,
      },
    } as unknown as LearnerPreviewPhase;
    render(<PreviewDesign phase={phase} />);
    const text = byTestId('preview-design').textContent ?? '';
    expect(text).toContain('US-4');
    expect(text).toContain('Overdue report');
    expect(text).toContain('As a person who runs TaskTrackr, I want a report.');
    expect(text).toContain('The learner writes the design record, the API contract and the sequence diagram.');
    expect(text).toContain('Their design needs at least 2 entities and 1 relation');
    expect(text).toContain('a sequence diagram that names at least one of the operations');
    expect(text).toContain('The starting point holds 1 entity, 3 operations and 1 decision; the API contract 5 endpoints.');
    expect(text).not.toContain('.json');
  });
});
