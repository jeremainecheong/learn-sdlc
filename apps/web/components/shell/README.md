# The shell

Everything the signed-in pages are drawn in. Import from `@/components/shell`;
the files behind the barrel are an implementation detail.

```tsx
import { DocPage, WorkPage, PhaseStrip, PersonaPanel, Thumb } from '@/components/shell';
```

Two frames, and you pick by what the page is for. **`DocPage`** is for pages
that are read: the map, a study guide, a phase's brief, the pull request, the
kill matrix, the incident drill, the change request, the reference solution,
a quiz, a run, and the teacher's version pages. **`WorkPage`** is for pages
that are worked in: the phase workspace, the Requirements room, the Design
room and the document pages drawn in the workspace's frame. The difference is
width: a doc page has a 1440 column with air around it, a work page fills the
viewport and scrolls inside its own panes.

## The layout owns the shell

`app/(app)/layout.tsx` mounts the bar and the sidebar **once**, above the
router, and every signed-in page is drawn inside them:

```tsx
<SessionGate>              {/* no token, no signed-in pages */}
  <ProjectProvider>        {/* one loader for the whole session */}
    <ProjectEntry>         {/* "Opening your project…" until the first answer */}
      <ShellProvider>      {/* what the page declares about the chrome */}
        <AppFrame>{children}</AppFrame>
      </ShellProvider>
    </ProjectEntry>
  </ProjectProvider>
</SessionGate>
```

So a navigation changes the text inside the chrome rather than replacing it.
If each page rendered its own `<TopBar>` and `<Sidebar>`, every click would
throw the shell away and build a new one, and the new one would arrive in
pieces: a sidebar with one row while a role effect ran, no learner name, the
wrong theme icon, a bell that counted on one page and nowhere else.

**`DocPage` and `WorkPage` do not render the bar or the sidebar.** They render
their content column and *declare* the rest.

| declared | what it does | when nothing is declared |
|---|---|---|
| `crumbs` | breadcrumbs in the bar | cleared on unmount |
| `active` | which nav entry is lit | falls back to `navKeyFromPath` |
| `nav.paletteGroups` | this page's ⌘K rows | the palette keeps the routes, the phases and Sign out |
| `nav.notificationsHref` | where the bell panel's foot link goes | the current phase |

Everything else the chrome needs (the project's phases, the current phase, the
bell's count) is **derived inside the shell** from `ProjectProvider`. A page
does not pass it and cannot make it disagree with the page next door. The rest
of `ShellNav` is accepted and ignored, so a page may hand over what
`railOf(...)` (`lib/rail.ts`) builds.

Declaring happens in a layout effect, so the shell has the new page's
configuration in the same commit that mounts it, before the browser paints.

```tsx
useShellConfig({ crumbs, active, paletteGroups });
```

**The sidebar's width is not declared.** If it were, pages side by side could
ask for different widths and walking between them would snap the column back
and forth. It is the learner's: see [the sidebar's two widths](#the-sidebars-two-widths).

`useShell()` reads the current declaration; `useDeclaredGroups()` reads the
palette rows. Both are safe outside the provider, where they return the
default, so a component can be rendered inside the signed-in shell and outside
it.

## Nothing refetches on a mount

`ProjectProvider` (`lib/useProject.tsx`) owns one copy of the catalogue, the
enrolment, its analytics and every open phase's detail. `useProject()` is a
context read over that one copy.

- A page mount **never** refetches. The copy in memory is used as it stands
  until it is a minute old (`FRESH_MS`).
- A refresh happens on `invalidateProject()`, on `reload()`, on
  `switchTo(slug)`, and when the window regains focus or becomes visible with
  a copy older than a minute.
- `revalidating` never puts a skeleton on the screen. `loading` is true only
  when there is nothing to show at all.
- `details[phaseId]` is the phase detail the workspace uses as its initial
  data rather than waiting for its own request.

`invalidateProject()`, which the workspace calls after a run, a submission or
a merge, marks the copy stale and starts the refetch there and then. It does
not empty the cache: the copy stays on screen, `revalidating` goes true,
`loading` stays false, and the fresh answer replaces the old one when it
lands. `resetProject()` does empty it, for a change of subject: a different
project or a different learner (`onSessionEnd`).

`lib/records.ts` holds the per-phase records (submissions, runs and mentor
exchanges), keyed by phase id and owned by the token the same way
(`cachedRecords` / `loadRecords`). They are read synchronously on mount and
refreshed in the background, so a revisit draws the finished page in its first
commit. `staleRecords()` and
`refreshPhaseRecords(phaseId)` do to them what `invalidateProject()` does to
the project (keep what is held, refetch now), and `resetRecords()` is the hard
clear.

## Who is signed in

`lib/session.ts` is a small external store: `getSession()`, `subscribe()`,
`setSession(user)`, `clearSession()`, `onSessionEnd(fn)`, `ownedByToken(drop)`
and `useSession()` / `useRole()` built on `useSyncExternalStore` with a `null`
server snapshot. `lib/api.ts`'s `storeAuth` / `clearAuth` / `getStoredUser` go
through it, and so does anything that edits the profile.

Nothing reads the stored user directly. The bar and the sidebar read the store
during render, not in an effect keyed on the pathname, which would cost a frame
on every navigation. One flip on the first hydration of a full page load is
unavoidable; a flip on a client navigation is a bug.

---

## Shared types

All in `types.ts`.

```ts
type Crumb = { label: string; href?: string; testId?: string };  // the last one is the page
type NavKey = 'home' | 'learn' | 'progress' | 'feedback' | 'profile'
            | 'map' | 'work' | 'artefacts' | 'dossier' | 'journal'
            | 'join' | 'class' | 'projects' | 'guide' | 'accounts' | 'account';

interface ShellNav {
  // Derived from ProjectProvider inside the shell. Accepted, ignored.
  projectTitle?: string;
  phases?: PhaseSummary[];
  currentPhaseId?: string;
  tokensToday?: number;
  notifications?: number;

  // Read from the page:
  notificationsHref?: string;     // the bell panel's foot link (default: the current phase)
  paletteGroups?: PaletteGroup[]; // this page's criteria, code, tests, artefacts
}

interface PaletteItem  { label: string; detail?: string; hint?: string;
                         icon?: IconName; phaseKey?: PhaseKey; place?: number;
                         href?: string; disabled?: boolean; onSelect?: () => void;
                         keywords?: string }
interface PaletteGroup { label: string; items: PaletteItem[] }
```

`Crumb.testId` exists because the browser tests press a page's way back by
its id: a workspace page's project crumb carries `back-dashboard`.

---

## `<DocPage>`

```tsx
<DocPage
  crumbs={[{ label: 'TaskTrackr', href: '/dashboard' }, { label: 'Pull request' }]}
  nav={nav}
  title="PR-3"
  chips={<PhaseLine phaseKey="implementation" title="Implementation" />}
  right={<Button href={workHref} testId="continue-phase">Open the workspace</Button>}
  titleTestId="pr-title"
>
  {/* panels */}
</DocPage>
```

| prop | type | what it does |
|---|---|---|
| `crumbs` | `Crumb[]` | Breadcrumbs in the top bar. The last is the page, not a link. |
| `active` | `NavKey` | Which sidebar entry is lit. Defaults to the route. |
| `nav` | `ShellNav` | Only `paletteGroups` (this page's ⌘K rows) and `notificationsHref` are read. |
| `title` | `ReactNode` | The h1. Omit it if the page draws its own heading. |
| `purpose` | `ReactNode` | One line under the title, muted. |
| `purposeInline` | `boolean` | Stacks the purpose under the title inside the title row's left block, for a page whose controls sit on the same row (the map). |
| `chips` | `ReactNode` | Sits on the title's baseline: a phase line, chips, a count. |
| `right` | `ReactNode` | Buttons at the right of the title row. |
| `aside` | `ReactNode` | A full-height column flush against the right edge, beside `<main>` (the map's node inspector). |
| `testId` | `string` | Goes on `<main>`. |
| `titleTestId` | `string` | Goes on the h1. |
| `children` | `ReactNode` | The page's panels. |

The frame owns the column and its width. Do not add your own `<main>` or width.

## `<WorkPage>` and `<PhaseStrip>`

```tsx
<WorkPage
  crumbs={[{ label: 'TaskTrackr', href: '/dashboard', testId: 'back-dashboard' }, { label: 'Code' }]}
  nav={nav}
  strip={
    <PhaseStrip
      phase={phase}
      titleLevel={1}
      headline="Make manager.py true to your contracts"
      right={<Button size="sm" testId="header-submit">Submit again</Button>}
    />
  }
>
  <div className="flex min-h-0 flex-1">{/* explorer | editor | panel */}</div>
</WorkPage>
```

`WorkPage`: `crumbs`, `active` (defaults to `'work'`), `nav`, `heading`,
`strip`, `testId`, `children`. It renders the strip and a `flex-1 min-h-0` box
for the page's columns. A working *route* opens on the sidebar's rail, which
`lib/sidebar.ts` decides from the path rather than this frame.

`PhaseStrip`: `phase` (needs `key` and `title`; `dueAt`, `place` and `count`
when the caller has them), `titleLevel`, `headline`, `chips`, `right`,
`rowLine`, `menuLine`, `workHeader`, `state`, `testId` (defaults to
`phase-strip`). It draws the phase's artwork and name, its place in the project
("Phase 2 of 3", `phase-place`) and, on a work header, the state chip the
workspace header shows (`phase-state`); chips and buttons sit to the right.

`titleLevel={1}` makes the phase's name the room's `h1`. Every working room
passes it and passes no `heading` to `WorkPage`; otherwise the room's only
heading would be `WorkPage`'s screen-reader one. A room with no strip yet (the
workspace before its phase lands) keeps `WorkPage`'s `heading`, so no route is
ever nameless.

A caller that hands `PhaseStrip` a whole `PhaseDetail` gets a chip reading
"Due 16 September at 23:59" (`warn` once past, `phase-strip-due`); a caller
with a literal `{ key, title }` simply has no date.

## `<TopBar>` and `<Sidebar>`

The layout mounts both, with no props. Everything they draw comes from the two
providers.

`<TopBar />`: the breadcrumbs, then `jump-to` (the palette), the bell, and
`nav-user`, which opens the account menu (`account-menu`: `nav-profile`,
`nav-evidence`, `nav-account`, `show-me-around`, the appearance choice
`theme-toggle`, and `logout`).

`<Sidebar />`: `full` draws the words, `rail` the icons with `aria-label`
tooltips, and the switch is an attribute on the same element. Below `lg` the
column becomes the scrolling strip under the bar. Test ids are the same in
every shape, and `data-testid` moves between `sidebar` and `rail` without the
element ever being replaced. Learners see `nav-home`, `nav-work`, `nav-learn`,
`nav-progress`, `nav-feedback` and `nav-join`; staff see `nav-instructor`,
`nav-projects` and `nav-guide`; administrators also see `nav-admin`.

`navKeyFromPath(pathname)` gives the `NavKey` a route lights.

### The sidebar's two widths

No page collapses the sidebar. The learner does, with `sidebar-toggle` at the
head of the column or **⌘B** (Ctrl B off a Mac) from anywhere, and the choice
is kept. `lib/sidebar.ts` owns it.

| context | routes | key | first visit |
|---|---|---|---|
| `doc` | everything else | `lsdlc_sidebar` | `rail` |
| `ide` | `/workspace/:id` and its `design`, `issue`, `interview`, `brief`, `pr`, `matrix`, `drill`, `change` and `solution` pages (`WORK_PATH`) | `lsdlc_sidebar_ide` | `rail` |

Two keys, because code needs the width: widening the column in the workspace
is remembered *for the workspace*, and leaving it returns to whatever the
learner chose for the document pages.

The width has to be right in the **first paint**, before React exists, or a
reload shows the other shape for a frame. So:

- `SIDEBAR_BOOT_SCRIPT` runs inline in `<head>` (`app/layout.tsx`, beside the
  theme's), reads the path and the key it names, and stamps `data-sidebar` on
  `<html>`.
- The stylesheets draw both shapes off that attribute (`shell-fidelity.css`
  sets the column's width, 76px on the rail and 232px in full). Same element,
  same markup, one attribute.
- React keeps a copy for the two things CSS cannot say, the `data-testid` and
  the button's label, synced by `useSidebar(pathname)` in a layout effect,
  which is also what changes the attribute on a client navigation, before the
  new page paints.

A new working page has to be named in `WORK_PATH` in `lib/sidebar.ts` as well
as built on `WorkPage`: the boot script reads the path and nothing else,
because it runs before any page can declare anything.

### The bell

The bell counts two things. One is the steps of `buildNextSteps(enrollment,
details, currentPhase)` (`components/home/derive.ts`) that have not passed,
computed in the bar from the provider, so it reads the same on every page.
The other is what has happened since the learner last looked
(`lib/notifications.ts`): a gate passed, a review posted, a deadline near, a
note from a teacher; on the staff side, who is stuck, flagged or asking for
help.

Pressing it opens a panel under the button rather than navigating: one row per
thing waiting, each a link to where it is dealt with, and a foot link to the
current phase. `Escape`, a click outside, the button again and any route
change close it; focus goes into the panel on open and back to the button on
close. Test ids: `bell`, `bell-panel`, `bell-item`, `bell-open-workspace`,
`bell-empty`, `bell-mark-all`.

### The theme icon

Both icons are in the DOM, and CSS picks between them from the `data-theme`
the boot script stamps on `<html>` before React runs (`.when-paper` /
`.when-graphite` in `globals.css`). That is the only way the toggle can be
right on the first paint of every load. `useTheme` drives the click and the
`aria-label`, which may settle after mount because neither is drawn.

## `<PersonaPanel>`

The reviewer for the phase and the thread you have with them. It owns the
mentor data flow (history, sending, the usage count), so pass ids, not data.

```tsx
<PersonaPanel phaseKey="implementation" phaseStateId={state.id} />
```

| prop | type | default | |
|---|---|---|---|
| `phaseKey` | `PhaseKey` | | picks the avatar, the hue, the name and the withheld line |
| `phaseStateId` | `string?` | | the thread. Without it the column is read-only. |
| `lesson` | `boolean` | `false` | a study guide's mentor: Guided only, and it cannot edit project work |
| `guidedOnly` | `boolean` | `false` | the Guided review alone, with no Agentic mode; it points to the workspace for proposals |
| `header` | `boolean` | `true` | the avatar block. A caller whose own heading already names the reviewer turns it off. |
| `interviewHref` | `string?` | | where this phase's customer interview lives, when the pack ships one |
| `interviewStarted` | `boolean` | `false` | the room has turns, so the interview button under the composer stands down |
| `onClose` | `() => void` | | draws a "Close mentor" button in the column's header |
| `className` | `string` | `''` | |

The column is 340px wide from `lg` and full width below. `PersonaColumn` draws
the same column over a thread the caller holds (`usePersona`), so one
conversation can be drawn under two tabs. `PERSONA_NAME` (`lib/phase.ts`,
re-exported here) is each phase's reviewer role,
`{ implementation: 'Senior engineer', … }`: it names the workspace's reviewer
tab, the journal's hint titles and the signature on a pull request's review
threads. The top of the mentor column shows the phase mentor's own name from
`PHASE_EXPERIENCE` instead.

There is no `hintLimit` prop and no cap on the number of questions. The rule
that does exist is in `@learnsdlc/shared` as `HINT_FREE_ALLOWANCE`,
`HINT_MARK_STEP`, `HINT_MARK_CAP` and `hintMarksLost`, the module the API's
process score subtracts by: the first ten questions are free, then each costs
three marks off the process criterion, at most thirty marks in all, and only on
the phases that carry a process criterion.

Three children ride inside it, all in `components/workspace/mentor/`:
`<MemoryLine content={reply}>` above a hint that carried a memory
(`mentor-memory-line`, `mentor-memory-detail`); `<StuckFlag phaseStateId>`
under the composer (`stuck-open`, `stuck-question`, `stuck-tried`,
`stuck-send`, `stuck-raised`, `stuck-answer`, `stuck-clear`), which fetches on
its own, so it is not fed from `PersonaThread`; and `<MetaBadges>` on every
reply (`reply-label`, `reply-ordinal`, `reply-provider`, `reply-line`, and one
of `badge-redacted`, `badge-redirected`, `badge-cached`, `badge-budget`; an
ordinary answer wears none, and the absence is the label).

### Taking it apart: `usePersona` and the three pieces

`PersonaPanel` is header, feed and composer stacked. A room that needs them in
different places takes the thread as a hook and the parts separately:

```tsx
const thread = usePersona({ phaseKey, phaseStateId });

<PersonaHeader thread={thread} />            {/* portrait, mentor name, '<Phase> mentor' */}
<PersonaFeed thread={thread} />              {/* the hints and withheld cards */}
<PersonaComposer thread={thread} />
```

One hook per column: two `usePersona` calls are two threads and two usage reads.

| export | shape | |
|---|---|---|
| `usePersona({ phaseKey, phaseStateId?, lesson? })` | `PersonaThread` | the whole flow: history, send, spend |
| `PersonaHeader({ thread, busy? })` | | the mentor's portrait (`MentorPortrait`), the mentor's name from `PHASE_EXPERIENCE`, and a line that reads `<Phase> mentor`, or `Thinking with you…` while `busy` |
| `PersonaFeed({ thread, className?, describe? })` | | `mentor-chat`, the messages; `describe` says what the reviewer does above the first question |
| `PersonaComposer({ thread, className? })` | | `chat-input`, `chat-send` |

The guided-hint count and the day's token use (`mentor-token-usage`) are drawn
by `MentorSession` in `PersonaPanel.tsx`, in the session's details, not by
`PersonaFeed`.

`PersonaThread` carries `{ lesson?, guidedOnly?, phaseKey, phaseStateId?,
reviewer, name, ask, messages, ordinals, asked, busy, usage, send, explain,
failure, clearFailure, scrollRef }`. `ordinals` is a `Map<messageId, number>`
and `asked` is a count, and both count questions rather than answers, as the
API's hint count does, so a question the guardrail refused costs exactly what
one it answered costs, and the number on screen is the number the grade
charges. The draft is the composer's own state and is not on the thread:
there, a keystroke would re-render the whole room. `explain` asks the reviewer
why a named test fails, and `failure` is the one sentence shown when a turn did
not go, wherever it was asked from. `usage` is seeded from analytics, so the
usage count is honest before the first question is asked.

## `<Palette>`

`⌘K` / `Ctrl K`. The top bar renders one already, with the phases, the routes
and Sign out. Feed it your page's rows through `nav.paletteGroups`:

```tsx
nav={{ ...nav, paletteGroups: [
  { label: 'Criteria', items: criteria.map(c => ({
      label: c.text, detail: `${c.ref}, ${c.artefact}`,
      hint: c.passing ? 'passing' : 'failing', icon: 'requirements',
      onSelect: () => focus(c.id) })) },
  { label: 'Code',  items: [...] },
  { label: 'Tests', items: [...] },
] }}
```

Direct use: `<Palette groups={PaletteGroup[]} trigger={ReactNode | null} placeholder={string} />`.
`trigger={null}` gives the dialog with no button of its own.

## `<CoachMarks>`

`AppFrame` mounts one route-keyed tour for every signed-in page. **Show me
around** in the account menu and the command palette replays the current
page's tour. Progress, the dashboard, the profile, the learning library, the
lessons and the phase rooms have their own steps; other pages have navigation
guidance.

A page tour opens only on request. A phase tutorial opens once by itself, on
the learner's first entry to a phase (remembered per learner and phase under
`lsdlc_phase_tutorial_v1:<learner>:<phase>`), never on a phase the learner has
passed and moved on from; **Replay tutorial** always opens it again. `force`
is for previews and component tests.

```tsx
<CoachMarks page="progress" />
<CoachMarks marks={[{ target: 'actual-control', title: '…', body: '…' }]} force />
```

`tours.ts` holds the steps and their targets (test ids or maintained layout
selectors) and re-exports `tour-replay.ts` (`registerTourReplay`,
`replayTour()`, which dispatches `TOUR_EVENT`) and `tour-seen.ts` (the seen
records and the tutorial scope). Only rendered targets with visible geometry
are included; hidden or inert panes are skipped, and a step whose target is
not drawn falls back to the control that reveals it. The tour never changes
panel preferences, follows links, opens editors, sends messages, or changes a
phase gate.

The native modal provides Next, Back, Skip and Done, holds keyboard focus,
supports Escape, and restores the opener (or the account or search button
when its menu has closed). Route and account changes close it. Its highlight
follows the target on resize and scroll; the card sits beside the target where
there is room. Small viewports keep the controls in a scrollable card, and
reduced motion turns the entry animation off. The page underneath is inert
while the tour is open. `onDone` fires on closing.

## `<Thumb>`

```tsx
<Thumb kind="kill-matrix" size={84} hue="testing" title="Kill matrix" />
<Thumb kind={thumbKind(artefact.title)} hue={artefact.phaseKey} />
```

`kind` is a `ThumbKind`:

`issue`, `criteria`, `contracts`, `model`, `decision`, `class-diagram`,
`components`, `call-graph`, `sequence`, `ledger`, `test-report`,
`kill-matrix`, `coverage-map`, `pipeline`, `runbook`, `incident`, `diff`,
`graph-diff`, `changelog`, `release`, `repo`, `pr`, `story-map`, `timeline`.

`size` is the drawn width (default 84); the height follows at 76/120. `hue`
takes a `PhaseKey` for the one accented element. Without `title` the drawing is
decorative and hidden from screen readers. `thumbKind(name)` picks the drawing
from an artefact's name.

## IDE chrome

```tsx
<ActivityBar items={[{ key: 'files', icon: 'code', label: 'Files', onSelect }]} active="files" />

<Explorer
  tree={[{ name: 'tasktrackr', kind: 'folder', depth: 1, open: true },
         { name: 'manager.py', depth: 2, active: true, modified: true, onSelect }]}
  sourceControl={{ pr: 'PR-3',
    changes: [{ name: 'manager.py', adds: 31, dels: 6, state: 'now' }],
    lines:   [{ state: 'fail', text: 'Submission 1: hidden 5 of 10' },
              { state: 'pass', text: 'Visible 4 of 4' }] }}
  problems={[{ state: 'warn', where: 'Line 69', what: 'Contract contradicted', onSelect }]}
/>

<BottomPanel
  tabs={[{ key: 'terminal', label: 'Terminal', content: <Term/> },
         { key: 'tests', label: 'Tests', testId: 'tab-tests', content: <RunPanel/> },
         { key: 'problems', label: 'Problems', count: 3, content: … }]}
  value={tab} onChange={setTab} height={150}
/>

<StatusBar branch="main" language="Python 3.11" line={62} col={9}
           problems={3} hidden="Hidden 5 of 10" saveState="Saved" savedAt="14:32" />

<InlineNote tone="fail" label="US-3.3"
            text="No ordering. The criterion asks for high, medium, low, then by id."
            test="filter_orders_by_priority_then_id" onExplain={…} />
<InlineNote tone="neutral" label="Not linked" text="Which criterion does this line answer?"
            choices={[{ label: 'US-3.1', onSelect }, { label: 'US-3.3', selected: true, onSelect }]} />
```

`Explorer` is 232px, `ActivityBar` 48px, `StatusBar` 26px, `BottomPanel` 150px
by default (`height={0}` lets it grow with the pane). The bottom panel's tab row
narrows its padding when its tabs would not fit (`useTabRowFit`).

`InlineNote` is a plain component, but putting one inside Monaco is not. Render
it into a view zone with `createRoot(zone.domNode)` and copy three things from
`components/workspace/CodeEditor.tsx`, each of which is a bug if you skip it:

1. **`z-index` on the zone node.** Monaco paints `.view-lines` *after*
   `.view-zones`, so without it the code layer covers your note and
   `elementFromPoint` returns the code: the note is visible and unclickable.
2. **Stop `mousedown`/`mouseup`/`pointerdown`/`pointerup` on the zone node.**
   Monaco's editor-node handler re-aims a press at the nearest text position,
   so a real click never reaches your button. Leave `click` alone and let it
   bubble to React.
3. **Measure with a ResizeObserver on the *card*, not the zone node.** The zone
   is sized from the height you write, so watching it feeds itself; and a
   taller zone brings the scrollbar in, which rewraps the card taller again.
   Ignore deltas of 2px or less and cap the loop, or the note never settles and
   Playwright refuses to click it ("element is not stable").

`StatusBar` carries `save-state` on the word alone (the time is a separate
span, `save-time`), so a test can assert "Saved" without matching a clock. It
also takes an optional `clock`: the Testing phase passes `clock 2026-03-01` or
`clock machine`, so a learner reading a surprising verdict can see which day
the sandbox ran on without opening a pane. It is drawn as `status-clock`.

## The workspace is a room, not a page load

The IDE is left and returned to constantly, so it is written to be walked into
rather than loaded. These live under `app/(app)/workspace/` and
`components/workspace/`.

**It is never blank.** `WorkspacePage` is a keyed wrapper around one
`PhaseWorkspace` per phase, and that component's first render already has a
phase: `ProjectProvider.details[phaseId]` is the initial data, refreshed behind
the drawn page. With no copy at all (a bookmark opened cold) it draws the
frame instead: the phase strip, the activity bar, and blocks where the
explorer, the code and the reviewer's column are going.

**The editor is kept once it is loaded.** The workspace starts the Monaco
chunk as soon as it mounts (`preloadEditor` in
`components/workspace/preload.ts`); a workspace opened after that reads the
component straight out of `loadedEditor()` rather than through `dynamic()`, so
the code column is drawn in the same commit as the rest of the room. The lazy
import is the fallback, and both placeholders are the same flat block.

**Leaving saves.** Typing is written on a 700ms debounce, so the way out
cancels the timer and sends whatever it was holding through
`saveWorkspaceOnExit` (`lib/api-workspace.ts`): one `keepalive` request that
nobody waits for, because the component that would show the result is already
gone. It runs from the effect cleanup and from `pagehide`, so a route change
and a closed tab are the same thing.

**Coming back is coming back.** Three module-level maps hold the signed-in
learner's place. `onSessionEnd` empties them on a sign-out, and each is also
checked against the token (`ownedByToken`, `lib/session.ts`) before every read
and write, so a second learner signing in over the top of the first (which
ends no session and fires no hook) never sees what the first one had:

| map | holds | written |
|---|---|---|
| `VIEWS` | the open file, the tabs opened by hand, the caret, the code's scroll, the panel and column tabs | on the way out of a phase |
| `DETAILS` | the phase as this session last saw it, fresher than the shell's copy | every reload, and every save |
| `THREADS` (`PersonaPanel.tsx`) | the reviewer's conversation, per phase | every turn |

`CodeEditor` takes `restore={{ line, col, scrollTop }}` and applies it once per
file as Monaco becomes ready, and reports movement back through `onScroll`.
The phase's verdicts and runs come from `lib/records.ts`, shared with the
journal, so a return visit asks for nothing but the phase itself.

## Routes

From `routes.ts`, re-exported by the barrel:

```ts
phaseDoorHref(phase)  // the room (or the quiz when it is all that is left), first visit or return; locked → /phases
phaseHref(phase)      // the same door, under the name the navigation reads
roomHref(phase)       // Requirements → /interview (the workspace when the phase holds no interview),
                      // Design → /design, Maintenance → /change when it opens the change room,
                      // every other phase → the workspace; locked → /phases
phaseWorkHref(phase)  // roomHref, or the quiz room when a quiz is the only task the phase has left to pass
doorWithTasks(phase, details) // the phase with the task list useProject already holds, so a door can answer for a quiz without a fetch
quizHref(phase, key?) // /workspace/:id/quiz?task=:key
briefHref(phase)      // /workspace/:id/brief
phaseDocHref(phase)   // the document behind a phase's room: issue, design, pr, matrix, drill, change
phaseDocLabel(phase)  // "Open the issue", "Open the pull request", …
solutionHref(phase)   // /workspace/:id/solution
useSignOut()          // clears the session and its caches, closes the socket, then /login
navKeyFromPath(path)  // which nav entry a route lights; the shell's fallback
```

From `lib/sidebar.ts`:

```ts
sidebarContext(path)  // 'ide' for the working pages (WORK_PATH), else 'doc'
useSidebar(pathname)  // { width, context, rail, toggle }: the learner's choice
applySidebar(ctx, w)  // stamp <html data-sidebar> and remember it
SIDEBAR_BOOT_SCRIPT   // the inline <head> script that makes the first paint right
```

The frames call `navKeyFromPath` themselves, so `active` is only worth passing
when a route lights something other than its own prefix.

## Test ids the shell owns

Do not duplicate these on a page.

| where | ids |
|---|---|
| top bar | `nav`, `jump-to`, `bell`, `bell-panel`, `bell-item`, `bell-open-workspace`, `nav-user`, `account-menu`, `nav-profile`, `nav-evidence`, `nav-account`, `show-me-around`, `theme-toggle`, `logout` |
| palette | `palette`, `palette-input`, `palette-row-{i}` |
| sidebar | `sidebar` or `rail`, `sidebar-toggle`, `nav-home`, `nav-work`, `nav-learn`, `nav-progress`, `nav-feedback`, `nav-join`, `nav-instructor`, `nav-projects`, `nav-guide`, `nav-admin` |
| coach | `coach`, `coach-card`, `coach-count`, `coach-highlight`, `coach-back`, `coach-next`, `coach-skip` |
| persona | `persona-panel`, `mentor-chat`, `mentor-composer`, `chat-input`, `chat-send`, `msg-user`, `msg-assistant`, `mentor-token-usage` |
| work page | `phase-strip` (override with `testId`), `phase-title`, `phase-place`, `phase-state`, `phase-strip-due`, `work-heading` |
| IDE | `explorer`, `bottom-panel`, `status-bar`, `save-state`, `save-time`, `status-clock`, `activity-bar` |

`phase-title` is on `PhaseStrip`'s phase name, so every working room answers
it with one line of code. Do not write it on a page: `getByTestId('phase-title')`
matching two elements fails the browser suite in strict mode.

## Primitives worth reaching for

From `@/components/ui` (one barrel over files by kind: `Button.tsx`,
`Table.tsx`, `Tabs.tsx`, `layout.tsx`, `status.tsx`, `phase-marks.tsx`,
`navigation.tsx`, `hooks.ts` and the rest):

`Button` (`variant` primary/secondary/ghost/danger, `keys="⌘⇧↵"`, `size`,
`href`, `icon`, `busy`, `busyLabel`, `testId`), `PhaseMark` (the phase numeral
as a solid mark: `state` pass/now/todo, `ringGap` to match what it sits on),
`PhaseLine` (mark, name, and "phase n of m" over the project's own phases),
`SectionHead` (title, purpose, right), `Table` (`cols: Column[]`,
`rows: ReactNode[][]`), `CellTitle` (square, title, detail), `Readout` (big
number, unit, label), `Tabs` (underlined row, `fill` to spread), and the hooks
`useTabs`, `useEdgeFade` and `useDialogFocus`.

Also there: `Panel`, `Section`, `Chip`, `StatusSquare`, `Stat`, `PhaseTile`,
`Avatar`, `Kbd`, `EmptyState`, `Steps`, `Breadcrumbs`, `Notice`, `Divider`,
`Detail`, `initialsOf`.
