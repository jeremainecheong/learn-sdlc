import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { ContentService, validateDesignChecks } from './content.service';
import { scoredKeysFor } from './rubric-scoring';
import { DirectoryPackSource } from './pack-source';
import { gradedPathsOf, gradedUnitsOf, soleTaskFor } from './pack-compiler';
import { evidenceOf, sealedTask } from '../workflow/task-view';
import { referenceFiles } from '../workflow/solution.reference';
import { referenceAnchor } from '../assistant/project-scope';
import { DEFAULT_DESIGN_CONTRACTS, DEFAULT_DESIGN_FLOOR, DESIGN_JSON, EMPTY_API_CONTRACT, serialiseDesign, EMPTY_DESIGN } from '@learnsdlc/shared';

const PACK = join(__dirname, '../../../../content/tasktrackr');
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function packWith(checks: unknown, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'design-pack-'));
  roots.push(root);
  cpSync(PACK, root, { recursive: true });
  const base = JSON.parse(JSON.stringify(require('../../../../content/tasktrackr/project.json')));
  base.slug = 'design-test'; base.version = '1.0.0';
  writeFileSync(join(root, 'project.json'), JSON.stringify(base));
  // the folder layout mounts a file by where it sits: files/ editable, readonly/ locked, at the
  // learner's path, its language read from that path; TaskTrackr's own design mounts are cleared first
  const design = join(root, 'phases', '02-design');
  for (const folder of ['files', 'readonly']) rmSync(join(design, folder), { recursive: true, force: true });
  for (const { path, content, editable } of (extra.files ?? []) as { path: string; content: string; editable: boolean }[]) {
    const at = join(design, editable ? 'files' : 'readonly', path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, content);
  }
  const { files: _mounted, ...members } = extra;
  writeFileSync(join(design, 'phase.json'), JSON.stringify({
    title: 'Design', intro: 'Two services and one contract.', artifactKind: 'design', canRun: false,
    taskPanel: 'Design the overdue report.', objectives: ['one'],
    rubric: { passThreshold: 70, criteria: [{ key: 'traceability', title: 'Traceability', weight: 1, description: 'Every story lands.' }] },
    checks, assistant: { systemPrompt: 'Be a mentor.', topics: [], progressive: [] }, ...members,
  }));
  return root;
}
const good = { kind: 'design', contracts: { api: true, screens: false }, sequence: false, stories: [{ id: 'US-4', title: 'Overdue report', line: 'As a lead, I want a report.' }], floor: DEFAULT_DESIGN_FLOOR };

describe('the design check kind', () => {
  const service = new ContentService();
  const load = (root: string) => service.loadProject(new DirectoryPackSource(root));
  it('loads a design phase, seeds the record and the API contract, and serves no markdown', () => {
    const phase = load(packWith(good)).phases.find((p) => p.key === 'design')!;
    expect(phase.checks.kind).toBe('design');
    expect(phase.artifactKind).toBe('design');
    expect(phase.files.map((f) => [f.path, f.editable])).toEqual([[DESIGN_JSON, true], ['shared/contract/api.json', true]]);
    expect(phase.files[0].content).toBe(serialiseDesign(EMPTY_DESIGN));
    expect(phase.files[1].content).toBe(EMPTY_API_CONTRACT);
    expect(gradedPathsOf(phase.checks)).toEqual([DESIGN_JSON, 'shared/contract/api.json']);
    expect(gradedUnitsOf(phase).map((u) => `${u.kind}:${u.id}`)).toEqual(['record:design/design.json', 'record:shared/contract/api.json']);
    expect([...scoredKeysFor(phase.checks, phase.rubric)]).toEqual(['traceability']);
  });
  it.each([
    // the folder layout refuses a taskFile in any phase.json, in its own sentence naming the folder
    ['a task file', { taskFile: 'task.md', taskPanel: undefined }, 'phases/02-design/phase.json: Design keeps its brief in taskPanel, not in a file.'],
    ['a markdown file', { files: [{ path: 'design/notes.md', content: 'x', editable: false, language: 'markdown' }] }, 'A Design phase mounts no markdown file: design/notes.md.'],
    ['a .markdown file', { files: [{ path: 'design/NOTES.markdown', content: 'x', editable: false, language: 'markdown' }] }, 'A Design phase mounts no markdown file: design/NOTES.markdown.'],
    ['a contract that is off', { files: [{ path: 'shared/contract/screens.json', content: '{"screens":[]}', editable: true, language: 'json' }] }, 'shared/contract/screens.json is mounted, but that contract is switched off.'],
    ['a locked record', { files: [{ path: DESIGN_JSON, content: serialiseDesign(EMPTY_DESIGN), editable: false, language: 'json' }] }, 'design/design.json must be editable: the learner writes it.'],
    ['an invalid starting record', { files: [{ path: DESIGN_JSON, content: '{"fields":[]}', editable: true, language: 'json' }] }, 'design/design.json: The design record is not valid: entities is not a list.'],
    ['a locked contract', { files: [{ path: 'shared/contract/api.json', content: EMPTY_API_CONTRACT, editable: false, language: 'json' }] }, 'shared/contract/api.json must be editable: the learner writes it.'],
    ['an invalid shipped contract', { files: [{ path: 'shared/contract/api.json', content: '{ not json', editable: true, language: 'json' }] }, 'shared/contract/api.json: '],
  ])('refuses %s', (_n, extra, message) => {
    expect(() => load(packWith(good, extra))).toThrow(message);
  });
  it('with the screen contract on, seeds it after the API contract, the record first', () => {
    const phase = load(packWith({ ...good, contracts: { api: true, screens: true } })).phases.find((p) => p.key === 'design')!;
    expect(phase.files.map((f) => f.path)).toEqual([DESIGN_JSON, 'shared/contract/api.json', 'shared/contract/screens.json']);
  });
  // the folder layout lists no mounts, so a pack cannot put the record after a contract; the
  // record is still served first and byte for byte when both are shipped under files/
  it('serves a shipped record byte for byte, and first beside a shipped contract', () => {
    const shipped = serialiseDesign({ ...EMPTY_DESIGN, notes: 'shipped as the teacher wrote it' });
    const phase = load(packWith(good, { files: [
      { path: 'shared/contract/api.json', content: EMPTY_API_CONTRACT, editable: true, language: 'json' },
      { path: DESIGN_JSON, content: shipped, editable: true, language: 'json' },
    ] })).phases.find((p) => p.key === 'design')!;
    expect(phase.files.map((f) => f.path)).toEqual([DESIGN_JSON, 'shared/contract/api.json']);
    expect(phase.files[0].content).toBe(shipped);
  });
});

describe('a design task beside the other kinds', () => {
  const service = new ContentService();
  const phase = service.loadProject(new DirectoryPackSource(packWith(good))).phases.find((p) => p.key === 'design')!;
  const task = soleTaskFor(phase);
  it('is sealed, settled by review, and serves no model answer', () => {
    expect(sealedTask(phase, task)).toBe(true);
    expect(evidenceOf(phase, task)).toBe('reviewed');
    expect(referenceFiles(phase, task)).toEqual({ available: false, reason: 'prose', files: [] });
  });
  it('anchors on the switches, the stories and the floor', () => {
    const anchor = referenceAnchor(phase, task);
    expect(referenceAnchor({ ...phase, checks: { ...good, record: DESIGN_JSON } as never }, task)).toBe(anchor);
    expect(referenceAnchor({ ...phase, checks: { ...good, record: DESIGN_JSON, sequence: true } as never }, task)).not.toBe(anchor);
    expect(referenceAnchor({ ...phase, checks: { ...good, record: DESIGN_JSON, floor: { ...DEFAULT_DESIGN_FLOOR, minEntities: 3 } } as never }, task)).not.toBe(anchor);
    expect(referenceAnchor({ ...phase, checks: { ...good, record: DESIGN_JSON, stories: [] } as never }, task)).not.toBe(anchor);
    expect(referenceAnchor({ ...phase, checks: { ...good, record: DESIGN_JSON, contracts: { api: true, screens: true } } as never }, task)).not.toBe(anchor);
  });
});

describe('validateDesignChecks', () => {
  it('fills the defaults', () => {
    expect(validateDesignChecks({ kind: 'design' })).toEqual({ kind: 'design', record: DESIGN_JSON, contracts: DEFAULT_DESIGN_CONTRACTS, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR });
  });
  it('keeps a sequence diagram the teacher switched on', () => {
    expect(validateDesignChecks({ kind: 'design', sequence: true }).sequence).toBe(true);
  });
  it.each([
    ['another phase', { kind: 'design' }, 'requirements', 'Only the Design phase can use the design kind.'],
    ['another record path', { kind: 'design', record: 'x.json' }, 'design', 'The design record is always design/design.json.'],
    ['13 stories', { kind: 'design', stories: Array.from({ length: 13 }, (_, i) => ({ id: `US-${i}`, title: 't', line: 'l' })) }, 'design', 'at most 12 stories'],
    ['a long story id', { kind: 'design', stories: [{ id: 'U'.repeat(17), title: 't', line: 'l' }] }, 'design', 'A story id is longer than 16 characters.'],
    ['a long line', { kind: 'design', stories: [{ id: 'US-1', title: 't', line: 'l'.repeat(401) }] }, 'design', 'Story US-1 has a title or line longer than 400 characters.'],
    ['a blank title', { kind: 'design', stories: [{ id: 'US-1', title: ' ', line: 'l' }] }, 'design', 'stories.title is required'],
    ['duplicate ids', { kind: 'design', stories: [{ id: 'US-1', title: 't', line: 'l' }, { id: 'US-1', title: 'u', line: 'm' }] }, 'design', 'stories ids must be unique'],
    ['a floor out of range', { kind: 'design', floor: { minEntities: 21 } }, 'design', 'floor.minEntities must be between 0 and 20'],
    ['a fractional floor', { kind: 'design', floor: { minScreens: 1.5 } }, 'design', 'floor.minScreens must be between 0 and 20'],
    ['a toggle that is not boolean', { kind: 'design', floor: { screenShape: 'yes' } }, 'design', 'floor.screenShape must be true or false'],
    ['a switch that is not boolean', { kind: 'design', contracts: { api: 1, screens: false } }, 'design', 'contracts.api and contracts.screens must be true or false.'],
    ['a sequence switch that is not boolean', { kind: 'design', sequence: 'on' }, 'design', 'sequence must be true or false.'],
  ])('refuses %s', (_n, spec, phaseKey, message) => {
    expect(() => validateDesignChecks(spec, phaseKey as never)).toThrow(message);
  });
  it('drops keys the kind does not have', () => {
    expect(Object.keys(validateDesignChecks({ kind: 'design', extra: 1, floor: { minEntities: 3, other: 2 } }).floor)).not.toContain('other');
  });
});
