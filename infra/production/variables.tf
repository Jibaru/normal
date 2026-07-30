variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the production Hyperdrive configurations."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character account identifier."
  }
}

variable "neon_org_id" {
  description = "Neon organization that owns the private-beta project."
  type        = string
}

variable "project_name" {
  description = "Stable production Neon project name."
  type        = string
  default     = "whatsapp-mcp-private-beta"

  validation {
    condition     = length(trimspace(var.project_name)) > 0
    error_message = "project_name must not be empty."
  }
}
