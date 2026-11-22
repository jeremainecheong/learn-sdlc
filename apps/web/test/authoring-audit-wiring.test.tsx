// @vitest-environment jsdom
/**
 * The teacher's record of changes as the API wrote it, drawn by the real
 * `AuditList`.
 *
 * The two recorders that act as a teacher end on `GET /instructor/audit` (the
 * teacher's whole trail) and keep what it answered:
 *
 * - `apps/api/test/copy-provenance-contract-wiring.e2e-spec.ts` (`copy-provenance.json`):
 *   a copy made, a phase intro written (`project.phase`), published, assigned;
 * - `apps/api/test/quiz-reveal-contract-wiring.e2e-spec.ts` (`quiz-reveal.json`):
 *   quiz tasks added and saved (`project.tasks`), the key read
 *   (`project.quiz-key`), published, assigned, and a task signed off.
 *
 * Read here through the real `instructorApi.audit` and `request` (`fetch` the
 * only seam) and drawn: every row gets a sentence of its own, never the
 * fallback "A recorded change" nor its machine key.
 * `audit-labels.test.tsx` draws one hand-built row per authoring name; this
 * one draws the rows the routes actually wrote, with their real detail.
 *
 * What it does not cover: the authoring names no recorder performs
 * (`project.update`, `project.validate`, `project.archive`, `project.draft`,
 * `project.interview`, `project.files`, `project.interview-read`), and a
 * page: the only mounted `AuditList` is the teacher portal's per-learner
 * panel (`audit(learnerId)`), whose rows are about that learner, so a
 * teacher's authoring rows reach no page.
 */
import { repoPath } from './support/paths';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventView } from '@learnsdlc/shared';
import { AUTHORING_AUDIT_EVENTS } from '@learnsdlc/shared';

vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  getToken: () => 'wiring-token',
}));

import { AuditList, describeAudit } from '@/components/staff/AuditList';
import { instructorApi } from '@/lib/api-instructor';

const trailOf = (file: string) =>
  JSON.parse(readFileSync(repoPath(`apps/api/test/fixtures/contract-bodies/${file}`), 'utf-8')).bodies
    .teacherTrail as AuditEventView[];
const TRAILS = { 'copy-provenance.json': trailOf('copy-provenance.json'), 'quiz-reveal.json': trailOf('quiz-reveal.json') };
const AUTHORING = new Set<string>(AUTHORING_AUDIT_EVENTS);

let serving: AuditEventView[] = [];
const seen: string[] = [];

beforeEach(() => {
  seen.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      seen.push(url.replace(/^.*\/api\/v1/, ''));
      return new Response(JSON.stringify(serving), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const draw = (events: AuditEventView[]) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<AuditList events={events} title="Record of changes" />);
  return [...host.querySelectorAll('[data-testid="audit-list"] > li')].map((li) => li.textContent ?? '');
};

describe('the teacher’s record of changes, from the API recordings', () => {
  for (const [file, trail] of Object.entries(TRAILS)) {
    it(`draws every row of the ${file} trail as its own sentence`, async () => {
      serving = trail;
      const rows = await instructorApi.audit();
      expect(seen).toEqual(['/instructor/audit']);
      const texts = draw(rows);
      expect(texts).toHaveLength(trail.length);
      const unread = rows
        .map((one, n) => [one.event, texts[n]] as const)
        .filter(([event, text]) => text.includes('A recorded change') || text.includes(`Recorded as ${event}`))
        .map(([event]) => event);
      expect(unread).toEqual([]);
      for (const one of rows) expect([one.event, describeAudit(one).unnamed ?? false]).toEqual([one.event, false]);
      // The trail holds authoring rows, and each is one of the shared names.
      const authoring = rows.filter((one) => one.event.startsWith('project.'));
      expect(authoring.length).toBeGreaterThan(0);
      for (const one of authoring) expect([one.event, AUTHORING.has(one.event)]).toEqual([one.event, true]);
    });
  }

  it('covers the authoring names the recorders perform, and the sign-off row keeps its reason', () => {
    const names = new Set<string>([...TRAILS['copy-provenance.json'], ...TRAILS['quiz-reveal.json']].map((one) => one.event));
    for (const name of ['project.create', 'project.phase', 'project.tasks', 'project.quiz-key', 'project.publish', 'cohort.project']) {
      expect([name, names.has(name)]).toEqual([name, true]);
    }
    const signoff = TRAILS['quiz-reveal.json'].find((one) => one.event === 'task.signoff')!;
    const [text] = draw([signoff]);
    expect(text).toContain(signoff.reason!);
  });
});
