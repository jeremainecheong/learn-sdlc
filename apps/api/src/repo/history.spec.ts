import { REPO_NO_FILES_LINE } from "@learnsdlc/shared";
import {
  buildHistory,
  type HistoryInput,
  type HistoryRevision,
} from "./history";

/**
 * Every product rule of the export lives in `history.ts`, so
 * every product rule of the export is checked here: what a commit is called,
 * what its body says, which commit a tag lands on, and what happens to a
 * revision whose files retention has already thrown away.
 */
const DOCS = {
  readmeStart: "# start\n",
  readmeFinal: "# final\n",
  journal: "# journal\n",
};

const revision = (
  over: Partial<HistoryRevision> & { id: string },
): HistoryRevision => ({
  phaseStateId: "state-1",
  createdAt: "2026-03-01T09:00:00.000Z",
  status: "succeeded",
  score: 86,
  passed: true,
  packVersion: null,
  runClock: null,
  commitMessage: null,
  regradeOf: null,
  snapshot: { "api/app.py": 'print("hi")' },
  ...over,
});

const input = (over: Partial<HistoryInput> = {}): HistoryInput => ({
  projectSlug: "tasktrackr",
  projectTitle: "TaskTrackr",
  learnerName: "Sam Tan",
  learnerEmail: "sam@example.edu",
  startedAt: "2026-02-28T08:00:00.000Z",
  completedAt: null,
  phases: [
    {
      phaseStateId: "state-1",
      phaseKey: "requirements",
      phaseOrder: 1,
      title: "Requirements",
    },
    {
      phaseStateId: "state-2",
      phaseKey: "design",
      phaseOrder: 2,
      title: "Design",
    },
    {
      phaseStateId: "state-3",
      phaseKey: "implementation",
      phaseOrder: 3,
      title: "Implementation",
    },
  ],
  revisions: [],
  releases: [],
  docs: DOCS,
  ...over,
});

describe("the exported history", () => {
  it("records completed strict reviews as binary verdicts even when no score exists", () => {
    const history = buildHistory(
      input({
        revisions: [
          revision({
            id: "pass",
            status: "completed",
            score: null,
            assessmentMode: "strict_binary",
            passed: true,
          }),
          revision({
            id: "revision",
            status: "completed",
            score: 0,
            assessmentMode: "strict_binary",
            passed: false,
          }),
          revision({
            id: "failed",
            status: "failed",
            score: null,
            passed: null,
          }),
          revision({
            id: "pending",
            status: "running",
            score: null,
            passed: null,
          }),
        ],
      }),
    );
    const message = (id: string) =>
      history.commits.find((row) => row.key === id)!.message;
    expect(message("pass")).toContain(". Pass.");
    expect(message("revision")).toContain(". Needs revision.");
    expect(message("revision")).not.toMatch(/score/i);
    expect(message("failed")).toContain("Review unavailable.");
    expect(message("pending")).toContain("Review in progress.");
  });
  it("writes one commit for every submission, oldest first across phases", () => {
    const history = buildHistory(
      input({
        revisions: [
          revision({
            id: "b",
            phaseStateId: "state-2",
            createdAt: "2026-03-02T09:00:00.000Z",
          }),
          revision({
            id: "a",
            phaseStateId: "state-1",
            createdAt: "2026-03-01T09:00:00.000Z",
          }),
          revision({
            id: "c",
            phaseStateId: "state-3",
            createdAt: "2026-03-03T09:00:00.000Z",
          }),
        ],
      }),
    );
    expect(history.commits.map((commit) => commit.key)).toEqual([
      "start",
      "a",
      "b",
      "c",
      "record",
    ]);
  });

  it("breaks a tie on createdAt with the id, the way the index does", () => {
    const at = "2026-03-01T09:00:00.000Z";
    const history = buildHistory(
      input({
        revisions: [
          revision({ id: "zz", createdAt: at }),
          revision({ id: "aa", createdAt: at }),
        ],
      }),
    );
    expect(history.commits.map((commit) => commit.key)).toEqual([
      "start",
      "aa",
      "zz",
      "record",
    ]);
  });

  it("makes a revision whose files were pruned an empty commit, not a skip", () => {
    const revisions = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      revision({
        id: `r${n}`,
        createdAt: `2026-03-0${n}T09:00:00.000Z`,
        // Retention keeps the newest few; the rest keep their row and lose
        // their files, which is exactly what the pull request already says.
        snapshot: n >= 6 ? { "api/app.py": `v${n}` } : null,
        passed: false,
        score: 62,
      }),
    );
    const history = buildHistory(input({ revisions }));
    const submissions = history.commits.filter(
      (commit) => commit.phaseTitle !== null,
    );
    expect(submissions).toHaveLength(7);
    expect(submissions.filter((commit) => commit.empty)).toHaveLength(5);
    expect(submissions[0].message).toContain(REPO_NO_FILES_LINE);
    expect(Object.keys(submissions[0].files)).toEqual([]);
  });

  it("keeps the learner own words and never invents them", () => {
    const history = buildHistory(
      input({
        revisions: [
          revision({ id: "a", commitMessage: "Handle the empty keyword" }),
          revision({
            id: "b",
            createdAt: "2026-03-02T09:00:00.000Z",
            commitMessage: null,
          }),
        ],
      }),
    );
    const [, first, second] = history.commits;
    expect(first.subject).toBe("Handle the empty keyword");
    expect(second.subject).toBe("Submit Requirements, attempt 2");
    expect(second.subject).not.toContain('"');
  });

  it("tags the commit a phase was merged on", () => {
    const history = buildHistory(
      input({
        revisions: [
          revision({ id: "a", passed: false, score: 40 }),
          revision({
            id: "b",
            createdAt: "2026-03-02T09:00:00.000Z",
            passed: true,
          }),
          revision({
            id: "c",
            createdAt: "2026-03-05T09:00:00.000Z",
            passed: true,
          }),
        ],
        releases: [
          {
            phaseStateId: "state-1",
            phaseKey: "requirements",
            version: "v1",
            notes: "Merged the overdue story",
            createdAt: "2026-03-03T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(history.tags).toHaveLength(1);
    expect(history.tags[0].commitKey).toBe("b");
    expect(history.tags[0].message).toBe("Merged the overdue story");
    expect(history.tags[0].overridden).toBe(false);
  });

  it("tags an overridden phase on the newest commit and says so", () => {
    const history = buildHistory(
      input({
        revisions: [revision({ id: "a", passed: false, score: 40 })],
        releases: [
          {
            phaseStateId: "state-1",
            phaseKey: "requirements",
            version: "v1",
            notes: null,
            createdAt: "2026-03-03T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(history.tags[0].overridden).toBe(true);
    expect(history.tags[0].commitKey).toBe("a");
    expect(history.tags[0].message).toBe(
      "Merged Requirements.\nThis phase was passed by an instructor override.",
    );
  });

  it("carries the pack version, the clock and the regrade parent only when they are set", () => {
    const plain = buildHistory(input({ revisions: [revision({ id: "a" })] }));
    const body = plain.commits[1].message.split("\n\n")[1].split("\n");
    expect(body).toEqual([
      "Requirements, submission 1. Historical verdict: Pass. Recorded score: 86.",
    ]);

    const full = buildHistory(
      input({
        revisions: [
          revision({ id: "a" }),
          revision({
            id: "b",
            createdAt: "2026-03-02T09:00:00.000Z",
            packVersion: "1.3.0",
            runClock: "2026-03-01",
            regradeOf: "a",
            snapshot: null,
          }),
        ],
      }),
    );
    expect(full.commits[2].message.split("\n\n")[1].split("\n")).toEqual([
      "Requirements, submission 2. Historical verdict: Pass. Recorded score: 86.",
      "Pack: tasktrackr@1.3.0",
      "Clock: 2026-03-01",
      REPO_NO_FILES_LINE,
      "Regrade of submission 1.",
    ]);
  });

  it("accumulates the tree, so a file written in one phase is still there in the next", () => {
    const history = buildHistory(
      input({
        revisions: [
          revision({ id: "a", snapshot: { "requirements/story.md": "one" } }),
          revision({
            id: "b",
            phaseStateId: "state-3",
            createdAt: "2026-03-04T09:00:00.000Z",
            snapshot: { "api/app.py": "two" },
          }),
        ],
      }),
    );
    // The commits carry only what changed; the accumulation is the exporter's
    // job, and what it accumulates is every path any commit ever wrote.
    const paths = history.commits.flatMap((commit) =>
      Object.keys(commit.files),
    );
    expect(paths).toEqual([
      "README.md",
      "requirements/story.md",
      "api/app.py",
      "README.md",
      "docs/journal.md",
    ]);
  });

  it("always writes the last commit, so the journal is in the tree of an unfinished project", () => {
    const history = buildHistory(input({ revisions: [] }));
    expect(history.commits.map((commit) => commit.key)).toEqual([
      "start",
      "record",
    ]);
    expect(history.commits[1].files["docs/journal.md"]).toBe("# journal\n");
    expect(history.commits[1].files["README.md"]).toBe("# final\n");
  });
});
