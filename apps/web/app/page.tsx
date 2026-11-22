import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, GitBranch } from "lucide-react";
import { PublicLayout } from "@/components/landing/PublicLayout";
import { HeroAtmosphere } from "@/components/landing/HeroAtmosphere";
export const metadata: Metadata = {
  title: { absolute: "LearnSDLC — Software clicks when you build it" },
  description:
    "Take a guided project from its first requirements to its next release. Learn the software development lifecycle through real work and feedback.",
  alternates: { canonical: "/" },
};
const phases = [
  ["Requirements", "Ask the right questions."],
  ["Design", "Give the idea a shape."],
  ["Implementation", "Make the pieces work."],
  ["Testing", "Find out what holds up."],
  ["Deployment", "Get it ready to release."],
  ["Maintenance", "Keep making it better."],
] as const;
export default function LandingPage() {
  return (
    <PublicLayout active="home">
      <section className="lh-hero" aria-labelledby="landing-title">
        <HeroAtmosphere />
        <div className="lh-eyebrow">
          <span className="lh-eyebrow-dot" />
          Learn the software development lifecycle
        </div>
        <h1 className="lh-title" id="landing-title">
          <span>Software clicks</span>
          <span className="lh-title-accent">when you build it.</span>
        </h1>
        <p className="lh-intro">
          Take a guided project from its first requirements to its next release.
          Write the code, make the decisions, and understand how it all fits
          together.
        </p>
        <div className="lh-actions">
          <Link href="/register" className="lh-primary">
            Create an account <ArrowUpRight size={18} />
          </Link>
          <Link href="/how-it-works" className="lh-secondary lh-frost">
            See how learning works <ArrowRight size={18} />
          </Link>
        </div>
        <p className="lh-cta-note">
          Start with the first phase of your project. Build your understanding
          through each phase it holds.
        </p>
        <div className="lh-illustration">
          <img
            className="lh-team"
            src="/artwork/team-3d.webp"
            width={2019}
            height={779}
            fetchPriority="high"
            alt="Three 3D learners connecting requirements, code, and software design"
          />
          <div className="lh-figure-note lh-frost">
            <GitBranch size={17} />
            <div>
              <strong>Every decision connects.</strong>
              <span>Understand the whole process.</span>
            </div>
          </div>
        </div>
      </section>
      <section className="lh-content" aria-labelledby="landing-phases">
        <div className="lh-section-heading">
          <div>
            <div className="lh-kicker">Six connected phases. A project holds the ones its teacher chose.</div>
            <h2 id="landing-phases">Go beyond writing code.</h2>
          </div>
          <Link className="lh-text-link" href="/what-you-learn">
            Explore what you’ll learn <ArrowRight size={18} />
          </Link>
        </div>
        <div className="lh-phases">
          {phases.map(([name, caption], i) => (
            <Link
              className="lh-phase lh-frost"
              href={`/what-you-learn#${name.toLowerCase()}`}
              key={name}
            >
              <span className="lh-phase-top">0{i + 1}<ArrowUpRight size={15} aria-hidden /></span>
              <span className={`lh-object lh-object-${i}`} aria-hidden="true" />
              <h3>{name}</h3>
              <span className="lh-phase-caption">{caption}</span>
            </Link>
          ))}
        </div>
        <div className="lh-story-link">
          <h2>
            Don’t just follow the steps.
            <br />
            Learn why they matter.
          </h2>
          <div>
            <p>
              Work from a brief, make something, check it, and use the feedback.
              Each attempt helps you connect your decisions to what happens
              next.
            </p>
            <Link className="lh-text-link" href="/how-it-works#demo">
              Watch the phase walkthroughs <ArrowRight size={18} />
            </Link>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
