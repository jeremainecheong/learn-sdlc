import type { PhaseKey } from '@learnsdlc/shared';
import type { QuizRowInput } from '../authoring/quiz-rows';
import { derivePack, isFolderLayout } from './folder-layout';
import type { PackSource } from './pack-source';
import { plainPath } from './secret-paths';

/*
 * A folder-layout upload's quiz files: read and parsed by phase, and placed
 * among the phase's own tasks in the order a draft stores them.
 */

/** A quiz file that does not parse as JSON: its own sentence, never the parser's (which quotes the file). */
export class QuizFileRefusal extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'QuizFileRefusal';
  }
}

/**
 * Every quiz file of a folder-layout upload, by phase key, in the order the
 * folder lists them (`quizzes/<task key>.json`), each parsed: its
 * pack-relative path, its task key and its JSON. The layout's own rules
 * (`derivePack`) have refused every misplaced file and every key that is not
 * a task key, or the work task's. A pointer-layout pack holds none.
 */
export function phaseQuizzesOf(source: PackSource): Map<PhaseKey, { at: string; key: string; raw: unknown }[]> {
  const out = new Map<PhaseKey, { at: string; key: string; raw: unknown }[]>();
  if (!isFolderLayout(JSON.parse(source.read('project.json')) as Record<string, unknown>)) return out;
  for (const phase of derivePack(source, { origin: 'upload' }).phases) {
    if (phase.quizzes.length === 0) continue;
    out.set(phase.key, phase.quizzes.map((one) => {
      let raw: unknown;
      try {
        raw = JSON.parse(one.text);
      } catch {
        throw new QuizFileRefusal(`${plainPath(one.at)} is not valid JSON. Open it in an editor that checks JSON, fix it and upload again.`);
      }
      return { at: one.at, key: one.key, raw };
    }));
  }
  return out;
}

/**
 * A phase's tasks in the order the draft stores them: its own
 * task(s) at their compiled orders and each quiz at the order its file
 * names, sorted by order, ties broken by task key in code-unit order; the
 * caller numbers them 1 to n, so no two rows share an order.
 */
export function sequencedTasks(own: readonly QuizRowInput[], quizzes: readonly QuizRowInput[]): QuizRowInput[] {
  return [...own, ...quizzes].sort((a, b) => a.order - b.order || (a.taskKey < b.taskKey ? -1 : a.taskKey > b.taskKey ? 1 : 0));
}
