import { DEFAULT_FIRST_SWEEP_DELAY_MS, resolveFirstSweepDelayMs } from './retention';

const env = (value: string | undefined) => ({ RETENTION_FIRST_SWEEP_DELAY_MS: value }) as NodeJS.ProcessEnv;

describe('how long the first retention sweep waits after a start', () => {
  it('waits two hours when the setting is unset, empty or not a whole number a timer can hold', () => {
    expect(DEFAULT_FIRST_SWEEP_DELAY_MS).toBe(7_200_000);
    for (const value of [undefined, '', 'abc', '2h', '-1', '1.5', '2147483648'])
      expect([value, resolveFirstSweepDelayMs(env(value))]).toEqual([value, DEFAULT_FIRST_SWEEP_DELAY_MS]);
  });

  it('waits the whole number of milliseconds it is given, with spaces trimmed and 0 sweeping at once', () => {
    expect(resolveFirstSweepDelayMs(env('0'))).toBe(0);
    expect(resolveFirstSweepDelayMs(env(' 60000 '))).toBe(60_000);
    expect(resolveFirstSweepDelayMs(env('2147483647'))).toBe(2_147_483_647);
  });
});
