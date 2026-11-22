// @vitest-environment jsdom
/**
 * In Deployment's Pipeline view the faulted copy's line
 * ("selfcheck: web cannot reach api - API_URL names "localhost", which is not a
 * service in this compose file") ran off the panel's edge behind a sideways
 * scroll. The selfcheck's output now wraps, as the Incident drill page's
 * already did; nothing else on the panel changed.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrillState, PhaseDetail } from '@learnsdlc/shared';
import { rememberDrillAlert } from '@/components/workspace/panels/deployment/alert-text';
import deploymentPanel from '@/components/workspace/panels/deployment';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

let host: HTMLDivElement, root: Root;
beforeEach(() => { sessionStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); sessionStorage.clear(); });

const PAGED = '2026-11-17T03:12:04.506Z';
const LINE = 'selfcheck: web cannot reach api - API_URL names "localhost", which is not a service in this compose file';
const drill = (): DrillState => ({
  fault: 'api-url', pagedAt: PAGED, runbookBefore: null, pagedExit: 1, healthRanAt: null, healthExit: null,
  fixAppliedAt: null, resolvedAt: null, incident: null,
}) as DrillState;
const props = () => ({
  detail: { id: 'p-5', key: 'deployment', title: 'Deployment', artifactKind: 'config', projectSlug: 'tasktrackr', files: [], provenance: { application: 'TaskTrackr' }, lastSubmission: null } as unknown as PhaseDetail,
  files: {}, setFile: vi.fn(), activePath: '', submission: null, run: null, enrollment: null, theme: 'paper', links: [], setLinks: vi.fn(),
  runClock: null, setRunClock: vi.fn(), submissions: [], runs: [], drill: drill(),
  drillApi: { start: vi.fn(), health: vi.fn(), resolve: vi.fn() }, reloadPhase: vi.fn(),
  helpers: { runNow: vi.fn(), submitNow: vi.fn(), flushSave: vi.fn(async () => {}), openFile: vi.fn(), fileText: () => '', loadSubmission: vi.fn(), setPane: vi.fn(), setTab: vi.fn(), setNotice: vi.fn(), setError: vi.fn(), busy: false, saving: 'idle' },
}) as unknown as PhasePanelProps;

describe('the faulted copy\'s line wraps inside the panel', () => {
  it('draws the line whole, in a block that wraps its lines', async () => {
    rememberDrillAlert('p-5', PAGED, LINE);
    const Tools = deploymentPanel.Tools!;
    await act(async () => root.render(<Tools {...props()} />));
    const block = host.querySelector('[data-testid="phase-deployment-drill-before"] pre') as HTMLElement;
    expect(block.textContent).toBe(LINE);
    expect(block.className).toContain('whitespace-pre-wrap');
    expect(block.className).toContain('break-words');
    // still a box of its own: a very long output scrolls inside it, never past the panel
    expect(block.className).toContain('max-h-48');
    expect(block.className).toContain('overflow-auto');
  });
});
