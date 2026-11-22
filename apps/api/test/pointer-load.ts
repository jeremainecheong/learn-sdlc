import { ContentService, type LoadProjectOptions } from '../src/content/content.service';
import type { PhaseContent, PhaseInputs, ProjectContent } from '../src/content/content.types';
import { pointerInputs } from '../src/content/legacy-layout';
import type { PackSource } from '../src/content/pack-source';

/** The private members of the loader the pointer reading drives, as `loadProject` drove them when it read the older layout. */
interface PointerLoader {
  loadVersion(raw: unknown, packName: string): string;
  loadLanguages(meta: Record<string, unknown>, packName: string): ProjectContent['languages'];
  loadPhase(spec: Record<string, unknown>, inputs: PhaseInputs, pack: { language: string; languages: ProjectContent['languages'] }, options: LoadProjectOptions): PhaseContent;
  projectOf(source: PackSource, meta: Record<string, unknown>, version: string, languages: ProjectContent['languages'], phases: PhaseContent[], warmupDir: unknown): ProjectContent;
}

/**
 * The pointer loader's read of an older pack, as a loader for the pointer
 * layout reads one: each listed phase
 * through the moved readers (`pointerInputs`) and the loader's own
 * `loadPhase`, a reader's error prefixed with the pack and the phase, the
 * phases sorted by order. It is the one place the pointer member names still
 * reach a loader sentence, through `pointerInputs`'s `named`.
 * `legacy-layout.spec.ts`'s first case pins this reading to recorded output
 * for every older fixture;
 * `folder-layout.spec.ts` reads the loader sentences it raises.
 */
export function pointerLoad(source: PackSource, options: LoadProjectOptions = {}): ProjectContent {
  const loader = new ContentService() as unknown as PointerLoader;
  const meta = JSON.parse(source.read('project.json'));
  const version = loader.loadVersion(meta.version, source.name);
  if (!Array.isArray(meta.phases) || meta.phases.length === 0) throw new Error(`${source.name}/project.json: phases must be a non-empty array`);
  const languages = loader.loadLanguages(meta, source.name);
  const phases = (meta.phases as string[]).map((rel) => {
    try {
      const phaseDir = source.child(rel);
      const spec = JSON.parse(phaseDir.read('phase.json'));
      return loader.loadPhase(spec, pointerInputs(phaseDir, spec), { language: meta.language, languages }, options);
    } catch (err) {
      throw new Error(`${source.name}/${rel}: ${(err as Error).message}`);
    }
  });
  phases.sort((a, b) => a.order - b.order);
  return loader.projectOf(source, meta, version, languages, phases, meta.warmup);
}
