# Every run uses a mocked AWS provider and plan-only evaluation. No account,
# secret lookup, EC2 instance or application is contacted or created.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
  mock_data "aws_ami" {
    defaults = { id = "ami-0123456789abcdef0", architecture = "arm64" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { bucket = "learnsdlc-preview-test-fixture", id = "learnsdlc-preview-test-fixture", arn = "arn:aws:s3:::learnsdlc-preview-test-fixture" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/learnsdlc/preview/learnsdlc-preview/core" }
  }
  mock_resource "aws_ebs_volume" {
    defaults = { id = "vol-0123456789abcdef0" }
  }
  mock_resource "aws_instance" {
    defaults = { id = "i-0123456789abcdef0", key_name = "" }
  }
  mock_resource "aws_network_interface" {
    defaults = { id = "eni-0123456789abcdef0" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:learnsdlc-preview/application-AbCdEf" }
  }
}

variables {
  aws_account_id = "123456789012"
  preview_host   = "preview.example.invalid"
}

run "safe_foundation_defaults" {
  command = plan

  assert {
    condition     = aws_instance.core.instance_type == "t4g.medium" && aws_instance.core.ami == "ami-0123456789abcdef0"
    error_message = "The default must be the reviewed ARM t4g.medium/AL2023 AMI."
  }
  assert {
    condition     = length([for filter in data.aws_ami.core.filter : filter if filter.name == "architecture" && toset(filter.values) == toset(["arm64"])]) == 1 && toset(data.aws_ami.core.owners) == toset(["amazon"])
    error_message = "Pinned and discovered AMIs must be checked as Amazon-owned ARM images."
  }
  assert {
    condition     = aws_instance.core.metadata_options[0].http_tokens == "required" && aws_instance.core.metadata_options[0].http_put_response_hop_limit == 1 && aws_instance.core.metadata_options[0].instance_metadata_tags == "disabled"
    error_message = "Require IMDSv2, host-only hop limit and no exposed metadata tags."
  }
  assert {
    condition     = (aws_instance.core.key_name == null || aws_instance.core.key_name == "") && aws_instance.core.credit_specification[0].cpu_credits == "standard"
    error_message = "No SSH key or unbounded T-family CPU-credit charges are permitted."
  }
  assert {
    condition     = aws_instance.core.root_block_device[0].encrypted && aws_instance.core.root_block_device[0].volume_type == "gp3" && aws_instance.core.root_block_device[0].volume_size == 60
    error_message = "The separate root must be encrypted 60-GiB gp3."
  }
  assert {
    condition     = aws_ebs_volume.data.encrypted && aws_ebs_volume.data.size == 50 && aws_ebs_volume.data.type == "gp3" && !aws_volume_attachment.data.force_detach && aws_ebs_volume.data.availability_zone == aws_subnet.core.availability_zone
    error_message = "Persistent data must be encrypted, separate, in the core AZ and never force detached."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.web) == 1 && aws_vpc_security_group_ingress_rule.web["http-acme"].from_port == 80 && aws_vpc_security_group_ingress_rule.web["http-acme"].to_port == 80 && aws_vpc_security_group_ingress_rule.web["http-acme"].cidr_ipv4 == "0.0.0.0/0"
    error_message = "Only ACME HTTP is open by default; HTTPS requires an explicit audience."
  }
  assert {
    condition     = aws_vpc_security_group_egress_rule.https.from_port == 443 && aws_vpc_security_group_egress_rule.https.to_port == 443 && aws_vpc_security_group_egress_rule.https.ip_protocol == "tcp"
    error_message = "Host egress must be HTTPS only."
  }
  assert {
    condition     = !aws_subnet.core.map_public_ip_on_launch && aws_eip.core.domain == "vpc" && aws_eip.core.network_interface == aws_network_interface.core.id && aws_instance.core.primary_network_interface[0].network_interface_id == aws_network_interface.core.id && aws_network_interface.core.security_groups == toset([aws_security_group.core.id])
    error_message = "Use one controlled ENI/EIP, not automatic public-IP assignment or other security groups."
  }
  assert {
    condition     = !aws_s3_bucket.artifacts.force_destroy && aws_s3_bucket_public_access_block.artifacts.block_public_acls && aws_s3_bucket_public_access_block.artifacts.block_public_policy && aws_s3_bucket_public_access_block.artifacts.ignore_public_acls && aws_s3_bucket_public_access_block.artifacts.restrict_public_buckets
    error_message = "The artifact bucket must be private and resistant to accidental emptying."
  }
  assert {
    condition     = aws_s3_bucket_versioning.artifacts.versioning_configuration[0].status == "Enabled" && one(aws_s3_bucket_server_side_encryption_configuration.artifacts.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256" && aws_s3_bucket_ownership_controls.artifacts.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "Require versioning, encryption and disabled ACL ownership."
  }
  assert {
    condition     = jsondecode(aws_s3_bucket_policy.tls.policy).Statement[0].Effect == "Deny" && jsondecode(aws_s3_bucket_policy.tls.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "Explicitly deny insecure transport for bucket and objects."
  }
  assert {
    condition     = one(aws_s3_bucket_lifecycle_configuration.backups.rule).filter[0].prefix == "backups/" && one(aws_s3_bucket_lifecycle_configuration.backups.rule).expiration[0].days == 30 && aws_cloudwatch_log_group.core.retention_in_days == 14
    error_message = "Bound backup/log retention without expiring release artifacts."
  }
  assert {
    condition     = alltrue([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : !contains(statement.Action, "secretsmanager:GetSecretValue") && !contains(statement.Action, "s3:DeleteObject") && !contains(statement.Resource, "*")])
    error_message = "The default host policy must not discover secrets, delete backup objects or grant wildcard resources."
  }
  assert {
    condition     = length([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : statement if statement.Sid == "ReadApprovedReleases" && statement.Action == ["s3:GetObject", "s3:GetObjectVersion"] && statement.Resource == ["arn:aws:s3:::learnsdlc-preview-test-fixture/releases/*"]]) == 1
    error_message = "Release access must stay read-only and prefix-scoped."
  }
  assert {
    condition     = strcontains(aws_instance.core.user_data, "APP_LAUNCH_BLOCKED") && !strcontains(aws_instance.core.user_data, "get-secret-value") && !strcontains(aws_instance.core.user_data, "docker run") && !strcontains(aws_instance.core.user_data, "mkfs") && !strcontains(aws_instance.core.user_data, "git clone")
    error_message = "User data must not retrieve secrets, mount/format data or start application/learner code."
  }
  assert {
    condition     = output.data_volume_id == aws_ebs_volume.data.id && output.data_device_name == "/dev/sdf" && output.data_mount_path == "/srv/learnsdlc" && output.application_status == "managed-by-reviewed-host-bootstrap; inspect live application readiness separately"
    error_message = "The bootstrap handoff must expose exact data identity and never claim app readiness."
  }
}

run "private_https_and_exact_secret" {
  command = plan
  variables {
    allowed_https_cidrs    = ["198.51.100.42/32"]
    app_secret_arn         = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:learnsdlc/preview/fixture-AbCdEf"
    app_secret_kms_key_arn = "arn:aws:kms:ap-southeast-1:123456789012:key/12345678-1234-1234-1234-123456789abc"
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.web) == 2 && aws_vpc_security_group_ingress_rule.web["https:198.51.100.42/32"].from_port == 443 && aws_vpc_security_group_ingress_rule.web["https:198.51.100.42/32"].to_port == 443 && aws_vpc_security_group_ingress_rule.web["http-acme"].cidr_ipv4 == "0.0.0.0/0"
    error_message = "Private HTTPS must not block public HTTP certificate challenges or expose any other port."
  }
  assert {
    condition     = length([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : statement if statement.Sid == "ReadExactAppSecret" && statement.Resource == [var.app_secret_arn] && statement.Action == ["secretsmanager:GetSecretValue"]]) == 1
    error_message = "Secrets Manager permission must name the exact supplied ARN and only read its value."
  }
  assert {
    condition     = length([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : statement if try(statement.Sid == "DecryptExactAppSecret" && statement.Resource == [var.app_secret_kms_key_arn] && statement.Condition.StringEquals["kms:EncryptionContext:SecretARN"] == var.app_secret_arn && statement.Condition.StringEquals["kms:ViaService"] == "secretsmanager.ap-southeast-1.amazonaws.com", false)]) == 1
    error_message = "Custom-key decrypt must remain bound to the exact key, secret and Secrets Manager service."
  }
}

run "reject_other_account_secret" {
  command = plan
  variables {
    app_secret_arn = "arn:aws:secretsmanager:ap-southeast-1:999999999999:secret:other-account-AbCdEf"
  }
  expect_failures = [var.app_secret_arn]
}

run "reject_ipv6_in_ipv4_rules" {
  command = plan
  variables { allowed_https_cidrs = ["::/0"] }
  expect_failures = [var.allowed_https_cidrs]
}

run "reject_empty_profile" {
  command = plan
  variables { aws_profile = "" }
  expect_failures = [var.aws_profile]
}

run "reject_incompatible_x86_core" {
  command = plan
  variables { instance_type = "t3.medium" }
  expect_failures = [var.instance_type]
}

run "guard_persistent_resources_and_scope" {
  command = plan
  assert {
    condition = alltrue([for resource_header in ["aws_ebs_volume\" \"data\" {", "aws_s3_bucket\" \"artifacts\" {"] :
      length([for resource_source in split("resource \"", file("${path.module}/storage.tf")) : resource_source if startswith(resource_source, resource_header) && can(regex("prevent_destroy\\s*=\\s*true", resource_source))]) == 1
    ])
    error_message = "Persistent EBS and artifact bucket lifecycle protection must remain in source."
  }
  assert {
    condition     = alltrue([for source in fileset(path.module, "*.tf") : source == "cognito.tf" || length(regexall("resource \\\"aws_(lb|alb|ecs_[^\\\"]+|db_instance|rds_[^\\\"]+|elasticache_[^\\\"]+|nat_gateway|lambda_[^\\\"]+|secretsmanager_secret_version|key_pair)\\\"", file("${path.module}/${source}"))) == 0])
    error_message = "Outside the explicitly reviewed Cognito resources, the preview must not add managed app services, learner runtime, SSH keys or secret values."
  }
}


run "cognito_resource_scope" {
  command = plan
  assert {
    condition = alltrue([for resource in regexall("resource \"([^\"]+)\" \"([^\"]+)\"", file("${path.module}/cognito.tf")) : contains([
      "aws_secretsmanager_secret.cognito_migration", "aws_cloudwatch_log_group.cognito_migration",
      "aws_iam_role.cognito_migration", "aws_iam_role_policy.cognito_migration",
      "aws_lambda_function.cognito_migration", "aws_lambda_permission.cognito_migration",
      "aws_cognito_user_pool.learnsdlc", "aws_cognito_user_pool_client.learnsdlc",
      "aws_cognito_user_pool_domain.learnsdlc"
    ], join(".", resource))])
    error_message = "Cognito may add only the reviewed pool/client/domain and its narrowly scoped migration function, role, logs and secret container."
  }
}

run "learner_network_and_host_identity" {
  command = plan
  assert {
    condition = aws_vpc.learner.cidr_block != aws_vpc.preview.cidr_block && length(aws_route_table.learner.route) == 0 && length(aws_security_group.learner.ingress) == 0 && length(aws_security_group.learner.egress) == 0 && !aws_subnet.learner.map_public_ip_on_launch
    error_message = "Learner VPC must have no additional routes, ingress, egress or public IP."
  }
  assert {
    condition = aws_route53_resolver_firewall_domain_list.all.domains == toset(["*."]) && aws_route53_resolver_firewall_rule.deny.action == "BLOCK" && aws_route53_resolver_firewall_config.learner.firewall_fail_open == "DISABLED" && aws_route53_resolver_firewall_rule_group_association.learner.priority > 100
    error_message = "All DNS must fail closed; association priorities 100 and below are reserved."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.microvm_runtime.policy).Statement[0].Resource == ["arn:aws:lambda:ap-southeast-1:123456789012:microvm-image:learnsdlc-preview-tasktrackr"] && !contains(jsondecode(aws_iam_role_policy.microvm_runtime.policy).Statement[0].Action, "lambda:CreateMicrovmShellAuthToken")
    error_message = "Host VM operations must name exactly the prepared image and omit shell access."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.microvm_connector_use.policy).Statement[0].Action == ["lambda:PassNetworkConnector"] && jsondecode(aws_iam_role_policy.microvm_connector_use.policy).Statement[0].Condition.StringEquals["aws:RequestedRegion"] == "ap-southeast-1"
    error_message = "Permission-only connector passing must remain region restricted and separate from VM operations."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.application_secret.policy).Statement[0].Action == ["secretsmanager:GetSecretValue"] && jsondecode(aws_iam_role_policy.application_secret.policy).Statement[0].Resource == [aws_secretsmanager_secret.application.arn]
    error_message = "The host may read only its exact application secret."
  }
}
