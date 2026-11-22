import { QUIZ_ONLY_ADD_REFUSAL, retiredWrittenPhaseUploadRefusal } from '@learnsdlc/shared';
import { ContentService, ARTIFACT_KINDS } from './content.service';
import { layoutFromManifest } from './legacy-layout';
import { MemoryPackSource } from './memory-pack-source';
import { entriesOf } from '../../test/fixtures/upload-packs/archive';
import { uploadPack } from '../../test/fixtures/paths';

/**
 * `shelf-task` (a markdown Requirements) re-keyed in memory to `key`, then
 * converted once to the folder layout as the door converts an older archive: the loader reads only that.
 */
function rekeyed(key: string, title: string): MemoryPackSource {
  const dir = uploadPack('shelf-task');
  const entries = entriesOf(dir).map((entry) => {
    if (entry.name !== 'phases/01-requirements/phase.json') return { name: entry.name, bytes: entry.data };
    const spec = JSON.parse(entry.data.toString('utf8'));
    return { name: entry.name, bytes: Buffer.from(JSON.stringify({ ...spec, key, title }, null, 2)) };
  });
  return layoutFromManifest(new MemoryPackSource(entries, 'shelf-task')).source;
}

describe('the markdown kind is gone', () => {
  it('is not a kind the loader knows', () => {
    expect(ARTIFACT_KINDS).toEqual(['story', 'design', 'code', 'tests', 'config', 'quiz']);
  });
  it.each([['implementation', 'Implementation'], ['testing', 'Testing'], ['deployment', 'Deployment'], ['maintenance', 'Maintenance']])('refuses a markdown phase under %s, naming the phase', (key, title) => {
    expect(() => new ContentService().loadProject(rekeyed(key, title), { convertLegacyRequirements: true, convertLegacyDesign: true })).toThrow(retiredWrittenPhaseUploadRefusal(title));
  });
  it('still converts a markdown Requirements at the door', () => {
    const project = new ContentService().loadProject(rekeyed('requirements', 'Requirements'), { convertLegacyRequirements: true, convertLegacyDesign: true });
    expect(project.phases[0].checks.kind).toBe('story');
  });
  it('says the quiz-only sentence', () => {
    expect(QUIZ_ONLY_ADD_REFUSAL).toBe("This phase holds the work it came with. Add a concept quiz here, or edit the phase's own task.");
  });
});
