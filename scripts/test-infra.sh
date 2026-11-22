#!/usr/bin/env bash
# The infrastructure's Python unit tests: every test module under infra/ that
# needs no Docker, no cloud account and no network.
#
#   npm run test:infra
#   PYTHON_BIN=python3.11 npm run test:infra
#
# Each folder runs in its own interpreter from inside that folder, because its
# tests import their neighbours by bare module name (bridge, gateway, gate) and
# two folders each have a module called package.py.
#
# Left out on purpose: infra/preview/gateway/test_caddy.py and
# test_native_form.cjs drive Docker and run by hand, and the Terraform tests
# under infra/preview need the Terraform CLI. test_upstream.py is the routing
# fixture test_caddy.py starts and holds no tests.
#
# infra/microvm/guest/test_package.py packages the real sandbox manifest, so
# apps/api/runner/runtime/manifest.json has to exist first: npm run prebake
# writes it (node scripts/prebake.mjs manifest writes it alone).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"

case "${1:-}" in
  -h|--help) print_usage "$0"; exit 0 ;;
  '') ;;
  *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
esac

PY="${PYTHON_BIN:-python3}"
[ -f "$ROOT/apps/api/runner/runtime/manifest.json" ] ||
  die "apps/api/runner/runtime/manifest.json is missing; infra/microvm/guest/test_package.py packages it. Run npm run prebake (or node scripts/prebake.mjs manifest), then this again."

# Every folder runs even after one fails, and the run fails at the end if any
# folder did.
FAILED=()
run_in() { # folder, unittest arguments
  local folder="$1"; shift
  step "$folder"
  (cd "$ROOT/$folder" && "$PY" -m unittest "$@") || FAILED+=("$folder")
}

run_in infra/microvm/controller discover -p 'test_*.py'
run_in infra/microvm/guest discover -p 'test_*.py'
run_in infra/preview/cognito discover -p 'test_*.py'
run_in infra/preview/gateway discover -p 'test_*.py'
# Named rather than discovered: this folder's only test module sits beside the
# subfolders above, which have run already.
run_in infra/preview test_static_assets

if [ "${#FAILED[@]}" -gt 0 ]; then
  die "failed in ${FAILED[*]}; the output above says which tests."
fi
ok "every infra unit test passed"
