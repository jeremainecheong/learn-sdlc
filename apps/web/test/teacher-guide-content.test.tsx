// @vitest-environment jsdom
/**
 * The teacher guide: the refusal explainer, the guide page and its
 * generator, the no-interview hint, axe on the rail and the page, and the
 * product's voice over every copy string the guide draws.
 */
import { repoPath } from './support/paths';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAxe } from './support/axe-bridge';
import type { DraftPhaseView } from '@learnsdlc/shared';
import {
  GUIDE_STEPS,
  INLINE_HELP,
  INLINE_HELP_KEYS,
  NO_INTERVIEW_HINT,
  TEACHER_GUIDE_OWN_SECTIONS,
  UPLOAD_REFUSALS,
  UPLOAD_REFUSAL_CODES,
  UPLOAD_REFUSAL_FALLBACK,
  UPLOAD_REFUSAL_HELP,
  UPLOAD_WARNINGS_SENTENCE,
  STARTER_WARNING,
} from '@learnsdlc/shared';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/teacher/guide',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', role: 'INSTRUCTOR', displayName: 'A Teacher' }),
}));

import { RefusalExplainer, refusalCodeOfSentence } from '@/components/staff/guide/RefusalExplainer';
import { GuideRail } from '@/components/staff/guide/GuideRail';
import { InlineHelp, InterviewHint } from '@/components/staff/guide/InlineHelp';
import { TeacherGuide } from '@/components/staff/guide/TeacherGuide';
import { deriveGuideSteps } from '@/components/staff/guide/guide-steps';
import { TEACHER_GUIDE_SECTIONS } from '@/lib/teacher-guide-doc.generated';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (node: ReactNode) => act(() => root.render(node));
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

/** A sentence a no-code answer must never say: that the archive, zip or project is at fault. */
const BLAMES = /\b(archive|zip|project|file)\b[^.]*\b(is|was|has) (wrong|invalid|damaged|broken|bad|not)\b/i;

async function axeClean(extra: Record<string, { enabled: boolean }> = {}): Promise<string[]> {
  const axe = await loadAxe();
  const result = await axe.run(host, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, ...extra } });
  return result.violations.map((one) => `${one.id}: ${one.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

describe('every refusal code is explained', () => {
  it('UPLOAD_REFUSAL_HELP keys are exactly the 29 wire codes', () => {
    expect(UPLOAD_REFUSAL_CODES).toHaveLength(29);
    expect(Object.keys(UPLOAD_REFUSAL_HELP).sort()).toEqual([...UPLOAD_REFUSAL_CODES].sort());
  });

  it.each([...UPLOAD_REFUSAL_CODES])('%s renders a title, a fix and a guide link', (code) => {
    render(<RefusalExplainer code={code} />);
    const help = UPLOAD_REFUSAL_HELP[code];
    expect(help.title.length).toBeGreaterThan(0);
    expect(help.fix.length).toBeGreaterThan(0);
    expect(byId('upload-refusal-help-title')?.textContent).toBe(help.title);
    expect(byId('upload-refusal-help-fix')?.textContent).toBe(help.fix);
    expect(byId('upload-refusal-help-link')?.getAttribute('href')).toBe(`/teacher/guide#${help.guideAnchor}`);
    // The sentence the page already shows maps back to its code.
    expect(refusalCodeOfSentence(UPLOAD_REFUSALS[code])).toBe(code);
  });

  it('an answer with no code gets the fallback, which never blames the archive', () => {
    render(<RefusalExplainer code={null} />);
    expect(byId('upload-refusal-help-title')?.textContent).toBe(UPLOAD_REFUSAL_FALLBACK.title);
    expect(byId('upload-refusal-help-fix')?.textContent).toBe(UPLOAD_REFUSAL_FALLBACK.fix);
    expect(`${UPLOAD_REFUSAL_FALLBACK.title} ${UPLOAD_REFUSAL_FALLBACK.fix}`).not.toMatch(BLAMES);
    expect(refusalCodeOfSentence('Too many uploads in the last minute, so this one was not read and nothing was imported.')).toBeNull();
    expect(refusalCodeOfSentence('Your session ended. Sign in again.')).toBeNull();
  });
});

describe('the fallback agrees with every no-code sentence it is drawn under', () => {
  // UploadProject says "nothing was imported" for a 429 and a no-code 400 or 5xx,
  // and a 403 is a role, not a signed-out session: the fallback must hold for all.
  it('asks for the same upload again, and only offers the draft check for a run that ran out of time', () => {
    expect(UPLOAD_REFUSAL_FALLBACK.fix).toMatch(/^Wait a minute, then upload the archive again\./);
    expect(UPLOAD_REFUSAL_FALLBACK.fix).not.toMatch(/in case the upload finished/i);
    expect(UPLOAD_REFUSAL_FALLBACK.fix).not.toMatch(/^[^.]*sign in again/i);
    expect(UPLOAD_REFUSAL_FALLBACK.fix).toMatch(/if the upload ran out of time/i);
  });
});

describe('the guide page carries no release-engineering notes', () => {
  it('drops the release preamble, the held-back section and links to files the app has no route to', async () => {
    const doc = await import('@/lib/teacher-guide-doc.generated');
    const all = [doc.TEACHER_GUIDE_PREAMBLE, ...doc.TEACHER_GUIDE_SECTIONS.map((one) => one.markdown)].join('\n');
    expect(all).not.toMatch(/\bR-X\b|held back|Linux host|authoring-format\.md/);
    expect(doc.TEACHER_GUIDE_SECTIONS.map((one) => one.id)).not.toContain('parts-that-could-have-been-held-back');
    // The teacher-facing sections all stay.
    expect(doc.TEACHER_GUIDE_SECTIONS.map((one) => one.id)).toContain('7-upload-refusals');
  });
});

describe('the guide page renders the generated document, and the generator checks drift', () => {
  const SCRIPT = resolve(__dirname, '../scripts/gen-teacher-guide.mjs');
  const GENERATED = resolve(__dirname, '../lib/teacher-guide-doc.generated.ts');
  const DOC = repoPath('docs/teacher-project-upload.md');
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('renders every section of the document under its own id, and the refusal table', async () => {
    await render(<TeacherGuide />);
    expect(host.querySelector('h1')?.textContent).toBe('Teacher guide');
    expect(TEACHER_GUIDE_SECTIONS.length).toBeGreaterThan(5);
    for (const section of TEACHER_GUIDE_SECTIONS) {
      expect(host.querySelector(`section[id="${section.id}"]`), section.id).not.toBeNull();
    }
    expect(host.querySelectorAll(`#${TEACHER_GUIDE_OWN_SECTIONS.refusalHelp} tbody tr`)).toHaveLength(29);
  });

  it('every step and every refusal links to a section the page has', () => {
    const ids = new Set([...TEACHER_GUIDE_SECTIONS.map((one) => one.id), ...Object.values(TEACHER_GUIDE_OWN_SECTIONS)]);
    for (const step of GUIDE_STEPS) expect(ids.has(step.docsAnchor), step.key).toBe(true);
    for (const code of UPLOAD_REFUSAL_CODES) expect(ids.has(UPLOAD_REFUSAL_HELP[code].guideAnchor), code).toBe(true);
    expect(ids.has(UPLOAD_REFUSAL_FALLBACK.guideAnchor)).toBe(true);
  });

  it('--check is green against the generated module', () => {
    const said = run('--check', '--doc', DOC, '--out', GENERATED);
    expect([said.status, said.stderr]).toEqual([0, '']);
  });

  it('--check fails on drift, and the generated module holds no project slug', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-guide-'));
    const drifted = join(dir, 'doc.md');
    copyFileSync(DOC, drifted);
    writeFileSync(drifted, `${readFileSync(drifted, 'utf8')}\nOne more line.\n`);
    expect(run('--check', '--doc', drifted, '--out', GENERATED).status).toBe(1);
    const text = readFileSync(GENERATED, 'utf8');
    expect(text).not.toMatch(/(['"`])tasktrackr\1/);
    expect(text).not.toMatch(/project=tasktrackr/);
  });
});

describe('the no-interview hint, and the inline help', () => {
  const requirements = (interview: boolean) =>
    ({ key: 'requirements', title: 'Requirements', interview: interview ? { persona: { name: 'Sam', role: 'r' } } : undefined }) as unknown as DraftPhaseView;

  it('a Requirements phase with no interview says how to get one', () => {
    render(<InterviewHint phase={requirements(false)} />);
    expect(byId('guide-no-interview')?.textContent).toContain(NO_INTERVIEW_HINT);
    render(<InterviewHint phase={requirements(true)} />);
    expect(byId('guide-no-interview')).toBeNull();
    render(<InterviewHint phase={{ ...requirements(false), key: 'design' } as DraftPhaseView} />);
    expect(byId('guide-no-interview')).toBeNull();
  });

  it.each([...INLINE_HELP_KEYS])('%s carries one "What is this?" line', (key) => {
    render(<InlineHelp topic={key} />);
    expect(byId(`inline-help-${key}`)?.querySelector('summary')?.textContent).toContain('What is this?');
    expect(byId(`inline-help-${key}`)?.textContent).toContain(INLINE_HELP[key].line);
  });
});

describe('axe on the rail and the guide page', () => {
  it('the rail is clean', async () => {
    await render(<GuideRail steps={deriveGuideSteps({ view: null })} where="editor" />);
    expect(byId('guide-rail')).not.toBeNull();
    expect(await axeClean()).toEqual([]);
  });

  // The guide's tables have no empty header cell, so this arm runs
  // empty-table-header too.
  it('the guide page is clean, empty-table-header included', async () => {
    await render(<TeacherGuide />);
    expect(await axeClean()).toEqual([]);
  });

  // The first column of docs/teacher-project-upload.md section 4's table is
  // named ("| Letter | Check | Passes when |"), so the whole document is
  // checked here with every rule on: an empty header cell is red.
  it('no empty table header in the document', async () => {
    await render(<TeacherGuide />);
    expect(await axeClean()).toEqual([]);
  });
});

describe("the product's voice over every string this lane adds", () => {
  const strings = [
    ...Object.values(UPLOAD_REFUSAL_HELP).flatMap((one) => [one.title, one.fix]),
    UPLOAD_REFUSAL_FALLBACK.title,
    UPLOAD_REFUSAL_FALLBACK.fix,
    ...GUIDE_STEPS.flatMap((step) => [step.title, ...step.help]),
    ...Object.values(INLINE_HELP).map((one) => one.line),
    UPLOAD_WARNINGS_SENTENCE,
    NO_INTERVIEW_HINT,
    STARTER_WARNING,
  ];

  it.each(strings.map((one) => [one]))('%s', (text) => {
    expect(text).not.toMatch(/[·|]/);
    expect(text).toMatch(/^[A-Z0-9]/);
    expect(text).not.toMatch(/\b(course|module|CS\d{3,4}|TaskTrackr)\b/i);
  });

  it('copy-lint is clean over the staged component and page roots', () => {
    const lint = resolve(__dirname, '../scripts/copy-lint.mjs');
    const roots = [resolve(__dirname, '../components/staff/guide'), resolve(__dirname, '../app/(app)/teacher/guide')];
    const said = spawnSync(process.execPath, [lint, ...roots], { encoding: 'utf8' });
    expect([said.status, said.stderr]).toEqual([0, '']);
  });
});
