"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AuthProviders, UserProfile } from "@learnsdlc/shared";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, numberWord } from "@learnsdlc/shared";
import { api, clearAuth, getToken, signInHref } from "@/lib/api";
import { saveBlob } from "@/lib/download";
import { getSession } from "@/lib/session";
import { rememberRegistrationEmail } from "@/lib/auth-flow";
import { Field } from "@/components/Field";
import { Icon } from "@/components/Icon";
import { ExperiencePage } from "@/components/experience/shared";
import { ArrowLeft } from "lucide-react";
import { Notice, Section } from "@/components/ui";
import { VerifyBanner } from "@/app/verify/VerifyBanner";

const ROLE_LABEL: Record<UserProfile["role"], string> = {
  LEARNER: "Learner",
  INSTRUCTOR: "Instructor",
  ADMIN: "Administrator",
};

/**
 * Which form the answer belongs to.
 *
 * The forms sit 300 to 900px below the page heading in a 720px column, so a
 * notice under the heading would be read out by a screen reader ("every
 * session has been signed out") while a sighted learner, still looking at the
 * button they had just pressed, saw nothing at all. An answer therefore
 * renders in the section that asked the question, directly under its button.
 */
type Scope = "password" | "export" | "delete";

interface Answer {
  scope: Scope;
  tone: "pass" | "fail";
  text: string;
}

function SectionNotice({
  answer,
  scope,
}: {
  answer: Answer | null;
  scope: Scope;
}) {
  if (!answer || answer.scope !== scope) return null;
  return (
    <Notice
      tone={answer.tone}
      role={answer.tone === "fail" ? "alert" : "status"}
      testId={`account-${answer.tone}`}
    >
      {answer.text}
    </Notice>
  );
}

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"idle" | "exporting" | "deleting">("idle");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [pw, setPw] = useState({ current: "", next: "" });
  const [savingPw, setSavingPw] = useState(false);
  const passwordRequest = useRef(false);
  const [capabilities, setCapabilities] = useState<AuthProviders | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const loadCapabilities = () => {
    setCapabilityError('');
    return api.providers().then(setCapabilities).catch(() => setCapabilityError('Account actions could not be loaded. Try again.'));
  };
  useEffect(() => { let live = true; api.providers().then(value => { if (live) setCapabilities(value); }).catch(() => { if (live) setCapabilityError('Account actions could not be loaded. Try again.'); }); return () => { live = false; }; }, []);

  useEffect(() => {
    if (!getToken()) {
      {
        // The sign-in page, told where the learner was, and nothing at all when
        // the session has just ended, because `request()` is already navigating
        // there with the reason as well.
        const to = signInHref();
        if (to) router.replace(to);
      }
      return;
    }
    const stored = getSession();
    setUser(stored);
    setLoading(false);
  }, [router]);

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordRequest.current || capabilities?.passwordChange === false) return;
    passwordRequest.current = true;
    setSavingPw(true);
    setAnswer(null);
    try {
      await api.changePassword(pw.current, pw.next);
      setPw({ current: "", next: "" });
      // The API bumps the token version, so every session (this tab
      // included) is signed out; the next request would bounce to /login
      // anyway, and saying so beats a silent redirect.
      const email = user?.email;
      clearAuth();
      if (email) rememberRegistrationEmail(email);
      // This is an authentication boundary: end the protected document and
      // put the confirmation beside the next action, with the address prefilled.
      window.location.replace('/login?passwordChanged=1');
    } catch (err) {
      setAnswer({
        scope: "password",
        tone: "fail",
        text: (err as Error).message,
      });
    } finally {
      passwordRequest.current = false;
      setSavingPw(false);
    }
  };

  const doExport = async () => {
    setBusy("exporting");
    setAnswer(null);
    try {
      const data = await api.exportAccount();
      // Built and revoked here rather than linking straight at the API: the
      // request needs the Authorization header, which a plain <a href> cannot
      // carry.
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      saveBlob(blob, "learnsdlc-export.json");
      setAnswer({
        scope: "export",
        tone: "pass",
        text: "Your data file is ready to save.",
      });
    } catch (err) {
      setAnswer({
        scope: "export",
        tone: "fail",
        text: (err as Error).message,
      });
    } finally {
      setBusy("idle");
    }
  };

  const doDelete = async () => {
    setBusy("deleting");
    setAnswer(null);
    try {
      await api.deleteAccount(confirmEmail.trim());
      clearAuth();
      // Leave the protected document immediately. A client-router transition
      // races its session guard, which otherwise sends deletion to sign-in.
      window.location.replace("/");
    } catch (err) {
      setAnswer({
        scope: "delete",
        tone: "fail",
        text: (err as Error).message,
      });
      setBusy("idle");
    }
  };

  const emailMatches =
    Boolean(user?.email) &&
    confirmEmail.trim().toLowerCase() === user!.email.toLowerCase();

  const details: [string, string | undefined, string][] = [
    ["Email", user?.email, "w-44"],
    ["Role", user ? ROLE_LABEL[user.role] : undefined, "w-20"],
  ];

  return (
    <ExperiencePage
      title="Account settings"
      eyebrow="Your account, your choice"
      active="account"
      variant="account"
      actions={
        <Link href="/profile" className="exp-button">
          <ArrowLeft size={15} />
          My profile
        </Link>
      }
    >
      <VerifyBanner />
      <div className="exp-account-settings exp-stack">
        {capabilityError && <Notice tone="fail"><span>{capabilityError}</span> <button type="button" className="exp-text-link" onClick={() => void loadCapabilities()}>Retry account actions</button></Notice>}
        <Section
          title="Sign-in details"
          purpose="The email and role attached to your account."
          className={loading ? "opacity-90" : ""}
        >
          {loading && (
            <p role="status" className="sr-only">
              Loading your details…
            </p>
          )}
          <dl className="grid gap-4 sm:grid-cols-2" aria-busy={loading}>
            {details.map(([label, value, width]) => (
              <div key={label} className="min-w-0">
                <dt className="label">{label}</dt>
                <dd className="mt-1 break-words text-[14px] text-ink">
                  {/* A dash while the profile is still being read would look
                        like an account with nothing in it. */}
                  {loading ? (
                    <span
                      aria-hidden
                      className={`skeleton my-1 block h-[14px] rounded ${width}`}
                    />
                  ) : (
                    value || "Not set"
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section
          title="Password"
          purpose={capabilities?.passwordChange === false ? 'Manage your password with your sign-in provider.' : 'Use your current password to choose a new one. Changing it signs you out on every device.'}
        >
          {!capabilities ? <p role="status">Loading password options…</p> : capabilities.passwordChange === false ? <p>Your sign-in provider manages this password. Use its account recovery options to change it.</p> : <>
          {capabilities.authProvider === 'cognito' && <p className="mb-4 text-[13px] text-muted">Use this form if you signed up with an email and password. If you use Google or an institution account, change your password with that provider.</p>}
          <form onSubmit={savePassword} className="max-w-[420px] space-y-4">
            <Field
              id="current-password"
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={pw.current}
              disabled={savingPw}
              onChange={(e) =>
                setPw((v) => ({ ...v, current: e.target.value }))
              }
              required
              data-testid="current-password"
            />
            <Field
              id="new-password"
              label="New password"
              type="password"
              autoComplete="new-password"
              hint={`At least ${PASSWORD_MIN_LENGTH} characters, and not one of the common breached passwords.`}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              value={pw.next}
              disabled={savingPw}
              onChange={(e) => setPw((v) => ({ ...v, next: e.target.value }))}
              required
              data-testid="new-password"
            />
            <button
              type="submit"
              disabled={savingPw || !pw.current || pw.next.length < PASSWORD_MIN_LENGTH}
              title={
                !pw.current
                  ? "Enter your current password first"
                  : pw.next.length < PASSWORD_MIN_LENGTH
                    ? `A new password needs at least ${numberWord(PASSWORD_MIN_LENGTH)} characters`
                    : undefined
              }
              className="btn"
              data-testid="password-save"
            >
              {savingPw ? "Changing…" : "Change password"}
            </button>
          </form>
          <SectionNotice answer={answer} scope="password" />
          <p className="text-[12.5px] leading-relaxed text-muted">
            Lost it? Sign out and use password recovery on the sign-in page.
          </p>
          </>}
        </Section>

        <Section
          title="Export your data"
          purpose="Everything LearnSDLC stores about you, as one JSON file: your workspace, submissions and reports, reflections, quiz papers and mentor transcripts."
        >
          <p className="text-[13px] leading-relaxed text-ink2">
            Your password and sign-in credentials are not included.
          </p>
          <div>
            <button
              onClick={doExport}
              disabled={busy !== "idle"}
              className="btn-secondary"
              data-testid="export-data"
            >
              <Icon name="download" size={15} />
              {busy === "exporting" ? "Preparing…" : "Download my data"}
            </button>
          </div>
          <SectionNotice answer={answer} scope="export" />
        </Section>

        <Section
          title="Delete your account"
          purpose={capabilities?.accountDeletion === false ? 'Account deletion needs support for this sign-in provider.' : 'Removes your account and everything attached to it: workspace, submissions, reflections and mentor transcripts. It happens immediately and cannot be undone.'}
          className="border-fail/40"
        >
          {!capabilities ? <p role="status">Loading deletion options…</p> : capabilities.accountDeletion === false ? <p data-testid="managed-account-deletion">Self-service deletion is not available for this managed account. Contact the LearnSDLC operator to request deletion. You can export your learning data above.</p> : !confirmOpen ? (
            <div>
              <button
                onClick={() => setConfirmOpen(true)}
                className="btn-secondary text-fail"
                data-testid="delete-account"
              >
                <Icon name="warning" size={15} />
                Delete my account
              </button>
              <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
                Export first if you want to keep anything.
              </p>
            </div>
          ) : (
            <div className="rounded-ctl bg-failtint p-4 sm:p-5">
              <label
                htmlFor="confirm-email"
                className="block text-[14px] font-medium text-ink"
              >
                Type <span className="mono break-all">{user?.email}</span> to
                confirm
              </label>
              <input
                id="confirm-email"
                type="email"
                autoComplete="off"
                className="field mt-2"
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                data-testid="confirm-email"
              />
              <div className="mt-4 flex flex-wrap gap-2.5">
                <button
                  onClick={doDelete}
                  disabled={!emailMatches || busy !== "idle"}
                  className="btn-danger"
                  data-testid="confirm-delete"
                >
                  {busy === "deleting" ? "Deleting…" : "Permanently delete"}
                </button>
                <button
                  onClick={() => {
                    setConfirmOpen(false);
                    setConfirmEmail("");
                  }}
                  className="btn-secondary"
                >
                  Cancel
                </button>
              </div>
              <SectionNotice answer={answer} scope="delete" />
            </div>
          )}
        </Section>
      </div>

      <p className="mt-6 text-[13px] text-muted">
        What we store and why is described in the{" "}
        <Link href="/privacy" className="text-accent underline underline-offset-2">
          privacy policy
        </Link>
        .
      </p>
    </ExperiencePage>
  );
}
