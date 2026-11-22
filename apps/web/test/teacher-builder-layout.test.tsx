// @vitest-environment jsdom
/**
 * The teacher's builder is laid out for editing.
 *
 * - One save status for the whole editor, fed by every card's own save.
 * - A section navigation (Overview, each phase, Validate, Publish).
 * - The process checklist folds to its one line once editing has begun.
 * - The runbook's entries are named, folding cards whose Add and Remove say
 *   which entry they act on, with concrete Data labels and examples.
 * - A failed validation row links to its phase and task.
 */
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { EMPTY_RUNBOOK, evaluateRunbookFloor, serialiseRunbook, type ValidationReport } from '@learnsdlc/shared';
import { EditorSaveProvider, summariseSaves, useEditorSaveSummary } from '@/components/staff/projects/save-status';
import { useCardSave } from '@/components/staff/projects/requirements/BuilderCard';
import { EditorNav } from '@/components/staff/projects/EditorNav';
import { GuideRail } from '@/components/staff/guide/GuideRail';
import { deriveGuideSteps } from '@/components/staff/guide/guide-steps';
import { RunbookRecordEditor, runbookItemName } from '@/components/staff/projects/deployment/RunbookRecordEditor';
import { ValidationReportPanel } from '@/components/staff/projects/ValidationReportPanel';

vi.mock('next/link', () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));

let host: HTMLDivElement;
let root: Root;
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const buttons = () => [...host.querySelectorAll('button')].map((one) => one.textContent?.trim());
const render = async (node: React.ReactNode) => act(async () => root.render(node));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the editor has one save status', () => {
  it('summarises the cards: failure first, then saving, then changes waiting, then saved', () => {
    const floor = { label: 'The floor', saveButton: 'Save the floor' };
    expect(summariseSaves([], false)).toBe('Every change saves as you make it.');
    expect(summariseSaves([{ ...floor, state: 'saved' }], false)).toBe('Saved');
    expect(summariseSaves([{ ...floor, state: 'changed' }], true)).toBe(
      'Not saved yet: The floor saves when you press Save the floor or leave the card.',
    );
    expect(summariseSaves([{ label: 'Brief', state: 'changed' }], false)).toBe('Not saved yet: Brief saves when you leave the card.');
    expect(summariseSaves([{ ...floor, state: 'saving' }, { label: 'Brief', state: 'changed' }], false)).toBe('Saving…');
    expect(summariseSaves([{ ...floor, state: 'saving' }, { label: 'Brief', state: 'failed', message: 'Write the intro first.' }], false)).toBe(
      'Not saved: Brief. Write the intro first.',
    );
  });

  it("a card's own save feeds the line: changed, saving, saved, and the refusal word for word", async () => {
    let send: () => Promise<never> = () => Promise.resolve({} as never);
    const card: { save?: ReturnType<typeof useCardSave> } = {};
    function Card() {
      const save = useCardSave({ label: 'The floor', saveButton: 'Save the floor', validate: () => '', send: () => send(), onSaved: () => undefined });
      useEffect(() => {
        card.save = save;
      });
      return null;
    }
    function Line() {
      return <p data-testid="line">{useEditorSaveSummary()}</p>;
    }
    await render(
      <EditorSaveProvider>
        <Line />
        <Card />
      </EditorSaveProvider>,
    );
    expect(byTestId('line')?.textContent).toBe('Every change saves as you make it.');
    await act(async () => card.save!.changed());
    expect(byTestId('line')?.textContent).toBe('Not saved yet: The floor saves when you press Save the floor or leave the card.');
    await act(async () => card.save!.saveNow());
    expect(byTestId('line')?.textContent).toBe('Saved');
    send = () => Promise.reject(new Error('The floor could not be saved.'));
    await act(async () => card.save!.changed());
    await act(async () => card.save!.saveNow());
    // The card's own sentence, word for word (a non-API error reads as the card's fallback).
    expect(byTestId('line')?.textContent).toBe('Not saved: The floor. That change could not be saved. Try again in a moment.');
  });
});

describe('the section navigation', () => {
  it('is one row of tabs: Overview, each phase, Validate and Publish, and it opens the one pressed', async () => {
    const onChange = vi.fn();
    await render(
      <EditorSaveProvider>
        <EditorNav
          phases={[
            { key: 'requirements', label: 'Requirements' },
            { key: 'design', label: 'Design' },
          ]}
          value="overview"
          onChange={onChange}
        />
      </EditorSaveProvider>,
    );
    const list = byTestId('editor-nav')!.querySelector('[role="tablist"]')!;
    expect(list.getAttribute('aria-label')).toBe('Sections of this draft');
    expect([...list.querySelectorAll('[role="tab"]')].map((one) => one.textContent)).toEqual([
      'Overview',
      'Requirements',
      'Design',
      'Validate',
      'Publish',
    ]);
    expect(byTestId('project-section-overview')?.getAttribute('aria-selected')).toBe('true');
    expect(byTestId('editor-nav-overview')?.closest('[role="tab"]')).toBe(byTestId('project-section-overview'));
    await act(async () => fireEvent.click(byTestId('editor-nav-phase-design')!));
    // A press opens the tab; the editor writes it as a pushed entry (the arrow keys open nothing, so there is no mode to pass).
    expect(onChange).toHaveBeenCalledWith('design');
    expect(byTestId('editor-save-status')?.getAttribute('role')).toBe('status');
    expect(byTestId('editor-save-status')?.textContent).toBe('Every change saves as you make it.');
  });
});

describe('the process checklist folds once editing has begun', () => {
  it('shows its one progress line and opens on request', async () => {
    await render(<GuideRail steps={deriveGuideSteps({ view: null })} where="editor" collapsible defaultOpen={false} />);
    const list = byTestId('guide-rail')!.querySelector('ol')!;
    expect(list.hidden).toBe(true);
    expect(byTestId('guide-rail-toggle')?.textContent).toBe('Show the steps');
    expect(byTestId('guide-rail-toggle')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => fireEvent.click(byTestId('guide-rail-toggle')!));
    expect(list.hidden).toBe(false);
    expect(byTestId('guide-rail-toggle')?.textContent).toBe('Hide the steps');
  });

  it('stays open where it is not collapsible (the projects page and the guide)', async () => {
    await render(<GuideRail steps={deriveGuideSteps({ view: null })} where="projects" />);
    expect(byTestId('guide-rail')!.querySelector('ol')!.hidden).toBe(false);
    expect(byTestId('guide-rail-toggle')).toBeNull();
  });
});

describe('the runbook record, as the teacher edits it', () => {
  const record = serialiseRunbook({
    ...EMPTY_RUNBOOK,
    environment: [
      { id: 'E1', name: 'API_URL', purpose: 'Where the web app finds the API', kind: 'config' },
      { id: 'E2', name: '', purpose: '', kind: 'config' },
    ],
    health: [{ id: 'H1', name: 'API health check', how: 'curl', expected: 'ok' }],
    data: [{ id: 'D1', what: 'The database file', how: '', where: '' }],
  });
  const floor = { minEnvironment: 2, minHealth: 1, minRollback: 0, minData: 1, requireIncident: false };

  it('names each entry, and its Add and Remove say which entry they act on', async () => {
    await render(<RunbookRecordEditor floor={floor} text={record} onChange={() => undefined} editable />);
    expect(byTestId('runbook-environment-0-summary')?.textContent).toBe('Environment E1 · API_URL');
    expect(byTestId('runbook-environment-1-summary')?.textContent).toBe('Environment E2 · environment variable E2');
    expect(byTestId('runbook-health-0-summary')?.textContent).toBe('Health checks H1 · API health check');
    expect(byTestId('runbook-environment-0-remove')?.textContent).toBe('Remove API_URL');
    expect(byTestId('runbook-add-environment')?.textContent).toBe('Add an environment variable');
    expect(byTestId('runbook-add-health')?.textContent).toBe('Add a health check');
    expect(byTestId('runbook-add-rollback')?.textContent).toBe('Add a rollback step');
    expect(byTestId('runbook-add-data')?.textContent).toBe('Add a data entry');
    expect(buttons().filter((text) => text === 'Remove' || text === 'Add')).toEqual([]);
    expect(host.querySelector('details[data-testid="runbook-environment-0"]')).not.toBeNull();
  });

  it('says what each Data field expects, with an example, where it said How and Where', async () => {
    await render(<RunbookRecordEditor floor={floor} text={record} onChange={() => undefined} editable />);
    const labels = [...byTestId('runbook-data-0')!.querySelectorAll('label')].map((label) => label.textContent);
    expect(labels).toEqual(['What is kept', 'How the backup is made', 'Where it is kept', 'How long copies are kept']);
    expect((byTestId('runbook-data-0-how') as HTMLTextAreaElement).placeholder).toBe('For example a nightly copy of the file');
    expect(host.textContent).toContain('For example a separate storage volume');
  });

  it('writes the same record the learner tab writes, and keeps every other entry', async () => {
    const onChange = vi.fn();
    await render(<RunbookRecordEditor floor={floor} text={record} onChange={onChange} editable />);
    await act(async () => fireEvent.click(byTestId('runbook-environment-0-remove')!));
    const written = JSON.parse(onChange.mock.calls[0][0]);
    expect(written.environment.map((item: { id: string }) => item.id)).toEqual(['E2']);
    expect(written.data[0].what).toBe('The database file');
    expect(runbookItemName('data', { id: 'D3', what: '' })).toBe('data entry D3');
  });

  it('keeps Check the runbook: pass or not yet per floor row, on the record as it now stands', async () => {
    function Held() {
      const [text, setText] = useState(record);
      return <RunbookRecordEditor floor={floor} text={text} onChange={setText} editable />;
    }
    await render(<Held />);
    expect(byTestId('runbook-check')?.textContent).toBe('Check the runbook');
    expect(byTestId('runbook-checks')).toBeNull();
    await act(async () => fireEvent.click(byTestId('runbook-check')!));
    const rows = [...byTestId('runbook-checks')!.querySelectorAll('li')];
    // The same rows, in the same words, as the learner's tab draws from the same floor.
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(
      evaluateRunbookFloor(record, floor).map((one) => `runbook-check-${one.id}`),
    );
    expect(rows.every((row) => /^(Passed|Not yet): /.test(row.textContent ?? ''))).toBe(true);
    expect(byTestId('runbook-check-runbook.health.min')?.textContent).toMatch(/^Passed: /);
    // Removing the one health check turns its row to Not yet at once.
    await act(async () => fireEvent.click(byTestId('runbook-health-0-remove')!));
    expect(byTestId('runbook-check-runbook.health.min')?.textContent).toMatch(/^Not yet: .*Fewer than 1 health check/);
  });

  it('a read-only record offers no check', async () => {
    await render(<RunbookRecordEditor floor={floor} text={record} onChange={() => undefined} editable={false} />);
    expect(byTestId('runbook-check')).toBeNull();
    expect(byTestId('runbook-checks')).toBeNull();
  });
});

describe('a failed validation row links to its field', () => {
  it('offers Go to its phase and task, and calls the editor with them', async () => {
    const onGoTo = vi.fn();
    const report = {
      tier: 'fast',
      ranAt: '2026-11-09T00:00:00.000Z',
      checks: [
        { id: 'task-has-brief', label: 'Every task has a brief', status: 'failed', sentence: 'The story task has no brief.', phaseKey: 'requirements', taskKey: 'story', files: [] },
        { id: 'pack-ok', label: 'The pack reads', status: 'passed', sentence: 'It reads.', phaseKey: null, taskKey: null, files: [] },
      ],
      passed: 1,
      failed: 1,
      notApplicable: 0,
      publishable: false,
      blocking: ['The story task has no brief.'],
      notApplicableLine: null,
    } as ValidationReport;
    await render(<ValidationReportPanel report={report} running={false} onRun={() => undefined} onGoTo={onGoTo} />);
    const go = byTestId('project-goto-task-has-brief-requirements-story')!;
    expect(go.textContent).toBe('Go to Requirements, task story');
    await act(async () => fireEvent.click(go));
    expect(onGoTo).toHaveBeenCalledWith('requirements', 'story');
    expect(host.querySelectorAll('[data-testid^="project-goto-"]')).toHaveLength(1);
  });
});
