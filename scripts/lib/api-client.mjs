// The JSON API calls the Node scripts make, named once.
//
// Every script talks to the LearnSDLC API the same way: a JSON body, an
// optional bearer token, and a JSON answer that may be empty. Each script
// keeps its own wording for a refusal (its logs and receipts are read by
// that wording), so the shared part is the request itself and the waits
// around it.

/**
 * One request. Never throws on an HTTP status, only when the API cannot be
 * reached. A body that is not JSON (or no body at all) reads as `{}`.
 * @returns {Promise<{ status: number, ok: boolean, data: any }>}
 */
export async function request(api, method, route, { token, body } = {}) {
  const res = await fetch(api + route, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

/** A route with its ids replaced by `:id`, so a refusal reads the same on every run. */
export const routeWithoutIds = (route) => route.replace(/[0-9a-f-]{36}/g, ':id');

/**
 * One request that must succeed: answers the data, or throws with the
 * method, the route without its ids, the status and the API's own sentence.
 */
export async function mustOk(api, method, route, options) {
  const res = await request(api, method, route, options);
  if (!res.ok) {
    throw new Error(`${method} ${routeWithoutIds(route)} answered ${res.status}: ${String(res.data?.message ?? JSON.stringify(res.data)).slice(0, 240)}`);
  }
  return res.data;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call `fn` until `done(value)` holds or the tries run out, waiting `everyMs`
 * between tries. Answers the last value either way; the caller decides what
 * a value that never got there means.
 */
export async function poll(fn, done, { tries = 240, everyMs = 500 } = {}) {
  let value;
  for (let i = 0; i < tries; i++) {
    value = await fn();
    if (done(value)) return value;
    await sleep(everyMs);
  }
  return value;
}
