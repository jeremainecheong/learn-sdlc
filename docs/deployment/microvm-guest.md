# MicroVM guest image

The guest in [`infra/microvm/guest`](../../infra/microvm/guest) is the image each learner MicroVM boots in the [reference AWS deployment](preview.md). It runs the same runner as every other deployment (`apps/api/runner/serve.py`, `sandbox_runner.py` and `app_session.py`) with the runtime dependencies the content packs declare, behind a small authenticated gateway. It holds no part of the LearnSDLC API, its database, its AI settings or any deployment credential. One VM runs one finite job or one preview, and is then thrown away.

## Building it

From the repository folder:

```sh
node scripts/prebake.mjs verify
python3 -m unittest discover -s infra/microvm/guest -p 'test_*.py' -v
docker build --platform linux/arm64 -f infra/microvm/guest/Dockerfile -t learnsdlc-microvm-guest:local .
python3 infra/microvm/guest/smoke.py --image learnsdlc-microvm-guest:local --report <a path outside the repository>
python3 infra/microvm/guest/package.py --output <a path outside the repository>/learnsdlc-microvm-source.zip
```

`package.py` writes a deterministic ZIP with only what the image build needs: the Dockerfile at the root, the guest gateway and installer, the runner's Python modules, `runtime/manifest.json` and the runtime lock files. It refuses a missing, linked or out-of-tree source, and it never includes `.env` files, AWS configuration, local wheels, `node_modules` or tests.

The Dockerfile starts from AWS's MicroVM Amazon Linux 2023 minimal image, pinned by digest, which carries the snapshot-compatible OpenSSL that MicroVM snapshots need. It installs Python 3.11 and Node.js 22, rebuilds the manifest's exact package versions for ARM Linux with `install_runtime.py`, makes the runner and gateway files root-owned and read-only, and removes set-user-id and set-group-id bits. Operating-system packages are updated at build time, so record the result as an image version and pin that version in the controller.

To publish it, upload the ZIP under the bucket's `releases/microvm/` prefix, which the module's image-build role can read, then create the image and an image version with the AWS CLI's `lambda-microvms` commands, using the module's `microvm_image_name`, `microvm_build_role_arn` and `microvm_build_log_group` outputs. See AWS's [image requirements](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html) and [snapshot compatibility](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html).

## The control contract

The gateway listens on port **8081**. Only the [controller](microvm-controller.md) talks to it, through the MicroVM's managed HTTPS endpoint with a token AWS scopes to that port. Learners never receive that token and never reach the control port.

The controller's run hook payload is this JSON object, with every value fresh for each operation:

```json
{
  "protocol": "learnsdlc-microvm-v1",
  "instanceId": "00000000-0000-4000-8000-000000000001",
  "controlToken": "<64 lowercase hexadecimal characters from 32 random bytes>",
  "purpose": "job",
  "sourceHash": "<SHA-256 of the exact bytes of the first request>"
}
```

The guest binds this identity once, before it accepts any learner source, together with the `microvmId` AWS supplies. A repeat of the same binding is accepted; any change to the token, source hash, purpose or identity is refused. Changed source needs a new VM.

Every control call carries `Authorization: Bearer <controlToken>` and `X-LearnSDLC-Instance: <instanceId>`, one bounded `Content-Length` and a JSON object (at most 16 MiB; duplicate keys and non-finite numbers are refused).

| Route | Behaviour |
|---|---|
| `GET /health` | The runner's health plus the protocol, instance id, MicroVM id, purpose and source hash; checks that the runner really runs as uid 65534 |
| `POST /execute` | The one finite job, only when the purpose is `job` |
| `POST /app/start` | The one preview, only when the purpose is `preview` |
| `POST /app/status`, `/app/proxy`, `/app/asset`, `/app/stop` | The runner's preview calls, for the app id this VM's start returned |

Replies keep the runner's HTTP status and wrap its JSON in `{protocol, instanceId, microvmId, purpose, sourceHash, result}`, which the controller checks before it reads `result`. An unauthorised call never learns the operation's identity, and no reply is cacheable. The first request's outcome is kept in memory, including a transport failure, and a duplicate of that request waits for it rather than running the job again. The guest keeps no durable history: recovery belongs to the controller.

## Lifecycle and isolation

AWS's lifecycle hooks (`ready`, `validate`, `run`, `resume`, `suspend`, `terminate`) are served on port 8081 under `/aws/lambda-microvms/runtime/v1/`. `ready`, `validate` and `resume` report the runner's health; `suspend` and `terminate` only acknowledge; `run` alone sets the binding above. None of them can run a command, write a file or reveal a token, and an unauthenticated hook can never reset the binding or stop learner processes. See AWS's [runtime hooks and endpoint authentication](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html).

The gateway is the only process with uid 0. It keeps the control token in memory that cannot be dumped, then starts the runner as uid and gid 65534 with no supplementary groups, `no_new_privs`, an allow-listed environment and process and descriptor limits. Once the runner has bound its socket, the gateway makes the socket's directory root-only, so learner code cannot call the runner directly, read the gateway's memory or change the guest's files. Inside the VM the runner treats the fresh VM itself as the isolation boundary (`RUNNER_ISOLATION=single-job-microvm`, set only by the gateway) and keeps its own file policy, time limits and preview limits; its preview limits in the guest are 900 seconds idle and 3,600 seconds in all, and the controller's shorter lifetime ends the VM first.

The image needs no AWS execution role. The network boundary is the deployment's job, not the image's: launch it only with the module's isolated egress connector and DNS firewall, never with an execution role, platform secrets in its environment, elevated operating-system capabilities or a learner-reachable control port.

## What the checks cover

- The unit tests (`test_gateway.py`, `test_isolation_bootstrap.py`, `test_package.py`) cover the binding, wrong credentials and source hashes, malformed JSON, refused routes, cross-session calls, duplicate suppression, transport failures, bodyless lifecycle hooks, reply identity and the packager. They use a stand-in runner. `test_package.py` needs `apps/api/runner/runtime/manifest.json`, which `node scripts/prebake.mjs build` writes (`node scripts/prebake.mjs manifest` writes it alone). `npm run test:infra` runs these tests with the other infrastructure unit tests.
- `smoke.py` runs the built image locally, one container per case with no network: real Python and Flask tests, a deliberately failing assertion, TypeScript and React DOM tests through esbuild, and a full TaskTrackr preview (bundle build, database seed, Flask start, health route, bundle fetch, wrong preview id refused, stop). It also checks the learner uid, the scrubbed environment and the protected control files.
- Neither proves AWS behaviour: the image build service, snapshot restore, egress and DNS filtering, endpoint tokens and cloud cleanup need a check against a real deployment, such as the controller's opt-in `verify_real.py`.
