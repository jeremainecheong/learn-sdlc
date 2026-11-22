'use client';

/**
 * The page preview in a tab of its own (`/page-preview#<id>`).
 *
 * It makes no API call and needs no session: it draws only the snapshot this
 * browser's workspace handed over (`handover.ts`), in the same sandboxed frame
 * and with the same running core as the workspace's panel. See the security
 * posture in `ClientPagePreview.tsx`. The tab does not follow the editor: it
 * says when its code was taken.
 */
import { useEffect, useState } from 'react';
import { PagePreviewTab } from '@/components/workspace/preview/client/PagePreviewTab';
import { takeHandover, type PageHandover } from '@/components/workspace/preview/client/handover';

/**
 * The id this tab first drew. "Skip to main content" rewrites the hash to
 * `#main`, so a refresh after it falls back to this id and shows the same
 * snapshot rather than nothing.
 */
const TAB_ID_KEY = 'learnsdlc.pagePreview.tab';

function readTabId(): string | null {
  try {
    return window.sessionStorage.getItem(TAB_ID_KEY);
  } catch {
    return null;
  }
}

function keepTabId(id: string): void {
  try {
    window.sessionStorage.setItem(TAB_ID_KEY, id);
  } catch {
    // not kept: a refresh after the hash changes says it has nothing to show
  }
}

function tabRecord(): PageHandover | null {
  const id = window.location.hash.replace(/^#/, '');
  const record = takeHandover(id);
  if (record) {
    keepTabId(id);
    return record;
  }
  const kept = readTabId();
  return kept && kept !== id ? takeHandover(kept) : null;
}

export default function PagePreviewPage() {
  const [record, setRecord] = useState<PageHandover | null | undefined>(undefined);
  useEffect(() => {
    setRecord(tabRecord());
  }, []);
  if (record === undefined) return null;
  return <PagePreviewTab record={record} />;
}
