import type { Server } from 'http';
import request from 'supertest';

/**
 * Small HTTP helpers the end-to-end specs share. Each spec boots the real
 * application and talks to it through supertest; these helpers only shorten
 * what every spec would otherwise write out by hand.
 */

/** The booted app's HTTP server, which supertest takes as its target. */
export type HttpTarget = Server;

/** The `Authorization` header for a signed-in caller. */
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * The body of `GET /api/v1/submissions/:id` once grading has finished. Only
 * the fields every caller reads are named; a spec reads the rest of the
 * verdict as it needs it.
 */
export interface SubmissionBody {
  id: string;
  status: 'completed' | 'failed';
  passed: boolean;
  // The verdict carries many more fields, and each spec reads its own.
  [field: string]: any;
}

export interface PollLimits {
  /** How many times to read the submission before giving up. */
  attempts: number;
  /** The pause between two reads, in milliseconds. */
  intervalMs: number;
  /** The error thrown when the submission is still grading after the last read. */
  message?: string;
}

/**
 * Read a submission until grading finishes (`completed` or `failed`) and
 * return its body. Every read must answer 200. Each spec passes its own
 * limits, because how long grading takes depends on what the spec hands in.
 * `headers` may be a function, called once per read, for a spec that sends
 * each request from its own address.
 */
export async function waitForSubmission(
  http: HttpTarget,
  headers: Record<string, string> | (() => Record<string, string>),
  submissionId: string,
  { attempts, intervalMs, message = 'submission did not finish' }: PollLimits,
): Promise<SubmissionBody> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const read = await request(http)
      .get(`/api/v1/submissions/${submissionId}`)
      .set(typeof headers === 'function' ? headers() : headers)
      .expect(200);
    if (read.body.status === 'completed' || read.body.status === 'failed') return read.body as SubmissionBody;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}
