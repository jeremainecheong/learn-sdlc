terraform {
  required_version = ">= 1.9, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64.0"
    }
  }
}

# An explicit profile/account prevents accidentally planning against the user's
# unrelated default account. Tests replace this provider with a full mock.
provider "aws" {
  region              = var.aws_region
  profile             = var.aws_profile
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = "LearnSDLC"
      Environment = "preview"
      ManagedBy   = "Terraform"
    }
  }
}
