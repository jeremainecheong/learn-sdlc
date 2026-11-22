'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import type { PhaseDetail, PhaseKey } from '@learnsdlc/shared';
import { Icon, type IconName } from '@/components/Icon';
import { opensChangeRoom } from '@/components/shell/routes';
import { previewSurface, previewViewLabel } from '@/components/workspace/preview/rooms';
import { AREA_ROW_STATUS, AreaRowCompact, useAreaRowFit } from './area-row-fit';

/**
 * The working-area row of the code phases, on the workspace and on the
 * phase's document pages (Implementation, Testing, Deployment and
 * Maintenance).
 *
 * The workspace draws its own views as buttons (they switch a view of that
 * page); a document page draws the same row, entry for entry, as links: a view
 * of the workspace by its address (`?panel=`, read once by the workspace and
 * then taken out of its address), and a page by its own path, the page the row
 * is on marked current. The words, the order, the icons, the classes and the
 * label are the workspace's, so going from one page of a phase to another
 * changes the centre of the page and not the row.
 */

/** The words of each phase's working-area row (the workspace reads them too). */
export const WORKING_AREA_LABELS: Record<PhaseKey, { edit: string; evidence: string; document: string }> = {
  requirements: { edit: 'Edit files', evidence: 'Validation evidence', document: 'Backlog' },
  design: { edit: 'Edit files', evidence: 'Validation evidence', document: 'Design workspace' },
  implementation: { edit: 'Code', evidence: 'Execution evidence', document: 'Pull request' },
  // The planted bugs are "Planted bugs" in the view and the tab alike;
  // "Kill matrix" is only the grid's own heading inside the view.
  testing: { edit: 'Write tests', evidence: 'Execution evidence', document: 'Planted bugs' },
  deployment: { edit: 'Configuration', evidence: 'Pipeline', document: 'Incident drill' },
  // "Edit files", the word the change page and the review page use for the same door.
  maintenance: { edit: 'Edit files', evidence: 'Execution evidence', document: 'Change request' },
};

/**
 * The review page's entry at the end of the row: "Pull request" in every code
 * phase. A second name such as "Reviews" would rename the page a viewer has
 * just met as Implementation's pull request, and would read like the band's
 * "View review", a different thing. The page's own title
 * stays "PR-<n>: …". Nothing on the phases with no row.
 */
const REVIEW_LABEL = {
  implementation: 'Pull request',
  testing: 'Pull request',
  deployment: 'Pull request',
  maintenance: 'Pull request',
} as const satisfies Partial<Record<PhaseKey, string>>;
export const AREA_REVIEW_LABEL: Partial<Record<PhaseKey, string>> = REVIEW_LABEL;

/** The workspace views that have an address (`?panel=`), read by the workspace when it opens. */
export const AREA_VIEW_PARAM = { code: 'code', split: 'split', evidence: 'evidence', preview: 'preview', files: 'files' } as const;
export type AreaView = keyof typeof AREA_VIEW_PARAM;

/** The document pages a row can be on. */
export type AreaPage = 'change' | 'pr' | 'matrix' | 'drill';

/** What the row needs of a phase: its address and what decides whether it has a preview view or a change room. */
export type AreaPhase = Pick<PhaseDetail, 'id' | 'key'> &
  Partial<Pick<PhaseDetail, 'canPreview' | 'provenance' | 'previewUnsupported' | 'files' | 'artifactKind' | 'change'>>;

/** One entry of the row: a view of the workspace, or a page of the phase. */
export interface AreaEntry {
  label: string;
  icon: IconName;
  href: string;
  /** The workspace view it opens (a button there, `data-view` here). */
  view?: AreaView;
  /** The document page it is. */
  page?: AreaPage;
}

/**
 * Whether a document page is drawn in the workspace's frame: the pages a
 * code phase's working-area row leads to. Maintenance's change request and
 * pull request where its door is the change room; Implementation's
 * pull request, Testing's planted bugs and pull request, Deployment's incident
 * drill and pull request. Every other page (the brief, the solution, the
 * Requirements and Design pages) keeps the frame it had.
 */
export function inWorkFrame(phase: AreaPhase, view: string): boolean {
  switch (phase.key) {
    case 'implementation': return view === 'pr';
    case 'testing': return view === 'matrix' || view === 'pr';
    case 'deployment': return view === 'drill' || view === 'pr';
    case 'maintenance': return (view === 'change' || view === 'pr') && opensChangeRoom(phase);
    default: return false;
  }
}

/** The label of a phase's working-area row, which the preview driver and the tours read. */
export const areaRowLabel = (key: PhaseKey) => (key === 'implementation' ? 'Implementation working area' : 'Phase working area');
/** Its classes: Implementation's row has its own; the other code phases share the runtime row's. */
export const areaRowClass = (key: PhaseKey) => (key === 'implementation' ? 'implementation-view-tabs' : 'implementation-view-tabs runtime-view-tabs');

/**
 * The row's entries for a phase, in the workspace's order. Every view's link
 * names the view it opens (`?panel=`), the edit view and Deployment's Pipeline
 * included: the workspace does not always open on
 * the view it opens on first, since it restores the view the learner last held
 * this session (its preview, say), so a bare address could open another view
 * than the entry's.
 */
export function areaEntries(phase: AreaPhase): AreaEntry[] {
  const base = `/workspace/${phase.id}`;
  const words = WORKING_AREA_LABELS[phase.key];
  const surface = previewSurface(phase);
  const at = (view: AreaView) => `${base}?panel=${AREA_VIEW_PARAM[view]}`;
  const preview: AreaEntry[] = surface === 'view' ? [{ label: previewViewLabel(phase), icon: 'run', href: at('preview'), view: 'preview' }] : [];
  switch (phase.key) {
    case 'implementation':
      return [
        { label: 'Code', icon: 'code', href: at('code'), view: 'code' },
        // The stacked icon the workspace's own Split button draws (code over the preview).
        { label: 'Split', icon: 'panel-bottom', href: at('split'), view: 'split' },
        ...(surface !== 'none' ? [{ label: previewViewLabel(phase), icon: 'run' as const, href: at('preview'), view: 'preview' as const }] : []),
        // No Files entry: the file tree is the left column's Files tab, as in the other code rooms.
        { label: REVIEW_LABEL.implementation, icon: 'pr', href: `${base}/pr`, page: 'pr' },
      ];
    case 'maintenance':
      return [
        ...(opensChangeRoom(phase) ? [{ label: words.document, icon: 'pr' as const, href: `${base}/change`, page: 'change' as const }] : []),
        { label: words.edit, icon: 'code', href: at('code'), view: 'code' },
        { label: words.evidence, icon: 'testing', href: at('evidence'), view: 'evidence' },
        ...preview,
        { label: REVIEW_LABEL.maintenance, icon: 'pr', href: `${base}/pr`, page: 'pr' },
      ];
    case 'testing':
      return [
        { label: words.edit, icon: 'code', href: at('code'), view: 'code' },
        { label: words.evidence, icon: 'testing', href: at('evidence'), view: 'evidence' },
        ...preview,
        { label: words.document, icon: 'doc', href: `${base}/matrix`, page: 'matrix' },
        { label: REVIEW_LABEL.testing, icon: 'pr', href: `${base}/pr`, page: 'pr' },
      ];
    case 'deployment':
      return [
        { label: words.edit, icon: 'code', href: at('code'), view: 'code' },
        { label: words.evidence, icon: 'deployment', href: at('evidence'), view: 'evidence' },
        ...preview,
        { label: words.document, icon: 'doc', href: `${base}/drill`, page: 'drill' },
        { label: REVIEW_LABEL.deployment, icon: 'pr', href: `${base}/pr`, page: 'pr' },
      ];
    default:
      return [];
  }
}

/**
 * The row on a document page: the workspace's row, entry for entry, as
 * links, with the page it is on marked current. `tools` is its right end: the
 * brief and mentor switches from 1024 px. Implementation's row also carries
 * the workspace's "Saved workspace" word before them.
 */
export function PhaseAreaNav({ phase, current, tools }: { phase: AreaPhase; current: AreaPage; tools?: ReactNode }) {
  const fit = useAreaRowFit();
  return (
    <nav ref={fit.ref} className={areaRowClass(phase.key)} aria-label={areaRowLabel(phase.key)} data-testid={`${phase.key}-area-nav`}>
      <AreaRowCompact.Provider value={fit.compact}>
        {areaEntries(phase).map((entry) => entry.view
          ? <Link key={entry.view} href={entry.href} data-view={entry.view}><Icon name={entry.icon} size={14} />{entry.label}</Link>
          : <Link key={entry.page} href={entry.href} aria-current={entry.page === current ? 'page' : undefined}><Icon name={entry.icon} size={14} />{entry.label}</Link>)}
        {phase.key === 'implementation' && <span className={AREA_ROW_STATUS}>Saved workspace</span>}
        {tools}
      </AreaRowCompact.Provider>
    </nav>
  );
}
