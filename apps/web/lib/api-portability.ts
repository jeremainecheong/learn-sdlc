'use client';

/**
 * A class as one file, in both directions.
 *
 * The export cannot be an `<a href>` to the API: the bearer token has to travel
 * in a header, which is exactly why `exportCsv` next door is written this way
 * too. The import goes through `request` like everything else, because it is
 * ordinary JSON in and ordinary JSON out: it is only the size of it that is
 * unusual, and that is the API's ceiling to enforce.
 */
import type {
  CohortExportDocument,
  CohortExportInclude,
  CohortImportResult,
} from '@learnsdlc/shared';
import { COHORT_IMPORT_MAX_BYTES, COHORT_IMPORT_MAX_BYTES_HEADER } from '@learnsdlc/shared';
import { API_BASE, ApiError, getToken, request } from './api';
import { apiErrorMessage, authHeader, seg } from './api-fetch';

/** A file name a person can find again on a desktop; the API sends the same one. */
export function cohortExportFilename(name: string): string {
  const stem =
    String(name || 'class')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'class';
  return `${stem}.json`;
}

/** Bytes as a person would write them, for a sentence rather than a log line. */
export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

export interface CohortExportFile {
  blob: Blob;
  filename: string;
  className: string;
  /** What this deployment's import actually accepts, from the response header. */
  maxImportBytes: number;
}

export const portabilityApi = {
  /**
   * The whole class, as the file the other laptop will read. Not through
   * `request()`: that helper parses the body, and this one is a download whose
   * bytes have to reach a disk unchanged.
   */
  exportCohort: async (
    cohortId: string,
    className: string,
    includes: CohortExportInclude[],
  ): Promise<CohortExportFile> => {
    const token = getToken();
    const query = includes.length ? `?include=${includes.join(',')}` : '';
    const res = await fetch(`${API_BASE}/instructor/cohorts/${seg(cohortId)}/export.json${query}`, {
      headers: authHeader(token),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, apiErrorMessage(data, `the export failed (${res.status})`));
    }
    const header = Number(res.headers.get(COHORT_IMPORT_MAX_BYTES_HEADER));
    return {
      blob: await res.blob(),
      filename: cohortExportFilename(className),
      className,
      // The header is the truth; the shared default is what to say when a proxy
      // has eaten it.
      maxImportBytes: Number.isFinite(header) && header > 0 ? header : COHORT_IMPORT_MAX_BYTES,
    };
  },

  /**
   * What importing this file would do (`dryRun`), or importing it. A dry run
   * writes nothing at all, so it is cheap to ask twice; `force` is the answer
   * to "you have already imported this file", which is a real thing to want.
   */
  importCohort: (
    document: CohortExportDocument,
    options: { dryRun?: boolean; force?: boolean } = {},
  ): Promise<CohortImportResult> => {
    const params = new URLSearchParams();
    if (options.dryRun) params.set('dryRun', 'true');
    if (options.force) params.set('force', 'true');
    const query = params.toString();
    return request<CohortImportResult>(
      'POST',
      `/instructor/cohorts/import${query ? `?${query}` : ''}`,
      document,
    );
  },
};

/**
 * What a chosen file holds, or the sentence to show instead.
 *
 * Parsed in the browser on purpose: a file that is not JSON is refused before
 * a large body crosses the wire, and the sentence is the same one the API
 * would have given, so an instructor sees one answer rather than two.
 */
export async function readExportFile(
  file: File,
): Promise<{ document: CohortExportDocument } | { error: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return {
      error: 'That file is not a class export. A class export starts with "format": "learnsdlc.cohort".',
    };
  }
  const document = parsed as CohortExportDocument;
  if (!document || typeof document !== 'object' || document.format !== 'learnsdlc.cohort') {
    return {
      error: 'That file is not a class export. A class export starts with "format": "learnsdlc.cohort".',
    };
  }
  return { document };
}
