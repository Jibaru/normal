terraform {
  required_version = "= 1.12.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.57.1"
    }
  }

  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "deployment_environment" {
  description = "Deployment environment bound into KMS encryption contexts."
  type        = string

  validation {
    condition     = contains(["development", "preview", "production"], var.deployment_environment)
    error_message = "deployment_environment must be development, preview, or production."
  }
}

variable "kms_administrator_assumer_arn" {
  description = "Bootstrap principal for KMS lifecycle administration."
  type        = string
}

variable "content_runtime_assumer_arn" {
  description = "Workload identity that can assume the API content runtime role."
  type        = string
}

variable "deletion_coordinator_assumer_arn" {
  description = "Workload identity that can assume the deletion coordinator role."
  type        = string
}

variable "provider_control_assumer_arn" {
  description = "Workload identity that can assume provider-control authority."
  type        = string
}

variable "ordinary_operator_assumer_arn" {
  description = "Human identity broker that can assume ordinary operator authority."
  type        = string
}

variable "break_glass_assumer_arn" {
  description = "Incident credential broker allowed to assume scoped break-glass authority."
  type        = string
}

variable "mcp_smoke_emergency_assumer_arn" {
  description = "Human recovery authority for the deployment-smoke refresh credential."
  type        = string
  default     = null
  nullable    = true
}

variable "github_oidc_provider_arn" {
  description = "Existing token.actions.githubusercontent.com OIDC provider ARN."
  type        = string
  default     = null
  nullable    = true
}

locals {
  bootstrap_principals = [
    var.kms_administrator_assumer_arn,
    var.content_runtime_assumer_arn,
    var.deletion_coordinator_assumer_arn,
    var.provider_control_assumer_arn,
    var.ordinary_operator_assumer_arn,
    var.break_glass_assumer_arn,
  ]
}

resource "aws_cloudformation_stack" "kms" {
  name          = "whatsapp-mcp-${var.deployment_environment}-kms"
  capabilities  = ["CAPABILITY_NAMED_IAM"]
  on_failure    = "ROLLBACK"
  template_body = file("${path.module}/kms.template.json")

  parameters = {
    DeploymentEnvironment         = var.deployment_environment
    KmsAdministratorAssumerArn    = var.kms_administrator_assumer_arn
    ContentRuntimeAssumerArn      = var.content_runtime_assumer_arn
    DeletionCoordinatorAssumerArn = var.deletion_coordinator_assumer_arn
    ProviderControlAssumerArn     = var.provider_control_assumer_arn
    OrdinaryOperatorAssumerArn    = var.ordinary_operator_assumer_arn
    BreakGlassAssumerArn          = var.break_glass_assumer_arn
  }

  lifecycle {
    precondition {
      condition     = length(toset(local.bootstrap_principals)) == length(local.bootstrap_principals)
      error_message = "Every KMS and IAM authority must use a distinct bootstrap principal."
    }
  }
}

resource "aws_cloudformation_stack" "mcp_smoke_credential" {
  count         = var.deployment_environment == "production" ? 1 : 0
  name          = "whatsapp-mcp-production-mcp-smoke-credential"
  capabilities  = ["CAPABILITY_NAMED_IAM"]
  on_failure    = "ROLLBACK"
  template_body = file("${path.module}/mcp-smoke-credential.template.json")

  parameters = {
    EmergencyAssumerArn      = var.mcp_smoke_emergency_assumer_arn
    GitHubOidcProviderArn    = var.github_oidc_provider_arn
    GitHubRepositoryIdentity = "cuevaio@83598208/normal@1317490924"
  }

  lifecycle {
    precondition {
      condition     = var.mcp_smoke_emergency_assumer_arn != null && var.github_oidc_provider_arn != null
      error_message = "Production requires distinct MCP smoke recovery authority and the existing GitHub OIDC provider ARN."
    }
  }
}

output "content_root_key_arn" {
  description = "Configure the API as KMS_CONTENT_ROOT_KEY_ARN."
  value       = aws_cloudformation_stack.kms.outputs["ContentRootKeyArn"]
}

output "content_runtime_role_arn" {
  value = aws_cloudformation_stack.kms.outputs["ContentRuntimeRoleArn"]
}

output "deletion_coordinator_key_arn" {
  description = "Deletion Capsule key; never configure this as a content root."
  value       = aws_cloudformation_stack.kms.outputs["DeletionCoordinatorKeyArn"]
}

output "deletion_coordinator_role_arn" {
  value = aws_cloudformation_stack.kms.outputs["DeletionCoordinatorRoleArn"]
}

output "break_glass_role_arn" {
  description = "Short-lived, Personal-Account-tag-bound incident decryption role."
  value       = aws_cloudformation_stack.kms.outputs["BreakGlassRoleArn"]
}

output "mcp_smoke_credential_role_arn" {
  value = try(aws_cloudformation_stack.mcp_smoke_credential[0].outputs["McpSmokeCredentialRoleArn"], null)
}

output "mcp_smoke_refresh_secret_id" {
  value = try(aws_cloudformation_stack.mcp_smoke_credential[0].outputs["McpSmokeRefreshSecretId"], null)
}
