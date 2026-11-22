import { register } from 'prom-client';
import { DURATION_SAMPLES, InProcessQueue } from './in-process.queue';

/** jobs_processed_total for one kind, as Prometheus would scrape it. */
async function processed(kind: string): Promise<Record<string, number>> {
  const metric = register.getSingleMetric('jobs_processed_total');
  const { values } = await metric!.get();
  const out: Record<string, number> = {};
  for (const v of values) if (v.labels.kind === kind) out[String(v.labels.status)] = v.value;
  return out;
}

describe('InProcessQueue', () => {
  it('counts completed and failed jobs on the same series the durable queue feeds', async () => {
    const before = await processed('run');
    const q = new InProcessQueue(1);
    q.register('run', async ({ id }) => {
      if (id === 'boom') throw new Error('handler exploded');
    });
    await q.enqueue('run', { id: 'ok-1' });
    await q.enqueue('run', { id: 'ok-2' });
    await q.enqueue('run', { id: 'boom' });
    await q.onIdle();
    const after = await processed('run');
    expect((after.completed ?? 0) - (before.completed ?? 0)).toBe(2);
    expect((after.failed ?? 0) - (before.failed ?? 0)).toBe(1);
  });

  it('reports itself as non-durable so callers can reconcile stranded work', () => {
    const q = new InProcessQueue(2);
    expect(q.durable).toBe(false);
    expect(q.name).toBe('in-process');
  });

  it('runs a registered handler with its payload', async () => {
    const q = new InProcessQueue(2);
    const seen: string[] = [];
    q.register('submission', async ({ id }) => {
      seen.push(id);
    });
    await q.enqueue('submission', { id: 'abc' });
    await q.onIdle();
    expect(seen).toEqual(['abc']);
  });

  it('never exceeds its concurrency limit', async () => {
    const q = new InProcessQueue(2);
    let active = 0;
    let peak = 0;
    q.register('run', async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
    });
    for (let i = 0; i < 8; i++) await q.enqueue('run', { id: String(i) });
    await q.onIdle();
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('isolates a failing job so the queue keeps draining', async () => {
    const q = new InProcessQueue(1);
    const done: string[] = [];
    q.register('submission', async ({ id }) => {
      if (id === 'boom') throw new Error('handler exploded');
      done.push(id);
    });
    await q.enqueue('submission', { id: 'boom' });
    await q.enqueue('submission', { id: 'after' });
    await q.onIdle();
    expect(done).toEqual(['after']);
  });

  it('drains in-flight work on shutdown and refuses new work after', async () => {
    const q = new InProcessQueue(1);
    let finished = false;
    q.register('run', async () => {
      await new Promise((r) => setTimeout(r, 50));
      finished = true;
    });
    await q.enqueue('run', { id: '1' });
    await q.shutdown();
    expect(finished).toBe(true);
    await expect(q.enqueue('run', { id: '2' })).rejects.toThrow(/shutting down/);
  });

  it('ping resolves: there is no backing store to reach', async () => {
    await expect(new InProcessQueue().ping()).resolves.toBeUndefined();
  });

  /* --------------------------- the fair scheduler --------------------------- */

  /**
   * The shape a class of forty makes: one learner presses Run three times
   * while everybody else presses it once. First in, first out serves all three
   * of theirs before anybody else's first, which is the thing that makes a lab
   * feel broken for thirty-nine people.
   */
  it('takes one job from each learner in turn rather than draining one learner first', async () => {
    const q = new InProcessQueue(1);
    const done: string[] = [];
    q.register('run', async ({ id }) => {
      done.push(id);
    });
    await q.enqueue('run', { id: 'A1', ownerId: 'ana' });
    await q.enqueue('run', { id: 'A2', ownerId: 'ana' });
    await q.enqueue('run', { id: 'A3', ownerId: 'ana' });
    await q.enqueue('run', { id: 'B1', ownerId: 'bo' });
    await q.enqueue('run', { id: 'C1', ownerId: 'kim' });
    await q.onIdle();
    expect(done).toEqual(['A1', 'B1', 'C1', 'A2', 'A3']);
  });

  it('keeps one learner\'s own jobs in the order they were submitted', async () => {
    const q = new InProcessQueue(1);
    const done: string[] = [];
    q.register('submission', async ({ id }) => {
      done.push(id);
    });
    await q.enqueue('submission', { id: 'first', ownerId: 'ana' });
    await q.enqueue('submission', { id: 'second', ownerId: 'ana' });
    await q.enqueue('submission', { id: 'third', ownerId: 'ana' });
    await q.onIdle();
    expect(done).toEqual(['first', 'second', 'third']);
  });

  /**
   * A job that names nobody (a background sweep, an older call site) shares
   * one turn with the other unowned jobs. It is never given a turn each (which
   * would starve the class) and never pushed to the back (which would starve
   * it).
   */
  it('gives every unowned job one shared turn beside the owned ones', async () => {
    const q = new InProcessQueue(1);
    const done: string[] = [];
    q.register('run', async ({ id }) => {
      done.push(id);
    });
    await q.enqueue('run', { id: 'U1' });
    await q.enqueue('run', { id: 'U2' });
    await q.enqueue('run', { id: 'A1', ownerId: 'ana' });
    await q.enqueue('run', { id: 'A2', ownerId: 'ana' });
    await q.onIdle();
    expect(done).toEqual(['U1', 'A1', 'U2', 'A2']);
  });

  /**
   * Asserted before the event loop turns, so the queue is still holding every
   * job: `enqueue` schedules the drain with setImmediate, and awaiting a
   * resolved promise only drains the microtask queue.
   */
  it('says how many jobs the scheduler would start before this one', async () => {
    const q = new InProcessQueue(1);
    q.register('run', async () => {});
    await q.enqueue('run', { id: 'A1', ownerId: 'ana' });
    await q.enqueue('run', { id: 'A2', ownerId: 'ana' });
    await q.enqueue('run', { id: 'A3', ownerId: 'ana' });
    await q.enqueue('run', { id: 'B1', ownerId: 'bo' });
    await q.enqueue('run', { id: 'C1', ownerId: 'kim' });

    expect(q.positionOf('run', 'A1')).toBe(0);
    expect(q.positionOf('run', 'B1')).toBe(1);
    expect(q.positionOf('run', 'C1')).toBe(2);
    expect(q.positionOf('run', 'A2')).toBe(3);
    expect(q.positionOf('run', 'A3')).toBe(4);
    // Not pending: never here, and a different kind with the same id.
    expect(q.positionOf('run', 'nothing-like-it')).toBeNull();
    expect(q.positionOf('submission', 'A1')).toBeNull();

    await q.onIdle();
    // Finished work is not in the line either.
    expect(q.positionOf('run', 'A1')).toBeNull();
  });

  it('has no estimate until five jobs of that kind have finished', async () => {
    const q = new InProcessQueue(1);
    q.register('run', async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    for (let i = 0; i < 4; i++) await q.enqueue('run', { id: `warm-${i}`, ownerId: 'ana' });
    await q.onIdle();
    expect(q.recentDurationMs('run')).toBeNull();

    await q.enqueue('run', { id: 'warm-4', ownerId: 'ana' });
    await q.onIdle();
    expect(q.recentDurationMs('run')).not.toBeNull();
    expect(q.recentDurationMs('submission')).toBeNull();
  });

  /**
   * The estimate describes the class in the room, not the one before it. A
   * quiet morning of quick jobs followed by a lab of slow ones must read slow:
   * a median over the whole term would still be reporting the morning, which
   * is the number a learner would be waiting against.
   */
  it('draws the estimate from the last twenty jobs and no further back', async () => {
    const q = new InProcessQueue(1);
    let jobMs = 0;
    q.register('submission', async () => {
      await new Promise((r) => setTimeout(r, jobMs));
    });
    for (let i = 0; i <= DURATION_SAMPLES; i++) {
      await q.enqueue('submission', { id: `quick-${i}`, ownerId: 'ana' });
    }
    await q.onIdle();
    const afterQuick = q.recentDurationMs('submission');
    expect(afterQuick).not.toBeNull();
    expect(afterQuick!).toBeLessThan(15);

    jobMs = 25;
    for (let i = 0; i < DURATION_SAMPLES; i++) {
      await q.enqueue('submission', { id: `slow-${i}`, ownerId: 'ana' });
    }
    await q.onIdle();
    expect(q.recentDurationMs('submission')!).toBeGreaterThanOrEqual(15);
  });
});
