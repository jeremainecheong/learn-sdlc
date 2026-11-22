variable "aws_account_id" {
  description = "Expected preview AWS account ID. Metadata only; never supply credentials."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Provide the exact 12-digit preview account ID."
  }
}

variable "aws_region" {
  description = "Region for the selected local-preview foundation."
  type        = string
  default     = "ap-southeast-1"
  validation {
    condition     = var.aws_region == "ap-southeast-1"
    error_message = "This reviewed preview foundation targets Singapore only."
  }
}

variable "aws_profile" {
  description = "Explicit operator profile; the ambient default profile is not used."
  type        = string
  default     = "learnsdlc-preview"
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$", var.aws_profile))
    error_message = "Select an explicit nonempty AWS profile name; the expected account ID is always enforced."
  }
}

variable "preview_host" {
  description = "Hostname of the private preview, without scheme. Kept out of the repository: set it in an untracked *.auto.tfvars file."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.preview_host))
    error_message = "Use one lowercase hostname without scheme, port or path."
  }
}

variable "name" {
  description = "Unique preview resource prefix, not a production environment name."
  type        = string
  default     = "learnsdlc-preview"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}[a-z0-9]$", var.name))
    error_message = "Use 4–32 lowercase letters, digits and internal hyphens."
  }
}

variable "availability_zone" {
  description = "Optional Singapore AZ. Data EBS must stay in this AZ when replacing the core."
  type        = string
  default     = null
  validation {
    condition     = var.availability_zone == null || can(regex("^${var.aws_region}[a-z]$", var.availability_zone))
    error_message = "Choose an availability zone within ap-southeast-1."
  }
}

variable "instance_type" {
  description = "Provisional ARM capacity. Benchmark before serving real classroom traffic."
  type        = string
  default     = "t4g.medium"
  validation {
    condition     = contains(["t4g.medium", "t4g.large"], var.instance_type)
    error_message = "This ARM foundation permits t4g.medium or t4g.large only."
  }
}

variable "ami_id" {
  description = "Optional pinned AL2023 ARM AMI ID. Null resolves the AWS public AL2023 ARM parameter at plan time."
  type        = string
  default     = null
  validation {
    condition     = var.ami_id == null || can(regex("^ami-[0-9a-f]{8,17}$", var.ami_id))
    error_message = "Provide a valid AMI ID or leave it null."
  }
}

variable "allowed_https_cidrs" {
  description = "Explicit IPv4 networks allowed on HTTPS. Empty blocks HTTPS until the operator chooses private tester CIDRs or public access. HTTP80 remains public for ACME only at the reverse proxy."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for cidr in var.allowed_https_cidrs : can(cidrnetmask(cidr))])
    error_message = "Supply valid IPv4 CIDRs; an empty set leaves HTTPS closed."
  }
}

variable "data_volume_size_gib" {
  description = "Encrypted persistent gp3 capacity; increases are supported, shrinking is not."
  type        = number
  default     = 50
  validation {
    condition     = var.data_volume_size_gib >= 50 && floor(var.data_volume_size_gib) == var.data_volume_size_gib
    error_message = "Use an integer data-volume size of at least 50 GiB."
  }
}

variable "backup_retention_days" {
  description = "Retention for current and noncurrent objects under backups/. Releases are not expired by this rule."
  type        = number
  default     = 30
  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 3650 && floor(var.backup_retention_days) == var.backup_retention_days
    error_message = "Backup retention must be an integer between 7 and 3650 days."
  }
}

variable "log_retention_days" {
  description = "Bounded CloudWatch log retention for host-side diagnostics."
  type        = number
  default     = 14
  validation {
    condition     = contains([7, 14, 30, 60, 90], var.log_retention_days)
    error_message = "Choose 7, 14, 30, 60 or 90 days."
  }
}

variable "app_secret_arn" {
  description = "Optional existing Secrets Manager container ARN only. Terraform never reads or populates its value."
  type        = string
  default     = null
  validation {
    condition     = var.app_secret_arn == null || can(regex("^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:[A-Za-z0-9/_+=.@-]+$", var.app_secret_arn))
    error_message = "Provide an exact same-account Singapore Secrets Manager ARN, without wildcards, or null."
  }
}

variable "app_secret_kms_key_arn" {
  description = "Optional exact customer-managed KMS key for the supplied secret; omit for the AWS-managed Secrets Manager key."
  type        = string
  default     = null
  validation {
    condition     = var.app_secret_kms_key_arn == null || (var.app_secret_arn != null && can(regex("^arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/[0-9a-f-]+$", var.app_secret_kms_key_arn)))
    error_message = "A secret KMS key requires an app secret ARN and an exact Singapore key ARN."
  }
}
