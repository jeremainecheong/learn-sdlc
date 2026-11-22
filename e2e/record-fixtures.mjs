// The worked Deployment and Maintenance records: TaskTrackr's passing runbook
// and CR-2's passing change request, each serialised as the shared serialisers
// write a record (two-space JSON and a trailing newline).
//
// One module, read by both sides: e2e/fixtures.ts (the Playwright suite) and
// scripts/golden-artefacts.mjs (the journey and the seeded class), as the
// design record is read from e2e/golden-records.ts. Plain ESM with no
// imports, so `node --test` and Playwright load it as it is. The AI stub,
// e2e/ai-stub.cjs, does not import it: the Compose service mounts that file
// alone.
//
// Both records carry E2E-PASS in their notes, the stub assessor's pass mark.
// The runbook's incident is empty on purpose: in a phase with a drill, the
// drill's resolve is its one writer, with PASSING_INCIDENT below
// (scripts/passing-work.mjs closeDrill, e2e/record-forms.ts closeDrillByApi).
// These are test and demo fixtures, not a learner's work.

export const RUNBOOK_RECORD = `${JSON.stringify({
  environment: [
    { id: 'E1', name: 'TASKTRACKR_DB', purpose: 'Where the API keeps its SQLite file; defaults to /data/tasktrackr.db on the tasktrackr-data volume.', kind: 'config', example: '/data/tasktrackr.db' },
    { id: 'E2', name: 'API_URL', purpose: 'Where the web service forwards /api; http://api:8000 inside the compose network, never localhost.', kind: 'config', example: 'http://api:8000' },
    { id: 'E3', name: 'PORT', purpose: 'The port the API listens on; 8000 by default.', kind: 'config' },
    { id: 'E4', name: 'HOST', purpose: 'The address the API binds; 0.0.0.0 in the image so the network can reach it.', kind: 'config' },
  ],
  health: [
    { id: 'H1', name: 'API healthcheck', how: 'docker compose ps (the api service reports healthy)', expected: 'api is up and healthy' },
    { id: 'H2', name: 'Deployment selfcheck', how: 'docker compose exec api python3 api/main.py --selfcheck', expected: 'selfcheck: web reaches api, 13 routes, 5 tables' },
  ],
  rollback: [
    { id: 'R1', step: 'Tag the previous known-good images back to latest: docker tag tasktrackr-api:previous tasktrackr-api:latest, and the same for web.', verify: 'docker image ls shows latest on the previous image ids.' },
    { id: 'R2', step: 'docker compose up -d to restart both services on those images.', verify: 'The selfcheck prints its success line again.' },
    { id: 'R3', step: 'Remember that a rollback does not undo the data: the database volume keeps every write.', verify: 'docker volume ls still lists tasktrackr-data.' },
  ],
  data: [{ id: 'D1', what: 'The database file', how: 'docker compose exec api sqlite3 /data/tasktrackr.db ".backup /data/backup.db", then copy it off the host', where: 'The tasktrackr-data volume; docker compose down -v deletes it.' }],
  incident: { rootCause: '', fix: '', actionItem: '' },
  notes: 'Deploying: docker compose up -d --build builds both images and starts api before web. E2E-PASS',
}, null, 2)}\n`;

export const CHANGE_REQUEST_RECORD = `${JSON.stringify({
  impact: { operations: ['listComments', 'addComment'], screens: ['#/lists/{id}'], files: ['api/repository/comments.py', 'api/routes/comments.py', 'api/repository/tasks.py', 'web/src/components/TaskRow.tsx'] },
  contract: [
    { id: 'C1', method: 'GET', path: '/api/tasks/{id}/comments', change: 'added', why: 'CR-2 reads a task\'s comments, newest first.' },
    { id: 'C2', method: 'POST', path: '/api/tasks/{id}/comments', change: 'added', why: 'CR-2 adds a comment and answers invalid_comment for a blank author or body.' },
  ],
  tests: [
    { id: 'T1', suite: 'tests/test_comments_api.py', covers: ['AC-1', 'AC-2', 'AC-3', 'AC-4'], result: 'pass' },
    { id: 'T2', suite: 'web/src/components/TaskRow.test.tsx', covers: ['AC-5', 'AC-6'], result: 'pass' },
  ],
  release: {
    version: '2.1.0', summary: 'Comments on a task',
    changes: [
      { id: 'L1', line: 'A task takes comments, and lists them newest first.', covers: ['AC-1', 'AC-2', 'AC-3', 'AC-4'] },
      { id: 'L2', line: 'Every task carries comment_count, and the row shows it.', covers: ['AC-5', 'AC-6'] },
      { id: 'L3', line: 'listComments and addComment are published in the API contract.', covers: ['AC-7'] },
    ],
    rollback: 'Redeploy 2.0.0: no schema change is needed, because the comments table was already in the schema.',
  },
  notes: 'E2E-PASS',
}, null, 2)}\n`;

// The write-up that closes the incident drill, each line over the resolve
// route's 20-character floor.
export const PASSING_INCIDENT = {
  rootCause: 'API_URL named localhost, so inside the compose network the proxy dialled its own container.',
  fix: 'API_URL is http://api:8000 in docker-compose.yml, the api service by its own name.',
  actionItem: 'Run the selfcheck against the compose file in CI before every release.',
};
