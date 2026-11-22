import 'reflect-metadata';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { Logger } from '@nestjs/common';
import { ContentService } from '../content/content.service';
import { AUTHORED_GUIDED_DRAFT_SELF_CHECK, GUIDED_DRAFT_SELF_CHECK } from './guided-draft';
import { GUIDED_REPAIR_CITED_LINE } from './openai.provider';
import {
  RecordingTransport,
  aiRequestFixturePath,
  digestOfBody,
  entryKey,
  readAiRequestFixture,
  recordAiRequests,
  serialiseAiRequestFixture,
  type AiRequestEntry,
  type AiRequestManifest,
} from '../../test/ai-request-golden';

/**
 * The request-bytes golden carries two declared insertions in the Guided
 * draft call, and this proves the current bodies differ from a base fixture
 * by exactly those two insertions and nothing else.
 *
 * The declared insertions, per moved surface:
 * - self-check (`guided.draft`, every scenario and phase): the system message
 *   gains `GUIDED_DRAFT_SELF_CHECK`, once, right after the hard rules.
 * - cited line (`guided.draft`, `guided:repair` call 3 only): the fenced
 *   rejected draft gains `GUIDED_REPAIR_CITED_LINE` and the one sentence the
 *   scripted review cited, after the draft and before the fence closes.
 * Every other surface (`guided.review`, `interview.answer`,
 * `interview.review`, `grading.review`, `agentic.classify`,
 * `agentic.generate`, `agentic.explanation`) is byte for byte the base
 * fixture's.
 *
 * The proof: take each freshly recorded body, remove exactly its declared
 * insertion, and rebuild the fixture from those bodies. It must be, byte for
 * byte, the base fixture (160 bodies, digest below).
 *
 * A change that legitimately moves request bodies (a pack version, a prompt
 * sentence, a request parameter) re-pins the digest below in the same change,
 * after the request digests' own diff shows that only the intended bodies
 * moved and by the intended text alone.
 */
const BASE_FIXTURE_SHA256 = '77990f4f4e16144481ea9effe100a8bbdea61cb39850739a5c339e031d70a41f';
const BASE_ENTRIES = 160;

interface Body {
  messages: Array<{ role: string; content: string }>;
  [key: string]: unknown;
}

/** One body with its declared insertion taken out, or the body itself where none was declared. */
function withoutDeclaredInsertion(entry: AiRequestEntry, raw: string): { body: string; removed: string[] } {
  if (entry.surface !== 'guided.draft') return { body: raw, removed: [] };
  const body = JSON.parse(raw) as Body;
  const removed: string[] = [];
  const system = body.messages[0];
  expect(system.role).toBe('system');
  // The self-check: exactly once, and only in the system message. A design phase is coached on the
  // authored arm, so its drafts carry the authored self-check in the reference one's place.
  const check = entry.phase === 'design' ? AUTHORED_GUIDED_DRAFT_SELF_CHECK : GUIDED_DRAFT_SELF_CHECK;
  expect([entryKey(entry), system.content.split(check).length]).toEqual([entryKey(entry), 2]);
  expect(body.messages.slice(1).some((message) => message.content.includes(check))).toBe(false);
  system.content = system.content.replace(check, '');
  removed.push('self-check');
  const last = body.messages[body.messages.length - 1];
  const cited = last.content.indexOf(`\n${GUIDED_REPAIR_CITED_LINE}\n`);
  if (entry.scenario === 'guided:repair' && entry.call === 3) {
    // The cited line: it sits inside the fence, between the draft and its close.
    expect(last.content.startsWith('<<<LEARNER_DATA unshown rejected draft\n')).toBe(true);
    expect(cited).toBeGreaterThan(0);
    const close = last.content.lastIndexOf('\nLEARNER_DATA>>>');
    expect(close).toBe(last.content.length - '\nLEARNER_DATA>>>'.length);
    const inserted = last.content.slice(cited, close);
    expect(inserted.split('\n').slice(2)).toHaveLength(1);
    expect(inserted.split('\n')[2].startsWith('- ')).toBe(true);
    last.content = last.content.slice(0, cited) + last.content.slice(close);
    removed.push('cited line');
  } else {
    expect([entryKey(entry), cited]).toEqual([entryKey(entry), -1]);
  }
  return { body: JSON.stringify(body), removed };
}

describe('the request-bytes golden against its base fixture', () => {
  const content = new ContentService();
  content.loadAll();
  let fresh: AiRequestManifest;
  let bodies: string[];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    // Read each scenario's bodies as the transport holds them, just before it
    // is re-armed for the next scenario. In memory only; nothing is written.
    const captured: string[][] = [];
    let live: RecordingTransport | null = null;
    const script = RecordingTransport.prototype.script;
    const spy = jest.spyOn(RecordingTransport.prototype, 'script').mockImplementation(function (this: RecordingTransport, replies) {
      if (live) captured.push([...live.bodies]);
      live = this;
      return script.call(this, replies);
    });
    try {
      fresh = await recordAiRequests(content);
      if (live) captured.push([...(live as RecordingTransport).bodies]);
    } finally {
      spy.mockRestore();
    }
    bodies = captured.flat();
  });

  afterAll(() => {
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('captured one body per recorded entry, and each is the body its digest names', () => {
    expect(bodies).toHaveLength(fresh.entries.length);
    fresh.entries.forEach((entry, at) => expect([entryKey(entry), digestOfBody(bodies[at])]).toEqual([entryKey(entry), entry.sha256]));
  });

  it('rebuilds, byte for byte, the base fixture once the declared insertions are removed', () => {
    const reasons: Record<string, number> = {};
    const before: AiRequestEntry[] = fresh.entries.map((entry, at) => {
      const { body, removed } = withoutDeclaredInsertion(entry, bodies[at]);
      for (const reason of removed) reasons[`${entry.surface} ${reason}`] = (reasons[`${entry.surface} ${reason}`] ?? 0) + 1;
      return { ...entry, sha256: digestOfBody(body), length: Buffer.byteLength(body, 'utf8') };
    });
    expect(before).toHaveLength(BASE_ENTRIES);
    const rebuilt = serialiseAiRequestFixture({ ...fresh, entries: before });
    expect(createHash('sha256').update(rebuilt, 'utf8').digest('hex')).toBe(BASE_FIXTURE_SHA256);
    const drafts = fresh.entries.filter((entry) => entry.surface === 'guided.draft').length;
    const repairs = fresh.entries.filter((entry) => entry.scenario === 'guided:repair' && entry.call === 3).length;
    expect(reasons).toEqual({ 'guided.draft self-check': drafts, 'guided.draft cited line': repairs });
  });

  it('is the regenerated fixture on disk: every guided.draft body moved, and nothing else', () => {
    const recorded = readAiRequestFixture()!;
    expect(recorded.entries).toEqual(fresh.entries);
    const committed = createHash('sha256').update(fs.readFileSync(aiRequestFixturePath(), 'utf-8'), 'utf8').digest('hex');
    expect(committed).not.toBe(BASE_FIXTURE_SHA256);
  });
});
