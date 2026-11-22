#!/usr/bin/env node
// The demo instructor for the local Compose stack (scripts/stack.sh), and a
// look at the reference project the API imported at boot.
//
// The native demo seeds the demo instructor itself (SEED_DEMO_ACCOUNTS), but
// only on a loopback bind; inside a container the API binds 0.0.0.0, so it
// refuses, and that refusal stays. This script makes the same address the way
// an administrator would: it signs up through the API and the stack's own
// generated administrator (.env.verify) gives it the INSTRUCTOR role. Its
// password is STACK_INSTRUCTOR_PASSWORD in .env.verify, generated for this
// machine by scripts/stack.sh, never a published one.
//
// Idempotent: an instructor already there is left alone. Prints no secret:
// the sign-in details are in .env.verify.
//
//   node scripts/stack-seed.mjs        (API_URL defaults to the stack's API, port 4080 unless STACK_API_PORT says otherwise)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { request } from './lib/api-client.mjs';
import { STACK_INSTRUCTOR_PASSWORD_KEY, stackInstructor } from './lib/demo-accounts.mjs';
import { STACK_API_URL } from './lib/endpoints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_URL || STACK_API_URL;
const ENV_FILE = path.join(ROOT, process.env.STACK_ENV_FILE || '.env.verify');

/** KEY=value lines; the generated file has no quoting or comments. */
export function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const call = (method, route, options) => request(API, method, route, options);

const ok = (text) => console.log(`  \x1b[32mok\x1b[0m    ${text}`);

export async function seed() {
  if (!fs.existsSync(ENV_FILE)) throw new Error(`${path.basename(ENV_FILE)} is missing; start the stack with scripts/stack.sh first.`);
  const env = readEnvFile(ENV_FILE);
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) throw new Error(`${path.basename(ENV_FILE)} has no ADMIN_EMAIL / ADMIN_PASSWORD.`);

  const admin = await call('POST', '/auth/login', { body: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } });
  if (!admin.ok) throw new Error(`the stack's administrator could not sign in (HTTP ${admin.status}). Was ${path.basename(ENV_FILE)} replaced after the database was created? bash scripts/stack.sh down --fresh starts clean.`);
  ok('the generated administrator signs in');

  const account = stackInstructor(env);
  const registered = await call('POST', '/auth/register', { body: account });
  if (!registered.ok && registered.status !== 409) {
    throw new Error(`signing up ${account.email} failed (HTTP ${registered.status}): ${JSON.stringify(registered.data).slice(0, 200)}`);
  }
  const found = await call('GET', `/admin/users?email=${encodeURIComponent(account.email)}`, { token: admin.data.token });
  if (!found.ok) throw new Error(`the administrator could not look the instructor up (HTTP ${found.status}).`);
  if (found.data.role !== 'INSTRUCTOR' && found.data.role !== 'ADMIN') {
    const promoted = await call('PATCH', `/admin/users/${found.data.id}`, { token: admin.data.token, body: { role: 'INSTRUCTOR' } });
    if (!promoted.ok) throw new Error(`the instructor role could not be given (HTTP ${promoted.status}).`);
  }
  const instructor = await call('POST', '/auth/login', { body: { email: account.email, password: account.password } });
  if (!instructor.ok) {
    throw new Error(`${account.email} exists here with a password other than ${STACK_INSTRUCTOR_PASSWORD_KEY} in ${path.basename(ENV_FILE)}; sign in with that one, or start clean with bash scripts/stack.sh down --fresh.`);
  }
  ok(`${account.email} is an instructor (password: ${STACK_INSTRUCTOR_PASSWORD_KEY} in ${path.basename(ENV_FILE)})`);

  const projects = await call('GET', '/projects', { token: instructor.data.token });
  const reference = Array.isArray(projects.data) && projects.data.find((p) => p.slug === 'tasktrackr');
  if (!reference) throw new Error('the reference project (TaskTrackr) is not in the catalogue; the API log says why its import failed.');
  ok(`the reference project is imported: ${reference.title ?? reference.slug}`);
  return { instructorToken: instructor.data.token, adminToken: admin.data.token };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seed().catch((error) => {
    console.error(`  \x1b[31mfail\x1b[0m  ${error.message}`);
    process.exit(1);
  });
}
