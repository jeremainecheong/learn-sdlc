# Every run is a plan against a mocked AWS provider. No account or IAM change.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_ssm_parameter" { defaults = { value = "ami-0123456789abcdef0" } }
  mock_data "aws_ami" { defaults = { id = "ami-0123456789abcdef0", architecture = "arm64" } }
  mock_resource "aws_s3_bucket" { defaults = { bucket = "learnsdlc-artifacts-fixture", id = "learnsdlc-artifacts-fixture", arn = "arn:aws:s3:::learnsdlc-artifacts-fixture" } }
  mock_resource "aws_cloudwatch_log_group" { defaults = { arn = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/learnsdlc/preview/learnsdlc-preview/core" } }
  mock_resource "aws_instance" { defaults = { id = "i-0123456789abcdef0" } }
  mock_resource "aws_secretsmanager_secret" { defaults = { arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:learnsdlc-preview/application-AbCdEf" } }
}

variables {
  aws_account_id = "123456789012"
  preview_host   = "preview.example.invalid"
}

run "disabled_means_no_audit_resources" {
  command = plan
  assert {
    condition     = length(aws_cloudtrail.management_audit) == 0 && length(aws_s3_bucket.audit_trail) == 0 && length(aws_s3_bucket_policy.audit_trail) == 0 && length(aws_s3_bucket_lifecycle_configuration.audit_trail) == 0 && length(aws_s3_bucket_public_access_block.audit_trail) == 0 && length(aws_s3_bucket_ownership_controls.audit_trail) == 0 && length(aws_s3_bucket_versioning.audit_trail) == 0 && length(aws_s3_bucket_server_side_encryption_configuration.audit_trail) == 0 && output.audit_trail_arn == null && output.audit_log_s3_uri == null
    error_message = "The opt-in default must create no audit bucket/trail or suggest logging is already active."
  }
}

run "dedicated_private_management_audit" {
  command = plan
  variables { audit_trail_enabled = true }
  override_resource {
    target          = aws_s3_bucket.audit_trail[0]
    override_during = plan
    values          = { id = "learnsdlc-preview-audit-123456789012", arn = "arn:aws:s3:::learnsdlc-preview-audit-123456789012" }
  }
  assert {
    condition     = length(aws_cloudtrail.management_audit) == 1 && aws_cloudtrail.management_audit[0].is_multi_region_trail && aws_cloudtrail.management_audit[0].include_global_service_events && aws_cloudtrail.management_audit[0].enable_logging && aws_cloudtrail.management_audit[0].enable_log_file_validation && !aws_cloudtrail.management_audit[0].is_organization_trail
    error_message = "Enabled auditing must cover multi-region/global management events with active logging and integrity validation."
  }
  assert {
    condition     = length(aws_cloudtrail.management_audit[0].event_selector) == 1 && alltrue([for selector in aws_cloudtrail.management_audit[0].event_selector : selector.read_write_type == "All" && selector.include_management_events && length(selector.data_resource) == 0 && length(selector.exclude_management_event_sources) == 0]) && length(aws_cloudtrail.management_audit[0].advanced_event_selector) == 0 && length(aws_cloudtrail.management_audit[0].insight_selector) == 0
    error_message = "The trail must include all read/write management events and no data-event or Insights selectors."
  }
  assert {
    condition     = aws_s3_bucket.audit_trail[0].bucket != aws_s3_bucket.artifacts.bucket && !aws_s3_bucket.audit_trail[0].force_destroy && aws_s3_bucket_public_access_block.audit_trail[0].block_public_acls && aws_s3_bucket_public_access_block.audit_trail[0].block_public_policy && aws_s3_bucket_public_access_block.audit_trail[0].ignore_public_acls && aws_s3_bucket_public_access_block.audit_trail[0].restrict_public_buckets && one(aws_s3_bucket_ownership_controls.audit_trail[0].rule).object_ownership == "BucketOwnerEnforced" && one(aws_s3_bucket_versioning.audit_trail[0].versioning_configuration).status == "Enabled"
    error_message = "Audit storage must be separate, versioned, private, owner-enforced and protected from force-empty deletion."
  }
  assert {
    condition     = alltrue([for rule in aws_s3_bucket_server_side_encryption_configuration.audit_trail[0].rule : one(rule.apply_server_side_encryption_by_default).sse_algorithm == "AES256"])
    error_message = "Logs/digests must have default SSE-S3 encryption without a new KMS key."
  }
  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.audit_trail[0].policy).Statement) == 3 && alltrue([for statement in jsondecode(aws_s3_bucket_policy.audit_trail[0].policy).Statement : statement.Effect == "Allow" ? statement.Principal.Service == "cloudtrail.amazonaws.com" && statement.Condition.StringEquals["aws:SourceArn"] == "arn:aws:cloudtrail:ap-southeast-1:123456789012:trail/learnsdlc-preview-management-audit" && statement.Condition.StringEquals["aws:SourceAccount"] == "123456789012" && contains(["s3:GetBucketAcl", "s3:PutObject"], statement.Action) : statement.Action == "s3:*" && statement.Principal == "*" && statement.Condition.Bool["aws:SecureTransport"] == "false" && statement.Condition.Bool["aws:PrincipalIsAWSService"] == "false"])
    error_message = "Only the exact account/trail may deliver; all non-service clients must use TLS."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_s3_bucket_policy.audit_trail[0].policy).Statement : statement if statement.Sid == "ExactTrailWrite"]).Resource == "arn:aws:s3:::learnsdlc-preview-audit-123456789012/management/AWSLogs/123456789012/*" && one([for statement in jsondecode(aws_s3_bucket_policy.audit_trail[0].policy).Statement : statement if statement.Sid == "ExactTrailWrite"]).Condition.StringEquals["s3:x-amz-acl"] == "bucket-owner-full-control"
    error_message = "CloudTrail delivery must be bounded to this account's log/digest prefix and ownership header."
  }
  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.audit_trail[0].rule) == 2 && alltrue([for rule in aws_s3_bucket_lifecycle_configuration.audit_trail[0].rule : rule.id != "bounded-audit-log-and-digest-retention" || (one(rule.expiration).days == 365 && one(rule.noncurrent_version_expiration).noncurrent_days == 365 && one(rule.filter).prefix == "management/")])
    error_message = "Default current and noncurrent audit records must each retain 365 days, scoped to the audit prefix."
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.host.policy, "learnsdlc-preview-audit-") && !strcontains(aws_iam_role_policy.host.policy, "cloudtrail:") && alltrue([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : !contains(statement.Resource, "*")]) && output.audit_log_s3_uri == "s3://learnsdlc-preview-audit-123456789012/management/AWSLogs/123456789012/"
    error_message = "The application host must gain no audit-bucket or CloudTrail permissions."
  }
}

run "reject_short_retention" {
  command = plan
  variables { audit_retention_days = 364 }
  expect_failures = [var.audit_retention_days]
}

run "reject_unbounded_retention" {
  command = plan
  variables { audit_retention_days = 731 }
  expect_failures = [var.audit_retention_days]
}

run "reject_fractional_retention" {
  command = plan
  variables { audit_retention_days = 365.5 }
  expect_failures = [var.audit_retention_days]
}
