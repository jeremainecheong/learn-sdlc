/** The landing pages' three-layer aurora; the CSS respects reduced motion. */
export function Aurora() {
  return (
    <div className="lh-aurora" aria-hidden="true">
      <div className="lh-aurora-band" />
      <div className="lh-aurora-band" />
      <div className="lh-aurora-band" />
    </div>
  );
}
