import 'reflect-metadata';
import * as fs from 'fs';
import { Logger } from '@nestjs/common';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import {
  aiRequestFixturePath,
  entryKey,
  firstDifferingEntry,
  readAiRequestFixture,
  recordAiRequests,
  type AiRequestEntry,
  type AiRequestManifest,
} from '../../test/ai-request-golden';

/*
 * The strict fixture: TaskTrackr's request bodies recorded with AI_AGENTIC_EDIT_LIST=strict and
 * AI_AGENTIC_PAYLOAD=full, beside the default fixture (edit list off, the code default) and the trim one. Without
 * it, a briefing change that only the edit-list contract sends (the record asked for whole, the compact record, code
 * through edits) would move no golden. It is regenerated only with a reason, as the others are
 * (`test/cli/ai-request-digests.ts --variant strict`).
 *
 * What it holds:
 * - the default's scenarios, every Agentic generation as `agentic.generate.edits` with the edit-list schema, answered
 *   in the edit-list shape (Design's record whole as compact JSON; Deployment's and Maintenance's record compact and
 *   unchanged beside one edit; one edit elsewhere), each expanding to the default's proposal byte for byte;
 * - so every other body, the six explanation bodies (which carry the proposal) and every classify and non-Agentic
 *   body, is the default fixture's digest: the end-to-end proof that a compact record stores the same bytes and that
 *   the strict answer's summary never reaches the explanation;
 * - one regeneration scenario appended last (Deployment propose): the first answer edits the runbook field by
 *   field, quoting text the record holds four times, the expander refuses it, and the same call is made once more
 *   with `regenerationSentence(…, 'edits')` in its briefing. The recording itself refuses unless the second body is
 *   the first with that sentence inserted once, three usage rows are written and one `agentic_regeneration
 *   site=propose code=files_proposal_refused clause=edit_list outcome=started` line is logged;
 * - one prompt assessment re-ask scenario appended after it (Design propose): the first classify
 *   answer breaks the one-question rule (two questions), the same classify request is sent once more with
 *   `classifyReaskNote('one_question')` as one trailing system message, and the usable second answer leads to the
 *   propose scenario's own generation. The recording refuses unless the second body is the first with that one
 *   message inserted once, three usage rows are written and one `agentic_regeneration site=classify
 *   code=intent_assessment clause=one_question outcome=ok` line is logged.
 *
 * Each generation body's length is pinned against a base recording made with this same harness, by its parts:
 * - every generation body: +68 (the summary sentence names every changed file by its path, in both modes);
 * - Design: +68 +341 (each document whole in files, the record compact, the contracts laid out) +69 = +478;
 * - Deployment: +68 +214 (the runbook one files entry, never edits) +456 (configuration through edits, the record
 *   compact) +69 = +807;
 * - Maintenance: +68 +229 (the change request one files entry) +462 (code through edits, the record compact) +69 =
 *   +828;
 * - every generation body a further +49 +39 (the summary sentence asks for present-tense statements that describe
 *   the proposal, what to read before explaining it, and a run step only where the phase has something to run);
 * - Requirements' two generation bodies a further +109 (the story record's notes hold open questions only).
 * The explanation, classify and every other body match the default fixture's digests.
 * Against the mode-off default the strict generation bodies are 1,636 to 2,750 bytes longer (the edit-list contract
 * and its response schema), pinned below so a strict-only change moves a reviewed pin.
 */

/** Strict generation-body length of the base recording, by scenario and phase, recorded with this harness. */
const BASE_STRICT_LENGTHS: Record<string, number> = {
  'agentic:propose-explain requirements': 9708, 'agentic:propose-explain design': 19964,
  'agentic:propose-explain implementation': 30259, 'agentic:propose-explain testing': 19727,
  'agentic:propose-explain deployment': 18326, 'agentic:propose-explain maintenance': 41420,
  'agentic:chat requirements': 10274, 'agentic:chat design': 28236, 'agentic:chat implementation': 50645,
  'agentic:chat testing': 26992, 'agentic:chat deployment': 25165, 'agentic:chat maintenance': 70143,
};
/** The growth over the base recording, by phase (the parts above). */
const SUMMARY_PRESENT_TENSE = 49 + 39;
const NOTES_OPEN_QUESTIONS = 109;
const GROWTH_SINCE_BASE: Record<string, number> = { requirements: 68 + SUMMARY_PRESENT_TENSE + NOTES_OPEN_QUESTIONS, design: 478 + SUMMARY_PRESENT_TENSE, implementation: 68 + SUMMARY_PRESENT_TENSE, testing: 68 + SUMMARY_PRESENT_TENSE, deployment: 807 + SUMMARY_PRESENT_TENSE, maintenance: 828 + SUMMARY_PRESENT_TENSE };
/** Strict over mode off, by scenario and phase: the edit-list contract and schema in place of the whole-file sentence. */
const OVER_MODE_OFF: Record<string, number> = {
  'agentic:propose-explain requirements': 1646, 'agentic:propose-explain design': 2162,
  'agentic:propose-explain implementation': 1796, 'agentic:propose-explain testing': 1708,
  'agentic:propose-explain deployment': 2515, 'agentic:propose-explain maintenance': 2750,
  'agentic:chat requirements': 1636, 'agentic:chat design': 2152, 'agentic:chat implementation': 1786,
  'agentic:chat testing': 1698, 'agentic:chat deployment': 2505, 'agentic:chat maintenance': 2740,
};

describe('the strict request-bytes net (AI_AGENTIC_EDIT_LIST=strict)', () => {
  const content = new ContentService();
  content.loadAll();
  const recorded = readAiRequestFixture()!;
  const strictFixture = readAiRequestFixture(undefined, 'strict');
  const held = { editList: config.agenticEditList, payload: config.agenticPayload };
  let fresh: AiRequestManifest;
  /** The default's scenarios' generations: the two appended scenarios (the regeneration, the prompt assessment re-ask) are pinned on their own below. */
  const generation = (entry: AiRequestEntry) => entry.surface === 'agentic.generate.edits' && entry.scenario !== 'agentic:regenerate' && entry.scenario !== 'agentic:classify-reask';

  beforeAll(async () => {
    Logger.overrideLogger(false);
    config.agenticEditList = 'strict';
    config.agenticPayload = 'full';
    try {
      fresh = await recordAiRequests(content);
    } finally {
      config.agenticEditList = held.editList;
      config.agenticPayload = held.payload;
    }
  });

  afterAll(() => {
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('writes the strict fixture beside the default and the trim ones', () => {
    expect(aiRequestFixturePath(undefined, 'strict')).toMatch(/tasktrackr-ai-request-digests-strict\.json$/);
    expect(fs.existsSync(aiRequestFixturePath(undefined, 'strict'))).toBe(true);
    expect(fs.readFileSync(aiRequestFixturePath(undefined, 'strict'), 'utf-8')).not.toMatch(/messages|golden-recorder-placeholder|Bearer|sk-/);
  });

  it('every strict request body matches the strict fixture', () => {
    expect(strictFixture).not.toBeNull();
    expect(firstDifferingEntry(strictFixture!.entries, fresh.entries)).toBeNull();
    expect(fresh.entries).toEqual(strictFixture!.entries);
  });

  it('records every Agentic generation as the edit list, and no whole-file generation (the fallback is untuned)', () => {
    expect(fresh.entries.filter((entry) => entry.surface === 'agentic.generate')).toEqual([]);
    expect(fresh.entries.filter(generation)).toHaveLength(12);
  });

  it('sends every other body byte for byte as the default fixture does, the explanation bodies among them', () => {
    expect(fresh.entries.slice(0, recorded.entries.length).map((entry) => entryKey({ ...entry, surface: entry.surface === 'agentic.generate.edits' ? 'agentic.generate' : entry.surface })))
      .toEqual(recorded.entries.map(entryKey));
    const others = fresh.entries.slice(0, recorded.entries.length).filter((entry) => !generation(entry));
    expect(others.filter((entry) => entry.surface === 'agentic.explanation')).toHaveLength(6);
    for (const entry of others) {
      const before = recorded.entries.find((row) => entryKey(row) === entryKey(entry))!;
      expect([entryKey(entry), entry.sha256]).toEqual([entryKey(entry), before.sha256]);
    }
  });

  it('grows each generation body by the stated bytes over the base strict body and over mode off', () => {
    for (const entry of fresh.entries.filter(generation)) {
      const at = `${entry.scenario} ${entry.phase}`;
      const off = recorded.entries.find((row) => row.scenario === entry.scenario && row.phase === entry.phase && row.surface === 'agentic.generate')!;
      expect([at, entry.length - BASE_STRICT_LENGTHS[at]]).toEqual([at, GROWTH_SINCE_BASE[entry.phase]]);
      expect([at, entry.length - off.length]).toEqual([at, OVER_MODE_OFF[at]]);
    }
  });

  it('records the one regeneration last: the same call twice, the second briefing longer by the refusal\'s sentence', () => {
    const regenerated = fresh.entries.slice(recorded.entries.length).filter((entry) => entry.scenario === 'agentic:regenerate');
    expect(regenerated.map(entryKey)).toEqual([
      'agentic:regenerate deployment #1 (agentic.classify)',
      'agentic:regenerate deployment #2 (agentic.generate.edits)',
      'agentic:regenerate deployment #3 (agentic.generate.edits)',
    ]);
    // The first answer's request is the propose scenario's own; the second adds only the sentence (checked inside the recording).
    const propose = fresh.entries.find((entry) => entry.scenario === 'agentic:propose-explain' && entry.phase === 'deployment' && entry.call === 2)!;
    expect(regenerated[1].sha256).toBe(propose.sha256);
    expect(regenerated[2].length).toBeGreaterThan(regenerated[1].length);
  });

  it('records the one prompt assessment re-ask after it: the classify call twice, then the same generation', () => {
    const appended = fresh.entries.slice(recorded.entries.length);
    expect(appended.map((entry) => entry.scenario)).toEqual(['agentic:regenerate', 'agentic:regenerate', 'agentic:regenerate', 'agentic:classify-reask', 'agentic:classify-reask', 'agentic:classify-reask']);
    const reasked = appended.slice(3);
    expect(reasked.map(entryKey)).toEqual([
      'agentic:classify-reask design #1 (agentic.classify)',
      'agentic:classify-reask design #2 (agentic.classify)',
      'agentic:classify-reask design #3 (agentic.generate.edits)',
    ]);
    // The first ask is the propose scenario's own classify body, and the generation after a usable second answer is
    // the propose scenario's own generation body: the re-ask moves neither. The second ask adds only the note
    // (checked byte for byte inside the recording).
    const propose = (call: number) => fresh.entries.find((entry) => entry.scenario === 'agentic:propose-explain' && entry.phase === 'design' && entry.call === call)!;
    expect(reasked[0].sha256).toBe(propose(1).sha256);
    expect(reasked[2].sha256).toBe(propose(2).sha256);
    expect(reasked[1].length).toBeGreaterThan(reasked[0].length);
  });

  it('leaves the shipped modes as they were after recording', () => {
    expect([config.agenticEditList, config.agenticPayload]).toEqual([held.editList, held.payload]);
  });
});
