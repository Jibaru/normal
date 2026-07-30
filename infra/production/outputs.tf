output "api_hyperdrive_id" {
  description = "Bind to the API Worker as HYPERDRIVE."
  value       = cloudflare_hyperdrive_config.api.id
}

output "webhook_hyperdrive_id" {
  description = "Bind to the API Worker as WEBHOOK_HYPERDRIVE."
  value       = cloudflare_hyperdrive_config.webhook.id
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
