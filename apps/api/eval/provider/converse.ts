import type { ContentBlock, ConverseCommandInput, ConverseCommandOutput, Message, SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { ChatMessage } from '../../src/assistant/openai.provider';
import type { BedrockSettings } from './bedrock-settings';

/**
 * The translation between the product's chat-completions request and the
 * Amazon Bedrock Converse API, in both directions. Pure: the same request
 * gives the same Converse bytes, with a fixed key order, so request digests
 * can be compared across models and runs.
 *
 * The product composes every prompt and sends it as a chat-completions body;
 * `BedrockProvider` hands that body here and sends what comes back to
 * Converse. Nothing in a prompt is rewritten: system messages become system
 * blocks, turns become turns, and a JSON answer is asked for in one trusted
 * system block appended last.
 */

/** The one network seam: production code builds the AWS SDK client, specs and the dry run pass a fake. */
export type ConverseSend = (input: ConverseCommandInput, abortSignal: AbortSignal) => Promise<ConverseCommandOutput>;

/** The sampling temperature every Bedrock request carries; each run records it in run.json. */
export const EVAL_TEMPERATURE = 0.4;

/** The trusted line a JSON call ends its system blocks with. */
export const JSON_ONLY_LINE = 'Respond with exactly one JSON object and nothing else: no prose before or after it and no Markdown fences.';
/** Converse requires the first turn to be the user's; a history window may start on the mentor's. */
export const HISTORY_OPENER = '(The conversation so far follows.)';
/** Stands in for a blank earlier turn (a stored row can be blank); Converse refuses an empty text block. */
export const EMPTY_TURN = '(empty message)';

/** What a call asks for: plain text, any JSON object, or JSON that validates against a named schema. */
export type JsonAsk = boolean | { name: string; schema: Record<string, unknown> };

function textBlock(text: unknown): { text: string } {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Bedrock request would carry an empty text block');
  return { text };
}

/** The Converse request for one completion. */
export function toConverseInput(messages: readonly ChatMessage[], maxTokens: number, json: JsonAsk, settings: BedrockSettings): ConverseCommandInput {
  const system: string[] = [];
  const turns: Message[] = [];
  for (const [index, message] of messages.entries()) {
    const role = (message as { role?: unknown }).role;
    if (role === 'system') {
      if (turns.length) throw new Error('Bedrock request has a system message after a turn');
      system.push(textBlock(message.content).text);
      continue;
    }
    if (role !== 'user' && role !== 'assistant') throw new Error('Bedrock request has an unknown role');
    // Only the final turn (the learner's ask) must carry text; a blank history row is named, not fatal.
    const isFinal = index === messages.length - 1;
    const blank = typeof message.content === 'string' && !message.content.trim();
    const block = blank && !isFinal ? { text: EMPTY_TURN } : textBlock(message.content);
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content!.push(block);
    else turns.push({ role, content: [block] });
  }
  if (!turns.length || turns[turns.length - 1].role !== 'user') throw new Error('Bedrock request must end on a user turn');
  if (turns[0].role === 'assistant') turns.unshift({ role: 'user', content: [{ text: HISTORY_OPENER }] });

  if (json) {
    system.push(typeof json === 'object'
      ? `${JSON_ONLY_LINE} It must validate against this JSON Schema.\n<<<RESPONSE_SCHEMA name=${json.name}\n${JSON.stringify(json.schema)}\nRESPONSE_SCHEMA>>>`
      : JSON_ONLY_LINE);
  }

  const input: ConverseCommandInput = { modelId: settings.modelId };
  if (system.length) input.system = system.map((text): SystemContentBlock => ({ text }));
  input.messages = turns;
  input.inferenceConfig = { maxTokens, temperature: EVAL_TEMPERATURE };
  if (settings.additionalModelRequestFields) input.additionalModelRequestFields = settings.additionalModelRequestFields as never;
  return input;
}

/** The parts of a chat-completions request body the translation reads. */
interface ChatRequestBody {
  messages?: unknown;
  max_completion_tokens?: unknown;
  max_tokens?: unknown;
  response_format?: { type?: unknown; json_schema?: { name?: unknown; schema?: unknown } };
}

/**
 * The Converse request for the chat-completions body the product sent, and
 * the kind of answer it asked for. The product names its output allowance
 * `max_completion_tokens` or `max_tokens` by model family and asks for JSON
 * through `response_format`; both are read here. Its sampling fields belong
 * to the OpenAI model family and are not carried over: every Converse request
 * has the same temperature.
 */
export function converseOfChatBody(body: string, settings: BedrockSettings): { input: ConverseCommandInput; json: JsonAsk } {
  const request = JSON.parse(body) as ChatRequestBody;
  if (!Array.isArray(request.messages)) throw new Error('Bedrock translation: the chat request has no messages');
  const maxTokens = request.max_completion_tokens ?? request.max_tokens;
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0) throw new Error('Bedrock translation: the chat request names no output allowance');
  const format = request.response_format;
  let json: JsonAsk = false;
  if (format?.type === 'json_schema') {
    const named = format.json_schema;
    if (typeof named?.name !== 'string' || !named.schema || typeof named.schema !== 'object') throw new Error('Bedrock translation: the response schema has no name or body');
    json = { name: named.name, schema: named.schema as Record<string, unknown> };
  } else if (format?.type === 'json_object') {
    json = true;
  } else if (format !== undefined) {
    throw new Error('Bedrock translation: unknown response format');
  }
  return { input: toConverseInput(request.messages as ChatMessage[], maxTokens as number, json, settings), json };
}

/** What a Converse answer becomes. */
export interface ParsedConverse {
  content: string;
  stopReason: string;
  usage: { tokensIn: number; tokensOut: number } | null;
  cachedTokens: number | null;
}

const SINGLE_FENCE = /^```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```$/;
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Text blocks joined; reasoning blocks dropped (their tokens stay in the
 * usage). On a JSON call, one whole-answer Markdown fence is unwrapped and
 * nothing else is repaired: a JSON-only instruction in a system block is
 * weaker than the OpenAI API's response format, and the product's strict
 * validators still judge what is left.
 */
export function fromConverseOutput(out: ConverseCommandOutput, json: JsonAsk): ParsedConverse {
  const blocks = (out?.output as { message?: { content?: ContentBlock[] } } | undefined)?.message?.content ?? [];
  let content = blocks.map((block) => (typeof block.text === 'string' ? block.text : '')).join('');
  if (json !== false) {
    const fenced = SINGLE_FENCE.exec(content.trim());
    if (fenced && !fenced[1].includes('```')) content = fenced[1];
  }
  const usage = out?.usage;
  return {
    content,
    stopReason: String(out?.stopReason ?? ''),
    usage: safeCount(usage?.inputTokens) && safeCount(usage?.outputTokens) ? { tokensIn: usage!.inputTokens!, tokensOut: usage!.outputTokens! } : null,
    cachedTokens: safeCount(usage?.cacheReadInputTokens) ? usage!.cacheReadInputTokens! : null,
  };
}

/** Converse stop reasons that mean the answer is whole. */
const COMPLETE_STOPS = new Set(['end_turn', 'stop_sequence']);

/**
 * A Converse answer as the chat-completions response body the product reads.
 * A whole answer finishes with `stop`; any other stop reason (`max_tokens`,
 * `guardrail_intervened`, ...) is passed on as the finish reason, which the
 * product refuses as an incomplete response.
 */
export function chatResponseOfConverse(parsed: ParsedConverse): string {
  return JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content: parsed.content }, finish_reason: COMPLETE_STOPS.has(parsed.stopReason) ? 'stop' : parsed.stopReason || 'unknown' }],
    ...(parsed.usage ? {
      usage: {
        prompt_tokens: parsed.usage.tokensIn,
        completion_tokens: parsed.usage.tokensOut,
        ...(parsed.cachedTokens !== null ? { prompt_tokens_details: { cached_tokens: parsed.cachedTokens } } : {}),
      },
    } : {}),
  });
}

/** Used only when an error carries no HTTP status of its own. */
const NAME_STATUS: Readonly<Record<string, number>> = {
  ThrottlingException: 429,
  ModelNotReadyException: 429,
  ServiceQuotaExceededException: 429,
  ServiceUnavailableException: 503,
  InternalServerException: 500,
  ModelErrorException: 424,
  ModelTimeoutException: 408,
  ValidationException: 400,
  AccessDeniedException: 403,
  ResourceNotFoundException: 404,
};
/** Throttling by any name buys the product's one retry, whatever status the SDK attached. */
const THROTTLE_NAMES = new Set(['ThrottlingException', 'ModelNotReadyException', 'ServiceQuotaExceededException']);

/** An SDK error's class name, when it is a bare identifier; never its message, which can carry ARNs and account ids. */
export function awsErrorName(err: unknown): string | null {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : null;
}

/** The HTTP status a Bedrock failure stands for, or null when it has none (a network failure, a local error). */
export function bedrockStatusOf(err: unknown): number | null {
  const name = awsErrorName(err);
  if (name && THROTTLE_NAMES.has(name)) return 429;
  const status = (err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  if (Number.isInteger(status) && (status as number) >= 400 && (status as number) <= 599) return status as number;
  return name && NAME_STATUS[name] ? NAME_STATUS[name] : null;
}
