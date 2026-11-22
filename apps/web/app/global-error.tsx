'use client';

/**
 * The last resort: this replaces the root layout, so it renders its own <html>
 * and <body> and cannot rely on globals.css having been applied. Everything is
 * inline for that reason. The colours read the theme tokens when they exist
 * and fall back to the Paper values (as RGB triplets) when they do not.
 */
const c = (token: string, paper: string) => `rgb(var(--c-${token}, ${paper}))`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: c('ground', '243 244 246'),
          color: c('ink', '17 24 39'),
          fontFamily: 'Geist, system-ui, -apple-system, "Segoe UI", sans-serif',
          padding: '1.5rem',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '32rem',
            background: c('surface', '255 255 255'),
            border: `1.5px solid ${c('edge', '227 230 235')}`,
            borderRadius: 10,
            padding: '1.75rem',
            boxSizing: 'border-box',
          }}
        >
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', margin: 0, lineHeight: 1.15 }}>
            LearnSDLC could not start
          </h1>
          <p style={{ marginTop: '0.75rem', color: c('ink2', '63 70 83'), lineHeight: 1.6, fontSize: 15 }}>
            An unexpected error stopped the application from rendering. Reloading usually clears
            it.
          </p>
          {error.digest && (
            <p
              style={{
                marginTop: '0.75rem',
                color: c('muted', '95 102 116'),
                fontSize: 12.5,
                fontFamily: '"Geist Mono", ui-monospace, Menlo, monospace',
                overflowWrap: 'anywhere',
              }}
            >
              Reference {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              border: 0,
              borderRadius: 8,
              height: 36,
              background: c('accent', '29 78 216'),
              color: c('onaccent', '255 255 255'),
              padding: '0 16px',
              fontSize: 13.5,
              fontWeight: 600,
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
