#!/usr/bin/env bash
# Prove that npm run demo is one command: it starts the product, the product
# answers, and ctrl+c leaves nothing behind.
#
#   npm run demo:check                     # on 3000 and 4000
#   WEB_PORT=3110 API_PORT=4110 npm run demo:check
#   npm run demo:check -- --expect-fast    # also assert the second run skipped the install and the build
#   npm run demo:check -- --ai-stub        # start it with the canned test mentor
#
# The AI it expects is the one the product will report: a loopback
# "local-ai:<model>" with the test stub, or a configured provider with
# OPENAI_API_KEY in the environment or .env, and the closing block has to say
# the same. With neither, the demo must refuse to start: it has to exit
# non-zero, say where the key goes, and leave both ports free. The API, the web app and the stub must be
# the processes it started, and the API must report itself as this demo. Where the runner says
# this machine cannot isolate learner code (any Mac), the demo has to say so
# and still serve the public pages; that is what it asserts there.
#
# It runs against a scratch database, a scratch mail file and a scratch runner
# socket, all removed afterwards, so it can be run on a laptop that already has
# a demo's data in data/ without touching it.
#
# Exit 0, or one line naming the assertion that failed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"
# shellcheck source=scripts/ai-key.sh
. "$ROOT/scripts/ai-key.sh"

EXPECT_FAST=0; AI_STUB=0
for a in "$@"; do
  case "$a" in
    --expect-fast) EXPECT_FAST=1 ;;
    --ai-stub) AI_STUB=1 ;;
    -h|--help) print_usage "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --help)"; exit 1 ;;
  esac
done

WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-4000}"
export WEB_PORT API_PORT
WEB_URL="http://localhost:$WEB_PORT"
API_URL="http://localhost:$API_PORT"

# A cold clone spends most of this on npm install and next build; the demo
# itself answers in seconds once they are done.
READY_TIMEOUT="${DEMO_CHECK_TIMEOUT:-600}"
STOP_TIMEOUT=20

SCRATCH="$ROOT/data/demo-selftest-$API_PORT"
OUT="$SCRATCH/demo.out"
export DB_PATH="$SCRATCH/learnsdlc.sqlite"
export MAIL_CAPTURE_FILE="$SCRATCH/mail.log"
export DEMO_LOG="$SCRATCH/servers.log"
export RUNNER_SOCKET="${TMPDIR:-/tmp}/learnsdlc/selftest-$API_PORT.sock"

DEMO_PID=""

# Who listens on a port: port_listening, listener_pids, listeners_all_visible
# and descends_from are in scripts/lib/common.sh, shared with scripts/demo.sh.
port_held() {
  port_listening "$1"
}

# Answering at all, whether or not this machine lets it confine learner code.
runner_answering() {
  case "$("${PYTHON_BIN:-python3}" -B scripts/runner-status.py 2>/dev/null)" in ok*|unsupported*) return 0 ;; *) return 1 ;; esac
}

# Only ever the process this script started, and only ever by pid.
kill_demo() {
  if [ -z "$DEMO_PID" ]; then return 0; fi
  if kill -0 "$DEMO_PID" 2>/dev/null; then
    kill -INT -"$DEMO_PID" 2>/dev/null || kill -INT "$DEMO_PID" 2>/dev/null || true
    i=0
    while [ "$i" -lt 40 ] && kill -0 "$DEMO_PID" 2>/dev/null; do sleep 0.5; i=$((i + 1)); done
    kill -KILL -"$DEMO_PID" 2>/dev/null || kill -KILL "$DEMO_PID" 2>/dev/null || true
  fi
}

fail() {
  echo "demo:check failed: $1" >&2
  if [ -f "$OUT" ]; then
    echo "--- the last 30 lines of npm run demo ---" >&2
    tail -n 30 "$OUT" >&2 || true
  fi
  kill_demo
  exit 1
}

cleanup() {
  kill_demo
  rm -rf "$SCRATCH"
  rm -f "$RUNNER_SOCKET"
}
trap cleanup EXIT

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"

if port_held "$WEB_PORT"; then fail "port $WEB_PORT is already in use, so this check cannot start the demo"; fi
if port_held "$API_PORT"; then fail "port $API_PORT is already in use, so this check cannot start the demo"; fi
AI_STUB_PORT="${AI_STUB_PORT:-${PW_AI_PORT:-4199}}"
if [ "$AI_STUB" = 1 ] && port_held "$AI_STUB_PORT"; then fail "port $AI_STUB_PORT is already in use, so this check cannot start the test mentor"; fi

# What the product will report, decided before it starts, by the rule the
# demo itself applies (ai_key_present in scripts/ai-key.sh).
if [ "$AI_STUB" = 1 ]; then
  EXPECT_AI=stub; EXPECT_LINE='test stub on 127.0.0.1'; DEMO_ARGS="--ai-stub"
elif ai_key_present "$ROOT"; then
  EXPECT_AI=configured; EXPECT_LINE='configured provider'; DEMO_ARGS=""
else
  # No key and no stub: the demo refuses before it installs or binds anything.
  echo "==> Starting npm run demo without an AI key: it has to refuse"
  set +e
  npm run --silent demo >"$OUT" 2>&1
  REFUSED=$?
  set -e
  [ "$REFUSED" -ne 0 ] || fail "npm run demo started without an AI key"
  grep -q 'LearnSDLC needs an AI key to start' "$OUT" || fail "npm run demo refused without saying it needs an AI key"
  grep -q 'OPENAI_API_KEY=<your key>' "$OUT" || fail "npm run demo did not say where the key goes"
  grep -q 'OPENAI_BASE_URL, OPENAI_MODEL and OPENAI_API_KEY' "$OUT" || fail "npm run demo did not name the OpenAI-compatible route"
  if port_held "$WEB_PORT" || port_held "$API_PORT"; then fail "npm run demo refused but left a port held"; fi
  echo "ok   npm run demo refused to start without an AI key (exit $REFUSED) and said where the key goes"
  exit 0
fi
ISOLATION="$("${PYTHON_BIN:-python3}" -B scripts/runner-status.py --local 2>/dev/null || true)"

echo "==> Starting npm run demo on $WEB_URL and $API_URL"
# set -m so the demo runs in its own process group: the interrupt below is then
# the one a person sends with ctrl+c, delivered to npm and to demo.sh together.
set -m
# DEMO_ARGS is a list of flags, not one word.
# shellcheck disable=SC2086
npm run --silent demo -- $DEMO_ARGS >"$OUT" 2>&1 &
DEMO_PID=$!
set +m

WAITED=0
while [ "$WAITED" -lt "$READY_TIMEOUT" ]; do
  if grep -q '^==> LearnSDLC is running' "$OUT" 2>/dev/null; then break; fi
  if ! kill -0 "$DEMO_PID" 2>/dev/null; then fail "npm run demo stopped before it said it was running"; fi
  sleep 2
  WAITED=$((WAITED + 2))
done
grep -q '^==> LearnSDLC is running' "$OUT" 2>/dev/null \
  || fail "npm run demo did not say it was running within $READY_TIMEOUT seconds"
echo "  ok    it says it is running after ${WAITED}s"

# Whoever answers on these ports has to be the demo this started (its process
# or a child), not something that took a port after the free-port check.
assert_ours() { # port, what it is
  pids="$(listener_pids "$1")"
  [ -n "$pids" ] || fail "no process this check can see is listening on port $1 for $2"
  listeners_all_visible "$1" || fail "$2 on port $1 shares it with a process this check cannot see: another process holds the port"
  for pid in $pids; do
    descends_from "$pid" "$DEMO_PID" \
      || fail "$2 on port $1 is pid $pid, which this check did not start: another process holds the port"
  done
}
assert_ours "$API_PORT" "the api"
assert_ours "$WEB_PORT" "the web app"
if [ "$AI_STUB" = 1 ]; then assert_ours "$AI_STUB_PORT" "the test mentor stub"; fi
echo "  ok    every port it needs is held by the demo this started"

# ------------------------------------------------------------- what it started

HEALTH="$(curl -sf "$API_URL/api/v1/health")" || fail "GET $API_URL/api/v1/health did not answer"
# Readiness answers 503 while the runner is degraded, and its body is what is
# read here, so no -f.
READY="$(curl -s "$API_URL/api/v1/health/ready")" || fail "GET $API_URL/api/v1/health/ready did not answer"
node -e '
  const [health, ready, expected] = process.argv.slice(1);
  const parse = (name, body) => {
    try { return JSON.parse(body); } catch (error) { console.error(`${name} is not JSON: ${body.slice(0, 200)}`); process.exit(1); }
  };
  const h = parse("health", health);
  const r = parse("health/ready", ready);
  if (h.status !== "ok") { console.error(`health.status is ${h.status}, not ok`); process.exit(1); }
  // Identity: what LearnSDLC itself reports about this instance, so a
  // different server answering on the port fails here as well as on its pid.
  const deps = new Map((r.dependencies || []).map((d) => [d.name, d]));
  const content = deps.get("content");
  const looksLikeThis =
    deps.get("database")?.detail === "better-sqlite3" &&
    deps.has("runner") && deps.has("isolation") &&
    typeof content?.detail === "string" && /^tasktrackr \d/.test(content.detail) &&
    r.queue?.backend === "in-process" &&
    r.aiProvider === h.aiProvider;
  if (!looksLikeThis) { console.error("the api on this port is not the SQLite LearnSDLC demo this check started"); process.exit(1); }
  // The product reports "openai", "local-ai:<model>" (a loopback endpoint,
  // which is what the stub is), "compatible-ai:<model>", or "unavailable";
  // it never stands a simulated mentor in for a missing provider.
  const ok = expected === "stub" ? h.aiProvider.startsWith("local-ai:")
    : expected === "configured" ? h.aiProvider !== "unavailable"
    : h.aiProvider === "unavailable";
  if (!ok) { console.error(`health.aiProvider is ${h.aiProvider}, which is not the ${expected} AI this demo was started with`); process.exit(1); }
' "$HEALTH" "$READY" "$EXPECT_AI" || fail "GET $API_URL/api/v1/health is not the LearnSDLC demo, or not with the $EXPECT_AI AI"
grep -q "AI  *$EXPECT_LINE" "$OUT" \
  || fail "npm run demo did not name its AI as \"$EXPECT_LINE\" in the closing block"
echo "  ok    the api is the demo this started, and reports the $EXPECT_AI AI the closing block names"

case "$ISOLATION" in
  ok*)
    grep -q 'confining learner code' "$OUT" || fail "the runner confines learner code here, and npm run demo did not say so"
    echo "  ok    the runner confines learner code (${ISOLATION#ok })" ;;
  *)
    grep -q 'cannot isolate learner code' "$OUT" || fail "this machine cannot isolate learner code, and npm run demo did not say so"
    grep -q 'Run, Submit and Preview are refused' "$OUT" || fail "npm run demo did not say Run, Submit and Preview are refused here"
    echo "  ok    it says this machine cannot isolate learner code and refuses Run, Submit and Preview"
    HOME_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/")"
    [ "$HOME_CODE" = 200 ] || fail "GET $WEB_URL/ answered $HOME_CODE, not 200"
    echo "  ok    the public pages still serve" ;;
esac

WEB_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/login")"
[ "$WEB_CODE" = 200 ] || fail "GET $WEB_URL/login answered $WEB_CODE, not 200"
echo "  ok    the web app serves /login"

LOGIN_BODY="$SCRATCH/login.json"
# The body is built in Node from the environment and sent on stdin, so the
# password never sits on a command line where the process list shows it.
LOGIN_CODE="$(SEED_PASSWORD="${SEED_PASSWORD:-}" DEMO_INSTRUCTOR_EMAIL="$DEMO_INSTRUCTOR_EMAIL" \
  DEMO_INSTRUCTOR_DEFAULT_PASSWORD="$DEMO_INSTRUCTOR_DEFAULT_PASSWORD" node -e '
    const { SEED_PASSWORD, DEMO_INSTRUCTOR_EMAIL, DEMO_INSTRUCTOR_DEFAULT_PASSWORD } = process.env;
    process.stdout.write(JSON.stringify({ email: DEMO_INSTRUCTOR_EMAIL, password: SEED_PASSWORD || DEMO_INSTRUCTOR_DEFAULT_PASSWORD }));
  ' | curl -s -o "$LOGIN_BODY" -w '%{http_code}' -X POST "$API_URL/api/v1/auth/login" \
  -H 'content-type: application/json' --data-binary @-)"
[ "$LOGIN_CODE" = 200 ] || fail "signing in as $DEMO_INSTRUCTOR_EMAIL answered $LOGIN_CODE, not 200"
node -e '
  const body = require("fs").readFileSync(process.argv[1], "utf8");
  const parsed = JSON.parse(body);
  if (!parsed.token) { console.error("the sign-in answered 200 with no token"); process.exit(1); }
' "$LOGIN_BODY" || fail "the demo staff account signed in without a token"
echo "  ok    $DEMO_INSTRUCTOR_EMAIL signs in"

if [ "$EXPECT_FAST" = 1 ]; then
  grep -q 'node_modules is current' "$OUT" \
    || fail "the second run reinstalled: no \"node_modules is current\" line"
  grep -q 'the build is newer than every source file' "$OUT" \
    || fail "the second run rebuilt: no \"the build is newer than every source file\" line"
  echo "  ok    it skipped the install and the build"
fi

# --------------------------------------------------------------------- ctrl+c

echo "==> Stopping it the way a person does"
kill -INT -"$DEMO_PID" 2>/dev/null || kill -INT "$DEMO_PID" 2>/dev/null || true

WAITED=0
while [ "$WAITED" -lt "$STOP_TIMEOUT" ]; do
  if ! kill -0 "$DEMO_PID" 2>/dev/null; then break; fi
  sleep 1
  WAITED=$((WAITED + 1))
done
if kill -0 "$DEMO_PID" 2>/dev/null; then fail "npm run demo was still running $STOP_TIMEOUT seconds after the interrupt"; fi
set +e
wait "$DEMO_PID"
DEMO_STATUS=$?
set -e
DEMO_PID=""
# demo.sh exits 0 on an interrupt, and its last four lines below prove it ran
# its own stop. npm, which is in the same process group and takes the same
# SIGINT a terminal sends, reports the interrupt as 130 (128 + SIGINT) on its
# own account, so both are the status of a clean ctrl+c and nothing else is.
case "$DEMO_STATUS" in
  0|130) ;;
  *) fail "npm run demo exited $DEMO_STATUS after the interrupt, which is neither 0 nor an interrupt" ;;
esac

if port_held "$API_PORT"; then fail "port $API_PORT is still held after the interrupt"; fi
if port_held "$WEB_PORT"; then fail "port $WEB_PORT is still held after the interrupt"; fi
if runner_answering; then fail "the sandbox runner is still answering on $RUNNER_SOCKET after the interrupt"; fi
if [ "$AI_STUB" = 1 ] && port_held "$AI_STUB_PORT"; then fail "port $AI_STUB_PORT (the test mentor) is still held after the interrupt"; fi
grep -q '^Stopping\.' "$OUT" || fail "npm run demo did not say it was stopping"
echo "  ok    both ports are free and the sandbox runner is gone"

echo
echo "demo:check passed on $WEB_URL and $API_URL"
