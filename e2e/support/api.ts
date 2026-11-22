import { expect, request as pwRequest, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API } from './env';

/** Every UUID in a route, so a failure message names the route and not one run's ids. */
const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** `route` with each id written as `:id`. */
export function routeName(route: string): string {
  return route.replace(IDS, ':id');
}

/**
 * A response that must be a success: fails the test with the method, the
 * route and the status, and returns the body parsed as JSON (null when the
 * body is empty). Callers read the fields they need from it.
 */
export async function okBody(res: APIResponse, method: string, route: string): Promise<any> {
  expect(res.ok(), `${method} ${routeName(route)} -> ${res.status()}`).toBeTruthy();
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** One API call that must succeed, through `api`, against the suite's API. */
export async function apiOk(
  api: APIRequestContext,
  method: string,
  route: string,
  headers: Record<string, string>,
  data?: unknown,
): Promise<any> {
  return okBody(await api.fetch(`${API}${route}`, { method, headers, data }), method, route);
}

/**
 * A request context for the whole file: made before the file's first test and
 * disposed of after its last. Returns a getter, because the context exists only
 * once the hook has run.
 */
export function useApiContext(): () => APIRequestContext {
  let api: APIRequestContext | undefined;
  test.beforeAll(async () => {
    api = await pwRequest.newContext();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });
  return () => {
    if (!api) throw new Error('the API request context is made in beforeAll and is not ready yet');
    return api;
  };
}
