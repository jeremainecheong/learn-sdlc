// The local addresses the Node scripts default to, named once. Each script
// still takes API_URL (or its own --api) first; these are only the fallbacks.
//
// The native demo (npm run demo) answers on 4000. The local Compose stack
// (scripts/stack.sh) answers on STACK_API_PORT and STACK_WEB_PORT, 4080 and
// 3080 unless they were chosen before its first start; stack.sh and
// prove-local.sh export the ones the stack was started with, and stack.sh
// keeps them in .env.verify at the repository root, which a script run by
// hand reads when its environment names no port.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The local stack's settings file, which stack.sh writes on its first start. */
export const STACK_ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.verify');

/** A stack port: the environment's, else the one .env.verify keeps, else the default. */
export function stackPort(name, fallback, env = process.env, file = STACK_ENV_FILE) {
  if (env[name]) return env[name];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  let value = '';
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && match[1] === name) value = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return value || fallback;
}

export const NATIVE_API_URL = 'http://localhost:4000/api/v1';

export const STACK_API_URL = `http://localhost:${stackPort('STACK_API_PORT', '4080')}/api/v1`;

export const STACK_WEB_URL = `http://localhost:${stackPort('STACK_WEB_PORT', '3080')}`;
