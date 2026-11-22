/**
 * The rail's Preview and Export of one version, as this browser remembers them.
 *
 * One marker per version and per step, `lsdlc_guide_<previewed|exported>:<versionId>`
 * = '1', kept in the browser's localStorage, so a new tab or a restart of the
 * same browser still reads Done.
 * It is still this browser's own: another browser, or another browser
 * profile, reads 'Not yet', and nothing is stored on the server. Another
 * version's marker never counts.
 *
 * Who writes it:
 * - previewed: the learner preview page, once the preview has loaded without a
 *   refusal (never the click on the editor's Preview link, so a preview the
 *   page then refuses stays 'Not yet', and a preview opened in a new tab or by
 *   a middle click is marked when it loads);
 * - exported: the editor, once the browser took the archive (ExportButton's onSaved).
 *
 * A storage that is missing, full or refused reads as never written, so the
 * step stays 'Not yet', and a write never throws.
 */
import { readStoredValue, dottedGuideMarkKey, guideMarkKey, type GuideMark } from '@/lib/storage-keys';

export { guideMarkKey, type GuideMark };

export function readGuideMark(mark: GuideMark, versionId: string): boolean {
  try {
    return readStoredValue(window.localStorage, guideMarkKey(mark, versionId), dottedGuideMarkKey(mark, versionId)) === '1';
  } catch {
    return false;
  }
}

export function writeGuideMark(mark: GuideMark, versionId: string): void {
  try {
    window.localStorage.setItem(guideMarkKey(mark, versionId), '1');
  } catch {
    // Storage refused: the step stays 'Not yet'.
  }
}
