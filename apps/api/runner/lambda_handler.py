"""AWS Lambda entrypoint for the LearnSDLC code runner.

The deployed function receives the exact same JSON job the local stdin
runner accepts and returns the same JSON result: one execution contract,
two transports (the runner stays behind an interface). The package is three
modules from this directory (lambda_handler.py, sandbox_runner.py and
runtime_diagnostics.py, which sandbox_runner imports at load) plus the baked
Python layer (runtime/python and runtime/manifest.json).
scripts/localstack-lambda.sh builds that zip and is the list's source of
truth; CI runs it against LocalStack Lambda.

A result is handed back exactly as `execute_job` built it. That includes an
`unavailable` result whose `stderr` is the runner's own sentence about a job
this transport cannot run at all: a TypeScript step, where the function has
no node (`transport_cannot_run_js_result`). The API reads a non-empty stderr
on an `unavailable` result as that permanent limit and shows the sentence to
the learner verbatim, where an empty one means the transport failed and "try
again" is the right thing to say; so nothing here may rewrite, clip or drop
it (test_lambda_handler.py pins this).
"""

from sandbox_runner import execute_job


#: What a preview job gets here. The API turns it into
#: PREVIEW_UNAVAILABLE_MESSAGE on the screen; this is the machine half.
PREVIEW_UNAVAILABLE = "preview is not available on this transport"


def handler(event, _context):
    event = event or {}
    if event.get("mode") == "preview":
        # A live preview is a process that keeps running while a learner clicks
        # around in it, and a Lambda invoke has nowhere to keep one: the
        # function is frozen between calls and thrown away after them. Returned
        # as an envelope rather than raised for the same reason the ValueError
        # below is: a function error is a truncated traceback in the API's log
        # and a spike on the function's metrics, where this is an answer the API
        # can read and say plainly on the Preview tab.
        return {"error": PREVIEW_UNAVAILABLE}
    try:
        return execute_job(event)
    except ValueError as err:
        # A job this runner cannot read is a caller's mistake, not an outage,
        # and serve.py already answers that case with 400 rather than 500. Let
        # out of here as an unhandled exception it would become a Lambda function
        # error instead: a truncated traceback in the API's log, an error on
        # the function's own metrics, and nothing that says which field was
        # wrong. The caller still sees `unavailable`; this returns no verdict,
        # and a job nobody graded must never read as a learner failing.
        return {"error": f"invalid job: {err}"}
