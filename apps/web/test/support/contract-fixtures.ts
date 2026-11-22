/**
 * The API's contract fixtures, for the web wiring tests: the same
 * modules `apps/api/test/fixtures/contract-exchanges/` and `upload-packs/markers.ts`
 * export, loaded at run time through `api-fixtures.ts` and typed by
 * `contract-fixture-types.ts`, so nothing here reaches outside the web image's
 * build context for the type checker.
 *
 * The recorder and the replay server load with this module (every wiring test
 * uses them); the archives, the sealed files and the shelf markers load only
 * in the test that asks, so a test that needs the recorder does not also
 * build the fixture packs' archives.
 */
import { loadApiFixture } from './api-fixtures';
import type {
  ArchivesModule,
  Exchange,
  MarkersModule,
  RecorderModule,
  Replay,
  ReplayModule,
  ExchangeRecording,
  SealedFilesModule,
} from './contract-fixture-types';

export type { Exchange, Replay, ExchangeRecording, Seen } from './contract-fixture-types';

const recorder = await loadApiFixture<RecorderModule>('contract-exchanges/recorder.ts');
const replay = await loadApiFixture<ReplayModule>('contract-exchanges/replay.ts');

export const readExchangeRecording = (name: string): ExchangeRecording => recorder.readExchangeRecording(name);
export const startReplay = (exchanges: readonly Exchange[]): Promise<Replay> => replay.startReplay(exchanges);
export const withSyntheticDigests = <T>(value: T): T => replay.withSyntheticDigests(value);

/** `contract-exchanges/archives.ts` (the fixture packs' upload archives, built in memory). */
export const loadUploadArchives = async () => (await loadApiFixture<ArchivesModule>('contract-exchanges/archives.ts')).CONTRACT_UPLOAD_ARCHIVES;

/** `contract-exchanges/sealed-files.ts`. */
export const loadSealedFiles = () => loadApiFixture<SealedFilesModule>('contract-exchanges/sealed-files.ts');

/** `upload-packs/markers.ts`'s `ALL_SHELF_MARKERS`. */
export const loadShelfMarkers = async () => (await loadApiFixture<MarkersModule>('upload-packs/markers.ts')).ALL_SHELF_MARKERS;
