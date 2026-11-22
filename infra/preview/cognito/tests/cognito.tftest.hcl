# Plan-only provider mocks: no AWS account, credentials, email or user exists.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
  mock_data "aws_ami" {
    defaults = { id = "ami-0123456789abcdef0", architecture = "arm64" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/fixture" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:ap-southeast-1:123456789012:function:fixture" }
  }
  mock_resource "aws_cognito_user_pool" {
    defaults = { id = "ap-southeast-1_Fixture123", arn = "arn:aws:cognito-idp:ap-southeast-1:123456789012:userpool/ap-southeast-1_Fixture123" }
  }
  mock_resource "aws_cognito_user_pool_client" {
    defaults = { id = "fixtureclient" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:ap-southeast-1:123456789012:log-group:fixture" }
  }
  override_resource {
    target = aws_secretsmanager_secret.cognito_migration
    values = { arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:fixture/migration-AbCdEf" }
  }
  override_resource {
    target = aws_secretsmanager_secret.application
    values = { arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:fixture/application-XyZaBc" }
  }
}

variables {
  aws_account_id = "123456789012"
  preview_host   = "preview.example.invalid"
}

run "identity_and_registration_trust_boundaries" {
  command = plan
  assert {
    condition     = aws_cognito_user_pool.learnsdlc.user_pool_tier == "ESSENTIALS" && aws_cognito_user_pool.learnsdlc.deletion_protection == "ACTIVE" && !one(aws_cognito_user_pool.learnsdlc.username_configuration).case_sensitive && aws_cognito_user_pool.learnsdlc.username_attributes == toset(["email"])
    error_message = "Managed identity must preserve case-insensitive email sign-in and protected Essentials storage."
  }
  assert {
    condition     = one(aws_cognito_user_pool.learnsdlc.password_policy).minimum_length == 8 && !one(aws_cognito_user_pool.learnsdlc.password_policy).require_uppercase && !one(aws_cognito_user_pool.learnsdlc.password_policy).require_lowercase && !one(aws_cognito_user_pool.learnsdlc.password_policy).require_symbols && !one(aws_cognito_user_pool.learnsdlc.password_policy).require_numbers
    error_message = "The preview must not silently replace the existing passphrase policy with composition rules."
  }
  assert {
    condition     = one(one(aws_cognito_user_pool.learnsdlc.account_recovery_setting).recovery_mechanism).name == "verified_email" && one(aws_cognito_user_pool.learnsdlc.verification_message_template).default_email_option == "CONFIRM_WITH_CODE" && aws_cognito_user_pool.learnsdlc.auto_verified_attributes == toset(["email"])
    error_message = "Native registration/recovery must use verified email and confirmation codes."
  }
  assert {
    condition     = length([for attribute in aws_cognito_user_pool.learnsdlc.schema : attribute if attribute.name == "learnsdlc_id" && !attribute.mutable && !attribute.required]) == 1 && !contains(aws_cognito_user_pool_client.learnsdlc.write_attributes, "custom:learnsdlc_id") && !contains(aws_cognito_user_pool_client.learnsdlc.write_attributes, "email_verified") && contains(aws_cognito_user_pool_client.learnsdlc.read_attributes, "custom:learnsdlc_id")
    error_message = "Users must not write legacy account IDs or claim verified email through the public client."
  }
  assert {
    condition     = one(aws_cognito_user_pool.learnsdlc.lambda_config).user_migration == aws_lambda_function.cognito_migration.arn && one(aws_cognito_user_pool.learnsdlc.lambda_config).pre_sign_up == aws_lambda_function.cognito_migration.arn
    error_message = "Legacy migration and direct native signup must both traverse the trusted trigger."
  }
}

run "public_client_redirect_and_token_boundary" {
  command = plan
  assert {
    condition     = !aws_cognito_user_pool_client.learnsdlc.generate_secret && aws_cognito_user_pool_client.learnsdlc.allowed_oauth_flows == toset(["code"]) && aws_cognito_user_pool_client.learnsdlc.prevent_user_existence_errors == "ENABLED" && aws_cognito_user_pool_client.learnsdlc.enable_token_revocation
    error_message = "Use a public authorization-code client with revocation and generic account-existence errors."
  }
  assert {
    condition     = aws_cognito_user_pool_client.learnsdlc.callback_urls == toset(["https://${var.preview_host}/api/v1/auth/sso/callback"]) && aws_cognito_user_pool_client.learnsdlc.logout_urls == toset(["https://${var.preview_host}/login"]) && startswith(output.cognito_domain, "https://") && output.cognito_google_redirect_url == "${output.cognito_domain}/oauth2/idpresponse"
    error_message = "Redirects must use exact reviewed endpoints, including the separate Google-to-Cognito callback."
  }
  assert {
    condition     = aws_cognito_user_pool_client.learnsdlc.explicit_auth_flows == toset(["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]) && aws_cognito_user_pool_client.learnsdlc.supported_identity_providers == toset(["COGNITO"]) && aws_cognito_user_pool_client.learnsdlc.allowed_oauth_scopes == toset(["openid", "email", "profile", "aws.cognito.signin.user.admin"])
    error_message = "Migration needs password auth; unsupported providers, admin auth and extra scopes must stay disabled."
  }
}

run "migration_lambda_cannot_access_learner_or_application_secrets" {
  command = plan
  assert {
    condition     = length(aws_lambda_function.cognito_migration.vpc_config) == 0 && aws_lambda_function.cognito_migration.timeout == 5 && aws_lambda_function.cognito_migration.memory_size == 128 && toset(aws_lambda_function.cognito_migration.architectures) == toset(["arm64"])
    error_message = "The trusted trigger must be a small ordinary Lambda with bounded duration and no learner VPC attachment."
  }
  assert {
    condition     = length(jsondecode(aws_iam_role_policy.cognito_migration.policy).Statement) == 2 && jsondecode(aws_iam_role_policy.cognito_migration.policy).Statement[0].Action == ["secretsmanager:GetSecretValue"] && jsondecode(aws_iam_role_policy.cognito_migration.policy).Statement[0].Resource == [aws_secretsmanager_secret.cognito_migration.arn] && !contains(jsondecode(aws_iam_role_policy.cognito_migration.policy).Statement[0].Resource, aws_secretsmanager_secret.application.arn) && jsondecode(aws_iam_role_policy.cognito_migration.policy).Statement[1].Action == ["logs:CreateLogStream", "logs:PutLogEvents"]
    error_message = "Migration role may read only its HMAC key and write its own logs, never application secrets or learner operations."
  }
  assert {
    condition     = aws_lambda_permission.cognito_migration.source_arn == aws_cognito_user_pool.learnsdlc.arn && aws_lambda_permission.cognito_migration.source_account == var.aws_account_id && aws_lambda_permission.cognito_migration.principal == "cognito-idp.amazonaws.com" && aws_lambda_permission.cognito_migration.action == "lambda:InvokeFunction"
    error_message = "Only the expected Cognito pool/account may invoke the migration function."
  }
  assert {
    condition     = toset(keys(one(aws_lambda_function.cognito_migration.environment).variables)) == toset(["MIGRATION_ENDPOINT", "MIGRATION_SECRET_ARN", "EXPECTED_REGION", "EXPECTED_ACCOUNT_ID"]) && one(aws_lambda_function.cognito_migration.environment).variables.MIGRATION_ENDPOINT == "https://${var.preview_host}/api/v1/auth/cognito/migrate"
    error_message = "Lambda environment may contain only metadata and the exact HTTPS endpoint, never secret values."
  }
}

run "reject_redirect_injection" {
  command = plan
  variables { cognito_preview_origin = "https://preview.example.test/other?return=https://untrusted.invalid" }
  expect_failures = [var.cognito_preview_origin]
}

run "reject_provider_injection" {
  command = plan
  variables { cognito_identity_providers = ["Google&redirect_uri=https://untrusted.invalid"] }
  expect_failures = [var.cognito_identity_providers]
}
