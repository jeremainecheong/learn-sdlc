import { createHash } from 'crypto';
import { config } from '../../src/config';
import { unitStore } from '../capture';
import { converseRouteActive } from '../provider/bedrock.provider';
import { withThrottleBackoff } from './aws';

/**
 * The reference arm's transport seam. `OpenAiProvider.attempt()` calls the
 * global `fetch`; this wrapper is installed once in the eval process and:
 *
 * - allows exactly one URL, `${config.openaiBaseUrl}/chat/completions` (the
 *   OpenAI API in a real run, the loopback stub in the dry run), and refuses
 *   every other fetch (the AWS SDK does not use fetch);
 * - records the request digest (sha256 + bytes of the body, never the body),
 *   the raw answer, finish reason and usage into the unit's call record;
 * - backs off exponentially on 429 inside the call (the product's own single
 *   retry still sits above it);
 * - reserves the call's worst case against the budget before sending and
 *   settles to actual usage after.
 *
 * The bearer key lives only in `config.openaiApiKey`, in memory, set from
 * Secrets Manager at run time. Nothing here logs a header or a body.
 */

let installed: typeof fetch | null = null;

export function rawFetch(): typeof fetch {
  return installed ?? globalThis.fetch;
}

export function installOpenAiFetch(options: { replayOn400?: boolean } = {}): void {
  if (installed) return;
  const original = globalThis.fetch;
  installed = original;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    // A Bedrock provider's request belongs to its Converse route, which records it itself.
    if (converseRouteActive()) return original(url, init);
    const target = String(url instanceof Request ? url.url : url);
    const allowed = `${config.openaiBaseUrl}/chat/completions`;
    if (target !== allowed) throw new Error('eval fetch refused: only the configured chat-completions URL is reachable from the provider');
    const ctx = unitStore.getStore();
    const record = ctx?.current ?? null;
    const body = String(init?.body ?? '');
    const parsed = (() => { try { return JSON.parse(body) as { max_completion_tokens?: number; max_tokens?: number }; } catch { return {}; } })();
    const maxTokens = parsed.max_completion_tokens ?? parsed.max_tokens ?? 0;
    if (record) {
      record.requestSha256 = createHash('sha256').update(body, 'utf8').digest('hex');
      record.requestBytes = Buffer.byteLength(body, 'utf8');
      record.maxTokensSent = maxTokens || null;
    }
    const reserved = ctx?.budget ? ctx.budget.reserve(Buffer.byteLength(body, 'utf8'), maxTokens) : 0;
    if (record) record.reservedUsd = reserved;
    let started = 0;
    let response: Response;
    try {
      response = await withThrottleBackoff(async () => {
        started = performance.now();
        const r = await original(target, init);
        if (r.status === 429) { await r.text(); throw Object.assign(new Error('throttled'), { status: 429 }); }
        return r;
      }, (err) => (err as { status?: number }).status === 429, init?.signal ?? undefined, (ms) => { if (record) { record.backoffMs += ms; record.throttleRetries += 1; } });
    } catch (err) {
      if ((err as { status?: number }).status === 429) {
        response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      } else {
        // Thrown before an answer (our deadline, a socket reset, DNS): it may
        // have been billed, so it is charged its worst case, in the guard and
        // on the record (the ledger and later runs read the record).
        const cost = ctx?.budget ? ctx.budget.settle(reserved, null, null) : 0;
        if (record) {
          record.costUsd = cost;
          record.latencyMs = started ? Math.round(performance.now() - started) : null;
          record.errorName = typeof (err as { name?: unknown })?.name === 'string' && /^[A-Za-z]{1,64}$/.test((err as { name: string }).name) ? (err as { name: string }).name : null;
          const ours = (err as { name?: string })?.name === 'TimeoutError' || Boolean(init?.signal?.aborted);
          if (!ours) record.outcome = 'transport';
        }
        throw err;
      }
    }
    let text = await response.text();
    if (record) record.latencyMs = Math.round(performance.now() - started);
    // Dry run only: a call kind the canned stub refuses is answered from the case's own reference.
    if (options.replayOn400 && response.status === 400 && ctx?.replay && record) {
      const replay = ctx.replay(record.label, JSON.parse(body));
      if (replay !== null) {
        text = JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: replay }, finish_reason: 'stop' }],
          usage: { prompt_tokens: Math.ceil(Buffer.byteLength(body) / 4), completion_tokens: Math.ceil(replay.length / 4) },
        });
        response = new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    let usageIn: number | null = null;
    let usageOut: number | null = null;
    if (record) {
      record.httpStatus = response.status;
      if (response.ok) {
        try {
          const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
          record.responseText = data.choices?.[0]?.message?.content ?? null;
          record.stopReason = data.choices?.[0]?.finish_reason ?? null;
          usageIn = Number.isSafeInteger(data.usage?.prompt_tokens) ? data.usage!.prompt_tokens! : null;
          usageOut = Number.isSafeInteger(data.usage?.completion_tokens) ? data.usage!.completion_tokens! : null;
          // The stub reports 1/1; estimate from bytes so the dry run's cost path is exercised.
          if (options.replayOn400 && usageIn !== null && usageIn <= 1) { usageIn = Math.ceil(Buffer.byteLength(body) / 4); usageOut = Math.ceil((record.responseText ?? '').length / 4); }
          record.tokensIn = usageIn;
          record.tokensOut = usageOut;
          record.cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? null;
          if (record.stopReason === 'length') record.outcome = 'incomplete';
          else if (record.stopReason === 'content_filter') record.outcome = 'refusal';
        } catch { /* the provider reports an unparsable body itself */ }
      }
    }
    if (record && response.status >= 500) record.outcome = 'server_error';
    if (ctx?.budget) {
      // A 4xx (429 after every backoff included) is refused before inference: not billed.
      const refused = !response.ok && response.status < 500;
      const cost = ctx.budget.settle(reserved, refused ? 0 : usageIn, refused ? 0 : usageOut);
      if (record) record.costUsd = cost;
    }
    return new Response(text, { status: response.status, headers: response.headers });
  }) as typeof fetch;
}
