import { fanoutPreflight } from '../../test/cli/verdict-digests';

/*
 * A fan-out value the config refuses loads as the serial grader in every
 * process but the API, so a verdict net "in fan-out mode" could prove the
 * serial path and still exit 0. The net refuses a value the API's boot would
 * refuse, and prints the values the grader loaded.
 */
describe('verdict-digests: the loaded grading fan-out is asserted and printed', () => {
  const loaded = (runFanout: number | null, speculativeMutants: boolean) => ({ runFanout, speculativeMutants });

  it('unset prints fanout=off speculativeMutants=off', () => {
    expect(fanoutPreflight({}, loaded(null, false))).toEqual({ line: 'fanout=off speculativeMutants=off' });
  });

  it('a valid fan-out prints the loaded values', () => {
    expect(fanoutPreflight({ RUNNER_SLOTS: '8', GRADING_RUN_FANOUT: '8', GRADING_SPECULATIVE_MUTANTS: 'on' }, loaded(8, true)))
      .toEqual({ line: 'fanout=8 speculativeMutants=on' });
  });

  it('a fan-out above RUNNER_SLOTS is refused, never loaded silently as serial', () => {
    const out = fanoutPreflight({ GRADING_RUN_FANOUT: '10', GRADING_SPECULATIVE_MUTANTS: 'on' }, loaded(null, false));
    expect(out).toEqual({ error: expect.stringContaining('GRADING_RUN_FANOUT (10) must not exceed RUNNER_SLOTS') });
  });

  it('speculative without a fan-out, and a non-integer fan-out, are refused', () => {
    expect(fanoutPreflight({ GRADING_SPECULATIVE_MUTANTS: 'on' }, loaded(null, false))).toEqual({ error: expect.stringContaining('needs GRADING_RUN_FANOUT') });
    expect(fanoutPreflight({ RUNNER_SLOTS: '8', GRADING_RUN_FANOUT: '2.5' }, loaded(null, false))).toEqual({ error: expect.stringContaining('positive whole number') });
  });

  it('a loaded value that differs from the environment is refused (the module loaded before the setting)', () => {
    expect(fanoutPreflight({ RUNNER_SLOTS: '8', GRADING_RUN_FANOUT: '8' }, loaded(null, false)))
      .toEqual({ error: 'the grader loaded fanout=off speculativeMutants=off but the environment says fanout=8 speculativeMutants=off' });
  });
});
