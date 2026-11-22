# Opt-in: no notification or policy is installed unless operations_alert_email is set.
variable "operations_alert_email" {
  description = "Explicitly authorized alert inbox; null leaves all operations resources absent. Subscription confirmation is a separate user action."
  type        = string
  default     = null
  sensitive   = true
  validation {
    condition     = var.operations_alert_email == null || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.operations_alert_email))
    error_message = "Use the authorized email address or null."
  }
}

variable "operations_monthly_account_budget_usd" {
  description = "Account-wide cost safety net, not attributed LearnSDLC spend. Reviewed separately; Budgets is delayed, never a hard spending cap."
  type        = number
  default     = 100
  validation {
    condition     = var.operations_monthly_account_budget_usd >= 10 && var.operations_monthly_account_budget_usd <= 500
    error_message = "Choose a reviewed monthly USD safety net between 10 and 500."
  }
}

locals {
  operations_enabled   = nonsensitive(var.operations_alert_email != null)
  operations_namespace = "LearnSDLC/Preview"
  operations_alarms = {
    monitor   = { metric = "MonitorHealthy", threshold = 1, comparison = "LessThanThreshold", periods = 3, statistic = "Minimum", description = "The monitor failed or stopped publishing for three minutes; inspect its systemd unit and instance health." }
    service   = { metric = "ServiceReady", threshold = 1, comparison = "LessThanThreshold", periods = 3, statistic = "Minimum", description = "Required app/database/queue/runner/prebake readiness failed for three minutes. This does not probe a signed-in browser journey." }
    queue     = { metric = "QueueBacklog", threshold = 5, comparison = "GreaterThanOrEqualToThreshold", periods = 5, statistic = "Maximum", description = "At least five waiting/paused/prioritized/delayed jobs for five minutes. Investigate workers; do not blindly replay jobs." }
    jobs      = { metric = "RecentFailedJobs", threshold = 1, comparison = "GreaterThanOrEqualToThreshold", periods = 1, statistic = "Maximum", description = "BullMQ recorded a terminal job failure within five minutes. A learner Needs revision is not an infrastructure failure." }
    backup    = { metric = "BackupAgeSeconds", threshold = 7200, comparison = "GreaterThanThreshold", periods = 2, statistic = "Maximum", description = "No locally recorded verified S3 upload within two hours; inspect backup service and exact remote versions. This does not certify restoration." }
    root_disk = { metric = "DiskRootUsedPercent", threshold = 85, comparison = "GreaterThanOrEqualToThreshold", periods = 3, statistic = "Maximum", description = "Encrypted root disk at least 85 percent full. Review exact unused artifacts; never prune volumes." }
    data_disk = { metric = "DiskDataUsedPercent", threshold = 85, comparison = "GreaterThanOrEqualToThreshold", periods = 3, statistic = "Maximum", description = "Persistent data disk at least 85 percent full. Review growth and resize safely; do not remove learning records." }
  }
}

resource "aws_sns_topic" "operations" {
  count = local.operations_enabled ? 1 : 0
  name  = "${var.name}-operations"
  # Alarm metadata only: no prompts, logs, secrets or learner identity in payloads.
}

resource "aws_sns_topic_policy" "operations" {
  count = local.operations_enabled ? 1 : 0
  arn   = aws_sns_topic.operations[0].arn
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "OwnedCloudWatchAlarmsOnly", Effect = "Allow", Principal = { Service = "cloudwatch.amazonaws.com" }, Action = "sns:Publish", Resource = aws_sns_topic.operations[0].arn,
    Condition = { StringEquals = { "aws:SourceAccount" = var.aws_account_id }, ArnLike = { "aws:SourceArn" = "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.name}-ops-*" } } },
    { Sid = "ExactAccountBudgetOnly", Effect = "Allow", Principal = { Service = "budgets.amazonaws.com" }, Action = "sns:Publish", Resource = aws_sns_topic.operations[0].arn,
    Condition = { StringEquals = { "aws:SourceAccount" = var.aws_account_id }, ArnLike = { "aws:SourceArn" = "arn:aws:budgets::${var.aws_account_id}:budget/${var.name}-account-safety-net" } } }
  ] })
}

resource "aws_sns_topic_subscription" "operations_email" {
  count      = local.operations_enabled ? 1 : 0
  topic_arn  = aws_sns_topic.operations[0].arn
  protocol   = "email"
  endpoint   = var.operations_alert_email
  depends_on = [aws_sns_topic_policy.operations]
}

resource "aws_iam_role_policy" "operations_metrics" {
  count = local.operations_enabled ? 1 : 0
  role  = aws_iam_role.core.id
  name  = "owned-preview-operational-metrics"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Action = ["cloudwatch:PutMetricData"], Resource = "*",
    Condition = { StringEquals = { "cloudwatch:namespace" = local.operations_namespace, "aws:RequestedRegion" = var.aws_region } }
  }] })
}

resource "aws_cloudwatch_metric_alarm" "operations" {
  for_each            = local.operations_enabled ? local.operations_alarms : {}
  alarm_name          = "${var.name}-ops-${each.key}"
  alarm_description   = each.value.description
  namespace           = local.operations_namespace
  metric_name         = each.value.metric
  dimensions          = { InstanceId = aws_instance.core.id }
  statistic           = each.value.statistic
  period              = 60
  evaluation_periods  = each.value.periods
  datapoints_to_alarm = each.value.periods
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.operations[0].arn]
  ok_actions          = [aws_sns_topic.operations[0].arn]
  depends_on          = [aws_sns_topic_policy.operations]
}

resource "aws_cloudwatch_metric_alarm" "operations_instance" {
  count               = local.operations_enabled ? 1 : 0
  alarm_name          = "${var.name}-ops-instance-status"
  alarm_description   = "EC2 instance or system status check failed. Single-host preview; no automatic failover is implied."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = aws_instance.core.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.operations[0].arn]
  ok_actions          = [aws_sns_topic.operations[0].arn]
}

# The module manages only the alarms above and the budget below. Alarms, agents and limits an operator adds by hand
# are not described here, and the next apply sets what the module manages back to what it says
# (docs/deployment/preview.md). The budget's monthly limit is the tfvars value, which git does not hold.
resource "aws_budgets_budget" "operations" {
  count        = local.operations_enabled ? 1 : 0
  name         = "${var.name}-account-safety-net"
  budget_type  = "COST"
  limit_amount = tostring(var.operations_monthly_account_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  # No misleading Project filter before cost-allocation tags are activated and proven.
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.operations[0].arn]
  }
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.operations[0].arn]
  }
  depends_on = [aws_sns_topic_policy.operations]
}
