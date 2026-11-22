import type { PhaseFiles } from './agentic-payload';

/** The paths the learner may edit in this phase, in the phase's order. */
export const editablePaths = (phase: PhaseFiles): string[] => phase.files.filter(file => file.editable).map(file => file.path);

/** Each editable path with its saved bytes, or the pack's own when nothing is saved, in the phase's order. */
export const editableEntries = (phase: PhaseFiles, workspace: Record<string, string> | null | undefined): Array<[string, string]> =>
  phase.files.filter(file => file.editable).map(file => [file.path, workspace?.[file.path] ?? file.content]);

/** `editableEntries` as a map from path to bytes: the editable files over the saved workspace. */
export const editableFiles = (phase: PhaseFiles, workspace: Record<string, string> | null | undefined): Record<string, string> =>
  Object.fromEntries(editableEntries(phase, workspace));
