'use client';

/**
 * Where a block on the project map leads: the door of the phase it was drawn
 * from, the same door the phase's row on Home and the "Continue my project"
 * button open (`phaseDoorHref`), so a block never lands a learner somewhere
 * the rest of the product would not.
 *
 * A block names its phase by id (`phaseId`) and always by key (`phase`); a
 * locked phase's placeholder names the locked phase, whose door is the
 * progress page. A block whose phase the enrolment does not hold opens
 * nothing.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { EnrollmentView, PhaseDetail } from '@learnsdlc/shared';
import { doorWithTasks, phaseDoorHref } from '@/components/shell/routes';
import type { MapNode } from '@/lib/map';

export function mapNodeDoor(
  node: Pick<MapNode, 'phase' | 'phaseId'>,
  enrollment: EnrollmentView | null | undefined,
  details: Record<string, PhaseDetail> | undefined,
): string | null {
  const phases = enrollment?.phases ?? [];
  const phase =
    (node.phaseId ? phases.find((p) => p.id === node.phaseId) : undefined) ??
    phases.find((p) => p.key === node.phase);
  return phase ? phaseDoorHref(doorWithTasks(phase, details)) : null;
}

/**
 * The function a map's `onSelect` calls: open the block's phase door.
 *
 * The router is read unconditionally, as the Rules of Hooks ask; tests that
 * mount Home or the map page mock `next/navigation`.
 */
export function useOpenMapNode(
  enrollment: EnrollmentView | null | undefined,
  details: Record<string, PhaseDetail> | undefined,
): (node: MapNode) => void {
  const router = useRouter();
  return useCallback(
    (node: MapNode) => {
      const href = mapNodeDoor(node, enrollment, details);
      if (!href) return;
      router.push(href);
    },
    [router, enrollment, details],
  );
}
