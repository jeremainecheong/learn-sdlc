import {
  REPO_NO_FILES_LINE,
  type PhaseKey,
  type FeedbackReport,
} from "@learnsdlc/shared";

/**
 * The history the exporter writes, as a pure function of rows.
 *
 * Every product rule of the export lives here and nowhere
 * else: what a commit is called, what its body says, which commit a tag lands
 * on, and what happens to a revision whose files retention has already thrown
 * away. `repo.service.ts` reads rows and writes objects; this decides what the
 * repository says.
 */

/** One attempt, as much of it as the history needs. */
export interface HistoryRevision {
  id: string;
  phaseStateId: string;
  /** ISO. Ordered by this and then by id, the tie-break the index was built for. */
  createdAt: string;
  status: string;
  score: number | null;
  passed: boolean | null;
  assessmentMode?: string | null;
  report?: FeedbackReport | null;
  packVersion: string | null;
  runClock: string | null;
  commitMessage: string | null;
  regradeOf: string | null;
  /** Null once retention has pruned it. That null is the whole signal. */
  snapshot: Record<string, string> | null;
}

export interface HistoryPhase {
  phaseStateId: string;
  phaseKey: PhaseKey;
  phaseOrder: number;
  title: string;
}

export interface HistoryRelease {
  phaseStateId: string;
  phaseKey: PhaseKey;
  version: string;
  notes: string | null;
  createdAt: string;
}

export interface HistoryDocs {
  /** `README.md` as the first commit writes it. */
  readmeStart: string;
  /** `README.md` as the last commit rewrites it, with the final counts. */
  readmeFinal: string;
  /** `docs/journal.md`, written by the last commit. */
  journal: string;
}

export interface HistoryInput {
  projectSlug: string;
  projectTitle: string;
  learnerName: string;
  learnerEmail: string;
  startedAt: string;
  completedAt: string | null;
  phases: HistoryPhase[];
  revisions: HistoryRevision[];
  releases: HistoryRelease[];
  docs: HistoryDocs;
}

/** One commit, before any of it is turned into git objects. */
export interface RepoCommit {
  /** `start`, a submission id, or `record`. Tags point at these. */
  key: string;
  subject: string;
  message: string;
  /** ISO. Author and committer date both. */
  at: string;
  /** Written over the parent's tree. Empty means the tree is the parent's. */
  files: Record<string, string>;
  /** True when the revision's files were pruned, so `git show` prints no diff. */
  empty: boolean;
  phaseTitle: string | null;
}

export interface RepoTag {
  name: string;
  phaseKey: PhaseKey;
  phaseTitle: string;
  message: string;
  /** What the card shows: the learner's own words, or null when they wrote none. */
  notes: string | null;
  overridden: boolean;
  createdAt: string;
  /** The commit key this tag lands on. */
  commitKey: string;
}

export interface RepoHistory {
  commits: RepoCommit[];
  tags: RepoTag[];
}

const time = (iso: string): number => {
  const at = new Date(iso).getTime();
  return Number.isFinite(at) ? at : 0;
};

/** Oldest first, ties broken by id, because two rows can share a `createdAt`. */
export function revisionOrder(a: HistoryRevision, b: HistoryRevision): number {
  const byTime = time(a.createdAt) - time(b.createdAt);
  return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** `2026-03-01T09:14:00.000Z` -> `2026-03-01`, for the clock line. */
const day = (iso: string): string => String(iso).slice(0, 10);

export function buildHistory(input: HistoryInput): RepoHistory {
  const phaseOf = new Map(
    input.phases.map((phase) => [phase.phaseStateId, phase]),
  );
  const ordered = [...input.revisions].sort(revisionOrder);

  // The attempt number a learner sees is per phase, and it is counted in the
  // same order the revisions panel counts it.
  const attempts = new Map<string, number>();
  const attemptOf = new Map<string, number>();
  for (const revision of ordered) {
    const next = (attempts.get(revision.phaseStateId) ?? 0) + 1;
    attempts.set(revision.phaseStateId, next);
    attemptOf.set(revision.id, next);
  }

  const commits: RepoCommit[] = [
    {
      key: "start",
      subject: `Start ${input.projectTitle}`,
      message: `Start ${input.projectTitle}`,
      at: input.startedAt,
      files: { "README.md": input.docs.readmeStart },
      empty: false,
      phaseTitle: null,
    },
  ];

  for (const revision of ordered) {
    const phase = phaseOf.get(revision.phaseStateId);
    const title = phase?.title ?? "A phase";
    const attempt = attemptOf.get(revision.id) ?? 1;
    // The learner's own words when they wrote any, and a plain sentence in the
    // product's voice when they did not. Nothing here is ever put in quotes:
    // a generated subject must not read as something the learner said.
    const written = (revision.commitMessage ?? "").trim();
    const subject = written || `Submit ${title}, attempt ${attempt}`;

    const verdict =
      revision.status === "failed"
        ? "Review unavailable."
        : revision.status === "queued" || revision.status === "running"
          ? "Review in progress."
          : revision.passed === null
            ? "No verdict recorded."
            : revision.assessmentMode === "strict_binary"
              ? `${revision.passed ? "Pass" : "Needs revision"}.`
              : `Historical verdict: ${revision.passed ? "Pass" : "Needs revision"}.${revision.score == null ? "" : ` Recorded score: ${Math.round(revision.score)}.`}`;
    const body = [`${title}, submission ${attempt}. ${verdict}`];
    if (revision.packVersion)
      body.push(`Pack: ${input.projectSlug}@${revision.packVersion}`);
    if (revision.runClock) body.push(`Clock: ${day(revision.runClock)}`);
    if (revision.snapshot == null) body.push(REPO_NO_FILES_LINE);
    if (revision.regradeOf) {
      const parent = attemptOf.get(revision.regradeOf);
      body.push(
        parent
          ? `Regrade of submission ${parent}.`
          : "Regrade of an earlier submission.",
      );
    }

    commits.push({
      key: revision.id,
      subject,
      message: `${subject}\n\n${body.join("\n")}`,
      at: revision.createdAt,
      files: revision.snapshot ?? {},
      empty: revision.snapshot == null,
      phaseTitle: title,
    });
  }

  // The last commit carries the two generated documents and the README the
  // counts are final in. Written whatever state the project is in, so the docs
  // are in the tree of a project three phases through as well as a finished one.
  const newest = commits.reduce(
    (at, commit) => Math.max(at, time(commit.at)),
    time(input.startedAt),
  );
  const recordAt = Math.max(
    newest,
    input.completedAt ? time(input.completedAt) : 0,
  );
  commits.push({
    key: "record",
    subject: "Record the project",
    message: "Record the project\n\nThe journal and the README, as they stand.",
    at: new Date(recordAt).toISOString(),
    files: {
      "README.md": input.docs.readmeFinal,
      "docs/journal.md": input.docs.journal,
    },
    empty: false,
    phaseTitle: null,
  });

  const tags: RepoTag[] = [];
  for (const release of [...input.releases].sort(
    (a, b) => time(a.createdAt) - time(b.createdAt),
  )) {
    const at = time(release.createdAt);
    const phase = phaseOf.get(release.phaseStateId);
    const title = phase?.title ?? release.phaseKey;
    // The revision the phase was merged on: its newest pass at or before the
    // merge. An instructor override leaves a release with no pass at all, and
    // then the tag lands on whatever the learner's newest commit was and says
    // so, rather than being left off.
    const passes = ordered.filter(
      (revision) =>
        revision.phaseStateId === release.phaseStateId &&
        revision.passed === true &&
        time(revision.createdAt) <= at,
    );
    const overridden = passes.length === 0;
    const commit = overridden
      ? [...commits]
          .reverse()
          .find((row) => time(row.at) <= at && row.key !== "record")
      : commits.find((row) => row.key === passes[passes.length - 1].id);
    const notes = (release.notes ?? "").trim() || null;
    const message = notes ?? `Merged ${title}.`;
    tags.push({
      name: release.version,
      phaseKey: release.phaseKey,
      phaseTitle: title,
      message: overridden
        ? `${message}\nThis phase was passed by an instructor override.`
        : message,
      notes,
      overridden,
      createdAt: release.createdAt,
      commitKey: commit?.key ?? "start",
    });
  }

  return { commits, tags };
}
