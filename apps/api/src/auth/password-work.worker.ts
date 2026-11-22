import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { PASSWORD_BCRYPT_ROUNDS, PASSWORD_INPUT_BYTES, PasswordReply, PasswordRequest } from './password-work.protocol';

// bcrypt is resolved by the trusted parent. No application module, credential,
// database connection, environment or logging facility enters this worker.
if (isMainThread || !parentPort || typeof workerData?.bcryptModule !== 'string') {
  throw new Error('Password worker must be started by its pool');
}
const port = parentPort;
const bcrypt = require(workerData.bcryptModule) as typeof import('bcryptjs');
function send(message: PasswordReply): void { port.postMessage(message); }
function valid(request: unknown): request is PasswordRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
  const value = request as Record<string, unknown>;
  if (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) ||
      typeof value.password !== 'string' || Buffer.byteLength(value.password) > PASSWORD_INPUT_BYTES) return false;
  if (value.type === 'hash') return Object.keys(value).length === 3;
  return value.type === 'compare' && Object.keys(value).length === 4 &&
    typeof value.encoded === 'string' && Buffer.byteLength(value.encoded) <= PASSWORD_INPUT_BYTES;
}

port.on('message', (request: unknown) => {
  if (!valid(request)) {
    // A malformed trusted-parent message is a protocol failure. Never echo it.
    port.close();
    return;
  }
  try {
    // Synchronous bcrypt is intentional inside this dedicated worker. It never
    // blocks the API event loop, and the parent permits one job per worker.
    const value = request.type === 'hash'
      ? bcrypt.hashSync(request.password, PASSWORD_BCRYPT_ROUNDS)
      : bcrypt.compareSync(request.password, request.encoded);
    send({ type: 'result', id: request.id, value });
  } catch {
    send({ type: 'failed', id: request.id });
  }
});
send({ type: 'ready' });
