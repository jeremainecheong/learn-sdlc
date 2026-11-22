'use client';

/**
 * The testing phase's own tab: link each test to the criterion it checks, see
 * which criteria nobody proved, read the first-red record of every run, and
 * read the kill matrix from the last verdict. Everything comes from props.
 */
import { useState } from 'react';
import { andList } from '@learnsdlc/shared';
import { Chip, EmptyState, Notice, Section } from '@/components/ui';
import { TechMark, techForPath } from '@/components/TechMark';
import type { StatusState } from '@/lib/phase';
import type { PhasePanelProps } from '../types';
import { Matrix } from './Matrix';
import { ListHead, ListRow } from './Rows';
import { errorName, nextLinks, type FirstRecord } from './lib';
import { RunClock } from './RunClock';
import { useTesting } from './useTesting';

const FIRST_STATE: Record<FirstRecord['state'], StatusState> = {
  'red-first': 'pass',
  'still-red': 'fail',
  'never-red': 'warn',
  'green-first': 'warn',
  unseen: 'todo',
};

function firstDetail(r: FirstRecord): string {
  const err = errorName(r.redMessage);
  const red = `run ${r.firstRed}${err ? ` (${err})` : ''}`;
  switch (r.state) {
    case 'red-first':
      return `Red on ${red}, green on run ${r.firstGreen}.`;
    case 'still-red':
      return `Red on ${red}. No run has it green yet.`;
    case 'never-red':
      return `Never seen red: first green on run ${r.firstGreen}.`;
    case 'green-first':
      return `Green on run ${r.firstGreen} before it was ever red, then red on ${red}.`;
    default:
      return 'Not in any run yet.';
  }
}

function firstChip(state: FirstRecord['state']) {
  switch (state) {
    case 'red-first':
      return <Chip tone="pass">Red first</Chip>;
    case 'still-red':
      return <Chip tone="fail">Still red</Chip>;
    case 'never-red':
      return <Chip tone="warn">Never red</Chip>;
    case 'green-first':
      return <Chip tone="warn">Green first</Chip>;
    default:
      return <Chip tone="outline">Not run</Chip>;
  }
}

export function TestingTools(props: PhasePanelProps) {
  const { detail, links, runs, setLinks, runClock, setRunClock, helpers, thread } = props;
  const { files, tests, criteria, linked, view, first, matrixClock } = useTesting(props);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const testFile = files[0]?.path ?? 'your test file';
  // The two content packs speak Python and JavaScript; the empty state names
  // the form the learner will actually type.
  const testForm = /script$/i.test(files[0]?.language ?? '') ? "test('…')" : 'def test_…';
  const choice = (name: string) => edits[name] ?? linked[name] ?? '';
  const dirty = Object.entries(edits).some(([name, to]) => to !== (linked[name] ?? ''));
  const submitLabel = detail.lastSubmission ? 'Update pull request' : 'Open pull request';
  const known = new Set(tests.map((t) => t.name));
  const unlinked = tests.filter((t) => !choice(t.name));
  const testsFor = (id: string) => tests.filter((t) => choice(t.name) === id).map((t) => t.name);
  const orphans = criteria.filter((c) => testsFor(c.id).length === 0);

  const save = async () => {
    const draft: Record<string, string> = {};
    for (const t of tests) {
      const to = choice(t.name);
      if (to) draft[t.name] = to;
    }
    setSaving(true);
    try {
      await setLinks(nextLinks(links, draft, tests, new Date().toISOString()));
      setEdits({});
      helpers.setNotice('Links saved.');
    } catch (err) {
      helpers.setError(err instanceof Error ? err.message : 'The links did not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      {/* 0. Which day the sandbox calls today, before anything that runs. */}
      <RunClock
        runClock={runClock}
        setRunClock={setRunClock}
        busy={helpers.busy}
        onNotice={helpers.setNotice}
        onError={helpers.setError}
      />

      {/* 1. Every test, and the criterion it claims to check. */}
      <Section
        title="Tests and the criteria they check"
        purpose={
          <>
            One row per test in{' '}
            <TechMark name={techForPath(testFile)} size={13} className="mr-1 inline align-text-bottom" />
            <span className="mono">{testFile}</span>. Pick the criterion each one checks; the map draws a line for every
            link you save.
          </>
        }
        right={
          <button
            type="button"
            className="btn btn-sm"
            data-testid="phase-testing-links-save"
            onClick={save}
            disabled={!dirty || saving || helpers.busy}
          >
            Save links
          </button>
        }
        pad={false}
        testId="phase-testing-picker"
      >
        {tests.length === 0 ? (
          <div className="px-4">
            <EmptyState
              icon="test"
              title="No tests yet"
              body={`Every ${testForm} in ${testFile} shows up here to be linked to a criterion.`}
              action={
                <button type="button" className="btn btn-sm" onClick={() => helpers.openFile(testFile)}>
                  Open {testFile}
                </button>
              }
            />
          </div>
        ) : (
          <div className="flex flex-col">
            <ListHead left="Test" right="Criterion" />
            {tests.map((t) => {
              const to = choice(t.name);
              const changed = to !== (linked[t.name] ?? '');
              return (
                <ListRow
                  key={t.name}
                  state={to ? 'pass' : 'warn'}
                  mono
                  title={t.name}
                  detail={`Line ${t.line}${t.suite ? ` in ${t.suite}` : ''}`}
                  right={
                    changed ? (
                      <Chip tone="accent">Not saved</Chip>
                    ) : to ? (
                      <Chip tone="pass">Linked</Chip>
                    ) : (
                      <Chip tone="warn">Not linked</Chip>
                    )
                  }
                  below={
                    <select
                      className="field h-8 py-0 text-[13px]"
                      data-testid={`phase-testing-link-${t.name}`}
                      aria-label={`Criterion checked by ${t.name}`}
                      value={to}
                      disabled={criteria.length === 0 || saving}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [t.name]: e.target.value }))}
                    >
                      <option value="">Not linked</option>
                      {criteria.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title ? `${c.id} — ${c.title}` : c.id}
                        </option>
                      ))}
                    </select>
                  }
                />
              );
            })}
          </div>
        )}
      </Section>

      {/* 2. The same links read the other way round: which criteria are proved. */}
      <Section
        title="Criteria and the tests that check them"
        purpose="One row per criterion this phase covers. A criterion with no test is an orphan, and nothing proves it."
        pad={false}
        testId="phase-testing-coverage"
      >
        {criteria.length > 0 && (
          <div className="flex flex-col">
            <ListHead left="Criterion" right="Test" />
            {criteria.map((c) => {
              const names = testsFor(c.id);
              const lead = c.title ? c.id : (c.note ?? '');
              const state: StatusState = names.length > 0 ? 'pass' : unlinked.length > 0 ? 'warn' : 'todo';
              return (
                <ListRow
                  key={c.id}
                  state={state}
                  mono={!c.title}
                  title={c.title ?? c.id}
                  detail={
                    lead || names.length > 0 ? (
                      <>
                        {lead}
                        {lead && names.length > 0 ? ', checked by ' : ''}
                        {!lead && names.length > 0 ? 'Checked by ' : ''}
                        {names.length > 0 && <span className="mono">{andList(names)}</span>}
                      </>
                    ) : undefined
                  }
                  right={
                    names.length > 0 ? (
                      <Chip tone="pass">Linked</Chip>
                    ) : unlinked.length > 0 ? (
                      <Chip tone="warn">Pick a test</Chip>
                    ) : (
                      <Chip tone="outline">No test yet</Chip>
                    )
                  }
                />
              );
            })}
          </div>
        )}
        <div className="px-4">
          <Notice
            tone={criteria.length === 0 ? 'info' : orphans.length > 0 ? 'warn' : 'pass'}
            testId="phase-testing-orphans"
          >
            {criteria.length === 0
              ? 'No criterion ids yet. They arrive with the story you wrote and with the first verdict.'
              : orphans.length > 0
                ? `No test points at ${andList(orphans.map((c) => c.id))}.`
                : 'Every criterion on this list has a test pointing at it.'}
          </Notice>
        </div>
      </Section>

      {/* 3. The first-red record: a test that was never red proved nothing. */}
      <Section
        title="Failing first"
        purpose="A test proves something only if it was red before the code made it green. Every run for this phase is kept."
        right={<Chip tone="outline">{runs.length === 1 ? '1 run' : `${runs.length} runs`}</Chip>}
        pad={false}
        testId="phase-testing-failing-first"
      >
        {first.length === 0 ? (
          <div className="px-4">
            <EmptyState
              icon="play"
              title="No runs yet"
              body="Run your tests to start the record. A test that has never been red has not proved anything yet."
              action={
                // The header's and the Tests tab's word for the same act, not the pack's label.
                <button type="button" className="btn btn-sm" onClick={helpers.runNow} disabled={helpers.busy}>
                  Run tests
                </button>
              }
            />
          </div>
        ) : (
          <div className="flex flex-col">
            <ListHead left="Test" right="First run" />
            {first.map((r) => (
              <ListRow
                key={r.name}
                state={FIRST_STATE[r.state]}
                mono
                title={r.name}
                detail={known.has(r.name) ? firstDetail(r) : `${firstDetail(r)} No longer in ${testFile}.`}
                right={firstChip(r.state)}
              />
            ))}
          </div>
        )}
      </Section>

      {/* 4. The kill matrix from the newest verdict that carries one. */}
      <Matrix
        view={view}
        submitLabel={submitLabel}
        busy={helpers.busy}
        onSubmit={helpers.submitNow}
        matrixClock={matrixClock}
        runClock={runClock}
        // The case that kept the grid from running, and the thread
        // to ask about it in.
        unrunCase={(() => {
          const failed = props.submission?.report?.tests?.cases.find(
            (c) => c.status !== 'passed',
          );
          return failed ? { name: failed.name, step: failed.step } : null;
        })()}
        thread={thread}
        onOpenThread={() => helpers.setTab('mentor')}
      />
    </div>
  );
}
