import type { PhaseKey } from '@learnsdlc/shared';
import { figuresFor } from './registry';
import './figures.css';

/** Draws the figures registered on one chapter, in the chapter's flow. Each
 * sits in a `display: contents` element that carries its registry id, so the
 * wrapper changes no layout. `chapterIndex` is the reader's zero-based index. */
export function ChapterFigures({ phaseKey, chapterIndex }: { phaseKey: PhaseKey; chapterIndex: number }) {
  return (
    <>
      {figuresFor(phaseKey, chapterIndex + 1).map(({ id, Component }) => (
        <div key={id} className="lesson-figure" data-figure-id={id}>
          <Component />
        </div>
      ))}
    </>
  );
}
