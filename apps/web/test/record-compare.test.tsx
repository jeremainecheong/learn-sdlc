// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, screen, within } from '@testing-library/dom';
import { afterEach, describe, expect, test } from 'vitest';
import { CHANGE_REQUEST_JSON, RUNBOOK_JSON } from '@learnsdlc/shared';
import { ProposalCompare } from '@/components/workspace/mentor/ProposalCompare';
import { changedLineCount } from '@/components/workspace/mentor/RecordCompare';
import { StructuredProposalSummary } from '@/components/workspace/mentor/StructuredProposalSummary';
import { recordFieldLabel, recordSlotIds } from '@/components/workspace/mentor/recordFieldLabel';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(node: ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(node)); }
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null; });

describe('the record subject of ProposalCompare', () => {
  const gate = { open: true, onClose: () => undefined, mentorName: 'Mentor', explanation: '', onExplanationChange: () => undefined, canExplain: true, onExplain: () => undefined, canApply: false, onApply: () => undefined, busy: false };
  const version = [{ path: 'change/release/version', before: '2.0.0', after: '2.1.0' }];
  // A run of changed lines counts the larger of what it removes and what it adds, so a line edited in place is one line.
  test('counts the lines a change touches once each: one replaced and one added is two, an edit in place is one', () => {
    expect(changedLineCount('services: {}\n', 'services:\n  api: {}\n')).toBe(2);
    expect(changedLineCount('a\nb\nc\n', 'a\nB\nc\n')).toBe(1);
    expect(changedLineCount('a\n', 'a\nb\nc\nd\ne\n')).toBe(4);
    expect(changedLineCount('a\nb\nc\n', 'a\n')).toBe(2);
    expect(changedLineCount(undefined, 'a\n')).toBe(1);
  });
  test('rails the record with its change count and each file with its changed lines, keeps the carried ids, and applies all documents', () => {
    render(<ProposalCompare {...gate} subject="record" label="Runbook" changes={[{ path: 'runbook/env-2/name', after: 'E2: PORT' }, { path: 'runbook/env-2/purpose', after: 'p' }]} carried={['environment entry E1', 'the incident']}
      files={[{ path: 'docker-compose.yml', before: 'services: {}\n', after: 'services:\n  api: {}\n' }]} />);
    expect(screen.getByTestId('record-compare-rail-record').getAttribute('aria-label')).toBe('Runbook, 2 changes');
    // The count on its own line (the comma is for a screen reader only); one total, in the card's noun, on Apply.
    expect(screen.getByRole('button', { name: 'docker-compose.yml, 2 lines' })).toBe(screen.getByTestId('record-compare-rail-docker-compose.yml'));
    expect(screen.getByTestId('record-compare-rail-docker-compose.yml').querySelector('.apv-rail-count')?.textContent).toBe('2 lines');
    expect(screen.getByRole('dialog').querySelector('header > span')?.textContent).toBe('Mentor\'s proposal for your runbook (2 files)');
    expect(screen.getByRole('button', { name: 'Apply all 2 files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next: docker-compose.yml' })).toBeTruthy();
    expect(screen.getByTestId('apv-carried').textContent).toBe('Kept as you saved them: environment entry E1 and the incident.');
  });
  test('one document: no rail, the singular kept line and "Apply to the change request"', () => {
    render(<ProposalCompare {...gate} subject="record" label="Change request" changes={version} carried={['test T1']} files={[]} />);
    expect(screen.queryByTestId('record-compare-rail-record')).toBeNull();
    expect(screen.getByTestId('apv-carried').textContent).toBe('Kept as you saved it: test T1.');
    expect(screen.getByRole('button', { name: 'Apply to the change request' })).toBeTruthy();
  });
  test('shows BEFORE and AFTER side by side, and one at a time under Flip', () => {
    render(<ProposalCompare {...gate} subject="record" label="Change request" changes={version} carried={[]} files={[]} />);
    expect(screen.getByTestId('record-compare-after-change/release/version').textContent).toBe('2.1.0');
    expect(screen.getByTestId('record-compare-before-change/release/version').textContent).toBe('2.0.0');
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Flip' })); });
    expect(screen.getByTestId('record-compare-before-change/release/version').textContent).toBe('2.0.0');
    expect(screen.queryByTestId('record-compare-after-change/release/version')).toBeNull();
  });
  test('names each changed field in words, by the saved item in its slot, never by its projection path', () => {
    const saved = JSON.stringify({ environment: [{ id: 'E1', name: 'API_URL', purpose: 'a', kind: 'config' }], health: [], rollback: [], data: [], incident: { rootCause: '', fix: '', actionItem: '' } });
    render(<ProposalCompare {...gate} subject="record" label="Runbook" saved={saved} carried={[]} files={[]}
      changes={[{ path: 'runbook/env-1/purpose', before: 'a', after: 'b' }, { path: 'runbook/env-2/name', after: 'E2: PORT' }, { path: 'runbook/notes', before: '', after: 'n' }]} />);
    const terms = [...document.querySelectorAll('.apv-fields dt')].map((dt) => dt.textContent);
    expect(terms.slice(0, 3)).toEqual(['Environment E1, what it controls', 'Environment E2, name', 'Notes']);
    expect(terms.some((term) => term!.includes('runbook/'))).toBe(false);
  });
});

describe('a record proposal that is no longer pending', () => {
  test('is summarised as your runbook by its fields in words, with the other files it wrote, never as the design record', () => {
    render(<StructuredProposalSummary files={{ [RUNBOOK_JSON]: '{}', 'docker-compose.yml': 'services: {}\n' }}
      changes={[{ path: 'runbook/env-2/name', after: 'E2: PORT' }, { path: 'runbook/env-2/purpose', after: 'p' }, { path: 'runbook/incident/root-cause', before: 'a', after: 'b' }]} />);
    const summary = within(screen.getByTestId('agentic-structured-summary'));
    expect(summary.queryByRole('region', { name: 'Design record' })).toBeNull();
    expect(summary.getByRole('region', { name: 'Your runbook' }).textContent).toBe('Your runbookAdded: Environment E2, nameAdded: Environment E2, what it controlsChanged: Incident, root cause');
    expect(summary.getByRole('region', { name: 'Files it also wrote' }).textContent).toBe('Files it also wrotedocker-compose.yml');
    expect(screen.getByTestId('agentic-structured-summary').textContent).not.toContain('runbook/');
  });
  test('is summarised as your change request', () => {
    render(<StructuredProposalSummary files={{ [CHANGE_REQUEST_JSON]: '{}' }} changes={[{ path: 'change/release/version', before: '2.0.0', after: '2.1.0' }]} />);
    expect(within(screen.getByTestId('agentic-structured-summary')).getByRole('region', { name: 'Your change request' }).textContent).toContain('Changed: Release, version');
  });
  test('names a slot by the saved item in it when its naming field did not change, else by its number', () => {
    const changes = [{ path: 'runbook/health-1/how', before: 'a', after: 'b' }];
    const saved = JSON.stringify({ environment: [], health: [{ id: 'H1', name: 'smoke', how: 'a', expected: 'ok' }], rollback: [], data: [], incident: { rootCause: '', fix: '', actionItem: '' } });
    expect(recordFieldLabel(changes[0].path, recordSlotIds(changes, saved))).toBe('Health check H1, command');
    expect(recordFieldLabel(changes[0].path, recordSlotIds(changes))).toBe('Health check 1, command');
    expect(recordFieldLabel('change/test-2/covers')).toBe('Test 2, covers');
    expect(recordFieldLabel('runbook/notes')).toBe('Notes');
  });
});
