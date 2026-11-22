// @vitest-environment jsdom
/**
 * The real reset control, the real reset client and the real `request`,
 * answered by what the API's routes answered in
 * `apps/api/test/reset-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-bodies/reset.json`). `fetch` is the only seam.
 *
 * `reset-control.test.tsx` proves the room's behaviour on hand-built
 * bodies; this file proves those bodies are the API's:
 *
 * 1. the control is offered on the recorded authored task and not on the
 *    recorded TaskTrackr phase (a sole task keyed '');
 * 2. the confirm is the recorded plan: the restored path, the plan's note, no
 *    proposal sentence;
 * 3. the reset quotes the recorded workspace version and hands the room the
 *    recorded result, whose version is the recorded phase-after's;
 * 4. a stale reset's recorded 409 is read as `workspace_changed`: the room is
 *    told "Nothing was reset…" and given the newer version and files (not
 *    the editor's "Keep mine" banner);
 * 5. the sole-task refusal the plan route answers is the POST's sentence;
 * 6. the teacher's trail row for the regraded pre-reset revision reads
 *    "of an earlier run, moved no gate"; the batch view carries no such field.
 */
import { repoPath } from './support/paths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventView, PhaseDetail, TaskResetPlanView, TaskResetResult } from '@learnsdlc/shared';

vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  getToken: () => 'wiring-token',
  getSession: () => ({ id: 'learner', role: 'LEARNER', displayName: 'Learner' }),
  useSession: () => ({ id: 'learner', role: 'LEARNER', displayName: 'Learner' }),
}));

import { RESET_DONE, RESET_KEEPS, RESET_STALE, TaskResetControl, resetOffered } from '@/components/workspace/TaskResetControl';
import { AuditList, describeAudit } from '@/components/staff/AuditList';
import { settle } from './support/dom';

/* ------------------------------ the recording ----------------------------- */

const RECORDING = repoPath('apps/api/test/fixtures/contract-bodies/reset.json');
const bodies = JSON.parse(readFileSync(RECORDING, 'utf-8')).bodies as {
  phaseBefore: PhaseDetail;
  plan: TaskResetPlanView;
  staleReset: { status: number; body: { error: string; message: string; version: string; files: Record<string, string> } };
  reset: { status: number; body: TaskResetResult };
  phaseAfter: PhaseDetail;
  regradeBatch: Record<string, unknown>;
  auditTrail: AuditEventView[];
  plainPhase: PhaseDetail;
  solePlan: TaskResetPlanView;
  soleRefused: { status: number; body: { message: string } };
};
const EARLIER_RUN = 'of an earlier run, moved no gate';
const before = bodies.phaseBefore;
const authored = before.tasks!.find((one) => one.key === bodies.reset.body.task.key)!;

/* -------------------------------- the server ------------------------------ */

const server = {
  post: 'reset' as 'reset' | 'stale' | 'sole',
  calls: [] as { method: string; path: string; body?: unknown }[],
};

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  // The recording's ids are placeholders (`<uuid:2>`), which a client
  // encodes as it would any path segment; decoded here to compare.
  const path = decodeURIComponent(url.replace(/^.*\/api\/v1/, ''));
  const method = (init?.method ?? 'GET').toUpperCase();
  server.calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
  if (method === 'GET' && /\/tasks\/[^/]+\/reset$/.test(path)) return answer(200, server.post === 'sole' ? bodies.solePlan : bodies.plan);
  if (method === 'POST' && /\/tasks\/[^/]+\/reset$/.test(path)) {
    if (server.post === 'stale') return answer(bodies.staleReset.status, bodies.staleReset.body);
    if (server.post === 'sole') return answer(bodies.soleRefused.status, bodies.soleRefused.body);
    return answer(bodies.reset.status, bodies.reset.body);
  }
  return answer(404, { message: `the wiring server has no ${method} ${path}` });
};

/* ------------------------------- the harness ------------------------------ */

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const press = async (id: string) => {
  const node = q(id) as HTMLButtonElement | null;
  expect(node, `no [data-testid="${id}"] to press`).not.toBeNull();
  await act(async () => {
    node!.click();
  });
  await settle();
};

const room = {
  prepared: 0,
  reset: [] as { result: TaskResetResult; plan: TaskResetPlanView }[],
  conflict: [] as { version?: string; files?: Record<string, string> }[],
};

const mount = async (detail: PhaseDetail, taskKey: string) => {
  await act(async () => {
    root.render(
      <TaskResetControl
        phaseId={detail.id}
        tasks={detail.tasks}
        task={detail.tasks!.find((one) => one.key === taskKey)}
        phaseStatus={detail.status}
        prepare={async () => {
          room.prepared += 1;
        }}
        baseVersion={() => detail.workspaceUpdatedAt ?? null}
        onReset={(result, plan) => {
          room.reset.push({ result, plan });
        }}
        onConflict={(body) => {
          room.conflict.push(body);
        }}
      />,
    );
  });
  await settle();
};

beforeEach(() => {
  server.post = 'reset';
  server.calls = [];
  room.prepared = 0;
  room.reset = [];
  room.conflict = [];
  vi.stubGlobal('fetch', vi.fn(serve));
  if (typeof HTMLDialogElement !== 'undefined') {
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('the reset seam, from the API recording (WIRE)', () => {
  it('offers the control on the recorded authored task and never on the recorded TaskTrackr phase', async () => {
    expect(resetOffered(before.tasks, authored, before.status)).toBe(true);
    const sole = bodies.plainPhase.tasks!;
    expect(sole.map((one) => one.key)).toEqual(['']);
    expect(resetOffered(sole, sole[0], bodies.plainPhase.status)).toBe(false);
    await mount(bodies.plainPhase, '');
    expect(q('task-reset-open')).toBeNull();
    await mount(before, authored.key);
    expect(q('task-reset-open')).not.toBeNull();
  });

  it('confirms with the recorded plan, quotes the recorded version and adopts the recorded result', async () => {
    await mount(before, authored.key);
    await press('task-reset-open');
    expect(server.calls[0]).toMatchObject({ method: 'GET', path: `/phases/${before.id}/tasks/${authored.key}/reset` });
    expect(q('task-reset-restores')?.textContent).toContain(bodies.plan.restores[0]);
    expect(q('task-reset-keeps')?.textContent).toBe(RESET_KEEPS);
    expect(q('task-reset-proposal')).toBeNull();
    expect(q('task-reset-refusal')).toBeNull();

    await press('task-reset-confirm');
    const post = server.calls.find((call) => call.method === 'POST')!;
    expect(post).toEqual({ method: 'POST', path: `/phases/${before.id}/tasks/${authored.key}/reset`, body: { baseVersion: before.workspaceUpdatedAt } });
    expect(room.prepared).toBe(1);
    expect(room.reset).toHaveLength(1);
    expect(room.reset[0].result.version).toBe(bodies.phaseAfter.workspaceUpdatedAt);
    expect(room.reset[0].result.version).not.toBe(before.workspaceUpdatedAt);
    expect(Object.keys(room.reset[0].result.workspace)).not.toContain(bodies.plan.restores[0]);
    expect(room.reset[0].result.task.key).toBe(authored.key);
    expect(q('task-reset-status')?.textContent).toBe(RESET_DONE);
    expect(room.conflict).toEqual([]);
  });

  it("reads the recorded stale 409 as workspace_changed: nothing reset, the newer copy handed to the room", async () => {
    expect(bodies.staleReset.status).toBe(409);
    expect(bodies.staleReset.body.error).toBe('workspace_changed');
    server.post = 'stale';
    await mount(before, authored.key);
    await press('task-reset-open');
    await press('task-reset-confirm');
    expect(room.reset).toEqual([]);
    expect(room.conflict).toEqual([{ version: bodies.staleReset.body.version, files: bodies.staleReset.body.files }]);
    expect(q('task-reset-status')?.textContent).toBe(RESET_STALE);
    expect(RESET_STALE.startsWith('Nothing was reset')).toBe(true);
    expect(q('task-reset-dialog')).toBeNull();
  });

  it('shows the recorded sole-task refusal, which is the sentence the POST refuses with', async () => {
    expect(bodies.solePlan.refusal).toBe(bodies.soleRefused.body.message);
    expect(bodies.soleRefused.status).toBe(400);
    // The plan route answers the refusal on any key; drawn here on the authored
    // room so the dialog path reads it (the room itself never offers it there).
    server.post = 'sole';
    await mount(before, authored.key);
    await press('task-reset-open');
    expect(q('task-reset-refusal')?.textContent).toBe(bodies.solePlan.refusal);
  });

  it("the teacher's recorded trail says the regraded revision was of an earlier run", async () => {
    const rows = bodies.auditTrail.filter((row) => row.event === 'phase.regrade');
    expect(rows.length).toBeGreaterThan(0);
    const described = describeAudit(rows[0]);
    expect(described.title).toContain(EARLIER_RUN);
    expect(described.state).toBe('now');
    await act(async () => {
      root.render(<AuditList events={bodies.auditTrail} />);
    });
    expect(host.querySelector('[data-testid="audit-list"]')?.textContent).toContain(EARLIER_RUN);
    // The recorded batch view carries no run note. Not pinned as a negative:
    // a later field that adds one should not turn this file red.
  });
});
