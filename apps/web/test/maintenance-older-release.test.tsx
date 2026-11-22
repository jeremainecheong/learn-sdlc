// @vitest-environment jsdom
/**
 * An older-format Maintenance (the code kind with no change request) has no
 * teacher's switch, and the change room draws no Contract tab for it. The
 * model the room reads says so, so the Release card never points at the tab.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PhaseDetail } from '@learnsdlc/shared';
import { useMaintenance, type MaintenanceModel } from '@/components/workspace/panels/maintenance/useMaintenance';

const CONTRACTS = JSON.stringify({ operations: [] });
const detail = (change?: unknown) => ({
  id: 'phase-m', key: 'maintenance', artifactKind: 'code', title: 'Maintenance', order: 6, place: 6, count: 6, projectSlug: 'tasktrackr',
  files: [{ path: 'design/contracts.json', content: CONTRACTS, editable: true }],
  tasks: [], lastSubmission: null, ...(change ? { change } : {}),
}) as unknown as PhaseDetail;

let host: HTMLDivElement, root: Root, model: MaintenanceModel | null = null;
function Probe({ d }: { d: PhaseDetail }) { model = useMaintenance({ detail: d, files: {}, submission: null, enrollment: null }); return null; }
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); model = null; });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the Release card of an older-format Maintenance', () => {
  it('never points at a Contract tab the room does not draw', () => {
    act(() => root.render(<Probe d={detail()} />));
    expect(model).not.toBeNull();
    expect(JSON.stringify(model!.release)).not.toContain('Contract tab');
  });
});
