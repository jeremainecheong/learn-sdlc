# LearnSDLC design system

The visual direction: Outfit headings, Manrope body text, cyan glass
navigation, artwork, and distinct working environments for the six phases.
Paper and Graphite are paired themes. The public homepage has the blue aurora;
signed-in pages prioritise reading, editing, and evidence.

## Source of truth

The code is the source of truth. The tokens live in `app/globals.css` and
`app/redesign.css`, and the files below hold the rest; this page describes
them. Paths are relative to `apps/web`. Application assets and fonts are served
from `apps/web/public`.

| Implementation | Responsibility |
|---|---|
| `app/globals.css` | Base/status tokens, typography utilities, fields, markdown and scrollbars |
| `app/redesign.css` | Surface and action palette, local fonts, motion tokens, full viewport frame |
| `components/ui/controls.css` | Shared Button geometry and primary, secondary, ghost, danger, disabled, busy, focus and press states |
| `components/ui/index.tsx` | Accessible primitives and their actual behaviour |
| `components/shell/shell-fidelity.css` | Retractable glass sidebar, header actions and native shell dialogs |
| `components/experience/experience.css` | Learner/teacher page composition, generated portraits, metrics and evidence cards |
| `components/workspace/phase-experience.css` | Familiar phase tools, active tabs and paired tool surfaces |
| `components/workspace/requirements/requirements-workspace.css` | Interview/backlog workspace and phase-specific controls |
| `components/workspace/WorkspacePanels.css` | Collapsible brief/mentor panel affordances |
| `components/learn/lessons.css` | Chapters, worked examples, practice and lesson navigation |
| `app/public-theme.css` | Every public, sign-in and legal page: composition, the frosted header, public controls and interactions, and the readable legal articles |
| `tailwind.config.js` | RGB-token utility names, font stacks and shape aliases |

## Theme and tokens

`lib/theme.ts` is the theme authority. The inline boot script stamps
`data-theme="paper"` or `"graphite"` before first paint, taking a saved choice
before the system preference. `useTheme()` handles explicit changes, other tabs
and system preference changes. Do not choose a second theme inside a component.

Colours are RGB triplets so Tailwind opacity modifiers work. These are the
values `redesign.css` sets over the base values in `globals.css`;
`--c-onaccent` comes from `globals.css`.

| Token | Paper | Graphite | Use |
|---|---|---|---|
| `--c-ground` | `244 248 251` | `20 39 55` | Page ground |
| `--c-surface` | `255 255 255` | `28 49 67` | Reading surfaces |
| `--c-raised` | `236 243 248` | `34 59 79` | Inset/disabled controls |
| `--c-edge` | `218 230 239` | `56 81 101` | Panel separators |
| `--c-edge2` | `181 202 218` | `80 109 131` | Control edges |
| `--c-ink` | `30 59 81` | `230 241 249` | Headings and primary text |
| `--c-ink2` | `64 90 109` | `192 214 230` | Body/detail text |
| `--c-muted` | `80 104 123` | `160 187 206` | Supporting text |
| `--c-field-border` | `113 140 160` | `117 147 168` | Input boundaries |
| `--c-accent` | `26 102 130` | `134 211 235` | Cyan action/selection |
| `--c-onaccent` | `255 255 255` | `11 18 32` | Text on solid cyan |
| `--c-tint` | `225 242 249` | `32 73 92` | Action-tinted background |

Status tokens remain semantic: pass, fail and warn each have foreground, tinted
background and solid-fill foreground tokens in `globals.css`. Graphite overrides
`--c-fail` to `255 166 166` in `redesign.css` so error text also clears 4.5:1 on
its blue raised and action-tinted surfaces. Phase tokens are
`--hue-<phase>` and `--tint-<phase>`, consumed through `lib/phase.ts`. Check the
actual foreground/background pair when introducing a new surface. A translucent
white fill with inherited light text is not a Graphite variant.

Component tokens compose the palette: `--control-primary-bg/fg`,
`--control-surface`, `--control-border`, inset highlight and shadow tokens.
Public pages and phase tools can have scoped surface tokens, provided each has
an explicit Graphite counterpart. Preserve tool identity rather than applying
one generic card treatment to every centre workspace.

## Type, shape and depth

- Outfit is the display face; Manrope is body/interface text; Space Grotesk is
  available for selected display details. Code, identifiers and keyboard hints
  use the existing Geist Mono stack. All font assets are local.
- Main reading text needs comfortable line height and bounded line length.
  Lesson prose uses a readable measure; diagrams and workbench panes can be wider.
- Shared panels use the 22px `rounded-panel` radius and restrained glass shadow.
  Dense tool surfaces use smaller scoped corners and familiar separators.
- Shared buttons are 42px minimum height with 12px corners. Compact controls are
  34px with 10px corners. Touch-facing primary actions use at least 44px where
  space permits; a dense workbench is not enlarged indiscriminately.
- Glass belongs to navigation, controls and selected framing surfaces. Reading
  panes need sufficient opacity and text contrast. Use fine borders, an inset
  highlight and restrained elevation to distinguish actionable layers.
- Do not animate inert metric cards as if they were buttons. A card that opens
  evidence should expose that interaction through semantics and visible states.

## Button contract

Prefer `Button` from `components/ui`. Existing native controls using `.btn`
share the same styles. `.btn-primary` is an alias for primary lesson links.

| Variant/state | Appearance and behaviour |
|---|---|
| Primary | Cyan fill, correctly paired foreground, slight top sheen and elevation; one strongest next action per action group |
| Secondary | Frosted surface, clear border, quiet depth; cyan-tinted hover |
| Ghost | Quiet text/icon action with a hover background; stable position |
| Danger | Semantic red fill and appropriate on-status text; destructive intent remains explicit |
| Hover | Fine-pointer highlight/elevation; enabled primary and secondary may rise 1px without changing layout dimensions |
| Press | Short inset/resting state, including touch; no width or font-size change |
| Focus | Visible 3px ring and 3px gap; do not remove keyboard focus to match a mockup |
| Disabled | Raised fill, readable muted text, outline, no hover/press effect; state is not opacity alone |
| Busy | Progress label and icon, tinted surface, `aria-busy`, disabled action; never fake success |

Icons are Lucide through `Icon`, sized consistently and prevented from shrinking.
Keep an 8px icon/label gap (6px compact). Icon-only controls need an accessible
name. Generated artwork is not a substitute for an interface icon.

Do not override `.btn` with page-level `color:white` or a new background: that
can erase disabled states and produce white text on Graphite's pale cyan.
Change scoped tokens or use the intended variant. Intentional danger-outline
controls preserve their semantic text colour.

## Motion

| Token | Value | Purpose |
|---|---|---|
| `--motion-fast` |120ms| Press feedback |
| `--motion-control` |180ms| Hover, focus-adjacent visual feedback and selection |
| `--motion-surface` |260ms| Dialog/surface entry |
| `--ease-out` |`cubic-bezier(.2,.8,.2,1)`| Responsive arrival |
| `--ease-press` |`cubic-bezier(.4,0,1,1)`| Immediate pressure response |

Motion explains an action. Use short opacity/transform transitions and animate
borders/shadows sparingly. Avoid `transition:all`, layout-size animation on
controls, delayed clicks and re-mounting panels to replay an entrance. Dialog
entry uses 6px vertical travel with stable measured width. Escape and focus
restoration do not wait for a closing animation.

The homepage aurora and floating artwork have their own pause and
reduced-motion behaviour. Workspace motion is restrained. Honour
`prefers-reduced-motion`: decorative motion stops, dialogs appear directly,
buttons remain in place, and the selected/hover/focus state remains visible.

## Layout and navigation

The application frame fills the viewport without an outer border, margin or
rounded wrapper. Its shell mounts once above routes. Panes scroll internally;
long content must not create a second document scrollbar or push controls away.

The sidebar is 76px collapsed (60px on mobile) and 232px pinned. Pinning reserves
space and shifts content; a temporary hover peek overlays. Keyboard/touch users
retain the explicit toggle and access to the same destinations. Active pages
have a persistent glass selection, cyan edge and `aria-current`; hover is a
separate state. Native search/account/notification dialogs keep focus, Escape
and viewport bounds.

Phase brief and mentor panels can be hidden independently. Keep the centre
workspace usable at intermediate widths. Requirements contains the stakeholder
interview followed by the Jira-style backlog; it does not expose a code editor.
Switching its tabs should preserve the frame and drafts. Other tools retain
Postman contracts, editor/preview panes, test suites/results, pipeline logs and
PR/diff structures. Mentors remain inside phase project and lesson spaces only.

Lessons are optional structured teaching. Their chapter navigation, diagrams,
worked examples and practice controls remain separate from mentor conversations.
Progress/teacher charts open the real underlying evidence and never infer a
score, streak, duration or verdict from decoration.

## Verification

Use real routes and isolated users. Visual checks must include Paper/Graphite,
desktop/tablet/mobile, content at realistic lengths, pointer hover and press,
keyboard focus, touch targets, disabled/busy states, reduced motion, viewport
bounds and assets. Sample animation over time; a still screenshot alone cannot
prove motion. Inspect the captures as well as the geometry report.

UI-only verification must not submit AI requests, execute code or mutate a
learner's work merely to enable a button. Use unsent drafts and guarded routes
for those states. API and provider behaviour needs separate, explicitly identified
evidence. Preserve failed attempts and distinguish a harness or dev-server
failure from an application defect.

Run the affected web tests, the type-check and the copy rules
(`npm run lint:copy -w @learnsdlc/web`), and verify the production build. The
copy rules are two: no middle dot or pipe stands in for a word in text a user
reads, and an error message starts as a sentence (a capital, a digit or an
opening quote).
No single screenshot or passing test suite proves that every user journey is
perfect.
