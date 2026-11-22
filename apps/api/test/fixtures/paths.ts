import * as path from 'path';

/**
 * Where the API's test fixtures live. The folders are described in
 * `README.md` beside this file.
 */

/** This folder: the recorded digests and contract recordings sit at its top level. */
export const FIXTURES_DIR = __dirname;

/** The packs a teacher would upload, one folder each (`shelf`, `starter`, ...). */
export const UPLOAD_PACKS_DIR = path.join(__dirname, 'upload-packs');

/** The older Shelf pack, frozen byte for byte. */
export const OLDER_SHELF_DIR = path.join(__dirname, 'older-shelf');

/** The older TaskTrackr pack, frozen byte for byte. */
export const OLDER_TASKTRACKR_DIR = path.join(__dirname, 'older-tasktrackr');

/** One upload pack's folder, by name. */
export const uploadPack = (name: string): string => path.join(UPLOAD_PACKS_DIR, name);
