/**
 * What the harness's Bedrock provider is built from, and the two checks every
 * Bedrock request depends on: the model id is an id and never an ARN, and the
 * only extra request fields are the ones that switch a model's reasoning off
 * or to its lowest setting.
 */

export interface BedrockSettings {
  /** A Bedrock model id or cross-region inference-profile id; never an ARN. */
  modelId: string;
  /** The model's documented reasoning switch, sent as Converse `additionalModelRequestFields`. Absent sends none. */
  additionalModelRequestFields?: Record<string, unknown>;
}

/**
 * A Bedrock model id (`amazon.nova-micro-v1:0`) or an inference-profile id
 * with its geography prefix (`us.amazon.nova-micro-v1:0`). An ARN does not
 * match: it carries the account id, and an id is all Converse needs.
 */
export const BEDROCK_MODEL_ID_PATTERN = /^(?:(?:us|eu|apac|global)\.)?[a-z0-9-]+\.[a-z0-9.-]+(?::\d+)?$/;
const MAX_MODEL_ID_CHARS = 128;

export function assertBedrockModelId(modelId: string): void {
  if (!BEDROCK_MODEL_ID_PATTERN.test(modelId) || modelId.length > MAX_MODEL_ID_CHARS) {
    throw new Error('Bedrock model id must be a model id or inference-profile id, not an ARN');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The only `additionalModelRequestFields` a model may be sent, each with the
 * values that turn reasoning off or to its lowest effort. Sampling settings,
 * budgets and tools are refused, so the extra fields can never change what is
 * measured beyond the reasoning switch.
 */
const REASONING_OFF: Readonly<Record<string, (value: unknown) => boolean>> = {
  reasoning_effort: (value) => value === 'low' || value === 'minimal' || value === 'none',
  reasoningConfig: (value) => isPlainObject(value) && Object.keys(value).length === 1 && value.type === 'disabled',
  thinking: (value) => isPlainObject(value) && Object.keys(value).length === 1 && value.type === 'disabled',
  enable_thinking: (value) => value === false,
};

export function assertReasoningOffFields(fields: Record<string, unknown> | undefined): void {
  if (fields === undefined) return;
  if (!isPlainObject(fields) || !Object.keys(fields).length
      || Object.entries(fields).some(([key, value]) => !Object.prototype.hasOwnProperty.call(REASONING_OFF, key) || !REASONING_OFF[key](value))) {
    throw new Error('Bedrock additionalModelRequestFields may only turn reasoning off or to its lowest setting');
  }
}
