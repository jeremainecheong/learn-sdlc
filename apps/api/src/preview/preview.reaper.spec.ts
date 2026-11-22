import 'reflect-metadata';
import { PREVIEW_SWEEP_MS, PreviewReaper } from './preview.reaper';
import type { PreviewService } from './preview.service';

/**
 * The API's half of the reaping. The runner sweeps its own
 * sessions every five seconds; this exists because the runner cannot see an
 * API that has stopped caring, and because a deploy must not leave a class's
 * applications running on a machine nothing is watching.
 */
describe('PreviewReaper', () => {
  const stub = () => {
    const calls = { swept: 0, stoppedAll: [] as string[], throwOnSweep: false };
    const preview = {
      async sweep() {
        if (calls.throwOnSweep) throw new Error('the register is on fire');
        calls.swept += 1;
        return 1;
      },
      async stopAll(reason: string) {
        calls.stoppedAll.push(reason);
        return 2;
      },
    } as unknown as PreviewService;
    return { calls, reaper: new PreviewReaper(preview) };
  };

  it('sweeps on its own timer, and lets go of the process', async () => {
    jest.useFakeTimers();
    const { calls, reaper } = stub();
    try {
      reaper.onModuleInit();
      jest.advanceTimersByTime(PREVIEW_SWEEP_MS * 3);
      // The ticks are scheduled; let their promises settle.
      await Promise.resolve();
      await Promise.resolve();
      expect(calls.swept).toBe(3);
    } finally {
      reaper.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('stops sweeping when the module goes away, so a closed app schedules nothing', () => {
    jest.useFakeTimers();
    const { calls, reaper } = stub();
    try {
      reaper.onModuleInit();
      reaper.onModuleDestroy();
      jest.advanceTimersByTime(PREVIEW_SWEEP_MS * 5);
      expect(calls.swept).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps sweeping after a sweep that threw', async () => {
    const { calls, reaper } = stub();
    calls.throwOnSweep = true;
    await reaper.tick();
    calls.throwOnSweep = false;
    await reaper.tick();

    // A reaper that dies on its first bad tick leaves every later session
    // running, which is the failure this swallow exists to prevent.
    expect(calls.swept).toBe(1);
  });

  it('leaves shared sessions supervised when one replica shuts down', async () => {
    const { calls, reaper } = stub();
    await reaper.beforeApplicationShutdown();

    // beforeApplicationShutdown, not onApplicationShutdown: stopping a session
    // writes an audit row, and a row written into a closed connection is a lost
    // record of a thing that did happen.
    expect(calls.stoppedAll).toEqual([]);
  });
});
