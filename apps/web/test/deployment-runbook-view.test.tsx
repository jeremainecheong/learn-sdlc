// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, screen } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_RUNBOOK, RUNBOOK_JSON, RUNBOOK_OLDER_FORMAT_ROOM, serialiseRunbook, validateRunbookRecord } from '@learnsdlc/shared';
import deployment from '@/components/workspace/panels/deployment';
import type { PhasePanelProps } from '@/components/workspace/panels/types';
import { loadAxe } from './support/axe-bridge';

/*
 * The IDE's Deployment tools with the runbook record: a "Pipeline and drill"
 * view and a "Runbook" view of forms over `deployment/runbook.json`. A detail
 * without the record (an older pinned version) draws the pipeline and the
 * drill alone: the RUNBOOK.md ledger is gone with TaskTrackr 5.0.0.
 */
let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(node: ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(node)); }
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null; live.clear(); });

const floor = { minEnvironment: 1, minHealth: 1, minRollback: 0, minData: 0, requireIncident: false };
const saved = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'where /api goes', kind: 'config' }] });
const paged = { fault: 'compose-port', pagedAt: '2026-10-01T01:00:00.000Z', runbookBefore: null, pagedExit: 1, healthRanAt: null, healthExit: null, fixAppliedAt: null, resolvedAt: null, incident: null };
const live = new Map<string, string>();
const props = (over: { runbook?: boolean; initialView?: string; setFile?: (path: string, text: string) => void; drill?: unknown; agentBusy?: boolean } = {}) =>
  ({
    detail: {
      id: 'p-deployment', key: 'deployment', artifactKind: 'config', lastSubmission: null,
      files: over.runbook === false ? [] : [{ path: RUNBOOK_JSON, content: saved, editable: true, language: 'json' }],
      ...(over.runbook === false ? {} : { runbook: { floor, drill: true } }),
    },
    files: {},
    submission: null,
    drill: over.drill ?? null,
    initialView: over.initialView,
    // as the IDE does, a record's newest typed text is answered by fileText at once, held where no state moves
    setFile: (path: string, text: string) => { live.set(path, text); over.setFile?.(path, text); },
    drillApi: { start: vi.fn(), health: vi.fn(), resolve: vi.fn() },
    helpers: { fileText: (path: string) => live.get(path) ?? (path === RUNBOOK_JSON ? saved : ''), busy: false, agentBusy: over.agentBusy ?? false, openFile: vi.fn(), flushSave: vi.fn(), setTab: vi.fn(), setPane: vi.fn(), setNotice: vi.fn(), setError: vi.fn() },
  }) as unknown as PhasePanelProps;
const Tools = deployment.Tools!;

describe('the Deployment tools with the runbook record', () => {
  it('opens on the drill, switches to the Runbook view, and writes the record as the learner types', () => {
    const setFile = vi.fn();
    render(<Tools {...props({ setFile })} />);
    expect(screen.queryByTestId('runbook-tab')).toBeNull();
    act(() => { fireEvent.click(screen.getByTestId('phase-deployment-tab-runbook')); });
    expect(screen.getByTestId('runbook-tab')).toBeTruthy();
    act(() => { fireEvent.input(screen.getByTestId('runbook-environment-0-purpose'), { target: { value: 'where web sends /api' } }); });
    // the field holds what was typed though nothing but the held text moved
    expect((screen.getByTestId('runbook-environment-0-purpose') as HTMLTextAreaElement).value).toBe('where web sends /api');
    expect(setFile).toHaveBeenLastCalledWith(RUNBOOK_JSON, expect.any(String));
    expect(validateRunbookRecord(setFile.mock.calls.at(-1)![1]).runbook!.environment[0].purpose).toBe('where web sends /api');
    expect(screen.queryByTestId('phase-deployment-runbook-ledger')).toBeNull();
  });

  it('the Runbook view ends with "Check the runbook", which draws each rule; it is not on the Pipeline and drill view', () => {
    render(<Tools {...props()} />);
    expect(screen.queryByTestId('runbook-check')).toBeNull();
    act(() => { fireEvent.click(screen.getByTestId('phase-deployment-tab-runbook')); });
    const check = screen.getByTestId('runbook-check') as HTMLButtonElement;
    expect(check.textContent).toBe('Check the runbook');
    expect(check.disabled).toBe(false);
    expect(screen.getByTestId('runbook-tab').lastElementChild).toBe(check);
    expect(screen.queryByTestId('runbook-checks')).toBeNull();
    act(() => { fireEvent.click(check); });
    expect(screen.getByTestId('runbook-checks').querySelectorAll('[data-testid^="runbook-check-"]').length).toBeGreaterThan(0);
  });

  it('switches views through a real tab list that says which view is selected, axe clean on both views', async () => {
    render(<Tools {...props()} />);
    const list = screen.getByRole('tablist', { name: 'Deployment tools' });
    const drill = screen.getByTestId('phase-deployment-tab-drill');
    const runbook = screen.getByTestId('phase-deployment-tab-runbook');
    expect([drill.getAttribute('role'), runbook.getAttribute('role')]).toEqual(['tab', 'tab']);
    expect([drill.getAttribute('aria-selected'), runbook.getAttribute('aria-selected')]).toEqual(['true', 'false']);
    expect(list.contains(runbook)).toBe(true);
    // the keyboard model: an arrow moves to the next view
    act(() => { fireEvent.keyDown(drill, { key: 'ArrowRight' }); });
    expect(runbook.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').contains(screen.getByTestId('runbook-tab'))).toBe(true);
    const axe = await loadAxe();
    const violations = async () => (await axe.run(host!, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations
      .map((one) => `${one.id}: ${one.nodes.map((node) => node.target.join(' ')).join(', ')}`);
    expect(await violations()).toEqual([]);
    act(() => { fireEvent.click(drill); });
    expect(drill.getAttribute('aria-selected')).toBe('true');
    expect(await violations()).toEqual([]);
  });

  it('locks the forms while an Agentic operation owns the saved copy, as the code editor locks', () => {
    const setFile = vi.fn();
    render(<Tools {...props({ initialView: 'runbook', agentBusy: true, setFile })} />);
    expect((screen.getByTestId('runbook-environment-0-purpose') as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByTestId('runbook-environment-0-kind') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByTestId('runbook-add-environment')).toBeNull();
    act(() => { fireEvent.input(screen.getByTestId('runbook-environment-0-purpose'), { target: { value: 'typed while applying' } }); });
    expect(setFile).not.toHaveBeenCalled();
  });

  it('opens on the Runbook view when the page asks for it (?panel=runbook)', () => {
    render(<Tools {...props({ initialView: 'runbook' })} />);
    expect(screen.getByTestId('runbook-tab')).toBeTruthy();
  });

  it('opens the Runbook view on a later change to ?panel=runbook too, and does nothing for another value', () => {
    // the IDE keeps the Tools mounted while the query moves (web review Nit N3)
    render(<Tools {...props()} />);
    expect(screen.queryByTestId('runbook-tab')).toBeNull();
    act(() => root!.render(<Tools {...props({ initialView: 'pipeline' })} />));
    expect(screen.queryByTestId('runbook-tab')).toBeNull();
    act(() => root!.render(<Tools {...props({ initialView: 'runbook' })} />));
    expect(screen.getByTestId('runbook-tab')).toBeTruthy();
    // the learner switches back by hand; another value leaves their choice alone
    act(() => { fireEvent.click(screen.getByTestId('phase-deployment-tab-drill')); });
    expect(screen.queryByTestId('runbook-tab')).toBeNull();
    act(() => root!.render(<Tools {...props({ initialView: 'pipeline' })} />));
    expect(screen.queryByTestId('runbook-tab')).toBeNull();
  });

  it("switches to the Runbook view from the drill's Open the runbook, opening no file", () => {
    const p = props({ drill: paged });
    render(<Tools {...p} />);
    act(() => { fireEvent.click(screen.getByTestId('phase-deployment-open-runbook')); });
    expect(screen.getByTestId('runbook-tab')).toBeTruthy();
    expect(p.helpers.openFile).not.toHaveBeenCalled();
  });
});

describe('the Deployment tools without the record', () => {
  it('keeps the view switch for an older-format Deployment, whose Runbook view is its notice, and no runbook ledger', () => {
    render(<Tools {...props({ runbook: false })} />);
    expect(screen.getByText('Start the drill')).toBeTruthy();
    expect(screen.queryByTestId('phase-deployment-runbook-ledger')).toBeNull();
    act(() => { fireEvent.click(screen.getByTestId('phase-deployment-tab-runbook')); });
    expect(screen.getByTestId('runbook-older-format').textContent).toBe(RUNBOOK_OLDER_FORMAT_ROOM);
    expect(screen.queryByTestId('runbook-tab')).toBeNull();
  });

  it('keeps Resolve INCIDENT-1 off in an older-format Deployment, with the room\'s sentence beside it as its reason', () => {
    const p = props({ runbook: false, drill: { ...paged, healthRanAt: '2026-10-01T01:05:00.000Z', healthExit: 0, fixAppliedAt: '2026-10-01T01:05:00.000Z' } });
    render(<Tools {...p} />);
    const written = 'The compose file named localhost for the api service.';
    for (const id of ['phase-deployment-incident-root-cause', 'phase-deployment-incident-fix', 'phase-deployment-incident-action']) {
      act(() => { fireEvent.change(screen.getByTestId(id), { target: { value: written } }); });
    }
    const resolve = screen.getByTestId('phase-deployment-drill-resolve') as HTMLButtonElement;
    const reason = screen.getByTestId('phase-deployment-drill-resolve-older');
    expect(reason.textContent).toBe(RUNBOOK_OLDER_FORMAT_ROOM);
    expect(resolve.disabled).toBe(true);
    expect(resolve.getAttribute('aria-describedby')).toBe(reason.id);
    act(() => { fireEvent.click(resolve); });
    expect(p.drillApi.resolve).not.toHaveBeenCalled();
  });

  it('the same filled form with the record turns Resolve on and says nothing of an older format', () => {
    render(<Tools {...props({ drill: { ...paged, healthRanAt: '2026-10-01T01:05:00.000Z', healthExit: 0, fixAppliedAt: '2026-10-01T01:05:00.000Z' } })} />);
    const written = 'The compose file named localhost for the api service.';
    for (const id of ['phase-deployment-incident-root-cause', 'phase-deployment-incident-fix', 'phase-deployment-incident-action']) {
      act(() => { fireEvent.change(screen.getByTestId(id), { target: { value: written } }); });
    }
    expect((screen.getByTestId('phase-deployment-drill-resolve') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('phase-deployment-drill-resolve-older')).toBeNull();
  });
});
