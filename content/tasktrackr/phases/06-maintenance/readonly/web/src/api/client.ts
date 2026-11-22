/**
 * The one place the front end knows how to talk to the API.
 *
 * The base path is RELATIVE — "api", with no leading slash — and that is the
 * whole trick that makes one build run in three places. In `npm run dev` and
 * under `docker compose up` the page is served from "/", so "api/lists"
 * resolves to "/api/lists" and web/serve.js proxies it to the API container.
 * In the live preview the page is served under a long capability path with a
 * <base href> in its head, and a relative URL follows that base while an
 * absolute "/api/lists" would escape it. Nothing here branches on which one it
 * is, because nothing here can tell.
 *
 * Set window.__TASKTRACKR_API__ if you ever put the API on another origin.
 * Then you also need CORS, which is exactly the cost the proxy saves you.
 */

import type { ApiErrorBody } from './types';

const DEFAULT_BASE = 'api';

/** The API's base path, without a trailing slash. */
export function apiBase(): string {
  const configured =
    typeof window === 'undefined'
      ? undefined
      : (window as { __TASKTRACKR_API__?: string }).__TASKTRACKR_API__;
  const base = configured && configured.length > 0 ? configured : DEFAULT_BASE;
  return base.replace(/\/+$/, '');
}

/** The API answered, and it said no. `code` is the slug from the contract. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function urlFor(path: string, query?: Record<string, string | undefined>): string {
  const url = `${apiBase()}/${path.replace(/^\/+/, '')}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

async function send<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
  const init: RequestInit = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(urlFor(path, query), init);
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const envelope = parsed as ApiErrorBody | null;
    const code = envelope?.error?.code ?? 'unexpected_error';
    const message =
      envelope?.error?.message ?? `The API answered ${response.status} and said nothing useful.`;
    throw new ApiError(response.status, code, message);
  }
  return parsed as T;
}

export function getJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
  return send<T>('GET', path, undefined, query);
}

export function postJson<T>(path: string, body?: unknown): Promise<T> {
  return send<T>('POST', path, body ?? {});
}

export function patchJson<T>(path: string, body: unknown): Promise<T> {
  return send<T>('PATCH', path, body);
}

export function deleteJson(path: string): Promise<void> {
  return send<void>('DELETE', path);
}
