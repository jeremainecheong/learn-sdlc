import { createHash } from 'crypto';
import type { ProjectFileRole } from '@learnsdlc/shared';
import type {
  DrillSpec,
  InterviewBrief,
  MutantSpec,
  PhaseContent,
  ProjectContent,
} from './content.types';

/**
 * Content addressing for the project model.
 *
 * Two jobs, and they are the same job read from two ends.
 *
 * The first is `content_blobs`: a pack's bytes are stored once, keyed by their
 * sha256, so a fork copies metadata rather than 992 KB of TaskTrackr and a
 * republish that changed one task reuses every other blob. `blobShaFor` is
 * that key, and its whole contract is that the same bytes yield the same key.
 *
 * The second is the digest of a *loaded* pack: `canonicalJson` plus a sha256 is
 * how a published version's `contentDigest` is computed, and it is how the
 * golden-equivalence net records what the loader produces so that the stored
 * form can be held against it field group by field group. The two share
 * one canonicaliser on purpose: the importer's idempotence key and the safety
 * net's fixture must never be able to disagree about what "the same content"
 * means.
 *
 * Nothing here reads a file. The bytes arrive from a `PackSource`, and the
 * sealed sets below are read off an already-loaded `ProjectContent`.
 */

/** sha256 of text, lower-case hex: the key `content_blobs` is keyed by. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** The blob key for a file's bytes. The same bytes are always the same row. */
export function blobShaFor(bytes: string): string {
  return sha256Hex(bytes);
}

/**
 * JSON with every object's keys recursively sorted and every `undefined`
 * member dropped, so that two loads of the same pack produce the same string
 * whatever order the loader happened to build its objects in.
 *
 * Arrays keep their order: a phase's `files` and a pack's `phases` are ordered
 * facts, the explorer and the map read them in the order they arrive, so
 * sorting them would hide a reordering the learner would see.
 */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(canonicalValue(value));
  return text === undefined ? 'null' : text;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = canonicalValue(member);
    }
    return out;
  }
  return value;
}

/** sha256 over the canonical JSON of a value: one field group, one digest. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/* ----------------------------- the sealed sets ---------------------------- */

/**
 * The path-keyed sealed material a phase holds, by the role the row carrying it
 * will be inserted under (`project_files.role`).
 *
 * A role is a property of a `(version, phase, path)`, never of bytes: in the
 * shipped pack five shas are a **locked `workspace` row** in one phase and a
 * sealed `solution` file in another, so this function answers "what is this
 * path to this phase", and the answer for the same bytes at another path may
 * legitimately differ.
 *
 * `implFiles` is here under `reference` because a `tests` phase grades the
 * learner's suite against it. It is also mounted, locked, in that phase's
 * workspace (the whole application is, so the phase can preview), which is
 * exactly why the seal that matters is the one on `hidden` and on `mutant`
 * rather than a blanket "sealed paths are not mounted".
 */
export function sealedFilesOf(
  phase: PhaseContent,
): Partial<Record<ProjectFileRole, Record<string, string>>> {
  const out: Partial<Record<ProjectFileRole, Record<string, string>>> = {};
  const put = (role: ProjectFileRole, files: Record<string, string>): void => {
    if (Object.keys(files).length === 0) return;
    out[role] = { ...(out[role] ?? {}), ...files };
  };
  const checks = phase.checks;
  if (checks.kind === 'code') {
    put('hidden', checks.hiddenTestFiles);
    put('solution', checks.solutionFiles);
  }
  if (checks.kind === 'tests') {
    put('reference', checks.referenceTestFiles);
    put('reference', checks.implFiles);
    put('support', checks.supportFiles);
    for (const mutant of checks.mutants) put('mutant', mutant.files);
  }
  if (checks.kind === 'code' || checks.kind === 'tests') {
    for (const run of checks.runs) {
      put('hidden', run.hiddenTestFiles);
      put('reference', run.referenceTestFiles);
      put('reference', run.implFiles);
      put('support', run.supportFiles);
    }
  }
  if (checks.kind === 'config' && checks.drill) put('drill', checks.drill.faultedFiles);
  return out;
}

/** The sealed paths of a phase, by role, sorted: the paths without the bytes. */
export function sealedPathsOf(phase: PhaseContent): Partial<Record<ProjectFileRole, string[]>> {
  const out: Partial<Record<ProjectFileRole, string[]>> = {};
  for (const [role, files] of Object.entries(sealedFilesOf(phase))) {
    out[role as ProjectFileRole] = Object.keys(files).sort();
  }
  return out;
}

/** Every path a phase mounts in the learner's workspace, editable or locked. */
export function mountedPathsOf(phase: PhaseContent): Map<string, boolean> {
  return new Map(phase.files.map((f) => [f.path, f.editable]));
}

/* ------------------------- the digest manifest ---------------------------- */

/**
 * One phase, as a digest per field group.
 *
 * The groups are the ones a reader of a failure needs told apart: a change to
 * the words a learner reads is `header`, a change to the files in the explorer
 * is `files`, and a change to the sealed bytes the grader runs is `sealed`.
 * `checks` deliberately covers the sealed members too, so a sealed byte that
 * moves fails twice rather than not at all.
 */
export interface PhaseDigests {
  header: string;
  files: string;
  checks: string;
  rubric: string;
  assistant: string;
  runtime: string;
  preview: string;
  sealed: string;
  sealedPaths: string;
}

/** Every field group of a loaded pack, as digests, and the two facts to read them by. */
export interface ContentDigestManifest {
  slug: string;
  version: string;
  /** slug, version, title, tagline, description, language, languages, build, runtime, preview, warmup. */
  project: string;
  /** Keyed by phase key, in the pack's own phase order. */
  phases: Record<string, PhaseDigests>;
}

/** The project header group: everything the pack declares outside its phases. */
export function projectHeaderOf(project: ProjectContent): Record<string, unknown> {
  return {
    slug: project.slug,
    version: project.version,
    title: project.title,
    tagline: project.tagline,
    description: project.description,
    language: project.language,
    languages: project.languages,
    build: project.build ?? null,
    runtime: project.runtime ?? null,
    preview: project.preview ?? null,
    warmup: project.warmup ?? null,
  };
}

/** The sealed group of a phase: every byte the grader reads and the learner must not. */
export function sealedGroupOf(phase: PhaseContent): Record<string, unknown> {
  const checks = phase.checks;
  const mutants: MutantSpec[] = checks.kind === 'tests' ? checks.mutants : [];
  const drill: DrillSpec | null = checks.kind === 'config' ? checks.drill ?? null : null;
  const interview: InterviewBrief | null = phase.interview ?? null;
  return { files: sealedFilesOf(phase), mutants, drill, interview };
}

export function phaseDigestsOf(phase: PhaseContent): PhaseDigests {
  return {
    header: digestOf({
      key: phase.key,
      order: phase.order,
      title: phase.title,
      intro: phase.intro,
      artifactKind: phase.artifactKind,
      taskPanel: phase.taskPanel,
      objectives: phase.objectives,
    }),
    files: digestOf(phase.files),
    checks: digestOf(phase.checks),
    rubric: digestOf(phase.rubric),
    assistant: digestOf(phase.assistant),
    runtime: digestOf({
      language: phase.language,
      canRun: phase.canRun,
      runLabel: phase.runLabel,
    }),
    preview: digestOf({ canPreview: phase.canPreview }),
    sealed: digestOf(sealedGroupOf(phase)),
    sealedPaths: digestOf(sealedPathsOf(phase)),
  };
}

/** The digest manifest of a loaded pack: the golden net's whole record of it. */
export function contentDigestManifest(project: ProjectContent): ContentDigestManifest {
  const phases: Record<string, PhaseDigests> = {};
  for (const phase of project.phases) phases[phase.key] = phaseDigestsOf(phase);
  return {
    slug: project.slug,
    version: project.version,
    project: digestOf(projectHeaderOf(project)),
    phases,
  };
}
