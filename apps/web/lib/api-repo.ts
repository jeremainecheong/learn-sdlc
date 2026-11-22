'use client';

/**
 * The learner's own project as a git repository.
 *
 * The download cannot be an `<a href>` to the API: the bearer token has to
 * travel in a header, which is exactly why the class export next door is
 * written this way too. The summary is ordinary JSON and goes through
 * `request` like everything else.
 */
import type { RepoSummaryView } from '@learnsdlc/shared';
import { repoArchiveName } from '@learnsdlc/shared';
import { API_BASE, ApiError, getToken, request } from './api';
import { apiErrorMessage, authHeader, seg } from './api-fetch';

export interface RepoArchive {
  blob: Blob;
  filename: string;
}

export const repoApi = {
  /** The counts the card shows. Cheap enough to ask for again after a submit. */
  summary: (slug: string): Promise<RepoSummaryView> =>
    request<RepoSummaryView>('GET', `/repo/${seg(slug)}/summary`),

  /**
   * The archive itself. Not through `request()`: that helper parses the body,
   * and these bytes have to reach a disk unchanged.
   */
  download: async (slug: string): Promise<RepoArchive> => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/repo/${seg(slug)}/export.zip`, {
      headers: authHeader(token),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, apiErrorMessage(data, `the download failed (${res.status})`));
    }
    return { blob: await res.blob(), filename: repoArchiveName(slug) };
  },
};
