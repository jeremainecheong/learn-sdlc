import { aiOperationSnapshot, currentAiOperationKind, trackAiOperation } from './operation-tracker';
import { AssistantService, KeyedLock } from './assistant.service';
import { InterviewService, STAKEHOLDER_REQUEST_TIMEOUT_MS } from './interview.service';
import { AgenticService, AGENTIC_REQUEST_TIMEOUT_MS } from './agentic.service';
import { renderMetrics, metricsAccess } from '../observability/metrics';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const count = () => aiOperationSnapshot().reduce((sum, row) => sum + row.active, 0);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

afterEach(() => { jest.useRealTimers(); expect(count()).toBe(0); });

it('counts independently queued operations and never stores their payloads', async () => {
  const release = deferred();
  const first = trackAiOperation('guided', () => release.promise);
  const second = trackAiOperation('agentic', () => release.promise);
  expect(count()).toBe(2);
  expect(aiOperationSnapshot().every(row => Object.keys(row).sort().join(',') === 'active,kind,oldestSeconds')).toBe(true);
  release.resolve(); await Promise.all([first, second]);
});

it('retains one underlying operation after its outer deadline settles, without double counting', async () => {
  const finish = deferred(); const deadline = deferred();
  const outer = trackAiOperation('interview', () => Promise.race([
    trackAiOperation('serialised', () => finish.promise), deadline.promise,
  ]));
  expect(count()).toBe(1);
  deadline.resolve(); await outer;
  expect(aiOperationSnapshot().find(row => row.kind === 'interview')?.active).toBe(1);
  finish.resolve(); await flush();
});

it('releases sync failures and rejected late work without negative counts', async () => {
  await expect(trackAiOperation('grading', () => { throw new Error('controlled'); })).rejects.toThrow('controlled');
  const finish = deferred();
  const outer = trackAiOperation('agentic', async () => {
    void trackAiOperation('serialised', () => finish.promise).catch(() => undefined);
  });
  await outer; expect(count()).toBe(1);
  finish.reject(new Error('late controlled')); await flush();
});

it('names the operation a metric label is being read inside, and nothing outside one', async () => {
  expect(currentAiOperationKind()).toBe('none');
  const release = deferred();
  const seen: string[] = [];
  const pending = trackAiOperation('guided', async () => {
    seen.push(currentAiOperationKind());
    // A nested scope retains the outer operation, so the label follows it.
    await trackAiOperation('serialised', () => {
      seen.push(currentAiOperationKind());
      return release.promise;
    });
  });
  release.resolve(); await pending;
  expect(seen).toEqual(['guided', 'guided']);
  expect(currentAiOperationKind()).toBe('none');
});

it('labels a retained tail as unattributed once its operation has settled', async () => {
  const finish = deferred();
  let late: string | undefined;
  const outer = trackAiOperation('agentic', async () => {
    void finish.promise.then(() => { late = currentAiOperationKind(); });
  });
  await outer;
  finish.resolve(); await flush();
  expect(late).toBe('none');
});

it('actual Guided service keeps same-learner queued turns visible until their final save settles', async () => {
  const save = deferred();
  const service = Object.create(AssistantService.prototype) as AssistantService;
  const answer = jest.fn().mockImplementationOnce(() => save.promise).mockResolvedValueOnce('second');
  Object.assign(service, { perLearner: new KeyedLock(),
    loadPhaseFor: jest.fn().mockResolvedValue({ state: {}, phase: {}, enrollment: {}, learner: {} }), answer });
  const first = service.chat('private-owner-fixture', 'private-phase', 'first');
  const second = service.chat('private-owner-fixture', 'private-phase', 'second');
  await flush();
  const observed = count(); const started = answer.mock.calls.length;
  save.resolve(); await Promise.all([first, second]);
  expect(started).toBe(1); expect(observed).toBe(2);
});

it('actual interview deadline cannot hide a still-pending ownership read', async () => {
  jest.useFakeTimers();
  const ownership = deferred<unknown>();
  const service = Object.create(InterviewService.prototype) as InterviewService;
  Object.assign(service, { workflow: { loadOwnedState: () => ownership.promise }, diagnostic: jest.fn() });
  const pending = service.ask('private-owner-fixture', 'private-phase', 'question').catch(error => error);
  await jest.advanceTimersByTimeAsync(STAKEHOLDER_REQUEST_TIMEOUT_MS);
  await pending;
  const stillActive = count();
  ownership.resolve({ phase: {}, enrollment: {} }); await flush();
  expect(stillActive).toBe(1);
});

it('actual agentic proposal retains its queued underlying promise after the55s deadline', async () => {
  jest.useFakeTimers();
  const ownership = deferred<unknown>();
  const assistant = Object.create(AssistantService.prototype) as AssistantService;
  Object.assign(assistant, { perLearner: new KeyedLock() });
  const service = Object.create(AgenticService.prototype) as AgenticService;
  Object.assign(service, { assistant, workflow: { loadOwnedState: () => ownership.promise } });
  const pending = service.propose('private-owner-fixture', 'private-phase', 'intent').catch(error => error);
  await jest.advanceTimersByTimeAsync(AGENTIC_REQUEST_TIMEOUT_MS); await pending;
  const observed = aiOperationSnapshot().find(row => row.kind === 'agentic')?.active;
  ownership.resolve({ phase: {}, state: {} }); await flush();
  expect(observed).toBe(1);
});

it('actual grading keeps usage persistence visible after the model has returned', async () => {
  const usage = deferred();
  const service = Object.create(AssistantService.prototype) as AssistantService;
  Object.assign(service, { perLearner: new KeyedLock(),
    openaiProvider: { available: true, review: jest.fn().mockResolvedValue({ tokensIn: 1, tokensOut: 1, provider: 'controlled' }) },
    recordReviewUsage: () => usage.promise });
  const pending = service.reviewSubmission({ rubric: { criteria: [] } } as never, { userId: 'private-owner-fixture' } as never, {} as never);
  await flush();
  const observed = aiOperationSnapshot().find(row => row.kind === 'grading')?.active;
  usage.resolve(); await pending;
  expect(observed).toBe(1);
});

it('exports fresh low-cardinality gauges through the existing protected metrics boundary', async () => {
  const done = deferred(); const pending = trackAiOperation('guided', () => done.promise);
  const busy = await renderMetrics();
  done.resolve(); await pending;
  const idle = await renderMetrics();
  expect(busy).toContain('ai_operations_active{kind="guided"} 1');
  expect(idle).toContain('ai_operations_active{kind="guided"} 0');
  expect(idle).toContain('ai_operation_oldest_seconds{kind="guided"} 0');
  expect(busy).not.toContain('private-owner-fixture');
  expect(metricsAccess(undefined, { NODE_ENV: 'production' })).toBe('disabled');
  expect(metricsAccess('Bearer wrong', { NODE_ENV: 'production', METRICS_TOKEN: 'controlled-only' })).toBe('bad-token');
});
