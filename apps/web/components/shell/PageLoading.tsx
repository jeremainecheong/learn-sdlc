import './page-loading.css';

/** The frame stays interactive while this one route-sized surface is pending. */
export function PageLoading({ label = 'Opening your page' }: { label?: string }) {
  return <main id="main" tabIndex={-1} className="route-loading" aria-busy="true" data-testid="route-loading">
    <p role="status" className="route-loading-label">{label}…</p>
    <div className="route-loading-heading" aria-hidden="true" />
    <div className="route-loading-grid" aria-hidden="true">
      <div className="route-loading-panel"><span /><span /><span /></div>
      <div className="route-loading-panel"><span /><span /><span /></div>
    </div>
  </main>;
}
