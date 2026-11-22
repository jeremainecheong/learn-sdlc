import type { Metadata } from 'next';

// The page preview in a tab of its own: outside the signed-in shell, never indexed.
// The title is written here, not imported: preview/copy.ts is a client module,
// and a server layout would get a client reference instead of the string. The
// test page-preview-tab pins it to PAGE_PREVIEW_TAB_TITLE.
export const metadata: Metadata = {
  title: 'Page preview',
  robots: { index: false, follow: false },
};

export default function PagePreviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
