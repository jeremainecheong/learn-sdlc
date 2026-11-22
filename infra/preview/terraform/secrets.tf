# The container is managed here; secret VALUES are uploaded separately and
# never enter Terraform configuration, plan, state, EC2 user data, or logs.
resource "aws_secretsmanager_secret" "application" {
  name                    = "${var.name}/application"
  recovery_window_in_days = 7
  description             = "Private preview application and invitation credentials"
}

resource "aws_iam_role_policy" "application_secret" {
  name = "exact-preview-application-secret"
  role = aws_iam_role.core.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow", Action = ["secretsmanager:GetSecretValue"],
      Resource = [aws_secretsmanager_secret.application.arn]
    }]
  })
}

output "application_secret_arn" { value = aws_secretsmanager_secret.application.arn }
