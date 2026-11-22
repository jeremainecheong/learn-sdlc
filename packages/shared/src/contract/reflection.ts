/**
 * The stored shapes of two phase state columns, `phase_states.estimate` and
 * `phase_states.retro`: a learner's estimate of the time a phase would take,
 * and a retrospective on it. Rows that hold them keep them, and the learner's
 * export carries them with the rest of the phase state. No route reads or
 * writes either one.
 */

/** The shape `phase_states.estimate` holds: the time a learner expected a phase to take. */
export interface PhaseEstimate {
  /** Hours, 0.25 to 40, in quarter-hour steps. */
  hours: number;
  confidence: 'low' | 'medium' | 'high';
  /** When it was written. */
  at: string;
}

/** The shape `phase_states.retro` holds: a learner's retrospective on a passed phase. Not the merge message. */
export interface PhaseRetro {
  wentWell: string;
  doDifferently: string;
  /** Optional; blank when they had nothing to add. */
  surprise: string;
  at: string;
}
