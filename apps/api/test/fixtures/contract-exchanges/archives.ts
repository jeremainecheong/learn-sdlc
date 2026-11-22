import { entriesOf, writeZip } from '../upload-packs/archive';
import { HOSTILE_BY_NAME } from '../upload-packs/hostile';
import { SHELF_DIR } from '../upload-packs/markers';

/**
 * The archives the upload recording was made with, by the
 * name the recording holds them under (`<archive:NAME>`).
 *
 * The recording never holds an archive's bytes. The API spec
 * (`upload-contract-wiring.e2e-spec.ts`) uploads these, and the web test
 * (`apps/web/test/upload-wiring.test.tsx`) builds the same ones here, hands
 * them to the page as the chosen file, and checks the page sent exactly these
 * bytes. Every archive comes from the upload-pack fixtures (`../upload-packs/`),
 * built in memory.
 */
export const CONTRACT_UPLOAD_ARCHIVES: Record<string, () => Buffer> = {
  /** Hostile set: a runtime outside the baked allow-lists (refused by the profile's sentence). */
  'fix2:runtime-outside-allow-lists': () => HOSTILE_BY_NAME.get('runtime-outside-allow-lists')!.build(),
  /** Hostile set: a run that asks for more time than a learner's run gets (a run-shape refusal with findings). */
  'fix2:run-timeout-above-limit': () => HOSTILE_BY_NAME.get('run-timeout-above-limit')!.build(),
  /** Hostile set: an entry that climbs out of the archive. */
  'fix2:path-traversal': () => HOSTILE_BY_NAME.get('path-traversal')!.build(),
  /** The Shelf pack with a manifest version the loader rejects: NOT_A_PACK with a detail. */
  'fix1:manifest-version-invalid': () =>
    writeZip(
      entriesOf(SHELF_DIR).map((entry) =>
        entry.name === 'project.json'
          ? { ...entry, data: Buffer.from(entry.data.toString('utf-8').replace('"version": "1.0.0"', '"version": "one"'), 'utf-8') }
          : entry,
      ),
    ),
  /** The Shelf pack as it is. */
  fix1: () => writeZip(entriesOf(SHELF_DIR)),
};
