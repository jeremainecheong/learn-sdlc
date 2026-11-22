import { readme, journalMarkdown, type ReadmeInput } from "./docs";
const input: ReadmeInput = {
  projectTitle: "TaskTrackr",
  learnerName: "Export Learner",
  exportedAt: "2026-09-10T00:00:00Z",
  phaseCount: 6,
  directories: ["requirements"],
  phasesPassed: 0,
  submissions: 1,
  emptyCommits: 1,
  tags: [],
};
describe("repository export claims", () => {
  it("describes partial editable evidence without inventing completion, average scores, or a runnable application", () => {
    const text = readme(input);
    expect(text).toContain("Six phases, none recorded as passed.");
    expect(text).toContain("not a complete standalone application");
    expect(text).toContain("full review reports are excluded");
    expect(text).toContain("latest 200");
    expect(text).not.toMatch(/Average score|hours spent|completed all/i);
  });
  it("labels the limited activity summary and preserves actual events", () => {
    const text = journalMarkdown(
      "TaskTrackr",
      [
        {
          at: input.exportedAt,
          phaseKey: "requirements",
          kind: "submission",
          title: "Revision 1",
          detail: "Original change",
          result: "Needs revision",
        },
      ],
      new Map([["requirements", "Requirements"]]),
    );
    expect(text).toContain("Needs revision");
    expect(text).toContain("private message text is excluded");
  });
});
