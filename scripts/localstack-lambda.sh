#!/usr/bin/env bash
# Package the LearnSDLC code runner and deploy it as a Lambda function on
# LocalStack (or any AWS-compatible endpoint). Used by the lambda-runner CI
# job and by local development with `docker compose -f docker-compose.yml -f
# docker-compose.localstack.yml up`.
set -euo pipefail

ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
FUNCTION="${RUNNER_LAMBDA_FUNCTION:-learnsdlc-code-runner}"
REGION="${AWS_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIP_DIR="$(mktemp -d)"
ZIP="$ZIP_DIR/runner.zip"
OUT="$(mktemp)"
trap 'rm -rf "$ZIP_DIR" "$OUT"' EXIT

# The pre-baked Python tree rides in the package: a pytest job on this
# transport otherwise answers with the sentence that names `npm run prebake`,
# on a machine where nobody can run it. The node half and the esbuild binary
# are deliberately left out: the python3.11 runtime has no node, so the
# front-end half of a phase needs RUNNER_MODE=local or socket either way.
echo "packaging runner from apps/api/runner ..."
if [ ! -d "$ROOT/apps/api/runner/runtime/python" ]; then
  echo "the pre-baked layer is not built. Run npm run prebake first." >&2
  exit 1
fi
# sandbox_runner.py imports runtime_diagnostics at module load, so the handler
# cannot start without it.
(cd "$ROOT/apps/api/runner" && zip -q "$ZIP" lambda_handler.py sandbox_runner.py runtime_diagnostics.py &&
  zip -qr "$ZIP" runtime/python runtime/manifest.json)

echo "waiting for LocalStack at $ENDPOINT ..."
for _ in $(seq 1 60); do
  if curl -sf "$ENDPOINT/_localstack/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -sf "$ENDPOINT/_localstack/health" >/dev/null 2>&1 || {
  echo "LocalStack did not answer at $ENDPOINT within two minutes." >&2; exit 1; }

aws --endpoint-url "$ENDPOINT" --region "$REGION" lambda delete-function \
  --function-name "$FUNCTION" >/dev/null 2>&1 || true

echo "creating function $FUNCTION ..."
aws --endpoint-url "$ENDPOINT" --region "$REGION" lambda create-function \
  --function-name "$FUNCTION" \
  --runtime python3.11 \
  --handler lambda_handler.handler \
  --zip-file "fileb://$ZIP" \
  --role arn:aws:iam::000000000000:role/lambda-runner \
  --timeout 60 \
  --memory-size 512 \
  --environment 'Variables={RUNNER_RUNTIME_DIR=/var/task/runtime}' >/dev/null

aws --endpoint-url "$ENDPOINT" --region "$REGION" lambda wait function-active-v2 \
  --function-name "$FUNCTION"

echo "smoke-invoking $FUNCTION ..."
PAYLOAD='{"files":{"tests/test_smoke.py":"import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1+1, 2)\n"},"mode":"tests","testPaths":["tests/test_smoke.py"],"timeoutSeconds":10,"memoryMb":256}'
aws --endpoint-url "$ENDPOINT" --region "$REGION" lambda invoke \
  --function-name "$FUNCTION" \
  --cli-binary-format raw-in-base64-out \
  --payload "$PAYLOAD" "$OUT" >/dev/null
grep -q '"ok": *true' "$OUT" || { echo "smoke invoke failed:"; cat "$OUT"; exit 1; }
echo "runner Lambda is live: $(cat "$OUT" | head -c 120)…"

# An app has nowhere to keep running on this transport, so a preview job comes
# back as a refusal envelope rather than an exception. Checked here as well as
# in CI because this script is what a laptop runs.
echo "checking that it refuses a preview ..."
aws --endpoint-url "$ENDPOINT" --region "$REGION" lambda invoke \
  --function-name "$FUNCTION" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"mode":"preview","files":{},"ttlSeconds":60}' "$OUT" >/dev/null
grep -q 'not available on this transport' "$OUT" || {
  echo "a preview job was not refused:"; cat "$OUT"; exit 1;
}
echo "preview refused, as it must be on Lambda"
