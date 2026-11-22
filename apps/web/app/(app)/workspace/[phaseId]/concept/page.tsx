'use client';

/**
 * /workspace/[phaseId]/concept?kind=before|after, the quick check
 * on what a chapter teaches, taken before the phase and again after it.
 *
 * The room is `ConceptRoom`, on the quiz doors with the task key
 * `concept-before` or `concept-after`. Nothing here is graded or gates
 * anything; the way back to the phase is always on screen.
 */

import { useParams, useSearchParams } from 'next/navigation';
import { railOf } from '@/lib/rail';
import { useProject } from '@/lib/useProject';
import { DocPage } from '@/components/shell';
import { Button } from '@/components/ui';
import { ConceptRoom } from '@/components/workspace/concept/ConceptRoom';
import { conceptKindFrom, conceptTitle } from '@/lib/api-concept';
import { projectName } from '@/lib/project-name';

export default function ConceptCheckPage() {
  const { phaseId } = useParams<{ phaseId: string }>();
  const kind = conceptKindFrom(useSearchParams().get('kind'));
  const { details, enrollment, analytics, currentPhase } = useProject();
  const held = details[phaseId] ?? enrollment?.phases.find((item) => item.id === phaseId);
  const title = held?.title ?? 'Phase';
  const back = `/workspace/${encodeURIComponent(phaseId)}`;

  const nav = railOf(enrollment, analytics, currentPhase);
  const crumbs = [
    ...(enrollment
      ? [{ label: projectName(enrollment.projectTitle), href: '/dashboard', testId: 'back-dashboard' }]
      : []),
    { label: title, href: back },
    // The leaf is the check's own name, the one its title and the header's
    // quick check line already use for it, never the address's `kind`.
    { label: conceptTitle(kind) },
  ];

  return (
    <DocPage
      crumbs={crumbs}
      nav={nav}
      active="work"
      testId="concept-page"
      title={<span data-testid="concept-title">{conceptTitle(kind)}</span>}
      purpose={`${title}: a quick check on what this chapter teaches. Not graded.`}
      right={
        <Button href={back} variant="ghost" size="sm" icon="arrow-left" testId="concept-back">
          Back to the phase
        </Button>
      }
    >
      <ConceptRoom key={`${phaseId}:${kind}`} phaseId={phaseId} kind={kind} backHref={back} />
    </DocPage>
  );
}
