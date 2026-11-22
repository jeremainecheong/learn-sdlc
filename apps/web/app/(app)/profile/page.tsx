"use client";
import { sameSession } from '@/lib/session-token';
import { useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { ReviewRefreshNotice } from "@/components/experience/ReviewRefreshNotice";
import { doorWithTasks, phaseDoorHref } from "@/components/shell/routes";
import {
  ArrowLeft,
  ArrowRight,
  Save,
  Pencil,
  X,
  Compass,
  Rocket,
  BriefcaseBusiness,
  Wrench,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import type { UserProfile } from "@learnsdlc/shared";
import { DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, PROFILE_BIO_MAX, PROFILE_GOALS_MAX } from "@learnsdlc/shared";
import { useSession, setSession, getSession, getToken } from "@/lib/session";
import { useProject } from "@/lib/useProject";
import { api, describeError } from "@/lib/api";
import { experienceApi } from "@/lib/api-experience";
import {
  AVATAR_LABELS,
  LearnerAvatar,
} from "@/components/experience/LearnerAvatar";
import {
  ExperiencePage,
  LoadingState,
  ReviewLoadError,
  CompactPhasePath,
  phaseArt,
  useReviews,
  isPass,
} from "@/components/experience/shared";

import { clearProfileDraft, profileFields, readProfileDraft, writeProfileDraft } from "@/components/experience/profile-draft";
import { DISPLAY_LOCALE } from "@/lib/locale";

function ProfileForm({
  user,
  summary,
  avatarDialogRef,
}: {
  user: UserProfile;
  summary: React.ReactNode;
  avatarDialogRef: RefObject<HTMLDialogElement | null>;
}) {
  const [restored] = useState(() => readProfileDraft(user.id));
  const [baseVersion, setBaseVersion] = useState(restored?.baseVersion ?? user.profileVersion ?? 0);
  const [savedFields, setSavedFields] = useState(() => profileFields(user));
  const [displayName, setName] = useState(restored?.fields.displayName ?? user.displayName);
  const [avatar, setAvatar] = useState(restored?.fields.avatar ?? user.avatar ?? 0);
  const [bio, setBio] = useState(restored?.fields.bio ?? user.bio ?? "");
  const [goals, setGoals] = useState(restored?.fields.goals ?? user.goals ?? "");
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [latest, setLatest] = useState<UserProfile | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const staff = user.role !== "LEARNER";
  const dirty = displayName !== savedFields.displayName || avatar !== savedFields.avatar || bio !== savedFields.bio || goals !== savedFields.goals;
  const stale = dirty && (user.profileVersion ?? 0) !== baseVersion;
  useEffect(() => {
    if (getSession()?.id !== user.id) return;
    if (dirty) setStorageAvailable(writeProfileDraft({ owner: user.id, baseVersion, fields: { displayName, avatar, bio, goals } }));
    else clearProfileDraft(user.id);
  }, [user.id, baseVersion, displayName, avatar, bio, goals, dirty]);
  useEffect(() => {
    if (!dirty || storageAvailable) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, storageAvailable]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const edit = () => setSaved(false);
  function useSavedProfile(current: UserProfile) {
    const fields = profileFields(current);
    setName(fields.displayName); setAvatar(fields.avatar); setBio(fields.bio); setGoals(fields.goals);
    setSavedFields(fields); setBaseVersion(current.profileVersion ?? 0); setLatest(null); setError(""); setSaved(false);
    clearProfileDraft(user.id); setSession(current);
  }
  async function reviewSavedProfile() {
    const token = getToken();
    setReviewing(true); setError("");
    try { const current = await api.me(); if (sameSession(getToken(), token) && current.id === user.id) setLatest(current); }
    catch (err) { setError(describeError(err, "Your saved profile could not be loaded.")); }
    finally { setReviewing(false); }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const token = getToken();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const updated = await experienceApi.saveProfile({
        baseVersion,
        displayName: displayName.trim(),
        avatar,
        bio: bio.trim(),
        goals: goals.trim(),
      });
      if (!sameSession(getToken(), token) || getSession()?.id !== user.id) return;
      useSavedProfile(updated);
      setSaved(true);
    } catch (err) {
      if (!sameSession(getToken(), token) || getSession()?.id !== user.id) return;
      setError(describeError(err, "Your profile could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="exp-grid exp-profile-grid" onSubmit={save}>
      <section className="exp-panel exp-form">
        <div>
          <h2>A little about you</h2>
          <p>Make this learning space feel like yours.</p>
        </div>
        <label className="exp-field">
          Display name
          <input
            disabled={busy}
            required
            minLength={DISPLAY_NAME_MIN}
            maxLength={DISPLAY_NAME_MAX}
            value={displayName}
            onChange={(event) => {
              setName(event.target.value);
              edit();
            }}
            autoComplete="name"
          />
        </label>
        <label className="exp-field">
          About you
          <textarea
            disabled={busy}
            maxLength={PROFILE_BIO_MAX}
            value={bio}
            onChange={(event) => {
              setBio(event.target.value);
              edit();
            }}
            placeholder="What brings you to software development?"
          />
        </label>
        <fieldset className="exp-goal-options">
          <legend>What brings you here?</legend>
          <p>Choose the goals you want to work towards.</p>
          {[
            { label: "Ship a complete project", Icon: Rocket },
            { label: "Make better team handoffs", Icon: UsersRound },
            { label: "Get confident with real tools", Icon: Wrench },
            { label: "Prepare for a software role", Icon: BriefcaseBusiness },
          ].map(({ label, Icon }) => (
            <label key={label}>
              <input
                disabled={busy}
                type="checkbox"
                checked={goals.split("\n").includes(label)}
                onChange={(event) => {
                  const lines = goals
                    .split("\n")
                    .filter((line) => line !== label && line.trim());
                  const nextGoals = event.target.checked
                    ? [...lines, label].join("\n")
                    : lines.join("\n");
                  if (nextGoals.length > PROFILE_GOALS_MAX) {
                    setError(
                      `Your goals have reached ${PROFILE_GOALS_MAX.toLocaleString(DISPLAY_LOCALE)} characters. Shorten them before adding another goal.`,
                    );
                    return;
                  }
                  setGoals(nextGoals);
                  setError("");
                  edit();
                }}
              />
              <Icon size={15} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <label className="exp-field">
          Your learning goals
          <textarea
            disabled={busy}
            maxLength={PROFILE_GOALS_MAX}
            value={goals}
            onChange={(event) => {
              setGoals(event.target.value);
              edit();
            }}
            placeholder="What would you like to build, understand, or become more confident doing?"
          />
        </label>
        {dirty && (
          <section className="exp-profile-draft" aria-label="Unsaved profile changes">
            <p role="status">{!storageAvailable ? "Unsaved changes. Browser storage is unavailable; save before leaving." : restored ? "Your unsaved draft is restored in this tab. Save when you are ready." : "Your unsaved changes are kept in this tab until you save."}</p>
            {stale && <p>Your saved profile changed after this draft began. Review it before replacing any fields.</p>}
            <div className="exp-actions">
              <button type="button" className="exp-button" disabled={busy || reviewing} onClick={() => void reviewSavedProfile()}>{reviewing ? "Loading saved profile…" : "Review saved profile"}</button>
              {!stale && <button type="button" className="exp-text-link" disabled={busy} onClick={() => useSavedProfile(user)}>Discard changes</button>}
            </div>
            {latest && <div className="exp-profile-comparison">
              <h3>Currently saved</h3>
              <dl><dt>Name</dt><dd>{latest.displayName}</dd><dt>Portrait</dt><dd>{AVATAR_LABELS[latest.avatar ?? 0]}</dd><dt>About you</dt><dd>{latest.bio || "Not set"}</dd><dt>Goals</dt><dd>{latest.goals || "Not set"}</dd></dl>
              <p>Use the saved profile to discard this draft, or keep your changes for the next Save profile to replace these fields.</p>
              <div className="exp-actions">
                <button type="button" className="exp-button" disabled={busy} onClick={() => useSavedProfile(latest)}>Use saved profile</button>
                <button type="button" className="exp-button" disabled={busy} onClick={() => { setBaseVersion(latest.profileVersion ?? 0); setSavedFields(profileFields(latest)); setSession(latest); setLatest(null); setError(""); }}>Keep my changes</button>
              </div>
            </div>}
          </section>
        )}
        {error && (
          <p role="alert" className="exp-error">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="exp-success">
            Your profile is saved.
          </p>
        )}
        <div className="exp-actions">
          <button
            className="exp-button exp-primary"
            disabled={busy || displayName.trim().length < DISPLAY_NAME_MIN}
          >
            <Save size={16} />
            {busy ? "Saving…" : "Save profile"}
          </button>
          <Link href="/account" className="exp-text-link">
            Account settings
            <ArrowRight size={14} />
          </Link>
        </div>
      </section>
      <dialog
        ref={avatarDialogRef}
        className="exp-avatar-dialog"
        aria-labelledby="profile-portrait-title"
      >
        <section>
          <button
            type="button"
            className="exp-dialog-close"
            aria-label="Close portrait picker"
            onClick={() => avatarDialogRef.current?.close()}
          >
            <X size={18} />
          </button>
          <span className="exp-eyebrow">Pick your portrait</span>
          <h2 id="profile-portrait-title">A face for your journey</h2>
          <p>Choose one of six 3D learner avatars.</p>
          <div
            className="exp-avatar-picker"
            role="group"
            aria-label="Choose a learner avatar"
          >
            {AVATAR_LABELS.map((label, index) => (
              <button
                type="button"
                key={label}
                className="exp-avatar-choice"
                disabled={busy}
                aria-label={`Select ${label}`}
                aria-pressed={avatar === index}
                onClick={() => {
                  setAvatar(index);
                  edit();
                }}
              >
                <LearnerAvatar avatar={index} size={80} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <p className="exp-caption">
            Your selection is applied when you save your profile.
          </p>
          <button
            type="button"
            className="exp-button exp-primary"
            onClick={() => avatarDialogRef.current?.close()}
          >
            Use this portrait
          </button>
        </section>
      </dialog>
      <aside className="exp-stack">
        {summary}
        <section className="exp-panel">
          <UsersRound size={24} />
          <h2 className="mt-3">{staff ? "Your classes" : "Your class, your choice"}</h2>
          <p>{staff ? "Return to your classes to follow learner progress and respond to submitted work." : "Learn independently or connect with a teacher. Your project history stays with you."}</p>
          <Link href={staff ? "/teacher" : "/classroom"} className="exp-text-link">
            {staff ? "My classes" : "Manage class membership"}
            <ArrowRight size={14} />
          </Link>
        </section>
        <div className="exp-inline-note">
          <ShieldCheck size={19} />
          <span>
            Private mentor conversations stay within your phase project spaces.
          </span>
        </div>
      </aside>
    </form>
  );
}
export default function ProfilePage() {
  const user = useSession();
  const staff = user?.role === "INSTRUCTOR" || user?.role === "ADMIN";
  const avatarDialogRef = useRef<HTMLDialogElement>(null);
  const { enrollment, details, loading: projectLoading } = useProject();
  const { reviews, loading, refreshing, error, refreshError, refresh } = useReviews();
  const currentPhase = enrollment?.phases.find(
    (phase) => phase.status !== "locked" && phase.status !== "passed",
  );
  const passed =
    enrollment?.phases.filter(
      (phase) =>
        phase.status === "passed" &&
        reviews.some(
          (review) => review.phase.id === phase.id && isPass(review.submission),
        ),
    ).length ?? 0;
  return (
    <ExperiencePage
      title="My profile"
      eyebrow="Your corner of LearnSDLC"
      active="profile"
      variant="profile"
      actions={
        <Link href={staff ? "/teacher" : "/dashboard"} className="exp-button">
          <ArrowLeft size={15} />
          {staff ? "My classes" : "Dashboard"}
        </Link>
      }
    >
      {user ? (
        <>
          <section className="exp-panel exp-hero exp-profile-hero">
            <button
              type="button"
              className="exp-portrait-button"
              aria-label="Change your portrait"
              onClick={() => avatarDialogRef.current?.showModal()}
            >
              <LearnerAvatar avatar={user.avatar} size={116} />
              <span>
                <Pencil size={13} />
              </span>
            </button>
            <div>
              <span className="exp-eyebrow">{staff ? "Teaching profile" : "Learner profile"}</span>
              <h2>{user.displayName}</h2>
              <p>{user.email}</p>
              <span className="exp-membership-label">
                <Compass size={13} />
                {user.role === "LEARNER"
                  ? user.cohort === "default"
                    ? "Learning independently"
                    : "Learning with a class"
                  : user.role === "INSTRUCTOR"
                    ? "Teacher"
                    : "Administrator"}
              </span>
            </div>
            <div className="exp-profile-links">
              <Link href={staff ? "/teacher" : "/progress"} className="exp-button">
                {staff ? "My classes" : "My progress"}
                <ArrowRight size={15} />
              </Link>
              {!staff && <Link href="/classroom" className="exp-text-link">
                My classroom
              </Link>}
            </div>
          </section>
          {error && <ReviewLoadError message={error} retry={refresh} />}
          {!staff && <ReviewRefreshNotice message={refreshError} refreshing={refreshing} retry={refresh} />}
          <ProfileForm
            key={user.id}
            user={user}
            avatarDialogRef={avatarDialogRef}
            summary={staff ? null : (
              <section className="exp-panel exp-profile-summary">
                <h2>Your learning so far</h2>
                <p>From your current project record.</p>
                <div
                  className="exp-stats"
                  aria-busy={projectLoading || loading || refreshing}
                >
                  {projectLoading || loading ? (
                    <p role="status">Loading activity…</p>
                  ) : error ? (
                    <p>Activity unavailable</p>
                  ) : (
                    <>
                      <div>
                        <strong>
                          {passed}
                          <span> / {enrollment?.phases.length ?? 0}</span>
                        </strong>
                        <span>Phases passed</span>
                      </div>
                      <div>
                        <strong>{reviews.length}</strong>
                        <span>Submissions</span>
                      </div>
                    </>
                  )}
                </div>

                {enrollment && (
                  <>
                    <header className="exp-section-heading">
                      <h3>Project journey</h3>
                      <Link href="/progress" className="exp-text-link">
                        View all
                        <ArrowRight size={14} />
                      </Link>
                    </header>
                    <CompactPhasePath
                      phases={enrollment.phases}
                      reviews={reviews}
                    />
                    {currentPhase && (
                      <Link
                        className="exp-profile-current"
                        href={phaseDoorHref(doorWithTasks(currentPhase, details))}
                      >
                        <img
                          src={phaseArt(currentPhase.key)}
                          width="51"
                          height="51"
                          alt=""
                        />
                        <span>
                          <small>Current phase</small>
                          <strong>{currentPhase.title}</strong>
                          <small>In progress</small>
                        </span>
                        <ArrowRight size={15} />
                      </Link>
                    )}
                  </>
                )}
              </section>
            )}
          />
        </>
      ) : (
        <LoadingState />
      )}
    </ExperiencePage>
  );
}
