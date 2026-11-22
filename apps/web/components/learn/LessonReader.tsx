"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { lessonChapter, updatePageQuery } from "@/lib/navigation";
import { PHASE_TITLES, placeLabel, type PhaseKey } from "@learnsdlc/shared";
import { PHASE_META } from "@/lib/phase";
import { DocPage, PersonaPanel, doorWithTasks, phaseDoorHref } from "@/components/shell";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  MapPin,
  MessageCircle,
  Play,
} from "lucide-react";
import { useProject } from "@/lib/useProject";
import { PHASE_EXPERIENCE } from "@/components/phases/experience";
import { LESSONS, type LessonChapter } from "./content";
import { GUIDE_HERO } from "./hero";
import "./lesson-hero.css";
import { PHASE_STUDY } from "./study";
import { ReasoningExercise, StudyRecap, Takeaway, WorkedExample } from "./StudyWalkthrough";
import { ChapterFigures } from "./figures/ChapterFigures";
import { PhaseGlyph } from "./figures/PhaseGlyph";
import { TermParagraphs } from "./figures/LessonTerm";
import { codeFragments } from "./figures/CodeText";

const LETTERS = ["A", "B", "C"];

/** "Check yourself": the chapter's ungraded question as three option cards.
 * "Check my reasoning" draws the chosen option's own feedback under that
 * card; choosing again clears it. */
export function Practice({ chapter }: { chapter: LessonChapter }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const fits = selected === chapter.correct;
  return (
    <section className="lesson-practice">
      <span className="learn-eyebrow">Ungraded practice</span>
      <h3>{codeFragments(chapter.question)}</h3>
      <fieldset>
        <legend className="sr-only">Choose an answer</legend>
        {chapter.options.map((option, i) => (
          <div className="lesson-practice-option" key={i} data-chosen={selected === i || undefined}>
            <label>
              <input
                type="radio"
                name={`practice-${chapter.title}`}
                checked={selected === i}
                onChange={() => {
                  setSelected(i);
                  setChecked(false);
                }}
              />
              <span className="lesson-practice-letter" aria-hidden="true">{LETTERS[i]}</span>
              <span>{codeFragments(option)}</span>
            </label>
            {checked && selected === i && (
              <p className="lesson-practice-feedback" role="status" data-fits={fits}>
                <strong>
                  {fits ? "That fits this example. " : "Revisit the example. "}
                </strong>
                {codeFragments(chapter.optionFeedback[i] ?? chapter.feedback)}
              </p>
            )}
          </div>
        ))}
      </fieldset>
      <button
        type="button"
        className="btn-secondary btn-sm"
        disabled={selected === null}
        onClick={() => setChecked(true)}
      >
        Check my reasoning
      </button>
      <small>
        This exercise checks only the displayed example. It does not assess or
        change your project.
      </small>
    </section>
  );
}
/** A "Where you use this" label split into its room ("Testing room") and
 * the rest (", Planted bugs page"). Only the room is a link, because the
 * link opens the phase's room, not the tab or page the rest names. */
export function splitWhere(where: string): { room: string; rest: string } {
  const match = /^(.*?\broom)(.*)$/.exec(where);
  return match ? { room: match[1], rest: match[2] } : { room: where, rest: '' };
}

export function LessonReader({ phaseKey }: { phaseKey: PhaseKey }) {
  const { enrollment, details } = useProject();
  const query = useSearchParams();
  const chapterIndex = lessonChapter(query?.get("chapter") ?? null, LESSONS[phaseKey].chapters.length);
  const [mentorOpen, setMentorOpen] = useState(false);
  const [mentorVisited, setMentorVisited] = useState(false);
  const askButton = useRef<HTMLButtonElement>(null);
  const mentorPanel = useRef<HTMLDivElement>(null);
  const chapterHeading = useRef<HTMLHeadingElement>(null);
  const previousChapter = useRef(chapterIndex);
  const openChapter = (index: number) => {
    if (index === chapterIndex) {
      chapterHeading.current?.scrollIntoView({ block: "start" });
      chapterHeading.current?.focus({ preventScroll: true });
      return;
    }
    updatePageQuery({ chapter: String(index + 1) });
  };
  useEffect(() => {
    if (previousChapter.current === chapterIndex) return;
    previousChapter.current = chapterIndex;
    chapterHeading.current?.scrollIntoView({ block: "start" });
    chapterHeading.current?.focus({ preventScroll: true });
  }, [chapterIndex]);
  const closeMentor = () => {
    setMentorOpen(false);
    askButton.current?.focus();
  };
  useEffect(() => {
    if (mentorOpen)
      mentorPanel.current
        ?.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
        ?.focus();
  }, [mentorOpen]);
  const lesson = LESSONS[phaseKey];
  const phase = enrollment?.phases.find((item) => item.key === phaseKey);
  const available = phase && phase.status !== "locked";
  const chapter = lesson.chapters[chapterIndex];
  const study = PHASE_STUDY[phaseKey];
  const chapterStudy = study.chapters[chapterIndex];
  const mentor = PHASE_EXPERIENCE[phaseKey];
  const hero = GUIDE_HERO[phaseKey];
  const phaseName = PHASE_TITLES[phaseKey];
  const where = chapterStudy.where ?? `The ${phaseName} room in your project space`;
  const whereParts = splitWhere(where);
  return (
    <div className="lesson-reader-shell">
    <DocPage
      active="learn"
      crumbs={[
        { label: "Learn", href: "/learn" },
        { label: phaseName },
      ]}
      testId={`lesson-${phaseKey}`}
      aside={
        mentorVisited ? (
          <div
            id="lesson-mentor"
            className="lesson-mentor"
            hidden={!mentorOpen}
            ref={mentorPanel}
            aria-label={`${mentor.name}, ${phaseKey} lesson mentor`}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeMentor();
            }}
          >
            <PersonaPanel
              key={phase?.id ?? phaseKey}
              lesson
              phaseKey={phaseKey}
              phaseStateId={phase?.id}
              onClose={closeMentor}
            />
          </div>
        ) : undefined
      }
    >
      <div className="lesson-page-top">
        <Link href="/learn">
          <ArrowLeft size={14} />
          Your learning library
        </Link>
        <span>
          {/* The phase's place in the learner's project where it holds the
              phase; else this guide's number in LearnSDLC's own six, with no
              project count. */}
          {phase && enrollment
            ? placeLabel(enrollment, phaseKey)
            : `Guide ${PHASE_META[phaseKey].order} of LearnSDLC's six`}{" "}
          / {phaseName}
        </span>
      </div>
      {/* One banner for all six guides: the words and the picture are
          the guide's own, from hero.ts; the look is the same. */}
      <header
        className="lesson-hero"
        data-phase={phaseKey}
        style={{ "--phase-accent": mentor.colour } as React.CSSProperties}
      >
        <div>
          <span className="learn-eyebrow">{hero.eyebrow}</span>
          <h1>
            {hero.headline[0]}
            <br />
            {hero.headline[1]}
          </h1>
          <p>{hero.lead}</p>
          <div className="lesson-actions">
            <span>
              <BookOpen size={14} />
              {lesson.chapters.length} chapters
            </span>
            <button
              ref={askButton}
              type="button"
              className="btn-secondary btn-sm"
              aria-expanded={mentorOpen}
              aria-controls="lesson-mentor"
              onClick={() => { setMentorVisited(true); setMentorOpen((value) => !value); }}
            >
              <MessageCircle size={14} />
              Ask {mentor.name}
            </button>
            {available && (
              <Link className="btn-primary btn-sm" href={phaseDoorHref(doorWithTasks(phase, details))}>
                Open project space
                <ArrowUpRight size={14} />
              </Link>
            )}
          </div>
        </div>
        {/* Drawn at the box's height times the art's scale, at its own shape
            (lessons.css), so every guide's picture has Requirements' weight. */}
        <img
          src={hero.art.src}
          alt={hero.art.alt}
          width={hero.art.width}
          height={hero.art.height}
          data-fills-height={hero.art.fillsHeight ? "true" : undefined}
          style={{
            "--hero-art-scale": String(hero.art.scale ?? 1),
            "--hero-art-ratio": (hero.art.width / hero.art.height).toFixed(4),
          } as React.CSSProperties}
        />
      </header>
      {/* The guide's path, drawn once for the guide, not in every
          chapter. No step is marked: the path is the guide's, and five of
          the six guides have more steps than chapters, so a mark could be
          true on one guide only. The chapter cards mark the open chapter. */}
      <figure className="lesson-flow lesson-path" style={{ "--phase-accent": mentor.colour } as React.CSSProperties}>
        <figcaption>
          <PhaseGlyph phaseKey={phaseKey} size={18} />
          {hero.path}
        </figcaption>
        <ol>
          {lesson.flow.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </figure>
      <div className="lesson-learning-heading">
        <span className="learn-eyebrow">Your phase brief</span>
        <h2>Understand it. Then put it to work.</h2>
      </div>
      {/* The four chapters as a row of cards over the full-width chapter. */}
      <div className="lesson-layout">
        <nav className="lesson-chapters" aria-label="Lesson chapters">
          <span className="learn-eyebrow">IN THIS GUIDE</span>
          {lesson.chapters.map((item, index) => (
            <button
              type="button"
              key={item.title}
              aria-current={chapterIndex === index ? "step" : undefined}
              onClick={() => openChapter(index)}
            >
              <span>0{index + 1}</span>
              {item.title}
            </button>
          ))}
          <details className="lesson-outcomes">
            <summary>You will learn to</summary>
            <ul>
              {lesson.outcomes.map((outcome) => (
                <li key={outcome}>{codeFragments(outcome)}</li>
              ))}
            </ul>
          </details>
        </nav>
        <article className="lesson-article" style={{ "--phase-accent": mentor.colour } as React.CSSProperties}>
          <span className="learn-eyebrow">
            Chapter {chapterIndex + 1} of {lesson.chapters.length}
          </span>
          <h2 id="lesson-chapter-title" ref={chapterHeading} tabIndex={-1}>
            {chapter.title}
          </h2>
          <p className="lesson-study-objective"><span>In this chapter</span> {codeFragments(chapterStudy.objective)}</p>
          <p className="lesson-where" data-testid="lesson-where">
            <MapPin size={14} aria-hidden="true" />
            <span>Where you use this:</span>{" "}
            {available ? (
              <span>
                <Link href={phaseDoorHref(doorWithTasks(phase, details))}>{whereParts.room}</Link>
                {whereParts.rest}
              </span>
            ) : (
              <strong>{where}</strong>
            )}
          </p>
          {chapterIndex === 0 && <section className="lesson-study-preparation"><h3>Before you begin</h3><p>{codeFragments(study.preparation)}</p></section>}
          <section className="lesson-idea" aria-labelledby="lesson-idea-title">
            <h3 id="lesson-idea-title">The idea</h3>
            <TermParagraphs
              paragraphs={[chapterStudy.explanation, ...chapter.body.split("\n\n")].filter(Boolean)}
              preferred={chapterStudy.term}
            />
          </section>
          {/* The chapter's registered figures (components/learn/figures/registry.ts). */}
          <ChapterFigures phaseKey={phaseKey} chapterIndex={chapterIndex} />
          <WorkedExample key={`walkthrough-${phaseKey}-${chapterIndex}`} chapter={chapterStudy} />
          <section className="lesson-check" aria-labelledby="lesson-check-title">
            <h3 id="lesson-check-title" className="lesson-part-title">Check yourself</h3>
            <Practice key={`practice-${phaseKey}-${chapterIndex}`} chapter={chapter} />
            <ReasoningExercise key={`reasoning-${phaseKey}-${chapterIndex}`} chapter={chapterStudy} />
          </section>
          <Takeaway chapter={chapterStudy} />
          {chapterIndex === lesson.chapters.length - 1 && <StudyRecap study={study} />}
          {/* Only the buttons that go somewhere: no Previous on chapter 1
              (the forward button keeps its place at the row's end). */}
          <footer className="lesson-chapter-footer">
            {chapterIndex > 0 && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => openChapter(chapterIndex - 1)}
              >
                Previous chapter
              </button>
            )}
            {chapterIndex < lesson.chapters.length - 1 ? (
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => openChapter(chapterIndex + 1)}
              >
                Next chapter
              </button>
            ) : (
              <Link
                className="btn-primary btn-sm"
                href={available ? phaseDoorHref(doorWithTasks(phase, details)) : "/learn"}
              >
                {available
                  ? "Bring it to your project"
                  : "Back to the catalogue"}
              </Link>
            )}
          </footer>
          {lesson.videos && (
            <section className="lesson-videos">
              <h3>Watch the idea in practice</h3>
              {/* Every chapter shows the guide's row; each video says the
                  chapter it goes with, and the open chapter's is marked. */}
              <div>
                {lesson.videos.map((video) => {
                  const here = video.chapter === chapterIndex + 1;
                  return (
                  <a
                    href={`https://www.youtube.com/watch?v=${video.id}`}
                    target="_blank"
                    rel="noreferrer"
                    key={video.id}
                    data-this-chapter={here || undefined}
                  >
                    <span className="lesson-video-poster">
                      <img
                        src={`/lessons/video-${video.id}.jpg`}
                        alt={`Video thumbnail: ${video.title}`}
                        width={480}
                        height={360}
                        loading="lazy"
                      />
                      <span aria-hidden>
                        <Play size={18} fill="currentColor" />
                      </span>
                    </span>
                    <strong>{video.title}</strong>
                    <span className="lesson-video-meta">
                      <small>{video.publisher}: Opens YouTube</small>
                      <span className="lesson-video-chapter" data-testid="video-chapter">
                        {video.chapter ? `Goes with chapter ${video.chapter}` : "Goes with the whole guide"}
                      </span>
                      {here && <span className="lesson-video-here">This chapter</span>}
                    </span>
                  </a>
                  );
                })}
              </div>
            </section>
          )}
          <section className="lesson-sources">
            <h3>Sources and further reading</h3>
            <p>
              Examples follow the TaskTrackr phase brief and supplied scaffold.
              External references explain the tools and concepts.
            </p>
            {lesson.sources.map((source) => (
              <a
                href={source.url}
                key={source.url}
                target="_blank"
                rel="noreferrer"
              >
                {source.title} ↗
              </a>
            ))}
          </section>
        </article>
      </div>
    </DocPage>
    </div>
  );
}
