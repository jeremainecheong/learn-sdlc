'use client';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import type { PhaseKey } from '@learnsdlc/shared';
import { LoadingState } from '@/components/experience/shared';
import { isPhaseKey } from '@/components/phases/experience';
import { LessonReader } from '@/components/learn/LessonReader';
import { DocPage } from '@/components/shell';
import Link from 'next/link';
import { lessonHiddenReason, lessonsVisibleFor, type LessonHiddenReason } from '@/lib/scenario';
import { useProjectMaybe } from '@/lib/useProject';
export default function LessonPage() {
 const { phaseKey } = useParams<{ phaseKey: string }>();
 if (!isPhaseKey(phaseKey)) return <DocPage title="That guide does not exist"><Link href="/learn">Return to Learn</Link></DocPage>;
 return <LessonGate phaseKey={phaseKey} />;
}
/**
 * Why the guide is not offered, said only as far as the payload knows it:
 * "your teacher wrote this phase" is true of an `own` phase and of nothing
 * else.
 */
const HIDDEN: Record<LessonHiddenReason, string> = {
 own: 'Your teacher wrote this phase for your class, so the guide written for the reference project would describe a different story. Your phase brief says what this phase asks of you.',
 mixed: 'Your teacher changed part of this phase for your class, so the guide written for the reference project would not match it. Your phase brief says what this phase asks of you.',
 unknown: 'The guide was written for the reference project, and this phase of your project may not match it. Your phase brief says what this phase asks of you.',
};
/**
 * A phase's lesson teaches the reference project's story, so direct entry
 * obeys the same predicate as every link to it. A learner whose phase is
 * their teacher's own scenario is told so and sent to their work; a signed-in
 * account with no enrolment has no project for the lesson to contradict, and
 * reads the lesson.
 */
function LessonGate({ phaseKey }: { phaseKey: PhaseKey }) {
 const state = useProjectMaybe();
 const enrollment = state?.enrollment ?? null;
 if (!enrollment && state?.loading) return <LoadingState />;
 const summary = enrollment?.phases.find(phase => phase.key === phaseKey) ?? null;
 // A held detail's provenance decides an application phase
 // whose roll-up is mixed, as it does for every other door.
 const held = summary ? state?.details?.[summary.id] : undefined;
 if (enrollment && !lessonsVisibleFor(summary, enrollment, held?.provenance)) return <DocPage title="This guide is not part of your project"><p data-testid="lesson-hidden">{HIDDEN[lessonHiddenReason(summary)]}</p><Link href="/dashboard">Return to your project</Link></DocPage>;
 return <Suspense fallback={<LoadingState />}><LessonReader key={phaseKey} phaseKey={phaseKey} /></Suspense>;
}
