'use client';

import { useId, useState } from 'react';
import type { RunResult, TestCaseResult } from '@learnsdlc/shared';
import type { PersonaThread } from '@/components/shell';
import { Icon } from '@/components/Icon';
import { useTabs } from '@/components/ui';
import { ExplainTestButton } from './ExplainTest';

type EvidenceTab = 'failure' | 'comparison' | 'console';

/**
 * The Tests tab's first line: how the run went, in words, before the
 * tree. "11 of 11 passed", or "2 of 11 failed, failures first" where the tree
 * then lists the failures at the top of each suite.
 */
export function testsSummaryLine(cases: readonly Pick<TestCaseResult, 'status'>[]): string {
  if (!cases.length) return 'No test cases reported';
  const failed = cases.filter((item) => item.status !== 'passed').length;
  return failed === 0
    ? `${cases.length} of ${cases.length} passed`
    : `${failed} of ${cases.length} failed, failures first`;
}

/** Failures first, each side in the runner's own order. */
function failuresFirst<T extends Pick<TestCaseResult, 'status'>>(cases: T[]): T[] {
  return [...cases.filter((item) => item.status !== 'passed'), ...cases.filter((item) => item.status === 'passed')];
}
type RecordedCase = TestCaseResult & { identity: string };

/** Only display a comparison when the runner explicitly labelled both values. */
function labelledComparison(message = ''): { expected: string; actual: string } | null {
  // A multiline value must remain intact in Details, never become a clipped comparison.
  const pair = message.trim().match(/^Expected:[ \t]*(\S[^\r\n]*)\r?\n[ \t]*(?:Actual|Received):[ \t]*(\S[^\r\n]*)$/i);
  return pair ? { expected: pair[1], actual: pair[2] } : null;
}

function CaseIcon({ status }: { status: TestCaseResult['status'] }) {
  return <Icon name={status === 'passed' ? 'check' : status === 'errored' ? 'warn' : 'cross'} size={13} />;
}

/** A suite tree and selected-case inspector backed exclusively by the recorded run. */
export function TestingRunEvidence({ result, thread, onOpenThread }: {
  result: RunResult;
  thread?: PersonaThread | null;
  onOpenThread?: () => void;
}) {
  const cases: RecordedCase[] = (result.tests?.cases ?? []).map((item, index) => ({
    ...item, identity: `${item.step ?? ''}:${item.name}:${index}`,
  }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = cases.find(item => item.identity === selectedId)
    ?? cases.find(item => item.status !== 'passed') ?? cases[0];
  const [tab, setTab] = useState<EvidenceTab>('failure');
  const panelId = `testing-evidence-${useId().replace(/[^\w-]/g, '')}`;
  const tabs = useTabs({
    keys: ['failure', 'comparison', 'console'], value: tab,
    onChange: key => setTab(key as EvidenceTab), controls: panelId, label: 'Selected test evidence',
  });
  const knownSteps = new Set((result.steps ?? []).map(step => step.id));
  const groups = (result.steps ?? []).map(step => ({
    id: step.id, label: step.label, cases: failuresFirst(cases.filter(item => item.step === step.id)),
  }));
  const ungrouped = failuresFirst(cases.filter(item => !item.step || !knownSteps.has(item.step)));
  if (ungrouped.length) groups.push({ id: 'unassigned', label: groups.length ? 'Other recorded cases' : 'Test suite', cases: ungrouped });
  const comparison = labelledComparison(selected?.message);
  const selectCase = (item: RecordedCase) => { setSelectedId(item.identity); setTab('failure'); };

  return <section className="testing-runner" aria-label="Recorded test run">
    <header className="testing-runner-toolbar">
      <Icon name="testing" size={14} /><strong>TEST RUNNER</strong>
      <span data-testid="run-summary">{result.tests ? `${result.tests.passed}/${result.tests.total} tests passed` : 'No test cases reported'}</span>
      <small>{result.durationMs} ms</small>
    </header>
    <p className="testing-run-summary-line" data-testid="tests-summary-line">{testsSummaryLine(cases)}</p>
    <p className="testing-runner-notice">Actual sandbox results. The phase review is separate.</p>
    <div className="testing-runner-grid">
      <nav className="testing-suite-tree" aria-label="Recorded test suites">
        <p>SUITES <span>{groups.length}</span></p>
        {groups.map(group => <details open key={group.id}>
          <summary><Icon name="folder" size={13}/><span>{group.label}</span><small>{group.cases.length}</small></summary>
          {group.cases.map(item => <button key={item.identity} type="button" aria-pressed={item.identity === selected?.identity} data-outcome={item.status} onClick={() => selectCase(item)} title={item.name}>
            <CaseIcon status={item.status}/><span>{item.name}</span><span className="sr-only">{item.status}</span>
          </button>)}
        </details>)}
        {!cases.length && <p className="testing-no-cases">The runner reported no individual cases. Inspect its run output.</p>}
      </nav>
      <div className="testing-case-detail">
        <header className="testing-selected-case" data-outcome={selected?.status}>
          {selected && <CaseIcon status={selected.status}/>}
          <div><strong>{selected?.name ?? 'Run output'}</strong><small>{selected ? `${selected.status === 'passed' ? 'Passed' : selected.status === 'errored' ? 'Errored' : 'Failed'}${selected.hidden ? ' / hidden case' : ''}${selected.durationMs !== undefined ? ` / ${selected.durationMs} ms` : ''}` : `Execution ended: ${result.exitKind}`}</small></div>
        </header>
        <div {...tabs.tablistProps} className="testing-detail-tabs">
          {([['failure', 'Details'], ['comparison', 'Expected / actual'], ['console', 'Run output']] as const).map(([key, label]) => <button key={key} type="button" {...tabs.tabProps(key)}>{label}</button>)}
        </div>
        <div id={panelId} role="tabpanel" aria-labelledby={tabs.tabProps(tab).id} className="testing-evidence-panel">
          {tab === 'failure' && <>
            <p className="testing-evidence-kicker">{selected?.status === 'passed' ? 'RECORDED RESULT' : 'FAILURE DETAILS'}</p>
            {selected?.message ? <pre className="testing-assertion-message">{selected.message}</pre> : <p>{selected?.status === 'passed' ? 'This case passed. The runner supplied no additional assertion message.' : 'No assertion message was supplied. Run output holds what the run printed.'}</p>}
            {!!selected?.frames?.length && <ul className="testing-source-frames" aria-label="Recorded source locations">{selected.frames.map((frame, index) => <li key={`${frame.path}:${frame.line}:${index}`}><code>{frame.path}:{frame.line}</code>{frame.snippet && <pre>{frame.snippet}</pre>}</li>)}</ul>}
            {selected && selected.status !== 'passed' && <ExplainTestButton testName={selected.name} step={selected.step} source="run" thread={thread} onOpenThread={onOpenThread}/>}
          </>}
          {tab === 'comparison' && (comparison ? <><p>Values explicitly labelled by the runner in this case's message.</p><div className="testing-diff-block"><div className="testing-diff-expected"><span>EXPECTED</span><pre>{comparison.expected}</pre></div><div className="testing-diff-actual"><span>ACTUAL</span><pre>{comparison.actual}</pre></div></div></> : <><p>The runner did not report separate expected and actual values for this case. Read the original assertion below.</p><pre>{selected?.message || 'No assertion message was supplied.'}</pre></>)}
          {tab === 'console' && <><p className="testing-evidence-kicker">COMPLETE RUN OUTPUT</p><p>What the whole run printed, every suite included.</p><pre className="testing-console">{result.stdout || 'No stdout was recorded.'}</pre>{result.stderr && <><p className="testing-evidence-kicker">STDERR</p><pre className="testing-console testing-console-error">{result.stderr}</pre></>}</>}
        </div>
      </div>
    </div>
  </section>;
}
