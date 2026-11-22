import type { PhaseKey } from '@learnsdlc/shared';
import { PHASE_EXPERIENCE } from './experience';

export function PhaseArtwork({ phaseKey, className = '' }: { phaseKey: PhaseKey; className?: string }) {
  return <img className={`phase-artwork ${className}`} src={`/artwork/${PHASE_EXPERIENCE[phaseKey].art}`} alt="" width={180} height={140} loading="lazy" />;
}
export function MentorPortrait({ phaseKey, speaking = false }: { phaseKey: PhaseKey; speaking?: boolean }) {
  const mentor = PHASE_EXPERIENCE[phaseKey];
  return <span className="mentor-character" data-speaking={speaking} role="img" aria-label={`${mentor.name}, ${mentor.role}`} style={{ backgroundPosition: mentor.position }} />;
}
