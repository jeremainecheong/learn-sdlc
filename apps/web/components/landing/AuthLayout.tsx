"use client";

import Link from "next/link";
import {
  ArrowLeft,
  FolderOpen,
  MessageSquare,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { PublicBrand } from "./PublicLayout";
import { Aurora } from "./Aurora";
import { Notice } from "@/components/ui";
import { usePathname } from "next/navigation";

/** Shared aurora and glass layout for registration, sign-in, and account recovery. */
export function AuthLayout({
  title,
  purpose,
  children,
}: {
  title: string;
  purpose?: string;
  children: React.ReactNode;
}) {
  const registration = usePathname() === "/register";
  return (
    <div
      className="marketing auth-experience"
      data-public-page={registration ? "register" : "signin"}
    >
      <Aurora />
      <header className="lh-entry-header">
        <Link href={registration ? "/login" : "/"} className="lh-entry-home">
          <ArrowLeft size={16} aria-hidden="true" />
          {registration ? "Back to sign in" : "Back to home"}
        </Link>
        <PublicBrand />
      </header>
      <div className="lh-signin-layout">
        <aside className="lh-returning-copy">
          <span className="lh-kicker">
            {registration ? "Your learning starts here" : "Welcome back"}
          </span>
          <h2>
            {registration ? (
              <>
                A little curiosity.<span>A lot to build.</span>
              </>
            ) : (
              <>
                Right where<span>you left off.</span>
              </>
            )}
          </h2>
          <p>
            {registration
              ? "Start a guided project and learn how software comes together, one decision at a time."
              : "Pick up your project, work through feedback, and carry on from your last step."}
          </p>
          <img
            className="lh-signin-illustration"
            src={`/artwork/${registration ? "registration-starter-kit-3d.webp" : "signin-learner-3d.webp"}`}
            alt=""
            width={420}
            height={320}
          />
          {!registration && (
            <div className="lh-returning-note">
              <span>
                <FolderOpen size={14} />
                Your projects
              </span>
              <span>
                <MessageSquare size={14} />
                Your feedback
              </span>
              <span>
                <ArrowRight size={14} />
                Your next step
              </span>
            </div>
          )}
        </aside>
        <main id="main" tabIndex={-1} className="lh-entry-card lh-frost">
          <div className="lh-entry-heading">
            <h1>{title}</h1>
            {purpose && <p>{purpose}</p>}
          </div>
          {children}
          {!registration && (
            <div className="lh-entry-card-foot">
              <ShieldCheck size={14} aria-hidden="true" />
              Your progress stays with your account.
            </div>
          )}
        </main>
      </div>
      <footer className="lh-entry-footer">
        <span>© {new Date().getFullYear()} LearnSDLC</span>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms of use</Link>
      </footer>
    </div>
  );
}

/**
 * The rule the sign-in page sets between its two ways in, and the recovery
 * pages reuse above a second choice.
 */
export function AuthRule({ children = "or" }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-[1.5px] flex-1 bg-edge" aria-hidden />
      <span className="label">{children}</span>
      <span className="h-[1.5px] flex-1 bg-edge" aria-hidden />
    </div>
  );
}

/**
 * A form's status line. The test id sits on a wrapper so the suites can find
 * it regardless of how the Notice primitive lays out its own element.
 */
export function AuthNotice({
  tone,
  testId,
  children,
}: {
  tone: "fail" | "pass" | "info" | "warn";
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className="lh-auth-notice">
      <Notice tone={tone} role={tone === "fail" ? "alert" : "status"}>
        {children}
      </Notice>
    </div>
  );
}
