// @vitest-environment node
/**
 * The authoring client, checked against the route table rather than against a
 * second copy of it.
 *
 * `AUTHORING_ROUTES` is the contract's own list of doors, methods and paths.
 * A client that retypes those strings is a second copy of a closed
 * set, and the first rename it misses is a 404 a teacher meets. So the client
 * builds every path **from** the table, and this suite walks the table's own
 * keys: every key is called, and every call has to produce the method and the
 * path the table declares. A route added to the contract and not to the client
 * fails here rather than in a teacher's browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHORING_ROUTES, AUTHORING_ROUTE_KEYS, type AuthoringRouteKey } from '@learnsdlc/shared';
// The sign-off table's own doors.
import { SIGNOFF_ROUTES, SIGNOFF_ROUTE_KEYS, type SignoffRouteKey } from '@learnsdlc/shared';

const request = vi.fn((..._args: unknown[]) => Promise.resolve(undefined as never));
vi.mock('@/lib/api', () => ({
  request: (...args: unknown[]) => request(...args),
  describeError: (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback),
  // The export answers bytes, so it is fetched as a
  // blob with the same token rather than parsed by `request`.
  API_URL: 'http://api.test',
  API_BASE: 'http://api.test/api/v1',
  getToken: () => 'token-1',
  ApiError: class ApiError extends Error {},
  // The export keeps lib/api's request deadline.
  REQUEST_TIMEOUT_MS: 20_000,
}));

import { authoringPath, projectsApi } from '@/lib/api-projects';
// The sign-off client.
import { signoffApi, signoffPath } from '@/lib/api-projects';

/**
 * The doors whose request does not go through `request`
 * whole. `sealed.read` is a GET whose query names the file (a GET has no
 * body), and `version.export` answers an archive, not JSON. Each is still
 * held to the table's method and path; the query is checked on its own.
 */
const fetchSpy = vi.fn((..._args: unknown[]) =>
  // The export answers application/zip and its withheld count.
  Promise.resolve({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/zip', 'x-export-withheld': '0' }), blob: () => Promise.resolve(new Blob(['zip'])) } as unknown as Response),
);
vi.stubGlobal('fetch', (...args: unknown[]) => fetchSpy(...args));

afterEach(() => {
  request.mockClear();
  fetchSpy.mockClear();
});

/** The ids every path in the table needs, and nothing it does not. */
const IDS = {
  projectId: 'p-1',
  versionId: 'v-1',
  phaseKey: 'requirements',
  taskKey: 'late-marker',
  cohortId: 'c-1',
};

/** One call per route key. The table decides what each one must produce. */
const CALLS: Record<AuthoringRouteKey, () => unknown> = {
  'projects.list': () => projectsApi.list(),
  'projects.create': () => projectsApi.create({ title: 'T', slug: 'my-course', fromVersionId: 'v-0' }),
  'projects.get': () => projectsApi.get(IDS.projectId),
  'projects.updateMeta': () => projectsApi.updateMeta(IDS.projectId, { title: 'T' }),
  'projects.archive': () => projectsApi.archive(IDS.projectId),
  'version.draft': () => projectsApi.draft(IDS.projectId, IDS.versionId),
  'version.validate': () => projectsApi.validate(IDS.projectId, IDS.versionId),
  'version.publish': () => projectsApi.publish(IDS.projectId, IDS.versionId, { version: '1.0.0' }),
  'tasks.list': () => projectsApi.tasks(IDS.projectId, IDS.versionId, 'requirements'),
  'tasks.add': () =>
    projectsApi.addTask(IDS.projectId, IDS.versionId, 'requirements', {
      taskKey: 'late-marker',
      title: 'T',
      brief: 'B',
      artefactType: 'quiz',
    }),
  'tasks.update': () =>
    projectsApi.updateTask(IDS.projectId, IDS.versionId, 'requirements', IDS.taskKey, { title: 'T' }),
  'tasks.setRequired': () =>
    projectsApi.setTaskRequired(IDS.projectId, IDS.versionId, 'requirements', IDS.taskKey, false),
  'tasks.reorder': () =>
    projectsApi.reorderTasks(IDS.projectId, IDS.versionId, 'requirements', ['late-marker']),
  'tasks.remove': () =>
    projectsApi.removeTask(IDS.projectId, IDS.versionId, 'requirements', IDS.taskKey),
  'tasks.quizKey': () =>
    projectsApi.readQuizKey(IDS.projectId, IDS.versionId, 'requirements', IDS.taskKey),
  'files.list': () => projectsApi.files(IDS.projectId, IDS.versionId),
  'assignment.assignable': () => projectsApi.assignable(IDS.cohortId),
  'assignment.read': () => projectsApi.assignment(IDS.cohortId),
  'assignment.assign': () =>
    projectsApi.assign(IDS.cohortId, { projectVersionId: 'v-1', reason: 'The class moves on.' }),
  'versions.createDraft': () =>
    projectsApi.createDraft(IDS.projectId, { fromVersionId: 'v-head' }),
  // The copy becomes the teacher's own.
  'phases.update': () =>
    projectsApi.updatePhase(IDS.projectId, IDS.versionId, 'requirements', { intro: 'A room booking desk.' }),
  'interview.replace': () =>
    projectsApi.putInterview(IDS.projectId, IDS.versionId, {
      persona: { name: 'Priya Nair', role: 'Facilities manager' },
      opening: 'Ask me about the rooms.',
      unknownReply: 'I do not know that one.',
      refusal: 'That is for you to write.',
      maxTurns: 10,
      factsExpected: 1,
      facts: [{ id: 'f1', topic: 'Who books', keywords: ['book'], answer: 'Staff book rooms.' }],
    }),
  'interview.remove': () => projectsApi.removeInterview(IDS.projectId, IDS.versionId),
  // The Phases card's three doors.
  'phases.remove': () => projectsApi.removePhase(IDS.projectId, IDS.versionId, 'requirements'),
  'phases.restore': () => projectsApi.restorePhase(IDS.projectId, IDS.versionId, 'requirements'),
  'phases.add': () => projectsApi.addPhase(IDS.projectId, IDS.versionId, 'requirements'),
  'interview.read': () => projectsApi.readInterview(IDS.projectId, IDS.versionId),
  'files.replace': () =>
    projectsApi.replaceFile(IDS.projectId, IDS.versionId, 'requirements', {
      path: 'requirements/draft.md',
      content: '# Stories\n',
    }),
  // The upload door, the profile, the seal, deep validation.
  'projects.upload': () => projectsApi.upload({ title: 'Books on a shelf', archiveBase64: 'UEsDBA==' }),
  'runtime.profile': () => projectsApi.runtimeProfile(),
  'sealed.write': () =>
    projectsApi.writeSealed(IDS.projectId, IDS.versionId, 'requirements', IDS.taskKey, {
      role: 'hidden',
      runId: 'api',
      path: 'test_hidden.py',
      contentBase64: 'eA==',
    }),
  'sealed.read': () =>
    projectsApi.readSealed(IDS.projectId, IDS.versionId, 'requirements', IDS.taskKey, {
      role: 'hidden',
      path: 'test_hidden.py',
      runId: 'api',
    }),
  // Export.
  'version.export': () => projectsApi.exportVersion(IDS.projectId, IDS.versionId),
  'deepValidation.start': () =>
    projectsApi.startDeepValidation(IDS.projectId, IDS.versionId, { acknowledgedMicroVMs: 7 }),
  'deepValidation.read': () => projectsApi.deepValidation(IDS.projectId, IDS.versionId),
};

/**
 * The method and path one call produced, from `request` or (for the one
 * door answered in bytes) from `fetch`, with the API base taken off.
 */
function sent(): { method: string; path: string } {
  if (request.mock.calls.length > 0) {
    expect(request).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const [method, path] = request.mock.calls[0] as unknown as [string, string];
    return { method, path };
  }
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit | undefined];
  expect(url.startsWith('http://api.test/api/v1/')).toBe(true);
  return { method: init?.method ?? 'GET', path: url.slice('http://api.test/api/v1'.length) };
}

describe('the authoring client', () => {
  it('has a call for every door the contract declares', () => {
    expect(Object.keys(CALLS).sort()).toEqual([...AUTHORING_ROUTE_KEYS].sort());
  });

  for (const key of AUTHORING_ROUTE_KEYS) {
    it(`sends ${key} at the method and path the table declares`, () => {
      CALLS[key]();
      const { method, path } = sent();
      expect(method).toBe(AUTHORING_ROUTES[key].method);
      // The path is compared without its query,
      // because `sealed.read` names its file in one; every other door sends
      // none, which the last line holds.
      const [bare, query] = path.split('?');
      expect(bare).toBe(
        authoringPath(key, IDS as unknown as Record<string, string>),
      );
      // Nothing left unsubstituted, ever.
      expect(path).not.toContain(':');
      if (key !== 'sealed.read') expect(query).toBeUndefined();
    });
  }

  it('names the sealed file to read in the query, and never sends a body on the GET', () => {
    CALLS['sealed.read']();
    const [, path, body] = request.mock.calls[0] as unknown as [string, string, unknown];
    const query = new URLSearchParams(path.split('?')[1]);
    expect(query.get('role')).toBe('hidden');
    expect(query.get('path')).toBe('test_hidden.py');
    expect(query.get('runId')).toBe('api');
    expect(body).toBeUndefined();
  });

  it('sends the sealed write and the upload as JSON bodies, as the contract shapes them', () => {
    CALLS['sealed.write']();
    expect(request.mock.calls[0][2]).toEqual({ role: 'hidden', runId: 'api', path: 'test_hidden.py', contentBase64: 'eA==' });
    request.mockClear();
    CALLS['projects.upload']();
    expect(request.mock.calls[0][2]).toEqual({ title: 'Books on a shelf', archiveBase64: 'UEsDBA==' });
  });

  it('fetches the export with the bearer token, as a blob', async () => {
    await CALLS['version.export']();
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-1');
  });

  it('refuses to build a path it has no id for, rather than sending the placeholder', () => {
    expect(() => authoringPath('tasks.update', { projectId: 'p-1' })).toThrow(/versionId/);
  });

  it('escapes an id rather than letting it open a path of its own', () => {
    expect(authoringPath('projects.get', { projectId: 'a/b' })).toBe('/instructor/projects/a%2Fb');
  });
});

/* The sign-off table, a table of its own. */
const SIGNOFF_CALLS: Record<SignoffRouteKey, () => unknown> = {
  'signoff.queue': () => signoffApi.queue(IDS.cohortId),
  'signoff.bulk': () =>
    signoffApi.bulk(IDS.cohortId, {
      phaseKey: 'deployment',
      taskKey: 'main',
      userIds: ['u-1'],
      reason: 'Runbooks checked in the lab.',
    }),
};

describe('the sign-off client', () => {
  it('has a call for every door of SIGNOFF_ROUTES', () => {
    expect(Object.keys(SIGNOFF_CALLS).sort()).toEqual([...SIGNOFF_ROUTE_KEYS].sort());
  });

  for (const key of SIGNOFF_ROUTE_KEYS) {
    it(`sends ${key} at the method and path the table declares`, () => {
      SIGNOFF_CALLS[key]();
      expect(request).toHaveBeenCalledTimes(1);
      const [method, path] = request.mock.calls[0] as unknown as [string, string];
      expect(method).toBe(SIGNOFF_ROUTES[key].method);
      expect(path).toBe(signoffPath(key, { cohortId: IDS.cohortId }));
      expect(path).not.toContain(':');
    });
  }
});
