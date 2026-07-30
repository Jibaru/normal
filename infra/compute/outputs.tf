output "api_origin" {
  description = "Public API Worker origin called directly by the browser."
  value       = "https://${cloudflare_workers_custom_domain.api.hostname}"
}

output "web_origin" {
  description = "Public Vercel web origin."
  value       = "https://${vercel_project_domain.web.domain}"
}

output "web_hostname" {
  description = "Vercel custom hostname used for DNS verification."
  value       = vercel_project_domain.web.domain
}

output "provider_control_service" {
  description = "Private service-binding target; no public hostname is declared."
  value       = cloudflare_worker.provider_control.name
}

output "vercel_project_id" {
  description = "Vercel project identifier used by the explicit web deployment."
  value       = vercel_project.web.id
}

output "vercel_team_id" {
  description = "Vercel team identifier used by the explicit web deployment."
  value       = var.vercel_team_id
}
