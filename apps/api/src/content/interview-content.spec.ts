import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config';
import { ContentService } from './content.service';

/**
 * The interview brief, loaded from the packs that ship.
 *
 * A pack is hand-authored JSON, so the loader's job is to name its own mistake
 * at boot rather than surface as an undefined three services away, and the
 * mistakes worth naming here are the ones that make the room unusable in a
 * quiet way: two facts with the same id (the checklist shows one row and ticks
 * two), an empty keyword list (a fact nothing can ever reach), and
 * `factsExpected` above the number of facts declared (a readout that can never
 * say "enough").
 */
describe('the shipped packs', () => {
  const content = new ContentService();
  content.loadAll();

  // The tree ships one pack, and this loops the catalogue
  // rather than a list written here, so a second pack gets the same scrutiny
  // the day one is added and a renamed pack cannot skip the whole describe.
  for (const slug of content.listProjects().map((project) => project.slug)) {
    describe(slug, () => {
      const phase = content.getPhase(slug, 'requirements');
      const brief = content.interviewBrief(phase);

      it('declares an interview on the requirements phase, and on no other', () => {
        expect(brief).not.toBeNull();
        for (const other of content.getProject(slug).phases) {
          if (other.key === 'requirements') continue;
          expect(content.interviewBrief(other)).toBeNull();
        }
      });

      it('names a customer, an opening, a refusal and an answer for not knowing', () => {
        expect(brief?.persona.name).toBeTruthy();
        expect(brief?.persona.role).toContain('product owner');
        expect(brief?.opening.length).toBeGreaterThan(20);
        expect(brief?.refusal.toLowerCase()).toContain('customer');
        expect(brief?.unknownReply.length).toBeGreaterThan(10);
      });

      it('gives every fact a unique id, a topic, keywords and an answer', () => {
        const ids = new Set<string>();
        for (const fact of brief?.facts ?? []) {
          expect(fact.id).toMatch(/^[A-Za-z0-9_-]{1,16}$/);
          expect(ids.has(fact.id)).toBe(false);
          ids.add(fact.id);
          expect(fact.topic.length).toBeGreaterThan(0);
          expect(fact.topic.length).toBeLessThanOrEqual(80);
          expect(fact.keywords.length).toBeGreaterThan(0);
          expect(fact.answer.length).toBeGreaterThan(0);
          expect(fact.answer.length).toBeLessThanOrEqual(1200);
        }
        expect(ids.size).toBeGreaterThanOrEqual(5);
      });

      it('can be finished: factsExpected never exceeds the facts declared', () => {
        expect(brief?.factsExpected).toBeGreaterThanOrEqual(1);
        expect(brief?.factsExpected).toBeLessThanOrEqual(brief?.facts.length ?? 0);
        expect(brief?.maxTurns).toBeGreaterThanOrEqual(brief?.factsExpected ?? 0);
      });

      it('keeps the answers out of the workspace: the brief is not a file', () => {
        const paths = phase.files.map((file) => file.path);
        expect(paths.some((p) => p.includes('interview'))).toBe(false);
        const workspace = JSON.stringify(content.workspaceFiles(phase, null));
        for (const fact of brief?.facts ?? []) {
          expect(workspace).not.toContain(fact.answer);
        }
      });

      it('settles the edge cases the rubric already rewards writing down', () => {
        const topics = (brief?.facts ?? []).map((fact) => fact.topic).join(' | ');
        expect(topics).toContain('due today');
        expect(topics).toContain('completed');
        expect(topics).toContain('out of scope');
      });
    });
  }
});

/**
 * The refusals. Each writes one broken pack into a temporary directory and
 * loads it, so the message a pack author would actually read is the thing
 * under test.
 */
describe('a broken interview brief', () => {
  let dir = '';
  const realContentDir = config.contentDir;

  const goodBrief = {
    persona: { name: 'Dana Osei', role: 'product owner' },
    opening: 'I have ten minutes.',
    unknownReply: 'I have not decided that.',
    refusal: 'I am the customer, not the author.',
    maxTurns: 12,
    factsExpected: 1,
    facts: [{ id: 'F1', topic: 'who it is for', keywords: ['who'], answer: 'the morning planner' }],
  };

  /**
   * A pack copied out of the real one, in the folder layout, with the brief
   * replaced: Requirements alone, or, for another phase key, Requirements and
   * Design with the brief on Design (only Requirements may be a story phase,
   * so the brief moves rather than the key). The brief is the phase folder's
   * interview.json; `raw` writes that file's text as it is.
   */
  const packWith = (brief: unknown, phaseKey = 'requirements', raw?: string): string => {
    const root = fs.mkdtempSync(path.join(dir, 'pack-'));
    const source = path.join(realContentDir, 'tasktrackr');
    const dirs = phaseKey === 'requirements' ? ['01-requirements'] : ['01-requirements', '02-design'];
    for (const one of dirs) fs.cpSync(path.join(source, 'phases', one), path.join(root, 'tasktrackr', 'phases', one), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'tasktrackr', 'project.json'),
      JSON.stringify({
        slug: 'tasktrackr',
        version: '1.0.0',
        title: 'TaskTrackr',
        tagline: 't',
        description: 'd',
        language: 'python',
      }),
    );
    for (const one of dirs) {
      const file = path.join(root, 'tasktrackr', 'phases', one, 'interview.json');
      fs.rmSync(file, { force: true });
      if (one.endsWith(`-${phaseKey}`) && (brief !== undefined || raw !== undefined)) fs.writeFileSync(file, raw ?? JSON.stringify(brief));
    }
    return root;
  };

  const load = (root: string): ContentService => {
    config.contentDir = root;
    const service = new ContentService();
    service.loadAll();
    return service;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-interview-'));
  });

  afterAll(() => {
    config.contentDir = realContentDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    config.contentDir = realContentDir;
    jest.restoreAllMocks();
  });

  it('names the file and the field when two facts share an id', () => {
    const root = packWith({
      ...goodBrief,
      facts: [goodBrief.facts[0], { ...goodBrief.facts[0], topic: 'something else' }],
    });
    expect(() => load(root)).toThrow(/interview\.facts\[1\]: duplicate fact id "F1"/);
  });

  it('refuses a fact nothing can ever reach', () => {
    const root = packWith({ ...goodBrief, facts: [{ ...goodBrief.facts[0], keywords: [] }] });
    expect(() => load(root)).toThrow(/interview\.facts\[0\]\.keywords must not be empty/);
  });

  it('refuses a room with no questions in it', () => {
    const root = packWith({ ...goodBrief, maxTurns: 0 });
    expect(() => load(root)).toThrow(/interview\.maxTurns must be an integer 1\.\.40/);
  });

  it('refuses a readout that can never say "enough"', () => {
    const root = packWith({ ...goodBrief, factsExpected: 4 });
    expect(() => load(root)).toThrow(/interview\.factsExpected must be an integer between 1 and the 1/);
  });

  it('refuses a customer with no name', () => {
    const root = packWith({ ...goodBrief, persona: { name: '', role: 'owner' } });
    expect(() => load(root)).toThrow(/interview\.persona\.name must be a non-empty string/);
  });

  it('refuses a brief that is not valid JSON', () => {
    const root = packWith(undefined, 'requirements', '{ not json');
    expect(() => load(root)).toThrow(/interview is not valid JSON/);
  });

  it('refuses a brief on a phase that is not requirements, by the folder layout\'s sentence', () => {
    // the folder layout fixes the interview at Requirements' interview.json: one elsewhere is refused by name,
    // where the older layout's interview member on another phase was dropped with a warning
    const root = packWith(goodBrief, 'design');
    expect(() => load(root)).toThrow('phases/02-design/interview.json: only Requirements holds a stakeholder interview.');
  });

  it('loads a pack that declares no interview at all', () => {
    const root = packWith(undefined);
    const service = load(root);
    expect(service.interviewBrief(service.getPhase('tasktrackr', 'requirements'))).toBeNull();
  });
});
