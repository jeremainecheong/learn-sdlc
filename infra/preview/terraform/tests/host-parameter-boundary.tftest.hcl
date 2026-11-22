# Plan-only mock. Actual policy simulation and host-role requests are checked
# separately, outside this test.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_ssm_parameter" { defaults = { value = "ami-0123456789abcdef0" } }
  mock_data "aws_ami" { defaults = { id = "ami-0123456789abcdef0", architecture = "arm64" } }
  mock_resource "aws_iam_role" { defaults = { id = "learnsdlc-preview-core", name = "learnsdlc-preview-core", arn = "arn:aws:iam::123456789012:role/learnsdlc-preview-core" } }
  mock_resource "aws_s3_bucket" { defaults = { bucket = "learnsdlc-preview-test-fixture", id = "learnsdlc-preview-test-fixture", arn = "arn:aws:s3:::learnsdlc-preview-test-fixture" } }
  mock_resource "aws_cloudwatch_log_group" { defaults = { arn = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/learnsdlc/preview/learnsdlc-preview/core" } }
  mock_resource "aws_instance" { defaults = { id = "i-0123456789abcdef0" } }
  mock_resource "aws_secretsmanager_secret" { defaults = { arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:learnsdlc-preview/application-AbCdEf" } }
}
variables {
  aws_account_id = "123456789012"
  preview_host   = "preview.example.invalid"
}
run "host_value_reads_blocked_transport_preserved" {
  command = plan
  assert {
    condition     = aws_iam_role_policy.host_parameter_boundary.role == aws_iam_role.core.id && aws_iam_role_policy.host_parameter_boundary.name == "learnsdlc-preview-no-parameter-values"
    error_message = "Only the owned host role receives the reversible inline boundary."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.host_parameter_boundary.policy) == jsondecode(file("tests/host-parameter-policy.json"))
    error_message = "Terraform must preserve the exact reviewed four-action deny, including the parameter-history route."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.ssm.policy_arn == "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    error_message = "Do not remove the managed SSM transport/document attachment."
  }
}
