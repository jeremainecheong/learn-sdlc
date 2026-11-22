import { createHash, createHmac } from 'crypto';
import type { ConverseCommandInput, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { bedrockStatusOf, type ConverseSend } from '../provider/converse';
import { unitStore } from '../capture';

/**
 * The AWS side of the harness, with credentials only from your AWS profile
 * (AWS_PROFILE, for example an `aws login` or `aws sso login` session,
 * resolved and refreshed by the SDK). No key is created, written or printed.
 * An expired session stops the Bedrock lanes cleanly: `awsLoginNeeded()` turns
 * true and the runner reports "AWS login needed".
 */

export const EVAL_REGION = 'us-east-1';
let loginNeeded = false;
export const awsLoginNeeded = (): boolean => loginNeeded;
export const resetAwsLoginNeeded = (): void => { loginNeeded = false; };

/**
 * A harness fault: a response carried reasoning from a model
 * whose reasoning is off (or that has no thinking mode), or a request did not
 * carry exactly the model's documented switch. Every lane stops at its next
 * unit and every later call is refused before it is sent; the faulty unit is
 * never recorded as a model result. Fix the switch, then resume.
 */
let fault: string | null = null;
export const harnessFault = (): string | null => fault;
export const setHarnessFault = (why: string): void => { fault ??= why; };
export const resetHarnessFault = (): void => { fault = null; };
const faultError = (why: string) => Object.assign(new Error(`harness fault: ${why}`), { name: 'HarnessFault' });

/** Stable JSON (sorted keys) so a switch compares by value, not by key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Reasoning-token counts anywhere in a Converse usage object (none is documented; any positive one is reasoning). */
function reasoningTokensIn(usage: unknown): number {
  let n = 0;
  const walk = (v: unknown, keyHint: string) => {
    if (typeof v === 'number' && /reason|think/i.test(keyHint) && v > 0) n += v;
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${keyHint}.${k}`);
  };
  walk(usage, '');
  return n;
}

/**
 * The request without what legitimately differs per model (model id, the
 * reasoning switch, the max-tokens clamp): equal digests across models prove
 * every model was asked the same thing from the same frozen inputs.
 */
function neutralRequestSha256(input: ConverseCommandInput): string {
  const { modelId: _m, additionalModelRequestFields: _f, inferenceConfig, ...rest } = input;
  const { maxTokens: _t, ...ic } = inferenceConfig ?? {};
  return createHash('sha256').update(canonicalJson({ ...rest, inferenceConfig: ic }), 'utf8').digest('hex');
}

const CREDENTIAL_ERRORS = new Set([
  'ExpiredTokenException', 'ExpiredToken', 'UnrecognizedClientException', 'InvalidSignatureException',
  'CredentialsProviderError', 'TokenProviderError', 'InvalidClientTokenId', 'SignatureDoesNotMatch',
]);
const THROTTLES = new Set(['ThrottlingException', 'ServiceUnavailableException', 'ModelNotReadyException', 'TooManyRequestsException']);
/** Refusals Bedrock returns before any inference: never billed. */
const NOT_BILLED = new Set(['ThrottlingException', 'ValidationException', 'AccessDeniedException', 'ResourceNotFoundException', 'ServiceQuotaExceededException', 'ModelNotReadyException', 'TooManyRequestsException']);

const errorName = (err: unknown): string | null => {
  const name = (err as { name?: unknown })?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : null;
};

function isCredentialError(err: unknown): boolean {
  const name = errorName(err);
  if (name && CREDENTIAL_ERRORS.has(name)) return true;
  const msg = err instanceof Error ? err.message : '';
  return /could not load credentials|token (?:has )?expired|session (?:has )?expired|login session/i.test(msg);
}

function credentialProvider(profile = process.env.AWS_PROFILE || 'default') {
  const { fromIni } = require('@aws-sdk/credential-provider-ini') as typeof import('@aws-sdk/credential-provider-ini');
  return fromIni({ profile });
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(signal?.reason); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_RETRIES = 6;

/**
 * Exponential backoff on throttling, inside the transport: 1, 2, 4, 8, 16, 32 s
 * (≤ 6 retries), within the call's own deadline. The product's one-retry policy
 * sits above this unchanged. Throttled attempts cost nothing; the wait is
 * recorded apart from the call's latency.
 */
export async function withThrottleBackoff<T>(run: () => Promise<T>, isThrottle: (err: unknown) => boolean, signal?: AbortSignal, onWait?: (ms: number) => void): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await run();
    } catch (err) {
      if (!isThrottle(err) || retry >= BACKOFF_MAX_RETRIES || signal?.aborted) throw err;
      const wait = BACKOFF_BASE_MS * 2 ** retry;
      onWait?.(wait);
      await sleep(wait, signal);
    }
  }
}

/**
 * The eval's SDK client settings: SDK retries off, so the product's one retry
 * is the only one; AWS_ENDPOINT_URL* and a profile endpoint_url are
 * ignored so learner text goes only to the regional AWS host; one HTTP/2 session
 * is reused, so Bedrock latency does not carry a fresh handshake per call that
 * the OpenAI reference arm does not pay.
 */
export function evalClientConfig(region: string, credentials: unknown) {
  return { region, maxAttempts: 1, credentials: credentials as never, ignoreConfiguredEndpointUrls: true, requestHandler: { disableConcurrentStreams: false } };
}

/**
 * The eval's Converse send for one model: the SDK client (retries off, as the
 * product builds it), the documented-maximum clamp on maxTokens, throttling
 * backoff, credential-expiry detection, and the capture of the request digest,
 * the raw answer, the stop reason and the usage into the current call record.
 */
export function evalConverseSend(options: {
  maxOutputTokens: number;
  region?: string;
  inner?: ConverseSend;
  /** The model's reasoning policy and its exact switch. Default: no thinking mode, nothing sent (the strictest). */
  reasoning?: { policy: 'none' | 'off' | 'minimum'; fields: Record<string, unknown> | null };
}): ConverseSend {
  const reasoning = options.reasoning ?? { policy: 'none' as const, fields: null };
  const expectedFields = reasoning.fields ? canonicalJson(reasoning.fields) : null;
  let client: { send: (cmd: unknown, opts: { abortSignal: AbortSignal }) => Promise<ConverseCommandOutput> } | null = null;
  let Command: (new (input: ConverseCommandInput) => unknown) | null = null;
  const inner: ConverseSend = options.inner ?? (async (input, abortSignal) => {
    if (!client) {
      const sdk = require('@aws-sdk/client-bedrock-runtime') as typeof import('@aws-sdk/client-bedrock-runtime');
      client = new sdk.BedrockRuntimeClient(evalClientConfig(options.region ?? EVAL_REGION, credentialProvider())) as never;
      Command = sdk.ConverseCommand as never;
    }
    return client!.send(new Command!(input), { abortSignal });
  });
  return async (input, abortSignal) => {
    const record = unitStore.getStore()?.current ?? null;
    const asked = input.inferenceConfig?.maxTokens ?? null;
    const sent: ConverseCommandInput = asked && asked > options.maxOutputTokens
      ? { ...input, inferenceConfig: { ...input.inferenceConfig, maxTokens: options.maxOutputTokens } }
      : input;
    const body = JSON.stringify(sent);
    if (record) {
      record.requestSha256 = createHash('sha256').update(body, 'utf8').digest('hex');
      record.requestBytes = Buffer.byteLength(body, 'utf8');
      record.maxTokensSent = sent.inferenceConfig?.maxTokens ?? null;
      record.reasoningFieldsSent = sent.additionalModelRequestFields ? canonicalJson(sent.additionalModelRequestFields) : null;
      record.neutralSha256 = neutralRequestSha256(sent);
    }
    if (fault) {
      if (record) record.outcome = 'harness_fault';
      throw faultError(fault);
    }
    const sentFields = sent.additionalModelRequestFields ? canonicalJson(sent.additionalModelRequestFields) : null;
    if (sentFields !== expectedFields) {
      // Never send a request without the model's documented switch (or with any other field).
      setHarnessFault(`request for ${String(sent.modelId)} carried reasoning fields ${sentFields ?? 'none'}, expected ${expectedFields ?? 'none'}`);
      if (record) record.outcome = 'harness_fault';
      throw faultError(fault!);
    }
    if (loginNeeded) {
      if (record) record.outcome = 'credentials';
      throw Object.assign(new Error('AWS login needed'), { name: 'CredentialsProviderError' });
    }
    const budget = unitStore.getStore()?.budget;
    const reserved = budget ? budget.reserve(Buffer.byteLength(body, 'utf8'), sent.inferenceConfig?.maxTokens ?? 0) : 0;
    if (record) record.reservedUsd = reserved;
    let started = 0;
    try {
      const out = await withThrottleBackoff(async () => {
        started = performance.now();
        return inner(sent, abortSignal);
      }, (err) => THROTTLES.has(errorName(err) ?? '') || (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 429,
      abortSignal, (ms) => { if (record) { record.backoffMs += ms; record.throttleRetries += 1; } });
      if (record) {
        record.latencyMs = Math.round(performance.now() - started);
        const blocks = (out?.output as { message?: { content?: Array<{ text?: string }> } })?.message?.content ?? [];
        record.reasoningBlocks = blocks.filter((b) => b && typeof b === 'object' && typeof b.text !== 'string').length;
        record.responseText = blocks.map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
        record.stopReason = String(out?.stopReason ?? '');
        record.tokensIn = Number.isSafeInteger(out?.usage?.inputTokens) ? out!.usage!.inputTokens! : null;
        record.tokensOut = Number.isSafeInteger(out?.usage?.outputTokens) ? out!.usage!.outputTokens! : null;
        record.cachedTokens = Number.isSafeInteger(out?.usage?.cacheReadInputTokens) ? out!.usage!.cacheReadInputTokens! : null;
        record.fenceNormalised = /^```(?:json)?[ \t]*\n[\s\S]*\n[ \t]*```$/.test(record.responseText.trim());
        record.reasoningTokens = reasoningTokensIn(out?.usage);
        if (record.stopReason === 'max_tokens') record.outcome = 'incomplete';
        else if (record.stopReason === 'guardrail_intervened' || record.stopReason === 'content_filtered') record.outcome = 'refusal';
        else if (record.stopReason === 'model_context_window_exceeded') record.outcome = 'context_limit';
        else if (!record.responseText.trim()) record.outcome = 'empty';
      }
      if (budget) {
        const cost = budget.settle(reserved, Number.isSafeInteger(out?.usage?.inputTokens) ? out!.usage!.inputTokens! : null, Number.isSafeInteger(out?.usage?.outputTokens) ? out!.usage!.outputTokens! : null);
        if (record) record.costUsd = cost;
      }
      // Assert on every response that no reasoning came back (gpt-oss excepted: minimum, cannot be disabled).
      if (reasoning.policy !== 'minimum') {
        const blocks = ((out?.output as { message?: { content?: Array<Record<string, unknown>> } })?.message?.content ?? []);
        const reasoningBlocks = blocks.filter((b) => b && typeof b === 'object' && ('reasoningContent' in b || (typeof b.text !== 'string' && !('toolUse' in b)))).length;
        const tokens = reasoningTokensIn(out?.usage);
        const text = blocks.map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
        const thinkText = /<think>\s*\S/i.test(text);
        if (reasoningBlocks || tokens || thinkText) {
          setHarnessFault(`reasoning returned by ${String(sent.modelId)} (policy ${reasoning.policy}; ${reasoningBlocks} reasoning block(s), ${tokens} reasoning token(s)${thinkText ? ', <think> text' : ''})`);
          if (record) record.outcome = 'harness_fault';
          throw faultError(fault!);
        }
      }
      return out;
    } catch (err) {
      if ((err as { name?: string })?.name === 'HarnessFault') throw err;
      const name = errorName(err);
      const status = bedrockStatusOf(err);
      const aborted = Boolean(abortSignal?.aborted);
      // Billed nothing only when Bedrock refused the call before inference: a
      // credential failure, throttling, a refusal by name, or a 4xx that was not
      // our own abort. Everything else (our deadline, a socket reset, a 5xx after
      // inference) may have been billed, so it is charged its worst case.
      const notBilled = isCredentialError(err)
        || (name !== null && NOT_BILLED.has(name))
        || (status !== null && status >= 400 && status < 500 && !aborted);
      const cost = budget ? budget.settle(reserved, notBilled ? 0 : null, notBilled ? 0 : null) : 0;
      if (record) {
        record.costUsd = cost;
        record.latencyMs = started ? Math.round(performance.now() - started) : null;
        record.errorName = name;
        record.httpStatus = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? status;
        const message = err instanceof Error ? err.message : '';
        if (isCredentialError(err)) { loginNeeded = true; record.outcome = 'credentials'; }
        else if (name === 'ValidationException' && /too long|too many tokens|context|max.*length|input length/i.test(message)) record.outcome = 'context_limit';
        else if (status === 429) record.outcome = 'rate_limited';
        else if (status !== null && status >= 500 && name !== 'ModelErrorException') record.outcome = 'server_error';
        else if (status === null && !aborted) record.outcome = 'transport';
      }
      throw err;
    }
  };
}

/* ------------------------- Secrets Manager (reference) ------------------------ */

class NodeSha256 {
  private readonly h: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(secret?: string | Uint8Array) {
    this.h = secret ? createHmac('sha256', Buffer.from(secret as Uint8Array)) : createHash('sha256');
  }
  update(data: string | Uint8Array): void { this.h.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)); }
  async digest(): Promise<Uint8Array> { return new Uint8Array(this.h.digest()); }
}

/**
 * Read one string field of the application secret into memory. A SigV4-signed
 * GetSecretValue with the login session's credentials; the response body is
 * parsed in memory and only the named field is returned. Nothing is logged or
 * written; errors name the class of failure only.
 */
export async function readSecretField(secretArn: string, field: string, rawFetch: typeof fetch): Promise<string> {
  const region = secretArn.split(':')[3];
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region ?? '')) throw new Error('secret reference is not a Secrets Manager ARN');
  const { SignatureV4 } = require('@smithy/signature-v4') as typeof import('@smithy/signature-v4');
  let credentials;
  try { credentials = await credentialProvider()(); } catch { loginNeeded = true; throw new Error('AWS login needed'); }
  const host = `secretsmanager.${region}.amazonaws.com`;
  const body = JSON.stringify({ SecretId: secretArn });
  const signer = new SignatureV4({ credentials, region, service: 'secretsmanager', sha256: NodeSha256 as never });
  const signed = (await signer.sign({
    method: 'POST', protocol: 'https:', hostname: host, path: '/',
    headers: { host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'secretsmanager.GetSecretValue' },
    body,
  } as never)) as unknown as { headers: Record<string, string> };
  const response = await rawFetch(`https://${host}/`, { method: 'POST', headers: signed.headers as Record<string, string>, body });
  const text = await response.text();
  if (!response.ok) {
    const kind = /ExpiredToken|UnrecognizedClient|InvalidSignature/.test(text) ? 'credentials' : `HTTP ${response.status}`;
    if (kind === 'credentials') loginNeeded = true;
    throw new Error(kind === 'credentials' ? 'AWS login needed' : `Secrets Manager refused the read (${kind})`);
  }
  const secretString = (JSON.parse(text) as { SecretString?: string }).SecretString;
  if (typeof secretString !== 'string') throw new Error('the application secret has no string value');
  let root: unknown;
  try { root = JSON.parse(secretString); } catch { throw new Error('the application secret is not a JSON object'); }
  // Each candidate is a dot path into the secret's JSON (e.g. "api_env.OPENAI_API_KEY"); the first string found wins.
  for (const candidate of field.split('|')) {
    let value: unknown = root;
    for (const part of candidate.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
    if (typeof value === 'string' && value) return value;
  }
  throw new Error(`the application secret has no ${field}`);
}

/** The stub reasoning probe's answer: a plain model reply with no reasoning (the dry run bills nothing). */
export function stubConverseProbeInner(): ConverseSend {
  return async (input) => ({
    output: { message: { role: 'assistant', content: [{ text: '8' }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(input)) / 4), outputTokens: 1, totalTokens: 0 },
    metrics: { latencyMs: 1 },
    $metadata: {},
  }) as ConverseCommandOutput;
}
