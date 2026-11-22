data "aws_ssm_parameter" "al2023_arm" {
  count = var.ami_id == null ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# One home for the values the host receives in its user data and the operator reads from the outputs.
locals {
  data_device_name = "/dev/sdf"
  data_mount_path  = "/srv/learnsdlc"
  backup_s3_uri    = "s3://${aws_s3_bucket.artifacts.bucket}/backups/"
  release_s3_uri   = "s3://${aws_s3_bucket.artifacts.bucket}/releases/"
}

locals {
  selected_ami = var.ami_id == null ? nonsensitive(data.aws_ssm_parameter.al2023_arm[0].value) : var.ami_id
  foundation_metadata = jsonencode({
    schema_version   = 1
    app_launch       = "blocked-until-reviewed-bootstrap-and-MicroVM-adapter"
    region           = var.aws_region
    data_volume_id   = aws_ebs_volume.data.id
    data_device_name = local.data_device_name
    data_mount_path  = local.data_mount_path
    backup_s3_uri    = local.backup_s3_uri
    release_s3_uri   = local.release_s3_uri
    log_group        = aws_cloudwatch_log_group.core.name
    app_secret_arn   = var.app_secret_arn
  })
}

data "aws_ami" "core" {
  owners = ["amazon"]
  filter {
    name   = "image-id"
    values = [local.selected_ami]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-arm64"]
  }
}

resource "aws_instance" "core" {
  ami                     = data.aws_ami.core.id
  instance_type           = var.instance_type
  iam_instance_profile    = aws_iam_instance_profile.core.name
  disable_api_termination = true
  monitoring              = false

  primary_network_interface {
    network_interface_id = aws_network_interface.core.id
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  credit_specification { cpu_credits = "standard" }

  root_block_device {
    volume_type = "gp3"
    # 60 GiB for the reference deployment. Pin ami_id before an apply: unpinned, the AMI is resolved from the public
    # parameter above at every plan, and a newer image REPLACES the host (docs/deployment/preview.md).
    volume_size           = 60
    encrypted             = true
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/templates/foundation.sh.tftpl", {
    foundation_metadata = local.foundation_metadata
  })
  user_data_replace_on_change = true

  depends_on = [
    aws_eip.core,
    aws_route.internet,
    aws_route_table_association.core,
    aws_vpc_security_group_egress_rule.https,
    aws_iam_role_policy_attachment.ssm,
    aws_iam_role_policy.host,
  ]
  tags = { Name = var.name, ApplicationStatus = "bootstrap-managed" }
}
