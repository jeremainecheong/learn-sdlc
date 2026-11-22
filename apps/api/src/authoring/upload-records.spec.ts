import { CHANGE_REQUEST_JSON, RUNBOOK_JSON } from '@learnsdlc/shared';
import { ContentService, type LoadProjectOptions } from '../content/content.service';
import type { CodeChecks, ConfigChecks } from '../content/content.types';
import { layoutFromManifest } from '../content/legacy-layout';
import type { PackSource } from '../content/pack-source';
import { olderTaskTrackrPack } from '../../test/legacy-phase';

const DOOR = { convertLegacyRequirements: true, convertLegacyDesign: true, convertLegacyRunbook: true, convertLegacyChange: true };

/**
 * An older pack loaded as the upload door loads it: converted once to the
 * folder layout (`layoutFromManifest`), then read by the loader, which reads
 * only the folder layout. The older Deployment and Maintenance stay older
 * inside the converted pack, so the loader's own conversions still apply.
 */
const loadOlder = (pack: PackSource, options?: LoadProjectOptions) =>
  new ContentService().loadProject(layoutFromManifest(pack).source, options);

describe('the door converts an older Deployment and Maintenance', () => {
  const project = loadOlder(olderTaskTrackrPack(), DOOR);
  const deployment = project.phases.find((p) => p.key === 'deployment')!;
  const maintenance = project.phases.find((p) => p.key === 'maintenance')!;
  it('reads a runbook, no markdown, the brief inline', () => {
    expect((deployment.checks as ConfigChecks).runbook?.record).toBe(RUNBOOK_JSON);
    expect(deployment.files.some((f) => f.path.endsWith('.md'))).toBe(false);
    expect(deployment.taskPanel).toContain('INCIDENT-1');
  });
  it('reads the ticket and the change request, no CHANGELOG.md', () => {
    expect((maintenance.checks as CodeChecks).ticket?.id).toBe('CR-2');
    expect(maintenance.files.some((f) => f.path === CHANGE_REQUEST_JSON)).toBe(true);
    expect(maintenance.files.some((f) => f.path === 'CHANGELOG.md')).toBe(false);
  });
  it('refuses an older Deployment that mounts another markdown file, by name', () => {
    const extra = olderTaskTrackrPack((name, text) => (name === 'phases/05-deployment/phase.json'
      ? JSON.stringify({ ...JSON.parse(text), files: [...JSON.parse(text).files, { path: 'docs/ops.md', source: 'task.md', editable: false, language: 'markdown' }] })
      : text));
    expect(() => loadOlder(extra, DOOR)).toThrow('A Deployment phase mounts no markdown file: docs/ops.md.');
  });
  it('refuses an older Deployment or Maintenance with no brief, or one that is not text, as every phase is refused', () => {
    for (const folder of ['05-deployment', '06-maintenance']) {
      for (const taskPanel of [undefined, { words: 'not text' }]) {
        const briefless = olderTaskTrackrPack((name, text) => {
          if (name !== `phases/${folder}/phase.json`) return text;
          const { taskFile: _file, ...phase } = JSON.parse(text);
          return JSON.stringify(taskPanel === undefined ? phase : { ...phase, taskPanel });
        });
        // the converted phase has no taskFile to fall back on, so the folder loader names taskPanel alone
        expect(() => loadOlder(briefless, DOOR)).toThrow('phase needs taskPanel');
      }
    }
  });
  it('leaves loadProject without the flags: an older Deployment loads as it is', () => {
    expect((loadOlder(olderTaskTrackrPack()).phases.find((p) => p.key === 'deployment')!.checks as ConfigChecks).runbook).toBeUndefined();
  });
});
