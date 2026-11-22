"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { UserProfile } from "@learnsdlc/shared";
import { DISPLAY_NAME_MAX, DISPLAY_NAME_MIN } from "@learnsdlc/shared";
import { invalidateProject } from "@/lib/useProject";
import { api, request, describeError } from "@/lib/api";
import { setActiveProject } from "@/lib/project";
import { setSession, useSession } from "@/lib/session";
import { cohortsApi } from "@/lib/api-cohorts";
import { experienceApi } from "@/lib/api-experience";
import { clearPendingClass, pendingClassCode } from "@/lib/auth-flow";
import { rememberJoinedClass } from "../dashboard/joined-class";
import {
  AVATAR_LABELS,
  LearnerAvatar,
} from "@/components/experience/LearnerAvatar";
import {
  ArrowRight,
  Check,
  Compass,
  UsersRound,
  ShieldCheck,
} from "lucide-react";
import "./onboarding.css";

/**
 * A class code is whole when it holds eight letters and digits, whatever the
 * dashes and spaces around them: the rule /join (`classroom/page.tsx`) holds
 * its Join class button to, so the two fields for one code behave alike.
 */
function wholeClassCode(code: string): boolean {
  return code.replace(/[^a-z0-9]/gi, "").length === 8;
}

export default function OnboardingPage() {
  const user = useSession();
  if (!user) return <main id="main" className="onboarding-page" aria-busy="true"><p role="status">Loading your learning setup…</p></main>;
  return <OnboardingForm key={user.id} user={user} />;
}

function OnboardingForm({ user }: { user: UserProfile }) {
  const router = useRouter();
  const [name, setName] = useState(user?.displayName ?? "");
  const [avatar, setAvatar] = useState(user?.avatar ?? 0);
  const [mode, setMode] = useState("solo");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const pending = pendingClassCode();
    if (pending) {
      setCode(pending);
      setMode("class");
    }
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "class" && !wholeClassCode(code)) return;
    setBusy(true);
    setError("");
    // The form draws its own error line rather than the browser's bubble
    // (`noValidate`): the same rules the fields carry, in words.
    const problem = setupProblem(name);
    if (problem) {
      setError(problem);
      // Focus goes back to the field at fault, as the browser's own check did.
      nameRef.current?.focus();
      setBusy(false);
      return;
    }
    let joined: { name?: string } | null = null;
    try {
      if (mode === "class") joined = await cohortsApi.join(code.trim());
      // "Learn independently" is the project for learners without a class.
      // An account can already be in one (an invitation link joined it,
      // or this form joined it before an enrolment failed), and the server
      // resolves a member's class project, a teacher's in the browser run. So
      // the membership is asked for and left first; a failure here stops the
      // setup with the server's sentence rather than starting the wrong one.
      else if (await experienceApi.classroom()) await experienceApi.leave();
      // Do not mark setup complete until its project exists. An interrupted
      // enrollment must return here on the next sign-in, with a safe retry.
      //
      // **The project is the server's answer, and this page does not name it.**
      // Neither a hard-coded slug nor the slug `lib/project` holds for the tab
      // will do: a hard-coded slug rules out a second project, and the tab
      // outlives the account, so on a shared machine where one learner signs
      // out and the next registers with no class, setup would enrol the new
      // account into the first one's teacher-assigned project. So the request
      // names nothing, and the class is joined first so that the answer is the
      // one the class carries.
      //
      // A learner the server cannot place (no class of theirs, nothing
      // published to start) is refused in the server's own sentence by the
      // catch below, with the form still filled in and the button still live.
      const started = await api.enroll();
      setActiveProject(started.projectSlug);
      const fresh = await request<UserProfile>("PATCH", "/account/profile", {
        displayName: name.trim(),
        avatar,
        onboardingCompleted: true,
        baseVersion: user?.profileVersion ?? 0,
      });
      setSession(fresh);
      clearPendingClass();
      invalidateProject();
      // The dashboard says once which class was joined.
      if (joined) rememberJoinedClass(joined.name);
      router.replace("/dashboard");
    } catch (e) {
      setError(
        describeError(e, "Your setup could not be saved. Please try again."),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" tabIndex={-1} className="onboarding-page">
      <header className="onboarding-heading">
        <span className="onboarding-eyebrow">Welcome to LearnSDLC</span>
        <h1>Make yourself at home.</h1>
        <p>A name, a face, and the way you want to learn.</p>
      </header>
      <form className="onboarding-grid" onSubmit={submit} aria-busy={busy} noValidate>
        <section className="onboarding-panel onboarding-person">
          <div className="onboarding-portrait">
            <LearnerAvatar avatar={avatar} size={110} />
          </div>
          <h2>Pick your portrait.</h2>
          <p>Choose one that feels like you. You can change it later.</p>
          <fieldset className="onboarding-avatars" disabled={busy}>
            <legend className="sr-only">Choose your learner portrait</legend>
            {AVATAR_LABELS.map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => setAvatar(i)}
                aria-pressed={avatar === i}
                aria-label={label}
              >
                <LearnerAvatar avatar={i} size={64} />
                <span className="onboarding-selection" aria-hidden>
                  {avatar === i && <Check size={13} />}
                </span>
              </button>
            ))}
          </fieldset>
          <label className="onboarding-field">
            What should we call you?
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={error === NAME_PROBLEM || undefined}
              aria-describedby={error === NAME_PROBLEM ? "onboarding-error" : undefined}
              minLength={DISPLAY_NAME_MIN}
              maxLength={DISPLAY_NAME_MAX}
              required
              autoComplete="name"
              placeholder="Your name"
              disabled={busy}
            />
          </label>
        </section>
        <section className="onboarding-panel onboarding-path">
          <span className="onboarding-eyebrow">Your learning setup</span>
          <h2>Start your way.</h2>
          <p>
            On your own, you start the project for learners without a class. A
            class may be on a project its teacher chose, and adds shared
            progress and teacher feedback.
          </p>
          <fieldset className="onboarding-modes" disabled={busy}>
            <legend className="sr-only">Choose how to learn</legend>
            <label>
              <input
                type="radio"
                name="learningMode"
                value="solo"
                checked={mode === "solo"}
                onChange={() => setMode("solo")}
              />
              <span>
                <Compass size={18} />
                <strong>Learn independently</strong>
                {/* See the same sentence on /classroom. */}
                <small>
                  Move at your own pace. If you later join a class that works
                  on another project, your dashboard opens that one next, and
                  your work on this one stays in your record.
                </small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="learningMode"
                value="class"
                checked={mode === "class"}
                onChange={() => setMode("class")}
              />
              <span>
                <UsersRound size={18} />
                <strong>Join a class</strong>
                <small>
                  Let your teacher follow your project and give feedback.
                </small>
              </span>
            </label>
          </fieldset>
          {/* The field /join draws for the same code, with its words and rules. */}
          {mode === "class" && (
            <div className="onboarding-field onboarding-class">
              <label htmlFor="onboarding-class-code">Class code</label>
              <input
                id="onboarding-class-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                maxLength={24}
                autoCapitalize="characters"
                autoComplete="off"
                placeholder="ABCD-EFGH"
                disabled={busy}
              />
            </div>
          )}
          <div className="onboarding-privacy">
            <ShieldCheck size={18} />
            <p>
              In a class, your teacher can see phase progress, submission
              verdicts, and feedback. Private mentor chats are not shared.
            </p>
          </div>
          {error && (
            <p role="alert" id="onboarding-error" className="text-fail">
              {error}
            </p>
          )}
          <button
            disabled={busy || (mode === "class" && !wholeClassCode(code))}
            className="onboarding-submit"
          >
            {busy ? "Saving your setup…" : "Start learning"}
            <ArrowRight size={17} aria-hidden />
          </button>
        </section>
      </form>
    </main>
  );
}

/** The name field's rule, said in words; the field is marked invalid while it shows. */
const NAME_PROBLEM = `Your name needs at least ${DISPLAY_NAME_MIN} characters.`;

/**
 * Setup's own check before anything is sent, in words rather than the
 * browser's bubble: a name of two characters, the rule its field carries. The
 * class code is not checked here: its field carries its own rule.
 */
function setupProblem(name: string): string {
  return name.trim().length < DISPLAY_NAME_MIN ? NAME_PROBLEM : "";
}
