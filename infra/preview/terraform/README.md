# Terraform module for the reference AWS deployment

This module builds the AWS resources of the [reference AWS deployment](../../../docs/deployment/preview.md): one Amazon Linux 2023 ARM host with an Elastic IP and Session Manager access, a separate encrypted data volume, a private S3 bucket for backups and release archives, an isolated network for learner MicroVMs, an application secret, an Amazon Cognito user pool with its trigger, and, if you ask for them, operations alarms and a management-event audit trail. There is no load balancer, container service, managed database, managed cache or NAT gateway. The deployment guide describes each resource; this page covers the module's inputs, outputs and checks.

Terraform builds infrastructure only. The host's user data installs Docker, the SSM agent and the AWS CLI, disables SSH, writes `/etc/learnsdlc/foundation.json` (the region, data volume id, device name, mount path, bucket prefixes, log group and secret, none of them secret) and creates `/etc/learnsdlc/APP_LAUNCH_BLOCKED`. Mounting the data volume, installing the application and starting it are steps you run afterwards ([Deploying](../../../docs/deployment/preview.md#deploying)). The `application_status` output says so; it is not a health result.

## Inputs

| Variable | Default | Notes |
|---|---|---|
| `aws_account_id` | none | The exact 12-digit account. The provider refuses any other. |
| `aws_profile` | `learnsdlc-preview` | The named AWS CLI profile to use; there is no fallback to an ambient profile. |
| `preview_host` | none | The site's hostname, without scheme. Keep it in an untracked `*.auto.tfvars` file. |
| `aws_region` | `ap-southeast-1` | The only accepted value. |
| `name` | `learnsdlc-preview` | Prefix for every resource name. |
| `availability_zone` | the region's `a` zone | The data volume stays in this zone. |
| `instance_type` | `t4g.medium` | `t4g.medium` or `t4g.large`. |
| `ami_id` | none (resolved) | Unset, the AMI is the newest Amazon Linux 2023 ARM image from AWS's public parameter at plan time. Pin it. |
| `allowed_https_cidrs` | empty | IPv4 networks allowed on port 443. Empty leaves HTTPS closed; port 80 is always open for certificate challenges and redirects. |
| `data_volume_size_gib` | 50 | At least 50; it can grow, never shrink. |
| `backup_retention_days` | 30 | 7 to 3650; applies to current and older versions under `backups/`. |
| `log_retention_days` | 14 | 7, 14, 30, 60 or 90. |
| `app_secret_arn`, `app_secret_kms_key_arn` | none | Grant the host read access to an existing same-account secret, and its key if it is customer managed. |
| `cognito_preview_origin` | `https://<preview_host>` | The origin used for the Cognito callback and sign-out addresses. |
| `cognito_identity_providers` | empty | Names of identity providers you have added to the pool ([Cognito sign-in](../../../docs/deployment/cognito-sso.md)). |
| `cognito_migration_zip_path` | `.preview/cognito/migration.zip` | The trigger package that `infra/preview/cognito/package.py` writes. |
| `operations_alert_email` | none | Setting it creates the alarms, an SNS e-mail subscription and the account budget alert. Confirming the subscription is a separate step in the e-mail. |
| `operations_monthly_account_budget_usd` | 100 | 10 to 500; an alert threshold, not a cap. |
| `audit_trail_enabled` | false | Creates a CloudTrail management-event trail and its bucket. |
| `audit_retention_days` | 365 | 365 to 730. |

`preview.tfvars.example` shows the shape with placeholder values. Variable files, state and plans are ignored by git; keep them private, because they name your account's resources.

## Outputs

`instance_id`, `aws_region`, `public_ip`, `selected_ami_id`, `data_volume_id`, `data_device_name` (`/dev/sdf`), `data_mount_path` (`/srv/learnsdlc`), `bucket_name`, `backup_s3_uri`, `release_s3_uri`, `cloudwatch_log_group_name`, `cloudwatch_log_group_arn`, `app_secret_arn`, `application_secret_arn`, `application_status`; the MicroVM outputs `learner_egress_connector_arn`, `microvm_image_name`, `microvm_image_arn`, `microvm_build_role_arn`, `microvm_build_log_group`; the Cognito outputs `cognito_user_pool_id`, `cognito_user_pool_arn`, `cognito_client_id`, `cognito_domain`, `cognito_redirect_url`, `cognito_google_redirect_url`, `cognito_identity_providers`, `cognito_migration_secret_arn`, `cognito_migration_function_name`; and, with the audit trail, `audit_trail_arn` and `audit_log_s3_uri`. None of them is a password, token or secret value.

## The data volume

On Nitro instances the attached volume appears as an NVMe device, so identify it by its EBS volume id (`data_volume_id`), not by `/dev/sdf` or a guessed `/dev/nvme1n1`. The attachment can arrive after boot. Format it only when it is new and empty, mount it at `/srv/learnsdlc` by filesystem UUID, and check the mount after a reboot before starting the application. Never fall back to keeping the database on the root volume, which is replaced with the instance. A replacement host must be in the volume's availability zone; detach without force.

`prevent_destroy` on the data volume and the bucket, and the bucket's refusal to be force-emptied, are Terraform guards, not AWS locks: editing the configuration or the state removes them. Backups under `backups/` expire after `backup_retention_days`, so a backup job that stops will let even the last good backup age out.

## Replacing the host

Changing the user data or the AMI replaces the instance (`user_data_replace_on_change`), and with `ami_id` unset every plan resolves the newest Amazon Linux 2023 image. Pin `ami_id` to `selected_ami_id` after the first apply and read each plan before applying it. Settings changed on a running host by hand are set back to the module's values by the next apply.

## Checks without AWS

The tests replace the AWS provider with a mock and only plan; nothing reaches AWS except the provider download from HashiCorp's registry during `init`. Build the Cognito package first, because the module reads it at plan time, and keep Terraform away from any AWS profile on your machine while it runs:

```sh
python3 infra/preview/cognito/package.py
export AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
terraform -chdir=infra/preview/terraform fmt -check -recursive
terraform -chdir=infra/preview/terraform init -backend=false -input=false
terraform -chdir=infra/preview/terraform validate
terraform -chdir=infra/preview/terraform test
```

The tests in `tests/` check encryption, access rules, IAM scopes, refused secrets and accounts, the values handed to the host, the opt-in alarms and audit trail, and that no forbidden service type is planned. `tests/host-parameter-boundary.tftest.hcl` compares the host's Parameter Store deny policy with `tests/host-parameter-policy.json` beside it; change the two together. The Cognito plans are checked separately by `infra/preview/cognito/verify_terraform.py`.

None of this shows that EC2 capacity, IAM enforcement, package installation, the volume mount, Session Manager, certificates, backups or the application work. Only a deployment shows that.

References: [Terraform mock providers](https://docs.hashicorp.com/terraform/language/tests/mocking), [Amazon Linux 2023 AMI parameters](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/finding-an-ami-parameter-store.html).
