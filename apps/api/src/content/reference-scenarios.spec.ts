import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PhaseKey } from '@learnsdlc/shared';
import { digestOf } from './blob.store';
import type { PhaseContent } from './content.types';
import {
  applicationDigest,
  isReferenceApplication,
  isReferenceFile,
  isReferenceInterview,
  isReferenceIntro,
  isReferenceScenario,
  scenarioDigest,
} from './reference-content';
import { REFERENCE_SCENARIOS } from './reference-scenarios';
import { SCREEN_COPY_PATH, withScreenCopy } from './screen-copy';
import { recordReferenceScenarioRows } from '../../test/reference-scenario-table';
import { tasktrackrContent, tasktrackrPhase } from '../../test/tasktrackr-phase';
import { FIXTURES_DIR } from '../../test/fixtures/paths';

/**
 * The scenario anchor's committed table: the drift check, the append-only pin, and what each digest is a
 * function of.
 */

const WRITTEN: PhaseKey[] = ['requirements', 'design'];
const EXECUTABLE: PhaseKey[] = ['implementation', 'testing', 'deployment', 'maintenance'];

/** TaskTrackr 3.0.0's two read-only Design documents, from the legacy fixture that keeps their bytes. */
const LEGACY_DOCUMENTS = [
  ['requirements/provided-stories.md', 'provided-stories.md'],
  ['design/architecture.md', 'architecture.md'],
].map(([path, source]) => ({
  path,
  content: readFileSync(join(FIXTURES_DIR, 'legacy-design', source), 'utf8'),
  editable: false,
  language: 'markdown',
}));

describe('the committed scenario table', () => {
  it('holds exactly what the pack on disk records, for its own version (the drift check)', () => {
    const recorded = recordReferenceScenarioRows(tasktrackrContent());
    const project = tasktrackrContent().getProject('tasktrackr');
    const committed = REFERENCE_SCENARIOS.filter((row) => row.pack === 'tasktrackr' && row.version === project.version);
    expect(committed).toEqual(recorded);
  });

  it('records a scenario, an intro and each read-only document per written phase, the interview once, and an application per executable phase', () => {
    const rows = REFERENCE_SCENARIOS.filter((row) => row.pack === 'tasktrackr' && row.version === '2.0.1');
    const of = (key: PhaseKey) => rows.filter((row) => row.phaseKey === key).map((row) => `${row.grain}:${row.key}`).sort();
    expect(of('requirements')).toEqual(['file:requirements/provided-stories.md', 'interview:', 'intro:', 'scenario:']);
    expect(of('design')).toEqual(['file:design/architecture.md', 'file:requirements/provided-stories.md', 'intro:', 'scenario:']);
    for (const key of EXECUTABLE) expect([key, of(key)]).toEqual([key, ['application:', 'intro:']]);
    // no digest of a sealed or editable file, ever: only what a learner reads and nobody's task owns
    expect(rows.filter((row) => row.grain === 'file').map((row) => row.key)).not.toContain('requirements/my-story.md');
    expect(rows.some((row) => /interview\/brief\.json|hidden\/|solution\//.test(row.key))).toBe(false);
  });

  it('records 3.0.0 Requirements as its scenario, intro and interview: the story phase ships no document', () => {
    const rows = REFERENCE_SCENARIOS.filter((row) => row.pack === 'tasktrackr' && row.version === '3.0.0');
    const of = (key: PhaseKey) => rows.filter((row) => row.phaseKey === key).map((row) => `${row.grain}:${row.key}`).sort();
    expect(of('requirements')).toEqual(['interview:', 'intro:', 'scenario:']);
    expect(of('design')).toEqual(['file:design/architecture.md', 'file:requirements/provided-stories.md', 'intro:', 'scenario:']);
    for (const key of EXECUTABLE) expect([key, of(key)]).toEqual([key, ['application:', 'intro:']]);
    // every row outside Requirements carries the digest 2.0.1 recorded: nothing else moved
    const older = REFERENCE_SCENARIOS.filter((row) => row.pack === 'tasktrackr' && row.version === '2.0.1');
    const strip = ({ version: _v, ...rest }: (typeof rows)[number]) => rest;
    expect(rows.filter((row) => row.phaseKey !== 'requirements').map(strip)).toEqual(
      older.filter((row) => row.phaseKey !== 'requirements').map(strip),
    );
  });

  it('records 4.0.0 Design as its scenario and intro: the design phase mounts no document, and nothing else moved', () => {
    const rows = REFERENCE_SCENARIOS.filter((row) => row.pack === 'tasktrackr' && row.version === '4.0.0');
    const of = (key: PhaseKey) => rows.filter((row) => row.phaseKey === key).map((row) => `${row.grain}:${row.key}`).sort();
    expect(of('design')).toEqual(['intro:', 'scenario:']);
    // every row outside Design carries the digest 3.0.0 recorded
    const older = REFERENCE_SCENARIOS.filter((row) => row.pack === 'tasktrackr' && row.version === '3.0.0');
    const strip = ({ version: _v, ...rest }: (typeof rows)[number]) => rest;
    expect(rows.filter((row) => row.phaseKey !== 'design').map(strip)).toEqual(
      older.filter((row) => row.phaseKey !== 'design').map(strip),
    );
  });

  it('pins the 2.0.1 rows by digest, so a later pack can only append', () => {
    const rows = REFERENCE_SCENARIOS.filter((row) => row.pack === 'tasktrackr' && row.version === '2.0.1');
    expect(rows).toHaveLength(16);
    expect(digestOf(rows)).toBe(PINNED_2_0_1_SCENARIO_ROWS);
  });
});

/** sha256 of `canonicalJson` over the sixteen 2.0.1 rows. Append-only; never regenerate. */
const PINNED_2_0_1_SCENARIO_ROWS = '3a42c89a26911f4c842c6d65547163805da92a843189af4e653b1c6af3b8fbb5';

describe('what the scenario digest is a function of', () => {
  it.each(WRITTEN)('answers reference for the shipped %s phase', (key) => {
    expect(isReferenceScenario(tasktrackrPhase(key))).toBe(true);
  });

  it.each(EXECUTABLE)("answers reference for the shipped %s phase's application", (key) => {
    expect(isReferenceApplication(tasktrackrPhase(key))).toBe(true);
    expect(isReferenceIntro(key, tasktrackrPhase(key).intro)).toBe(true);
  });

  it('is a function of the bytes, not of the object or its key order', () => {
    const phase = tasktrackrPhase('requirements');
    const clone = JSON.parse(JSON.stringify(phase)) as PhaseContent;
    expect(scenarioDigest(clone)).toBe(scenarioDigest(phase));
    // the interview with every key written in reverse order is the same interview
    const reversed = <T>(value: T): T =>
      Array.isArray(value)
        ? (value.map(reversed) as unknown as T)
        : value && typeof value === 'object'
          ? (Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reversed(v)])) as T)
          : value;
    expect(isReferenceInterview(reversed(phase.interview))).toBe(true);
    expect(isReferenceScenario({ ...clone, interview: reversed(phase.interview) })).toBe(true);
  });

  it('moves on the intro, the interview and every read-only document, and on nothing a task owns', () => {
    // TaskTrackr 4.0.0's Design mounts its three records alone, so the read-only documents are 3.0.0's, mounted beside them
    const shipped = tasktrackrPhase('design');
    expect(shipped.files.filter((file) => !file.editable)).toEqual([]);
    const phase: PhaseContent = { ...shipped, files: [...shipped.files, ...LEGACY_DOCUMENTS] };
    const base = scenarioDigest(phase);
    const readOnly = phase.files.filter((file) => !file.editable);
    const editable = phase.files.filter((file) => file.editable);
    expect(readOnly.map((file) => file.path).sort()).toEqual(['design/architecture.md', 'requirements/provided-stories.md']);
    const moved: Array<[string, PhaseContent]> = [
      ['intro', { ...phase, intro: `${phase.intro} ` }],
      ...readOnly.map((file): [string, PhaseContent] => [
        file.path,
        { ...phase, files: phase.files.map((one) => (one.path === file.path ? { ...one, content: `${one.content}\n` } : one)) },
      ]),
    ];
    for (const [what, variant] of moved) {
      expect([what, scenarioDigest(variant)]).not.toEqual([what, base]);
      expect([what, isReferenceScenario(variant)]).toEqual([what, false]);
    }
    // an editable starter belongs to the task that owns it, whose anchor hashes it
    const starter = { ...phase, files: phase.files.map((one) => (one.path === editable[0].path ? { ...one, content: '# Ours\n' } : one)) };
    expect(scenarioDigest(starter)).toBe(base);

    const requirements = tasktrackrPhase('requirements');
    const fact = requirements.interview!.facts[0];
    const edited = { ...requirements, interview: { ...requirements.interview!, facts: [{ ...fact, answer: `${fact.answer} ` }, ...requirements.interview!.facts.slice(1)] } };
    expect(isReferenceScenario(edited)).toBe(false);
    expect(isReferenceInterview(edited.interview)).toBe(false);
    expect(isReferenceScenario({ ...requirements, interview: undefined })).toBe(false);
  });

  it('marks one read-only document by its bytes, and the original bytes again after a revert', () => {
    // TaskTrackr 3.0.0's Design read the backlog as a document, and its row still names those bytes
    const backlog = LEGACY_DOCUMENTS.find((file) => file.path === 'requirements/provided-stories.md')!;
    expect(isReferenceFile('design', backlog.path, backlog.content)).toBe(true);
    expect(isReferenceFile('design', backlog.path, '# RoomDesk backlog\n')).toBe(false);
    // the same bytes at a path the table does not hold are not the reference's
    expect(isReferenceFile('design', 'requirements/elsewhere.md', backlog.content)).toBe(false);
  });

  it("leaves the screen copy a learner's Design pass lays over the application out of its digest", () => {
    const phase = tasktrackrPhase('implementation');
    expect(phase.files.some((file) => file.path === SCREEN_COPY_PATH)).toBe(true);
    const overlaid = withScreenCopy(phase, {
      version: 1,
      sourceSubmissionId: 'submission-1',
      sourcePhaseStateId: 'phase-state-1',
      title: 'Rooms free now',
      empty: 'No room is free right now.',
    });
    expect(overlaid).not.toBe(phase);
    expect(applicationDigest(overlaid)).toBe(applicationDigest(phase));
    expect(isReferenceApplication(overlaid)).toBe(true);
    // and it still moves on any other byte of the application
    const other = phase.files.find((file) => file.path !== SCREEN_COPY_PATH && file.path !== 'shared/contract/screens.json')!;
    const touched = { ...phase, files: phase.files.map((file) => (file.path === other.path ? { ...file, content: `${file.content}\n` } : file)) };
    expect(isReferenceApplication(touched)).toBe(false);
  });
});
