import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExecutionRunView } from '@learnsdlc/shared';
import { Markdown } from '@/components/Markdown';
import { CaseRow, RunPanel, splitTrace } from '@/components/workspace/RunPanel';

/**
 * Two facts that are cheaper to pin here than in a browser.
 */

describe('markdown nests under the page it is drawn in (finding 36)', () => {
  const html = (md: string) => renderToStaticMarkup(<Markdown>{md}</Markdown>);

  it('never emits an h1, whoever wrote the text', () => {
    // The pack's brief and the learner's own artefact both open with a `#`,
    // so rendered as h1 they would give /dossier three h1 elements and
    // /warmup two, telling a screen reader there were three documents on one
    // page.
    const out = html('# TaskTrackr — Design\n\n## 1 · Task data model\n\n### Notes\n');
    expect(out).not.toContain('<h1');
    expect(out).toContain('<h2 data-md="1">');
    expect(out).toContain('<h3 data-md="2">');
    expect(out).toContain('<h4 data-md="3">');
  });

  it('carries the level the author wrote, so the size does not move', () => {
    // globals.css sizes `.prose-docs [data-md='1']` at the 19px an h1 in
    // `.prose-docs` would have, so this is the whole of the visual contract.
    expect(html('# One')).toContain('data-md="1"');
    expect(html('###### Six')).toContain('<h6 data-md="6">');
  });
});

describe('the tests pane answers the press, not the last run (finding 8)', () => {
  const finished: ExecutionRunView = {
    id: 'run-1',
    status: 'completed',
    kind: 'run',
    createdAt: '2026-09-06T12:38:00.000Z',
    result: {
      ok: false,
      exitKind: 'ok',
      stdout: '',
      stderr: '',
      durationMs: 1200,
      tests: {
        total: 6,
        passed: 0,
        failed: 6,
        errored: 0,
        cases: [{ name: 'test_overdue_excludes_today', status: 'failed', message: 'AssertionError' }],
      },
    },
  };

  const panel = (busy: boolean) =>
    renderToStaticMarkup(
      <RunPanel run={finished} canRun runLabel="Run tests" busy={busy} onRun={() => undefined} />,
    );

  it('clears the old verdict on the frame the run is asked for', () => {
    // With RUNNER_SLOTS=1 and other learners' runs in flight, pressing Run
    // must not leave "0/6 tests passed" and its four-minute-old stamp
    // standing as though it were the answer to the press.
    const out = panel(true);
    expect(out).toContain('data-testid="run-pending"');
    expect(out).toContain('Waiting for a sandbox.');
    expect(out).not.toContain('data-testid="run-summary"');
  });

  it('shows the verdict again once the run is not in flight', () => {
    const out = panel(false);
    expect(out).toContain('data-testid="run-summary"');
    expect(out).not.toContain('data-testid="run-pending"');
  });
});

describe('a failure is the learner’s own problem first (finding 19)', () => {
  // A real phase 3 first-run answer: nine frames under the
  // sandbox before the one line the learner wrote.
  const PYTEST = [
    'Traceback (most recent call last):',
    '  File "sandbox/python/werkzeug/test.py", line 1156, in open',
    '    response = self.run_wsgi_app(request.environ, buffered=buffered)',
    '  File "sandbox/python/flask/testing.py", line 240, in open',
    '    return super().open(*args, **kwargs)',
    '  File "sandbox/python/flask/app.py", line 1478, in wsgi_app',
    '    response = self.full_dispatch_request()',
    '  File "tests/test_tasks_api.py", line 17, in test_overdue_excludes_today',
    '    assert response.status_code == 200',
    'AssertionError: assert 500 == 200',
  ].join('\n');

  it('names the learner’s frame in the product’s reference style', () => {
    const trace = splitTrace(PYTEST);
    expect(trace).not.toBeNull();
    expect(trace!.headline).toBe('AssertionError: assert 500 == 200');
    expect(trace!.own).toEqual([
      'test_tasks_api.py, line 17, in test_overdue_excludes_today — assert response.status_code == 200',
    ]);
    // The sandbox's own layout never reaches the room's default view.
    expect(trace!.own.join('\n')).not.toContain('sandbox/python');
    expect(trace!.library).toHaveLength(6);
  });

  it('leaves a message that is not a traceback exactly as it is', () => {
    expect(splitTrace('AssertionError: 3 != 4')).toBeNull();
  });

  it('draws the learner’s frame and hides the framework behind a disclosure', () => {
    const out = renderToStaticMarkup(
      <table>
        <tbody>
          <CaseRow name="test_overdue_excludes_today" status="failed" message={PYTEST} />
        </tbody>
      </table>,
    );
    expect(out).toContain('data-testid="case-trace-own"');
    expect(out).toContain('test_tasks_api.py, line 17');
    expect(out).toContain('6 more lines, from the test framework');
    // The nine framework frames are inside the closed <details>, and the
    // summary the learner reads first is the assertion.
    expect(out.indexOf('AssertionError: assert 500 == 200')).toBeLessThan(
      out.indexOf('werkzeug'),
    );
  });
});
