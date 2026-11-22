import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExecutionRunView } from '@learnsdlc/shared';
import { RUNNER_UNAVAILABLE_MESSAGE } from '@learnsdlc/shared';
import { RunPanel, RunResultView } from '@/components/workspace/RunPanel';

/**
 * A run the sandbox never ran is not a verdict,
 * and which sentence it gets depends on why: the runner's own words for a
 * job this transport cannot run at all (a TypeScript step on Lambda), the
 * "try again" sentence only when the transport itself failed.
 */
describe('the tests pane on a run the sandbox never ran', () => {
  const SENTENCE =
    'this transport cannot run JavaScript: there is no node here. The front-end half of a phase needs RUNNER_MODE=local or socket. The API tests step was checked, but nothing is scored until every step can run, so the gate stays shut.';

  const failedWith = (stderr: string): ExecutionRunView => ({
    id: 'run-1',
    status: 'failed',
    kind: 'run',
    createdAt: '2026-09-06T12:38:00.000Z',
    result: { ok: false, exitKind: 'unavailable', stdout: '', stderr, durationMs: 0 },
  });

  const panel = (run: ExecutionRunView) =>
    renderToStaticMarkup(
      <RunPanel run={run} canRun runLabel="Run tests" busy={false} onRun={() => undefined} />,
    );

  it('shows the runner’s own sentence verbatim for a permanent limit, with no try again', () => {
    const out = panel(failedWith(SENTENCE));
    expect(out).toContain('data-testid="run-unavailable"');
    expect(out).toContain('this transport cannot run JavaScript');
    expect(out).toContain('the gate stays shut');
    expect(out).not.toContain('Try again');
    expect(out).not.toContain('The run failed to execute.');
    // Not a verdict: no pass or fail box and no count over it.
    expect(out).not.toContain('data-testid="run-summary"');
  });

  it('says try again only when the transport itself failed', () => {
    const out = panel(failedWith(''));
    expect(out).toContain('data-testid="run-unavailable"');
    expect(out).toContain(RUNNER_UNAVAILABLE_MESSAGE);
    expect(out).not.toContain('data-testid="run-summary"');
  });

  it('still says a run failed to execute when the row carries no result at all', () => {
    const out = panel({ ...failedWith(''), result: null });
    expect(out).toContain('The run failed to execute.');
    expect(out).not.toContain('data-testid="run-unavailable"');
  });

  it('never draws an unavailable result as a verdict, whatever row it came on', () => {
    const out = renderToStaticMarkup(
      <RunResultView result={{ ok: false, exitKind: 'unavailable', stdout: '', stderr: SENTENCE, durationMs: 0 }} />,
    );
    expect(out).toContain('data-testid="run-unavailable"');
    expect(out).not.toContain('Run failed');
    expect(out).not.toContain('data-testid="run-summary"');
  });

  it('does not claim an image build from a successful non-test selfcheck', () => {
    const out = renderToStaticMarkup(
      <RunResultView result={{ ok: true, exitKind: 'ok', stdout: 'selfcheck: configuration consistent', stderr: '', durationMs: 18 }} />,
    );
    expect(out).toContain('Run completed successfully');
    expect(out).toContain('selfcheck: configuration consistent');
    expect(out).not.toMatch(/build check|image built/i);
  });
  it('shows a pre-execution input failure without inventing runner evidence', () => {
    const out = panel({ ...failedWith(''), result: null, error: 'This older run did not retain its inputs. Press Run again.' });
    expect(out).toContain('This older run did not retain its inputs. Press Run again.');
    expect(out).toContain('role="alert"');
    expect(out).not.toContain('data-testid="run-summary"');
  });

  it('labels the recorded input fingerprint and clock separately from later editor changes', () => {
    const out = panel({ ...failedWith(''), inputHash: 'a'.repeat(64), runClock: '2026-03-01' });
    expect(out).toContain('data-testid="run-input-provenance"');
    // What was run and when, in words; the fingerprint is the line's title, never a word in it.
    expect(out).toContain(`title="Recorded inputs ${'a'.repeat(64)}"`);
    expect(out).toContain('Ran on your saved files at ');
    expect(out).toContain(', with the date set to 1 March 2026. Edits since then are not in this result.');
    expect(out).not.toMatch(/>[^<]*aaaaaaaaaaaa/);
    expect(out).not.toContain('2026-03-01');
    expect(out).not.toContain('sandbox clock');
  });

});
