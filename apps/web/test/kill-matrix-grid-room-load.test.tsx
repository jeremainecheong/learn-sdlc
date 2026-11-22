import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MutantRow } from '@learnsdlc/shared';
import { matrixView, type TestFn } from '../components/workspace/panels/testing/lib';
import { MatrixGrid } from '../components/workspace/panels/testing/MatrixDoc';
import { RoomFallback } from '../components/workspace/panels/RoomFallback';

/*
 * The rooms.
 *
 * Two things this file holds:
 *
 * - **the kill matrix draws every cell**. A mutant runs against the suite it
 *   belongs to and no other, so a Python test never meets a front-end bug.
 *   Those cells must not be blank: a blank cell in a grid whose whole job is
 *   to be complete cannot be read as either killed or alive.
 * - **a room that could not load says so**. With the API unreachable, a room
 *   must not render one grey sentence (the browser's own "Failed to fetch")
 *   with no heading, no retry and no route back.
 */

const fn = (name: string, path: string): TestFn => ({ name, path, line: 1 });

const row = (
  mutant: string,
  cases: { name: string; status: 'passed' | 'failed' }[],
): MutantRow => ({
  mutant,
  description: mutant,
  killed: cases.some((c) => c.status !== 'passed'),
  cases,
});

// The third API test never fails on any planted bug: it is the criterion test
// the matrix must not label "Catches nothing" on a run that scored 100.
const API = ['catches a completion', 'catches the overdue rule', 'proves the boundary rule'];
const WEB = ['a late task wears the badge'];
const tests = [...API, ...WEB].map((n, i) =>
  fn(n, i < API.length ? 'tests/t.py' : 'web/src/a.test.tsx'),
);

const apiBug = (killed: string) =>
  row(`api_${killed}`, API.map((n) => ({ name: n, status: n === killed ? 'failed' : 'passed' })));
const webBug = (killed: string) =>
  row(`web_${killed}`, WEB.map((n) => ({ name: n, status: n === killed ? 'failed' : 'passed' })));

describe('the kill matrix grid', () => {
  const view = matrixView([apiBug(API[0]), apiBug(API[1]), webBug(WEB[0])], tests);

  it('draws a mark in every cell, including the ones the test never ran against', () => {
    // Three tests against three bugs is nine cells; four of them are the other
    // layer's, and they must still be drawn.
    const notRun = view.rows.flatMap((b) =>
      view.columns.filter((c) => !b.ran.includes(c.key)),
    ).length;
    expect(notRun).toBeGreaterThan(0);

    const html = renderToStaticMarkup(<MatrixGrid view={view} />);
    const drawn = html.split('matrix-cell-not-run').length - 1;
    expect(drawn).toBe(notRun);
  });

  it('never calls a test with no planted bug behind it a test that catches nothing', () => {
    const html = renderToStaticMarkup(<MatrixGrid view={view} />);
    expect(html).not.toContain('Catches nothing');
    // One phrase for it on the planted bugs page (the chip, the figure and the row's square).
    expect(html).toContain('No planted bug behind it');
    expect(html).not.toContain('No bug behind it<');
  });
});

describe('a workspace room that could not load', () => {
  it('says nothing but the room name while it is still loading', () => {
    const html = renderToStaticMarkup(<RoomFallback room="kill matrix" />);
    expect(html).toContain('Loading the kill matrix');
    expect(html).not.toContain('Try again');
  });

  it('gives the sentence, a retry and a route back when the load failed', () => {
    const html = renderToStaticMarkup(
      <RoomFallback
        room="issue"
        error="Can&#x27;t reach the server. Check your connection and try again."
        onRetry={() => undefined}
      />,
    );
    expect(html).toContain('reach the server');
    expect(html).toContain('room-retry');
    expect(html).toContain('room-back');
    expect(html).toContain('/dashboard');
    // Never the browser's own words.
    expect(html).not.toContain('Failed to fetch');
  });
});
