locals {
  database_name              = "whatsapp_mcp"
  api_runtime_role           = "whatsapp_api_runtime"
  webhook_runtime_role       = "whatsapp_webhook_runtime"
  restore_runtime_role       = "whatsapp_restore_runtime"
  break_glass_requester_role = "whatsapp_break_glass_requester"
  break_glass_approver_role  = "whatsapp_break_glass_approver"
  break_glass_runtime_role   = "whatsapp_break_glass_runtime"
}

resource "neon_project" "private_beta" {
  name                      = var.project_name
  org_id                    = var.neon_org_id
  region_id                 = "aws-us-east-1"
  pg_version                = 17
  history_retention_seconds = 604800
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
resource "random_password" "database_roles" {
  for_each = toset([
    local.api_runtime_role,
    local.webhook_runtime_role,
    local.restore_runtime_role,
    local.break_glass_runtime_role,
  ])
  length  = 48
  special = false
}

resource "postgresql_role" "api_runtime" {
  name                      = local.api_runtime_role
  login                     = true
  password                  = random_password.database_roles[local.api_runtime_role].result
  encrypted_password        = true
  inherit                   = false
  create_database           = false
  create_role               = false
  replication               = false
  bypass_row_level_security = false
}

resource "postgresql_role" "webhook_runtime" {
  name                      = local.webhook_runtime_role
  login                     = true
  password                  = random_password.database_roles[local.webhook_runtime_role].result
  encrypted_password        = true
  inherit                   = false
  create_database           = false
  create_role               = false
  replication               = false
  bypass_row_level_security = false
}

resource "postgresql_role" "restore_runtime" {
  name                      = local.restore_runtime_role
  login                     = true
  password                  = random_password.database_roles[local.restore_runtime_role].result
  encrypted_password        = true
  inherit                   = false
  create_database           = false
  create_role               = false
  replication               = false
  bypass_row_level_security = false
}

resource "postgresql_role" "break_glass_requester" {
  name    = local.break_glass_requester_role
  login   = false
  inherit = false
}

resource "postgresql_role" "break_glass_approver" {
  name    = local.break_glass_approver_role
  login   = false
  inherit = false
}

resource "postgresql_role" "break_glass_runtime" {
  name                      = local.break_glass_runtime_role
  login                     = true
  password                  = random_password.database_roles[local.break_glass_runtime_role].result
  encrypted_password        = true
  inherit                   = false
  create_database           = false
  create_role               = false
  replication               = false
  bypass_row_level_security = false
}

resource "cloudflare_hyperdrive_config" "api" {
  account_id = var.cloudflare_account_id
  name       = "whatsapp-mcp-api-production"

  origin = {
    database = local.database_name
    host     = neon_project.private_beta.database_host
    password = random_password.database_roles[local.api_runtime_role].result
    port     = 5432
    scheme   = "postgresql"
    user     = postgresql_role.api_runtime.name
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
    password = random_password.database_roles[local.webhook_runtime_role].result
    port     = 5432
    scheme   = "postgresql"
    user     = postgresql_role.webhook_runtime.name
  }

  caching = {
    disabled = true
  }

  mtls = {
    sslmode = "require"
  }
}
