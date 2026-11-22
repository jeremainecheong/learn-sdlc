"use client";

/** The working header: location, search, notifications and account. */
import Link from "next/link";
import { LearnerAvatar } from "@/components/experience/LearnerAvatar";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { placeOf } from "@learnsdlc/shared";
import { buildNextSteps } from "@/components/home/derive";
import { shortcutWord } from "@/lib/keys";
import { useSession } from "@/lib/session";
import { useViewAs } from "@/lib/view-as";
import { useSidebar } from "@/lib/sidebar";
import { useProjectMaybe } from "@/lib/useProject";
import { anyLessonsOffered } from "@/lib/scenario";
import { useProjectPalette } from "@/lib/palette";
import { nextChoice, useThemeChoice } from "@/lib/theme";
import { Icon } from "@/components/Icon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BellPanel } from "./BellPanel";
import { Palette } from "./Palette";
import { ShellDialog } from "./ShellDialog";
import { navigationItems, phaseItems } from "./navigation";
import { useDeclaredGroups, useShell } from "./ShellProvider";
import { doorWithTasks, phaseDoorHref } from "./routes";
import { replayTour, tourPageFromPath } from "./tours";
import { useSignOut } from "./useSignOut";
import type { Crumb, PaletteGroup, ShellNav } from "./types";

/**
 * Which widths a crumb is drawn at, counted back from the page you are on:
 * 0 is the current page and is always there, 1 is its parent, and anything
 * further back needs an xl screen. See the comment at the trail below.
 */
function crumbShown(depth: number): string {
  // Written out rather than composed: Tailwind reads these files as text and
  // never sees a class name a template literal builds at runtime.
  if (depth === 0) return "flex";
  if (depth === 1) return "hidden lg:flex";
  return "hidden xl:flex";
}

/** {@link crumbShown} for the separator, which is an inline glyph. */
function chevronShown(depth: number): string {
  if (depth === 0) return "inline-block";
  if (depth === 1) return "hidden lg:inline-block";
  return "hidden xl:inline-block";
}

export function TopBar({
  /** Overrides what the page declared. The layout passes nothing. */
  crumbs,
  /** Only read outside the signed-in shell, where there is no provider. */
  nav,
}: {
  crumbs?: Crumb[];
  nav?: ShellNav;
} = {}) {
  const signOut = useSignOut();
  const shell = useShell();
  const project = useProjectMaybe();
  const user = useSession();
  const viewing = useViewAs();
  const staff = user?.role === 'INSTRUCTOR' || user?.role === 'ADMIN';
  const learning = !staff || Boolean(viewing);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountButton = useRef<HTMLButtonElement>(null);
  const declared = useDeclaredGroups();
  const pathname = usePathname();
  const { rail, toggle } = useSidebar(pathname);
  const theme = useThemeChoice();
  // The shortcut as this machine spells it, settled after mount so the server's
  // render and the first client render agree.
  const [searchKey, setSearchKey] = useState("⌘K");
  useEffect(() => setSearchKey(shortcutWord("K")), []);

  const trail = pathname === "/dashboard" ? [{ label: "Your learning overview" }] : crumbs ?? shell.crumbs;
  const enrollment = project?.enrollment ?? null;
  const currentPhase = project?.currentPhase;
  const phases = enrollment?.phases ?? nav?.phases ?? [];
  const currentPhaseId = project ? currentPhase?.id : nav?.currentPhaseId;
  // Every open phase's tasks, already fetched, which is what lets a door here
  // answer for a quiz. Read once and named, because the
  // palette's own memo binds `project` to something else.
  const details = project?.details;

  /**
   * The project's own rows (criteria, code, tests, artefacts) read here
   * rather than declared by each page.
   *
   * Rows declared page by page would let ⌘K find "US-4" on Home and nothing at
   * all in the workspace, the issue editor or the design room: the same query
   * answered differently depending on which room it was typed in. The rows are
   * memoised off the map
   * already in memory and cost nothing until the map is there.
   */
  const projectGroups = useProjectPalette(enrollment);
  const lessons = anyLessonsOffered(enrollment, project?.details);

  const groups = useMemo<PaletteGroup[]>(() => {
    // "Learn" only where the project offers a lesson.
    const go = navigationItems(user?.role, currentPhase, Boolean(viewing), details, lessons);
    const phaseRows = learning ? phaseItems(phases, currentPhaseId, details) : [];
    // A room that declares its own rows keeps them first (the workspace's
    // open files, the issue editor's criteria), and the project's rows fill in
    // whatever that room did not name. Matching by label so a room that hands
    // over its own "Criteria" is not shadowed by a second group of the same
    // name.
    const named = new Set(declared.map((g) => g.label));
    const project = projectGroups.filter((g) => !named.has(g.label));
    const nextTheme = nextChoice(theme.choice, theme.system);
    return [
      { label: "Go to", items: go },
      ...(learning ? (declared.length ? declared : (nav?.paletteGroups ?? [])) : []),
      ...(learning ? project : []),
      ...(phaseRows.length ? [{ label: "Phases", items: phaseRows }] : []),
      {
        label: "Actions",
        items: [
          // The signed-in frame owns a replayable tour on every page.
          ...(tourPageFromPath(pathname)
            ? [
                {
                  label: "Show me around",
                  detail: "The tour of this page, again",
                  hint: "tour",
                  icon: "info" as const,
                  keywords: "tour help guide coach",
                  onSelect: replayTour,
                },
              ]
            : []),
          {
            // The shortcut is written on the button in the sidebar too; here
            // is where a learner who has never noticed the button finds it.
            label: rail ? "Expand the sidebar" : "Collapse the sidebar",
            detail: "The section nav, full width or a strip of icons",
            hint: shortcutWord("B"),
            icon: rail
              ? ("chevrons-right" as const)
              : ("chevrons-left" as const),
            onSelect: toggle,
          },
          {
            // The theme has a button in the bar; without this row the palette
            // would answer "theme" and "graphite" with nothing at all.
            label:
              nextTheme === null
                ? "Follow your system theme"
                : nextTheme === "graphite"
                  ? "Switch to the dark theme"
                  : "Switch to the light theme",
            detail: "Paper and Graphite, or whichever your machine is set to",
            icon: "sun" as const,
            onSelect: () => theme.set(nextTheme),
          },
          {
            label: "Sign out",
            detail: "End this session on this device",
            icon: "signout" as const,
            onSelect: signOut,
          },
        ],
      },
    ];
  }, [
    declared,
    projectGroups,
    nav?.paletteGroups,
    currentPhaseId,
    phases,
    signOut,
    rail,
    toggle,
    theme,
    pathname,
    user?.role,
    currentPhase,
    viewing,
    learning,
    details,
    lessons,
  ]);

  // One count for the whole app, from the same plan Home draws. It is derived
  // here rather than passed by a page, so it reads the same on Home, Phases,
  // the map, the journal, the shelf and the workspace.
  const steps = useMemo(
    () =>
      enrollment
        ? buildNextSteps(enrollment, project?.details ?? {}, currentPhase).steps
        : [],
    [enrollment, project?.details, currentPhase],
  );
  // The bell's foot goes through the phase's door when the
  // shell holds the phase; the nav-only shell has an id and nothing else.
  const workspaceHref =
    shell.notificationsHref ??
    nav?.notificationsHref ??
    (currentPhase
      ? // The door, with the task list the shell already holds for every open
        // phase.
        phaseDoorHref(doorWithTasks(currentPhase, details))
      : currentPhaseId
        ? `/workspace/${currentPhaseId}`
        : undefined);

  return (
    <header
      className="shell-topbar print-hide"
      data-testid="nav"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-3.5">
        {trail.length > 0 && (
          <>
            <nav aria-label="Breadcrumb" className="shell-breadcrumb min-w-0">
              <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0 text-[13.5px] font-medium text-ink2">
                {trail.map((c, i) => {
                  const last = i === trail.length - 1;
                  // Earlier crumbs drop out rather than every crumb being
                  // shaved to nothing. With every `<li>` `min-w-0 truncate`,
                  // at 768 the whole trail would shrink together and "Work"
                  // would be drawn five pixels wide: one glyph and an
                  // ellipsis, while the page below had 600px of empty space.
                  // The page you are on is always named
                  // in full; its parent joins at lg and the rest at xl.
                  const depth = trail.length - 1 - i;
                  return (
                    <li
                      key={`${c.label}-${i}`}
                      className={`${crumbShown(depth)} min-w-0 items-center gap-1.5`}
                    >
                      {i > 0 && (
                        <Icon
                          name="chevron-right"
                          size={12}
                          // The separator belongs to the crumb before it, so
                          // it goes when that crumb goes and no trail ever
                          // opens with a stray chevron.
                          className={`${chevronShown(depth + 1)} shrink-0 text-dim`}
                        />
                      )}
                      {c.href && !last ? (
                        <Link
                          href={c.href}
                          className="truncate rounded-sm hover:text-ink"
                          data-testid={c.testId}
                        >
                          {c.label}
                        </Link>
                      ) : (
                        <span
                          className={`truncate ${last ? "max-w-[32ch] text-ink" : ""}`}
                          aria-current={last ? "page" : undefined}
                        >
                          {c.label}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>
          </>
        )}
      </div>

      <div className="shell-top-actions">
        <Palette groups={groups} trigger={<button type="button" data-testid="jump-to" className="shell-search-trigger" aria-label="Search learning and project" aria-haspopup="dialog" title={`Search (${searchKey})`}><Icon name="search" size={18} /></button>} />
        <BellPanel
          steps={steps}
          phase={currentPhase}
          place={currentPhase ? placeOf({ phases }, currentPhase.key) || undefined : undefined}
          phases={phases}
          workspaceHref={workspaceHref}
        />

        {/* The name arrives with the session, and the whole right-hand group
            slid left when it did. The link keeps a name's worth of width from
            the first frame. */}
        {!user && (
          <span
            aria-hidden
            className="hidden h-[18px] w-[84px] shrink-0 sm:inline-block"
          />
        )}
        {user && (
          <div className="shell-profile-menu">
            <button type="button" ref={accountButton} data-testid="nav-user" aria-label="Open account menu" title={user.displayName} aria-haspopup="dialog" aria-expanded={accountOpen} onClick={() => setAccountOpen(true)}>
              <LearnerAvatar avatar={user.avatar} size={33} /><span className="shell-profile-name">{user.displayName}</span><Icon name="chevron-down" size={12} />
            </button>
            <ShellDialog open={accountOpen} onClose={() => setAccountOpen(false)} anchor={accountButton} label="Your account" testId="account-menu" className="shell-account-dialog">
            <div className="shell-menu-heading"><strong>Your account</strong><button type="button" className="shell-icon-button" aria-label="Close account menu" onClick={() => setAccountOpen(false)}><Icon name="cross" size={18} /></button></div>
            <nav className="shell-profile-links" aria-label="Your account" onClick={event => { if ((event.target as Element).closest('a,button[data-close-menu]')) setAccountOpen(false); }}>
              <strong title={user.displayName}>{user.displayName}</strong>
              <Link href="/profile" data-testid="nav-profile"><Icon name="user" size={16} />My profile</Link>
              {learning && <Link href="/progress" data-testid="nav-evidence"><Icon name="artefacts" size={16} />My progress and evidence</Link>}
              {staff && <Link href="/teacher"><Icon name="class" size={16} />My classes</Link>}
              <Link href="/account" data-testid="nav-account"><Icon name="sliders" size={16} />Account settings</Link>
              {tourPageFromPath(pathname) && <button type="button" data-close-menu onClick={replayTour} data-testid="show-me-around"><Icon name="info" size={16} />Show me around</button>}
              <div className="shell-theme-choice"><span>Appearance</span><ThemeToggle /></div>
              <button type="button" data-close-menu onClick={signOut} data-testid="logout"><Icon name="signout" size={16} />Sign out</button>
            </nav>
            </ShellDialog>
          </div>
        )}
      </div>
    </header>
  );
}
