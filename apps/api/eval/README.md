# Model evaluation harness (advanced)

This harness scores language models on LearnSDLC's own AI jobs. It sends a
fixed corpus of cases through the product's own provider class, prompts and
parsers, runs any code a model proposes inside a sandbox, has small LLM judges
score the answers, and writes a report that weighs quality against latency.
It is the "score your own model" path that `docs/local-run.md` points to.

You do not need it to run LearnSDLC. To check that one model works with the
product, `bash scripts/prove-local.sh --ai-check` is enough (a few minutes,
one case per AI job). Use this harness only to compare models on many cases,
and only with a budget.

## What is in this folder

- **The harness:** `cli.ts` and its phases (below), started by `run.sh`.
- **Its Bedrock provider**, in `provider/`. `BedrockProvider` is the
  product's `OpenAiProvider` with its transport swapped for the Amazon
  Bedrock Converse API: every prompt composer, the AI gate, the one retry on a
  429, the Guided self-review, the interview review, the Agentic envelope and
  the strict review parser are the product's code, unchanged. The product
  sends each completion as a chat-completions request; while a call of a
  `BedrockProvider` runs, that request is translated to Converse
  (`provider/converse.ts`) and the answer is translated back. The product
  itself has no Bedrock provider and reads no AWS setting for its AI.
- **Its own tests**, the `*.spec.ts` files. They make no network call and need
  no credentials (see "Its own tests").

The provider needs `@aws-sdk/client-bedrock-runtime`, and the harness also
loads `@aws-sdk/credential-provider-ini` and `@smithy/signature-v4`. All three
are development dependencies of the API, so `npm ci` in this checkout installs
them.

## What it needs from outside

- **Provider credentials and money.** Candidates run on Amazon Bedrock in
  `us-east-1`, with the AWS profile named by `AWS_PROFILE` (`default` when
  unset; an `aws login` or `aws sso login` session works). The reference arm
  calls the OpenAI API with a key it reads from AWS Secrets Manager, from the
  secret named by the `application_secret_arn` field of the JSON file that
  `EVAL_DEPLOYMENT_CONFIG` names (the field `api_env.OPENAI_API_KEY` or
  `OPENAI_API_KEY` of that secret). The key stays in memory: the harness never
  prints or writes it. Every paid call is held under a spend stop
  (`--stop-usd`, at most and by default US$45, counted across every real run
  in the folder), and a paid run refuses to start without a plan that fits the
  stop and a passing reasoning probe.
- **An evaluation folder**, named by `EVAL_ROOT`. Nothing in it is in this
  repository: the corpus holds recorded learner work and the model list holds
  prices and access notes. It must hold:
  - `corpus/MANIFEST.json` and one folder per job type
    (`review-requirements`, ..., `interview-turn`, `mentor-turn`,
    `agentic-proposal`, `explanation-assessment`), one `<case id>.json` per
    case. `contracts.ts` (`validateCase`) says which fields each job type needs
    and refuses a case field by field.
  - `models.json`, an array of model rows. The rows whose `slate` is
    `candidate`, `candidate+judge` or `reference` run; `contracts.ts`
    (`loadModels`) lists the fields it reads (`modelId`, `invokeId`,
    `priceIn`, `priceOut`, `maxOutput`, `probe`, `runnable`, `slateNote` with
    the judge slot and hardware tier, ...). Every slate row must have an alias
    in `KNOWN_MODELS` and a documented reasoning switch in
    `REASONING_SWITCHES`.
  - `tools/build_corpus.py`, the corpus builder, which holds the learner-name
    and join-code patterns of the privacy scan. They name real people and
    classes, so they are not written into this repository. The harness reads
    every entry of the form `re.compile(r'<pattern>'), '<learner-name|join-code>'`;
    without the file it stops with a message naming the path, and writes
    nothing.

  The harness writes `corpus-derived/` (each case's deterministic inputs,
  frozen once written) and `runs/<run id>/` there.
- **macOS** for executable truth and for deriving review inputs: model-written
  code runs under `sandbox-exec` (Seatbelt), with no network and writes only
  to its own job folder, after a live canary has proved the fence. It also
  needs the runner's baked runtime in `apps/api/runner/runtime/`
  (`node scripts/prebake.mjs build`). Without them those cases are marked not
  run; model-written code is never run outside the sandbox.
- **Node 24** and Python 3.

| Variable | Default | What it sets |
|---|---|---|
| `EVAL_ROOT` | none (required) | The evaluation folder above. |
| `AWS_PROFILE` | `default` | The AWS profile for Bedrock and Secrets Manager. |
| `EVAL_DEPLOYMENT_CONFIG` | none | The JSON file naming the secret that holds the reference arm's OpenAI key. Needed only for a real run with the reference arm, or `probe --reference-key`. |
| `EVAL_CALL_TIMEOUT_MS` | `120000` | The per-call timeout the harness gives the product, long enough to measure answer quality apart from hosting speed. Latency is recorded per call either way. |
| `EVAL_PYTHON` | `python3.11`, else `python3` on PATH | The Python the sandboxed runner may start. |
| `EVAL_NODE_BIN` | the Node running the harness | The Node the sandboxed runner may start. |
| `EVAL_NODE` | `node` on PATH | The Node `run.sh` starts the harness with. |

The harness sets the product's own settings itself: one completion in flight
per model (`AI_MAX_CONCURRENCY=1`), `OPENAI_TIMEOUT_MS` from
`EVAL_CALL_TIMEOUT_MS`, and no `OPENAI_API_KEY` or `OPENAI_BASE_URL` from the
shell.

Two files at the checkout root belong to the harness and are ignored by git:
`.eval-scratch/` (workspace copies the sandbox runs, and the plan's
composition runs) and the optional `.eval-starter-state`, a one-line label for
which copy of the Shelf starter fixture this checkout holds. Each run records
that label (or `unknown`) and the fixture's sha256 in `inputs.json`, and a
real run refuses to resume on a different fixture than it started with.

## How to run each phase

`run.sh <phase> [options]` runs `cli.ts` through ts-node from `apps/api`, with
`NODE_OPTIONS` cleared. Every line it prints is privacy-redacted: model
aliases, counts and dollars only. The phases, in order:

| Phase | What it does | Cost |
|---|---|---|
| `derive [--only id,id] [--force]` | Computes each case's deterministic inputs with the product's grader (runner jobs under Seatbelt) into `corpus-derived/`; a file already there is kept unless `--force` | free |
| `plan --run <id> [--stub] [--calibrate <pilot run>] [--pilot-per-job N]` | Sizes every call by composing each case against the loopback stub, and writes `plan.json` with a worst-case estimate and the priority cuts that fit the stop; a paid run refuses to start without a current plan | free |
| `probe --run <id> --reasoning [--stub] [--reference-key]` | One short call per Bedrock model with its reasoning switch, asserting no reasoning comes back, into `reasoning-probe.json`; a paid run requires it | a fraction of a cent |
| `run --run <id> [--stage candidates,exec,judgeA,judgeB,judgeC,pairwise,rejudge\|all] [--models k,k] [--per-job N \| --sample F] [--stop-usd N] [--stub]` | Candidates, executable truth, judges and pairwise comparisons; resumable from its ledger | the plan's estimate |
| `score --run <id>` / `report --run <id>` | Metrics, then the report (Markdown, HTML, CSV and a sponsor summary), from what is on disk | free |
| `spotcheck --run <id> --ingest <csv>` | Folds a human spot check into the report | free |
| `reparse --run <id>` | Re-reads the judgements on disk with the judge-only format tolerance | free |
| `privacy --run <id>` | Scans every file the run wrote and names the kinds of finding per file, never the text | free |

Example, with your own folder:

```bash
export EVAL_ROOT=/path/to/evaluation
apps/api/eval/run.sh derive
apps/api/eval/run.sh plan --run my-run
apps/api/eval/run.sh probe --run my-run --reasoning
apps/api/eval/run.sh run --run my-run
apps/api/eval/run.sh report --run my-run
```

`--stub` routes every provider to `e2e/ai-stub.cjs` on a free loopback port,
so `plan --stub`, `probe --reasoning --stub`, `run --stub` and `report` make a
free dry run of the whole pipeline without credentials. The call kinds the
stub does not answer are answered from each case's own reference, so the
numbers of a dry run say nothing about any model; the report says so on its
first line.

## Its own tests

From the repository root:

```bash
npm run test:eval -w @learnsdlc/api        # the harness's specs
npm run typecheck:eval -w @learnsdlc/api   # the harness against the API as it is
```

`npm run typecheck` at the root includes the second. The specs make no
network call: the provider specs use a fake Converse send, and one dry-run
spec starts the loopback stub. The specs that read a real `models.json` are
skipped unless `EVAL_ROOT` is set. The Seatbelt specs that need
`sandbox-exec` skip where it is missing.
