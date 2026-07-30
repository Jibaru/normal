locals {
  environment_suffix           = var.deployment_environment == "production" ? "" : "-${var.deployment_environment}"
  api_worker_name              = "whatsapp-mcp-api${local.environment_suffix}"
  provider_control_worker_name = "whatsapp-mcp-provider-control${local.environment_suffix}"
  web_project_name             = "whatsapp-mcp-web${local.environment_suffix}"
  api_bundle_path              = abspath("${path.root}/../../apps/api/dist/index.js")
  provider_control_bundle_path = abspath("${path.root}/../../apps/provider-control/dist/index.js")
}

resource "cloudflare_workers_script" "provider_control" {
  account_id     = var.cloudflare_account_id
  script_name    = local.provider_control_worker_name
  content_file   = local.provider_control_bundle_path
  content_sha256 = filesha256(local.provider_control_bundle_path)
  main_module    = "index.js"

  compatibility_date = "2026-07-30"

  bindings = [
    {
      name = "DEPLOYMENT_ENVIRONMENT"
      text = var.deployment_environment
      type = "plain_text"
    }
  ]

  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 1
      persist            = true
    }
  }
}

resource "cloudflare_workers_script_subdomain" "provider_control" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.provider_control.script_name
  enabled          = false
  previews_enabled = false
}

resource "cloudflare_workers_script" "api" {
  account_id     = var.cloudflare_account_id
  script_name    = local.api_worker_name
  content_file   = local.api_bundle_path
  content_sha256 = filesha256(local.api_bundle_path)
  main_module    = "index.js"

  compatibility_date = "2026-07-30"

  bindings = [
    {
      name = "DEPLOYMENT_ENVIRONMENT"
      text = var.deployment_environment
      type = "plain_text"
    },
    {
      name    = "PROVIDER_CONTROL"
      service = cloudflare_workers_script.provider_control.script_name
      type    = "service"
    }
  ]

  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 1
      persist            = true
    }
  }
}

resource "cloudflare_workers_script_subdomain" "api" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.api.script_name
  enabled          = false
  previews_enabled = false
}

resource "cloudflare_workers_custom_domain" "api" {
  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id
  hostname   = var.api_hostname
  service    = cloudflare_workers_script.api.script_name
}

resource "vercel_project" "web" {
  name      = local.web_project_name
  framework = "nextjs"
  team_id   = var.vercel_team_id

  root_directory  = "apps/web"
  build_command   = "cd ../.. && bun x turbo run build --filter=@whatsapp-mcp/web --cache-dir=.turbo/cache"
  install_command = "cd ../.. && bun install --frozen-lockfile"

  auto_assign_custom_domains                        = true
  automatically_expose_system_environment_variables = false
  customer_success_code_visibility                  = false
  directory_listing                                 = false
  git_fork_protection                               = true
  protected_sourcemaps                              = true

  environment = [
    {
      key       = "DEPLOYMENT_ENVIRONMENT"
      value     = var.deployment_environment
      target    = ["production"]
      sensitive = false
    },
    {
      key       = "NEXT_PUBLIC_API_ORIGIN"
      value     = "https://${var.api_hostname}"
      target    = ["production"]
      sensitive = false
    }
  ]

  lifecycle {
    precondition {
      condition     = var.api_hostname != var.web_hostname
      error_message = "The web and API origins must be distinct so Vercel cannot become a data-plane proxy."
    }
  }
}

resource "vercel_project_domain" "web" {
  project_id = vercel_project.web.id
  domain     = var.web_hostname
  team_id    = var.vercel_team_id
}
