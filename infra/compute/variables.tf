variable "deployment_environment" {
  description = "The isolated authority and deployment environment represented by this state."
  type        = string

  validation {
    condition     = contains(["development", "preview", "production"], var.deployment_environment)
    error_message = "deployment_environment must be development, preview, or production."
  }
}

variable "cloudflare_account_id" {
  description = "Cloudflare account dedicated to this environment's authority scope."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hexadecimal ID."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone containing api_hostname."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be a 32-character lowercase hexadecimal ID."
  }
}

variable "vercel_team_id" {
  description = "Vercel team dedicated to this environment's authority scope."
  type        = string

  validation {
    condition     = can(regex("^team_[A-Za-z0-9]+$", var.vercel_team_id))
    error_message = "vercel_team_id must use Vercel's team_<id> form."
  }
}

variable "api_hostname" {
  description = "Public custom hostname routed directly to the API Worker."
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.api_hostname)) &&
      !endswith(var.api_hostname, ".workers.dev")
    )
    error_message = "api_hostname must be a lowercase custom DNS hostname outside workers.dev."
  }
}

variable "web_hostname" {
  description = "Public custom hostname assigned to the Vercel web project."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.web_hostname))
    error_message = "web_hostname must be a lowercase DNS hostname."
  }
}
