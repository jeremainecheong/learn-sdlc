import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import * as net from 'net';
import * as path from 'path';
import type { ConverseCommandInput, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import type { ConverseSend } from '../provider/converse';
import { explanationEvidence } from '../../src/assistant/explanation-assessment';
import { unitStore } from '../capture';
import type { CorpusCase } from '../contracts';
import { repoRoot } from '../io';

/**
 * The dry run (`--stub`): every provider is routed to the loopback stub
 * `e2e/ai-stub.cjs`, started on a free port. Nothing leaves the machine and
 * nothing is billed.
 *
 * - The reference arm (OpenAiProvider) points `config.openaiBaseUrl` at it.
 * - Every Bedrock arm keeps the harness's BedrockProvider and its Converse
 *   mapping; only the send is swapped for a translator: Converse → the stub's
 *   chat-completions shape (system blocks → a system message, the
 *   RESPONSE_SCHEMA block → `response_format.json_schema`) → back to a Converse
 *   output with byte-estimated usage.
 * - The call kinds the stub refuses (Agentic classify/generate, the
 *   explanation assessment, the judges) are answered by a replay built from
 *   the case's own reference, so the whole pipeline runs end to end.
 */

export const STUB_KEY = 'e2e-stub-not-a-secret';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export async function startStub(): Promise<{ port: number; child: ChildProcess; stop: () => void }> {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(repoRoot(), 'e2e', 'ai-stub.cjs')], {
    env: { PATH: '/usr/bin:/bin', PW_AI_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 100; i += 1) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (up) return { port, child, stop: () => child.kill() };
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error('the loopback stub did not start');
}

/** Converse input → the OpenAI-shaped request the stub reads (dry runs only). */
function chatRequestOf(input: ConverseCommandInput): { model: string; messages: Array<{ role: string; content: string }>; response_format?: unknown } {
  const systemBlocks = (input.system ?? []).map((b) => (b as { text?: string }).text ?? '');
  let responseFormat: unknown;
  const kept: string[] = [];
  for (const text of systemBlocks) {
    const m = /<<<RESPONSE_SCHEMA name=([^\n]+)\n([\s\S]*)\nRESPONSE_SCHEMA>>>/.exec(text);
    if (m) { responseFormat = { type: 'json_schema', json_schema: { name: m[1], schema: JSON.parse(m[2]), strict: true } }; continue; }
    if (/^Respond with exactly one JSON object/.test(text)) { responseFormat = responseFormat ?? { type: 'json_object' }; continue; }
    kept.push(text);
  }
  const messages = [
    ...(kept.length ? [{ role: 'system', content: kept.join('\n') }] : []),
    ...(input.messages ?? []).map((m) => ({ role: String(m.role), content: (m.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('\n') })),
  ];
  return { model: String(input.modelId), messages, ...(responseFormat ? { response_format: responseFormat } : {}) };
}

export function stubConverseInner(port: number): ConverseSend {
  return async (input, abortSignal): Promise<ConverseCommandOutput> => {
    const request = chatRequestOf(input);
    const body = JSON.stringify(request);
    const response = await fetchRaw(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${STUB_KEY}` }, body, signal: abortSignal,
    });
    const text = await response.text();
    let content: string | null = null;
    if (response.ok) content = (JSON.parse(text) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content;
    else if (response.status === 400) {
      const ctx = unitStore.getStore();
      content = ctx?.replay && ctx.current ? ctx.replay(ctx.current.label, request) : null;
    }
    if (content === null) throw Object.assign(new Error('stub refused'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } });
    return {
      output: { message: { role: 'assistant', content: [{ text: content }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(input)) / 4), outputTokens: Math.ceil(content.length / 4), totalTokens: 0 },
      metrics: { latencyMs: 1 },
      $metadata: {},
    } as ConverseCommandOutput;
  };
}

/** The process's original fetch (the eval installs a wrapper over the global one). */
let originalFetch: typeof fetch = globalThis.fetch;
export const setOriginalFetch = (f: typeof fetch): void => { originalFetch = f; };
const fetchRaw = (url: string, init: RequestInit) => originalFetch(url, init);

/* -------------------------------- replays -------------------------------- */

const firstEditable = (c: CorpusCase): [string, string] | null => {
  const ws = (c.input.workspace ?? c.input.data?.savedWorkspace ?? {}) as Record<string, string>;
  const key = (c.input.editablePaths as string[] | undefined)?.[0] ?? Object.keys(ws)[0];
  return key ? [key, ws[key] ?? ''] : null;
};

/** A candidate-side replay for the call kinds the stub refuses: built only from the case's reference. */
export function candidateReplay(c: CorpusCase): (label: string, request: unknown) => string | null {
  return (label) => {
    const exp = (c.reference.expected ?? {}) as Record<string, any>;
    if (label === 'agentic.classify') {
      if (c.input.mode === 'chat') {
        const kind = typeof exp.kind === 'string' ? exp.kind.split(/\s+or\s+/)[0] : 'discussion';
        return JSON.stringify({ kind, reply: 'Replayed reply for the dry run.', questions: kind === 'clarification' ? ['Which change do you want proposed?'] : [] });
      }
      const adequate = exp.intentAdequate !== false;
      return JSON.stringify({ adequate, feedback: adequate ? 'Replayed: the request is bounded.' : 'Replayed: one thing is unclear.', questions: adequate ? [] : ['Which behaviour should change?'] });
    }
    if (label === 'agentic.generate') {
      const files = exp.files ?? c.reference.recordedOutput?.files;
      if (files) return JSON.stringify({ files });
      const one = firstEditable(c);
      return one ? JSON.stringify({ files: { [one[0]]: `${one[1]}\n` } }) : JSON.stringify({ files: {} });
    }
    if (label === 'agentic.explanation') {
      const answer = String(c.input.data?.learnerAnswer ?? '');
      const ids = explanationEvidence(answer).map((u) => u.id);
      const adequate = exp.adequate === true;
      const dims = ['effects', 'constraints', 'verification', 'consistency'].map((key) => adequate
        ? { key, met: true, finding: 'supported', learnerEvidenceIds: ids.slice(0, 1) }
        : key === 'consistency' ? { key, met: false, finding: 'unsupported', learnerEvidenceIds: ids.slice(0, 1) } : { key, met: false, finding: 'missing', learnerEvidenceIds: [] });
      return JSON.stringify({ dimensions: dims });
    }
    if (label === 'guided.draft') return 'Which single line of the brief names the behaviour you are least sure about?';
    if (label === 'interview.answer') return 'I mostly need to see which books are out, so ask me about a specific case.';
    return null;
  };
}

/**
 * The judge-side replay: a valid judgement for whatever schema was asked,
 * synthetic but varied by judge model and output (scores 2-4, pairwise A/B/tie)
 * so the dry run exercises the per-judge and inter-judge tables.
 */
export function judgeReplay(): (label: string, request: unknown) => string | null {
  return (_label, request) => {
    const r = request as { model?: string; response_format?: { json_schema?: { name?: string; schema?: { properties?: Record<string, any> } } }; messages?: Array<{ content: string }> };
    const schema = r.response_format?.json_schema;
    if (!schema?.name) return null;
    const seed = createHash('sha256').update(`${r.model ?? ''}|${(r.messages ?? []).map((m) => m.content).join('|')}`).digest();
    if (/pairwise/.test(schema.name)) return JSON.stringify({ winner: (['A', 'B', 'tie'] as const)[seed[0] % 3], justification: 'Replayed judgement for the dry run.' });
    const crit = schema.schema?.properties?.scores?.properties ?? {};
    const scores = Object.fromEntries(Object.keys(crit).map((k, i) => [k, { score: 2 + (seed[(i + 1) % seed.length] % 3), justification: 'Replayed judgement for the dry run.' }]));
    return JSON.stringify({ scores });
  };
}
