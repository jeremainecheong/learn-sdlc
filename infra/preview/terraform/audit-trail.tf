# Durable management-event history is explicitly opt-in. This bucket is separate
# from workload releases/backups and grants no application or runner permissions.
variable "audit_trail_enabled" {
  description = "Create the reviewed account management trail and dedicated audit bucket. Enabling is an explicit operator decision; later removal is blocked by prevent_destroy."
  type        = bool
  default     = false
}

variable "audit_retention_days" {
  description = "Days retained as current and again as noncurrent audit versions. Default 365 gives roughly 730 days for append-only logs; S3 lifecycle deletion is asynchronous."
  type        = number
  default     = 365
  validation {
    condition     = var.audit_retention_days >= 365 && var.audit_retention_days <= 730 && floor(var.audit_retention_days) == var.audit_retention_days
    error_message = "Audit retention must be an integer between 365 and 730 days for each version stage."
  }
}

locals {
  audit_trail_name  = "${var.name}-management-audit"
  audit_trail_arn   = "arn:aws:cloudtrail:${var.aws_region}:${var.aws_account_id}:trail/${local.audit_trail_name}"
  audit_bucket_name = "${var.name}-audit-${var.aws_account_id}"
  audit_log_prefix  = "management"
}

resource "aws_s3_bucket" "audit_trail" {
  count         = var.audit_trail_enabled ? 1 : 0
  bucket        = local.audit_bucket_name
  force_destroy = false
  tags          = { Name = local.audit_bucket_name, Purpose = "account-management-audit" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "audit_trail" {
  count                   = var.audit_trail_enabled ? 1 : 0
  bucket                  = aws_s3_bucket.audit_trail[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "audit_trail" {
  count  = var.audit_trail_enabled ? 1 : 0
  bucket = aws_s3_bucket.audit_trail[0].id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "audit_trail" {
  count  = var.audit_trail_enabled ? 1 : 0
  bucket = aws_s3_bucket.audit_trail[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_trail" {
  count  = var.audit_trail_enabled ? 1 : 0
  bucket = aws_s3_bucket.audit_trail[0].id
  rule {
    # SSE-S3 encrypts logs and digest files without a customer KMS key or its
    # standing key/request charges. No plaintext application secret enters TF.
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_policy" "audit_trail" {
  count  = var.audit_trail_enabled ? 1 : 0
  bucket = aws_s3_bucket.audit_trail[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureClientTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.audit_trail[0].arn, "${aws_s3_bucket.audit_trail[0].arn}/*"]
        # AWS redacts network context on service-to-service calls. This AWS-
        # recommended exception grants nothing; the two exact allows follow.
        Condition = { Bool = { "aws:SecureTransport" = "false", "aws:PrincipalIsAWSService" = "false" } }
      },
      {
        Sid       = "ExactTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.audit_trail[0].arn
        Condition = { StringEquals = { "aws:SourceArn" = local.audit_trail_arn, "aws:SourceAccount" = var.aws_account_id } }
      },
      {
        Sid       = "ExactTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.audit_trail[0].arn}/${local.audit_log_prefix}/AWSLogs/${var.aws_account_id}/*"
        Condition = { StringEquals = {
          "aws:SourceArn"     = local.audit_trail_arn
          "aws:SourceAccount" = var.aws_account_id
          "s3:x-amz-acl"      = "bucket-owner-full-control"
        } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.audit_trail, aws_s3_bucket_ownership_controls.audit_trail]
}

resource "aws_s3_bucket_lifecycle_configuration" "audit_trail" {
  count  = var.audit_trail_enabled ? 1 : 0
  bucket = aws_s3_bucket.audit_trail[0].id
  rule {
    id     = "bounded-audit-log-and-digest-retention"
    status = "Enabled"
    filter { prefix = "${local.audit_log_prefix}/" }
    expiration { days = var.audit_retention_days }
    noncurrent_version_expiration { noncurrent_days = var.audit_retention_days }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
  rule {
    id     = "remove-expired-audit-delete-markers"
    status = "Enabled"
    filter { prefix = "${local.audit_log_prefix}/" }
    expiration { expired_object_delete_marker = true }
  }
  depends_on = [aws_s3_bucket_versioning.audit_trail]
}

resource "aws_cloudtrail" "management_audit" {
  count                         = var.audit_trail_enabled ? 1 : 0
  name                          = local.audit_trail_name
  s3_bucket_name                = aws_s3_bucket.audit_trail[0].bucket
  s3_key_prefix                 = local.audit_log_prefix
  enable_logging                = true
  enable_log_file_validation    = true
  is_multi_region_trail         = true
  include_global_service_events = true
  is_organization_trail         = false

  # First-copy management read/write events only: no data resources, Insights,
  # Lake event stores, CloudWatch log ingestion, or exclusions of IAM/KMS events.
  event_selector {
    read_write_type                  = "All"
    include_management_events        = true
    exclude_management_event_sources = []
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    aws_s3_bucket_policy.audit_trail,
    aws_s3_bucket_versioning.audit_trail,
    aws_s3_bucket_server_side_encryption_configuration.audit_trail,
    aws_s3_bucket_lifecycle_configuration.audit_trail,
  ]
}

output "audit_trail_arn" {
  description = "Exact management trail ARN when enabled; no trail exists merely because configuration is present."
  value       = var.audit_trail_enabled ? local.audit_trail_arn : null
}

output "audit_log_s3_uri" {
  description = "Dedicated management log/digest prefix; workload roles receive no audit access."
  value       = var.audit_trail_enabled ? "s3://${local.audit_bucket_name}/${local.audit_log_prefix}/AWSLogs/${var.aws_account_id}/" : null
}
