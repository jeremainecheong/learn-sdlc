# Plan-only AWS mock; never contacts an account or sends email.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_ssm_parameter" { defaults = { value = "ami-0123456789abcdef0" } }
  mock_data "aws_ami" { defaults = { id = "ami-0123456789abcdef0", architecture = "arm64" } }
  mock_resource "aws_s3_bucket" { defaults = { bucket = "learnsdlc-preview-test-fixture", id = "learnsdlc-preview-test-fixture", arn = "arn:aws:s3:::learnsdlc-preview-test-fixture" } }
  mock_resource "aws_cloudwatch_log_group" { defaults = { arn = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/learnsdlc/preview/learnsdlc-preview/core" } }
  mock_resource "aws_instance" { defaults = { id = "i-0123456789abcdef0" } }
  mock_resource "aws_secretsmanager_secret" { defaults = { arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:learnsdlc-preview/application-AbCdEf" } }
  mock_resource "aws_sns_topic" { defaults = { arn = "arn:aws:sns:ap-southeast-1:123456789012:learnsdlc-preview-operations" } }
}
variables {
  aws_account_id = "123456789012"
  preview_host   = "preview.example.invalid"
}

run "disabled_without_authorized_recipient" {
  command = plan
  assert {
    condition     = length(aws_sns_topic.operations) == 0 && length(aws_cloudwatch_metric_alarm.operations) == 0 && length(aws_budgets_budget.operations) == 0 && length(aws_iam_role_policy.operations_metrics) == 0
    error_message = "An absent recipient must create no operational AWS resources or notifications."
  }
}
run "bounded_alerts_and_namespace_permissions" {
  command = plan
  variables { operations_alert_email = "owned-test@example.test" }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.operations) == 7 && length(aws_cloudwatch_metric_alarm.operations_instance) == 1 && alltrue([for alarm in aws_cloudwatch_metric_alarm.operations : alarm.treat_missing_data == "breaching" && alarm.period == 60 && alarm.dimensions.InstanceId == "i-0123456789abcdef0"])
    error_message = "Seven aggregate metrics and instance status must alert for missing data on the exact host."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.operations_metrics[0].policy).Statement[0].Action == ["cloudwatch:PutMetricData"] && jsondecode(aws_iam_role_policy.operations_metrics[0].policy).Statement[0].Condition.StringEquals["cloudwatch:namespace"] == "LearnSDLC/Preview"
    error_message = "The host receives only namespace-bound metric publication; no SNS, alarm, secret or lifecycle privilege."
  }
  assert {
    condition     = alltrue([for statement in jsondecode(aws_sns_topic_policy.operations[0].policy).Statement : statement.Effect == "Allow" && statement.Action == "sns:Publish" && statement.Condition.StringEquals["aws:SourceAccount"] == "123456789012" && strcontains(statement.Condition.ArnLike["aws:SourceArn"], "learnsdlc-preview-")])
    error_message = "Only exact-account named CloudWatch alarms and the named budget can publish; no public topic publisher."
  }
  assert {
    condition     = aws_budgets_budget.operations[0].limit_amount == "100" && aws_budgets_budget.operations[0].name == "learnsdlc-preview-account-safety-net" && length(aws_budgets_budget.operations[0].notification) == 2 && length(aws_budgets_budget.operations[0].cost_filter) == 0
    error_message = "Budget must be explicitly account-wide and distinguish delayed notification from an enforced spending cap."
  }
}
run "reject_unreviewed_large_budget" {
  command = plan
  variables { operations_monthly_account_budget_usd = 5000 }
  expect_failures = [var.operations_monthly_account_budget_usd]
}
