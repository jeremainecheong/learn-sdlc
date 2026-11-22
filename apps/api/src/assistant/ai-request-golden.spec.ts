import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { StuckService } from './stuck.service';
import { AssistantService } from './assistant.service';
import { OpenAiProvider } from './openai.provider';
import {
  AI_GOLDEN_BASE_URL,
  AI_GOLDEN_EFFORT,
  AI_GOLDEN_MODEL,
  AI_GOLDEN_PACK,
  RECORDED_SURFACES,
  RecordingTransport,
  aiRequestFixturePath,
  entryKey,
  firstDifferingEntry,
  readAiRequestFixture,
  recordAiRequests,
  type AiRequestManifest,
} from '../../test/ai-request-golden';

/**
 * The request-bytes golden net: TaskTrackr's model requests, held against a
 * recorded fixture of the bodies they send.
 *
 * The reviewer, the mentor and the Agentic prompts are scoped to the content
 * that declares them. The promise to TaskTrackr is that a learner of the
 * shipped project cannot tell: every request body TaskTrackr sends stays the
 * same bytes. This is the file that says so in one command, `--check`
 * semantics, in the suite: the fixture is read, never written, and a moved
 * body fails by naming its scenario, phase, call and surface.
 *
 * Regenerating the fixture is a deliberate act with a reason declared per surface, a
 * planned change to a reference prompt, and it is never the fix for a
 * failing step.
 */
describe('the request-bytes golden net', () => {
  const content = new ContentService();
  content.loadAll();
  const project = content.getProject(AI_GOLDEN_PACK);
  const recorded = readAiRequestFixture();
  let fresh: AiRequestManifest;
  // What the recorder borrows, as it was before it borrowed it.
  const before = {
    fetch: globalThis.fetch,
    openaiApiKey: config.openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    openaiModel: config.openaiModel,
    openaiReasoningEffort: config.openaiReasoningEffort,
  };

  beforeAll(async () => {
    // Every model call logs an `ai_call` line; forty of them say nothing here.
    Logger.overrideLogger(false);
    fresh = await recordAiRequests(content);
  });

  afterAll(() => {
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  // The same fence the verdict net keeps: the module this runs is the source,
  // not a compiled twin a build once dropped beside it.
  it('runs the TypeScript recorder, not a compiled twin left beside it', () => {
    const resolved = require.resolve('../../test/ai-request-golden');
    expect(path.extname(resolved)).toBe('.ts');
    const twin = `${resolved.slice(0, -'.ts'.length)}.js`;
    expect(fs.existsSync(twin)).toBe(false);
  });

  it('has a committed fixture for the pack on disk, under the hard-limit model settings', () => {
    // Without it every comparison below would pass by having nothing to compare.
    expect(recorded).not.toBeNull();
    expect(recorded!.pack).toBe(AI_GOLDEN_PACK);
    expect(recorded!.version).toBe(project.version);
    expect([recorded!.model, recorded!.effort]).toEqual(['gpt-5.6-luna', 'none']);
    expect([AI_GOLDEN_MODEL, AI_GOLDEN_EFFORT]).toEqual([recorded!.model, recorded!.effort]);
    expect(recorded!.entries.length).toBeGreaterThan(0);
  });

  it('keeps digests only: no body, prompt or key reaches the committed fixture', () => {
    const raw = fs.readFileSync(aiRequestFixturePath(), 'utf-8');
    for (const entry of recorded!.entries) {
      expect(Object.keys(entry).sort()).toEqual(['call', 'length', 'phase', 'scenario', 'sha256', 'surface']);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(entry.length) && entry.length > 0).toBe(true);
    }
    expect(raw).not.toMatch(/messages|systemPrompt|golden-recorder-placeholder|Bearer|sk-/);
  });

  it('every request body TaskTrackr sends matches its recorded digest', () => {
    // The digest is the assertion; the entry is the sentence it fails with.
    expect(firstDifferingEntry(recorded!.entries, fresh.entries)).toBeNull();
    expect(fresh.entries).toEqual(recorded!.entries);
  });

  it('covers every model-facing surface and every phase', () => {
    const surfaces = new Set(recorded!.entries.map((entry) => entry.surface));
    // `agentic.generate.edits` exists only while
    // AI_AGENTIC_EDIT_LIST is not off. The net records the code default,
    // off (strict is recorded by the strict fixture beside it:
    // ai-request-strict.spec.ts), so that label is the one surface it must never see.
    expect(surfaces.has('agentic.generate.edits')).toBe(false);
    expect([...RECORDED_SURFACES].filter((surface) => surface !== 'agentic.generate.edits' && !surfaces.has(surface))).toEqual([]);
    const phases = project.phases.map((phase) => phase.key);
    for (const scenario of [
      'grading:scaffold-no-checks',
      'grading:fixed-checks',
      'grading:build-report',
      'guided:plain',
      'guided:instructor-notes',
      'guided:memory',
      'guided:last-failed-checks',
      'guided:repair',
      'lesson:plain',
      'agentic:propose-explain',
      'agentic:chat',
      // A turn with more history than a prompt carries.
      'guided:history',
    ]) {
      const covered = new Set(recorded!.entries.filter((entry) => entry.scenario === scenario).map((entry) => entry.phase));
      expect([scenario, phases.filter((key) => !covered.has(key))]).toEqual([scenario, []]);
    }
    // Explain on the phases whose learners run tests; the interview where the pack has one.
    const where = (scenario: string) => [...new Set(recorded!.entries.filter((entry) => entry.scenario === scenario).map((entry) => entry.phase))];
    expect(where('explain:failing-test')).toEqual(project.phases.filter((phase) => ['code', 'tests'].includes(phase.checks.kind)).map((phase) => phase.key));
    expect(where('interview:plain')).toEqual(project.phases.filter((phase) => content.interviewBrief(phase)).map((phase) => phase.key));
    // One grading body per graded submission, and the Guided repair really repaired.
    for (const entry of recorded!.entries.filter((row) => row.scenario.startsWith('grading:'))) {
      expect([entryKey(entry), entry.call]).toEqual([entryKey(entry), 1]);
    }
    expect(recorded!.entries.filter((entry) => entry.scenario === 'guided:repair' && entry.phase === 'requirements').map((entry) => entry.surface))
      .toEqual(['guided.draft', 'guided.review', 'guided.draft', 'guided.review']);
  });

  it('records one manifest however many times it runs in one process', async () => {
    // Nothing the first recording left behind, a cache row, a memo, a
    // metric, a module-level constant, may move the second.
    const again = await recordAiRequests(content);
    expect(firstDifferingEntry(fresh.entries, again.entries)).toBeNull();
  });

  it('puts back fetch, the key, the model settings and the transport it borrowed', () => {
    expect(globalThis.fetch).toBe(before.fetch);
    expect({
      openaiApiKey: config.openaiApiKey,
      openaiBaseUrl: config.openaiBaseUrl,
      openaiModel: config.openaiModel,
      openaiReasoningEffort: config.openaiReasoningEffort,
    }).toEqual({
      openaiApiKey: before.openaiApiKey,
      openaiBaseUrl: before.openaiBaseUrl,
      openaiModel: before.openaiModel,
      openaiReasoningEffort: before.openaiReasoningEffort,
    });
  });

  it('refuses any URL but the chat completions endpoint, and any undeclared call', async () => {
    const transport = new RecordingTransport();
    const base = config.openaiBaseUrl;
    config.openaiBaseUrl = AI_GOLDEN_BASE_URL;
    try {
      transport.script([() => 'unused']);
      await expect(transport.fetch('http://127.0.0.1:11434/api/version', { body: '{}' })).rejects.toThrow('refuses');
      await expect(transport.fetch(`${AI_GOLDEN_BASE_URL}/responses`, { body: '{}' })).rejects.toThrow('refuses');
      expect(transport.bodies).toEqual([]);
      transport.script([]);
      await expect(transport.fetch(`${AI_GOLDEN_BASE_URL}/chat/completions`, { body: '{}' })).rejects.toThrow('undeclared');
    } finally {
      config.openaiBaseUrl = base;
    }
  });

  it('leaves out StuckService because it makes no model call', () => {
    // If a provider is ever injected here, the net must grow a stuck scenario.
    const params = (Reflect.getMetadata('design:paramtypes', StuckService) ?? []) as unknown[];
    expect(params).not.toContain(OpenAiProvider);
    expect(params).not.toContain(AssistantService);
  });

  it('records the fixture the CLI writes, at the path the CLI writes it to', () => {
    expect(aiRequestFixturePath()).toMatch(/apps\/api\/test\/fixtures\/tasktrackr-ai-request-digests\.json$/);
  });
});

/*
 * The authored executable cases only; the TaskTrackr fixture is never
 * rewritten. An uploaded application's
 * executable reviews go to the neutral arm, so none of its request bodies may
 * be a body TaskTrackr's net recorded, and recording them leaves the net's
 * 160 entries exactly as they were.
 */
describe('authored executable bodies beside the net', () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { DirectoryPackSource } = require('../content/pack-source') as typeof import('../content/pack-source');
  const { soleTaskFor } = require('../content/pack-compiler') as typeof import('../content/pack-compiler');
  const { SHELF_DIR } = require('../../test/fixtures/upload-packs/markers') as typeof import('../../test/fixtures/upload-packs/markers');
  const { digestOfBody } = require('../../test/ai-request-golden') as typeof import('../../test/ai-request-golden');
  /* eslint-enable @typescript-eslint/no-var-requires */

  it("records none of TaskTrackr's digests for the Shelf pack's four executable reviews, and the fixture keeps its 160 entries", async () => {
    const before = fs.readFileSync(aiRequestFixturePath(), 'utf-8');
    const recorded = readAiRequestFixture()!;
    const shelf = new ContentService().loadProject(new DirectoryPackSource(SHELF_DIR));
    const transport = new RecordingTransport();
    const held = { fetch: globalThis.fetch, key: config.openaiApiKey, base: config.openaiBaseUrl, model: config.openaiModel, effort: config.openaiReasoningEffort };
    const review = (request: { response_format?: { json_schema?: { schema?: Record<string, any> } } }) => {
      const variants = (request.response_format?.json_schema?.schema?.properties?.criteriaEvidence?.items?.anyOf ?? []) as Array<{ properties: { key: { enum: string[] } } }>;
      const keys = [...new Set(variants.map((variant) => variant.properties.key.enum[0]))];
      return JSON.stringify({ verdict: 'needs_revision', summary: 'N5.', strengths: [], improvements: ['N5.'], processNote: 'N5.', criteriaEvidence: keys.map((key) => ({ key, met: false, evidence: 'N5.', issue: 'N5.', nextStep: 'N5.' })) });
    };
    const bodies: string[] = [];
    globalThis.fetch = transport.fetch as unknown as typeof fetch;
    config.openaiApiKey = 'n5-golden-placeholder-not-a-key';
    config.openaiBaseUrl = AI_GOLDEN_BASE_URL;
    config.openaiModel = AI_GOLDEN_MODEL;
    config.openaiReasoningEffort = AI_GOLDEN_EFFORT;
    try {
      for (const phase of shelf.phases.filter((one) => ['code', 'tests', 'config'].includes(one.checks.kind))) {
        const task = soleTaskFor(phase);
        transport.script([review]);
        await new OpenAiProvider().review(phase, {
          workspace: Object.fromEntries(phase.files.filter((file) => file.editable).map((file) => [file.path, file.content])),
          criteria: task.rubric.criteria.map((one) => ({ key: one.key, title: one.title, weight: one.weight, score: 0, evidence: [] })),
          checks: [], overall: 0, hints: 0, ranBeforeSubmit: false, task, phaseTasks: [task],
        });
        bodies.push(...transport.bodies);
      }
    } finally {
      globalThis.fetch = held.fetch;
      config.openaiApiKey = held.key;
      config.openaiBaseUrl = held.base;
      config.openaiModel = held.model;
      config.openaiReasoningEffort = held.effort;
    }
    expect(bodies).toHaveLength(4);
    const known = new Set(recorded.entries.map((entry) => entry.sha256));
    expect(bodies.map(digestOfBody).filter((digest) => known.has(digest))).toEqual([]);
    for (const body of bodies) expect(body).toContain("strict evidence reviewer for one task of a teacher's project.");
    expect(recorded.entries).toHaveLength(160);
    expect(fs.readFileSync(aiRequestFixturePath(), 'utf-8')).toBe(before);
  });
});
