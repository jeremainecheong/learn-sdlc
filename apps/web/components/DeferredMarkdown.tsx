'use client';

import { lazy, Suspense } from 'react';

const ParsedMarkdown = lazy(() => import('./Markdown').then(({ Markdown }) => ({ default: Markdown })));

/** Keep a received reply readable while the separately loaded parser arrives. */
export function DeferredMarkdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<div data-markdown-pending className="prose-docs whitespace-pre-wrap">{children}</div>}>
      <ParsedMarkdown>{children}</ParsedMarkdown>
    </Suspense>
  );
}
