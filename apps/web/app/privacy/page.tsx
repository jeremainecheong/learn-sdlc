import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "The account, coursework, AI context, and learning records LearnSDLC stores and shares.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="1 October 2026">
      <p className="lede">
        LearnSDLC stores your learning record so you can return to your project
        and review earlier work. This page describes the application’s data
        flows. Your installation’s operator controls its hosting, backups, and
        configured AI provider.
      </p>

      <h2>Your account and learning record</h2>
      <p>
        Your account contains your email, display name, password hash, role,
        optional class membership, selected avatar, biography, goals, and
        onboarding preferences. Passwords are hashed with bcrypt and are not
        stored as plaintext.
      </p>
      <p>
        Your learning record includes saved workspace files, submitted revision
        snapshots, automated execution results, review evidence, Pass or Needs
        revision verdicts, reflections, phase progress, completion records, and
        teacher feedback. Earlier reports can also contain scores from a
        previous grading system; these remain historical records and do not
        replace the current strict assessment requirements.
      </p>
      <p>
        Phase conversations, stakeholder interviews, mentor proposals, your
        explanations of proposals, and whether you authorized an application are
        stored to support the connected learning experience. Activity metrics
        come from recorded actions, including submissions, runs, hints, and
        provider token use.
      </p>

      <h2>What reaches the AI provider</h2>
      <p>
        The configured provider may run locally or through an external service.
        The context depends on the action you request:
      </p>
      <ul>
        <li>
          <strong>Phase mentor:</strong> your message, recent conversation
          turns, the phase instructions, current editable workspace files,
          relevant failed checks, and a short summary of earlier phase work.
          Teacher guidance for your class may also be included.
        </li>
        <li>
          <strong>Stakeholder interview:</strong> your question and the phase’s
          stakeholder context.
        </li>
        <li>
          <strong>Submission review:</strong> the submitted editable source,
          phase objectives, rubric criteria, relevant public project contracts,
          and automated check evidence. The model evaluates the actual submitted
          work.
        </li>
        <li>
          <strong>Agentic assistance:</strong> your intent, current work and
          constraints, the proposed changes, and your explanation of what those
          changes do.
        </li>
        <li>
          <strong>Failure explanations:</strong> the failing test’s description
          and assertion, together with relevant source context. Hidden test
          source is not sent as learner-visible teaching material.
        </li>
      </ul>
      <p className="callout">
        Your work and messages can therefore leave this application when an
        external AI provider is configured. The application bounds request
        context and attempts to redact common secret patterns; this is not a
        guarantee that all sensitive information will be removed. Keep
        credentials and unrelated personal information out of project files and
        conversations.
      </p>
      <p>
        LearnSDLC does not run a model-training pipeline on your work. A
        provider’s own retention and data-use practices depend on the service
        and the operator’s configuration. Ask your installation’s operator which
        provider is active if this affects your decision to use AI assistance.
      </p>

      <h2>Classes and teacher access</h2>
      <p>
        Class membership is optional. Joining allows authorized teachers for
        that class to inspect your identity, phase progress, submitted evidence,
        review history, and learning activity metrics. Teachers can add
        comments, request revisions, or acknowledge an exact submission. Their
        feedback does not overwrite an AI verdict.
      </p>
      <p>
        Private mentor conversation text is excluded from teacher views and
        class exports. Administrators can manage accounts and classes; the
        operator also controls the underlying database. Leaving a class removes
        its teachers’ access to your learning record while preserving your
        project, submissions, and earlier feedback for you.
      </p>

      <h2>Browser storage and diagnostics</h2>
      <p>
        Your browser stores the sign-in token, a local copy of your profile,
        interface preferences, and workspace recovery data where supported.
        Signing out clears the session and registered private workspace caches.
        Shared devices should be signed out when you finish.
      </p>
      <p>
        The application has no advertising or advertising tracking pixels.
        Server diagnostics include request method, path, status, duration, and
        correlation identifiers. Request bodies are not part of ordinary request
        logs. Operators can configure external error monitoring, so diagnostic
        handling also depends on the installation.
      </p>

      <h2>Retention and exports</h2>
      <p>
        The current application keeps submitted source snapshots and review
        history while your account exists. Temporary AI response caches can
        expire without deleting your saved conversations. Older installations
        and imported records may lack source snapshots; review and export views
        identify those gaps.
      </p>
      <p>
        The account page offers a JSON export of your account and associated
        learning records, including your private conversations. The
        course-completion export contains phase evidence and retained submitted
        snapshots and excludes private conversations. A repository export
        contains the project files and recorded revision history. These exports
        are learning records, not accredited certificates.
      </p>

      <h2>Deleting your account</h2>
      <p>
        You can request permanent account deletion from account settings while
        signed in. This removes your active account and associated coursework
        records from the application database. Some administrative audit records
        remain as a record of the action, with the deleted subject identifier
        removed. Backup copies and their retention are controlled by the
        installation’s operator.
      </p>
      <p>
        If you wrote projects as a teacher, deletion is refused while any
        learner is still enrolled on one of their published versions. Otherwise
        each project you wrote is archived rather than deleted, together with
        what you wrote in it: titles, briefs, rubric rules, the stakeholder
        interview, the backlog and the files you replaced. Your account export
        includes that writing. File contents are stored once and shared by
        their content between projects, so file contents are never deleted.
      </p>
      <p>
        Password reset and address verification use the email delivery service
        configured by the operator. A reset link expires after one hour. If you
        cannot access your account or need information about backups, contact
        the operator using the details below.
      </p>

      <h2>Connection and execution security</h2>
      <p>
        Connection security depends on the deployment: hosted installations can
        serve HTTPS, while local development may use HTTP. Docker-based
        execution uses isolated workspaces and configured CPU, memory, and
        execution-time limits. The development process runner has different
        isolation guarantees. Access to learning records is checked by the API
        for each authenticated user and role.
      </p>
      <p>
        This is a higher-education learning tool and is not directed at children
        under 13. Contact the operator to report an inappropriate account, a
        privacy concern, or a security issue.
      </p>

      <h2>Changes</h2>
      <p>
        This version adds what account deletion does to the projects a teacher
        wrote, and that the account export includes their interviews, backlogs
        and replaced files. The previous version updated the description of
        source files sent for AI review, private teacher-view boundaries,
        retained revision history, browser storage, and exports. The date above
        changes when these data flows change.
      </p>
    </LegalPage>
  );
}
