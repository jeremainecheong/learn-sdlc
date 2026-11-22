#!/usr/bin/env bash
# LearnSDLC's whole stack in containers, on this machine: every feature,
# learner code included, on any host that runs Docker.
#
#   bash scripts/stack.sh up                 # AI from your key in .env (OpenAI or any compatible endpoint)
#   bash scripts/stack.sh up --ai-stub       # the deterministic test mentor, for CI and scripts/prove-local.sh
#   bash scripts/stack.sh up --fresh         # wipe this stack's data first
#   bash scripts/stack.sh up --detach        # return once it is up (CI, scripts/prove-local.sh)
#   bash scripts/stack.sh stop               # stop the containers, keep everything
#   bash scripts/stack.sh down [--fresh]     # remove the containers (and, with --fresh, the data)
#   bash scripts/stack.sh status | logs
#   bash scripts/stack.sh compose <args>     # docker compose with this stack's files
#
# npm run demo -- --docker [--ai-stub] [--fresh] [--down] is the same thing;
# npm run stack -- <command> too.
#
# What `up` does, in order: checks Docker, Compose, the ports, the disk and the
# memory; writes .env.verify (this machine's own generated secrets, 0600, never
# committed) on the first run; builds the runner, api and web images one at a
# time; starts PostgreSQL, Redis, the runner, the API, the web app, Caddy and
# Mailpit as the Compose project learnsdlc; runs the migrations (the
# API applies them at boot); waits for every health check; creates the demo
# instructor; and prints where everything is. Without --detach it then follows
# the API's log until ctrl+c, which stops the containers.
#
# Ports, all on 127.0.0.1 only: web 3080, API 4080, captured mail 5085.
# STACK_WEB_PORT, STACK_API_PORT and STACK_MAIL_PORT choose others before the
# first start; .env.verify keeps them after that.
# An AI key is required: `up` refuses to start without OPENAI_API_KEY in .env
# (or the environment) unless --ai-stub asks for the test mentor by name.
#
# The Compose project is learnsdlc, and its containers and volumes carry that
# name; LEARNSDLC_STACK_PROJECT=<name> on every command gives a second checkout
# on the same machine a project of its own. A stack created under an earlier
# default, learnsdlc-redesign, keeps its database, queue and backups in that
# project's volumes: set LEARNSDLC_STACK_PROJECT=learnsdlc-redesign to keep
# using it, or run
# LEARNSDLC_STACK_PROJECT=learnsdlc-redesign bash scripts/stack.sh down --fresh
# to delete it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"

# The Compose project: its containers, volumes and images carry this name.
# LEARNSDLC_STACK_PROJECT gives a second checkout on the same machine its own
# (with its own ports, below).
PROJECT="${LEARNSDLC_STACK_PROJECT:-learnsdlc}"
ENV_FILE=".env.verify"
# Which AI the stack was last started with, so stop, down, status and logs
# address the same services. Matched by .gitignore's `.env.*`.
MODE_FILE=".env.verify-ai"

# The three published ports. Once .env.verify exists its values win, because
# the web bundle was built for the API address in it; before that the
# environment chooses, and 3080, 4080 and 5085 are the defaults. Exported for
# docker-compose.verify.yml and for the Node checks (scripts/lib/endpoints.mjs).
stack_port() { # name, default
  local value
  value="$(env_value "$ENV_FILE" "$1")"
  [ -n "$value" ] || value="${!1:-}"
  printf '%s' "${value:-$2}"
}
STACK_WEB_PORT="$(stack_port STACK_WEB_PORT 3080)"
STACK_API_PORT="$(stack_port STACK_API_PORT 4080)"
STACK_MAIL_PORT="$(stack_port STACK_MAIL_PORT 5085)"
export STACK_WEB_PORT STACK_API_PORT STACK_MAIL_PORT
WEB_URL="http://localhost:$STACK_WEB_PORT"
API_URL="http://localhost:$STACK_API_PORT/api/v1"
MAIL_URL="http://localhost:$STACK_MAIL_PORT"
PORTS="$STACK_WEB_PORT $STACK_API_PORT $STACK_MAIL_PORT"

COMMAND="up"; AI="provider"; FRESH=0; DETACH=0; BUILD=1; AI_SET=0
PASSTHROUGH=()
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    # docker compose with this stack's files, project and AI, for scripts
    # (scripts/prove-local.sh) and for anyone who wants a command it lacks.
    compose)     COMMAND=compose; PASSTHROUGH=("$@"); break ;;
    up|stop|down|status|logs) COMMAND="$a" ;;
    --ai-stub)   AI=stub; AI_SET=1 ;;
    --fresh)     FRESH=1 ;;
    --detach)    DETACH=1 ;;
    --no-build)  BUILD=0 ;;
    -h|--help)   print_usage "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

# For stop, down, status and logs the AI is the one `up` last used.
if [ "$COMMAND" != up ] && [ "$AI_SET" = 0 ] && [ -f "$MODE_FILE" ]; then
  AI="$(tr -dc 'a-z-' < "$MODE_FILE")"
  case "$AI" in stub|provider) ;; *) AI=provider ;; esac
fi

compose_files() {
  printf '%s\n' -f docker-compose.yml -f docker-compose.verify.yml
  case "$AI" in
    stub) printf '%s\n' -f docker-compose.ai-stub.yml --profile ai-stub ;;
  esac
}
COMPOSE=(docker compose --env-file "$ENV_FILE" -p "$PROJECT")
while IFS= read -r arg; do COMPOSE+=("$arg"); done < <(compose_files)
# One build or pull at a time: a laptop's memory, not the network, is the limit.
export COMPOSE_PARALLEL_LIMIT=1

# ------------------------------------------------------------- the other commands

# Everything Compose made for this project, found by its project label.
# Returns 1 when there was nothing to remove.
remove_project_by_label() {
  local label="label=com.docker.compose.project=$PROJECT" ids found=1
  ids="$(docker ps -aq --filter "$label")"
  # shellcheck disable=SC2086
  if [ -n "$ids" ]; then docker rm -f $ids >/dev/null; found=0; fi
  ids="$(docker volume ls -q --filter "$label")"
  # shellcheck disable=SC2086
  if [ -n "$ids" ]; then docker volume rm $ids >/dev/null; found=0; fi
  ids="$(docker network ls -q --filter "$label")"
  # shellcheck disable=SC2086
  if [ -n "$ids" ]; then docker network rm $ids >/dev/null; found=0; fi
  return "$found"
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker was not found. Install Colima (macOS), Docker Engine with the compose plugin (Linux) or Docker Desktop with WSL2 (Windows): docs/local-run.md, Prerequisites."
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running. Start it (colima start on a Mac, sudo systemctl start docker on Linux), then run this again."
}

case "$COMMAND" in
  compose) need_docker; [ -f "$ENV_FILE" ] || die "this stack has never been started here ($ENV_FILE is missing)."; exec "${COMPOSE[@]}" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} ;;
  status) need_docker; [ -f "$ENV_FILE" ] || die "this stack has never been started here ($ENV_FILE is missing)."; "${COMPOSE[@]}" ps; exit 0 ;;
  logs)   need_docker; [ -f "$ENV_FILE" ] || die "this stack has never been started here ($ENV_FILE is missing)."; exec "${COMPOSE[@]}" logs -f --tail 100 ;;
  stop)
    need_docker
    [ -f "$ENV_FILE" ] || { ok "nothing to stop: this stack has never been started here"; exit 0; }
    step "Stopping the containers (data and images are kept)"
    "${COMPOSE[@]}" stop
    ok "stopped. Start again with the same command you used before; it reuses the images and the data."
    exit 0 ;;
  down)
    need_docker
    if [ ! -f "$ENV_FILE" ]; then
      # Compose cannot read the stack's files without .env.verify (the base
      # file requires its variables), so the project's containers, volumes and
      # networks are found by the label Compose put on them.
      if [ "$FRESH" = 1 ] && remove_project_by_label; then
        ok "removed this stack's containers and data ($ENV_FILE was missing). The images are kept."
      else
        ok "nothing to remove: this stack has no $ENV_FILE here (down --fresh also removes data left without it)"
      fi
      exit 0
    fi
    if [ "$FRESH" = 1 ]; then
      step "Removing the containers and this stack's data (database, queue, backups, certificates)"
      "${COMPOSE[@]}" down --volumes --remove-orphans
      ok "removed. The images are kept, so the next start does not rebuild from scratch."
    else
      step "Removing the containers (the data is kept)"
      "${COMPOSE[@]}" down --remove-orphans
      ok "removed. The data is kept; add --fresh to remove it too."
    fi
    exit 0 ;;
esac

# --------------------------------------------------------------- prerequisites

# No key, no start: before anything is checked, built or pulled. --ai-stub is
# the only way past this, and it has to be asked for.
if [ "$AI" = provider ]; then
  # shellcheck source=scripts/ai-key.sh
  . "$ROOT/scripts/ai-key.sh"
  require_ai_key "$ROOT"
fi

step "Checking this machine"
need_docker
COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || true)"
[ -n "$COMPOSE_VERSION" ] || die "docker compose (v2) was not found. Install the compose plugin (docker-compose-plugin on Linux; brew install docker-compose on a Mac, then follow its note), then run this again."
# The !override tag in docker-compose.verify.yml needs Compose 2.24 or newer.
compose_new_enough() {
  local v="${COMPOSE_VERSION#v}" major minor
  major="${v%%.*}"; v="${v#*.}"; minor="${v%%.*}"
  [ "${major:-0}" -gt 2 ] 2>/dev/null || { [ "${major:-0}" -eq 2 ] && [ "${minor:-0}" -ge 24 ]; } 2>/dev/null
}
compose_new_enough || die "docker compose $COMPOSE_VERSION is too old; this needs 2.24 or newer. Update the compose plugin."
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), compose $COMPOSE_VERSION"

command -v node >/dev/null 2>&1 || die "node was not found. Install Node 24 (nvm install, which reads .nvmrc); this script uses it to create the demo instructor and to write the sandbox manifest."
command -v curl >/dev/null 2>&1 || die "curl was not found; it is how this asks the stack whether it answers. Install it."

# Already ours? Then its ports are not "taken".
RUNNING=""
if [ -f "$ENV_FILE" ]; then
  RUNNING="$("${COMPOSE[@]}" ps --status running -q 2>/dev/null || true)"
fi
if [ -z "$RUNNING" ]; then
  for p in $PORTS; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      die "port $p is already in use on this machine. Stop whatever holds it (lsof -iTCP:$p -sTCP:LISTEN names it), then run this again. The stack's ports are web $STACK_WEB_PORT, API $STACK_API_PORT and mail $STACK_MAIL_PORT; STACK_WEB_PORT, STACK_API_PORT and STACK_MAIL_PORT move them before the first start, and after it the ports kept in .env.verify apply."
    fi
  done
  ok "ports $STACK_WEB_PORT, $STACK_API_PORT and $STACK_MAIL_PORT are free"
else
  ok "this stack is already running; its ports are its own"
fi

# Free space where Docker keeps its images: Docker Desktop's disk lives under
# the home folder, Docker Engine's under its root directory.
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
DISK_AT="$HOME"
if [ "$(uname -s)" = Linux ] && [ -n "$DOCKER_ROOT" ] && [ -d "$DOCKER_ROOT" ]; then DISK_AT="$DOCKER_ROOT"; fi
FREE_GB="$(df -Pk "$DISK_AT" 2>/dev/null | awk 'NR==2 { printf "%d", $4 / 1048576 }')"
# Docker Desktop keeps images inside its VM's own fixed-size disk, which fills
# long before the host's does. Ask the VM (a 4 MB image, pulled once).
if [ "$(uname -s)" != Linux ]; then
  VM_FREE_GB="$(docker run --rm alpine:3.20 df -Pk / 2>/dev/null | awk 'NR==2 { printf "%d", $4 / 1048576 }' || true)"
  if [ -n "$VM_FREE_GB" ] && { [ -z "$FREE_GB" ] || [ "$VM_FREE_GB" -lt "$FREE_GB" ]; }; then FREE_GB="$VM_FREE_GB"; fi
fi

NEED_GB=10
if [ -n "$FREE_GB" ] && [ "$FREE_GB" -lt "$NEED_GB" ]; then
  die "only ${FREE_GB} GB is free where Docker keeps its data; this needs about ${NEED_GB} GB (the images and room to build). Free some space (docker builder prune and docker image prune remove build cache and unused images; colima start --disk or Docker Desktop, Settings, Resources raises the VM disk), then run this again."
fi
ok "${FREE_GB:-?} GB free for Docker (about ${NEED_GB} GB needed)"

# Caddy and the test mentor read files from this checkout through bind mounts.
# A Docker VM that does not share this folder (Colima and Lima share only the
# home folder by default) would mount empty directories in their place.
if docker run --rm -v "$ROOT/infra:/checkout-infra:ro" alpine:3.20 test -f /checkout-infra/Caddyfile.local >/dev/null 2>&1; then
  ok "Docker can read this checkout ($ROOT)"
else
  die "Docker cannot see this checkout ($ROOT): its VM does not share this folder. Clone under your home folder, or share the folder with the VM (Colima: colima start --mount <folder>), then run this again."
fi

MEM_BYTES="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
MEM_GB=$((MEM_BYTES / 1073741824))
NEED_MEM=6
if [ "$MEM_GB" -lt "$NEED_MEM" ]; then
  warn "Docker may use ${MEM_GB} GB of memory; this stack wants about ${NEED_MEM} GB. Raise it (colima start --memory 8; Docker Desktop: Settings, Resources), or expect slow builds and out-of-memory restarts."
else
  ok "Docker may use ${MEM_GB} GB of memory (about ${NEED_MEM} GB wanted)"
fi

# ------------------------------------------------------------------ the AI

AI_LINE=""
case "$AI" in
  stub)
    AI_LINE="test mentor (e2e/ai-stub.cjs) inside the stack: canned answers, no key, nothing leaves this machine. It passes only work marked E2E-PASS."
    ok "AI: the deterministic test mentor (no key needed)" ;;
  provider)
    # The variables a hosted model needs, from the private .env, handed to
    # Compose through the environment (which wins over .env.verify) and never
    # written anywhere else.
    for name in OPENAI_API_KEY OPENAI_BASE_URL OPENAI_MODEL OPENAI_REASONING_EFFORT OPENAI_TIMEOUT_MS; do
      value="$(env_value .env "$name")"
      if [ -n "$value" ]; then export "$name=$value"; fi
    done
    BASE="${OPENAI_BASE_URL:-$(env_value "$ENV_FILE" OPENAI_BASE_URL)}"
    AI_LINE="your provider from .env: model ${OPENAI_MODEL:-default (OPENAI_MODEL in docker-compose.yml)}$([ -n "$BASE" ] && [ "$BASE" != https://api.openai.com/v1 ] && echo ' at your OPENAI_BASE_URL' || echo ' at OpenAI')"
    ok "AI: the key in .env (model ${OPENAI_MODEL:-the default})" ;;
esac

# ------------------------------------------------------- this machine's secrets

step "Configuration"
if [ ! -f "$ENV_FILE" ]; then
  if docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1; then
    if [ "$FRESH" = 1 ]; then
      remove_project_by_label || true
      ok "removed the data left without $ENV_FILE (--fresh)"
    else
      die "$ENV_FILE is missing but this stack's database volume is still here, and its password was in that file. Run: bash scripts/stack.sh down --fresh (deletes the old data), then this again."
    fi
  fi
  # Generated here, once, for this machine: never a published value, from the
  # generators setup.sh uses for .env (new_secret and new_password in
  # scripts/lib/common.sh). The API inside its container binds every
  # interface, so the demo instructor's password is one of them too. The AI
  # settings are not written here: docker-compose.yml and
  # docker-compose.verify.yml hold their defaults, and the key comes from .env
  # at every start.
  GENERATED_JWT_SECRET="$(new_secret)" \
  GENERATED_ADMIN_PASSWORD="$(new_password)" \
  GENERATED_POSTGRES_PASSWORD="$(new_password)" \
  GENERATED_INSTRUCTOR_PASSWORD="$(new_password)" \
  node -e '
    const fs = require("fs");
    const { STACK_WEB_PORT: web, STACK_API_PORT: api, STACK_MAIL_PORT: mail } = process.env;
    const generated = (name) => {
      const value = process.env[`GENERATED_${name}`];
      if (!value) throw new Error(`nothing was generated for ${name}`);
      return value;
    };
    const settings = {
      SITE_HOST: "localhost", API_HOST: "localhost",
      STACK_WEB_PORT: web, STACK_API_PORT: api, STACK_MAIL_PORT: mail,
      JWT_SECRET: generated("JWT_SECRET"),
      ADMIN_EMAIL: "verification-admin@learnsdlc.local", ADMIN_PASSWORD: generated("ADMIN_PASSWORD"),
      POSTGRES_PASSWORD: generated("POSTGRES_PASSWORD"),
      STACK_INSTRUCTOR_PASSWORD: generated("INSTRUCTOR_PASSWORD"),
      NEXT_PUBLIC_API_URL: `http://localhost:${api}`, NEXT_PUBLIC_SITE_URL: `http://localhost:${web}`,
      WEB_ORIGIN: `http://localhost:${web}`, RUN_MIGRATIONS: "true",
      JOB_CONCURRENCY: "1", RUNNER_SLOTS: "2",
      PREVIEW_SESSIONS: "1", PREVIEW_MEMORY_MB: "256", RUN_MEMORY_MB: "256",
    };
    const text = Object.entries(settings).map(([k, v]) => `${k}=${v}\n`).join("");
    fs.writeFileSync(process.argv[1], text, { mode: 0o600 });
    fs.chmodSync(process.argv[1], 0o600);
  ' "$ENV_FILE"
  ok "created $ENV_FILE: this machine's own secrets and sign-in details (0600, ignored by git)"
else
  ok "$ENV_FILE is in place (reused, so the data volumes still open)"
  # A .env.verify without the demo instructor's password gets one now;
  # every other value in it is kept, so the data volumes still open.
  case "$(ensure_env_secret "$ENV_FILE" STACK_INSTRUCTOR_PASSWORD new_password || true)" in
    kept) ;;
    written) ok "added STACK_INSTRUCTOR_PASSWORD to $ENV_FILE: the demo instructor's password, generated for this machine" ;;
    *) die "the demo instructor's password could not be generated into $ENV_FILE (node writes it)." ;;
  esac
fi
printf '%s\n' "$AI" > "$MODE_FILE"

if [ "$FRESH" = 1 ]; then
  step "Wiping this stack's data (--fresh)"
  "${COMPOSE[@]}" down --volumes --remove-orphans
  ok "containers and volumes removed; images kept"
fi

# ------------------------------------------------------------------ the images

if [ "$BUILD" = 1 ]; then
  step "Building the images, one at a time (the first build takes 3-20 minutes, depending on the network)"
  # The runner image installs the sandbox's dependencies inside itself, for its
  # own platform; it only needs the manifest that says which.
  if [ ! -f apps/api/runner/runtime/manifest.json ] || ! node scripts/prebake.mjs manifest >/dev/null 2>&1; then
    PY="$(find_python atleast || true)"
    [ -n "$PY" ] || die "Python 3.11 or newer was not found; it writes the sandbox manifest the runner image is built from. Install it (docs/local-run.md, Prerequisites)."
    PYTHON_BIN="$PY" node scripts/prebake.mjs manifest || die "the sandbox manifest could not be written; the message above says why."
  fi
  ok "sandbox manifest is current"
  for service in runner api web; do
    printf '  ... %s\n' "$service"
    "${COMPOSE[@]}" build "$service" || die "the $service image did not build; the output above says why."
    ok "$service image built"
  done
else
  ok "--no-build: reusing the images that are here"
fi

# ------------------------------------------------------------------ the stack

STOPPING=0
on_interrupt() {
  [ "$STOPPING" = 1 ] && return 0
  STOPPING=1
  echo
  step "Stopping (ctrl+c)"
  "${COMPOSE[@]}" stop || true
  ok "stopped. The data and images are kept; the same command starts it again."
  exit 130
}
trap on_interrupt INT TERM

show_failure() {
  echo
  "${COMPOSE[@]}" ps || true
  local confinement
  # The runner says at start which fence it has; its health probe only exits 1.
  confinement="$("${COMPOSE[@]}" logs --no-color runner 2>/dev/null | grep -o 'confinement: .*' | tail -n 1 || true)"
  if [ -n "$confinement" ]; then
    echo "  The runner reports: $confinement"
    case "$confinement" in
      *unsupported*)
        echo "  Its kernel has no Landlock, so it refuses to run learner code and the stack stops here."
        echo "  Docker Desktop's VM kernel is built without Landlock (checked on Docker Desktop with"
        echo "  Docker 27.4 on macOS). On a Mac, run the stack in Colima instead: docs/local-run.md,"
        echo "  Prerequisites. On Linux, use a kernel of 5.13 or newer with Landlock enabled." ;;
    esac
  fi
  echo "  Logs: bash scripts/stack.sh logs"
}

step "Starting (PostgreSQL, Redis, runner, API with migrations, web, Caddy, Mailpit)"
# --remove-orphans: a switch of AI (from --ai-stub to your key) leaves the
# test mentor's container behind otherwise.
"${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 300 || { show_failure; die "the stack did not become healthy (each service has five minutes; one that fails its health check stops it sooner)."; }
ok "every service reports healthy"

curl -fsS -o /dev/null "$API_URL/health/ready" || { show_failure; die "the API is up but $API_URL/health/ready does not answer ready."; }
ok "API ready (database, queue and runner answer): $API_URL"
curl -fsS -o /dev/null "$WEB_URL/login" || die "the web app does not answer $WEB_URL/login."
ok "web answering: $WEB_URL"

step "Demo accounts and the reference project"
node scripts/stack-seed.mjs || die "the demo instructor could not be created; the message above says why."

AI_PROVIDER="$(curl -fsS "$API_URL/health" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).aiProvider||"")}catch{}})' || true)"

cat <<BLOCK

==> LearnSDLC is running (Compose project $PROJECT)

  Web          $WEB_URL
  API          $API_URL
  Mail         $MAIL_URL (every message the stack sends lands here)

  Learner      register at $WEB_URL/register
  Instructor   $DEMO_INSTRUCTOR_EMAIL, password STACK_INSTRUCTOR_PASSWORD in $ENV_FILE
  Admin        ADMIN_EMAIL and ADMIN_PASSWORD in $ENV_FILE
               Both passwords were generated for this machine: open $ENV_FILE to sign in.

  AI           $AI_LINE
               The API reports: ${AI_PROVIDER:-unknown}
  Runner       its own container: no network, read-only, every learner run confined

  Stop         ctrl+c here, or: bash scripts/stack.sh stop
  Remove       bash scripts/stack.sh down        (add --fresh to delete the data too)
  Prove it     bash scripts/prove-local.sh --reuse

BLOCK

if [ "$DETACH" = 1 ]; then
  trap - INT TERM
  exit 0
fi

echo "Following the API and runner logs. ctrl+c stops the stack."
"${COMPOSE[@]}" logs -f --tail 0 api runner &
LOGS_PID=$!
set +e
wait "$LOGS_PID"
set -e
# Here only when the log stream ended by itself: the containers were stopped
# from somewhere else. Nothing is left for this script to stop.
trap - INT TERM
echo
echo "The log stream ended (the containers were stopped elsewhere). bash scripts/stack.sh status shows them."
