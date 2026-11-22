/**
 * The counted noun the change cards share. The ticket itself is the teacher's
 * (`PhaseDetail.change`), and the change's name is read from the change
 * request (`changeSignature`).
 */

import { pluralWord } from '@learnsdlc/shared';

/** "1 case" / "4 cases", so a sentence never reads "1 cases". */
export function count(n: number, noun: string): string {
  return `${n} ${pluralWord(n, noun)}`;
}
