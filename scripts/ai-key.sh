# Sourced by the local-run scripts (demo.sh, start.sh, host.sh, stack.sh and
# demo-selftest.sh): LearnSDLC does not start without an AI key. The mentor,
# the stakeholder interview, the Agentic assistant, the explanation gate and
# grading all need a hosted model that passes the product's AI checks. The one
# exception is the test mentor, asked for by name with --ai-stub (CI and
# scripts/prove-local.sh).
#
# The key comes from the environment or from .env in the repository root (the
# last assignment wins). It is never printed.

ai_key_present() { # repository root
  [ -n "${OPENAI_API_KEY:-}" ] && return 0
  [ -f "$1/.env" ] || return 1
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?OPENAI_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]#]' "$1/.env" || return 1
  # The last assignment must not be empty.
  local last
  last="$(grep -E '^[[:space:]]*(export[[:space:]]+)?OPENAI_API_KEY[[:space:]]*=' "$1/.env" | tail -n 1)"
  last="${last#*=}"
  last="${last#"${last%%[![:space:]\"\']*}"}"
  [ -n "$last" ] && case "$last" in \#*) return 1 ;; esac
  [ -n "$last" ]
}

require_ai_key() { # repository root
  ai_key_present "$1" && return 0
  cat >&2 <<'MESSAGE'

  LearnSDLC needs an AI key to start, and none was found.

  Put your key in .env at the repository root (cp .env.example .env first):

      OPENAI_API_KEY=<your key>

  That uses OpenAI's default model (OPENAI_MODEL in .env.example names it).
  Any OpenAI-compatible hosted endpoint works too:
  set OPENAI_BASE_URL, OPENAI_MODEL and OPENAI_API_KEY in the same file.
  docs/local-run.md, "Your AI key", has the details.

MESSAGE
  exit 1
}
