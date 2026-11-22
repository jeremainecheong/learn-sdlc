// The documented default for IMPORT_MAX_BYTES, shared with the web
// panel so both halves of the warning quote the same number.
import { COHORT_IMPORT_MAX_BYTES } from '@learnsdlc/shared';
import { byteSize } from './parse';

/**
 * The most a class import may carry, in bytes.
 *
 * A class travels as one JSON document, and a class is bigger than a workspace
 * PUT: the global 4 MB body limit is the right ceiling for every other route
 * and far too small for this one. It is a number rather than a string because
 * three places have to agree on it: the body parser, the sentence the route
 * says when a file is over it, and the panel that warns before the file is
 * even chosen.
 *
 * Raising it costs memory rather than disk: express buffers the whole body and
 * JSON.parse allocates roughly twice the text again, so 32 MB is about a
 * 100 MB spike in the API process. Runbook §7c says to raise the api service's
 * mem_limit with it. The default is generous (a snapshot-free export of a
 * fifty-learner class measures in single-digit megabytes) precisely so that
 * nobody needs to raise it.
 */
export function resolveImportMaxBytes(env = process.env): number {
  return byteSize(env.IMPORT_MAX_BYTES) ?? COHORT_IMPORT_MAX_BYTES;
}
