# Managed identity is separate from the untrusted learner MicroVM runtime.
# Build the small, source-only Lambda ZIP before planning:
# python3 infra/preview/cognito/package.py
variable "cognito_preview_origin" {
  description = "Exact HTTPS origin for the reviewed preview; no paths, ports or wildcard callbacks. Defaults to https://<preview_host>."
  type        = string
  default     = null
  validation {
    condition     = var.cognito_preview_origin == null || can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.cognito_preview_origin))
    error_message = "Use one lowercase HTTPS hostname without credentials, port, path, query or fragment."
  }
}

variable "cognito_identity_providers" {
  description = "Names of separately provisioned SSO providers. Provider secrets must never enter Terraform."
  type        = set(string)
  default     = []
  validation {
    condition = alltrue([
      for provider in var.cognito_identity_providers :
      provider != "COGNITO" && can(regex("^[A-Za-z][A-Za-z0-9_-]{0,31}$", provider))
    ])
    error_message = "Use exact configured provider names; COGNITO is already included."
  }
}

variable "cognito_migration_zip_path" {
  description = "Optional local ZIP from cognito/package.py. Contains source only; never a secret."
  type        = string
  default     = null
}

locals {
  cognito_preview_origin = coalesce(var.cognito_preview_origin, "https://${var.preview_host}")
  cognito_domain_prefix  = "${var.name}-${var.aws_account_id}-${var.aws_region}"
  cognito_domain         = "https://${local.cognito_domain_prefix}.auth.${var.aws_region}.amazoncognito.com"
  cognito_callback_url   = "${local.cognito_preview_origin}/api/v1/auth/sso/callback"
  cognito_migration_zip  = coalesce(var.cognito_migration_zip_path, "${path.module}/../../../.preview/cognito/migration.zip")
}

resource "aws_secretsmanager_secret" "cognito_migration" {
  name                    = "${var.name}/cognito-migration"
  description             = "Trusted legacy migration HMAC key; value is populated outside Terraform"
  recovery_window_in_days = 7
}

resource "aws_cloudwatch_log_group" "cognito_migration" {
  name              = "/aws/lambda/${var.name}-cognito-migration"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "cognito_migration" {
  name = "${var.name}-cognito-migration"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRole",
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "cognito_migration" {
  name = "exact-migration-key-and-own-logs"
  role = aws_iam_role.cognito_migration.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadMigrationKey", Effect = "Allow",
        Action   = ["secretsmanager:GetSecretValue"],
        Resource = [aws_secretsmanager_secret.cognito_migration.arn]
      },
      {
        Sid      = "WriteOwnLogs", Effect = "Allow",
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource = ["${aws_cloudwatch_log_group.cognito_migration.arn}:*"]
      }
    ]
  })
}

resource "aws_lambda_function" "cognito_migration" {
  function_name    = "${var.name}-cognito-migration"
  description      = "HMAC-authenticated migration of existing LearnSDLC accounts; never runs learner code"
  role             = aws_iam_role.cognito_migration.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "migration.handler"
  filename         = local.cognito_migration_zip
  source_code_hash = filebase64sha256(local.cognito_migration_zip)
  # Cognito invokes synchronously with a 5-second deadline. The SDK and HMAC
  # secret must initialize promptly on the first native registration request.
  memory_size = 512
  timeout     = 5

  environment {
    variables = {
      MIGRATION_ENDPOINT   = "${local.cognito_preview_origin}/api/v1/auth/cognito/migrate"
      MIGRATION_SECRET_ARN = aws_secretsmanager_secret.cognito_migration.arn
      EXPECTED_REGION      = var.aws_region
      EXPECTED_ACCOUNT_ID  = var.aws_account_id
    }
  }

  # The handler emits no events, passwords, emails or provider responses.
  logging_config {
    log_format            = "JSON"
    application_log_level = "ERROR"
    system_log_level      = "WARN"
    log_group             = aws_cloudwatch_log_group.cognito_migration.name
  }

  # No VPC attachment, learner access, function URL, database permissions or
  # application secret access. HTTPS is to the one configured API endpoint.
  depends_on = [aws_iam_role_policy.cognito_migration]
}

resource "aws_cognito_user_pool" "learnsdlc" {
  name                     = "${var.name}-learners"
  user_pool_tier           = "ESSENTIALS"
  deletion_protection      = "ACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"

  username_configuration {
    case_sensitive = false
  }

  # Keep the current passphrase policy. New-password breach screening remains
  # an application validation rule; no new composition requirements are added.
  password_policy {
    minimum_length                   = 8
    require_lowercase                = false
    require_uppercase                = false
    require_numbers                  = false
    require_symbols                  = false
    temporary_password_validity_days = 1
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 3
      max_length = 320
    }
  }

  schema {
    name                     = "learnsdlc_id"
    attribute_data_type      = "String"
    required                 = false
    mutable                  = false
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 36
      max_length = 36
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your LearnSDLC verification code"
    email_message        = "Your LearnSDLC verification code is {####}. Enter this code in LearnSDLC to verify your email address."
  }

  lambda_config {
    user_migration = aws_lambda_function.cognito_migration.arn
    pre_sign_up    = aws_lambda_function.cognito_migration.arn
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lambda_permission" "cognito_migration" {
  statement_id   = "OnlyLearnSDLCUserPool"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.cognito_migration.function_name
  principal      = "cognito-idp.amazonaws.com"
  source_account = var.aws_account_id
  source_arn     = aws_cognito_user_pool.learnsdlc.arn
}

resource "aws_cognito_user_pool_client" "learnsdlc" {
  name         = "${var.name}-web"
  user_pool_id = aws_cognito_user_pool.learnsdlc.id

  generate_secret                      = false
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  explicit_auth_flows                  = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile", "aws.cognito.signin.user.admin"]
  supported_identity_providers         = concat(["COGNITO"], sort(tolist(var.cognito_identity_providers)))
  callback_urls                        = [local.cognito_callback_url]
  default_redirect_uri                 = local.cognito_callback_url
  logout_urls                          = ["${local.cognito_preview_origin}/login"]
  read_attributes                      = ["email", "email_verified", "name", "custom:learnsdlc_id"]
  write_attributes                     = ["email", "name"]
  access_token_validity                = 15
  id_token_validity                    = 15
  refresh_token_validity               = 30
  auth_session_validity                = 3

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_pool_domain" "learnsdlc" {
  domain                = local.cognito_domain_prefix
  user_pool_id          = aws_cognito_user_pool.learnsdlc.id
  managed_login_version = 1
}

output "cognito_user_pool_id" { value = aws_cognito_user_pool.learnsdlc.id }
output "cognito_user_pool_arn" { value = aws_cognito_user_pool.learnsdlc.arn }
output "cognito_client_id" { value = aws_cognito_user_pool_client.learnsdlc.id }
output "cognito_domain" { value = local.cognito_domain }
output "cognito_redirect_url" { value = local.cognito_callback_url }
output "cognito_google_redirect_url" { value = "${local.cognito_domain}/oauth2/idpresponse" }
output "cognito_identity_providers" { value = sort(tolist(var.cognito_identity_providers)) }
output "cognito_migration_secret_arn" { value = aws_secretsmanager_secret.cognito_migration.arn }
output "cognito_migration_function_name" { value = aws_lambda_function.cognito_migration.function_name }
