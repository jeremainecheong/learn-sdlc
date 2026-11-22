## What this changes

<!-- One or two sentences: what the code does now that it did not before. Link the issue if there is one. -->

## How it was checked

<!-- The commands you ran and what they printed at the end. -->

## Checklist

See CONTRIBUTING.md for each item. Tick it, or say why it does not apply.

- [ ] `npm run typecheck` passes.
- [ ] The tests of the area I changed pass, and I named the commands above. A change in behaviour has a test that fails without it.
- [ ] Words a learner or teacher reads in `apps/web` pass `npm run lint:copy -w @learnsdlc/web`.
- [ ] If `docs/teacher-project-upload.md` changed, the module is regenerated and `npm run check:teacher-guide -w @learnsdlc/web` passes.
- [ ] No applied migration in `apps/api/src/migrations` is renamed or edited; a schema change is a new migration.
- [ ] No byte under `content/` changed without a new `version` in that pack's `project.json`.
- [ ] No key, password, token or private address is in the change.
- [ ] The documents this change makes untrue are updated in this pull request.
- [ ] Each commit message is one plain sentence saying what the code now does.
