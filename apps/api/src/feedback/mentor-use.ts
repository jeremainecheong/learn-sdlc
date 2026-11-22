/** What the learner did with the mentor's Agentic mode in one phase: the proposals it made, and how many were applied. */
export interface AgenticUse { proposals: number; applied: number }

/**
 * The process criterion's sentences about the mentor, in words.
 *
 * `hints` is the learner's Guided messages in the phase (`hintsForPhase`), the
 * count `scoreProcess`, the reliance index and the integrity flags read; it is
 * said as Guided hints, because that is all it counts. Agentic use is said
 * beside it, from the phase's proposals, so the process line never says no
 * help was used when the mentor proposed the change; no score, verdict or flag
 * reads the proposals. A proposal is applied only
 * once its explanation was accepted (`AgenticService.apply`), so "applied"
 * says so. `agentic` null means the proposals could not be read: nothing is
 * said about them rather than something false.
 *
 * "0 mentor hint(s)" is a form the product's voice does not have; the counts
 * are read by a learner and a teacher, not by a parser.
 */
export function mentorUseSentences(hints: number, agentic: AgenticUse | null): string[] {
  const guided = hints === 0 ? 'No Guided hints this phase.' : hints === 1 ? 'One Guided hint this phase.' : `${hints} Guided hints this phase.`;
  return agentic ? [guided, agenticUseSentence(agentic)] : [guided];
}

function agenticUseSentence({ proposals, applied }: AgenticUse): string {
  if (proposals === 0) return 'No Agentic proposals this phase.';
  const made = proposals === 1 ? 'One Agentic proposal this phase' : `${proposals} Agentic proposals this phase`;
  if (applied === 0) return `${made}, ${proposals === 1 ? 'not applied' : 'none applied'}.`;
  if (proposals === 1) return `${made}, applied after its explanation was accepted.`;
  if (applied === proposals) return `${made}, all applied after their explanations were accepted.`;
  return `${made}; ${applied === 1 ? 'one applied after its explanation was' : `${applied} applied after their explanations were`} accepted.`;
}
