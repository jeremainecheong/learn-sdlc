import { Mark } from '@/components/Mark';

/** Authentication and the initial project read use one stable opening surface. */
export function SessionEntry({ problem = '', onRetry, label = 'Checking your sign-in…', testId = 'session-gate' }: {
  problem?: string; onRetry?: () => void; label?: string; testId?: string;
}) {
  return <main id="main" tabIndex={-1} className="session-entry" data-testid={testId} aria-busy={!problem}>
    <section className="session-entry-card" aria-labelledby="session-entry-heading">
      <span className="session-entry-mark"><Mark size={40} /></span>
      <p className="session-entry-eyebrow">LearnSDLC</p>
      <h1 id="session-entry-heading">{problem ? 'Let’s reconnect your session.' : 'Opening your workspace.'}</h1>
      {problem ? <>
        <p role="alert" className="session-entry-error">{problem}</p>
        {onRetry && <button type="button" className="btn-secondary" onClick={onRetry} data-testid="session-retry">Try again</button>}
      </> : <p role="status">{label}</p>}
    </section>
  </main>;
}
