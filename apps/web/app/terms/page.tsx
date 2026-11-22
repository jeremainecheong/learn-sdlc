import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "The rules for using LearnSDLC: what you may run in the sandbox, who owns the work you write, academic honesty, and the limits of the service.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated="10 September 2026">
      <p className="lede">
        Plain terms for an educational tool. By creating an account you agree to
        these.
      </p>

      <h2>What this is</h2>
      <p>
        LearnSDLC is a teaching platform. You carry a project — a reference
        project, or one your teacher sets — through the phases of the software
        development life cycle the project holds (LearnSDLC has six; a project
        holds the ones its teacher chose).
        Reviews assess your submitted evidence against phase requirements. A
        completion record documents your learning; it is not a professional
        qualification.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>One account per person. Keep your password to yourself.</li>
        <li>
          Give a working email address. It is how you sign in, and how we would
          reach you about your account. If you lose your password, use the reset
          link on the sign-in page; if you no longer control the email address,
          contact the address at the bottom of this page.
        </li>
        <li>
          Tell us promptly if you believe someone else is using your account.
        </li>
      </ul>

      <h2>The sandbox</h2>
      <p>
        Coursework can run in the installation’s execution environment. Use it
        responsibly:
      </p>
      <ul>
        <li>
          Run only code that is part of your coursework. Do not use the sandbox
          for mining, scanning, proxying, hosting, or anything unrelated to the
          exercise.
        </li>
        <li>
          Do not attempt to escape the sandbox, reach the network from inside
          it, read other learners&apos; data, or exhaust shared resources on
          purpose.
        </li>
        <li>
          Do not attempt to extract hidden test suites, seeded bug variants or
          reference solutions. They are the assessment; taking them defeats the
          point and spoils it for everyone.
        </li>
      </ul>
      <p>
        Execution has configured resource and time limits. Available tools and
        isolation depend on the installation. Do not assume a successful check
        means that your project has been released to a public service.
      </p>

      <h2>The AI mentor</h2>
      <p>
        Each phase has its own mentor. Guided mode helps you reason through the
        work with hints and questions. Agentic mode can propose changes when
        your request supplies adequate intent, context, and constraints. Before
        a proposal can be applied, you must explain what it does and why it
        meets the requirements, and authorize the accepted changes. Editing a
        proposal requires a new review of your understanding.
      </p>
      <p>
        Model output can be wrong. Treat it as a prompt to think, not as an
        authority, and check anything it tells you against the code you are
        actually running.
      </p>
      <p>
        AI features depend on the configured provider and usage limits. A
        provider failure does not count as a successful review. You can keep
        editing saved work while AI assistance is unavailable.
      </p>

      <h2>Academic honesty</h2>
      <p>
        Submit work that you understand, and follow your institution’s rules on
        assistance and attribution when using LearnSDLC for credit. Teachers of
        a class you join can inspect submitted work, review history, and
        activity metrics. Private mentor conversation text is not part of the
        teacher portal. Activity counts alone are not a finding of academic
        misconduct.
      </p>

      <h2>Reviews and progression</h2>
      <p>
        Reviews return Pass or Needs revision, with evidence and feedback. Each
        phase must pass before the next project phase opens, and every phase
        of the project must pass for course completion. Lessons are optional. You can revise
        and resubmit; earlier submissions and verdicts remain in your history.
        Teacher comments and acknowledgments do not replace an AI verdict.
      </p>

      <h2>Independent learning and classes</h2>
      <p>
        You can study independently or join a class. Joining gives authorized
        teachers access to the class learning records described in the privacy
        policy. Leaving a class preserves your project and learning history.
      </p>

      <h2>Who owns what</h2>
      <ul>
        <li>
          <strong>You own what you write.</strong> Your requirements, design,
          code, tests and reflections are yours. We store and process them only
          to run the service for you.
        </li>
        <li>
          <strong>We own the course material.</strong> The reference projects,
          phase content, rubrics, hidden test suites and seeded bug variants
          remain ours. You may use them for your own learning; do not
          redistribute them.
        </li>
      </ul>

      <h2>Availability</h2>
      <p>
        The service is provided as is, without warranty. It may be unavailable
        for maintenance, it may change, and it may be discontinued. Keep your
        own copy of anything you would be sorry to lose — the account page can
        export your data as JSON at any time.
      </p>

      <h2>Suspension</h2>
      <p>
        Accounts that abuse the sandbox, attempt to extract assessment material,
        or degrade the service for others may be suspended or removed.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent permitted by law, we are not liable for indirect or
        consequential loss arising from use of the service, including loss of
        coursework. This does not limit liability that cannot be limited by law.
      </p>

      <h2>Changes</h2>
      <p>
        If these terms change materially, the date at the top will change.
        Continuing to use the service after that means you accept the revised
        terms.
      </p>
    </LegalPage>
  );
}
