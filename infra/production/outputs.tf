output "api_hyperdrive_id" {
  description = "Bind to the API Worker as HYPERDRIVE."
  value       = cloudflare_hyperdrive_config.api.id
}

output "webhook_hyperdrive_id" {
  description = "Bind to the API Worker as WEBHOOK_HYPERDRIVE."
  value       = cloudflare_hyperdrive_config.webhook.id
}

output "neon_branch_id" {
  description = "Opaque Neon branch identity bound into API restore readiness."
  value       = neon_project.private_beta.default_branch_id
  sensitive   = true
}

output "restore_database_url" {
  description = "Direct TLS URL for the restore-only runtime role."
  value       = "postgresql://${neon_role.restore_runtime.name}:${urlencode(neon_role.restore_runtime.password)}@${neon_project.private_beta.database_host}/${local.database_name}?sslmode=require"
  sensitive   = true
}

output "migration_database_url" {
  description = "Direct owner URL used only by the serialized migration command."
  value       = neon_project.private_beta.connection_uri
  sensitive   = true
}

output "neon_project_id" {
  description = "Production Neon project identifier."
  value       = neon_project.private_beta.id
}
