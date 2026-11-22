import { AsyncLocalStorage } from 'async_hooks';
import { config } from '../../src/config';
import { OpenAiProvider } from '../../src/assistant/openai.provider';
import { assertBedrockModelId, assertReasoningOffFields, type BedrockSettings } from './bedrock-settings';
import { awsErrorName, bedrockStatusOf, chatResponseOfConverse, converseOfChatBody, fromConverseOutput, type ConverseSend } from './converse';

/**
 * The product's `OpenAiProvider` with its transport swapped for Amazon
 * Bedrock's Converse API, and nothing else.
 *
 * Every prompt composer, the AI gate, the one 429 retry, the Guided draft,
 * self-review and repair, the interview review, the Agentic envelope with its
 * size refusal, the strict rubric parse and its grounding checks run as the
 * product's own code, unchanged. The product sends each completion as a
 * chat-completions request through the global `fetch`; while a call of this
 * provider runs, that one request is answered by Converse instead:
 *
 *   product request body -> Converse request -> `send` -> Converse answer
 *   -> chat-completions response body -> the product's own response checks.
 *
 * A Converse refusal with an HTTP status comes back as that status, so the
 * product's retry, its failure messages and the failure readers behave as
 * they do for any provider. A failure with no status (a network failure)
 * becomes the same `fetch failed` error the product sees when its own
 * transport cannot connect. The harness's own stops (a harness fault, the
 * spend stop, an expired AWS login) pass through unchanged.
 *
 * The provider's gate size and timeout are the product's: `AI_MAX_CONCURRENCY`
 * and `OPENAI_TIMEOUT_MS`, which boot.ts sets for the evaluation.
 */

interface ConverseRoute {
  settings: BedrockSettings;
  send: ConverseSend;
}

/** The route of the Bedrock provider whose call is running, if any. */
const routes = new AsyncLocalStorage<ConverseRoute>();

/** True inside a call of a `BedrockProvider`: the chat-completions request is Converse's to answer. */
export const converseRouteActive = (): boolean => routes.getStore() !== undefined;

/** Errors the harness raises inside a send to stop a run; they reach the runner as they were thrown. */
const HARNESS_STOPS = new Set(['HarnessFault', 'BudgetExceeded', 'CredentialsProviderError']);

/** Answer one chat-completions request through Converse, with `fetch`'s contract. */
async function converseFetch(route: ConverseRoute, url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = String(url instanceof Request ? url.url : url);
  if (target !== `${config.openaiBaseUrl}/chat/completions`) throw new Error('Bedrock route refused: only the chat-completions request is translated');
  if (typeof init?.body !== 'string') throw new Error('Bedrock route refused: the request has no body');
  const signal = init.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const { input, json } = converseOfChatBody(init.body, route.settings);
  let out;
  try {
    // Outside the route, so a send that itself uses fetch (the dry run's stub) reaches the network seam below.
    out = await routes.exit(() => route.send(input, signal));
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    const name = awsErrorName(err);
    const status = bedrockStatusOf(err);
    if (status !== null) {
      return new Response(JSON.stringify({ error: { type: name ?? 'unknown' } }), { status, headers: { 'content-type': 'application/json' } });
    }
    if (name && HARNESS_STOPS.has(name)) throw err;
    // The class name only: an SDK message can carry ARNs, account ids or credential hints.
    throw Object.assign(new TypeError('fetch failed'), name ? { awsErrorName: name } : {});
  }
  return new Response(chatResponseOfConverse(fromConverseOutput(out, json)), { status: 200, headers: { 'content-type': 'application/json' } });
}

let installed = false;

/**
 * Put the Converse route in front of the global `fetch`, once per process.
 * Outside a Bedrock provider's call every request goes on to the `fetch` that
 * was there before, untouched.
 */
function installConverseFetch(): void {
  if (installed) return;
  installed = true;
  const below = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const route = routes.getStore();
    return route ? converseFetch(route, url, init) : below(url, init);
  }) as typeof fetch;
}

export class BedrockProvider extends OpenAiProvider {
  private readonly route: ConverseRoute;

  constructor(settings: BedrockSettings, send: ConverseSend) {
    super();
    assertBedrockModelId(settings.modelId);
    assertReasoningOffFields(settings.additionalModelRequestFields);
    this.route = { settings: { ...settings }, send };
    installConverseFetch();
  }

  override get name(): string {
    return `bedrock:${this.route.settings.modelId}`;
  }

  /** Configured by construction: the model id is checked there, and credentials are the send's. */
  override get available(): boolean {
    return true;
  }

  // Every public model call runs inside this provider's route; a spec holds
  // that no public method of OpenAiProvider is left out.
  override chat(...args: Parameters<OpenAiProvider['chat']>): ReturnType<OpenAiProvider['chat']> {
    return routes.run(this.route, () => super.chat(...args));
  }

  override interview(...args: Parameters<OpenAiProvider['interview']>): ReturnType<OpenAiProvider['interview']> {
    return routes.run(this.route, () => super.interview(...args));
  }

  override reviewInterview(...args: Parameters<OpenAiProvider['reviewInterview']>): ReturnType<OpenAiProvider['reviewInterview']> {
    return routes.run(this.route, () => super.reviewInterview(...args));
  }

  override structured(...args: Parameters<OpenAiProvider['structured']>): ReturnType<OpenAiProvider['structured']> {
    return routes.run(this.route, () => super.structured(...args));
  }

  override review(...args: Parameters<OpenAiProvider['review']>): ReturnType<OpenAiProvider['review']> {
    return routes.run(this.route, () => super.review(...args));
  }
}
