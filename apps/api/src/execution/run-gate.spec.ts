import { HttpStatus } from '@nestjs/common';
import { AI_BUSY_CODE } from '@learnsdlc/shared';
import { AI_BUSY_MESSAGE, AiBusyError, RunGate, SANDBOX_BUSY_MESSAGE, SandboxBusyError } from './run-gate';

/** A promise plus the handle that settles it, so a test can hold a slot open. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RunGate', () => {
  it('never runs more than the limit at once and releases in arrival order', async () => {
    const gate = new RunGate(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    const runs = gates.map((held, i) =>
      gate.run(async () => {
        started.push(i);
        await held.promise;
        return i;
      }),
    );

    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(gate.queued).toBe(1);

    gates[0].resolve();
    await runs[0];
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(gate.queued).toBe(0);
  });

  it('frees the slot when the work throws', async () => {
    const gate = new RunGate(1);
    await expect(gate.run(async () => Promise.reject(new Error('runner died')))).rejects.toThrow(
      'runner died',
    );
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });

  it('refuses a limit below one, because that gate would never open', () => {
    expect(() => new RunGate(0)).toThrow('at least 1');
  });
});

describe('RunGate cancellation', () => {
  it('never admits an already-cancelled operation and leaves the slot available', async () => {
    const gate = new RunGate(1);
    const controller = new AbortController();
    const reason = new Error('Operation ended'); controller.abort(reason);
    const work = jest.fn(async () => 'must not run');
    await expect(gate.run(work, controller.signal)).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });

  it('removes a cancelled waiter without disturbing the remaining queue or retaining its handles', async () => {
    jest.useFakeTimers();
    try {
      const gate = new RunGate(1, { maxWaitMs: 5000 });
      const held = deferred(); const running = gate.run(() => held.promise);
      const controller = new AbortController(); const reason = new Error('Deadline');
      const remove = jest.spyOn(controller.signal, 'removeEventListener');
      const work = jest.fn(async () => 'must not run');
      const cancelled = gate.run(work, controller.signal);
      const refusal = expect(cancelled).rejects.toBe(reason);
      const started: string[] = [];
      const following = ['first', 'second'].map(name => gate.run(async () => { started.push(name); return name; }));
      expect(gate.queued).toBe(3); expect(jest.getTimerCount()).toBe(3);
      controller.abort(reason); await refusal;
      expect(gate.queued).toBe(2); expect(jest.getTimerCount()).toBe(2);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(work).not.toHaveBeenCalled();
      held.resolve(); await running;
      await expect(Promise.all(following)).resolves.toEqual(['first', 'second']);
      expect(started).toEqual(['first', 'second']);
      expect(jest.getTimerCount()).toBe(0); expect(gate.queued).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it('returns a slot when cancellation arrives after admission but before work starts', async () => {
    const gate = new RunGate(1); const controller = new AbortController();
    const work = jest.fn(async () => 'must not run');
    const admitted = gate.run(work, controller.signal);
    const reason = new Error('Cancelled immediately'); controller.abort(reason);
    await expect(admitted).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });

  it('does not free a running operation’s slot until its work has actually stopped', async () => {
    const gate = new RunGate(1); const held = deferred(); const controller = new AbortController();
    const first = gate.run(() => held.promise, controller.signal);
    await Promise.resolve(); controller.abort();
    const secondWork = jest.fn(async () => 'next');
    const second = gate.run(secondWork);
    await Promise.resolve(); expect(secondWork).not.toHaveBeenCalled();
    held.resolve(); await first;
    await expect(second).resolves.toBe('next'); expect(gate.queued).toBe(0);
  });
});

/** The gate's refusal, or a failure saying it let the caller through. */
async function refusal(pending: Promise<unknown>): Promise<SandboxBusyError> {
  try {
    await pending;
  } catch (err) {
    if (err instanceof SandboxBusyError) return err;
    throw err;
  }
  throw new Error('expected the gate to refuse, but the work ran');
}

describe('RunGate, bounded', () => {
  it('refuses rather than waits once the deadline passes', async () => {
    // A FIFO with no deadline would keep a caller in the line however long the
    // line took, which for forty learners on the drill's health check at two
    // slots is about eleven minutes of open request. A caller past the
    // deadline is told the runner is busy while
    // that still means something to them.
    const gate = new RunGate(1, { maxWaitMs: 50 });
    const held = deferred();
    const first = gate.run(() => held.promise);

    const refused = await refusal(gate.run(async () => 'never runs'));
    expect(refused.reason).toBe('deadline');

    held.resolve();
    await first;
    expect(gate.queued).toBe(0);
  });

  it('answers the refusal as a 503 a learner can read', async () => {
    const gate = new RunGate(1, { maxWaitMs: 20 });
    const held = deferred();
    const first = gate.run(() => held.promise);

    const refused = await refusal(gate.run(async () => 'never runs'));
    expect(refused.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(refused.message).toBe(SANDBOX_BUSY_MESSAGE);
    // Nothing internal in it: no socket path, no stack, no queue length.
    expect(refused.message).not.toMatch(/\//);

    held.resolve();
    await first;
  });

  it('never starts the work it refused', async () => {
    const gate = new RunGate(1, { maxWaitMs: 20 });
    const held = deferred();
    const first = gate.run(() => held.promise);
    const work = jest.fn(async () => 'ran');

    await refusal(gate.run(work));
    expect(work).not.toHaveBeenCalled();

    held.resolve();
    await first;
  });

  it('turns an arrival away at the door once the line is full', async () => {
    // The second half of the bound: a burst that outruns the deadline is
    // refused as it arrives rather than accumulating a line of callers who
    // would each be refused later anyway.
    const gate = new RunGate(1, { maxWaitMs: 60_000, maxWaiting: 2 });
    const held = deferred();
    const running = gate.run(() => held.promise);
    const queued = [gate.run(async () => 'a'), gate.run(async () => 'b')];
    expect(gate.queued).toBe(2);

    const refused = await refusal(gate.run(async () => 'c'));
    expect(refused.reason).toBe('queue-full');
    expect(gate.queued).toBe(2);

    held.resolve();
    await running;
    expect(await Promise.all(queued)).toEqual(['a', 'b']);
  });

  it('leaves the line behind a refused waiter in its arrival order', async () => {
    // A waiter that gives up is spliced out of the middle of the queue; the
    // callers after it keep their places rather than being dropped with it.
    const gate = new RunGate(1, { maxWaitMs: 60_000 });
    const held = deferred();
    const running = gate.run(() => held.promise);

    const early = gate.run(async () => 'early');
    const late = gate.run(async () => 'late');
    expect(gate.queued).toBe(2);

    // Time the first waiter out by hand, the way its own timer would.
    const internals = gate as unknown as { giveUp(w: unknown): void; waiting: unknown[] };
    internals.giveUp(internals.waiting[0]);
    await refusal(early);
    expect(gate.queued).toBe(1);

    held.resolve();
    await running;
    await expect(late).resolves.toBe('late');
  });

  it('waits happily inside the deadline', async () => {
    // The bound must not become a limit on ordinary queueing: a slot that
    // frees up before the deadline is handed over as it always was.
    const gate = new RunGate(1, { maxWaitMs: 5_000 });
    const held = deferred();
    const first = gate.run(() => held.promise);
    const second = gate.run(async () => 'second');
    setTimeout(() => held.resolve(), 10);
    await first;
    await expect(second).resolves.toBe('second');
  });

  // The AI gate is a RunGate too, and its refusal must never carry the code runner's sentence:
  // otherwise a review refused after the queue wait is filed as a provider failure, and a turn as a slow model.
  describe('a gate that refuses in its own words (provider_busy)', () => {
    const aiGate = (options: { maxWaitMs?: number; maxWaiting?: number }) =>
      new RunGate(1, { ...options, busy: (reason, waitedMs) => new AiBusyError(reason, waitedMs) });

    it('refuses a full line with the AI error, carrying the reason and no wait', async () => {
      const gate = aiGate({ maxWaitMs: 60_000, maxWaiting: 0 });
      const held = deferred();
      const running = gate.run(() => held.promise);
      const refused = await gate.run(async () => 'never').catch(error => error);
      expect(refused).toBeInstanceOf(AiBusyError);
      expect(refused).not.toBeInstanceOf(SandboxBusyError);
      expect([refused.reason, refused.waitedMs, refused.getStatus()]).toEqual(['queue-full', 0, HttpStatus.SERVICE_UNAVAILABLE]);
      expect(refused.message).toBe(AI_BUSY_MESSAGE);
      // The body carries a code of its own, so a client can say "busy" without matching the words.
      expect(refused.getResponse()).toEqual({ statusCode: 503, error: 'Service Unavailable', code: AI_BUSY_CODE, message: AI_BUSY_MESSAGE });
      expect(AI_BUSY_CODE).toBe('AI_BUSY');
      held.resolve(); await running;
    });

    it('refuses a waiter past its deadline with the AI error and the wait it sat through', async () => {
      const gate = aiGate({ maxWaitMs: 20 });
      const held = deferred();
      const running = gate.run(() => held.promise);
      const refused = await gate.run(async () => 'never').catch(error => error);
      expect(refused).toBeInstanceOf(AiBusyError);
      expect([refused.reason, refused.waitedMs]).toEqual(['deadline', 20]);
      held.resolve(); await running;
      expect(gate.queued).toBe(0);
    });

    it('keeps the runner gate on the runner sentence', async () => {
      const gate = new RunGate(1, { maxWaitMs: 60_000, maxWaiting: 0 });
      const held = deferred();
      const running = gate.run(() => held.promise);
      const refused = await gate.run(async () => 'never').catch(error => error);
      expect(refused).toBeInstanceOf(SandboxBusyError);
      expect(refused.message).toBe(SANDBOX_BUSY_MESSAGE);
      held.resolve(); await running;
    });

    it('says the class is busy and the work is saved, never the code runner', () => {
      expect(AI_BUSY_MESSAGE).toBe('The AI is busy with the rest of the class, so this did not run. Your work is saved. Try again in a minute.');
      expect(AI_BUSY_MESSAGE).not.toMatch(/runner|provider/i);
    });
  });
});
