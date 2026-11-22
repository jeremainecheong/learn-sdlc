'use client';

/** The tab of its own: one header block (label, snapshot line, Reload) and the frame taking the rest. */
import { PAGE_PREVIEW_RELOAD, PAGE_PREVIEW_TAB_EMPTY, pagePreviewTabSnapshot } from '../copy';
import { PagePreviewBody, usePagePreviewRun, loadSucrase } from './ClientPagePreview';
import { fetchPreviewRuntime, pagePreviewLabel, type PageTransform } from './bundle';
import type { PageHandover } from './handover';

const NO_FILES: Record<string, string> = {};

export function PagePreviewTab({
  record,
  loadTransform = loadSucrase,
  loadRuntime = fetchPreviewRuntime,
}: {
  record: PageHandover | null;
  loadTransform?: () => Promise<PageTransform>;
  loadRuntime?: () => Promise<string>;
}) {
  const run = usePagePreviewRun(record?.files ?? NO_FILES, { loadTransform, loadRuntime });
  return (
    <main id="main" tabIndex={-1} className="flex h-screen min-h-0 flex-col bg-surface text-ink" data-testid="page-preview-tab">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b-1.5 border-edge px-3.5 py-2">
        <div className="m-0 min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink2">
          <p className="m-0" data-testid="page-preview-tab-label">
            {pagePreviewLabel(record?.files ?? NO_FILES)}
          </p>
          {record ? (
            <p className="m-0" data-testid="page-preview-tab-snapshot" data-taken-at={record.takenAt}>
              {pagePreviewTabSnapshot(record.takenAt)}
            </p>
          ) : null}
        </div>
        {record && run.hasPage && (
          <button type="button" className="btn-ghost btn-sm shrink-0" onClick={run.restart} data-testid="page-preview-reload">
            {PAGE_PREVIEW_RELOAD}
          </button>
        )}
      </div>
      {record ? (
        <PagePreviewBody run={run} />
      ) : (
        <p className="purpose px-3.5 py-3" data-testid="page-preview-tab-empty">
          {PAGE_PREVIEW_TAB_EMPTY}
        </p>
      )}
    </main>
  );
}
