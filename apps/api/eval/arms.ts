import * as fs from 'fs';
import { config } from '../src/config';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { captureAttempts } from './capture';
import type { EvalModel } from './contracts';
import { BedrockProvider } from './provider/bedrock.provider';
import type { BedrockSettings } from './provider/bedrock-settings';
import { evalConverseSend, readSecretField } from './transport/aws';
import { installOpenAiFetch, rawFetch } from './transport/openai-fetch';
import { STUB_KEY, setOriginalFetch, stubConverseInner } from './transport/stub';

/**
 * One provider instance per model lane, always the product's provider class:
 *
 * - Bedrock rows: the harness's `BedrockProvider` (provider/bedrock.provider.ts),
 *   the product's `OpenAiProvider` with its transport swapped for Converse
 *   and the eval's send. Every composer, the gate, the one 429 retry, the
 *   Guided self-review and repair, the interview review, the Agentic envelope,
 *   the strict review parse and its grounding are the product's, unchanged.
 * - The reference row: a plain `OpenAiProvider` with the production settings
 *   (the reference model, reasoning effort none, api.openai.com), its key read
 *   from Secrets Manager into memory only.
 *
 * Each instance has its own gate of one (AI_MAX_CONCURRENCY = 1, set in
 * boot.ts), so a model never has two requests in flight; the lanes run in
 * parallel with each other.
 */

export type ArmMode = 'real' | 'stub';

export interface ArmOptions { mode: ArmMode; stubPort?: number }

/** A JSON file whose application_secret_arn names the Secrets Manager secret holding OPENAI_API_KEY. */
const DEPLOYMENT_CONFIG = process.env.EVAL_DEPLOYMENT_CONFIG ?? '';

let referenceKeyLoaded = false;

/** Read the deployment's application secret's OPENAI_API_KEY into `config` (memory only). Never printed or written. */
export async function loadReferenceKey(): Promise<void> {
  if (referenceKeyLoaded) return;
  if (!DEPLOYMENT_CONFIG) throw new Error('EVAL_DEPLOYMENT_CONFIG is not set: the reference arm reads its key from the secret that file names');
  const arn = (JSON.parse(fs.readFileSync(DEPLOYMENT_CONFIG, 'utf8')) as { application_secret_arn?: string }).application_secret_arn;
  if (!arn) throw new Error('the file in EVAL_DEPLOYMENT_CONFIG names no application secret');
  config.openaiApiKey = await readSecretField(arn, 'api_env.OPENAI_API_KEY|OPENAI_API_KEY', rawFetch());
  referenceKeyLoaded = true;
}

function bedrockSettingsFor(model: EvalModel): BedrockSettings {
  return {
    modelId: model.modelId,
    ...(model.additionalModelRequestFields ? { additionalModelRequestFields: model.additionalModelRequestFields } : {}),
  };
}

export async function makeProvider(model: EvalModel, options: ArmOptions): Promise<OpenAiProvider> {
  installOpenAiFetch({ replayOn400: options.mode === 'stub' });
  setOriginalFetch(rawFetch());
  if (model.provider === 'openai') {
    config.openaiModel = model.modelId;
    config.openaiReasoningEffort = 'none';
    if (options.mode === 'stub') {
      config.openaiBaseUrl = `http://127.0.0.1:${options.stubPort}/v1`;
      config.openaiApiKey = STUB_KEY;
    } else {
      config.openaiBaseUrl = 'https://api.openai.com/v1';
      await loadReferenceKey();
    }
    return captureAttempts(new OpenAiProvider());
  }
  const send = evalConverseSend({
    maxOutputTokens: model.maxOutputTokens,
    // The documented switch goes on every request, and every response is checked for reasoning.
    reasoning: { policy: model.reasoning.policy, fields: model.reasoning.fields },
    ...(options.mode === 'stub' ? { inner: stubConverseInner(options.stubPort!) } : {}),
  });
  return captureAttempts(new BedrockProvider(bedrockSettingsFor(model), send));
}
