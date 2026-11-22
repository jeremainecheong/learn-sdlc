# MicroVM controller

The controller in [`infra/microvm/controller`](../../infra/microvm/controller) lets the [reference AWS deployment](preview.md) run learner code in AWS Lambda MicroVMs without changing the API. It listens on the same UNIX socket and speaks the same HTTP protocol as the local runner (`apps/api/runner/serve.py`), so the API keeps `RUNNER_MODE=socket`. Behind the socket, every finite job (a test run, a grading run, a smoke check) gets a fresh MicroVM, and every live preview of a learner's app gets a MicroVM of its own. No learner code runs on the host, and there is no fallback to a local subprocess or to Docker.

The controller is Python standard library only. It drives AWS through the AWS CLI's `lambda-microvms` commands, using the EC2 instance role, and it talks to each guest over HTTPS through the MicroVM's managed endpoint. The guest side is described in the [guest image guide](microvm-guest.md).

## Routes

| Route | What it does |
|---|---|
| `GET /health` | Configuration, slots, counts and launch totals ([Health](#health)) |
| `POST /execute` | One finite job in a fresh MicroVM; answers when the result is in |
| `POST /app/start` | Starts a preview MicroVM and answers at once with a host id and `starting` |
| `POST /app/status`, `/app/stop`, `/app/proxy`, `/app/asset` | The runner's preview calls, translated to the guest that owns the host id |
| `POST /operation/owner` | Which preview operation an owner holds, and whether its cleanup is confirmed |
| `POST /operation/close-expired` | Closes one stuck `expired-unconfirmed` record on the controller's own proof ([Stuck records](#stuck-records)) |

Any other path is refused. A request body is at most 16 MiB.

## Installing it

1. Copy the five runtime modules, `serve.py`, `bridge.py`, `cloud.py`, `registry.py` and `operation_trace.py`, to `/opt/learnsdlc/microvm-controller`, owned by root and readable by the service user. (`verify_real.py` and `metadata_probe.py` are operator and guest diagnostics, not part of the service.)
2. Create the system user `learnsdlc-controller` and the group `learnsdlc-runner`, with the group id the API container joins (2000 in `infra/preview/compose.yaml`). Install [`learnsdlc-microvm.service`](../../infra/microvm/controller/learnsdlc-microvm.service).
3. Install an AWS CLI version 2 with the `lambda-microvms` commands at `/usr/local/bin/aws`. The controller runs it with an empty configuration and credentials file and no endpoint overrides, so the only credentials it can use are the instance role's.
4. Write `/etc/learnsdlc/microvm-controller.env`:

   | Key | Value |
   |---|---|
   | `AWS_REGION` | `ap-southeast-1` (the default, and the only region the controller accepts) |
   | `MICROVM_IMAGE_ARN` | The image's ARN; the module's `microvm_image_arn` output |
   | `MICROVM_IMAGE_VERSION` | An explicit image version; `latest` is refused |
   | `MICROVM_INGRESS_ARN` | An AWS-managed ingress connector, `arn:aws:lambda:ap-southeast-1:aws:network-connector:aws-network-connector:<NAME>` |
   | `MICROVM_EGRESS_ARN` | The module's `learner_egress_connector_arn` output |

   The image and the egress connector must belong to the same account. A shell ingress connector or an internet egress connector is refused.
5. Start the service: `systemctl enable --now learnsdlc-microvm.service`.

The unit runs the controller as `learnsdlc-controller:learnsdlc-runner` with a hardened systemd sandbox, a 1,536 MiB memory ceiling and a 192-task limit. The socket is `/run/learnsdlc/runner.sock`, mode 0660, in a directory the API container mounts read-only; the unit keeps that directory across restarts so the running API still sees a recreated socket. Do not widen the socket's permissions to make a mismatched group work: fix the group id instead.

The registry, `/var/lib/learnsdlc-microvm/registry.sqlite`, records every operation's launch intent, VM identity and cleanup state, and holds each guest's private control token. Its directory is 0700 and its files 0600. Keep it across restarts and when you restore the host: it is how the controller knows which VMs are its own. Never rebuild it from a listing of the image's VMs.

The instance role needs `lambda:RunMicrovm`, `lambda:GetMicrovm`, `lambda:TerminateMicrovm`, `lambda:CreateMicrovmAuthToken` and `lambda:GetMicrovmImage` on the image, and `lambda:PassNetworkConnector` in the region; the Terraform module grants exactly these. No execution role, shell token or application secret is ever passed to a MicroVM. The named close of a stuck record also needs `lambda:ListMicrovms`, which the module does not grant; without it that one route fails closed (502 `cloud_access_denied`) and nothing else is affected.

On the API side, keep `RUNNER_TRANSPORT_ALLOWANCE_SECONDS=60` so a run's wait covers the MicroVM's boot, and keep `GRADING_RUN_FANOUT` ≤ `RUNNER_SLOTS` ≤ the controller's slots. A job past the controller's slots is refused at once (503 `runner capacity is full`). When you raise the limits, raise the controller first and the API second; when you lower them, the reverse.

## How an operation runs

1. The controller records the launch intent in the registry before it calls `RunMicrovm`, with a fresh client token and a run hook that carries only identifiers: the protocol name, an instance UUID, a 64-character control token, the purpose (`job` or `preview`) and the SHA-256 of the exact request bytes it will send.
2. It waits for the guest's `/health` on port 8081, then posts the request bytes to the guest with the control token, the instance id and a port-scoped AWS endpoint token. The workspace travels in that authenticated request, never in the run hook. The AWS CLI's input is written to a private temporary file, so no token appears in a process argument.
3. It accepts a reply only if it names the same protocol, instance, MicroVM and source hash as the registry row, and only if the result has the shape a runner result must have. A malformed, contradictory or empty "successful" result is refused. A preview that is ready is not a Pass.
4. A finite job's whole budget is the 60-second boot allowance plus the job's own limit (1 to 60 seconds, 15 by default) plus 10 seconds of transfer. Teardown runs separately, so a slow termination never holds the API's request open.

Preview traffic still passes through the API's capability check first. Only content-type and accept headers and bounded bodies cross to the guest; cookies, authorization headers, AWS headers, guest ids and tokens never reach the learner's page. Only HTTPS endpoint hosts of the form `*.lambda-microvm.ap-southeast-1.on.aws` are accepted, and redirects are not followed.

## Limits

The limits are code defaults in `bridge.py` (`Config`), not environment keys. Changing one is a code change and a controller reinstall.

| Limit | Default | Bound |
|---|---|---|
| Finite-job MicroVMs at once (`job_limit`, reported as `slots`) | 24 | 1 to 32 |
| Preview MicroVMs at once (`preview_limit`) | 10 | 1 to 12 |
| Teardowns at once (`cleanup_limit`) | 24 | 1 to `job_limit` |
| Finite MicroVM lifetime | 180 s | 60 to 300 s |
| Preview MicroVM lifetime | 600 s | 30 to 600 s |
| Boot allowance | 60 s | 1 to 60 s |
| Launch rate and burst | 5 a second, burst 5 | 0.2 to 50 a second, burst up to 50 |

Admission is a transaction in the registry. A VM waiting for confirmed teardown still holds its slot, so an AWS outage cannot let the controller launch more than its limits. A preview that has seen no status or proxy call for 300 seconds is stopped. The socket serves at most `max(12, slots + preview slots + 4)` connections at once (38 at the defaults) and closes any beyond that. The account's MicroVM quotas and the host's memory must cover the limits you install.

Every `RunMicrovm` call first takes a token from one launch pacer (a token bucket at the launch rate). A throttled launch (`ThrottlingException`, `TooManyRequestsException` or HTTP 429) is re-sent with the same client token after a short jittered back-off, at most 16 times and never later than 20 seconds after the first send or within the boot allowance's last 10 seconds. A launch whose paced wait would end that late is refused at once as `launch_pacing_budget`. Any other provider error fails the operation at once.

## Restarts and recovery

- On start, interrupted finite operations and incomplete preview starts are marked for cleanup and never replayed. A preview that had finished starting keeps serving its host id after a controller-only restart.
- A launch whose response was lost is resolved with at most one replay of the same client token and parameters, only to learn the VM's identity so it can be terminated; the replay never runs learner code.
- A failed `GetMicrovm` or `TerminateMicrovm` stays as durable cleanup intent and is retried by the sweep every 5 seconds. The controller never reports a VM stopped or a job graded that it has not confirmed.
- A row whose VM cannot be confirmed terminated after its maximum lifetime is marked `expired-unconfirmed` and counted on health.
- The API's requests carry no stable request id, so a retried API request is a new operation and a new VM. The controller never merges two operations because their source matches.

## Stuck records

`POST /operation/close-expired` with `{"id": "<operation id>"}` closes one `expired-unconfirmed` row, and only when both hold:

1. the row is past its expiry plus its VM's maximum duration, so any VM a send could have started has ended; and
2. one complete listing of the row's image and version (no continuation token) shows no MicroVM that is neither `TERMINATED` nor another registered row's own.

It then records the row as terminated with the outcome `absent-after-expiry`. It never adopts, terminates or deletes a VM. Its refusals are 400 `invalid operation close`, 404 `no such operation`, 409 `the operation is not expired-unconfirmed`, 409 `the operation's launch record is unreadable`, 409 `the MicroVM inventory is incomplete` and 409 `an unregistered MicroVM of this image is still running`.

## Health

`GET /health` reports `slots`, `cleanupLimit`, `inFlight`, `previews`, `previewSlots`, `expiredUnconfirmed`, `waiting`, `launchRate`, `launchBurst`, and three totals since the controller started: `launchThrottles`, `launchPaced` and `launchPacedMs`. Read the totals as differences across a window, because a restart resets them. A row whose run succeeded can still record a throttled launch that a re-send absorbed, so judge runs by their results, not by that column. A non-zero `expiredUnconfirmed` is a reason to look at the registry and the MicroVM console, not proof that cleanup succeeded.

`python3 scripts/runner-status.py` reads the same health over `RUNNER_SOCKET` and prints one line.

## Checks

The unit tests use fake AWS and guest transports and make no AWS calls:

```sh
python3 -m unittest discover -s infra/microvm/controller -p 'test_*.py' -v
```

`npm run test:infra` runs them with the other infrastructure unit tests ([testing guide](../testing.md)).

`verify_real.py` is an opt-in check against a real deployed image, run by an operator, never by the service. Three options are required, because each belongs to one operator and one deployment: `--profile` (the AWS CLI profile of an approved operator identity), `--outputs` (the deployment's `terraform output -json` file) and `--evidence-dir` (a private folder outside any repository, where each run writes its requests and answers). Without them it prints its usage and exits 2 before it reads a file or calls AWS. `--region` and `--image-name` are optional, and `--aws-bin` defaults to `aws` on `PATH`. Without `--run` it stops with `Explicit --run required; creates at most two short-lived authorized MicroVMs.` and touches nothing; with it, it launches at most two short-lived finite MicroVMs with cleanup in `finally`, and writes its receipt to the `--report` path (by default `real-verification.json` beside it, which git ignores), refusing to overwrite an existing one.

```sh
python3 infra/microvm/controller/verify_real.py --help
```

AWS references: [RunMicrovm and client tokens](https://docs.aws.amazon.com/cli/latest/reference/lambda-microvms/run-microvm.html), [GetMicrovm](https://docs.aws.amazon.com/cli/latest/reference/lambda-microvms/get-microvm.html), [CreateMicrovmAuthToken](https://docs.aws.amazon.com/cli/latest/reference/lambda-microvms/create-microvm-auth-token.html), [MicroVM networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html).
