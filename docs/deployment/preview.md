# Reference AWS deployment

The repository carries the code for one way to host LearnSDLC on AWS: a single EC2 host runs the trusted services in Docker Compose, and every piece of learner code runs in an AWS Lambda MicroVM of its own. It is a reference, not a turnkey installer. Terraform builds the AWS resources, and the repository provides the Compose file, the reverse proxy configuration, an invitation gate, the MicroVM controller and guest image, a Cognito sign-in trigger and a static-asset helper. It does not include a host bootstrap or a release tool: installing the application onto the host is a set of steps you script yourself, and this page gives the contract those steps must meet.

| Part | Code | Guide |
|---|---|---|
| AWS resources | `infra/preview/terraform` | [Terraform module](../../infra/preview/terraform/README.md) |
| Services on the host | `infra/preview/compose.yaml`, `infra/preview/Caddyfile` | this page |
| Invitation gate | `infra/preview/gateway` | [Invitation gate](../../infra/preview/gateway/README.md) |
| Learner code on MicroVMs | `infra/microvm/controller`, `infra/microvm/guest` | [MicroVM controller](microvm-controller.md), [MicroVM guest image](microvm-guest.md) |
| Optional managed sign-in | `infra/preview/terraform/cognito.tf`, `infra/preview/cognito` | [Cognito sign-in](cognito-sso.md) |
| Old build assets across a release | `infra/preview/static_assets.py` | this page |

## What it builds

The module targets one region, `ap-southeast-1`; its variables and the MicroVM controller refuse any other.

- **Core network.** One VPC with one public subnet in one availability zone, an internet gateway and an Elastic IP on the host's only network interface. Inbound TCP 80 is open for certificate challenges and redirects; inbound TCP 443 is open only to the networks in `allowed_https_cidrs` (empty, the default, leaves HTTPS closed). Outbound traffic is HTTPS only.
- **The host.** One Amazon Linux 2023 ARM instance (`t4g.medium` by default; the module accepts `t4g.medium` or `t4g.large`), with IMDSv2 required, termination protection on, standard CPU credits and an encrypted root volume. SSH is disabled; administration is through AWS Systems Manager Session Manager. Its user data installs Docker, the SSM agent and the AWS CLI from the distribution's repositories, writes the module's outputs to `/etc/learnsdlc/foundation.json` and leaves a marker, `/etc/learnsdlc/APP_LAUNCH_BLOCKED`. It does not mount the data volume, fetch the application or start anything else.
- **Persistent data.** A separate encrypted data volume (at least 50 GiB) attached as `/dev/sdf`, meant to be mounted at `/srv/learnsdlc`, and one private S3 bucket: versioned, encrypted, ACLs disabled, TLS only. Objects under `backups/` (current and older versions) expire after `backup_retention_days` (30 by default); objects under `releases/` do not expire.
- **The host's role.** Session Manager; listing the bucket's `backups/` and `releases/` prefixes, reading and writing `backups/`, reading `releases/`; writing its own CloudWatch log group; reading the application secret; and running, reading, terminating and minting tokens for MicroVMs of the one image the module names. It may not read Systems Manager Parameter Store values.
- **Secrets.** An empty Secrets Manager secret, `<name>/application`, for your application settings. Terraform never sets or reads its value. `app_secret_arn` can grant the host read access to an existing secret as well.
- **Learner isolation.** A second VPC whose subnet has no routes, a security group with no rules, a Route 53 Resolver DNS firewall that blocks every name, and a Lambda network connector that gives MicroVMs that network and nothing else. The module also names the MicroVM image (`<name>-tasktrackr`) and creates the role and log group the image build uses; the image itself is built outside Terraform.
- **Sign-in.** An Amazon Cognito user pool, app client and domain, and the trigger function that migrates existing accounts. The application uses them only when its API runs with `AUTH_PROVIDER=cognito`.
- **Opt-in extras.** With `operations_alert_email` set: an SNS topic and e-mail subscription, eight CloudWatch alarms and an account-wide monthly budget alert. With `audit_trail_enabled`: a CloudTrail management-event trail and its own bucket.

## What runs on the host

`infra/preview/compose.yaml` (project `learnsdlc-cloud-preview`) runs:

| Service | What it is |
|---|---|
| `postgres` | PostgreSQL 16, data under `/srv/learnsdlc/postgres` |
| `redis` | Redis 7 with append-only persistence, data under `/srv/learnsdlc/redis` |
| `api` | The API image, read-only, every capability dropped, talking to the runner socket `/run/learnsdlc/runner.sock`, which it mounts read-only from the host |
| `web` | The web image, built with the site's address |
| `preview-gate` | The invitation gate |
| `caddy` | The only service that publishes ports (80 and 443); it obtains the certificate, sends traffic through the gate and serves retained build assets |

Every service logs to CloudWatch through Docker's `awslogs` driver. Learner code does not run in Compose at all: the API's runner socket belongs to the [MicroVM controller](microvm-controller.md), a systemd service on the host.

Compose needs four values in its environment and three private files on the data volume:

| Value | What it is |
|---|---|
| `SITE_HOST` | The site's hostname, without scheme |
| `RELEASE_ID` | The tag for the images this release builds. The static-asset helper expects `learnsdlc-` followed by 64 lowercase hexadecimal characters. |
| `CLOUDWATCH_LOG_GROUP` | The `cloudwatch_log_group_name` output |
| `RUNNER_STARTUP_OWNER_ID` | A fixed lowercase UUID the API's start-up runner check runs as |
| `/srv/learnsdlc/secrets/postgres.env` | `POSTGRES_PASSWORD` |
| `/srv/learnsdlc/secrets/api.env` | The API's secrets and settings: at least `JWT_SECRET`, `DATABASE_URL` (pointing at `postgres`), `OPENAI_API_KEY`, and the `COGNITO_*` settings if you use Cognito. The [configuration reference](../configuration.md) lists every variable. |
| `/srv/learnsdlc/secrets/gate/preview-gate.json` | The gate's signing key and invitation hashes ([gate guide](../../infra/preview/gateway/README.md)) |

The API service sets `RUN_MIGRATIONS=false`, so apply the database migrations once per release, before the new API starts, with the API image's migration command, `node apps/api/dist/cli/migrate.js`. It also joins supplementary group 2000, which must be the id of the `learnsdlc-runner` group that owns the controller's socket.

## What you need

- An AWS account where Lambda MicroVMs and network connectors are available in `ap-southeast-1`, and an operator identity that is not the account root. Sign in with temporary credentials (IAM Identity Center or `aws login`) under a named profile. AWS credentials never belong in the application's `.env`, the Terraform variables or the repository. The Terraform provider uses only the profile you name and refuses any account but `aws_account_id`.
- Terraform 1.9 or later (below 2.0); the AWS provider version is locked in `.terraform.lock.hcl`.
- An AWS CLI version 2 that has the `lambda-microvms` commands, on your machine for the image build and on the host for the controller.
- Python 3 for the helper scripts, and Docker with ARM64 builds if you want to run the guest image's local smoke test.
- A domain name whose record you can point at the Elastic IP.
- An API key for an OpenAI-compatible provider.

## Deploying

1. **Build the Cognito trigger package.** The module always creates the user pool and its trigger, so run `python3 infra/preview/cognito/package.py` first. It writes `.preview/cognito/migration.zip`, which git ignores.
2. **Set the variables.** Copy `infra/preview/terraform/preview.tfvars.example` to an untracked file (for example `infra/preview/terraform/preview.auto.tfvars`) and set `aws_account_id`, `aws_profile`, `preview_host` and `allowed_https_cidrs`. After the first plan, pin `ami_id` to the plan's `selected_ami_id`.
3. **Plan and apply.** From the repository folder:

   ```sh
   terraform -chdir=infra/preview/terraform init
   terraform -chdir=infra/preview/terraform plan -out=reviewed.tfplan
   terraform -chdir=infra/preview/terraform apply reviewed.tfplan
   ```

   Keep the state and plan files private: they name your account's resources.
4. **Prepare the host** in a Session Manager shell. Find the data volume by its EBS volume id (on Nitro instances the device appears as an NVMe disk, not `/dev/sdf`), format it only if it is new and empty, mount it at `/srv/learnsdlc` and add it to `/etc/fstab` by filesystem UUID. Create `/srv/learnsdlc/{postgres,redis,secrets,caddy,next-static}`, write the three private files above with owner-only permissions, and create the `learnsdlc-runner` group with id 2000.
5. **Build the MicroVM image and install the controller**, as the [guest image guide](microvm-guest.md) and the [controller guide](microvm-controller.md) describe.
6. **Install the application.** Copy a source tree of this repository to the host (for example as an archive under the bucket's `releases/` prefix, which the host can read), then from `infra/preview` build the images and start the services:

   ```sh
   docker compose -f compose.yaml build
   docker compose -f compose.yaml run --rm api node apps/api/dist/cli/migrate.js
   docker compose -f compose.yaml up -d
   ```

   Remove `/etc/learnsdlc/APP_LAUNCH_BLOCKED` once the services are healthy; the marker is a convention for your own scripts, and nothing in the repository reads it.
7. **Point the domain** at the `public_ip` output. Caddy obtains the certificate once the name resolves to the host.
8. **Issue invitations** with the [gate's `invite.py`](../../infra/preview/gateway/README.md), and, if you want Cognito sign-in, follow the [Cognito guide](cognito-sso.md).

## Operating it

- **Health.** `docker compose -f compose.yaml ps` shows each service's health check; `/api/v1/health/ready` is the API's own readiness answer; the controller reports its slots and cleanup state on `GET /health` over its socket ([controller guide](microvm-controller.md#health)).
- **Alarms.** The opt-in alarms read seven metrics in the `LearnSDLC/Preview` namespace (`MonitorHealthy`, `ServiceReady`, `QueueBacklog`, `RecentFailedJobs`, `BackupAgeSeconds`, `DiskRootUsedPercent`, `DiskDataUsedPercent`) plus the instance status check. The repository does not include the monitor that publishes those seven metrics, and every alarm treats missing data as breaching, so enable `operations_alert_email` only together with a publisher of your own. The budget alert is an account-wide safety net, not a spending cap.
- **Backups.** The reference Compose file has no backup service. Schedule a `pg_dump` of the `postgres` container and copy the archive to the bucket's `backups/` prefix, which the host role can write. Remember that those objects expire after `backup_retention_days`, so a backup job that stops will let the last good copy age out; alert on the age of the newest backup. Rehearse restores into a separate database, never over the live one. The [production runbook](../production-runbook.md) covers database backup and restore in general.
- **Releasing a new web image.** A page loaded before a release can still ask for the previous release's JavaScript afterwards. `infra/preview/static_assets.py` keeps those files: run `static_assets.py prepare --image <new web image>` before replacing any service (it copies the immutable `/_next/static` files out of the running and the new web images into `/srv/learnsdlc/next-static`, and refuses to continue if a file at the same address differs), then `static_assets.py activate --image <new web image>` once the new web container is healthy, and `static_assets.py prune` every hour. Files that only the old image had are kept for 24 hours after activation. It keeps no HTML, API responses or user data, and it stops the release rather than delete files when it reaches its limits (12,000 files, 512 MiB in all, 128 MiB per image, 64 MiB per file). Caddy serves those files only behind the invitation check.
- **Changing the infrastructure on a running host.** Changing the user data or the AMI replaces the instance (`user_data_replace_on_change`), and an unpinned `ami_id` resolves to the newest Amazon Linux 2023 image at every plan, so pin it before the first apply and read every plan before applying it. Resources an operator changes by hand (instance size, extra alarms, agents) are not described by the module, and the next apply sets them back to what the module says.
- **Logs.** Each service's log is in the host's CloudWatch log group. Caddy discards HTTP access logs on purpose, because invitation and preview addresses are credentials.

## What it costs, in kind

There are no load balancers, NAT gateways or managed databases. Always on: the EC2 instance, its two EBS volumes and the Elastic IP's public IPv4 address, the S3 bucket's backups and release archives (with their older versions), the CloudWatch log groups, two Secrets Manager secrets, the DNS firewall, the Cognito user pool's monthly active users, and, if enabled, the audit trail's bucket. Per use: MicroVM running time for every finite job and preview, image builds, the Cognito trigger's invocations, and the AI provider's tokens, which the provider bills directly. Check AWS's current prices for your region before you deploy.

## Tearing it down

Several resources are protected against accidental removal, so a plain `terraform destroy` stops:

- `prevent_destroy` on the data volume, the bucket, the Cognito user pool and, if enabled, the audit bucket and trail;
- termination protection on the instance and deletion protection on the user pool;
- `skip_destroy` on the host's log group, so it stays after a destroy.

To remove a deployment:

1. Take a final database backup and copy it somewhere you keep.
2. Stop the services (`docker compose -f compose.yaml down`), then stop the controller and confirm on its last health reading, or in the MicroVM console, that no MicroVM is still running; terminate any that are.
3. Delete the MicroVM image and its versions, which Terraform did not create, and any Google identity provider you added to the user pool.
4. In your copy of the module, remove the `prevent_destroy` lines and turn off termination and deletion protection; empty every version from the versioned buckets; then run `terraform destroy`.
5. Delete the log groups that remain, and force-delete the two secrets if you do not want to wait out their seven-day recovery window.
