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
  type AiRequestManifest,
} from '../../test/ai-request-golden';

/*
 * The trim fixture: TaskTrackr's request bodies recorded with
 * AI_AGENTIC_PAYLOAD=trim, beside the default fixture, which the golden net
 * keeps unchanged. The trim may move only `agentic.generate` bodies: every
 * other body, classify and the explanation gate among them, stays the
 * default fixture's byte for byte. Regenerated only with a reason, as the
 * default one is (`test/cli/ai-request-digests.ts --payload trim`).
 */
describe('the trim request-bytes net (AI_AGENTIC_PAYLOAD=trim)', () => {
  const content = new ContentService();
  content.loadAll();
  const recorded = readAiRequestFixture();
  const trimFixture = readAiRequestFixture(undefined, 'trim');
  const held = config.agenticPayload;
  let fresh: AiRequestManifest;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    config.agenticPayload = 'trim';
    try {
      fresh = await recordAiRequests(content);
    } finally {
      config.agenticPayload = held;
    }
  });

  afterAll(() => {
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('keeps the default fixture\'s path and writes the trim one beside it', () => {
    expect(aiRequestFixturePath()).toMatch(/tasktrackr-ai-request-digests\.json$/);
    expect(aiRequestFixturePath(undefined, 'trim')).toMatch(/tasktrackr-ai-request-digests-trim\.json$/);
    expect(fs.existsSync(aiRequestFixturePath(undefined, 'trim'))).toBe(true);
  });

  it('--payload trim changes only agentic.generate scenarios', () => {
    expect(recorded).not.toBeNull();
    expect(fresh.entries.map(entryKey)).toEqual(recorded!.entries.map(entryKey));
    const moved = fresh.entries.filter((entry, index) => entry.sha256 !== recorded!.entries[index].sha256);
    expect(moved.length).toBeGreaterThan(0);
    expect([...new Set(moved.map((entry) => entry.surface))]).toEqual(['agentic.generate']);
    // The chat bodies lose their duplicate workspace, so each one is shorter.
    for (const entry of moved) {
      const before = recorded!.entries.find((row) => entryKey(row) === entryKey(entry))!;
      expect([entryKey(entry), entry.length < before.length]).toEqual([entryKey(entry), true]);
    }
  });

  it('every trimmed request body matches the trim fixture', () => {
    expect(trimFixture).not.toBeNull();
    expect(firstDifferingEntry(trimFixture!.entries, fresh.entries)).toBeNull();
    expect(fresh.entries).toEqual(trimFixture!.entries);
  });

  it('leaves the shipped mode full after recording', () => {
    expect(config.agenticPayload).toBe('full');
  });
});
