#!/usr/bin/env bash
# One-time setup for a fresh clone of LearnSDLC.
#
#   bash scripts/setup.sh              # deps + build (what most people need)
#   bash scripts/setup.sh --with-ai    # show hosted OpenAI configuration guidance
#   bash scripts/setup.sh --with-aws   # also start LocalStack + deploy the runner Lambda
#
# Safe to re-run: the install and .env are skipped when they are already
# there; the build and the sandbox's pre-baked layer are rebuilt each time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"

WITH_AI=0; WITH_AWS=0
for a in "$@"; do
  case "$a" in
    --with-ai)  WITH_AI=1 ;;
    --with-aws) WITH_AWS=1 ;;
    -h|--help)  print_usage "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --help)"; exit 1 ;;
  esac
done

echo "==> Checking prerequisites"

command -v node >/dev/null || die "node not found. Run 'nvm install' to use the version in .nvmrc."
node_supported || die "node $(node -v) is unsupported; use Node 24.9+ LTS (run 'nvm install')."
ok "node $(node -v)"

command -v npm >/dev/null || die "npm not found (it ships with Node)."
ok "npm $(npm -v)"

# The sandbox runner itself needs only the standard library; the libraries
# learner code imports are pre-baked below, for Python 3.11 exactly.
# PYTHON_BIN, when set (scripts/demo.sh sets it to an absolute path), is tried
# first, and the one found is used by the pre-bake and the runner.
PYTHON_FOUND="$(find_python exact || true)"
[ -n "$PYTHON_FOUND" ] \
  || die "Python 3.11 was not found (${PYTHON_BIN:-python3} is $(python_version "${PYTHON_BIN:-python3}")). The sandbox's pre-baked layer needs 3.11 exactly: install it (brew install python@3.11, or apt install python3.11), or set PYTHON_BIN to one."
export PYTHON_BIN="$PYTHON_FOUND"
PY="$(python_version "$PYTHON_BIN")"
ok "python3 $PY"

echo "==> Installing dependencies"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ] \
   && [ package-lock.json -ot node_modules/.package-lock.json ]; then
  ok "node_modules already up to date (delete node_modules to force a reinstall)"
else
  echo "  this downloads ~600MB and takes a few minutes on a cold cache..."
  # npm ci installs exactly what package-lock.json pins and never rewrites it.
  npm ci
  ok "dependencies installed"
fi

echo "==> Building"
npm run build
ok "shared + api + web built"

echo "==> Sandbox dependencies"
# Flask, pytest, React, jsdom and esbuild, on disk before the first learner run:
# a graded run has no network and no package manager, so anything a learner's
# code imports has to be here already. Skipped in one line when no pack declares
# a runtime block, and never run during a job.
if node scripts/prebake.mjs build; then
  ok "the sandbox's pre-baked layer is ready"
else
  die "the sandbox's dependencies could not be built; the message above says which one."
fi

echo "==> Configuration"
# .env is created once, from .env.example, and then belongs to this machine.
# Its JWT_SECRET is generated here (scripts/lib/common.sh, ensure_env_secret):
# written when it is empty or a value this repository publishes, and never
# replaced once it is real, because a new one signs everyone out and redraws
# every quiz paper in progress.
ENV_CREATED=0
if [ ! -f .env ]; then
  cp .env.example .env
  ENV_CREATED=1
fi
JWT_OUTCOME="$(ensure_env_secret .env JWT_SECRET)" \
  || die "a JWT_SECRET could not be generated into .env (node writes it); set JWT_SECRET in .env yourself and run this again."
case "$ENV_CREATED:$JWT_OUTCOME" in
  1:*)        ok ".env created from .env.example, with a JWT_SECRET generated for this machine - set OPENAI_API_KEY in it (required)" ;;
  0:kept)     ok ".env already exists (left untouched)" ;;
  0:replaced) ok ".env already exists; its JWT_SECRET was a published placeholder, so one was generated for this machine (nothing else changed)" ;;
  0:*)        ok ".env already exists; its JWT_SECRET was empty, so one was generated for this machine (nothing else changed)" ;;
esac

if [ "$WITH_AWS" = 1 ]; then
  echo "==> Mock AWS (LocalStack)"
  command -v docker >/dev/null || die "docker not found; needed for --with-aws."
  docker info >/dev/null 2>&1 || die "the docker daemon is not running."
  if docker ps --format '{{.Names}}' | grep -q '^learnsdlc-localstack$'; then
    ok "localstack already running"
  else
    docker rm -f learnsdlc-localstack >/dev/null 2>&1 || true
    # Loopback only: LocalStack holds the Docker socket, which is root on this
    # machine, so nothing else on the network may reach it.
    docker run -d --name learnsdlc-localstack -p 127.0.0.1:4566:4566 \
      -e SERVICES=lambda -v /var/run/docker.sock:/var/run/docker.sock \
      localstack/localstack:3 >/dev/null
    ok "localstack started on 127.0.0.1:4566"
  fi
  command -v aws >/dev/null \
    && { bash scripts/localstack-lambda.sh && ok "runner Lambda deployed"; } \
    || warn "aws CLI not found - skipping the Lambda deploy. Install it and re-run scripts/localstack-lambda.sh."
  warn "the Lambda runner is Python-only: its python3.11 runtime has no node,"
  warn "so the front-end half of a phase needs RUNNER_MODE=local or socket."
fi

if [ "$WITH_AI" = 1 ]; then
  echo "==> Hosted AI"
  warn "Add OPENAI_API_KEY to the private .env in your editor."
  warn "The model is OPENAI_MODEL in .env, or the default .env.example names. No local model is started."
fi

cat <<DONE

==> Setup complete

  Start the app:            bash scripts/start.sh
  AI configuration:        add OPENAI_API_KEY to .env before starting
  Run the tests:            npm test (its runner suite needs pytest: $PYTHON_BIN -m pip install pytest)
  Acceptance suite:         npm run e2e

  Web  http://localhost:${WEB_PORT:-3000}
  API  http://localhost:${API_PORT:-4000}

  Register a learner at /register. scripts/start.sh also seeds staff accounts
  (loopback only, passwords published):
    $DEMO_INSTRUCTOR_EMAIL / $(staff_password_shown "$DEMO_INSTRUCTOR_DEFAULT_PASSWORD")
    $DEMO_ADMIN_EMAIL      / $(staff_password_shown "$DEMO_ADMIN_DEFAULT_PASSWORD")
DONE
