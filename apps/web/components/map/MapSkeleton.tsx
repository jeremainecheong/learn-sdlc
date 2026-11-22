import './ProjectMap.css';

/**
 * What the map's well holds while the drawing is on its way: six lanes in the
 * map's own proportions, each a title bar over a few block shapes, so the
 * card keeps its size and the drawing replaces the outline in place rather
 * than pushing the page down when it lands. Never a spinner on its own.
 */
const LANES = [4, 3, 4, 4, 2, 1];

export function MapSkeleton({ label = 'Loading your project map', testId }: { label?: string; testId?: string }) {
  return (
    <div className="pm-root" data-testid={testId}>
      <div className="pm-well">
        <div className="pm-scroller" role="status" aria-busy="true" aria-label={label}>
          <div className="pm-skeleton">
            {LANES.map((blocks, i) => (
              <div key={i} className="pm-skeleton-col" aria-hidden>
                <span className="skeleton block" />
                {Array.from({ length: blocks }, (_, j) => (
                  <span key={j} className="skeleton block" />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
