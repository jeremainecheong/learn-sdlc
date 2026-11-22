# The preview reads its exact application secret through Secrets Manager.
# Keep the managed SSM transport/document permissions, while preventing the
# host role from reading unrelated Parameter Store values in any region.
# The operator-side AL2023 AMI lookup uses the operator's credentials.
resource "aws_iam_role_policy" "host_parameter_boundary" {
  name = "${var.name}-no-parameter-values"
  role = aws_iam_role.core.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "BlockUnneededParameterValues"
      Effect = "Deny"
      Action = [
        "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"
      ]
      Resource = "*"
    }]
  })
}
