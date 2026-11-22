import type { LessonTermKey } from '../figures/lesson-terms';
/** The shape of one phase guide's study material (one module per phase
 * beside this file). */
export interface ChapterStudy {
  objective: string;
  explanation: string;
  title: string;
  steps: string[];
  example: string;
  why: string;
  practice: string;
  reasoning: string;
  takeaway: string;
  table?: { caption: string; headings: string[]; rows: string[][] };
  /** Where the learner uses this chapter in the product, the room and
   * the part of it in the room's own labels ("Testing room, Planted bugs
   * page"). The reader draws it as the chapter's one "Where you use this"
   * chip. Every chapter of the six guides fills it
   * (test/guide-where-chips.test.ts); the reader's fallback is for a guide
   * that does not. */
  where?: string;
  /** Optional: the guide term (`figures/lesson-terms.ts`) to define at
   * its first use in the chapter's idea. Left out, the first listed term that
   * appears is marked; `null` marks none (the only listed word in the idea is
   * used in another sense). test/lesson-reader.test.tsx pins all 24. */
  term?: LessonTermKey | null;
}
export interface PhaseStudy {
  preparation: string;
  recap: string[];
  transfer: string;
  chapters: [ChapterStudy, ChapterStudy, ChapterStudy, ChapterStudy];
}
