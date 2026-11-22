/** The shape of one phase guide's chapters, practice and sources (one module
 * per phase beside this file). */
export interface LessonChapter { title: string; body: string; question: string; options: [string, string, string]; correct: number; feedback: string; optionFeedback: [string, string, string] }
export interface Lesson { title: string; subtitle: string; outcomes: string[]; flow: string[]; chapters: LessonChapter[]; sources: { title: string; url: string }[]; videos?: LessonVideo[] }
/** A video in the guide's "Watch the idea in practice" row. `chapter` (1 to 4) is the chapter it goes with; left out, it fits the whole guide. */
export interface LessonVideo { title: string; publisher: string; id: string; chapter?: number }
