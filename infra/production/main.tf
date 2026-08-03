locals {
  database_name              = "whatsapp_mcp"
  api_runtime_role           = "whatsapp_api_runtime"
  webhook_runtime_role       = "whatsapp_webhook_runtime"
  break_glass_requester_role = "whatsapp_break_glass_requester"
  break_glass_approver_role  = "whatsapp_break_glass_approver"
  break_glass_runtime_role   = "whatsapp_break_glass_runtime"
}

resource "neon_project" "private_beta" {
  name                      = var.project_name
  org_id                    = var.neon_org_id
  region_id                 = "aws-us-east-1"
  pg_version                = 17
  history_retention_seconds = 2592000
  default_branch_protected  = true
  store_password            = "yes"

  branch {
    name          = "production"
    database_name = local.database_name
    role_name     = "whatsapp_migration_owner"
  }
}

# Neon API-created roles initially inherit neon_superuser. Migration 0001
# atomically revokes that membership and enforces the restricted attributes
# before the expected schema version can become ready.
resource "neon_role" "api_runtime" {
  project_id = neon_project.private_beta.id
  branch_id  = neon_project.private_beta.default_branch_id
  name       = local.api_runtime_role
}

resource "neon_role" "webhook_runtime" {
  project_id = neon_project.private_beta.id
  branch_id  = neon_project.private_beta.default_branch_id
  name       = local.webhook_runtime_role
}

resource "neon_role" "break_glass_requester" {
  project_id = neon_project.private_beta.id
  branch_id  = neon_project.private_beta.default_branch_id
  name       = local.break_glass_requester_role
}

resource "neon_role" "break_glass_approver" {
  project_id = neon_project.private_beta.id
  branch_id  = neon_project.private_beta.default_branch_id
  name       = local.break_glass_approver_role
}

resource "neon_role" "break_glass_runtime" {
  project_id = neon_project.private_beta.id
  branch_id  = neon_project.private_beta.default_branch_id
  name       = local.break_glass_runtime_role
}

resource "cloudflare_hyperdrive_config" "api" {
  account_id = var.cloudflare_account_id
  name       = "whatsapp-mcp-api-production"

  origin = {
    database = local.database_name
    host     = neon_project.private_beta.database_host
    password = neon_role.api_runtime.password
    port     = 5432
    scheme   = "postgresql"
    user     = neon_role.api_runtime.name
  }

  caching = {
    disabled = true
  }

  mtls = {
    sslmode = "require"
  }
}

resource "cloudflare_hyperdrive_config" "webhook" {
  account_id = var.cloudflare_account_id
  name       = "whatsapp-mcp-webhook-production"

  origin = {
    database = local.database_name
    host     = neon_project.private_beta.database_host
    password = neon_role.webhook_runtime.password
    port     = 5432
    scheme   = "postgresql"
    user     = neon_role.webhook_runtime.name
  }

  caching = {
    disabled = true
  }

  mtls = {
    sslmode = "require"
  }
}
