import type { ComponentType } from 'react';

/** One registered figure: the chapter it belongs to and the component drawn there. */
export interface FigureEntry {
  /** The chapter's number as the reader shows it: 1 to 4 ("Chapter 1 of 4"). */
  chapter: 1 | 2 | 3 | 4;
  /** Drawn with no props, in the chapter's flow, in registration order. */
  component: ComponentType;
}

/** A phase's figures by id. Ids are unique across all six phases (kebab case,
 * for example `mutation-table`); the reader draws each one inside an element
 * carrying `data-figure-id`. */
export type PhaseFigures = Readonly<Record<string, FigureEntry>>;
