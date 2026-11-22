# Helpers the local-run scripts share. Sourced, never run:
#
#   . "$ROOT/scripts/lib/common.sh"
#
# Every function here is plain bash and reads nothing until it is called, so a
# script can source this first and still parse its own options before it
# checks the machine. Output goes to stdout, except die, which writes to stderr
# and exits.

# ---------------------------------------------------------------- the output

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }
die()  { printf '  \033[31mfail\033[0m  %s\n' "$1" >&2; exit 1; }

# A script's --help: the comment block at the top of the file, without the
# shebang and without the leading "# ".
print_usage() { # script path
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$1"
}

# ----------------------------------------------------------- the demo accounts

# The two demo staff accounts the native demo seeds (SEED_DEMO_ACCOUNTS, on a
# loopback bind only). Their default passwords are published, which is why
# that path binds 127.0.0.1 and why the API refuses them at sign-in wherever
# the network can reach it; SEED_PASSWORD replaces both. The local Compose
# stack creates the instructor's address on a password it generates into
# .env.verify (scripts/stack.sh). The same values are in
# scripts/lib/demo-accounts.mjs for the Node scripts and in
# apps/api/src/seed/demo-accounts.ts for the API.
DEMO_INSTRUCTOR_EMAIL='instructor@learnsdlc.test'
DEMO_ADMIN_EMAIL='admin@learnsdlc.test'
DEMO_INSTRUCTOR_DEFAULT_PASSWORD='Instructor123!'
DEMO_ADMIN_DEFAULT_PASSWORD='Admin123!'

# What a closing block prints for a demo staff account's password: the
# published default it is given, or, when SEED_PASSWORD is set, a sentence
# that says so. A password the person chose is never printed.
staff_password_shown() { # published default password
  if [ -n "${SEED_PASSWORD:-}" ]; then
    printf '%s' 'the SEED_PASSWORD set in your environment'
  else
    printf '%s' "$1"
  fi
}

# ------------------------------------------------------------- the toolchain

# package.json's engines field (^24.9.0 || >=26.0.0): npm ci refuses any other
# Node, so a check that accepted one would only move the failure later.
node_supported() {
  command -v node >/dev/null && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 24 && minor >= 9) || major >= 26 ? 0 : 1)'
}

# Learner JavaScript runs on Node 22, the TaskTrackr pack's runtime, apart
# from the application's own Node 24.
node22_ok() { # node binary
  [ -x "$1" ] && "$1" -e 'process.exit(process.versions.node.split(".")[0] === "22" ? 0 : 1)' 2>/dev/null
}

# The Node 22 binary for learner code: NODE_BIN when it is set (and then only
# that one), otherwise the newest Node 22 nvm has, or a node22 on PATH.
# Prints its path, or nothing and returns 1.
find_node22() {
  if [ -n "${NODE_BIN:-}" ]; then
    node22_ok "$NODE_BIN" && printf '%s' "$NODE_BIN" && return 0
    return 1
  fi
  local candidate
  for candidate in $(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v22.*/bin/node 2>/dev/null | sort -t. -k2,2n -k3,3n | tail -n 1) \
                   "$(command -v node22 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && node22_ok "$candidate"; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

# A Python for the scripts, by absolute path. "exact" accepts 3.11 only: the
# sandbox's pre-baked layer is built for and checked against 3.11
# (apps/api/runner/runtime_dependencies.py), so the native runner needs that
# version. "atleast" accepts 3.11 or newer, which is enough to write the
# manifest the runner image is built from. PYTHON_BIN, when set, is tried
# first; then python3.11 before python3, so a machine whose python3 is newer
# still finds its 3.11.
find_python() { # exact | atleast
  local rule candidate
  if [ "$1" = exact ]; then
    rule='sys.version_info[:2] == (3, 11)'
  else
    rule='sys.version_info >= (3, 11)'
  fi
  for candidate in ${PYTHON_BIN:-} python3.11 python3 python3.13 python3.12; do
    if command -v "$candidate" >/dev/null 2>&1 \
       && "$candidate" -c "import sys; sys.exit(0 if $rule else 1)" 2>/dev/null; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

python_version() { # python binary: "3.11", or "missing"
  "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo missing
}

# ------------------------------------------------------------------ the ports

# Who listens on a port. ss reads the kernel's own socket table and names the
# owning process for this user's sockets (Linux); lsof answers on a Mac. A
# listener that ss shows without a pid belongs to a process this user cannot
# see, which is never one a script here started. With neither tool, a
# connection attempt still says whether something listens.
port_listening() { # port
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -Hltn "( sport = :$1 )" 2>/dev/null)" ]
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}
listener_pids() { # port: one pid per line; empty when nothing (visible) listens
  if command -v ss >/dev/null 2>&1; then
    ss -Hltnp "( sport = :$1 )" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
  else
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u
  fi
}
listeners_all_visible() { # port: every listening socket names its process
  if command -v ss >/dev/null 2>&1; then
    [ -z "$(ss -Hltnp "( sport = :$1 )" 2>/dev/null | grep -v 'pid=')" ]
  else
    return 0
  fi
}
descends_from() { # pid, ancestor pid
  local p="$1"
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
    [ "$p" = "$2" ] && return 0
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
  done
  return 1
}
port_holder() { # "name pid" of a listener on the port, "unknown" when it cannot be named
  if ! port_listening "$1"; then return 0; fi
  local pid
  pid="$(listener_pids "$1" | head -n 1)"
  if [ -n "$pid" ]; then
    printf '%s %s' "$(ps -o comm= -p "$pid" 2>/dev/null | awk '{ print $1 }' || echo unknown)" "$pid"
  else
    printf 'a process this user cannot see, pid unknown'
  fi
}

# ---------------------------------------------------------------- the dotenv

# A value from a dotenv file: the last assignment wins, quotes are removed, and
# an unquoted value loses a trailing " # comment". Prints nothing when the file
# or the key is missing. Never echoed by any caller that reads a secret.
env_value() { # file, key
  [ -f "$1" ] || return 0
  local line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=" "$1" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *) value="${value%%[[:space:]]#*}"; value="${value%"${value##*[![:space:]]}"}" ;;
  esac
  printf '%s' "$value"
}

# --------------------------------------------------------------- the secrets

# A new secret for this machine: 48 random bytes from the operating system's
# generator, written as 96 hex characters, which is safe unquoted in a dotenv
# file and well over the API's 32-byte floor for JWT_SECRET. Node is what
# every local run already needs, so nothing else has to be installed for it.
# Callers write it into a file and never print it.
new_secret() {
  node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("hex"))'
}

# A new password for an account a script creates: 24 random bytes as 32
# URL-safe characters, inside the API's password rules. Never printed.
new_password() {
  node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))'
}

# Whether a JWT secret is one this repository publishes, and so no secret at
# all: the list PLACEHOLDER_JWT_SECRETS holds in apps/api/src/config/auth.ts,
# compared as the API compares it (edges trimmed, any case).
# apps/api/test/local-secrets.spec.ts checks that the two lists agree.
published_jwt_secret() { # value
  local value
  value="$(printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    dev-secret-change-me-in-production|change-me-in-production|changeme|change-me|secret|jwt-secret|please-change-me|local-test-only-jwt-secret-refused-in-production)
      return 0 ;;
  esac
  return 1
}

# Make sure a dotenv file holds a value of its own for a generated secret, and
# print what was done: "kept" when the file already holds one, which is never
# replaced (a JWT_SECRET that changes signs everyone out and redraws every quiz
# paper in progress, because QUIZ_SEED_SECRET defaults to it); "written" when
# the key was missing or empty; "replaced" when a JWT_SECRET held a value this
# repository publishes. The file is created when it is missing and is left
# readable by its owner only. The value itself is never printed.
ensure_env_secret() { # file, key, generator (new_secret, the default, or new_password)
  local file="$1" key="$2" make="${3:-new_secret}" current value tmp outcome
  current="$(env_value "$file" "$key")"
  # KEY=  # a comment: the value is empty, as a dotenv reader sees it.
  case "$current" in \#*) current="" ;; esac
  if [ -n "$current" ]; then
    if [ "$key" != JWT_SECRET ] || ! published_jwt_secret "$current"; then
      echo kept
      return 0
    fi
    outcome=replaced
  else
    outcome=written
  fi
  value="$("$make")" || return 1
  [ -n "$value" ] || return 1
  if [ -f "$file" ] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?$key[[:space:]]*=" "$file"; then
    # Every assignment of the key becomes the new one, so whichever a reader
    # takes (the first or the last) is the same value.
    tmp="$(mktemp "$file.XXXXXX")"
    awk -v key="$key" -v value="$value" '
      $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" { print key "=" value; next }
      { print }' "$file" > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$file"
  else
    (
      umask 077
      if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then echo >> "$file"; fi
      printf '%s=%s\n' "$key" "$value" >> "$file"
    )
    chmod 600 "$file"
  fi
  echo "$outcome"
}

# ---------------------------------------------------------------- the runner

# Start apps/api/runner/serve.py on RUNNER_SOCKET and wait until it answers.
# runner-status.py reads the runner's own GET /health: "down" until it
# answers, then "ok <mechanism>" or "unsupported <reason>". A runner that
# answers but cannot confine learner code (a Mac, Windows, a Linux kernel
# without Landlock) is up, and refuses every Run, Submit and Preview by itself.
#
# Sets RUNNER_PID and RUNNER_STATUS. Returns 0 once the runner answers
# (whatever it says), 1 when it exits or never answers; the caller decides
# what an "unsupported" answer means for it.
start_socket_runner() { # python binary, log file
  local python="$1" log="$2"
  mkdir -p "$(dirname "$RUNNER_SOCKET")" "$(dirname "$log")"
  "$python" apps/api/runner/serve.py >>"$log" 2>&1 &
  RUNNER_PID=$!
  RUNNER_STATUS="down"
  local _
  for _ in $(seq 1 60); do
    RUNNER_STATUS="$("$python" -B scripts/runner-status.py || true)"
    case "$RUNNER_STATUS" in ok*|unsupported*) return 0 ;; esac
    kill -0 "$RUNNER_PID" 2>/dev/null || { RUNNER_STATUS="down the runner exited"; return 1; }
    sleep 0.5
  done
  return 1
}
