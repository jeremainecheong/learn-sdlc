import * as path from 'path';
import { config } from '../config';
import { ContentService } from './content.service';
import type { ProjectContent } from './content.types';
import { DirectoryPackSource } from './pack-source';
import { referencePacks } from './reference-content';

/**
 * The reference pack on this deployment's disk, loaded once and lazily for the
 * readers that derive a fact from the reference's own bytes at run time: the
 * provenance resolver's executable keys and the plain-text twins of the AI
 * scope's anchors (`assistant/project-scope.ts`), so the process loads it once
 * for both.
 *
 * Answers `null` while it has not been read: never tried, or the last try
 * failed (no pack on this disk yet), in which case it is tried again at most
 * once a minute, so one transient read error never pins the fallback for the
 * life of the process. Once read it answers `{ project }`, the project or
 * `null` where the scenario table names no reference pack.
 *
 * Nothing in `content.service`'s import closure imports this module.
 */
let held: { project: ProjectContent | null } | null = null;
let triedAt = 0;

/** How long a failed read is kept before the pack is read again. */
const REFERENCE_PACK_RETRY_MS = 60_000;

export function referencePackOnDisk(): { project: ProjectContent | null } | null {
  if (held || Date.now() - triedAt <= REFERENCE_PACK_RETRY_MS) return held;
  triedAt = Date.now();
  try {
    const [slug] = referencePacks();
    held = { project: slug ? new ContentService().loadProject(new DirectoryPackSource(path.join(config.contentDir, slug))) : null };
  } catch {
    // no pack on this disk yet, or one that does not load: the readers keep
    // what they were handed, and the read is tried again after the retry span
  }
  return held;
}
