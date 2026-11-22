// @vitest-environment jsdom
/**
 * The case file's Background, paragraph by paragraph.
 *
 * A phase's intro can run to several paragraphs (TaskTrackr's Design
 * Background is six), separated by blank lines. The mission tab draws each
 * paragraph as its own `<p>`, never the whole intro run together in one.
 * Drawn on the recorded phase details of `copy-provenance.json`, with the intro
 * replaced.
 */
import { repoFile } from './support/paths';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail } from '@learnsdlc/shared';

const shell = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('@/lib/useProject', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjectMaybe: () => shell.state,
  useProject: () => shell.state,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { Brief, introParagraphs } from '@/components/phases/Brief';

const b0 = JSON.parse(repoFile('apps/api/test/fixtures/contract-bodies/copy-provenance.json')).bodies as {
  defaultEnrollment: EnrollmentView;
  defaultPhases: Record<string, PhaseDetail>;
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  shell.state = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const drawn = (intro: string) => {
  const board = b0.defaultEnrollment;
  const phase = board.phases.find((one) => one.key === 'design')!;
  act(() => root.render(<Brief phase={phase} detail={{ ...b0.defaultPhases.design, intro }} onBegin={() => undefined} />));
  return Array.from(host.querySelectorAll('[data-testid="brief-intro"]')).map((p) => [p.tagName, p.textContent]);
};

describe("the case file's Background", () => {
  it('draws each blank-line paragraph as its own paragraph, in order', () => {
    expect(drawn('The app is two services.\n\nThe web service forwards /api.\n  \n\nThe architecture is settled.')).toEqual([
      ['P', 'The app is two services.'],
      ['P', 'The web service forwards /api.'],
      ['P', 'The architecture is settled.'],
    ]);
  });

  it('keeps a one-paragraph intro as one paragraph, its single line breaks inside it', () => {
    expect(drawn('One paragraph\nover two lines.')).toEqual([['P', 'One paragraph\nover two lines.']]);
    expect(introParagraphs('')).toEqual([]);
  });
});
