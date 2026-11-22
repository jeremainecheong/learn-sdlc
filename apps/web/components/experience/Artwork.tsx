/** Decorative art never implies a grade or competes with the adjacent evidence.
 * Intrinsic dimensions reserve space before decoding, including on slow links. */
export function Artwork({ kind, className = '' }: {
  kind: 'journey' | 'evidence';
  className?: string;
}) {
  const journey = kind === 'journey';
  return <img
    className={`exp-sculpture ${className}`.trim()}
    src={`/artwork/${journey ? 'journey-map' : 'evidence-review'}-3d.webp`}
    width={journey ? 960 : 640}
    height={journey ? 720 : 640}
    alt=""
    aria-hidden="true"
    decoding="async"
    draggable={false}
  />;
}
