# API test fixtures

Everything here is test data for the API suite (and, where noted, for the web
suite). `paths.ts` names the folders for specs to import.

Many files here are byte-for-byte copies of files under `content/`, or of each
other. That is on purpose: each frozen copy holds a pack as it shipped at one
point, so a spec can prove that the code still reads, converts or grades that
shape. Never refresh a frozen folder from `content/`, never de-duplicate it, and
never reformat or re-encode its files: a spec that reads it would then test the
current pack instead of the older one, or a recorded digest would stop matching.

## Folders

| Folder | What it holds | Read by |
| --- | --- | --- |
| `upload-packs/` | Packs a teacher uploads: `shelf` (the example a teacher's own project is tested with), `shelf-preview`, `shelf-task`, `shelf-design-task`, `shelf-three`, `starter` and `deadline-badge` (a six-phase project whose page the Deadline badge browser tests preview). `archive.ts`, `hostile.ts` and `markers.ts` build archives from them, hostile archives included, and name the sealed markers. | The upload, authoring, sealing and isolation specs; `test/cli/starter-archive.ts` generates `src/authoring/starter-archive.generated.ts` from `starter` and `shelf`. `deadline-badge` is read by `src/assistant/record-review-impact.spec.ts` and by the browser tests `e2e/page-preview-deadline-badge.spec.ts` and `e2e/page-preview-tab.spec.ts` (through `e2e/support/deadline-badge.ts`), which type the learner's work from `apps/web/test/fixtures/deadline-badge-v5-web.json`. |
| `older-shelf/` | Shelf in the older pointer layout (`canonical/`, `files[].source`), frozen. | `sealed-roles-shelf.e2e-spec.ts`, `written-phase-pack.ts`, `legacy-phase.ts` and the layout specs under `src/`. |
| `older-tasktrackr/` | TaskTrackr 5.0.0's `project.json`, `canonical/` and phases 1 to 4 in the older layout, frozen. | `legacy-phase.ts`. |
| `legacy-requirements/`, `legacy-design/`, `legacy-deployment/`, `legacy-maintenance/` | Single phases as they shipped before their structured records: markdown stories and designs, a markdown runbook and changelog. | The record conversion specs under `src/`, `legacy-phase.ts` and `legacy-design-phase.ts`. |
| `legacy-shelf/` | Shelf's Deployment and Maintenance as they shipped before their records. | `legacy-phase.ts` and `src/content/legacy-layout.spec.ts`. |
| `contract-bodies/` | Four recordings of API response bodies, with `recorder.ts`. Set `CONTRACT_BODIES_RECORD=1` on the recording spec to record one again. | The `*-contract-wiring.e2e-spec.ts` specs record and check them; the web wiring tests replay them. |
| `contract-exchanges/` | Recorded request and response exchanges, with `recorder.ts`, `replay.ts`, `archives.ts` and `sealed-files.ts`. Set `CONTRACT_EXCHANGES_RECORD=1` on the recording spec to record one again. | The `*-contract-wiring.e2e-spec.ts` specs record and check them; the web wiring tests replay them through `apps/web/test/support/`. |

## Files

| File | What it holds | Written by |
| --- | --- | --- |
| `tasktrackr-content-digests.json`, `shelf-1.0.0-content-digests.json` | What the pack loader produces, as digests. | `test/cli/content-digests.ts` |
| `tasktrackr-verdict-digests.json`, `shelf-1.0.0-verdict-digests.json` | What the grader produces for each phase, as digests. | `test/cli/verdict-digests.ts` |
| `tasktrackr-ai-request-digests*.json` | What each model call sends, as digests, for the default, `trim` and `strict` settings. | `test/cli/ai-request-digests.ts` |
| `tasktrackr-fanout-equivalence.json` | The grader's verdicts with and without fan-out. | `src/feedback/fanout-equivalence.spec.ts`, with `FANOUT_EQUIVALENCE_RECORD=write` |
| `plain-text-5.0.0.json` | TaskTrackr 5.0.0's markdown texts turned into plain text. | Read by `apps/web/test/plain-text.test.tsx`. |
| `folder-packs.ts`, `records-worked.ts` | Small packs and worked records built in code. | Imported by specs. |

Regenerating a digest file is a deliberate change with a reason, never the fix
for a failing check.
