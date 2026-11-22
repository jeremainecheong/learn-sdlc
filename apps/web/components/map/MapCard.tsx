'use client';

/**
 * The card the project map is set in, on Home and on the map page: a white
 * panel on the cool ground with the long card shadow, a header compartment
 * (one outline icon, the title, the line that says what the map is for, and
 * the card's actions) ruled off from the body, and under it the figures and
 * the drawing.
 *
 * The figures are what the drawing holds, counted from the same data the
 * drawing is made from, so the numbers and the picture cannot disagree.
 */
import { pluralWord, type EnrollmentView, type ProjectMapData } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import './ProjectMap.css';

export interface MapFigures {
  blocks: number;
  lines: number;
  open: number;
  phases: number;
  /**
   * What the drawing has folded, where it folded anything: Home's card groups
   * a function's tests into one block and a given story's criteria into
   * another, so its counts are of those groups and smaller than the full
   * map's. Absent on a map with no group of two or more.
   */
  folded?: 'tests' | 'criteria' | 'both';
}

/** Which kinds of block on this map stand in for two or more of the full map's. */
function foldedKinds(data: ProjectMapData): MapFigures['folded'] {
  const groups = data.nodes.filter((n) => (n.folded?.length ?? 0) > 1);
  const tests = groups.some((n) => n.kind === 'test');
  const criteria = groups.some((n) => n.kind === 'criterion');
  return tests && criteria ? 'both' : tests ? 'tests' : criteria ? 'criteria' : undefined;
}

/** The figures row's words for a folded map: what is grouped, and where each one is. */
export const FOLDED_LINE: Record<NonNullable<MapFigures['folded']>, string> = {
  both: 'Tests and given criteria grouped here; the full map shows every block',
  tests: 'Tests grouped by function here; the full map shows every block',
  criteria: 'Given criteria grouped by story here; the full map shows every block',
};

/**
 * Blocks the learner's work puts on the map, the lines between them, and the
 * phases open. A locked phase's placeholder is not a block of work, so a line
 * to or from one is not a line "between them" either: only a line with a block
 * of work at both ends is counted, so a fresh learner's map never reads "1
 * block of your work · 5 lines between them" with every line running to a
 * placeholder.
 */
export function mapFigures(data: ProjectMapData, enrollment: EnrollmentView | null | undefined): MapFigures {
  const phases = enrollment?.phases ?? [];
  const blocks = data.nodes.filter((n) => n.kind !== 'placeholder');
  const work = new Set(blocks.map((n) => n.id));
  const folded = foldedKinds(data);
  return {
    blocks: blocks.length,
    lines: data.edges.filter((e) => work.has(e.from) && work.has(e.to)).length,
    open: phases.filter((p) => p.status !== 'locked').length,
    phases: phases.length,
    ...(folded ? { folded } : {}),
  };
}

export function MapFiguresRow({ figures }: { figures: MapFigures }) {
  const { blocks, lines, open, phases, folded } = figures;
  return (
    <ul className="pm-figures" aria-label="What the map holds" data-testid="map-figures">
      {/* Nothing counted is said in words, not as a nought: "Nothing
          written yet", and no line figure for blocks that have none. */}
      {blocks === 0 ? (
        <li>Nothing written yet</li>
      ) : (
        <li>
          <strong>{blocks}</strong>{' '}
          {pluralWord(blocks, 'block of your work', 'blocks of your work')}
        </li>
      )}
      {lines > 0 && (
        <li>
          <strong>{lines}</strong>{' '}
          {pluralWord(lines, 'line between them', 'lines between them')}
        </li>
      )}
      <li>
        <strong>
          {open} of {phases}
        </strong>{' '}
        {pluralWord(phases, 'phase open', 'phases open')}
      </li>
      {/* A folded map's counts are of its groups, so the row says so: the
          full map, unfolded, counts more blocks of the same work. */}
      {folded && <li data-testid="map-figures-folded">{FOLDED_LINE[folded]}</li>}
    </ul>
  );
}

export function MapCard({
  title,
  titleId,
  purpose,
  actions,
  children,
  testId,
  className = '',
}: {
  /** The card's h2. Left out on the map page, whose h1 already names it. */
  title?: React.ReactNode;
  titleId?: string;
  purpose?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section
      className={`pm-card ${className}`}
      data-testid={testId}
      aria-labelledby={title && titleId ? titleId : undefined}
    >
      {(title || actions) && (
        <header className="pm-card-head">
          {title && (
            <span className="pm-card-icon" aria-hidden>
              <Icon name="map" size={18} strokeWidth={1.7} />
            </span>
          )}
          <div className="pm-card-titles">
            {title && (
              <h2 className="pm-card-title" id={titleId}>
                {title}
              </h2>
            )}
            {purpose && <p className="pm-card-purpose">{purpose}</p>}
          </div>
          {actions && <div className="pm-card-actions">{actions}</div>}
        </header>
      )}
      <div className="pm-card-body">{children}</div>
    </section>
  );
}
