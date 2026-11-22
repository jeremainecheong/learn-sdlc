#!/bin/sh
# Run one phase of the model evaluation through ts-node.
#   apps/api/eval/run.sh <phase> [options]      (see README.md: derive plan probe run score report spotcheck reparse privacy)
# No secret is read here: the OpenAI reference key is read by the harness from
# AWS Secrets Manager into memory only, with your AWS profile (AWS_PROFILE).
# EVAL_ROOT names the evaluation folder (corpus/, models.json, runs/); EVAL_NODE
# a Node 24 binary if `node` on PATH is another version.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${EVAL_NODE:-node}
: "${EVAL_ROOT:?set EVAL_ROOT to the evaluation folder (corpus/, models.json, runs/); see apps/api/eval/README.md}"
cd "$HERE/.."
exec env -u NODE_OPTIONS TS_NODE_TRANSPILE_ONLY=1 TS_NODE_PROJECT=eval/tsconfig.json \
  "$NODE" -r ts-node/register eval/cli.ts "$@"
