/**
 * The web's view of the API's contract fixtures (test/support/contract-fixtures.ts)
 * against the fixtures themselves.
 *
 * The wiring tests load the API's recorder, replay server, archives, sealed
 * files and shelf markers at run time, typed by `contract-fixture-types.ts`
 * instead of by the API's own declarations (which the web image's build
 * context does not hold). These checks keep that typing honest in the
 * monorepo: every recording on disk has the shape the web tests read, and
 * every loaded module has the exports, of the kinds, the web tests call.
 */
import { readdirSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { API_TEST_FIXTURES } from './support/api-fixtures';
import { loadSealedFiles, loadShelfMarkers, loadUploadArchives, readExchangeRecording, startReplay, withSyntheticDigests } from './support/contract-fixtures';

const RECORDINGS_DIR = resolve(API_TEST_FIXTURES, 'contract-exchanges');
const recordings = readdirSync(RECORDINGS_DIR).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));

describe("the web's typing of the API's Release X fixtures", () => {
  it('finds the recordings the wiring tests replay', () => {
    expect(recordings).toEqual(expect.arrayContaining(['upload', 'sealed']));
  });

  it.each(recordings)('recording %s has the ExchangeRecording shape', (name) => {
    const recording = readExchangeRecording(name);
    expect(typeof recording.recordedBy).toBe('string');
    expect(typeof recording.redaction).toBe('string');
    expect(recording.facts).toEqual(expect.any(Object));
    expect(Array.isArray(recording.exchanges)).toBe(true);
    for (const one of recording.exchanges) {
      expect(typeof one.name).toBe('string');
      expect(typeof one.method).toBe('string');
      expect(typeof one.path).toBe('string');
      expect(one.query).toEqual(expect.any(Object));
      expect('requestBody' in one).toBe(true);
      expect(typeof one.status).toBe('number');
      expect('body' in one).toBe(true);
      if (one.headers !== undefined) {
        for (const value of Object.values(one.headers)) expect(typeof value).toBe('string');
      }
    }
  });

  it('the replay server has the Replay shape', async () => {
    const replay = await startReplay([]);
    try {
      expect(typeof replay.url).toBe('string');
      expect(Array.isArray(replay.seen)).toBe(true);
      expect(Array.isArray(replay.misses)).toBe(true);
      expect(typeof replay.answer).toBe('function');
    } finally {
      await replay.close();
    }
    expect(withSyntheticDigests({ digest: '<sha256:1>' }).digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the archives, sealed files and shelf markers have the shapes the tests read', async () => {
    const archives = await loadUploadArchives();
    expect(Object.keys(archives).length).toBeGreaterThan(0);
    for (const build of Object.values(archives)) expect(typeof build).toBe('function');

    const { CONTRACT_SEALED_FILES, CONTRACT_SEALED_MARKER } = await loadSealedFiles();
    expect(typeof CONTRACT_SEALED_MARKER).toBe('string');
    expect(Object.keys(CONTRACT_SEALED_FILES).sort()).toEqual(['hidden-extra', 'hidden-extra-web']);
    for (const build of Object.values(CONTRACT_SEALED_FILES)) expect(Buffer.isBuffer(build())).toBe(true);

    const markers = await loadShelfMarkers();
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) expect(typeof marker).toBe('string');
  });
});
