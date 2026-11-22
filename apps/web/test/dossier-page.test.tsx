// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import DossierPage from "@/app/(app)/dossier/page";

const mocks = vi.hoisted(() => ({
  history: vi.fn(), snapshot: vi.fn(), records: vi.fn(),
  enrollment: {
    id: "project", projectSlug: "tasktrackr", projectTitle: "TaskTrackr",
    startedAt: "2026-09-10T00:00:00Z", completedAt: null,
    phases: [
      { id: "open", key: "requirements", order: 1, title: "Requirements", status: "in_progress", attempts: 1 },
      { id: "locked", key: "maintenance", order: 6, title: "Maintenance", status: "locked", attempts: 0 },
    ],
  },
}));
vi.mock("@/lib/useProject", () => ({ useProject: () => ({ enrollment: mocks.enrollment, details: {}, slug: "tasktrackr", loading: false, revalidating: false }) }));
vi.mock("@/components/shell", () => ({ PERSONA_NAME: { requirements: "Mira", maintenance: "Sage" } }));
vi.mock("@/lib/session", () => ({ useSession: () => null }));
vi.mock("@/lib/api", () => ({ api: { getSubmissionWithFiles: mocks.snapshot }, describeError: (error: Error) => error.message }));
vi.mock("@/lib/api-experience", () => ({ experienceApi: { history: mocks.history } }));
vi.mock("@/lib/records", () => ({ cachedRecords: () => ({}), loadAllRecords: async () => true, loadRecords: mocks.records }));
vi.mock("@/components/experience/shared", () => ({ ExperiencePage: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/shell/AppFrame", () => ({ RetryNotice: ({ message }: { message: string }) => <div role="alert">{message}</div> }));
vi.mock("@/components/ui", () => ({ Button: ({ children, disabled }: { children: React.ReactNode; disabled: boolean }) => <button disabled={disabled}>{children}</button>, Kbd: () => null, EmptyState: () => <p>No project</p> }));
vi.mock("@/components/dossier/print.css", () => ({ DOSSIER_PRINT_CSS: "", PrintStyle: () => null }));
vi.mock("@/components/dossier/Dossier", () => ({ Dossier: ({ dossier }: { dossier: { phases: Array<{ files: Array<{ content: string }> }> } }) => <article>{dossier.phases.flatMap(phase => phase.files).map((file, index) => <p key={index}>{file.content}</p>)}</article> }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.history.mockResolvedValue([{ id: "submitted", phaseStateId: "open", verifiedPass: false, attempt: 1 }]);
  mocks.snapshot.mockResolvedValue({ id: "submitted", status: "completed", passed: false, createdAt: "2026-09-10T01:00:00Z", report: null, workspaceSnapshot: { "requirements/story.md": "Retained submitted story" } });
  mocks.records.mockImplementation(async (id: string) => {
    if (id === "locked") throw new Error("403: phase locked");
    return { records: { submissions: [], runs: [], chat: [] }, partial: false };
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("prepares an incomplete-course PDF from submitted bytes without reading gated future activity", async () => {
  await act(async () => { root.render(<DossierPage />); });
  expect(host.textContent).toContain("Retained submitted story");
  expect(host.querySelector("button")?.disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(mocks.records.mock.calls).toEqual([["open"]]);
});

it("keeps print blocked when the accessible phase's activity cannot be read", async () => {
  mocks.records.mockResolvedValue({ records: { submissions: [], runs: [], chat: [] }, partial: true });
  await act(async () => { root.render(<DossierPage />); });
  expect(host.querySelector("button")?.disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Some activity records could not be read");
});
