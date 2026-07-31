locals {
  environment_suffix            = var.deployment_environment == "production" ? "" : "-${var.deployment_environment}"
  api_worker_name               = "whatsapp-mcp-api${local.environment_suffix}"
  provider_control_worker_name  = "whatsapp-mcp-provider-control${local.environment_suffix}"
  web_project_name              = "whatsapp-mcp-web${local.environment_suffix}"
  webhook_ingress_bucket_name   = "whatsapp-mcp-webhook-ingress${local.environment_suffix}"
  stored_media_bucket_name      = "whatsapp-mcp-stored-media${local.environment_suffix}"
  deletion_capsules_bucket_name = "whatsapp-mcp-deletion-capsules${local.environment_suffix}"
  deletion_markers_bucket_name  = "whatsapp-mcp-deletion-markers${local.environment_suffix}"
  oauth_kv_namespace_name       = "whatsapp-mcp-oauth${local.environment_suffix}"
  ingestion_queue_name          = "whatsapp-mcp-ingestion${local.environment_suffix}"
  dead_letter_queue_name        = "whatsapp-mcp-ingestion-dlq${local.environment_suffix}"
  api_bundle_path               = abspath("${path.root}/../../apps/api/dist/index.js")
  provider_control_bundle_path  = abspath("${path.root}/../../apps/provider-control/dist/index.js")
}

resource "cloudflare_r2_bucket" "webhook_ingress" {
  account_id    = var.cloudflare_account_id
  name          = local.webhook_ingress_bucket_name
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket_lifecycle" "webhook_ingress" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.webhook_ingress.name

  rules = [{
    id      = "expire-encrypted-webhook-events"
    enabled = true
    conditions = {
      prefix = ""
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
    delete_objects_transition = {
      condition = {
        max_age = 604800
        type    = "Age"
      }
    }
  }]
}

resource "cloudflare_r2_bucket" "stored_media" {
  account_id    = var.cloudflare_account_id
  name          = local.stored_media_bucket_name
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket" "deletion_capsules" {
  account_id    = var.cloudflare_account_id
  name          = local.deletion_capsules_bucket_name
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lifecycle" "stored_media" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.stored_media.name

  rules = [{
    id      = "abort-incomplete-stored-media-uploads"
    enabled = true
    conditions = {
      prefix = ""
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
  }]
}

resource "cloudflare_r2_bucket" "deletion_markers" {
  account_id    = var.cloudflare_account_id
  name          = local.deletion_markers_bucket_name
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lock" "deletion_markers" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.deletion_markers.name

  rules = [{
    id      = "retain-deletion-markers"
    enabled = true
    prefix  = ""
    condition = {
      type = "Indefinite"
    }
  }]
}

resource "cloudflare_r2_managed_domain" "webhook_ingress" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.webhook_ingress.name
  enabled     = false
}

resource "cloudflare_r2_managed_domain" "stored_media" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.stored_media.name
  enabled     = false
}

resource "cloudflare_r2_managed_domain" "deletion_capsules" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.deletion_capsules.name
  enabled     = false
}

resource "cloudflare_r2_managed_domain" "deletion_markers" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.deletion_markers.name
  enabled     = false
}

resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.cloudflare_account_id
  title      = local.oauth_kv_namespace_name
}

resource "cloudflare_queue" "ingestion" {
  account_id = var.cloudflare_account_id
  queue_name = local.ingestion_queue_name

  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = 604800
  }
}

resource "cloudflare_queue" "dead_letter" {
  account_id = var.cloudflare_account_id
  queue_name = local.dead_letter_queue_name

  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = 345600
  }
}

resource "cloudflare_worker" "provider_control" {
  account_id = var.cloudflare_account_id
  name       = local.provider_control_worker_name

  subdomain = {
    enabled          = false
    previews_enabled = false
  }
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

resource "cloudflare_worker_version" "provider_control" {
  account_id  = var.cloudflare_account_id
  worker_id   = cloudflare_worker.provider_control.id
  main_module = "index.js"

  compatibility_date = "2026-07-30"

  modules = [
    {
      name         = "index.js"
      content_file = local.provider_control_bundle_path
      content_type = "application/javascript+module"
    }
  ]

  bindings = [
    {
      name = "DEPLOYMENT_ENVIRONMENT"
      text = var.deployment_environment
      type = "plain_text"
    },
    {
      name = "WASENDER_API_CREDENTIAL"
      type = "inherit"
    },
    {
      name = "WASENDER_REFERENCE_SECRET"
      type = "inherit"
    }
  ]
}

resource "cloudflare_workers_deployment" "provider_control" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.provider_control.name
  strategy    = "percentage"

  versions = [
    {
      percentage = 100
      version_id = cloudflare_worker_version.provider_control.id
    }
  ]
}

resource "cloudflare_worker" "api" {
  account_id = var.cloudflare_account_id
  name       = local.api_worker_name

  subdomain = {
    enabled          = false
    previews_enabled = false
  }
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

resource "cloudflare_worker_version" "api" {
  account_id  = var.cloudflare_account_id
  worker_id   = cloudflare_worker.api.id
  main_module = "index.js"

  compatibility_date = "2026-07-30"

  modules = [
    {
      name         = "index.js"
      content_file = local.api_bundle_path
      content_type = "application/javascript+module"
    }
  ]

  bindings = [
    {
      name = "DEPLOYMENT_ENVIRONMENT"
      text = var.deployment_environment
      type = "plain_text"
    },
    {
      name         = "OAUTH_KV"
      namespace_id = cloudflare_workers_kv_namespace.oauth.id
      type         = "kv_namespace"
    },
    {
      bucket_name = cloudflare_r2_bucket.webhook_ingress.name
      name        = "WEBHOOK_INGRESS"
      type        = "r2_bucket"
    },
    {
      bucket_name = cloudflare_r2_bucket.stored_media.name
      name        = "STORED_MEDIA"
      type        = "r2_bucket"
    },
    {
      bucket_name = cloudflare_r2_bucket.deletion_capsules.name
      name        = "DELETION_CAPSULES"
      type        = "r2_bucket"
    },
    {
      bucket_name = cloudflare_r2_bucket.deletion_markers.name
      name        = "DELETION_MARKERS"
      type        = "r2_bucket"
    },
    {
      name       = "INGESTION_QUEUE"
      queue_name = cloudflare_queue.ingestion.queue_name
      type       = "queue"
    },
    {
      name    = "PROVIDER_CONTROL"
      service = cloudflare_worker.provider_control.name
      type    = "service"
    }
  ]

  depends_on = [cloudflare_workers_deployment.provider_control]
}

resource "cloudflare_workers_deployment" "api" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.api.name
  strategy    = "percentage"

  versions = [
    {
      percentage = 100
      version_id = cloudflare_worker_version.api.id
    }
  ]
}

resource "cloudflare_queue_consumer" "ingestion" {
  account_id        = var.cloudflare_account_id
  queue_id          = cloudflare_queue.ingestion.queue_id
  script_name       = cloudflare_worker.api.name
  type              = "worker"
  dead_letter_queue = cloudflare_queue.dead_letter.queue_name

  settings = {
    batch_size            = 10
    max_retries           = 7
    max_wait_time_ms      = 5000
    retry_delay           = 10800
    visibility_timeout_ms = 900000
  }

  depends_on = [cloudflare_workers_deployment.api]
}

resource "cloudflare_queue_consumer" "dead_letter" {
  account_id  = var.cloudflare_account_id
  queue_id    = cloudflare_queue.dead_letter.queue_id
  script_name = cloudflare_worker.api.name
  type        = "worker"

  settings = {
    batch_size            = 10
    max_retries           = 7
    max_wait_time_ms      = 5000
    retry_delay           = 300
    visibility_timeout_ms = 900000
  }

  depends_on = [cloudflare_workers_deployment.api]
}

resource "cloudflare_workers_cron_trigger" "api" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.api.name

  schedules = [
    { cron = "* * * * *" },
    { cron = "*/5 * * * *" },
    { cron = "0 * * * *" },
  ]

  depends_on = [cloudflare_workers_deployment.api]
}

resource "cloudflare_workers_custom_domain" "api" {
  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id
  hostname   = var.api_hostname
  service    = cloudflare_worker.api.name

  depends_on = [cloudflare_workers_deployment.api]
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
