// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProgressPage from "@/app/(app)/progress/page";
import { SubmissionEvidence } from "@/components/experience/SubmissionEvidence";
const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  evidence: vi.fn(),
  notes: vi.fn(),
  write: vi.fn(),
  enrollmentId: "enrollment",
  revalidating: false,
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/useProject", () => ({
  useProject: () => ({
    loading: false,
    revalidating: mocks.revalidating,
    enrollment: {
      id: mocks.enrollmentId,
      projectSlug: "tasktrackr",
      phases: [
        {
          id: "phase",
          key: "requirements",
          title: "Requirements",
          order: 1,
          status: "in_progress",
          attempts: 0,
        },
      ],
    },
  }),
}));
vi.mock("@/lib/api-experience", () => ({
  experienceApi: {
    history: mocks.history,
    teacherEvidence: mocks.evidence,
    teacherFeedback: mocks.notes,
    writeFeedback: mocks.write,
  },
}));
vi.mock("@/lib/api", () => ({
  api: { getSubmissionWithFiles: mocks.evidence },
  describeError: (error: Error) => error.message,
}));
let root: Root;
let host: HTMLDivElement;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const submission = {
  id: "submission",
  status: "failed",
  passed: false,
  report: null,
  createdAt: "2026-09-10T00:00:00Z",
  error: "Review unavailable",
  workspaceSnapshot: { "story.md": "Saved work" },
};
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  )!;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.enrollmentId = "enrollment";
  mocks.revalidating = false;
  mocks.evidence.mockResolvedValue(submission);
  mocks.notes.mockResolvedValue([]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
describe("honest review loading and recovery", () => {
  it("shows the focused or hovered historical review without changing its exact evidence link", async () => {
    mocks.history.mockResolvedValue([
      { id: "earlier", status: "completed", passed: false, verifiedPass: false, reviewUnavailable: false, createdAt: submission.createdAt, phaseStateId: "phase", attempt: 1 },
      { ...submission, id: "later", createdAt: "2026-09-11T00:00:00Z", phaseStateId: "phase", attempt: 2 },
    ]);
    await act(async () => root.render(<ProgressPage />));
    const points = host.querySelectorAll<HTMLAnchorElement>(".exp-review-dot");
    const caption = host.querySelector('[aria-label="Review point details"]')!;
    expect(caption.textContent).toContain("Focus or hover");
    act(() => fireEvent.focusIn(points[0]));
    expect(caption.textContent).toContain("Requirements / Review 1");
    expect(caption.textContent).toContain("Needs revision");
    expect(points[0].getAttribute("href")).toContain("submission=earlier");
    expect(points[0].getAttribute("data-active")).toBe("true");
    act(() => fireEvent.pointerOver(points[1]));
    expect(caption.textContent).toContain("Requirements / Review 2");
    expect(caption.textContent).toContain("Review unavailable");
    expect(points[1].getAttribute("href")).toContain("submission=later");
    expect(points[0].hasAttribute("data-active")).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("does not display zero submissions before history arrives or when it fails, then recovers from Retry", async () => {
    const pending = deferred<unknown[]>();
    mocks.history.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(<ProgressPage />));
    expect(host.textContent).toContain("Loading your learning record");
    expect(host.textContent).not.toContain("Recorded submissions");
    await act(async () => pending.reject(new Error("History unavailable")));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "History unavailable",
    );
    expect(host.textContent).not.toContain("Recorded submissions");
    mocks.history.mockResolvedValue([]);
    await act(async () => button("Retry reviews").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Recorded submissions");
  });
  it("does not claim there are no teacher comments while their request is pending or unavailable", async () => {
    const pending = deferred<unknown[]>();
    mocks.notes.mockReturnValueOnce(pending.promise);
    await act(async () =>
      root.render(<SubmissionEvidence submissionId="submission" />),
    );
    expect(host.textContent).toContain("Loading teacher feedback");
    expect(host.textContent).not.toContain(
      "No teacher feedback on this submission",
    );
    await act(async () => pending.reject(new Error("Feedback unavailable")));
    expect(host.textContent).toContain("Feedback unavailable");
    expect(host.textContent).not.toContain(
      "No teacher feedback on this submission",
    );
    mocks.notes.mockResolvedValue([]);
    await act(async () => button("Retry teacher feedback").click());
    expect(host.textContent).toContain(
      "No teacher feedback on this submission",
    );
  });
  it("hides the previous enrollment history immediately when the active enrollment changes during refresh", async () => {
    mocks.history.mockResolvedValueOnce([
      { ...submission, phaseStateId: "phase" },
    ]);
    await act(async () => root.render(<ProgressPage />));
    expect(host.textContent).toContain("Recorded submissions");
    mocks.enrollmentId = "another-enrollment";
    mocks.revalidating = true;
    await act(async () => root.render(<ProgressPage />));
    expect(host.textContent).toContain("Loading your learning record");
    expect(host.textContent).not.toContain("Recorded submissions");
    const pending = deferred<unknown[]>();
    mocks.history.mockReturnValueOnce(pending.promise);
    mocks.revalidating = false;
    await act(async () => root.render(<ProgressPage />));
    await act(async () => pending.reject(new Error("New history unavailable")));
    expect(host.textContent).toContain("New history unavailable");
    expect(host.textContent).not.toContain("Recorded submissions");
  });
  it("locks a submitted teacher draft while saving and preserves the same draft and request ID on retry", async () => {
    const pending = deferred<unknown>();
    mocks.write.mockReturnValueOnce(pending.promise);
    await act(async () =>
      root.render(<SubmissionEvidence teacher submissionId="submission" />),
    );
    const input = host.querySelector("textarea")!;
    act(() => {
      fireEvent.change(input, { target: { value: "Please clarify the overdue boundary." } });
    });
    await act(async () => button("Save feedback").click());
    expect(input.disabled).toBe(true);
    expect(host.querySelector("select")?.disabled).toBe(true);
    expect(host.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => pending.reject(new Error("Connection lost")));
    expect(input.value).toBe("Please clarify the overdue boundary.");
    expect(input.disabled).toBe(false);
    const first = mocks.write.mock.calls[0][1];
    mocks.write.mockResolvedValue({
      id: "note",
      action: "comment",
      text: input.value,
      authorName: "Teacher",
      createdAt: submission.createdAt,
    });
    await act(async () => button("Save feedback").click());
    expect(mocks.write.mock.calls[1][1].requestId).toBe(first.requestId);
    expect(host.textContent).toContain("AI verdict is unchanged");
  });
});
