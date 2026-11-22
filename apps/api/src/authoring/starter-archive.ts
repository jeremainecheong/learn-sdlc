import { createHash } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { STARTER_ARCHIVE_NAMES, type StarterArchiveName } from '@learnsdlc/shared';
import { STARTER_ARCHIVE_RECORDS } from './starter-archive.generated';

/**
 * The two staff downloads, the starter and the
 * shelf example, served from bytes the build carries.
 *
 * The archives are embedded in the API dist through the generated module
 * (`starter-archive.generated.ts`, written by `test/cli/starter-archive.ts`),
 * so the image needs no Dockerfile edit and the upload fixtures still never
 * ship as files (`upload-packs-not-in-runtime.spec.ts`). The starter is
 * example content on purpose, and only staff can download it.
 *
 * Both archives carry example hidden tests and solutions. A learner who could
 * download one would read the hidden suite of any class that used it
 * unchanged, so the route that serves them (`GET
 * /instructor/starter/:name`) is staff-only, and every download leaves one
 * audit row, for `solution.read`'s and `project.quiz-key`'s reason: who has
 * read sealed material is on the record. This helper does not write the row;
 * it calls `audit` once, after the name is known and the bytes are checked,
 * and hands the bytes over only when that call has settled. A failed audit
 * write therefore serves nothing.
 *
 * Pure apart from that hook: no database, no file read, no clock.
 */

/** What the route sends: the bytes, the name to save them as, and their digest. */
export interface StarterArchive {
  bytes: Buffer;
  filename: string;
  sha256: string;
}

/** What the audit row may say about one download: never a byte of the archive. */
export interface StarterArchiveDownload {
  name: StarterArchiveName;
  filename: string;
  size: number;
  sha256: string;
}

/**
 * Writes the one audit row a download leaves (the authoring service supplies it, with the
 * caller in its closure). Awaited before the bytes are handed over; a throw
 * is the route's failure, and no archive leaves.
 */
export type StarterArchiveAudit = (download: StarterArchiveDownload) => void | Promise<void>;

/** The sentence a name outside the list gets. It never repeats what was asked for. */
export const STARTER_ARCHIVE_NOT_FOUND = 'There is no download by that name. The guide offers the starter and the shelf example.';

export function isStarterArchiveName(value: unknown): value is StarterArchiveName {
  return typeof value === 'string' && (STARTER_ARCHIVE_NAMES as readonly string[]).includes(value);
}

/** Decoded once per process and checked against the recorded digest; callers get copies. */
const decoded = new Map<StarterArchiveName, Buffer>();

function bytesOf(name: StarterArchiveName): Buffer {
  let held = decoded.get(name);
  if (!held) {
    const record = STARTER_ARCHIVE_RECORDS[name];
    held = Buffer.from(record.base64, 'base64');
    const digest = createHash('sha256').update(held).digest('hex');
    if (held.length !== record.size || digest !== record.sha256) {
      // The build carries a module the generator did not write: refuse to serve it.
      throw new Error(`starter archive "${name}" does not match its recorded digest`);
    }
    decoded.set(name, held);
  }
  return held;
}

/**
 * One staff download. `name` is the route's raw parameter: anything but
 * `starter` or `shelf` is a 404 that names nothing, before the audit is called.
 */
export async function starterArchive(name: string, audit: StarterArchiveAudit): Promise<StarterArchive> {
  if (!isStarterArchiveName(name)) throw new NotFoundException(STARTER_ARCHIVE_NOT_FOUND);
  const record = STARTER_ARCHIVE_RECORDS[name];
  const held = bytesOf(name);
  await audit({ name, filename: record.filename, size: record.size, sha256: record.sha256 });
  return { bytes: Buffer.from(held), filename: record.filename, sha256: record.sha256 };
}
