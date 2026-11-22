# Start here

This archive is a complete LearnSDLC project you can upload as it is, then
make your own. It carries Shelf, a small library application: a Python API
and a TypeScript page, taken through all six phases from requirements to
maintenance.

Replace the starter's hidden tests before you assign it. Every teacher who
downloads this archive can read the same hidden tests, reference solutions
and planted faults, so a class that works on them unchanged is working on
answers other people already hold.

## What one submission costs

A full pass over this project runs 16 microVMs: 4 for Implementation, 6 for
Testing, 2 for Deployment and 4 for Maintenance. Requirements and Design run
none. The ceilings are 10 per phase and 24 per version, so you have room to
add a run or a planted fault before the upload refuses the project.

## What to change first

1. Upload the archive as it is, so you see a draft that passes every check.
2. Replace the hidden tests in `phases/03-implementation/hidden_tests` and
   `phases/06-maintenance/hidden_tests`, and the planted faults in
   `phases/04-testing/mutants`, with your own.
3. Rewrite each phase's brief in your own words: the `taskPanel` in each
   phase's `phase.json`. Each phase folder holds a `NOTES.md` that says what
   the phase asks and which folders are sealed.
4. Write the stakeholder's facts in the editor, or in
   `phases/01-requirements/interview.json`, and keep them to the one story the
   backlog leaves out. The Requirements task names the stakeholder exactly as
   the interview's persona does.
5. Seal, run deep validation, preview the draft as a learner, then publish.

## Files no learner ever sees

This file and every `NOTES.md` are for you, not for learners. No phase mounts
them, so they never reach a workspace, and the upload stores none of their
bytes. An exported project leaves them out, so keep your own copy of the
archive.

`phases/01-requirements/interview.json` is not a comment. LearnSDLC seals
it with the version as the stakeholder interview. Its facts go to the AI
interviewer and the AI reviewer, and reach the learner through the
interviewer's replies. Write nothing in it that a learner should never hear.
