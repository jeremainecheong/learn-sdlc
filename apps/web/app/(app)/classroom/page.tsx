"use client";
import { sameSession } from '@/lib/session-token';
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, LockKeyhole, UsersRound } from "lucide-react";
import type { CohortView } from "@learnsdlc/shared";
import { api, describeError } from "@/lib/api";
import { getToken, setSession } from "@/lib/session";
import { experienceApi } from "@/lib/api-experience";
import { cohortsApi } from "@/lib/api-cohorts";
import { JoinCode } from "@/components/experience/JoinCode";
import { ExperiencePage, LoadingState } from "@/components/experience/shared";
import { useProject } from "@/lib/useProject";
import { clearActiveProject } from "@/lib/project";

export default function ClassroomPage() {
  const [cohort, setCohort] = useState<CohortView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const readVersion = useRef(0);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const [refreshError, setRefreshError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { reload } = useProject();
  const loadMembership = useCallback(async () => {
    const version = ++readVersion.current;
    setLoading(true); setLoadError("");
    try {
      const value = await experienceApi.classroom();
      if (version === readVersion.current) setCohort(value);
    } catch (err) {
      if (version === readVersion.current) setLoadError(describeError(err, "Class membership could not be loaded."));
    } finally {
      if (version === readVersion.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    setCode(new URLSearchParams(window.location.search).get("code") ?? "");
    void loadMembership();
    return () => { readVersion.current += 1; };
  }, [loadMembership]);
  async function refreshAccount() {
    const version = readVersion.current;
    const owner = getToken();
    setRefreshError("");
    try {
      const profile = await api.me();
      if (version !== readVersion.current || !sameSession(getToken(), owner)) return;
      setSession(profile);
      await reload();
    } catch (err) {
      if (version === readVersion.current && sameSession(getToken(), owner))
        setRefreshError(describeError(err, "Your account view could not be refreshed."));
    }
  }
  async function retryAccountRefresh() {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true);
    try { await refreshAccount(); }
    finally { actionPending.current = false; setBusy(false); }
  }
  async function membership(action: "join" | "leave") {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true);
    setError(""); setNotice(""); setRefreshError("");
    try {
      try {
        if (action === "join") {
          setCohort(await cohortsApi.join(code));
          setCode("");
          // The same true sentence as the page's own: a class on another
          // project opens next, and started work is kept.
          setNotice("You have joined your class. If your class works on another project, your dashboard opens that one next, and the work you have already started stays in your record.");
        } else {
          await experienceApi.leave();
          setCohort(null);
          setNotice("You are now learning independently. Your project work and submission history stay in your record. If your class was on a project its teacher wrote, your dashboard now opens the project for learners without a class.");
        }
      } catch (err) {
        setError(describeError(err, "Your membership could not be updated."));
        return;
      }
      // The class decides which project the server resolves, and it has just
      // changed. The shell reloads under the project the tab holds, and a read
      // that names a project is answered with the row held there, so the tab
      // forgets it first and the reload asks the server which project is this
      // learner's now. Before the account refresh, so its retry asks the same.
      clearActiveProject();
      await refreshAccount();
    } finally {
      actionPending.current = false; setBusy(false);
    }
  }
  return (
    <ExperiencePage
      title="My classroom"
      eyebrow="Your learning, your choice"
      active="join"
      variant="classroom"
      actions={
        <Link href="/profile" className="exp-button">
          My profile
        </Link>
      }
    >
      <div className="exp-grid">
        <section className="exp-panel">
          <UsersRound size={34} color="#2a829a" />
          {loading ? (
            <LoadingState />
          ) : loadError ? (
            <>
              <h2 className="mt-5">Your class membership is unavailable.</h2>
              <p>We could not check your current class. Retry to see your membership and available actions.</p>
              <p role="alert" className="exp-error">{loadError}</p>
              <button type="button" className="exp-button exp-primary" onClick={() => void loadMembership()}>Retry membership</button>
            </>
          ) : cohort ? (
            <>
              <span className="exp-eyebrow mt-5">Your class</span>
              <h2>{cohort.name}</h2>
              <p>
                Your teacher can follow your phase progress and inspect the
                feedback on your submissions.
              </p>
              {/* The class's join code, masked as on the teacher's pages: this
                  page can be on a shared screen, and the code lets anyone into
                  the class. Show code reveals it, Copy code copies it unseen. */}
              <div className="exp-classroom-code" data-testid="classroom-join-code">
                <span className="exp-caption">Class join code</span>
                <JoinCode code={cohort.joinCode} compact />
              </div>
              <div className="exp-actions mt-6">
                <Link href="/dashboard" className="exp-button exp-primary">
                  Continue my project
                  <ArrowRight size={15} />
                </Link>
                <Link href="/progress" className="exp-button">
                  My feedback
                </Link>
              </div>
              <div className="exp-inline-note mt-6">
                <span>
                  You can leave at any time. Your progress and project work stay
                  in your record. If this class is on a project its teacher
                  wrote, your dashboard then opens the project for learners
                  without a class.
                </span>
              </div>
              <button
                type="button"
                className="exp-button mt-4"
                disabled={busy}
                onClick={() => void membership("leave")}
              >
                {busy ? "Updating membership…" : "Leave class"}
              </button>
            </>
          ) : (
            <>
              <span className="exp-eyebrow mt-5">
                Class membership is optional
              </span>
              <h2>Learn solo, or join your class.</h2>
              {/* A class that works on another project sets
                  aside a platform project the learner started, and its own
                  project opens next. Nothing is deleted or re-pinned. A class
                  with no project, or one on the same project, keeps them where
                  they are, which is why the sentence names the condition. */}
              <p>
                If you have a class code, join here so your teacher can follow
                your work. If your class works on another project, your
                dashboard opens that one next, and the work you have already
                started stays in your record.
              </p>
              <form
                className="exp-form mt-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  void membership("join");
                }}
              >
                <label className="exp-field">
                  Class code
                  <input
                    required
                    maxLength={24}
                    disabled={busy}
                    autoCapitalize="characters"
                    autoComplete="off"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="ABCD-EFGH"
                  />
                </label>
                <button
                  className="exp-button exp-primary"
                  disabled={
                    busy || code.replace(/[^a-z0-9]/gi, "").length !== 8
                  }
                >
                  {busy ? "Joining…" : "Join class"}
                  <ArrowRight size={15} />
                </button>
              </form>
              <Link href="/dashboard" className="exp-text-link mt-5">
                Keep learning independently
                <ArrowRight size={14} />
              </Link>
            </>
          )}
          {error && (
            <p role="alert" className="exp-error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="exp-success">
              {notice}
            </p>
          )}
          {refreshError && (
            <div className="exp-inline-note">
              <div><p role="alert">Your membership is saved. The account view could not refresh. {refreshError}</p>
              <button type="button" className="exp-button" disabled={busy} onClick={() => void retryAccountRefresh()}>
                {busy ? "Refreshing account…" : "Retry account refresh"}
              </button></div>
            </div>
          )}
        </section>
        <aside className="exp-panel">
          <span className="exp-eyebrow">Clear from the start</span>
          <h2>What’s shared?</h2>
          <p>
            Joining a class gives your teacher a view of your learning record.
          </p>
          <ul className="exp-list">
            {[
              ["Phase progress", "Where you are in the project's phases."],
              [
                "Submitted evidence",
                "Your submitted files and review evidence.",
              ],
              [
                "Submission feedback",
                "AI verdicts and teacher feedback on each revision.",
              ],
            ].map(([title, detail]) => (
              <li key={title} className="exp-row">
                <div>
                  <strong>{title}</strong>
                  <p>{detail}</p>
                </div>
                <Check size={17} color="#39877e" />
              </li>
            ))}
            <li className="exp-row">
              <div>
                <strong>Private mentor conversations</strong>
                <p>Stay private and are excluded from teacher views.</p>
              </div>
              <LockKeyhole size={19} />
            </li>
          </ul>
        </aside>
      </div>
    </ExperiencePage>
  );
}
