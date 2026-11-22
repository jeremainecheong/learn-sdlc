/**
 * The shapes of the API's contract fixtures, as the web tests use
 * them. They mirror `apps/api/test/fixtures/contract-exchanges/recorder.ts` and
 * `replay.ts`, which cannot be imported here (see `api-fixtures.ts`). The
 * recordings themselves are still the API's: `contract-fixtures.test.ts`
 * checks every recording and the loaded modules against these shapes.
 */

export interface Exchange {
  /** A name the web test asks for this exchange by. Unique within a file. */
  name: string;
  method: string;
  /** The path under `/api/v1`, ids redacted, no query. */
  path: string;
  /** The query, redacted, as an object (empty when none). */
  query: Record<string, string>;
  /** What the web (or the spec standing in for it) sent; null for none. */
  requestBody: unknown;
  status: number;
  /** The JSON answer, or for a non-JSON answer `{ contentType, text }`. */
  body: unknown;
  /** Response headers the web reads (content type, disposition), redacted. */
  headers?: Record<string, string>;
}

export interface ExchangeRecording {
  recordedBy: string;
  redaction: string;
  /** Values that are not exchanges: an id the web is handed as a prop, a cap. */
  facts: Record<string, unknown>;
  exchanges: Exchange[];
}

/** One request the replay server received, body parsed. */
export interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | undefined;
}

export interface Replay {
  url: string;
  seen: Seen[];
  misses: string[];
  /** Replace the answers for one method and path, served afresh in order (a vacuity proof breaks a body). */
  answer(method: string, path: string, answers: Array<Pick<Exchange, 'status' | 'body' | 'headers'>>): void;
  close(): Promise<void>;
}

/** `contract-exchanges/recorder.ts`, the part the web reads. */
export interface RecorderModule {
  readExchangeRecording(name: string): ExchangeRecording;
}

/** `contract-exchanges/replay.ts`. */
export interface ReplayModule {
  startReplay(exchanges: readonly Exchange[]): Promise<Replay>;
  withSyntheticDigests<T>(value: T): T;
}

/** `contract-exchanges/archives.ts`. */
export interface ArchivesModule {
  CONTRACT_UPLOAD_ARCHIVES: Record<string, () => Buffer>;
}

/** `contract-exchanges/sealed-files.ts`. */
export interface SealedFilesModule {
  CONTRACT_SEALED_MARKER: string;
  CONTRACT_SEALED_FILES: { readonly 'hidden-extra': () => Buffer; readonly 'hidden-extra-web': () => Buffer };
}

/** `upload-packs/markers.ts`, the part the web reads. */
export interface MarkersModule {
  ALL_SHELF_MARKERS: readonly string[];
}
