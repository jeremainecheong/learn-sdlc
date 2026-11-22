import { buildCiSteps } from './ci-steps';

const scaffold = `name: tasktrackr-ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      # TODO(learner): add a step that runs the unit test suite

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # TODO(learner): add a step that builds the Docker image
`;

const completed = `name: tasktrackr-ci

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - name: Run the unit tests
        run: python -m unittest discover -s tests
  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build the image
        run: docker build -t tasktrackr:ci .
`;

const passingSmoke = { ok: true, stdout: 'added [ ] #1 Ship the release · high', stderr: '' };
const failingSmoke = {
  ok: false,
  stdout: '',
  stderr: 'python: can\'t open file \'/app/cli.py\': No such file or directory',
};

describe('buildCiSteps', () => {
  it('returns no rows for an empty file', () => {
    expect(buildCiSteps('', passingSmoke)).toEqual([]);
    expect(buildCiSteps('   \n\n', undefined)).toEqual([]);
  });

  it('reports one failed row when the yaml does not parse', () => {
    const rows = buildCiSteps('jobs:\n  test:\n   steps:\n  - uses: [oops\n', passingSmoke);
    expect(rows).toHaveLength(1);
    expect(rows[0].job).toBe('workflow');
    expect(rows[0].step).toBe('parse ci.yml');
    expect(rows[0].ok).toBe(false);
    expect(rows[0].detail).toContain('not valid YAML');
  });

  it('reports a failed row when the document is not a workflow mapping', () => {
    const rows = buildCiSteps('just a string\n', passingSmoke);
    expect(rows).toEqual([
      {
        job: 'workflow',
        step: 'parse ci.yml',
        ok: false,
        detail: 'ci.yml does not describe a workflow, so no pipeline runs at all.',
      },
    ]);
  });

  it('reports a failed row when there are no jobs', () => {
    const rows = buildCiSteps('name: ci\non:\n  push: {}\n', passingSmoke);
    expect(rows).toEqual([
      {
        job: 'workflow',
        step: 'jobs',
        ok: false,
        detail: 'ci.yml declares no jobs, so a push runs nothing.',
      },
    ]);
  });

  it('describes the scaffold: setup steps unknown, nothing graded, no test step at all', () => {
    const rows = buildCiSteps(scaffold, passingSmoke);
    expect(rows.map((r) => [r.job, r.step, r.ok])).toEqual([
      ['test', 'actions/checkout@v4', null],
      ['test', 'actions/setup-python@v5', null],
      ['build', 'actions/checkout@v4', null],
    ]);
    expect(rows.every((r) => r.ok === null)).toBe(true);
    expect(rows[0].detail).toContain('actions/checkout@v4');
  });

  it.each([passingSmoke, failingSmoke, undefined])('never substitutes the separate selfcheck for test or build execution (%j)', (smoke) => {
    const rows = buildCiSteps(completed, smoke);
    expect(rows.map((r) => [r.job, r.step, r.ok])).toEqual([
      ['test', 'actions/checkout@v4', null],
      ['test', 'actions/setup-python@v5', null],
      ['test', 'Run the unit tests', null],
      ['build', 'actions/checkout@v4', null],
      ['build', 'Build the image', null],
    ]);
    expect(rows[2].detail).toContain('test suite step was not executed');
    expect(rows[4].detail).toContain('build step was not executed');
    expect(rows.every((r) => !/would go green|would go red/.test(r.detail))).toBe(true);
  });

  it('keeps node, jest and bundle commands unexecuted even when selfcheck succeeds', () => {
    const yml = `jobs:
  ci:
    steps:
      - name: tests
        run: node --test tests/
      - name: unit
        run: npx jest --ci
      - name: bundle
        run: npm run build
`;
    const rows = buildCiSteps(yml, passingSmoke);
    expect(rows.map((r) => r.ok)).toEqual([null, null, null]);
    expect(rows[0].detail).toContain('test suite');
    expect(rows[2].detail).toContain('build');
  });

  it('says a step that only names a build never runs it', () => {
    const yml = `jobs:
  build:
    steps:
      - name: docker build the image
`;
    const rows = buildCiSteps(yml, passingSmoke);
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBeNull();
    expect(rows[0].detail).toBe(
      'This step names the build but has no run command, so nothing executes.',
    );
  });

  it('flags a later job that declares no needs', () => {
    const yml = `jobs:
  test:
    steps:
      - run: pytest
  build:
    steps:
      - run: docker build .
`;
    const rows = buildCiSteps(yml, passingSmoke);
    const needs = rows.find((r) => r.step === 'needs');
    expect(needs).toBeDefined();
    expect(needs?.job).toBe('build');
    expect(needs?.ok).toBeNull();
    expect(needs?.detail).toContain('runs beside test');
    // The declared pipeline keeps its order: the advisory row sits above the job's steps.
    expect(rows.map((r) => r.step)).toEqual(['pytest', 'needs', 'docker build .']);
  });

  it('does not flag needs on the first job or when needs is declared', () => {
    expect(buildCiSteps(completed, passingSmoke).some((r) => r.step === 'needs')).toBe(false);
  });

  it('reports a job with no steps as failed', () => {
    const yml = `jobs:
  test:
    runs-on: ubuntu-latest
`;
    const rows = buildCiSteps(yml, passingSmoke);
    expect(rows).toEqual([
      {
        job: 'test',
        step: '(no steps)',
        ok: false,
        detail: 'This job has no steps, so it does nothing.',
      },
    ]);
  });

  it('reports a job that is not a mapping and a step that is not a mapping', () => {
    const rows = buildCiSteps('jobs:\n  test: 3\n  build:\n    steps:\n      - hello\n', undefined);
    expect(rows[0]).toEqual({
      job: 'test',
      step: '(empty job)',
      ok: false,
      detail: 'This job has no definition, so it does nothing.',
    });
    const bad = rows.find((r) => r.job === 'build' && r.step === 'step 1');
    expect(bad?.ok).toBe(false);
    expect(bad?.detail).toContain('not a mapping');
  });

  it('falls back to the run command, then to a positional label, for an unnamed step', () => {
    const yml = `jobs:
  test:
    steps:
      - run: |
          echo one
          echo two
      - with:
          key: value
`;
    const rows = buildCiSteps(yml, undefined);
    expect(rows[0].step).toBe('echo one');
    expect(rows[1].step).toBe('step 2');
    expect(rows[1].detail).toBe('This step runs no command.');
  });

  it('truncates long labels and details instead of dumping the file into the report', () => {
    const long = 'x'.repeat(400);
    const rows = buildCiSteps(`jobs:\n  test:\n    steps:\n      - name: ${long}\n`, undefined);
    expect(rows[0].step.length).toBeLessThanOrEqual(80);
    expect(rows[0].step.endsWith('…')).toBe(true);
    expect(rows[0].detail.length).toBeLessThanOrEqual(200);
  });

  it('caps the number of rows', () => {
    const steps = Array.from({ length: 300 }, (_, i) => `      - run: echo ${i}`).join('\n');
    const rows = buildCiSteps(`jobs:\n  test:\n    steps:\n${steps}\n`, undefined);
    expect(rows).toHaveLength(100);
  });

  it('is pure: the same input yields the same rows', () => {
    expect(buildCiSteps(completed, passingSmoke)).toEqual(buildCiSteps(completed, passingSmoke));
  });
});
