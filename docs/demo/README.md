# A demo class

The teacher's console is drawn from whoever is enrolled. On a fresh database
that is one learner, so most of what a teacher works with has nothing to show.
`npm run seed:class` fills a class so the console can be shown, tried or
captured as a teacher sees it in the middle of a term.

To seed one:

```bash
npm run demo -- --class --ai-stub    # the demo with DEMO_CLOCK set and a class seeded
# or, against an API already started with DEMO_CLOCK=true:
npm run seed:class -- --at 2026-09-24T14:00+08:00
```

The seed wants reproducible mentor answers, so it runs only while the canned
test endpoint answers (`--ai-stub`). With a real model it stops before creating
anything and says so; add `--any-mentor` to `npm run seed:class` to seed the
class against a real model anyway.

Twenty-five learners are replayed through the public API (register, join,
enrol, save, ask the mentor, run, submit, reflect, advance) with the API's
clock wound back five weeks and walked forward a lab day at a time, so the
class arrives dated across a term rather than dated this afternoon. It prints
one line per learner as they finish. `--at` pins what "today" means, which is what makes a screenshot
reproducible; without it the class is always five weeks old, whenever it is
seeded.

The clock is `POST /api/v1/demo/clock`, and it exists only on a loopback,
non-production API started with `DEMO_CLOCK=true`. Every other deployment
answers 404. Nothing about the seeded rows depends on it afterwards: they keep
the dates they were written with, and the process goes back to real time when
the seeder finishes or when the API restarts.

The demo instructor, `instructor@learnsdlc.test`, owns the seeded class, so
signing in as that account shows the class full. `npm run seed:class -- --remove`
takes the twenty-five accounts and their work out again; the class itself
stays, because there is no route that deletes one.

Three things are worth knowing before you seed:

- **Determinism.** Who is stuck, who leaned on the mentor, which acceptance
  cases each learner left out and which lab day each submission landed on are
  all dealt from `--seed` (default 20260401) and are identical between runs.
  Only the absolute dates move, and `--at` pins those. The seeder refuses to
  run against a live model for the same reason (a model's hints differ every
  time) unless you pass `--any-mentor`.
- **Size.** Twenty-five terms of workspace snapshots grow the sqlite file,
  and the seeder prints its size when it finishes. Every submission is kept,
  so the file does not shrink afterwards: do not seed a class onto a database
  you care about.
- **Sign-ins.** A moved clock means every account's token expires as the term
  walks past it, so a run signs in many times from one address. The API counts
  those in a window of `SIGNIN_MAX_PER_ADDRESS` (200 a minute by default),
  which is enough; if a run stops with "the API
  is still counting sign-ins from this machine", wait a minute, or raise that
  variable on the API and start it again.
