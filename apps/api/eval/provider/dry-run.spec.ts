import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { makeProvider } from '../arms';
import { unitStore, type CallRecord, type UnitContext } from '../capture';
import { REFERENCE_KEY, REFERENCE_MODEL_ID, REASONING_SWITCHES, type CorpusCase, type EvalModel } from '../contracts';
import { runInterview } from '../jobs';
import { startStub } from '../transport/stub';

/*
 * The dry run's wiring, end to end and offline: the loopback stub
 * (e2e/ai-stub.cjs) answers both arms at once. The reference arm goes
 * through the reference fetch wrapper to the stub's chat-completions route;
 * the Bedrock arm goes through the product's provider, the Converse route,
 * the eval's Converse send and the stub translator. Each unit's call records
 * must come from its own arm, with the product's own call labels.
 */

const model = (over: Partial<EvalModel>): EvalModel => ({
  key: 'nova-micro', label: 'Amazon Nova Micro', provider: 'bedrock', modelId: 'us.amazon.nova-micro-v1:0', role: 'candidate', class: 'cloud',
  tier: null, licence: '', priceIn: 0.035, priceOut: 0.14, maxOutputTokens: 5000, contextTokens: null, hardware: '', access: '', probe: 'ok',
  reasoning: REASONING_SWITCHES['nova-micro'], additionalModelRequestFields: null, runnable: true, notRunReason: null,
  ...over,
});

const interviewCase: CorpusCase = {
  id: 'dry-interview', jobType: 'interview-turn', schemaVersion: 1, source: {},
  input: { question: 'Which tasks count as overdue?', brief: { kind: 'reference' }, projectTitle: 'TaskTrackr' },
  reference: {}, tags: { project: 'tasktrackr' },
};

const unit = (key: string): UnitContext => ({ unitId: `dry|${key}`, modelKey: key, caseId: interviewCase.id, jobType: interviewCase.jobType, calls: [], current: null });

describe('a dry run of one interview case on both arms at once', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  beforeAll(async () => {
    Logger.overrideLogger(false);
    stub = await startStub();
  });
  afterAll(() => {
    stub?.stop();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('answers each arm through its own transport, with the product\'s call labels', async () => {
    const bedrock = await makeProvider(model({}), { mode: 'stub', stubPort: stub.port });
    const reference = await makeProvider(model({ key: REFERENCE_KEY, provider: 'openai', modelId: REFERENCE_MODEL_ID, role: 'reference', reasoning: REASONING_SWITCHES[REFERENCE_KEY] }), { mode: 'stub', stubPort: stub.port });
    expect(bedrock.name).toBe('bedrock:us.amazon.nova-micro-v1:0');

    const onBedrock = unit('nova-micro');
    const onReference = unit(REFERENCE_KEY);
    const [b, r] = await Promise.all([
      unitStore.run(onBedrock, () => runInterview(bedrock, interviewCase)),
      unitStore.run(onReference, () => runInterview(reference, interviewCase)),
    ]);

    for (const outcome of [b, r]) expect(outcome).toMatchObject({ useCase: 'interview', delivered: true, failure: null });
    const shape = (calls: CallRecord[]) => calls.map((call) => [call.label, call.outcome, /^[0-9a-f]{64}$/.test(call.requestSha256 ?? '')]);
    expect(shape(onBedrock.calls)).toEqual([['interview.answer', 'ok', true], ['interview.review', 'ok', true]]);
    expect(shape(onReference.calls)).toEqual(shape(onBedrock.calls));
    // Only a Converse request has a model-neutral digest; the reference records the chat-completions body.
    expect(onBedrock.calls.every((call) => /^[0-9a-f]{64}$/.test(call.neutralSha256 ?? ''))).toBe(true);
    expect(onReference.calls.every((call) => call.neutralSha256 === null)).toBe(true);
    expect(onBedrock.calls.map((call) => call.requestSha256)).not.toEqual(onReference.calls.map((call) => call.requestSha256));
  }, 60_000);
});
