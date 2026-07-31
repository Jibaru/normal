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

variable "clerk_issuer" {
  description = "Exact HTTPS Clerk issuer for this isolated environment."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.clerk_issuer))
    error_message = "clerk_issuer must be an exact HTTPS origin."
  }
}

variable "clerk_jwt_template" {
  description = "Clerk custom JWT template whose audience is the exact API origin."
  type        = string
  default     = "whatsapp-api"

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_-]{0,63}$", var.clerk_jwt_template))
    error_message = "clerk_jwt_template must be a safe Clerk template name."
  }
}

variable "clerk_publishable_key" {
  description = "Public Clerk browser key for this isolated environment."
  type        = string

  validation {
    condition     = can(regex("^pk_(test|live)_[A-Za-z0-9_-]{20,}\\$?$", var.clerk_publishable_key))
    error_message = "clerk_publishable_key must use Clerk's public key format."
  }
}

variable "oauth_clients" {
  description = "Reviewed MCP Client allowlist with exact redirect URIs for this environment."
  type = list(object({
    client_class  = string
    client_id     = string
    client_name   = string
    redirect_uris = list(string)
  }))

  validation {
    condition = (
      length(var.oauth_clients) > 0 &&
      length(var.oauth_clients) <= 32 &&
      length(distinct([for client in var.oauth_clients : client.client_id])) == length(var.oauth_clients) &&
      alltrue([
        for client in var.oauth_clients :
        can(regex("^[a-z][a-z0-9_-]{0,63}$", client.client_class)) &&
        can(regex("^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$", client.client_id)) &&
        length(trimspace(client.client_name)) > 0 &&
        length(client.client_name) <= 128 &&
        length(client.redirect_uris) > 0 &&
        length(client.redirect_uris) <= 8 &&
        length(distinct(client.redirect_uris)) == length(client.redirect_uris) &&
        alltrue([
          for redirect_uri in client.redirect_uris :
          can(regex("^https://[^#]+$", redirect_uri)) ||
          can(regex("^http://(127\\.0\\.0\\.1|localhost|\\[::1\\])(?::[0-9]+)?/[^#]*$", redirect_uri))
        ])
      ])
    )
    error_message = "oauth_clients must contain 1-32 unique reviewed clients with safe classes, IDs, names, and exact HTTPS or loopback redirects."
  }
}
