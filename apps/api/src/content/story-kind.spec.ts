import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { ContentService, validateStoryChecks } from './content.service';
import { scoredKeysFor } from './rubric-scoring';
import { DirectoryPackSource } from './pack-source';
import { EMPTY_STORY, LEARNER_PICKS, STORY_CAPS, STORY_JSON, serialiseStory } from '@learnsdlc/shared';

const PACK = join(__dirname, '../../../../content/tasktrackr');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function packWith(checks: unknown, extra: Record<string, unknown> = {}) {
  // the whole real pack, so every other phase and the files they reach for are there
  const root = mkdtempSync(join(tmpdir(), 'story-pack-'));
  roots.push(root);
  cpSync(PACK, root, { recursive: true });
  const base = JSON.parse(JSON.stringify(require('../../../../content/tasktrackr/project.json')));
  base.slug = 'story-test'; base.version = '1.0.0';
  writeFileSync(join(root, 'project.json'), JSON.stringify(base));
  // the folder layout: the folder's name is the phase's key and order, and a mount is a file under files/
  const req = join(root, 'phases', '01-requirements');
  writeFileSync(join(req, 'phase.json'), JSON.stringify({
    title: 'Requirements', intro: 'Background.', artifactKind: 'story', canRun: false,
    taskPanel: 'Write the story.', objectives: ['one'],
    rubric: { passThreshold: 70, criteria: [{ key: 'story_structure', title: 'Structure', weight: 1, description: 'Full sentence.' }] },
    checks, assistant: { systemPrompt: 'Be a mentor.', topics: [], progressive: [] }, ...extra,
  }));
  return root;
}
const good = { kind: 'story', providedStories: [{ id: 'US-1', title: 'Add a task', persona: 'user', capability: 'add', benefit: 'track' }],
  learnerStory: { id: 'US-4', hints: { persona: 'team lead' } }, floor: { minCriteria: 2, requiredTags: ['happy', 'boundary'], minExclusions: 1, requireSentence: true } };

describe('the story check kind', () => {
  const service = new ContentService();
  const load = (root: string) => service.loadProject(new DirectoryPackSource(root));
  it('loads a story phase, synthesises the record file and reads taskPanel inline', () => {
    const project = load(packWith(good));
    const phase = project.phases.find(p => p.key === 'requirements')!;
    expect(phase.checks.kind).toBe('story');
    expect(phase.taskPanel).toBe('Write the story.');
    const file = phase.files.find(f => f.path === STORY_JSON)!;
    expect(file.editable).toBe(true);
    expect(JSON.parse(file.content).id).toBe('US-4');
  });
  it.each([
    ['too many criteria', { ...good, floor: { ...good.floor, minCriteria: 9 } }, 'floor.minCriteria must be between 1 and 8'],
    ['duplicate ids', { ...good, providedStories: [good.providedStories[0], good.providedStories[0]] }, 'providedStories ids must be unique'],
    ['learner id clashes', { ...good, learnerStory: { id: 'US-1', hints: {} } }, 'learnerStory.id must not be a provided story'],
    ['unknown tag', { ...good, floor: { ...good.floor, requiredTags: ['weird'] } }, 'floor.requiredTags'],
  ])('refuses %s', (_n, checks, message) => {
    expect(() => load(packWith(checks))).toThrow(message);
  });
});

describe('validateStoryChecks', () => {
  it('fills the default floor, record and learner story when the pack leaves them out', () => {
    expect(validateStoryChecks({ kind: 'story' })).toEqual({
      kind: 'story',
      record: STORY_JSON,
      providedStories: [],
      learnerStory: { id: 'US-4', hints: { persona: undefined, capability: undefined, benefit: undefined } },
      floor: { minCriteria: 2, requiredTags: ['happy', 'boundary'], minExclusions: 1, requireSentence: true },
    });
  });

  const story = (id: string) => ({ id, title: 't', persona: 'p', capability: 'c', benefit: 'b' });
  it.each([
    ['minExclusions out of range', { floor: { minExclusions: 7 } }, 'floor.minExclusions must be between 0 and 6'],
    ['requireSentence not a boolean', { floor: { requireSentence: 'yes' } }, 'floor.requireSentence must be true or false'],
    ['thirteen provided stories', { providedStories: Array.from({ length: 13 }, (_, i) => story(`US-${i + 10}`)) }, 'at most 12 providedStories'],
    ['a blank persona', { providedStories: [{ ...story('US-1'), persona: ' ' }] }, 'providedStories.persona is required'],
    ['a blank learner id', { learnerStory: { id: '', hints: {} } }, 'learnerStory.id is required'],
  ])('refuses %s', (_n, extra, message) => {
    expect(() => validateStoryChecks({ kind: 'story', ...extra })).toThrow(message);
  });

  // a worked example with a blank clause would teach the gap the floor refuses
  it.each(['given', 'when', 'then'])('refuses a provided criterion with a blank %s, fail-closed, in one fixed sentence', (clause) => {
    const criterion = { id: 'AC-1', given: 'g', when: 'w', then: 't', tag: 'happy', [clause]: '  ' };
    expect(() => validateStoryChecks({ kind: 'story', providedStories: [{ ...story('US-1'), criteria: [criterion] }] })).toThrow(
      'Provided story US-1 has a criterion with an empty Given, When or Then.',
    );
  });

  it('refuses a provided criterion with a clause missing altogether', () => {
    const criterion = { id: 'AC-1', given: 'g', then: 't', tag: 'happy' };
    expect(() => validateStoryChecks({ kind: 'story', providedStories: [{ ...story('US-2'), criteria: [criterion] }] })).toThrow(
      'Provided story US-2 has a criterion with an empty Given, When or Then.',
    );
  });

  it('accepts provided criteria whose three clauses are all written', () => {
    const criterion = { id: 'AC-1', given: 'g', when: 'w', then: 't', tag: 'happy' };
    expect(validateStoryChecks({ kind: 'story', providedStories: [{ ...story('US-1'), criteria: [criterion] }] }).providedStories[0].criteria).toEqual([criterion]);
  });

  it('expands the scored keys of a story phase to every criterion of its rubric', () => {
    const checks = validateStoryChecks({ kind: 'story' });
    expect([...scoredKeysFor(checks, { criteria: [{ key: 'story_structure' }, { key: 'acceptance_criteria' }] })]).toEqual([
      'story_structure',
      'acceptance_criteria',
    ]);
  });
});

describe('validateStoryChecks: the editor DTO\'s rules at the upload door', () => {
  const story = (id: string) => ({ id, title: 't', persona: 'p', capability: 'c', benefit: 'b' });
  const criterion = (extra: Record<string, unknown> = {}) => ({ id: 'AC-1', given: 'g', when: 'w', then: 't', tag: 'happy', ...extra });
  const long = (n: number) => 'x'.repeat(n + 1);
  it.each([
    ['a record path other than the fixed one', { record: 'requirements/mine.json' }, 'The story record is always requirements/story.json.'],
    ['providedStories that is not a list', { providedStories: { id: 'US-1' } }, 'providedStories must be a list.'],
    ['a provided story that is not an object', { providedStories: ['US-1'] }, 'Each provided story must be an object.'],
    ['a provided id over the cap', { providedStories: [story(long(STORY_CAPS.storyId))] }, `A provided story id is longer than ${STORY_CAPS.storyId} characters.`],
    ['a provided title over the cap', { providedStories: [{ ...story('US-1'), title: long(STORY_CAPS.storyTitle) }] }, `Provided story US-1 has a title longer than ${STORY_CAPS.storyTitle} characters.`],
    ['a provided persona over the cap', { providedStories: [{ ...story('US-1'), persona: long(STORY_CAPS.sentencePart) }] }, `Provided story US-1 has a persona longer than ${STORY_CAPS.sentencePart} characters.`],
    ['a provided capability over the cap', { providedStories: [{ ...story('US-1'), capability: long(STORY_CAPS.sentencePart) }] }, `Provided story US-1 has a capability longer than ${STORY_CAPS.sentencePart} characters.`],
    ['a provided benefit over the cap', { providedStories: [{ ...story('US-1'), benefit: long(STORY_CAPS.sentencePart) }] }, `Provided story US-1 has a benefit longer than ${STORY_CAPS.sentencePart} characters.`],
    ['more than 20 criteria on a provided story', { providedStories: [{ ...story('US-1'), criteria: Array.from({ length: STORY_CAPS.listItems + 1 }, (_, i) => criterion({ id: `AC-${i + 1}` })) }] }, `Provided story US-1 has more than ${STORY_CAPS.listItems} criteria.`],
    ['a criterion that is not an object', { providedStories: [{ ...story('US-1'), criteria: ['AC-1'] }] }, 'Provided story US-1 has a criterion that is not an object.'],
    ['a criterion id over the cap', { providedStories: [{ ...story('US-1'), criteria: [criterion({ id: long(STORY_CAPS.criterionId) })] }] }, `Provided story US-1 has a criterion id that is empty or longer than ${STORY_CAPS.criterionId} characters.`],
    ['a criterion with no id', { providedStories: [{ ...story('US-1'), criteria: [criterion({ id: undefined })] }] }, `Provided story US-1 has a criterion id that is empty or longer than ${STORY_CAPS.criterionId} characters.`],
    ['a criterion tag outside the set', { providedStories: [{ ...story('US-1'), criteria: [criterion({ tag: 'edge' })] }] }, 'Provided story US-1 has a criterion whose tag is not happy, boundary or error.'],
    ['a criterion clause over the cap', { providedStories: [{ ...story('US-1'), criteria: [criterion({ then: long(STORY_CAPS.criterionSentence) })] }] }, `Provided story US-1 has a criterion clause longer than ${STORY_CAPS.criterionSentence} characters.`],
    ['a learner story id over the cap', { learnerStory: { id: long(STORY_CAPS.storyId), hints: {} } }, `learnerStory.id is longer than ${STORY_CAPS.storyId} characters.`],
    ['hints that are not an object', { learnerStory: { id: 'US-4', hints: ['a team lead'] } }, 'learnerStory.hints must be an object of text hints.'],
    ['a hint that is not text', { learnerStory: { id: 'US-4', hints: { persona: 7 } } }, 'learnerStory.hints.persona must be text.'],
    ['a hint over the cap', { learnerStory: { id: 'US-4', hints: { benefit: long(STORY_CAPS.sentencePart) } } }, `learnerStory.hints.benefit is longer than ${STORY_CAPS.sentencePart} characters.`],
  ])('refuses %s, in one fixed sentence', (_n, extra, message) => {
    expect(() => validateStoryChecks({ kind: 'story', ...extra })).toThrow(message);
  });

  it('refuses the story kind on any phase but Requirements', () => {
    expect(() => validateStoryChecks({ kind: 'story' }, 'design')).toThrow('Only the Requirements phase can use the story kind.');
    expect(() => validateStoryChecks({ kind: 'story' }, 'deployment')).toThrow('Only the Requirements phase can use the story kind.');
    expect(validateStoryChecks({ kind: 'story' }, 'requirements').kind).toBe('story');
  });

  it('accepts a learner-picks id and every field at its cap', () => {
    const at = (n: number) => 'x'.repeat(n);
    const checks = validateStoryChecks({
      kind: 'story',
      providedStories: [{ id: at(STORY_CAPS.storyId), title: at(STORY_CAPS.storyTitle), persona: at(STORY_CAPS.sentencePart), capability: at(STORY_CAPS.sentencePart), benefit: at(STORY_CAPS.sentencePart),
        criteria: [criterion({ id: at(STORY_CAPS.criterionId), given: at(STORY_CAPS.criterionSentence) })] }],
      learnerStory: { id: LEARNER_PICKS, hints: { persona: at(STORY_CAPS.sentencePart) } },
    });
    expect(checks.learnerStory.id).toBe(LEARNER_PICKS);
    expect(checks.providedStories).toHaveLength(1);
  });

  it('the editor DTO reads the same caps', async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const { StoryChecksDto } = await import('../authoring/authoring.dto');
    const body = (provided: Record<string, unknown>) => plainToInstance(StoryChecksDto, {
      providedStories: [provided], learnerStory: { id: 'US-4', hints: {} }, floor: { minCriteria: 2, requiredTags: ['happy'], minExclusions: 1, requireSentence: true },
    });
    expect(await validate(body({ ...story('US-1'), criteria: [criterion({ given: 'x'.repeat(STORY_CAPS.criterionSentence) })] }))).toEqual([]);
    expect((await validate(body({ ...story('US-1'), criteria: [criterion({ given: 'x'.repeat(STORY_CAPS.criterionSentence + 1) })] }))).length).toBeGreaterThan(0);
    expect((await validate(body({ ...story('x'.repeat(STORY_CAPS.storyId + 1)) }))).length).toBeGreaterThan(0);
  });
});

describe('the story phase in the loader', () => {
  const service = new ContentService();
  const requirements = (root: string) =>
    service.loadProject(new DirectoryPackSource(root)).phases.find((p) => p.key === 'requirements')!;
  const shippedRecord = serialiseStory(EMPTY_STORY);

  it('seeds an empty id when the learner picks the story', () => {
    const phase = requirements(packWith({ ...good, learnerStory: { id: LEARNER_PICKS, hints: {} } }));
    expect(JSON.parse(phase.files.find((f) => f.path === STORY_JSON)!.content).id).toBe('');
  });

  it('keeps a record file the pack ships at checks.record', () => {
    // distinguishable from the seed the loader would write, so an overwrite shows
    const shipped = JSON.stringify({ ...JSON.parse(shippedRecord), id: 'US-9', title: 'shipped' }, null, 2) + '\n';
    // shipped where the learner sees it: files/ at the record's own path
    const root = packWith(good);
    const at = join(root, 'phases', '01-requirements', 'files', STORY_JSON);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, shipped);
    const records = requirements(root).files.filter((f) => f.path === STORY_JSON);
    expect(records).toHaveLength(1);
    expect(records[0].content).toBe(shipped);
    expect(JSON.parse(records[0].content)).toMatchObject({ id: 'US-9', title: 'shipped' });
  });

  // the folder layout keeps every brief inline, so a taskFile beside a taskPanel is refused by name, not read over it
  it('refuses a taskFile even when a taskPanel is present', () => {
    const root = packWith(good, { taskFile: 'task.md' });
    writeFileSync(join(root, 'phases', '01-requirements', 'task.md'), '## From the file\n');
    expect(() => requirements(root)).toThrow('phases/01-requirements/phase.json: Requirements keeps its brief in taskPanel, not in a file.');
  });

  it('refuses a phase with no taskPanel', () => {
    expect(() => requirements(packWith(good, { taskPanel: undefined }))).toThrow('phase needs taskPanel');
  });

  it('accepts a rubric of two criteria, both scored by the floor', () => {
    const phase = requirements(packWith(good, {
      rubric: { passThreshold: 70, criteria: [
        { key: 'story_structure', title: 'Structure', weight: 0.5, description: 'Full sentence.' },
        { key: 'acceptance_criteria', title: 'Criteria', weight: 0.5, description: 'Testable.' },
      ] },
    }));
    expect(phase.rubric.criteria.map((c) => c.key)).toEqual(['story_structure', 'acceptance_criteria']);
  });
});
