resource "aws_ebs_volume" "data" {
  availability_zone = local.availability_zone
  size              = var.data_volume_size_gib
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "${var.name}-data", Purpose = "persistent-learning-data" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "data" {
  device_name  = local.data_device_name
  volume_id    = aws_ebs_volume.data.id
  instance_id  = aws_instance.core.id
  force_detach = false
}

resource "aws_s3_bucket" "artifacts" {
  bucket_prefix = "${var.name}-"
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_policy" "tls" {
  bucket = aws_s3_bucket.artifacts.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.artifacts]
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "bounded-backup-retention"
    status = "Enabled"
    filter { prefix = "backups/" }
    expiration { days = var.backup_retention_days }
    noncurrent_version_expiration { noncurrent_days = var.backup_retention_days }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
  depends_on = [aws_s3_bucket_versioning.artifacts]
}

resource "aws_cloudwatch_log_group" "core" {
  name              = "/learnsdlc/preview/${var.name}/core"
  retention_in_days = var.log_retention_days
  skip_destroy      = true
}
