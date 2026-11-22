import { buildDrillReport } from './drill';

/** The learner's incident as the runbook record holds it: the diagnosis reads the root cause and the fix. */
const incident = (rootCause: string, fix = 'Restored the line.') => ({ rootCause, fix });

const base = {
  fault: 'entrypoint-shell',
  description:
    'The Dockerfile ENTRYPOINT is rewritten to the shell form, so the container starts /bin/sh instead of the CLI.',
  failedBeforeFix: true,
  passedAfterFix: true,
  incident: null,
  beforeStderr: 'the container starts with "/bin/sh" — the smoke run expects python or node',
  afterStdout: 'added [ ] #1 Ship the release · high',
};

describe('buildDrillReport', () => {
  it('carries the fault, the outcomes and the captured output through', () => {
    const report = buildDrillReport(base);
    expect(report.fault).toBe('entrypoint-shell');
    expect(report.faultDescription).toBe(base.description);
    expect(report.failedBeforeFix).toBe(true);
    expect(report.passedAfterFix).toBe(true);
    expect(report.beforeStderr).toBe(base.beforeStderr);
    expect(report.afterStdout).toBe(base.afterStdout);
  });

  it('reports the two smoke outcomes independently', () => {
    expect(buildDrillReport({ ...base, failedBeforeFix: false }).failedBeforeFix).toBe(false);
    expect(buildDrillReport({ ...base, passedAfterFix: false }).passedAfterFix).toBe(false);
  });

  it('coerces missing outcome flags to false rather than undefined', () => {
    const report = buildDrillReport({
      ...base,
      failedBeforeFix: undefined as unknown as boolean,
      passedAfterFix: undefined as unknown as boolean,
    });
    expect(report.failedBeforeFix).toBe(false);
    expect(report.passedAfterFix).toBe(false);
  });

  describe('diagnosisNamesFault', () => {
    it('is false when there is no incident', () => {
      expect(buildDrillReport(base).diagnosisNamesFault).toBe(false);
    });

    it('is true when the incident names the faulted directive', () => {
      expect(buildDrillReport({
        ...base,
        incident: incident('The ENTRYPOINT was changed to the shell form, so the image ran /bin/sh.', 'Restored the exec form ["python", "cli.py"].'),
      }).diagnosisNamesFault).toBe(true);
    });

    it('is false when the incident is written but never names the directive', () => {
      expect(buildDrillReport({
        ...base,
        incident: incident('Something in the container was wrong and it would not start.', 'I changed the file back.'),
      }).diagnosisNamesFault).toBe(false);
    });

    it('names the directive case-insensitively', () => {
      expect(buildDrillReport({ ...base, incident: incident('The entrypoint line was replaced with a shell.') }).diagnosisNamesFault).toBe(true);
    });

    it('reads the fix as well as the root cause', () => {
      expect(buildDrillReport({ ...base, incident: incident('The image would not start.', 'Put the ENTRYPOINT back in exec form.') }).diagnosisNamesFault).toBe(true);
    });

    it('matches a SCREAMING_SNAKE environment variable from the description', () => {
      const args = {
        ...base,
        fault: 'env-data-path',
        description:
          'ENV TASKTRACKR_DATA is pointed at /nonexistent/tasks.json, which nothing in the smoke path reads.',
      };
      expect(buildDrillReport({ ...args, incident: incident('TASKTRACKR_DATA pointed at a path that does not exist.') }).diagnosisNamesFault).toBe(true);
      expect(buildDrillReport({ ...args, incident: incident('The data path was wrong.') }).diagnosisNamesFault).toBe(false);
    });

    it('falls back to the fault id words when the description names no directive', () => {
      const args = {
        ...base,
        fault: 'needs-test-removed',
        description: 'The build job no longer waits for the test job.',
      };
      // "needs" is a directive word, so it is picked from the description...
      expect(
        buildDrillReport({
          ...args,
          description: 'The build job drops needs: test.',
          incident: incident('The build job had no needs, so it ran on a red suite.'),
        }).diagnosisNamesFault,
      ).toBe(true);
      // ...and when the description names none, the id words carry the match.
      expect(
        buildDrillReport({
          ...args,
          incident: incident('The job dependency was removed from the pipeline.'),
        }).diagnosisNamesFault,
      ).toBe(false);
      expect(
        buildDrillReport({
          ...args,
          incident: incident('The pipeline was missing its test dependency.'),
        }).diagnosisNamesFault,
      ).toBe(true);
    });

    it('is false when there is no fault to name', () => {
      expect(
        buildDrillReport({ ...base, fault: '', description: '', incident: incident('The ENTRYPOINT was shell form.') }).diagnosisNamesFault,
      ).toBe(false);
    });

    it('does not match a fault word inside a longer word', () => {
      const args = { ...base, fault: 'copy-missing', description: 'The COPY line is deleted.' };
      expect(buildDrillReport({ ...args, incident: incident('The copywriter changed the file.', 'Reverted it.') }).diagnosisNamesFault).toBe(false);
    });
  });

  it('truncates very long captured output instead of storing the whole log', () => {
    const report = buildDrillReport({
      ...base,
      beforeStderr: 'e'.repeat(9000),
      afterStdout: 'o'.repeat(9000),
    });
    expect(report.beforeStderr).toHaveLength(4001);
    expect(report.beforeStderr.endsWith('…')).toBe(true);
    expect(report.afterStdout).toHaveLength(4001);
  });

  it('trims trailing whitespace from captured output and tolerates missing strings', () => {
    const report = buildDrillReport({
      ...base,
      beforeStderr: 'boom\n\n',
      afterStdout: undefined as unknown as string,
      incident: undefined as unknown as null,
    });
    expect(report.beforeStderr).toBe('boom');
    expect(report.afterStdout).toBe('');
    expect(report.diagnosisNamesFault).toBe(false);
  });

  it('reads the diagnosis from the record\'s incident alone', () => {
    const base = { fault: 'web-points-at-localhost', description: 'The web service API_URL is http://localhost:8000.', failedBeforeFix: true, passedAfterFix: true, beforeStderr: '', afterStdout: '' };
    expect(buildDrillReport({ ...base, incident: { rootCause: 'API_URL named localhost', fix: 'set it to http://api:8000' } }).diagnosisNamesFault).toBe(true);
    expect(buildDrillReport({ ...base, incident: { rootCause: 'the site was broken', fix: 'restarted it' } }).diagnosisNamesFault).toBe(false);
    expect(buildDrillReport({ ...base, incident: null }).diagnosisNamesFault).toBe(false);
  });

  it('is pure: the same input yields the same report', () => {
    const named = { ...base, incident: incident('The ENTRYPOINT was shell form.') };
    expect(buildDrillReport(named)).toEqual(buildDrillReport(named));
  });
});
