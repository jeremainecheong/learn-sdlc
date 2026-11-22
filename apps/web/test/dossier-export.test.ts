import { describe, expect, it } from "vitest";
import type {
  EnrollmentView,
  PhaseDetail,
  SubmissionView,
} from "@learnsdlc/shared";
import { buildDossier, evidenceRevision } from "@/components/dossier/build";
import type { PhaseRecords } from "@/lib/records";
const phase = {
  id: "phase",
  key: "requirements",
  order: 1,
  title: "Requirements",
  status: "in_progress",
  attempts: 1,
  bestScore: null,
  passedAt: null,
};
const enrollment = {
  phases: [phase],
  projectSlug: "tasktrackr",
  projectTitle: "TaskTrackr",
  releases: [],
  startedAt: "2026-09-10T00:00:00Z",
  completedAt: null,
} as unknown as EnrollmentView;
const details = {
  phase: {
    ...phase,
    files: [
      {
        path: "requirements/story.md",
        content: "NEWER PRIVATE DRAFT",
        editable: true,
        language: "markdown",
      },
      {
        path: "requirements/new.md",
        content: "UNSUBMITTED FILE",
        editable: true,
        language: "markdown",
      },
    ],
    links: [],
    rubric: { passThreshold: 70, criteria: [] },
    drill: null,
  },
} as unknown as Record<string, PhaseDetail>;
const revision = {
  id: "review",
  status: "completed",
  passed: false,
  score: 0,
  report: null,
  createdAt: "2026-09-10T00:00:00Z",
} as SubmissionView;
const records = (rows: SubmissionView[]) =>
  ({ phase: { submissions: rows, runs: [], chat: [] } }) satisfies Record<
    string,
    PhaseRecords
  >;
describe("submitted source in printable dossiers", () => {
  it("prints exact latest submitted bytes and never fills missing paths from a later draft", () => {
    const doc = buildDossier(
      enrollment,
      details,
      records([revision]),
      {
        review: {
          "requirements/story.md": "ORIGINAL SUBMISSION",
          "requirements/old.md": "RETAINED REMOVED PATH",
        },
      },
      null,
    );
    expect(doc.phases[0].files.map((row) => row.content)).toEqual([
      "ORIGINAL SUBMISSION",
      "RETAINED REMOVED PATH",
    ]);
    expect(JSON.stringify(doc.phases[0].files)).not.toMatch(
      /PRIVATE|UNSUBMITTED/,
    );
  });
  it("keeps a verified pass as the evidence source ahead of a later unverified historical passing row", () => {
    const verified = { ...revision, id: "verified", passed: true, verifiedPass: true };
    const laterLegacy = { ...revision, id: "legacy", passed: true, verifiedPass: false };
    expect(evidenceRevision([verified, laterLegacy])?.id).toBe("verified");
    expect(evidenceRevision([laterLegacy])?.id).toBe("legacy");
  });
  it("keeps missing and never-submitted source empty instead of inserting starter or live files", () => {
    expect(
      buildDossier(
        enrollment,
        details,
        records([revision]),
        { review: null },
        null,
      ).phases[0].files,
    ).toEqual([]);
    expect(
      buildDossier(enrollment, details, records([]), {}, null).phases[0].files,
    ).toEqual([]);
  });
  it("does not certify completion from imported passed statuses without verified evidence", () => {
    const imported = {
      ...enrollment,
      completedAt: "2026-09-10T12:00:00Z",
      phases: Array.from({ length: 6 }, (_, i) => ({
        ...phase,
        id: `phase-${i}`,
        status: "passed",
      })),
    } as EnrollmentView;
    const doc = buildDossier(imported, {}, {}, {}, null);
    expect(doc.completedAt).toBeNull();
    expect(doc.phasesPassed).toBe(0);
  });
});


describe("binary verdict wording in the persisted dossier journal", () => {
  it("uses verified evidence rather than a numeric threshold and retains historical labels", () => {
    const rows = [
      { ...revision, id: "pass", verifiedPass: true, passed: true, report: { overall: 100, passThreshold: 70, assessmentMode: "strict_binary", passed: true } },
      { ...revision, id: "revision", verifiedPass: false, passed: false, report: { overall: 100, passThreshold: 70, assessmentMode: "strict_binary", passed: false } },
      { ...revision, id: "unverified", verifiedPass: false, passed: true, report: { overall: 100, passThreshold: 70, assessmentMode: "strict_binary", passed: true } },
      { ...revision, id: "historical", verifiedPass: false, passed: true, report: { overall: 100, passThreshold: 70, passed: true } },
    ] as SubmissionView[];
    const original = JSON.stringify(rows);
    const doc = buildDossier({ ...enrollment, releases: [{ id: "release", phaseKey: "requirements", version: "v1", score: 100, notes: "Recorded reflection", createdAt: revision.createdAt }] } as EnrollmentView, details, records(rows), {}, null);
    const reviews = doc.journal.filter(row => row.kind === "submission");
    expect(reviews.map(row => row.result)).toEqual(["Pass", "Needs revision", "Needs revision", "Historical Pass"]);
    expect(reviews[2].detail).toContain("lacks verified evidence");
    expect(doc.journal.find(row => row.kind === "release")?.title).toBe("Requirements merged as v1");
    expect(JSON.stringify(doc.journal)).not.toMatch(/scored 100|gate 70|approved at|points? short/);
    expect(JSON.stringify(rows)).toBe(original);
  });
});
