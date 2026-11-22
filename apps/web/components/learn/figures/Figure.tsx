'use client';
import { useId, type ReactNode } from 'react';
import { usePrefersReducedMotion } from './motion';
import { codeFragments } from './CodeText';
import './figures.css';

/** The words of the honesty tag a simulated figure wears by default. */
export const MODEL_TAG = 'Teaching model, not a run of your work';

export interface FigureProps {
  /** The registry id; drawn as `data-figure-id` so tests and readers can find it. */
  id?: string;
  /** The caption's heading: what the picture shows. */
  title: string;
  /** One line saying what to click or press. */
  howTo?: string;
  /** A visible description under the figure (the facts the picture states):
   * words, or words with their own `<code>`. */
  description?: ReactNode;
  /** Wear the honesty tag: `true` for the default words, or a string of your own. */
  model?: boolean | string;
  /** Fragments of the caption, how-to line and description to draw in code
   * type (an expression such as `due <= today`). A word holding `--`, `<=`
   * and the like is code type anyway (CodeText.tsx). */
  code?: readonly string[];
  /** Put the body in a focusable, labelled scroll region (wide SVGs and tables). */
  scroll?: boolean;
  className?: string;
  children: ReactNode;
}

/** The frame every study-guide figure sits in: caption, how-to line,
 * optional honesty tag, body, description. White ground, flat border. */
export function Figure({ id, title, howTo, description, model, code, scroll, className, children }: FigureProps) {
  const reduce = usePrefersReducedMotion();
  const tag = model === true ? MODEL_TAG : model || null;
  return (
    <figure className={`fig${className ? ` ${className}` : ''}`} data-figure-id={id} data-motion={reduce ? 'reduce' : 'full'}>
      <figcaption>
        <strong>{codeFragments(title, code)}</strong>
        {howTo && <span className="fig-howto">{codeFragments(howTo, code)}</span>}
        {tag && <span className="fig-model-tag">{codeFragments(tag, code)}</span>}
      </figcaption>
      {scroll ? (
        <div className="fig-scroll" role="region" aria-label={`${title}: scrollable figure`} tabIndex={0}>
          {children}
        </div>
      ) : (
        <div className="fig-body">{children}</div>
      )}
      {description && <p className="fig-description">{typeof description === 'string' ? codeFragments(description, code) : description}</p>}
    </figure>
  );
}

export interface FigureSvgProps {
  /** Read out as the picture's name. */
  title: string;
  /** Read out as the picture's description: say every fact the picture shows. */
  description: string;
  viewBox: string;
  /** The smallest width before the scroll region scrolls (px); keep it at
   * about 0.75 times the viewBox width so the text stays readable. A plan
   * 1000 units wide or more never goes below WIDE_PLAN_MIN_SCALE times its
   * width (below). */
  minWidth?: number;
  className?: string;
  children: ReactNode;
}

/** How many times its viewBox width an SVG may draw at most. Its text is
 * 13 units (figures.css), so it never draws above about 15.6 px, the size of
 * the chapter's body text. */
export const FIGURE_SVG_MAX_SCALE = 1.2;

/** The least a plan 1000 units wide or more draws at, as a share of its
 * width, when it passes a `minWidth`: 0.86, so its 13-unit text stays at
 * about 11 px while it scrolls in its box at a phone's width (at 0.72 to
 * 0.76 it would fall to 9.4 to 9.9 px). */
export const WIDE_PLAN_MIN_SCALE = 0.86;

/** The minimum width a FigureSvg draws at: the figure's own, raised for a
 * plan 1000 units wide or more. */
export function figureMinWidth(viewBoxWidth: number, minWidth?: number): number | undefined {
  if (minWidth === undefined) return undefined;
  return viewBoxWidth >= 1000 ? Math.max(minWidth, Math.round(viewBoxWidth * WIDE_PLAN_MIN_SCALE)) : minWidth;
}

/** An SVG named for assistive technology: `role="img"`, a `<title>` and a
 * `<desc>` with ids unique on the page, joined by `aria-labelledby`. It draws
 * at the figure's width, up to FIGURE_SVG_MAX_SCALE times its viewBox width,
 * centred. */
export function FigureSvg({ title, description, viewBox, minWidth, className, children }: FigureSvgProps) {
  const id = useId().replace(/:/g, '');
  const width = Number(viewBox.trim().split(/[\s,]+/)[2]);
  const maxWidth = Number.isFinite(width) && width > 0 ? Math.round(width * FIGURE_SVG_MAX_SCALE) : undefined;
  return (
    <svg
      className={`fig-svg${className ? ` ${className}` : ''}`}
      viewBox={viewBox}
      role="img"
      aria-labelledby={`${id}-title ${id}-desc`}
      style={{ minWidth: figureMinWidth(width, minWidth), maxWidth }}
    >
      <title id={`${id}-title`}>{title}</title>
      <desc id={`${id}-desc`}>{description}</desc>
      {children}
    </svg>
  );
}
