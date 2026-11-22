/**
 * Run a command with the repository's private environment loaded.
 *
 *   node scripts/run-with-env.mjs <command> [args...]
 *
 * The root .env is read as data (process.loadEnvFile), never as shell source,
 * so a value can hold any character without being executed. A variable the
 * caller already exported wins over the same name in .env. The file is found
 * beside this script's folder, so the command works from any directory.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Provide a command to run.');
const child = spawn(command, args, { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  // The command and the error code only (ENOENT, EACCES, ...): never an
  // environment value, which may be a secret.
  console.error(`${command} could not start: ${error.code ?? error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
});
