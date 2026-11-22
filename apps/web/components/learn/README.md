# Study guides

The six phase guides under `/learn`, the Learn catalogue's phase map and its "How LearnSDLC checks your work" section live here. Every word a guide shows is in web code.

| What | Where |
|---|---|
| Chapter words, practice and sources | `content/<phase>.ts`, joined by `content.ts` (exports `LESSONS`); shapes in `content/types.ts` |
| Walkthroughs, tables and recap | `study/<phase>.ts`, joined by `study.ts` (exports `PHASE_STUDY`); shapes in `study/types.ts` |
| A phase's figures | `figures/<phase>.tsx` |
| Shared figure blocks and their stylesheet | `figures/` (`Figure.tsx`, `StepThrough.tsx`, `ToggleSet.tsx`, `StatusMark.tsx`, `PhaseGlyph.tsx`, `CodeText.tsx`, `LessonTerm.tsx`, `motion.ts`, `figures.css`) |
| The figure registry and the chapter slot | `figures/registry.ts`, `figures/ChapterFigures.tsx` |
| The reader | `LessonReader.tsx`, `StudyWalkthrough.tsx`, `lessons.css`, `lesson-hero.css` |
| Each guide's first screen and catalogue card | `hero.ts` |
| The catalogue's phase map | `phase-map.ts` (words and the gate sentence), `PhaseMap.tsx` |
| "How LearnSDLC checks your work" | `HowChecksWork.tsx`, `HowChecksWorkSlot.tsx`, `HowChecksWork.css` |

## House rules

1. White ground for every figure; no cream, paper or frosted gradient.
2. Flat shapes: 1.5 px strokes, 8 px corners, white or a 4 percent tint; no gradient, glow or shadow.
3. Colour only where it means something: pass green, fail red, survived amber, grey for not run. A selected button, node or box has one neutral look in every guide: `--fig-selected` (ink) as its stroke over `--fig-selected-fill`, never the phase accent (Deployment's is the green of Passed, and Testing's sits beside the fail red). The Implementation, Testing, Requirements and Design figure rules name that ink `--fig-accent`, which `figures.css` sets to `--fig-selected`. The phase accent appears only outside figures, as a small marker (the chapter's "Where you use this" bar, the takeaway bar).
4. Never colour alone: every state is a word too (use `StatusMark`).
5. Real artefacts (a real contract row, mutant name, config line), not decoration; no emoji and no 3D in figures.
6. A simulated figure says so: `model` on `Figure`. No invented score is presented as real.
7. Keyboard first: Tab reaches every control, Space or Enter presses, arrows move inside a group; changing text sits in `aria-live="polite"`.
8. Contrast 4.5:1 for text and 3:1 for meaningful strokes on white (`--fig-line` is 3.2:1; `--fig-rule` is for dividers only).
9. Motion 150 ms or less, and none under reduced motion (the blocks handle it through `usePrefersReducedMotion` in `motion.ts`; do not add your own animation).
10. Copy lint: no `·` or `|` in any exported string, prop or JSX text (write "or"); sentence case, plain words, no exclamation marks, no vendor, model or course names. No new dependency.

## The blocks

All under `figures/`. `figures.css` is imported by `Figure` and `ChapterFigures`.

### `Figure` (`Figure.tsx`)

The frame: caption, how-to line, honesty tag, body, visible description.

| Prop | Type | |
|---|---|---|
| `title` | `string` | caption heading, required |
| `howTo` | `string?` | one line saying what to press |
| `description` | `ReactNode?` | visible facts under the figure |
| `model` | `boolean \| string?` | `true` draws "Teaching model, not a run of your work" (`MODEL_TAG`); a string draws your words |
| `code` | `string[]?` | fragments of the figure's words drawn in code type (see `CodeText.tsx`) |
| `scroll` | `boolean?` | body in a focusable `role="region"` labelled "<title>: scrollable figure" |
| `id`, `className` | `string?` | `id` becomes `data-figure-id` (the reader's slot already carries it) |

`FigureSvg` names an SVG: `title`, `description` (say every fact the picture shows), `viewBox`, `minWidth?`. It sets `role="img"` and unique `aria-labelledby` ids. Its text is the page's own font at 13 units (`figures.css`; set no font or size on a `<text>` beyond weight or a monospace class for code), and it draws at most 1.2 times its viewBox width (`FIGURE_SVG_MAX_SCALE`), centred, so the text stays near body size. A drawing that should fill a figure at 1440 (about 1190 px) gives its viewBox a width of 1000 or more, and a `minWidth`; FigureSvg keeps such a plan at 0.86 of its width or more (`WIDE_PLAN_MIN_SCALE`), so while it scrolls in its box on a phone its text stays at about 11 px.

```tsx
<Figure title="One list, many tasks" howTo="Choose how many tasks the list holds." model scroll>
  <FigureSvg title="List 7 and its tasks" description="List 7 holds 3 tasks; each task names list_id 7." viewBox="0 0 600 200">
    <rect x="20" y="20" width="160" height="60" rx="8" fill="#fff" stroke="var(--fig-line)" />
  </FigureSvg>
</Figure>
```

### `StepThrough` (`StepThrough.tsx`)

Frames with Back, Next, Start again, "Step 2 of 5" and a polite live line; arrows, Home and End move.

| Prop | Type | |
|---|---|---|
| `label` | `string` | the group's name |
| `steps` | `{ title: string; text: string; content?: ReactNode }[]` | `text` is announced on every move |
| `initialStep` | `number?` | zero-based |
| `onStepChange` | `(index: number) => void` | zero-based, after each move |

```tsx
<StepThrough label="Trace the invalid-name request" steps={[
  { title: 'The request', text: 'The client sends POST /api/lists with an empty name.', content: <SequenceFrame lit={0} /> },
  { title: 'The route', text: 'The route calls create_list(name).', content: <SequenceFrame lit={1} /> },
]} />
```

### `ToggleSet` (`ToggleSet.tsx`)

`aria-pressed` buttons, single or multiple; a pressed button also draws a tick; a polite summary ("Tests in your suite: 2 of 5 on.").

| Prop | Type | |
|---|---|---|
| `label` | `string` | the group's name and the summary's start |
| `options` | `{ value: V; label: string; code?: true \| string[] }[]` | `code`: `true` for a whole typed payload, or its code fragments |
| `value`, `onChange` | `V` and `(v: V) => void`, or with `multiple`: `V[]` and `(v: V[]) => void` | controlled; multiple keeps the options' order |
| `multiple` | `true?` | |
| `summary` | `'hidden' \| 'visible'` | the summary is always there for screen readers; `visible` draws it |

```tsx
const [rule, setRule] = useState<'lt' | 'le'>('lt');
<ToggleSet label="Overdue rule" options={[{ value: 'lt', label: 'due < today' }, { value: 'le', label: 'due <= today' }]} value={rule} onChange={setRule} />
```

### Code in words (`CodeText.tsx`)

The page font joins some pairs into one glyph (Manrope draws `--` as a dash). `codeFragments(text, also?)` draws every word holding `--`, `->`, `<=`, `>=`, `!=` or `=>` (or a comparison on its own) as `<code class="code-fragment">` with ligatures off (`figures.css`, `lessons.css`), plus any fragment named in `also`. The reader, `Figure` (its `code` prop), `ToggleSet` (an option's `code`) and `StepThrough` pass their words through it. `wordBreaks(text)` puts a `<wbr>` after each underscore and slash and before an inner capital, so a long name breaks there on a phone, never inside a word.

### `StatusMark` (`StatusMark.tsx`)

The only place a state becomes colour, glyph and word. States: `passed`, `failed`, `survived`, `killed`, `not-run`, `current` (words: Passed, Failed, Survived, Killed, Not run, You are here). `label` replaces the word and keeps the glyph.

```tsx
<StatusMark status="survived" />
<StatusMark status="not-run" label="Not meaningful" />
```

### `PhaseGlyph` (`PhaseGlyph.tsx`)

Six flat 24 px stroke icons. Props: `phaseKey`, `size?` (24), `title?` (give one only when no words sit beside it; otherwise it is `aria-hidden`), `className?`.

```tsx
<PhaseGlyph phaseKey="testing" /> Testing
```

### `LessonTerm` (`LessonTerm.tsx`)

`<LessonTerm term="rollback">roll back</LessonTerm>`: dotted underline, a card on hover or focus, Escape closes, `aria-describedby` while open. `TermParagraphs` is what the reader uses to mark one term in a chapter. The terms are the guides' own list, `figures/lesson-terms.ts`, never `lib/glossary.ts`.

## The guide's first screen (`hero.ts`)

All six guides open the same way: a navy banner, the "Your phase brief" heading, and the four chapters as a row of cards over the full-width chapter. `LessonReader` holds no per-phase branch for looks; what differs per guide is in `hero.ts`. `GUIDE_HERO[phase]` gives the banner's `eyebrow`, two-line `headline`, `lead` (what the phase is for, then what the learner makes in it, checked against the phase's `phase.json`), `art` (a file in `public/artwork/`, drawn at its own shape at the 4:3 box's height times its `scale`, so every guide's picture has Requirements' weight; the `ART_WEIGHT` note in `hero.ts` says how each scale was measured) and the `path` caption ("The learning and evidence path" on all six). `GUIDE_CARD[phase]` gives the catalogue card's `promise`, its three or four `topics` and an optional third meta item (`extra`, only where it is true of that guide); `/learn` draws one card per offered guide in phase order, all the same. Rules the reader and the catalogue need beyond `lessons.css` go in `lesson-hero.css`, scoped to the learn pages.

## The chapter page

Every chapter draws in one order: "In this chapter" (`objective`), "Where you use this" (`where`: the one chip; when the learner holds the phase, its room part, for example "Testing room", links to the phase's door and the tab or page after it stays plain words, `splitWhere` in `LessonReader.tsx`; no figure says it again), "The idea" (`explanation`, then `body` split on blank lines, with one guide term marked), the chapter's figures, "TaskTrackr, worked" (`example` as an artefact card captioned "The worked example", since several are illustrative, beside the numbered `steps`, `why`, `table`), "Check yourself" (the practice question as three option cards, then the reveal exercise), "Keep this idea" (`takeaway`). The guide's `flow` is drawn once under the banner, with no step marked: five of the six guides have more steps than chapters, so the chapter cards mark the open chapter instead.

Two optional fields on a chapter's study (`study/types.ts`):

- `where`: the room and the part of it, in the room's own labels, for example `'Testing room, Planted bugs page'`. All 24 chapters fill it; `test/guide-where-chips.test.ts` pins each label to a label the room really draws, and `test/lesson-reader.test.tsx` checks no chapter shows the fallback.
- `term`: a key of `figures/lesson-terms.ts` to define at its first use in the idea (the reader marks one term per chapter; left out, the first listed term that appears is marked; `null` marks none, for a chapter whose only listed word is used in another sense). `test/lesson-reader.test.tsx` pins the term each of the 24 chapters marks.

## Registering a figure

A figure is a component with no props. Add one line to the phase's map in `figures/<phase>.tsx`:

```tsx
export const DESIGN_FIGURES: PhaseFigures = {
  'design-contract-builder': { chapter: 1, component: ContractBuilder },
};
```

- `chapter` is the number the reader shows (1 to 4), not an index.
- Ids are kebab case, start with the phase name, and are unique across all six guides.
- Several figures on one chapter draw in the order listed, after the chapter's idea and before "TaskTrackr, worked", each in a `<div class="lesson-figure" data-figure-id="...">` that adds no box.
- `registry.ts` joins the six maps; a new figure needs no change there.

A figure never prints what a phase grades: no code, SQL or record a learner could paste into a graded gap or record unless the phase's brief or visible files already give exactly that. Teach on something the project supplies (the lists feature, a supplied function) or on a clearly labelled illustrative example, and fill at most one part of a record as an example. The gate is taught as the product decides it (`GATE_RULE` in `phase-map.ts`), never as a score against a pass mark.

The model figure is `MutationTable` in `figures/testing.tsx` (Testing, chapter 4), tested in `test/mutation-table.test.tsx`: data as exported constants, a `Figure` with an honesty tag, `ToggleSet`s for the controls, `StatusMark` in every row, a real `<table>` in `ScrollRegion`, and one polite line that says what changed.

## Tests

- `test/guide-content-modules.test.ts` keeps the indexes' shape (`LESSONS`, `PHASE_STUDY`, one module per phase, four chapters, three options).
- `test/guide-figure-registry.test.tsx` checks the registry: every chapter of every guide has a figure, ids are unique, each figure renders on its own with a caption and an honesty tag, and each chapter still draws the key facts it teaches.
- Each phase's figures and words are checked in `test/guides-requirements-design.test.tsx`, `test/guides-implementation-testing.test.tsx` and `test/guides-deployment-maintenance.test.tsx`. Update quoted words when the copy changes; keep every fact.
- `test/lesson-reader.test.tsx` checks the reader: distinct feedback for every option, one walkthrough and one practice per chapter, the marked terms, and British spelling across the guides' files (it names those files by path, so a moved file is listed again there).
