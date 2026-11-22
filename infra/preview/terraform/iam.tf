resource "aws_iam_role" "core" {
  name = "${var.name}-core"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.core.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

locals {
  host_policy_statements = concat([
    {
      Sid      = "LocateOwnBucket", Effect = "Allow", Action = ["s3:GetBucketLocation"],
      Resource = [aws_s3_bucket.artifacts.arn]
    },
    {
      Sid       = "ListOwnedPrefixes", Effect = "Allow", Action = ["s3:ListBucket"],
      Resource  = [aws_s3_bucket.artifacts.arn],
      Condition = { StringLike = { "s3:prefix" = ["backups", "backups/*", "releases", "releases/*"] } }
    },
    {
      Sid      = "BackupAndRestore", Effect = "Allow",
      Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      Resource = ["${aws_s3_bucket.artifacts.arn}/backups/*"]
    },
    {
      Sid      = "ReadApprovedReleases", Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"],
      Resource = ["${aws_s3_bucket.artifacts.arn}/releases/*"]
    },
    {
      Sid      = "WriteOwnLogs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
      Resource = ["${aws_cloudwatch_log_group.core.arn}:*"]
    }
    ], var.app_secret_arn == null ? [] : [{
      Sid      = "ReadExactAppSecret", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"],
      Resource = [var.app_secret_arn]
      }], var.app_secret_kms_key_arn == null ? [] : [{
      Sid      = "DecryptExactAppSecret", Effect = "Allow", Action = ["kms:Decrypt"],
      Resource = [var.app_secret_kms_key_arn],
      Condition = { StringEquals = {
        "kms:ViaService"                  = "secretsmanager.${var.aws_region}.amazonaws.com",
        "kms:EncryptionContext:SecretARN" = var.app_secret_arn
      } }
  }])
}

resource "aws_iam_role_policy" "host" {
  name   = "${var.name}-host-artifacts"
  role   = aws_iam_role.core.id
  policy = jsonencode({ Version = "2012-10-17", Statement = local.host_policy_statements })
}

resource "aws_iam_instance_profile" "core" {
  name = "${var.name}-core"
  role = aws_iam_role.core.name
}
