import type { PhaseKey, PhaseProvenanceView, PreviewUnsupported } from '@learnsdlc/shared';
import { runsReferenceApplication } from '@/components/workspace/application';
import { hasPagePreview } from '@/components/workspace/preview/client/entry';

/**
 * Whether this phase offers App preview at all: the pack's `canPreview`, and
 * only while the phase runs the reference application. An uploaded
 * application's preview is unproven, so the control is hidden for it rather
 * than drawn and failing.
 */
export function previewOffered(
  phase: { canPreview?: boolean; provenance?: Pick<PhaseProvenanceView, 'application'> | null } | null | undefined,
): boolean {
  return Boolean(phase?.canPreview) && runsReferenceApplication(phase?.provenance);
}

/**
 * Where a phase's preview is drawn: the centre column's own section under the
 * editor, the centre column's third working view, or nowhere.
 *
 * `previewUnsupported` is deliberately not an input. A deployment that cannot
 * run an app at all is exactly where the surface has to exist, because the
 * panel's `unavailable` state is where the learner is told why.
 */
export type PreviewSurface = 'section' | 'view' | 'none';

/**
 * The implementation room reads code and its running app side by side, so its
 * preview is a pane of its own under the editor. Every other room whose pack
 * ships an app, testing and maintenance, in this pack, gets a third entry
 * beside the edit and evidence views.
 *
 * The API accepts a preview for all three, so each draws a way to start one.
 */
type PreviewRoom = {
  key: PhaseKey;
  canPreview?: boolean;
  provenance?: Pick<PhaseProvenanceView, 'application'> | null;
  previewUnsupported?: PreviewUnsupported;
  files?: readonly { path: string }[];
};

/**
 * Which preview this room draws.
 *
 * - `server`: the reference project's sandbox preview. It
 *   stays first wherever this deployment can run it, and it is also kept for a
 *   phase whose files are not known yet (no page to judge).
 * - `client`: the page preview, the learner's visible page code run in the
 *   browser with sample data. Every uploaded room with a page to draw gets it,
 *   and so does a reference room whose sandbox preview this deployment cannot
 *   run (`previewUnsupported` set), so a student always sees a page.
 * - `none`: no page code and no app (requirements, design, deploy-only rooms).
 */
export type PreviewMode = 'server' | 'client' | 'none';

export function previewMode(phase: PreviewRoom | null | undefined): PreviewMode {
  if (!phase) return 'none';
  const offered = previewOffered(phase);
  if (offered && !phase.previewUnsupported) return 'server';
  if (phase.files && hasPagePreview(phase.files.map((f) => f.path))) return 'client';
  return offered ? 'server' : 'none';
}

export function previewSurface(phase: PreviewRoom): PreviewSurface {
  if (previewMode(phase) === 'none') return 'none';
  return phase.key === 'implementation' ? 'section' : 'view';
}

/**
 * Whether the room keeps the App preview pane: the sandbox preview, or the
 * page preview drawn under the reference project's pane where the sandbox
 * cannot run. The workspace works this out in its own two lines (`appPreviewPane`
 * and `previewLabel`, which the preview driver reads by their text); this is
 * the same rule for the Maintenance document pages' working-area row, so the
 * row says one word on every page that draws it. The two are held together
 * by test/maintenance-frame.
 */
export function appPreviewPaneOf(phase: PreviewRoom | null | undefined): boolean {
  const kind = previewMode(phase);
  return kind === 'server' || (kind === 'client' && previewOffered(phase));
}

/** The name of a room's preview view in its working-area row. */
export function previewViewLabel(phase: PreviewRoom | null | undefined): 'App preview' | 'Page preview' {
  return appPreviewPaneOf(phase) ? 'App preview' : 'Page preview';
}
