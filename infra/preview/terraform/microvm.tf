# Learner egress has no path to the trusted core, internet, or other learners.
# Managed HTTPS ingress is separate and requires a per-VM, port-scoped token.
resource "aws_vpc" "learner" {
  cidr_block           = "10.49.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = false
  tags                 = { Name = "${var.name}-learner-isolation" }
}

resource "aws_subnet" "learner" {
  vpc_id                  = aws_vpc.learner.id
  cidr_block              = "10.49.1.0/24"
  availability_zone       = local.availability_zone
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-learner-isolation" }
}

resource "aws_route_table" "learner" {
  vpc_id = aws_vpc.learner.id
  route  = []
  tags   = { Name = "${var.name}-learner-no-egress" }
}

resource "aws_route_table_association" "learner" {
  subnet_id      = aws_subnet.learner.id
  route_table_id = aws_route_table.learner.id
}

resource "aws_security_group" "learner" {
  name        = "${var.name}-learner-no-egress"
  description = "No ingress or egress in learner VPC; managed VM HTTPS uses separate auth"
  vpc_id      = aws_vpc.learner.id
  ingress     = []
  egress      = []
}

# Security groups cannot block the VPC resolver. Block DNS explicitly as well.
resource "aws_route53_resolver_firewall_domain_list" "all" {
  name    = "${var.name}-all-domains"
  domains = ["*."]
}

resource "aws_route53_resolver_firewall_rule_group" "learner" {
  name = "${var.name}-learner-no-dns"
}

resource "aws_route53_resolver_firewall_rule" "deny" {
  name                    = "deny-all"
  action                  = "BLOCK"
  block_response          = "NODATA"
  priority                = 100
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.all.id
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.learner.id
}

resource "aws_route53_resolver_firewall_rule_group_association" "learner" {
  name                   = "${var.name}-learner-no-dns"
  firewall_rule_group_id = aws_route53_resolver_firewall_rule_group.learner.id
  vpc_id                 = aws_vpc.learner.id
  priority               = 101
  mutation_protection    = "DISABLED"
}

resource "aws_route53_resolver_firewall_config" "learner" {
  resource_id        = aws_vpc.learner.id
  firewall_fail_open = "DISABLED"
}

resource "aws_iam_role" "connector" {
  name = "${var.name}-learner-connector"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = ["sts:AssumeRole", "sts:TagSession"],
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "connector" {
  role = aws_iam_role.connector.id
  name = "isolated-learner-enis"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow", Action = ["ec2:CreateNetworkInterface"],
        Resource = [aws_subnet.learner.arn, aws_security_group.learner.arn]
      },
      {
        Effect    = "Allow", Action = ["ec2:CreateNetworkInterface"],
        Resource  = ["arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:network-interface/*"],
        Condition = { "ForAllValues:StringEquals" = { "aws:TagKeys" = ["aws:lambda:networkConnectorName", "aws:lambda:networkConnectorId"] } }
      },
      {
        Effect   = "Allow", Action = ["ec2:CreateTags"],
        Resource = ["arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:network-interface/*"],
        Condition = { StringEquals = {
          "ec2:CreateAction"            = "CreateNetworkInterface",
          "ec2:ManagedResourceOperator" = "network-connectors.lambda.amazonaws.com"
        } }
      }
    ]
  })
}

resource "aws_lambdacore_network_connector" "learner" {
  name          = "${var.name}-learner-isolation"
  operator_role = aws_iam_role.connector.arn
  configuration {
    vpc_egress_configuration {
      subnet_ids                        = [aws_subnet.learner.id]
      security_group_ids                = [aws_security_group.learner.id]
      network_protocol                  = "IPv4"
      associated_compute_resource_types = ["MicroVm"]
    }
  }
  depends_on = [
    aws_iam_role_policy.connector,
    aws_route_table_association.learner,
    aws_route53_resolver_firewall_rule.deny,
    aws_route53_resolver_firewall_rule_group_association.learner,
    aws_route53_resolver_firewall_config.learner,
  ]
}

locals {
  microvm_image_name = "${var.name}-tasktrackr"
  microvm_image_arn  = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:microvm-image:${local.microvm_image_name}"
}

resource "aws_cloudwatch_log_group" "microvm_build" {
  name              = "/aws/lambda/microvms/${local.microvm_image_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "microvm_build" {
  name = "${var.name}-microvm-build"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = ["sts:AssumeRole", "sts:TagSession"],
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "microvm_build" {
  role = aws_iam_role.microvm_build.id
  name = "source-and-build-logs"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = ["${aws_s3_bucket.artifacts.arn}/releases/microvm/*"] },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = ["${aws_cloudwatch_log_group.microvm_build.arn}:*"] }
    ]
  })
}

# No execution role or shell-token permission. Only the host controller uses
# this policy; learner containers never receive EC2 instance-role credentials.
resource "aws_iam_role_policy" "microvm_runtime" {
  role = aws_iam_role.core.id
  name = "owned-tasktrackr-microvms"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow",
      Action   = ["lambda:RunMicrovm", "lambda:GetMicrovm", "lambda:TerminateMicrovm", "lambda:CreateMicrovmAuthToken", "lambda:GetMicrovmImage"],
      Resource = [local.microvm_image_arn]
    }]
  })
}

# This permission-only action has no resource type in AWS's authorization
# reference. Runtime itself remains scoped to the one prepared image above.
resource "aws_iam_role_policy" "microvm_connector_use" {
  role = aws_iam_role.core.id
  name = "pass-microvm-network-connectors"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = ["lambda:PassNetworkConnector"], Resource = "*",
      Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } }
    }]
  })
}

output "learner_egress_connector_arn" { value = aws_lambdacore_network_connector.learner.arn }
output "microvm_image_name" { value = local.microvm_image_name }
output "microvm_image_arn" { value = local.microvm_image_arn }
output "microvm_build_role_arn" { value = aws_iam_role.microvm_build.arn }
output "microvm_build_log_group" { value = aws_cloudwatch_log_group.microvm_build.name }
