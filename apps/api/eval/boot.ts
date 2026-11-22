import 'reflect-metadata';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DEFAULT_EVAL_CALL_TIMEOUT_MS } from './contracts';

/**
 * Process setup shared by every harness entry point, imported first:
 * - `@learnsdlc/shared` is read from source, as the specs read it (the same
 *   resolver hook as test/cli/ai-request-digests.ts), so the harness needs no
 *   build of the shared package;
 * - Nest's logger is silenced, so stdout carries only the harness's own
 *   aliases, counts and dollars;
 * - the per-call settings the evaluation fixes are set before any product
 *   module reads them: one completion in flight per provider instance, and a
 *   per-call timeout (EVAL_CALL_TIMEOUT_MS, default 120 s) long enough to
 *   measure answer quality apart from hosting speed (latency is recorded per
 *   call, so the product's own timeout can be reported against);
 * - the reference arm's key and endpoint are never taken from the shell: the
 *   harness sets them itself (arms.ts), and an AWS profile is always named.
 */
const SHARED_SOURCE = path.resolve(__dirname, '..', '..', '..', 'packages', 'shared', 'src', 'index.ts');
const Module = require('module') as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolve = Module._resolveFilename;
Module._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
  return resolve.call(this, request === '@learnsdlc/shared' ? SHARED_SOURCE : request, ...rest);
};

process.env.AI_MAX_CONCURRENCY = '1';
process.env.OPENAI_TIMEOUT_MS = process.env.EVAL_CALL_TIMEOUT_MS || String(DEFAULT_EVAL_CALL_TIMEOUT_MS);
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
process.env.AWS_PROFILE = process.env.AWS_PROFILE || 'default';

Logger.overrideLogger(false);
