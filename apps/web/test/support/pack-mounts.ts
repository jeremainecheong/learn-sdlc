/**
 * A pack phase's mounts as the API's loader derives them from the folder
 * layout (spec 7.1, 7.2): every file under the phase folder's `files/`
 * (editable) and `readonly/` (locked), at the workspace path it sits at, its
 * language read from that path, the whole list in code-unit path order. The
 * web tests that draw a room from a pack on disk (TaskTrackr, the Shelf
 * family) read it here, so they see the files the learner's workspace holds.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { compareMountPaths, languageOfPath } from '@learnsdlc/shared';

export interface PackMount {
  path: string;
  content: string;
  editable: boolean;
  language: string;
}

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, rel = ''): string[] {
  if (!existsSync(path.join(dir, rel))) return [];
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const at = rel ? `${rel}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(dir, at) : [at];
  });
}

/** The mounts of the phase folder `phaseDir`, in the loader's order. */
export function phaseMounts(phaseDir: string): PackMount[] {
  const mounts = (['files', 'readonly'] as const).flatMap((folder) =>
    filesUnder(path.join(phaseDir, folder)).map((at) => ({
      path: at,
      content: readFileSync(path.join(phaseDir, folder, at), 'utf8'),
      editable: folder === 'files',
      language: languageOfPath(at),
    })),
  );
  return mounts.sort((a, b) => compareMountPaths(a.path, b.path));
}
