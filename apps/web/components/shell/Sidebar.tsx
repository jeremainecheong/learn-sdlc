"use client";

/** Cyan glass navigation. Pinning reserves 232px; temporary hover or keyboard
 * expansion overlays the content. The default rail is 76px (60px on mobile). */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { shortcutWord } from "@/lib/keys";
import { placeOf } from "@learnsdlc/shared";
import { useRole } from "@/lib/session";
import { useViewAs } from "@/lib/view-as";
import { useSidebar } from "@/lib/sidebar";
import { useProjectMaybe } from "@/lib/useProject";
import { anyLessonsOffered } from "@/lib/scenario";
import { Icon, type IconName } from "@/components/Icon";
import { Mark } from "@/components/Mark";
import { homeHrefFor } from "@/lib/navigation";
import { doorWithTasks, phaseHref } from "./routes";
import { useIsoLayoutEffect } from "@/lib/use-iso-layout-effect";
import { useShell } from "./ShellProvider";
import type { NavKey, ShellNav } from "./types";
import { projectName } from "@/lib/project-name";

interface Entry {
  key: NavKey;
  /** Drawn but invisible: it is holding space for an answer still in flight. */
  held?: boolean;
  href: string;
  label: string;
  icon: IconName;
  testId: string;
  roles: "learner" | "staff" | "admin" | "all";
  /** Pinned to the foot: the class you are in, not a view of your work. */
  foot?: boolean;
}

const ENTRIES: Entry[] = [
  { key: "home", href: "/dashboard", label: "Overview", icon: "home", testId: "nav-home", roles: "learner" },
  { key: "work", href: "/dashboard", label: "My project", icon: "code", testId: "nav-work", roles: "learner" },
  { key: "learn", href: "/learn", label: "Learn", icon: "book", testId: "nav-learn", roles: "learner" },
  { key: "progress", href: "/progress", label: "Progress", icon: "chart", testId: "nav-progress", roles: "learner" },
  { key: "feedback", href: "/feedback", label: "Feedback", icon: "explain", testId: "nav-feedback", roles: "learner" },
  { key: "join", href: "/classroom", label: "My classroom", icon: "people", testId: "nav-join", roles: "learner" },
  { key: "class", href: "/teacher", label: "My classes", icon: "class", testId: "nav-instructor", roles: "staff" },
  // The projects a teacher writes and assigns get a row of their own, beside
  // the classes they are assigned to, rather than an unlabelled overflow on
  // the class page.
  { key: "projects", href: "/teacher/projects", label: "Projects", icon: "layers", testId: "nav-projects", roles: "staff" },
  // The teacher guide, staff only, beside the projects it explains.
  { key: "guide", href: "/teacher/guide", label: "Teacher guide", icon: "book", testId: "nav-guide", roles: "staff" },
  { key: "accounts", href: "/admin", label: "Accounts", icon: "people", testId: "nav-admin", roles: "admin" },
];

/**
 * The rows this browser drew for this learner last time.
 *
 * A row can wait on an answer ("Work" needs a phase to open), so a cold load
 * either inserts it late (every row below moves down) or holds its space and
 * takes it back (every row below moves up 36px). A stored set that names a row
 * `ENTRIES` does not carry (a "Warm-up" row, say) costs nothing, because only
 * the rows `ENTRIES` draws are looked up in it.
 * Neither cost is avoidable while the first frame has to guess. It does not
 * have to guess: the set it settled on last time is written down, so a learner
 * who has been here before gets their own column from the first paint, and the
 * heuristic is left for a browser that has never drawn it.
 */
const NAV_ROWS_KEY = "lsdlc_nav_rows";

function readNavRows(): string[] | null {
  try {
    const raw = window.localStorage.getItem(NAV_ROWS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((k) => typeof k === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeNavRows(keys: string[]): void {
  try {
    window.localStorage.setItem(NAV_ROWS_KEY, JSON.stringify(keys));
  } catch {
    // A browser with storage blocked simply gets the heuristic every time.
  }
}

/** Which entry the route lights, when the page has not said. */
export function navKeyFromPath(pathname: string | null): NavKey | undefined {
  if (!pathname) return undefined;
  if (pathname.startsWith("/learn")) return "learn";
  if (pathname.startsWith("/feedback")) return "feedback";
  if (pathname.startsWith("/progress")) return "progress";
  if (pathname.startsWith("/profile")) return "profile";
  if (pathname.startsWith("/teacher/projects")) return "projects";
  if (pathname.startsWith("/teacher/guide")) return "guide";
  if (pathname.startsWith("/teacher")) return "class";
  if (pathname.startsWith("/classroom")) return "join";
  if (pathname.startsWith("/workspace")) return "work";
  if (pathname.startsWith("/completion")) return "progress";
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/complete"))
    return "home";
  if (pathname.startsWith("/map")) return "map";
  if (pathname.startsWith("/artefacts")) return "artefacts";
  if (pathname.startsWith("/dossier")) return "dossier";
  if (pathname.startsWith("/journal")) return "journal";
  if (pathname.startsWith("/join")) return "join";
  if (pathname.startsWith("/instructor")) return "class";
  if (pathname.startsWith("/admin")) return "accounts";
  if (pathname.startsWith("/account")) return "account";
  return undefined;
}

export function Sidebar({
  active,
  nav,
  className = "",
}: {
  active?: NavKey;
  /** Only read outside the signed-in shell, where there is no provider. */
  nav?: ShellNav;
  className?: string;
}) {
  const pathname = usePathname();
  const shell = useShell();
  const project = useProjectMaybe();
  const own = useRole();
  // While an instructor is viewing a learner's
  // work, the pages being read are the learner's, so these are the entries
  // that lead to them. The account is still the instructor's and every write
  // is still refused; only the navigation follows what is on screen.
  const viewing = useViewAs();
  const role = viewing ? "LEARNER" : own;
  const { rail, toggle } = useSidebar(pathname);

  // ⌘B on a Mac, Ctrl B everywhere else: VS Code's binding for the same
  // thing. Registered here rather than in the hook because the hook has two
  // readers and one key press must switch the width once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "b") return;
      if (document.querySelector('dialog[open]:not(.chat-surface), .chat-surface[aria-modal="true"], [role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const [word, setWord] = useState("⌘B");
  useEffect(() => setWord(shortcutWord("B")), []);

  // "Show me around" replays the tour of the page that is open.
  // Only five pages carry one; everywhere else the button says so and takes
  // no click, rather than leaving the column or doing nothing quietly.

  const current = active ?? shell.active ?? navKeyFromPath(pathname);
  const enrollment = project?.enrollment ?? null;
  const phases = enrollment?.phases ?? nav?.phases ?? [];
  const currentPhaseId = project
    ? project.currentPhase?.id
    : nav?.currentPhaseId;
  const projectTitle = enrollment
    ? projectName(enrollment.projectTitle)
    : nav?.projectTitle;
  // "Work" is the phase the learner is in; without one there is nothing to
  // open, so the entry is not drawn rather than drawn dead.
  const activePhase = phases.find((phase) => phase.id === currentPhaseId);
  // Through the task list the shell already holds, so "Work" opens the paper
  // where a quiz is all the phase has left. The nav-only shell has no map and
  // gets the plain phase href.
  const workHref = activePhase ? phaseHref(doorWithTasks(activePhase, project?.details)) : null;

  /**
   * The column stops moving under the learner's hand.
   *
   * Overview, Progress, Feedback and My classroom are drawn from the first
   * frame, and Learn follows the set this browser remembered until the
   * enrolment answers. "My project" waits on the enrolment, and inserting it
   * once the answer landed would push every row below it 36px down, a
   * visible layout shift on a cold load. While the answer is still in flight
   * the row is drawn and left invisible, so it takes its space and then
   * fills it. A learner who turns out to have no open phase still sees it
   * settle, which is the case this cannot fix without guessing.
   */
  const settling = Boolean(project?.loading);
  const lessons = anyLessonsOffered(enrollment, project?.details);

  // The set this browser drew last time, read before the first paint so the
  // correction is never a frame the learner sees.
  const [remembered, setRemembered] = useState<string[] | null>(null);
  useIsoLayoutEffect(() => setRemembered(readNavRows()), []);

  const entries = useMemo(() => {
    const wanted = (e: Entry): boolean => {
      if (e.key === "work")
        return (
          Boolean(workHref) ||
          (remembered ? remembered.includes("work") : settling)
        );
      // "Learn" leads to the reference project's
      // lessons; an enrolment none of whose phases offers one draws no door.
      // While the enrolment is still in flight the row follows the set this
      // browser settled on last time, so it is not drawn and then taken away.
      if (e.key === "learn") {
        if (settling && !enrollment && remembered) {
          if (!remembered.includes("learn")) return false;
        } else if (!lessons) return false;
      }
      if (e.roles === "all") return true;
      // Only a learner's own rows are worth holding space for. Holding the
      // staff and admin rows too meant the foot of the column lost 72px the
      // moment the role came back LEARNER, which is the common case.
      if (!role)
        return remembered
          ? remembered.includes(e.key)
          : e.roles === "learner" && settling;
      if (e.roles === "learner") return role === "LEARNER";
      if (e.roles === "staff") return role === "INSTRUCTOR" || role === "ADMIN";
      return role === "ADMIN";
    };
    return ENTRIES.filter(wanted).map((e) => {
      if (e.key === "work" && workHref) return { ...e, href: workHref };
      // A row standing in for an answer that has not arrived: it holds the
      // space, takes no click and is not read out.
      const held =
        (e.key === "work" && !workHref) || (!role && e.roles === "learner");
      return held ? { ...e, held: true } : e;
    });
  }, [role, workHref, settling, remembered, lessons, enrollment]);

  // What it settled on, for the next cold load. Written only once every answer
  // is in, so a half-loaded column is never what the next visit is drawn from.
  useEffect(() => {
    if (settling || !role) return;
    writeNavRows(entries.filter((e) => !e.held).map((e) => e.key));
  }, [entries, settling, role]);

  // One element, two shapes, for the life of the session. From `lg` it is the
  // column the design is drawn around; below it there is no room beside the
  // content, so the same links become the strip under the bar. Two elements
  // would mean two of every test id, and a link that exists twice can disagree
  // with itself.
  const [peek, setPeek] = useState(false);
  const suppressPeek = useRef(false);
  const sidebar = useRef<HTMLElement | null>(null);
  const open = !rail || peek;
  const togglePinned = () => { suppressPeek.current = !rail; setPeek(false); toggle(); };

  return (
    <div className="nav-slot relative shrink-0">
      <aside ref={sidebar} id="learning-navigation" aria-label="Learning navigation" data-testid={rail ? "rail" : "sidebar"} data-peek={rail && peek}
        className={`nav-col print-hide ${className}`}
        onPointerEnter={event => { if (event.pointerType !== 'touch' && window.matchMedia('(hover: hover)').matches && !suppressPeek.current) setPeek(true); }}
        onPointerLeave={() => { setPeek(false); suppressPeek.current = false; }}
        onFocusCapture={event => { if (event.target.matches(':focus-visible') && !suppressPeek.current) setPeek(true); }}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setPeek(false); suppressPeek.current = false; } }}
        onKeyDown={event => {
          if (event.key === 'Tab') { suppressPeek.current = false; setPeek(true); }
          if (event.key === 'Escape') { event.preventDefault(); suppressPeek.current = true; setPeek(false); if (!rail) toggle(); sidebar.current?.querySelector<HTMLButtonElement>('[data-testid="sidebar-toggle"]')?.focus(); }
        }}>
        <div className="shell-nav-head">
          <Link href={homeHrefFor(role ? { role } : null)} className="shell-nav-brand" aria-label="LearnSDLC home"><span className="shell-nav-mark"><Mark size={29} /></span><span className="nav-label">learn<span>sdlc</span></span></Link>
          <button type="button" onClick={togglePinned} data-testid="sidebar-toggle" aria-expanded={open} aria-controls="learning-navigation" aria-label={!rail ? 'Collapse the sidebar' : peek ? 'Pin the sidebar open' : 'Expand the sidebar'} title={`${!rail ? 'Collapse' : 'Expand'} the sidebar (${word})`} className="nav-row nav-toggle">
            <Icon name={rail ? 'chevrons-right' : 'chevrons-left'} size={18} strokeWidth={1.7} />
            <span className="nav-label">{!rail ? 'Collapse' : 'Keep open'}</span>
          </button>
        </div>
        <p className="shell-nav-heading nav-label">{role === 'INSTRUCTOR' || role === 'ADMIN' ? 'My teaching' : 'My learning'}</p>
        <nav className="shell-primary-nav" aria-label="Learning sections">
          {entries.map(entry => <NavRow key={entry.key} entry={entry} on={current === entry.key} />)}
        </nav>
        {projectTitle && <div className="shell-current-project nav-label"><span>Current project</span><strong>{projectTitle}</strong>{activePhase && <p>Phase {String(placeOf({ phases }, activePhase.key)).padStart(2, '0')}: {activePhase.title}</p>}</div>}
        <div className="shell-nav-bottom nav-label">Your learning belongs to you.</div>
      </aside>
    </div>
  );
}

function NavRow({ entry, on }: { entry: Entry; on: boolean }) {
  if (entry.held) {
    return (
      <span
        aria-hidden
        className="nav-row invisible flex h-[34px] shrink-0 items-center gap-2.5 whitespace-nowrap rounded-ctl px-2.5 text-[13.5px] font-medium"
      >
        <Icon
          name={entry.icon}
          size={18}
          strokeWidth={1.7}
          className="shrink-0"
        />
        <span className="nav-label">{entry.label}</span>
      </span>
    );
  }
  return (
    <Link
      href={entry.href}
      /**
       * The workspace is the heaviest entry in the build, 324 kB of first-load
       * JS, and Next would prefetch its RSC payload from every signed-in
       * landing and then abort a third of the prefetches when the sidebar
       * re-renders with the enrolment: the server renders the payload, the
       * browser throws it away, and every route reports failed requests. Off
       * by default here; Next still prefetches
       * it on hover and on focus, which is a beat before the click either way.
       */
      prefetch={entry.key === "work" ? false : undefined}
      data-testid={entry.testId}
      aria-current={on ? "page" : undefined}
      title={entry.label}
      aria-label={entry.label}
      className={`nav-row flex h-[34px] shrink-0 items-center gap-2.5 whitespace-nowrap rounded-ctl px-2.5 text-[13.5px] transition-colors ${
        on
          ? "bg-tint font-semibold text-ink"
          : "font-medium text-ink2 hover:bg-raised hover:text-ink"
      }`}
    >
      <Icon
        name={entry.icon}
        size={18}
        strokeWidth={1.7}
        className={`shrink-0 ${on ? "text-accent" : "text-muted"}`}
      />
      <span className="nav-label">{entry.label}</span>
    </Link>
  );
}
