"use client";
import Link from "next/link";
import { doorWithTasks, phaseDoorHref } from "@/components/shell/routes";
import {
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Compass,
  GitBranch,
  MousePointer2,
  NotebookTabs,
} from "lucide-react";
import { ExperiencePage } from "@/components/experience/shared";
import { PHASE_KEYS } from "@/components/phases/experience";
import { PhaseArtwork } from "@/components/phases/PhaseArtwork";
import { LESSONS } from "@/components/learn/content";
import { useProject } from "@/lib/useProject";
import { useSession } from "@/lib/session";
import { lessonsOfferedOn } from "@/lib/scenario";
import { PHASE_META } from "@/lib/phase";
import { PhaseMap } from "@/components/learn/PhaseMap";
import { PHASE_MAKES, PHASE_NAMES, mapNodes } from "@/components/learn/phase-map";
import { GUIDE_CARD } from "@/components/learn/hero";
import { PhaseGlyph } from "@/components/learn/figures/PhaseGlyph";
import { HowChecksWorkSlot } from "@/components/learn/HowChecksWorkSlot";
import "@/components/learn/lesson-hero.css";
export default function LearnPage() {
  const { enrollment, details, loading } = useProject();
  const user = useSession();
  const staff = user?.role === "INSTRUCTOR" || user?.role === "ADMIN";
  const phase = enrollment?.phases.find(
    (item) => item.status !== "passed" && item.status !== "locked",
  );
  // Each guide teaches the reference project's phase, so the catalogue lists
  // only the phases this enrolment is offered. While the enrolment is in
  // flight nothing is listed, so a cold load never draws a guide it then
  // takes back.
  const settling = Boolean(loading) && !enrollment;
  const offered = settling
    ? []
    : PHASE_KEYS.filter((key) => lessonsOfferedOn(enrollment, key, details));
  const none = !settling && offered.length === 0;
  return (
    <ExperiencePage
      title="Learn"
      eyebrow=""
      active="learn"
      actions={
        <Link
          className="exp-button"
          href={
            staff
              ? "/teacher"
              : phase
                ? phaseDoorHref(doorWithTasks(phase, details))
                : "/dashboard"
          }
        >
          {staff ? "Back to teaching" : "Go to my project"}
          <ArrowUpRight size={15} />
        </Link>
      }
    >
      <div
        className="learn-library"
        data-testid="learn-catalogue"
        aria-busy={settling || undefined}
      >
        <header className="learn-library-hero">
          <div>
            <span className="learn-eyebrow">Your learning library</span>
            <h2>
              A guide when
              <br />
              you need one.
            </h2>
            <p>
              Optional lessons to help you make sense of the work. Explore an
              example, look up a concept, or return to your project whenever
              you’re ready.
            </p>
            {!none && (
              <span className="learn-welcome-note">
                <Bookmark size={13} />
                Pick a lesson. Take what helps. Keep building.
              </span>
            )}
          </div>
          <img
            src="/artwork/learn-library-3d.webp"
            width={260}
            height={260}
            alt="A small cyan glass library holding learning cards, a navy book, and an ivory bookmark"
          />
        </header>
        {/* The lifecycle map, drawn once the enrolment has settled and
            some guide is offered. */}
        {!settling && !none && <PhaseMap nodes={mapNodes(enrollment, offered)} />}
        {/* "How LearnSDLC checks your work", the five-step walk through
            propose, explain, apply (components/learn/HowChecksWorkSlot.tsx). */}
        {!settling && !none && <HowChecksWorkSlot />}
        {offered.length > 0 && (
          <section>
            <header className="learn-section-heading">
              <h2>Explore a guide</h2>
              <span>All optional. Use them alongside your project</span>
            </header>
            {/* One card per offered guide, in phase order, all in one
                design. The list keeps the
                `learn-phase-list` class: the Learn tour's "Choose a guide"
                mark points at its first card's link (components/shell/tours.ts). */}
            <ol className="learn-phase-list">
              {offered.map((key) => {
                const card = GUIDE_CARD[key];
                return (
                  <li key={key} className="learn-feature" data-phase={key}>
                    <div className="learn-feature-top">
                      <PhaseArtwork phaseKey={key} />
                      <div>
                        {/* LearnSDLC's own six guides, numbered by LearnSDLC's model, not a project's places. */}
                        <span className="learn-eyebrow">
                          Phase 0{PHASE_META[key].order} / {LESSONS[key].chapters.length} chapters
                        </span>
                        <h3>
                          <PhaseGlyph phaseKey={key} size={22} />
                          {PHASE_NAMES[key]}
                        </h3>
                      </div>
                    </div>
                    <p className="learn-feature-promise">{card.promise}</p>
                    <p className="learn-makes"><span>You make:</span> {PHASE_MAKES[key][0]}</p>
                    <div className="learn-guide-meta">
                      <span>
                        <NotebookTabs size={14} />
                        {LESSONS[key].chapters.length} chapters
                      </span>
                      <span>
                        <MousePointer2 size={14} />
                        Interactive examples
                      </span>
                      {card.extra && (
                        <span>
                          <GitBranch size={14} />
                          {card.extra}
                        </span>
                      )}
                    </div>
                    <div className="learn-topics">
                      {card.topics.map((topic) => (
                        <span key={topic}>{topic}</span>
                      ))}
                    </div>
                    {/* One name form for every card, the phase's own name
                        capitalised ("Open Design guide"). Only the web tests
                        use these names; no e2e spec, tour or driver does. */}
                    <Link
                      className="exp-button exp-primary"
                      href={`/learn/${key}`}
                      aria-label={`Open ${PHASE_NAMES[key]} guide`}
                    >
                      Open guide
                      <ArrowRight size={15} />
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
        {none && (
          <p className="learn-bottom-note" data-testid="learn-none">
            <Compass size={15} />
            The guides here follow the reference project’s phases, and none of
            them matches a phase of your project. Your phase briefs say what
            each phase asks of you.
          </p>
        )}
        {!none && !settling && (
          <p className="learn-bottom-note">
            <Compass size={15} />
            Your project is where you apply it. Come back here whenever a little
            guidance would help.
          </p>
        )}
      </div>
    </ExperiencePage>
  );
}
